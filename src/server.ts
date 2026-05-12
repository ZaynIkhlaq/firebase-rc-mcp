import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { assertProjectIdShape } from './projects.js';
import {
  getTemplate,
  getTemplateAtVersion,
  publishTemplate,
  listVersions,
  listFirebaseProjects,
  extractParamValue,
  setParamValue,
} from './firebase.js';
import { diff, renderDiff, summarizeDiff } from './diff.js';
import { issueDiffToken, consumeDiffToken } from './tokens.js';
import { semanticHintFor } from './semantics.js';
import { authSummary, loginInteractive, NotSignedInError } from './auth.js';
import { writeKeyFile, readKeyFile, writeBackup, listWorkspace } from './workspace.js';

const INSTRUCTIONS = `firebase-rc-mcp gives the user read/write access to Firebase Remote Config on any Firebase project their signed-in Google account has access to.

This tool works with LOCAL FILES on the user's machine. Editing happens in JSON files in their workspace folder (default: ~/firebase-rc/). You read and edit those files using your normal Read / Edit / Write tools. The MCP only talks to Firebase to pull (download to file), diff (compare file to live), push (upload file), and roll back.

If the user has not signed in yet, calling any tool will fail with a "not signed in" error. When that happens, call rc_login — it opens the user's browser to a Google sign-in page and waits for them to complete the flow. Tell the user "I'm opening your browser to sign in — pick the Google account that has access to your Firebase project," then call rc_login. The tool blocks until sign-in completes (or 5 min timeout). After it returns, retry whatever they originally asked for.

Standard workflow for any change:
1. rc_pull — downloads the key's current live value into <workspace>/<project>/<key>.json. Returns the file path. If the file already exists and live hasn't changed, this is essentially a no-op (just refreshes metadata).
2. Read the file (use your Read tool — these files can be large, only read the section the user cares about if so).
3. Either let the user edit the file by hand, OR edit it yourself with your Edit tool based on what the user asked for.
4. rc_diff — reads the file from disk, compares to live Firebase, returns a structured diff + a short-lived single-use token. SHOW the diff to the user.
5. After explicit user confirmation ("yes", "publish", "go ahead"), call rc_push — reads the file from disk again, verifies token, publishes.

Strict rules:
- The file on disk is the source of truth. Always edit the file, not your own in-memory copy.
- Never call rc_push without first calling rc_diff in this turn — rc_push will refuse without a fresh token anyway.
- Never publish without an explicit yes from the user in this conversation. Past authorizations do not carry forward.
- For destructive-looking changes (removing fields, bulk rewrites, anything that removes or overwrites large amounts of data), re-confirm with specifics naming the impact.
- If rc_diff / rc_push return a version-mismatch refusal, pull again, re-apply the edit, then continue.
- Speak plainly. Don't say "ETag mismatch" — say "Firebase changed since we last looked, let me re-pull."
- After successful pull, tell the user the file path so they know where to find it if they want to look at it themselves.

If the user has never used this tool before and asks "what can you do," call rc_list_projects to show them the projects their account can reach, then ask which one to start with.
`;

function asJsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function asError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function maybeNotSignedIn(e: unknown) {
  if (e instanceof NotSignedInError) {
    return asError('Not signed in. Call rc_login — it will open the user\'s browser to sign in with Google.');
  }
  return null;
}

const projectArg = z.string().describe('Firebase project ID (e.g. "my-app-prod"). Whatever project the user wants to operate on; their Google account must have Remote Config Admin (or higher) on it.');

