import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The knowledge store is the brain that makes every session warm. It is STRICTLY
// LOCAL to this machine — never uploaded, never shared. It holds *context about*
// the user's projects and keys (what they're for, which they touch, notes, change
// history) plus the optional post-push revalidate curl. It NEVER holds Remote
// Config values — those always come live from Firebase, so this file can't carry
// stale or dangerous data. Written mode 0600 because the revalidate curl contains
// secrets (the `secret=` query param and any bypass header).

export type RevalidateSpec = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

export type Note = { text: string; at: string };
export type HistoryEntry = { at: string; env?: string; summary: string; why?: string };

export type KeyKnowledge = {
  touches: number;
  lastTouchedAt: string;
  valueType?: string;
  notes: Note[];
  history: HistoryEntry[];
};

export type ProjectKnowledge = {
  projectId: string;
  env?: string;
  purpose?: string;
  revalidate?: RevalidateSpec;
  keys: Record<string, KeyKnowledge>;
  coEdits: Record<string, string[]>;
};

export type Knowledge = {
  projects: ProjectKnowledge[];
  notes: Note[];
  updatedAt: string;
};

const NOTES_CAP = 20; // per key (and per project-level notes list)
const HISTORY_CAP = 10; // per key

function configDir(): string {
  // Mirror auth.ts path conventions so everything firebase-rc lands in one place.
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'firebase-rc');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'firebase-rc');
  return path.join(home, '.config', 'firebase-rc');
}

export function knowledgePath(): string {
  if (process.env.FIREBASE_RC_KNOWLEDGE_FILE) return process.env.FIREBASE_RC_KNOWLEDGE_FILE;
  return path.join(configDir(), 'knowledge.json');
}

function emptyKnowledge(): Knowledge {
  return { projects: [], notes: [], updatedAt: new Date().toISOString() };
}

export function readKnowledge(): Knowledge {
  const p = knowledgePath();
  if (!fs.existsSync(p)) return emptyKnowledge();
  try {
    const k = JSON.parse(fs.readFileSync(p, 'utf8')) as Knowledge;
    k.projects ??= [];
    k.notes ??= [];
    for (const proj of k.projects) {
      proj.keys ??= {};
      proj.coEdits ??= {};
    }
    return k;
  } catch {
    return emptyKnowledge();
  }
}

export function writeKnowledge(k: Knowledge): void {
  k.updatedAt = new Date().toISOString();
  const p = knowledgePath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(k, null, 2) + '\n', { mode: 0o600 });
}

export function getProject(k: Knowledge, projectId: string): ProjectKnowledge | undefined {
  return k.projects.find((p) => p.projectId === projectId);
}

function getOrCreateProject(k: Knowledge, projectId: string): ProjectKnowledge {
  let p = getProject(k, projectId);
  if (!p) {
    p = { projectId, keys: {}, coEdits: {} };
    k.projects.push(p);
  }
  return p;
}

function getOrCreateKey(proj: ProjectKnowledge, key: string): KeyKnowledge {
  let stat = proj.keys[key];
  if (!stat) {
    stat = { touches: 0, lastTouchedAt: new Date().toISOString(), notes: [], history: [] };
    proj.keys[key] = stat;
  }
  return stat;
}

/** Set project metadata captured during onboarding (env / purpose / revalidate). */
export function setProjectMeta(
  projectId: string,
  meta: { env?: string; purpose?: string; revalidate?: RevalidateSpec }
): void {
  const k = readKnowledge();
  const proj = getOrCreateProject(k, projectId);
  if (meta.env !== undefined) proj.env = meta.env;
  if (meta.purpose !== undefined) proj.purpose = meta.purpose;
  if (meta.revalidate !== undefined) proj.revalidate = meta.revalidate;
  writeKnowledge(k);
}

/** Bump usage stats for a key. Called on pull and push (automatic capture). */
export function recordTouch(projectId: string, key: string, valueType?: string): void {
  const k = readKnowledge();
  const proj = getOrCreateProject(k, projectId);
  const stat = getOrCreateKey(proj, key);
  stat.touches += 1;
  stat.lastTouchedAt = new Date().toISOString();
  if (valueType) stat.valueType = valueType;
  writeKnowledge(k);
}

