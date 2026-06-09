import type { RevalidateSpec } from './knowledge.js';

// Parse a raw `curl` command (as the user pastes it) into a request spec we can
// replay after a push. We deliberately keep whatever the user pasted verbatim —
// the `secret=` query param stays in the URL, and a missing bypass header (prod)
// just means that header is absent. No magic, no rewriting.

/** Tokenize a shell-ish curl string, honoring single/double quotes and `\`-newline continuations. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === '\\' && (input[i + 1] === '\n' || input[i + 1] === '\r')) {
      // line continuation — skip the backslash and the newline(s)
      i++;
      while (input[i + 1] === '\n' || input[i + 1] === '\r') i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

export function parseCurl(raw: string): RevalidateSpec {
  const trimmed = raw.trim().replace(/^\$\s*/, '');
  const tokens = tokenize(trimmed);
  if (tokens[0] === 'curl') tokens.shift();

  let url: string | undefined;
  let method: string | undefined;
  let body: string | undefined;
  const headers: Record<string, string> = {};

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => tokens[++i];
    switch (t) {
      case '--location':
      case '-L':
        // boolean in real curl; some pastes write `--location <url>`. If the next
        // token is a non-flag, treat it as the URL.
        if (tokens[i + 1] && !tokens[i + 1].startsWith('-')) url = next();
        break;
      case '--url':
        url = next();
        break;
      case '-H':
      case '--header': {
        const h = next();
        if (h) {
          const idx = h.indexOf(':');
          if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        }
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
        body = next();
        break;
      case '-X':
      case '--request':
        method = next();
        break;
      case '--compressed':
      case '-s':
      case '--silent':
      case '-k':
      case '--insecure':
        break; // ignore no-arg flags we don't need
      default:
        if (!t.startsWith('-') && !url) url = t; // bare positional URL
        break;
    }
  }

  if (!url) throw new Error('Could not find a URL in that curl command.');
  if (!method) method = body !== undefined ? 'POST' : 'GET';
  return { method: method.toUpperCase(), url, headers, body };
}

export type RevalidateResult = { ok: boolean; status: number; statusText: string; snippet: string; url: string };

export async function fireRevalidate(spec: RevalidateSpec): Promise<RevalidateResult> {
  const res = await fetch(spec.url, {
    method: spec.method,
    headers: spec.headers,
    body: spec.method === 'GET' || spec.method === 'HEAD' ? undefined : spec.body,
  });
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    snippet: text.slice(0, 300),
    url: spec.url,
  };
}

/** Redact the secret query param + sensitive headers for safe display back to the user. */
export function describeRevalidate(spec: RevalidateSpec): string {
  let shownUrl = spec.url;
  try {
    const u = new URL(spec.url);
    if (u.searchParams.has('secret')) u.searchParams.set('secret', 'REDACTED');
    shownUrl = u.toString();
  } catch { /* leave as-is */ }
  const headerNames = Object.keys(spec.headers);
  return `${spec.method} ${shownUrl}${headerNames.length ? ` (headers: ${headerNames.join(', ')})` : ''}`;
}
