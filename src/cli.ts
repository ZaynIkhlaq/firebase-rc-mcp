#!/usr/bin/env node
import { authSummary, loginInteractive, deleteOurCreds } from './auth.js';
import { listFirebaseProjects } from './firebase.js';

async function cmdLogin() {
  const already = authSummary();
  if (already.signedIn) {
    console.error(`Already signed in as ${already.email ?? '(unknown email)'}.`);
    console.error('Run `firebase-rc logout` first if you want to switch accounts.');
    return;
  }
  try {
    const { email, credsFile } = await loginInteractive();
    console.error(`\nSigned in as ${email ?? '(unknown email)'}.`);
    console.error(`Credentials saved to ${credsFile}.`);
    console.error('\nNext: register this MCP server with your client. For Claude Code:');
    console.error('  claude mcp add firebase-rc -- npx -y firebase-rc');
  } catch (e) {
    console.error(`\nLogin failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdLogout() {
  const removed = deleteOurCreds();
  if (removed) console.error('Signed out. Credentials removed.');
  else console.error('No credentials stored by firebase-rc. (firebase-tools credentials, if any, are left alone.)');
}

async function cmdStatus() {
  const s = authSummary();
  if (!s.signedIn) {
    console.error('Not signed in. Run: npx -y firebase-rc login');
    process.exitCode = 1;
    return;
  }
  console.error(`Signed in as: ${s.email ?? '(unknown email)'}`);
  console.error(`Credentials:  ${s.credsFile}`);
  console.error('\nProjects your account can see:');
  try {
    const projects = await listFirebaseProjects();
    if (!projects.length) {
      console.error('  (none — your account has no Firebase projects visible to it)');
    } else {
      for (const p of projects.slice(0, 20)) {
        console.error(`  - ${p.projectId}${p.displayName ? `  (${p.displayName})` : ''}`);
      }
      if (projects.length > 20) console.error(`  ... and ${projects.length - 20} more`);
    }
  } catch (e) {
    console.error(`  Could not list projects: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

function cmdHelp() {
  console.error(`firebase-rc - Firebase Remote Config from any MCP client

Usage:
  firebase-rc login     Sign in with Google (one-time per machine).
  firebase-rc logout    Remove stored credentials.
  firebase-rc status    Show current account and reachable projects.
  firebase-rc           Start the MCP server (stdio) - invoked by your MCP client.

After 'login', register with Claude Code:
  claude mcp add firebase-rc -- npx -y firebase-rc

You operate on any Firebase project your signed-in Google account has
Remote Config Admin (or higher) on. No allowlist, no config files.
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
