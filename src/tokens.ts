import { createHash, randomBytes } from 'node:crypto';

const TOKEN_TTL_MS = 10 * 60 * 1000;

type Entry = {
  project: string;
  key: string;
  valueHash: string;
  expectedEtag: string;
  expectedTemplateVersion: string;
  createdAt: number;
};

const store = new Map<string, Entry>();

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return '{' + entries.map(([k, val]) => JSON.stringify(k) + ':' + canonicalize(val)).join(',') + '}';
}

export function issueDiffToken(args: {
  project: string;
  key: string;
  newValue: unknown;
  expectedEtag: string;
  expectedTemplateVersion: string;
}): { token: string; expiresInMs: number } {
  const token = 'dt_' + randomBytes(18).toString('base64url');
  store.set(token, {
    project: args.project,
    key: args.key,
    valueHash: canonicalHash(args.newValue),
    expectedEtag: args.expectedEtag,
    expectedTemplateVersion: args.expectedTemplateVersion,
    createdAt: Date.now(),
  });
  sweepExpired();
  return { token, expiresInMs: TOKEN_TTL_MS };
}

export type ConsumeResult =
  | { ok: true; entry: Entry }
  | { ok: false; reason: string };

export function consumeDiffToken(args: {
  token: string;
  project: string;
  key: string;
  newValue: unknown;
}): ConsumeResult {
  const e = store.get(args.token);
  if (!e) return { ok: false, reason: 'No matching diff token. Call rc_diff first to compute a diff for this value.' };
  if (Date.now() - e.createdAt > TOKEN_TTL_MS) {
    store.delete(args.token);
    return { ok: false, reason: 'Diff token expired (10 min). Call rc_diff again with the latest value.' };
  }
  if (e.project !== args.project) return { ok: false, reason: `Diff token is for project ${e.project}, not ${args.project}.` };
  if (e.key !== args.key) return { ok: false, reason: `Diff token is for key "${e.key}", not "${args.key}".` };
  if (e.valueHash !== canonicalHash(args.newValue)) {
    return { ok: false, reason: 'Value changed since rc_diff. Call rc_diff again with the exact value you intend to publish.' };
  }
  store.delete(args.token);
  return { ok: true, entry: e };
}

function sweepExpired() {
  const now = Date.now();
  for (const [k, e] of store) {
    if (now - e.createdAt > TOKEN_TTL_MS) store.delete(k);
  }
}
