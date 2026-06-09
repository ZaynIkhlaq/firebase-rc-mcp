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
import { authSummary, loginInteractive, NotSignedInError } from './auth.js';
import { freshEditFile, readEditFileRaw, deleteEditFile, parseByType, sweepStaleTemps } from './tempedit.js';
import { parseCurl, fireRevalidate, describeRevalidate } from './revalidate.js';
import {
  readKnowledge,
  getProject,
  setProjectMeta,
  recordTouch,
  recordPushHistory,
  recordCoEdits,
  addNote,
  keyContext,
  summarize,
  type RevalidateSpec,
} from './knowledge.js';

const BASE_INSTRUCTIONS = `firebase-rc gives the user read/write access to Firebase Remote Config on any Firebase project their signed-in Google account has access to.

There are NO local copies of config values. Live Firebase is always the source of truth. To edit a key you pull it (which writes the CURRENT live value to a throwaway temp file), edit that temp file, diff it against live, and push. The temp file is deleted on a successful push.

If the user is brand new (no known context below), run rc_setup — a one-time guided onboarding that signs them in, records the projects they care about (with env + purpose), and optionally captures a post-push cache-invalidation curl. After that, every session starts warm.

If any tool fails with "not signed in," run rc_setup (preferred) or rc_login. Both open the user's browser to a Google sign-in and block until done (up to 5 min). Tell the user "I'm opening your browser to sign in" first, then call it, then retry.

Standard change workflow:
1. rc_pull(project, key) — writes the current live value to a temp file and returns its path (plus any notes/history we've learned about this key).
2. Edit that temp file with your normal Read/Edit/Write tools (or let the user edit it).
3. rc_diff(project, key, editFile) — diffs the temp file against current live, returns a structured diff + a short-lived single-use diffToken. SHOW the diff to the user.
4. After an explicit "yes" from the user this turn, rc_push(project, key, editFile, diffToken) — publishes, deletes the temp file, and (if a revalidate curl is stored for the project) automatically fires it so the change takes effect.

Learning — keep the user's context sharp over time (this is local-only, never uploaded):
- When you learn something durable about a key or project that the user couldn't trivially re-derive (what a key controls, a gotcha, env-specific behavior), record it with rc_remember.
- When you push, pass a short \`why\` so the change is logged with intent.
- Call rc_context anytime to recall what we know.

Strict rules:
- Never rc_push without a fresh diffToken from rc_diff this turn — it will refuse anyway.
- Never publish without an explicit yes from the user in this conversation. Past authorizations do not carry forward.
- For destructive-looking changes (removing fields, bulk rewrites), re-confirm with specifics naming the impact.
- If a tool reports a version mismatch, the live config changed since you looked — pull again, re-apply, re-diff. Say it plainly ("Firebase changed since we last looked, re-pulling"), not "ETag mismatch."`;

function buildInstructions(): string {
  const summary = summarize();
  return summary ? `${BASE_INSTRUCTIONS}\n\n${summary}` : BASE_INSTRUCTIONS;
}

function asJsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function asError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function maybeNotSignedIn(e: unknown) {
  if (e instanceof NotSignedInError) {
    return asError('Not signed in. Run rc_setup (preferred — also records your projects) or rc_login to open the browser and sign in with Google.');
  }
  return null;
}

async function loginWithTimeout(): Promise<{ email?: string; credsFile: string }> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Sign-in timed out after 5 minutes. Tell the user to try again.')), 5 * 60 * 1000)
  );
  return Promise.race([loginInteractive(), timeout]);
}

// Tracks which keys were touched this process (session) so rc_push can learn
// which keys get edited together. In-memory only.
const sessionTouched = new Map<string, Set<string>>();
function markTouched(project: string, key: string) {
  let set = sessionTouched.get(project);
  if (!set) sessionTouched.set(project, (set = new Set()));
  set.add(key);
}
function otherKeysTouched(project: string, key: string): string[] {
  return [...(sessionTouched.get(project) ?? [])].filter((k) => k !== key);
}

const projectArg = z.string().describe('Firebase project ID (e.g. "my-app-prod"). The signed-in Google account must have Remote Config Admin (or higher) on it.');

