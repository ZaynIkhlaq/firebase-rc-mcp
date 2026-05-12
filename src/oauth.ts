import http from 'node:http';
import { AddressInfo } from 'node:net';
import { OAuth2Client } from 'google-auth-library';

// We act as the same OAuth client that the firebase-tools CLI ships with.
// These values are public — they're baked into every install of firebase-tools
// (src/api.ts in that repo) and into every install of this package. For a
// desktop/installed-app OAuth client, the "secret" identifies the app, not
// authenticates it. Security comes from the loopback redirect + per-user
// consent + on-disk refresh-token storage at 0600.
export const FIREBASE_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
export const FIREBASE_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

// Match the scopes firebase-tools requests so the resulting refresh token can
// drive any Firebase / Google Cloud API the user's account is authorized for.
export const SCOPES = [
  'email',
  'openid',
  'https://www.googleapis.com/auth/cloudplatformprojects.readonly',
  'https://www.googleapis.com/auth/firebase',
  'https://www.googleapis.com/auth/cloud-platform',
];

export type OAuthResult = {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  email?: string;
  sub?: string;
};

export async function runBrowserOAuth(): Promise<OAuthResult> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/cb`;

  const oauth = new OAuth2Client({ clientId: FIREBASE_CLIENT_ID, clientSecret: FIREBASE_CLIENT_SECRET, redirectUri });
  const authUrl = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

  const codePromise = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        if (url.pathname !== '/cb') { res.writeHead(404).end(); return; }
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<html><body style="font-family:-apple-system,sans-serif;padding:40px"><h2>Sign-in failed</h2><pre>${escapeHtml(err)}</pre></body></html>`);
          reject(new Error(`OAuth error: ${err}`));
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) { res.writeHead(400).end('Missing code'); reject(new Error('OAuth callback missing code')); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body style="font-family:-apple-system,sans-serif;padding:40px"><h2>Signed in</h2><p>You can close this tab and return to your terminal.</p></body></html>');
        resolve(code);
      } catch (e) { reject(e as Error); }
    });
  });

  // Best-effort browser open. We don't depend on the `open` package — `open` URLs ourselves with platform commands.
  void openUrl(authUrl);
  console.error(`\nOpening browser to sign in. If it doesn't open, visit:\n  ${authUrl}\n`);

  const code = await codePromise.finally(() => server.close());

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Try `firebase-rc login` again.');
  if (!tokens.access_token) throw new Error('Google did not return an access token. Try `firebase-rc login` again.');

  let email: string | undefined;
  let sub: string | undefined;
  if (tokens.id_token) {
    try {
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: FIREBASE_CLIENT_ID });
      const payload = ticket.getPayload();
      email = payload?.email;
      sub = payload?.sub;
    } catch { /* not fatal */ }
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: tokens.expiry_date ?? Date.now() + 55 * 60 * 1000,
    email,
    sub,
  };
}

async function openUrl(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore — user can paste the URL */ }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
