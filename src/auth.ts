import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OAuth2Client } from 'google-auth-library';
import { FIREBASE_CLIENT_ID, FIREBASE_CLIENT_SECRET, SCOPES, runBrowserOAuth } from './oauth.js';

// We accept refresh tokens from two places, in priority order:
//   1. Our own creds file at ~/.config/firebase-rc-mcp/auth.json (or XDG/AppData equivalent).
//      Written by `firebase-rc-mcp login`.
//   2. firebase-tools' creds file at ~/.config/configstore/firebase-tools.json
//      (or platform equivalent). Lets users who've already done `firebase login`
//      skip our login step entirely.
// Both formats store a Google refresh token issued to the firebase-tools public
// OAuth client, so the same client_id/client_secret can refresh either.

type OurCreds = { refreshToken: string; email?: string; sub?: string; createdAt: string };
type FbToolsCreds = { user?: { email?: string }; tokens?: { refresh_token?: string } };

function ourCredsPath(): string {
  // Mirror configstore's path conventions so users on any OS end up in a sensible place.
  if (process.env.FIREBASE_RC_MCP_AUTH_FILE) return process.env.FIREBASE_RC_MCP_AUTH_FILE;
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'firebase-rc-mcp', 'auth.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'firebase-rc-mcp', 'auth.json');
  return path.join(home, '.config', 'firebase-rc-mcp', 'auth.json');
}

function firebaseToolsCredsPaths(): string[] {
  // firebase-tools uses the `configstore` package, which picks different
  // base dirs per platform. We check all the locations it might have written to.
  const home = os.homedir();
  const out: string[] = [];
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    out.push(path.join(base, 'configstore', 'firebase-tools.json'));
  } else if (process.platform === 'darwin') {
    out.push(path.join(home, '.config', 'configstore', 'firebase-tools.json'));
    out.push(path.join(home, 'Library', 'Preferences', 'configstore', 'firebase-tools.json'));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    out.push(path.join(xdg, 'configstore', 'firebase-tools.json'));
  }
  return out;
}

function readOurCreds(): OurCreds | null {
  const p = ourCredsPath();
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as OurCreds; } catch { return null; }
}

function readFirebaseToolsCreds(): { refreshToken: string; email?: string; source: string } | null {
  for (const p of firebaseToolsCredsPaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as FbToolsCreds;
      const rt = j.tokens?.refresh_token;
      if (rt) return { refreshToken: rt, email: j.user?.email, source: p };
    } catch { /* try next */ }
  }
  return null;
}

export function writeOurCreds(c: OurCreds): void {
  const p = ourCredsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function deleteOurCreds(): boolean {
  const p = ourCredsPath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

function resolveRefreshToken(): { refreshToken: string; email?: string; source: string } {
  const ours = readOurCreds();
  if (ours?.refreshToken) return { refreshToken: ours.refreshToken, email: ours.email, source: ourCredsPath() };
  const fb = readFirebaseToolsCreds();
  if (fb) return fb;
  throw new NotSignedInError();
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedClient: OAuth2Client | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const { refreshToken } = resolveRefreshToken();
  if (!cachedClient) {
    cachedClient = new OAuth2Client({ clientId: FIREBASE_CLIENT_ID, clientSecret: FIREBASE_CLIENT_SECRET });
    cachedClient.setCredentials({ refresh_token: refreshToken });
  }
  const res = await cachedClient.getAccessToken();
  if (!res.token) throw new Error('Failed to refresh access token. Run `firebase-rc-mcp login` again.');
  const expiry = (cachedClient.credentials.expiry_date as number | undefined) ?? Date.now() + 55 * 60 * 1000;
  cachedToken = { token: res.token, expiresAt: expiry };
  return res.token;
}

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in. Run `npx -y firebase-rc-mcp login` in your terminal and pick the Google account that has access to your Firebase project.');
    this.name = 'NotSignedInError';
  }
}

export function authSummary(): { signedIn: boolean; email?: string; credsFile?: string } {
  const ours = readOurCreds();
  if (ours?.refreshToken) return { signedIn: true, email: ours.email, credsFile: ourCredsPath() };
  const fb = readFirebaseToolsCreds();
  if (fb) return { signedIn: true, email: fb.email, credsFile: fb.source };
  return { signedIn: false };
}

export async function loginInteractive(): Promise<{ email?: string; credsFile: string }> {
  const result = await runBrowserOAuth();
  writeOurCreds({
    refreshToken: result.refreshToken,
    email: result.email,
    sub: result.sub,
    createdAt: new Date().toISOString(),
  });
  cachedToken = { token: result.accessToken, expiresAt: result.expiresAt };
  return { email: result.email, credsFile: ourCredsPath() };
}

export { SCOPES };