export async function startServer(): Promise<void> {
  sweepStaleTemps();
  const server = new McpServer({ name: 'firebase-rc', version: '0.2.0' }, { instructions: buildInstructions() });

  server.registerTool(
    'rc_auth_status',
    {
      description: 'Check whether the user is signed in. If signedIn is false, run rc_setup (preferred) or rc_login.',
      inputSchema: {},
    },
    async () => {
      const s = authSummary();
      if (!s.signedIn) return asJsonContent({ signedIn: false, nextStep: 'Run rc_setup to sign in and record your projects (or rc_login to just sign in).' });
      return asJsonContent({ signedIn: true, email: s.email, credsFile: s.credsFile });
    }
  );

  server.registerTool(
    'rc_login',
    {
      description: 'Sign in with Google. Opens the browser and blocks until done (up to 5 min). Prefer rc_setup for first-time users. Tell the user "I\'m opening your browser to sign in" right before calling this.',
      inputSchema: {},
    },
    async () => {
      const existing = authSummary();
      if (existing.signedIn) return asJsonContent({ alreadySignedIn: true, email: existing.email });
      try {
        const { email, credsFile } = await loginWithTimeout();
        return asJsonContent({ signedIn: true, email, credsFile, message: `Signed in as ${email ?? 'unknown'}. Now retry whatever the user originally asked for.` });
      } catch (e) {
        return asError(`Sign-in failed: ${(e as Error).message}`);
      }
    }
  );

  server.registerTool(
    'rc_setup',
    {
      description:
        'One-time guided onboarding. Call with NO arguments first: it signs the user in (opens browser, blocks) and returns the projects their account can reach, with instructions to gather which projects they work with, each project\'s env + one-line purpose, and an optional post-push revalidate curl. Then call it AGAIN with the `projects` array to save everything. Re-run anytime to add/update projects.',
      inputSchema: {
        projects: z
          .array(
            z.object({
              projectId: z.string().describe('Firebase project ID.'),
              env: z.string().optional().describe('Environment label, e.g. "dev", "staging", "prod".'),
              purpose: z.string().optional().describe('One-line description of what this project is for.'),
              revalidateCurl: z
                .string()
                .optional()
                .describe('OPTIONAL. The full revalidate curl command the user pastes. Fired automatically after each push to this project. Stored locally (mode 0600).'),
            })
          )
          .optional()
          .describe('Omit on the first call (discovery). Provide on the second call to persist the gathered setup.'),
      },
    },
    async (args) => {
      // Phase 1: ensure signed in (login happens here — no separate session needed).
      if (!authSummary().signedIn) {
        try {
          await loginWithTimeout();
        } catch (e) {
          return asError(`Sign-in failed: ${(e as Error).message}`);
        }
      }
      const s = authSummary();

      // Phase 2 (no projects yet): discover + guide.
      if (!args.projects || args.projects.length === 0) {
        try {
          const projects = await listFirebaseProjects();
          return asJsonContent({
            step: 'collect',
            signedInAs: s.email,
            projects: projects.map((p) => ({ projectId: p.projectId, displayName: p.displayName })),
            instructions:
              'Ask the user which of these projects they actually work with. For each chosen project get: an env (dev/staging/prod) and a one-line purpose. Then ask if they want automatic cache-invalidation after a push — if yes, have them paste the full revalidate curl for that project (different per env). Finally call rc_setup again with the `projects` array filled in. This only needs doing once.',
          });
        } catch (e) {
          return maybeNotSignedIn(e) ?? asError((e as Error).message);
        }
      }

      // Phase 3: persist.
      const saved: Array<{ projectId: string; env?: string; purpose?: string; revalidate?: string }> = [];
      for (const p of args.projects) {
        let revalidate: RevalidateSpec | undefined;
        if (p.revalidateCurl && p.revalidateCurl.trim()) {
          try {
            revalidate = parseCurl(p.revalidateCurl);
          } catch (e) {
            return asError(`Couldn't parse the revalidate curl for ${p.projectId}: ${(e as Error).message}`);
          }
        }
        setProjectMeta(p.projectId, { env: p.env, purpose: p.purpose, revalidate });
        saved.push({ projectId: p.projectId, env: p.env, purpose: p.purpose, revalidate: revalidate ? describeRevalidate(revalidate) : undefined });
      }
      return asJsonContent({
        step: 'done',
        signedInAs: s.email,
        saved,
        message: 'Setup complete. Future sessions start warm — I\'ll already know these projects. Just tell me what to change.',
      });
    }
  );

  server.registerTool(
    'rc_context',
    {
      description: 'Recall everything firebase-rc has learned locally about the user: their projects (env/purpose), frequently-edited keys, notes, and recent change history. Use at the start of work to avoid cold-listing projects/keys. Secrets in revalidate curls are redacted.',
      inputSchema: {},
    },
    async () => {
      const k = readKnowledge();
      return asJsonContent({
        projects: k.projects.map((p) => ({
          projectId: p.projectId,
          env: p.env,
          purpose: p.purpose,
          revalidate: p.revalidate ? describeRevalidate(p.revalidate) : undefined,
          keys: Object.fromEntries(
            Object.entries(p.keys).map(([key, s]) => [
              key,
              { touches: s.touches, lastTouchedAt: s.lastTouchedAt, valueType: s.valueType, notes: s.notes, lastChange: s.history[0] },
            ])
          ),
          coEdits: p.coEdits,
        })),
        notes: k.notes,
        updatedAt: k.updatedAt,
      });
    }
  );

  server.registerTool(
    'rc_remember',
    {
      description:
        'Record a durable, local-only note about a key or project — something the user could not trivially re-derive (what a key controls, a gotcha, env-specific behavior). With project+key it attaches to that key; with just project it is a project note; with neither it is a global note. Call this whenever you learn something worth keeping.',
      inputSchema: {
        text: z.string().describe('The fact to remember. Keep it concise and durable.'),
        project: z.string().optional().describe('Project ID this note is about.'),
        key: z.string().optional().describe('Key this note is about (requires project).'),
      },
    },
    async (args) => {
      addNote({ projectId: args.project, key: args.key, text: args.text });
      return asJsonContent({ remembered: true, scope: args.key ? `${args.project}/${args.key}` : args.project ?? 'global' });
    }
  );

  server.registerTool(
    'rc_list_projects',
    {
      description: 'List every Firebase project the signed-in account can reach. Usually unnecessary once rc_setup has run — prefer rc_context.',
      inputSchema: {},
    },
    async () => {
      try {
        const projects = await listFirebaseProjects();
        return asJsonContent({
          count: projects.length,
          projects: projects.map((p) => ({ projectId: p.projectId, displayName: p.displayName, state: p.state })),
          note: 'These are projects your account can SEE. Editing also requires the Remote Config Admin role.',
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_list_keys',
    {
      description: 'List all Remote Config keys in a project, with type and size. Optional `filter` substring.',
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
      description:
        'Fetch the CURRENT live value of a Remote Config key and write it to a throwaway temp file for editing. Returns the temp file path plus any notes/history we have learned about this key. There is no persistent local copy — the file is deleted after a successful push. Always pull fresh right before editing.',
      inputSchema: { project: projectArg, key: z.string().describe('Remote Config parameter key.') },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const { template } = await getTemplate(project);
        const info = extractParamValue(template, args.key);
        if (!info.exists) return asError(`Key "${args.key}" does not exist in project "${project}".`);

        const editFile = freshEditFile(project, args.key, info.parsed);
        recordTouch(project, args.key, info.valueType);
        markTouched(project, args.key);
        const ctx = keyContext(project, args.key);

        return asJsonContent({
          project,
          key: args.key,
          editFile,
          valueType: info.valueType,
          templateVersion: template.version?.versionNumber,
          priorNotes: ctx?.notes?.slice(0, 5).map((n) => n.text),
          lastChange: ctx?.lastChange,
          message: `Live value written to ${editFile}. Edit that file, then call rc_diff. (Ephemeral — deleted after push, never a persistent copy.)`,
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_diff',
    {
      description:
        'Diff the edited temp file against the CURRENT live Remote Config value. Returns a structured diff, a summary, and a short-lived single-use diffToken (10 min) that rc_push requires. ALWAYS show the diff and get an explicit yes before pushing.',
      inputSchema: {
        project: projectArg,
        key: z.string().describe('Remote Config parameter key.'),
        editFile: z.string().describe('Path to the temp file returned by rc_pull.'),
      },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const raw = readEditFileRaw(args.editFile);
        const { template, etag } = await getTemplate(project);
        const info = extractParamValue(template, args.key);
        if (!info.exists) return asError(`Key "${args.key}" does not exist in project "${project}".`);

        const newValue = parseByType(raw, info.valueType);
        const changes = diff(info.parsed, newValue);

        if (changes.length === 0) {
          return asJsonContent({ project, key: args.key, changeCount: 0, summary: 'No changes — the edited file matches live. Nothing to push.' });
        }

        const { token, expiresInMs } = issueDiffToken({
          project,
          key: args.key,
          newValue,
          expectedEtag: etag,
          expectedTemplateVersion: template.version?.versionNumber ?? '',
        });
        return asJsonContent({
          project,
          key: args.key,
          editFile: args.editFile,
          changeCount: changes.length,
          summary: summarizeDiff(changes),
          changes,
          rendered: renderDiff(changes),
          diffToken: token,
          diffTokenExpiresInMs: expiresInMs,
          currentLiveVersion: template.version?.versionNumber,
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_push',
    {
      description:
        'Publish the edited temp file to Firebase Remote Config. REQUIRES a fresh diffToken from rc_diff this turn. Refuses if the file changed since rc_diff, the token expired, or live changed since rc_diff. On success: deletes the temp file, logs the change, and (unless skipRevalidate) fires the project\'s stored revalidate curl so the change takes effect. Never publishes without an explicit yes from the user.',
      inputSchema: {
        project: projectArg,
        key: z.string().describe('Remote Config parameter key.'),
        editFile: z.string().describe('Path to the temp file returned by rc_pull.'),
        diffToken: z.string().describe('Token returned from rc_diff for this key.'),
        why: z.string().optional().describe('Short reason for this change — logged to the key\'s local history for future context.'),
        skipRevalidate: z.boolean().optional().describe('Set true to NOT fire the post-push revalidate curl this time.'),
      },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const raw = readEditFileRaw(args.editFile);
        const { template, etag } = await getTemplate(project);
        const info = extractParamValue(template, args.key);
        if (!info.exists) return asError(`Key "${args.key}" does not exist in project "${project}".`);

        const newValue = parseByType(raw, info.valueType);
        const consume = consumeDiffToken({ token: args.diffToken, project, key: args.key, newValue });
        if (!consume.ok) return asError(consume.reason);

        if (
          template.version?.versionNumber &&
          consume.entry.expectedTemplateVersion &&
          template.version.versionNumber !== consume.entry.expectedTemplateVersion
        ) {
          return asError(`Firebase changed since we last looked (live is now v${template.version.versionNumber}, diff was v${consume.entry.expectedTemplateVersion}). Pull again, re-apply, re-diff, then push.`);
        }

        const changeSummary = summarizeDiff(diff(info.parsed, newValue));
        setParamValue(template, args.key, newValue, info.valueType);

        try {
          await publishTemplate(project, template, { ifMatch: etag, validateOnly: true });
        } catch (e) {
          return asError(`Firebase rejected the template (validation): ${(e as Error).message}`);
        }
        const published = await publishTemplate(project, template, { ifMatch: etag });

        // Edit is live — drop the temp file and learn from this change.
        deleteEditFile(args.editFile);
        const proj = getProject(readKnowledge(), project);
        recordTouch(project, args.key, info.valueType);
        recordPushHistory(project, args.key, { env: proj?.env, summary: changeSummary, why: args.why });
        recordCoEdits(project, args.key, otherKeysTouched(project, args.key));

        // Fire the post-push cache invalidation, if configured.
        let revalidate: unknown;
        if (!args.skipRevalidate && proj?.revalidate) {
          try {
            revalidate = await fireRevalidate(proj.revalidate);
          } catch (e) {
            revalidate = { ok: false, error: (e as Error).message, note: 'Push succeeded but revalidate failed — the config is live but the cache may not be busted yet.' };
          }
        } else if (!args.skipRevalidate) {
          revalidate = { skipped: true, reason: 'No revalidate curl stored for this project. Add one via rc_setup if you want auto-invalidation.' };
        }

        return asJsonContent({
          project,
          key: args.key,
          newVersion: published.version?.versionNumber,
          publishedAt: published.version?.updateTime,
          publishedBy: published.version?.updateUser?.email,
          revalidate,
        });
      } catch (e) {
        return maybeNotSignedIn(e) ?? asError((e as Error).message);
      }
    }
  );

  server.registerTool(
    'rc_revalidate',
    {
      description: 'Manually fire the stored post-push cache-invalidation curl for a project (the same one rc_push fires automatically). Useful to re-trigger invalidation without re-publishing.',
      inputSchema: { project: projectArg },
    },
    async (args) => {
      try {
        const project = assertProjectIdShape(args.project);
        const proj = getProject(readKnowledge(), project);
        if (!proj?.revalidate) return asError(`No revalidate curl stored for "${project}". Add one via rc_setup.`);
        const result = await fireRevalidate(proj.revalidate);
        return asJsonContent({ project, ...result });
      } catch (e) {
        return asError((e as Error).message);
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
      description: 'Roll the entire template back to a previous version. Creates a NEW version with that version\'s contents. Affects ALL keys in the project. Requires confirmPhrase: "rollback".',
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