export async function startServer(): Promise<void> {
  const server = new McpServer({ name: 'firebase-rc-mcp', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'rc_auth_status',
    {
      description: 'Check whether the user is signed in. Call this first if anything fails with "not signed in." If signedIn is false, call rc_login.',
      inputSchema: {},
    },
    async () => {
      const s = authSummary();
      if (!s.signedIn) {
        return asJsonContent({
          signedIn: false,
          nextStep: 'Call rc_login — it will open the user\'s browser to sign in with Google.',
        });
      }
      return asJsonContent({
        signedIn: true,
        email: s.email,
        credsFile: s.credsFile,
        nextStep: 'Call rc_list_projects to see which Firebase projects this account can reach.',
      });
    }
  );

  server.registerTool(
    'rc_login',
    {
      description: 'Sign the user in with Google. Opens their browser to a sign-in page and waits for them to complete the flow (up to 5 minutes). If already signed in, returns immediately. Tell the user "I\'m opening your browser to sign in" right before calling this — the call blocks until they finish.',
      inputSchema: {},
    },
    async () => {
      const existing = authSummary();
      if (existing.signedIn) return asJsonContent({ alreadySignedIn: true, email: existing.email });
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Sign-in timed out after 5 minutes. Tell the user to try again.')), 5 * 60 * 1000)
        );
        const { email, credsFile } = await Promise.race([loginInteractive(), timeout]);
        return asJsonContent({ signedIn: true, email, credsFile, message: `Signed in as ${email ?? 'unknown'}. Now retry whatever the user originally asked for.` });
      } catch (e) {
        return asError(`Sign-in failed: ${(e as Error).message}`);
      }
    }
  );

  server.registerTool(
    'rc_workspace_info',
    {
      description: 'Show where local Remote Config files live on this machine and what is currently pulled.',
      inputSchema: {},
    },
    async () => {
      const ws = listWorkspace();
      return asJsonContent({
        workspaceRoot: ws.root,
        envOverride: process.env.FIREBASE_RC_MCP_WORKSPACE ? `FIREBASE_RC_MCP_WORKSPACE=${process.env.FIREBASE_RC_MCP_WORKSPACE}` : undefined,
        projects: ws.projects,
        note: 'Each project has its own folder. JSON files in that folder are the local working copies. Backups live under .backups/.',
      });
    }
  );

  server.registerTool(
    'rc_list_projects',
    {
      description: 'List every Firebase project the signed-in Google account has access to, via the Firebase Management API.',
      inputSchema: {},
    },
    async () => {
      try {
        const projects = await listFirebaseProjects();
        return asJsonContent({
          count: projects.length,
          projects: projects.map((p) => ({ projectId: p.projectId, displayName: p.displayName, state: p.state })),
          note: 'These are projects your account can SEE. Whether you can edit Remote Config on a given project also depends on having the Remote Config Admin role.',
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_list_keys',
    {
      description: 'List all Remote Config keys (parameter names) in a project, with type and size. Optional `filter` substring.',
      inputSchema: { project: projectArg, filter: z.string().optional().describe('Optional case-insensitive substring filter on key names.') },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const { template } = await getTemplate(project);
        const all = Object.keys(template.parameters ?? {}).sort();
        const f = (args.filter || '').toLowerCase();
        const filtered = f ? all.filter((k) => k.toLowerCase().includes(f)) : all;
        const keys = filtered.map((k) => {
          const p = template.parameters![k];
          return { key: k, valueType: p.valueType, sizeChars: (p.defaultValue?.value || '').length };
        });
        return asJsonContent({
          project,
          templateVersion: template.version?.versionNumber,
          lastUpdated: template.version?.updateTime,
          totalKeys: all.length,
          returnedKeys: keys.length,
          keys,
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_pull',
    {
      description: 'Download the current live value of a Remote Config key to a local JSON file at <workspace>/<project>/<key>.json (default workspace: ~/firebase-rc/). Returns the file path so you (or the user) can open/edit it. If the file already exists locally with unpublished edits, refuses unless overwriteLocal=true.',
      inputSchema: {
        project: projectArg,
        key: z.string().describe('Remote Config parameter key.'),
        overwriteLocal: z.boolean().optional().describe('If a local file with local edits exists, set true to overwrite. Default false.'),
      },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const { template, etag } = await getTemplate(project);
        const info = extractParamValue(template, args.key);
        if (!info.exists) return asError(`Key "${args.key}" does not exist in project "${project}".`);

        const existing = readKeyFile(project, args.key);
        if (existing.exists && !args.overwriteLocal) {
          const localChanges = diff(info.parsed, existing.parsed);
          if (localChanges.length > 0) {
            const sameVersion = existing.meta?.pulledTemplateVersion === template.version?.versionNumber;
            return asError(
              `Local file at ${existing.filePath} has ${localChanges.length} unpublished edit(s) vs live (live is v${template.version?.versionNumber}, local was pulled from v${existing.meta?.pulledTemplateVersion ?? '?'}). ` +
              (sameVersion
                ? `Live hasn't changed since you pulled — your local edits are still valid. To discard them and re-pull, call rc_pull again with overwriteLocal=true.`
                : `Live has ALSO changed since you pulled. Call rc_pull with overwriteLocal=true to discard local edits, OR push your local edits first via rc_diff + rc_push.`)
            );
          }
        }

        const backup = writeBackup(project, args.key, info.parsed, 'pulled');
        const { filePath, metaPath } = writeKeyFile(project, args.key, info.parsed, {
          project,
          key: args.key,
          valueType: info.valueType ?? 'JSON',
          pulledAt: new Date().toISOString(),
          pulledTemplateVersion: template.version?.versionNumber ?? '',
          pulledEtag: etag,
          description: info.description,
        });
        return asJsonContent({
          project,
          key: args.key,
          filePath,
          metaPath,
          backupPath: backup,
          valueType: info.valueType,
          templateVersion: template.version?.versionNumber,
          sizeChars: existing.raw?.length ?? (typeof info.parsed === 'string' ? info.parsed.length : JSON.stringify(info.parsed).length),
          pulledAt: new Date().toISOString(),
          semanticHint: semanticHintFor(project, args.key),
          message: `Saved to ${filePath}. Open it in your editor or ask me to make changes, then say "diff" or "publish".`,
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_diff',
    {
      description: 'Compare the LOCAL FILE (<workspace>/<project>/<key>.json) against the current live Remote Config value. Returns a structured diff, a human-readable summary, and a short-lived single-use diffToken (10 min) that rc_push requires. ALWAYS show the diff to the user and get explicit confirmation before calling rc_push. Must rc_pull first if the file does not exist.',
      inputSchema: {
        project: projectArg,
        key: z.string().describe('Remote Config parameter key.'),
      },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const local = readKeyFile(project, args.key);
        if (!local.exists) return asError(`No local file for "${args.key}" in project "${project}". Call rc_pull first.`);

        const { template, etag } = await getTemplate(project);
        const info = extractParamValue(template, args.key);
        if (!info.exists) return asError(`Key "${args.key}" does not exist in project "${project}".`);

        const changes = diff(info.parsed, local.parsed);
        const liveChanged = local.meta && local.meta.pulledTemplateVersion !== template.version?.versionNumber;

        const { token, expiresInMs } = issueDiffToken({
          project,
          key: args.key,
          newValue: local.parsed,
          expectedEtag: etag,
          expectedTemplateVersion: template.version?.versionNumber ?? '',
        });
        return asJsonContent({
          project,
          key: args.key,
          filePath: local.filePath,
          changeCount: changes.length,
          summary: summarizeDiff(changes),
          changes,
          rendered: renderDiff(changes),
          diffToken: token,
          diffTokenExpiresInMs: expiresInMs,
          currentLiveVersion: template.version?.versionNumber,
          localPulledFromVersion: local.meta?.pulledTemplateVersion,
          liveChangedSincePull: !!liveChanged,
          liveChangedWarning: liveChanged
            ? `Live version is now v${template.version?.versionNumber} but local was pulled from v${local.meta?.pulledTemplateVersion}. The diff above is against CURRENT live. Push will be allowed but consider whether someone else's changes need to merge.`
            : undefined,
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_push',
    {
      description: 'Publish the LOCAL FILE to Firebase Remote Config. REQUIRES a fresh diffToken from a recent rc_diff call with the same key. Refuses if no diff was computed, if the file changed since rc_diff (hash mismatch), if the token expired (10 min), or if live Firebase changed since rc_diff. Will NOT publish without explicit confirmation from the user.',
      inputSchema: {
        project: projectArg,
        key: z.string().describe('Remote Config parameter key.'),
        diffToken: z.string().describe('Token returned from rc_diff for this key.'),
      },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const local = readKeyFile(project, args.key);
        if (!local.exists) return asError(`No local file for "${args.key}" in project "${project}". Call rc_pull first.`);

        const consume = consumeDiffToken({ token: args.diffToken, project, key: args.key, newValue: local.parsed });
        if (!consume.ok) return asError(consume.reason);

        const { template, etag } = await getTemplate(project);
        if (template.version?.versionNumber && consume.entry.expectedTemplateVersion && template.version.versionNumber !== consume.entry.expectedTemplateVersion) {
          return asError(`Live version is now v${template.version.versionNumber} but rc_diff was computed against v${consume.entry.expectedTemplateVersion}. Someone else published in between. Pull again, re-diff, then push.`);
        }
        const info = extractParamValue(template, args.key);
        if (!info.exists) return asError(`Key "${args.key}" does not exist in project "${project}".`);

        const prePushBackup = writeBackup(project, args.key, info.parsed, 'pre-push');

        setParamValue(template, args.key, local.parsed, info.valueType);

        try { await publishTemplate(project, template, { ifMatch: etag, validateOnly: true }); }
        catch (e) { return asError(`Firebase rejected the template (validation): ${(e as Error).message}`); }

        const published = await publishTemplate(project, template, { ifMatch: etag });

        writeKeyFile(project, args.key, local.parsed, {
          project,
          key: args.key,
          valueType: info.valueType ?? 'JSON',
          pulledAt: new Date().toISOString(),
          pulledTemplateVersion: published.version?.versionNumber ?? '',
          pulledEtag: '',
          description: info.description,
        });

        return asJsonContent({
          project,
          key: args.key,
          newVersion: published.version?.versionNumber,
          publishedAt: published.version?.updateTime,
          publishedBy: published.version?.updateUser?.email,
          prePushBackup,
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_list_versions',
    {
      description: 'List recent template versions for a project — versionNumber, updateTime, who updated, origin.',
      inputSchema: { project: projectArg, limit: z.number().int().min(1).max(100).optional().describe('Number of versions to return (default 15).') },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const versions = await listVersions(project, args.limit ?? 15);
        return asJsonContent({ project, versions });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_rollback',
    {
      description: 'Roll the entire template back to a previous version. This creates a NEW version with the contents of the target version. Affects ALL keys in the project, not just one. Requires confirmPhrase: "rollback".',
      inputSchema: {
        project: projectArg,
        versionNumber: z.number().int().min(1).describe('Version number to restore (from rc_list_versions).'),
        confirmPhrase: z.literal('rollback').describe('Must be exactly the string "rollback" — guards against accidental restores.'),
      },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        if (args.confirmPhrase !== 'rollback') return asError('confirmPhrase must be exactly "rollback".');
        const target = await getTemplateAtVersion(project, args.versionNumber);
        const published = await publishTemplate(project, target.template, { ifMatch: '*' });
        return asJsonContent({
          project,
          restoredFrom: args.versionNumber,
          newVersion: published.version?.versionNumber,
          publishedAt: published.version?.updateTime,
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((e) => {
    console.error('Server failed to start:', (e as Error).message);
    process.exit(1);
  });
}