/** Append a change-log entry for a key (automatic on push; `why` is agent-supplied). */
export function recordPushHistory(
  projectId: string,
  key: string,
  entry: { env?: string; summary: string; why?: string }
): void {
  const k = readKnowledge();
  const proj = getOrCreateProject(k, projectId);
  const stat = getOrCreateKey(proj, key);
  stat.history.unshift({ at: new Date().toISOString(), env: entry.env ?? proj.env, summary: entry.summary, why: entry.why });
  if (stat.history.length > HISTORY_CAP) stat.history.length = HISTORY_CAP;
  writeKnowledge(k);
}

/** Link keys edited together this session (automatic capture of workflow shape). */
export function recordCoEdits(projectId: string, key: string, others: string[]): void {
  const fresh = others.filter((o) => o && o !== key);
  if (!fresh.length) return;
  const k = readKnowledge();
  const proj = getOrCreateProject(k, projectId);
  const set = new Set(proj.coEdits[key] ?? []);
  for (const o of fresh) set.add(o);
  proj.coEdits[key] = [...set];
  writeKnowledge(k);
}

/** Record a durable semantic note. With a key -> attached to that key; without -> project/global. */
export function addNote(args: { projectId?: string; key?: string; text: string }): void {
  const k = readKnowledge();
  const note: Note = { text: args.text, at: new Date().toISOString() };
  if (args.projectId && args.key) {
    const proj = getOrCreateProject(k, args.projectId);
    const stat = getOrCreateKey(proj, args.key);
    stat.notes.unshift(note);
    if (stat.notes.length > NOTES_CAP) stat.notes.length = NOTES_CAP;
  } else if (args.projectId) {
    // No key: stash under the project as a leading project-level note (reuse key "*").
    const proj = getOrCreateProject(k, args.projectId);
    const stat = getOrCreateKey(proj, '*');
    stat.notes.unshift(note);
    if (stat.notes.length > NOTES_CAP) stat.notes.length = NOTES_CAP;
  } else {
    k.notes.unshift(note);
    if (k.notes.length > NOTES_CAP) k.notes.length = NOTES_CAP;
  }
  writeKnowledge(k);
}

/** Notes + most recent change for a single key — surfaced inline by rc_pull. */
export function keyContext(projectId: string, key: string): { notes: Note[]; lastChange?: HistoryEntry } | undefined {
  const proj = getProject(readKnowledge(), projectId);
  const stat = proj?.keys[key];
  if (!stat) return undefined;
  return { notes: stat.notes, lastChange: stat.history[0] };
}

/**
 * Compact summary baked into the MCP server `instructions` at connect time so the
 * agent starts every session warm — knowing the user's projects and hot keys
 * instead of cold-listing everything.
 */
export function summarize(k: Knowledge = readKnowledge()): string {
  if (!k.projects.length && !k.notes.length) return '';
  const lines: string[] = [];
  lines.push('KNOWN CONTEXT (local, learned from past sessions — use it instead of cold-listing projects/keys):');
  for (const proj of k.projects) {
    const tag = [proj.env, proj.purpose].filter(Boolean).join(' — ');
    lines.push(`- ${proj.projectId}${tag ? ` (${tag})` : ''}${proj.revalidate ? ' [auto-revalidates on push]' : ''}`);
    const hot = Object.entries(proj.keys)
      .filter(([key]) => key !== '*')
      .sort((a, b) => b[1].touches - a[1].touches)
      .slice(0, 8);
    if (hot.length) {
      lines.push(`  frequent keys: ${hot.map(([key, s]) => `${key} (${s.touches}x)`).join(', ')}`);
    }
    for (const [key, s] of Object.entries(proj.keys)) {
      const note = s.notes[0];
      if (note) lines.push(`  note [${key === '*' ? 'project' : key}]: ${note.text}`);
    }
  }
  for (const n of k.notes.slice(0, 5)) lines.push(`- note: ${n.text}`);
  return lines.join('\n');
}
