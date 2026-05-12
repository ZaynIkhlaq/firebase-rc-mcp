import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OAuth2Client } from 'google-auth-library';

// Piggyback on firebase-tools' login. After the user runs `firebase login` once,
// their refresh token lives at the path below. We refresh access tokens against
// the same public OAuth client identity that firebase-tools ships with — these
// values are not secret; they're embedded in every npm install of firebase-tools
// and identify the application, not authenticate it.
const FIREBASE_TOOLS_CREDS = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
const FIREBASE_TOOLS_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_TOOLS_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

type FirebaseToolsConfig = {
  user?: { email?: string };
  tokens?: { refresh_token?: string };
};

function readCreds(): FirebaseToolsConfig {
  if (!fs.existsSync(FIREBASE_TOOLS_CREDS)) throw new NotSignedInError();
  return JSON.parse(fs.readFileSync(FIREBASE_TOOLS_CREDS, 'utf8')) as FirebaseToolsConfig;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedClient: OAuth2Client | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;

  const creds = readCreds();
  const refreshToken = creds.tokens?.refresh_token;
  if (!refreshToken) throw new NotSignedInError();

  if (!cachedClient) {
    cachedClient = new OAuth2Client({ clientId: FIREBASE_TOOLS_CLIENT_ID, clientSecret: FIREBASE_TOOLS_CLIENT_SECRET });
    cachedClient.setCredentials({ refresh_token: refreshToken });
  }
  const res = await cachedClient.getAccessToken();
  if (!res.token) throw new Error('Failed to refresh access token. Re-run `firebase login`.');
  const expiry = (cachedClient.credentials.expiry_date as number | undefined) ?? Date.now() + 55 * 60 * 1000;
  cachedToken = { token: res.token, expiresAt: expiry };
  return res.token;
}

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in. Run `firebase login` in a terminal first.');
    this.name = 'NotSignedInError';
  }
}

export function authSummary(): { signedIn: boolean; email?: string; credsFile: string } {
  if (!fs.existsSync(FIREBASE_TOOLS_CREDS)) return { signedIn: false, credsFile: FIREBASE_TOOLS_CREDS };
  try {
    const c = readCreds();
    return { signedIn: !!c.tokens?.refresh_token, email: c.user?.email, credsFile: FIREBASE_TOOLS_CREDS };
  } catch {
    return { signedIn: false, credsFile: FIREBASE_TOOLS_CREDS };
  }
}
