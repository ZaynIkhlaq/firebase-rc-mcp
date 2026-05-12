#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { authSummary } from './auth.js';
import { listFirebaseProjects } from './firebase.js';

// Path to the firebase-tools CLI bundled as a dependency of this package.
function firebaseBinPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli.js → dist → package root → node_modules/.bin/firebase
  return path.resolve(here, '..', 'node_modules', '.bin', 'firebase');
}

function runFirebase(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(firebaseBinPath(), args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(`Could not run bundled firebase CLI: ${err.message}`);
      console.error('Fallback: `npx -y firebase-tools ' + args.join(' ') + '`');
      resolve(1);
    });
  });
}

async function cmdLogin() {
  const code = await runFirebase(['login']);
  process.exit(code);
}

async function cmdLogout() {
  const code = await runFirebase(['logout']);
  process.exit(code);
}

async function cmdStatus() {
  const s = authSummary();
  if (!s.signedIn) {
    console.error('Not signed in. Run: npx -y firebase-rc-mcp login');
    process.exitCode = 1;
    return;
  }
  console.error(`Signed in as: ${s.email ?? '(unknown email)'}`);
  console.error(`Credentials:  ${s.credsFile}`);
  console.error('\nFetching projects your account can see…');
  try {
    const projects = await listFirebaseProjects();
    console.error(`  ${projects.length} project(s) reachable:`);
    for (const p of projects.slice(0, 20)) {
      console.error(`    • ${p.projectId}${p.displayName ? `  (${p.displayName})` : ''}`);
    }
    if (projects.length > 20) console.error(`    … and ${projects.length - 20} more`);
  } catch (e) {
    console.error(`  Could not list projects: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function cmdHelp() {
  console.error(`firebase-rc-mcp — Firebase Remote Config from any MCP client

Usage:
  firebase-rc-mcp login     Sign in with Google (one-time per machine).
  firebase-rc-mcp logout    Remove stored credentials.
  firebase-rc-mcp status    Show current account + projects reachable.
  firebase-rc-mcp           Start the MCP server (stdio) — invoked by Claude Code.

After 'login', register with Claude Code:
  claude mcp add firebase-rc -- npx -y firebase-rc-mcp

You operate on any Firebase project your signed-in Google account has
Remote Config Admin (or higher) on — no allowlist, no config files.
`);
}

async function main() {
  const sub = process.argv[2];
  if (sub === 'login' || sub === 'signin' || sub === 'sign-in') return cmdLogin();
  if (sub === 'logout' || sub === 'signout' || sub === 'sign-out') return cmdLogout();
  if (sub === 'status' || sub === 'whoami') return cmdStatus();
  if (sub === '-h' || sub === '--help' || sub === 'help') { cmdHelp(); return; }
  await (await import('./server.js')).startServer();
}

main().catch((e) => {
  console.error((e as Error).message || e);
  process.exit(1);
});
