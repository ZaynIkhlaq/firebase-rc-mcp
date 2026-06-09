import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { RemoteConfigParameter } from './firebase.js';

// Edits happen on an EPHEMERAL temp file, never a persistent local copy. Every
// edit starts from a fresh live fetch written here; the file is deleted on a
// successful push. Living in the OS temp dir makes it obviously disposable.

type ValueType = NonNullable<RemoteConfigParameter['valueType']>;

export function tempRoot(): string {
  return path.join(os.tmpdir(), 'firebase-rc');
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}

function serialize(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
}

/** Parse the edited file's raw text back into a value, using the live valueType. */
export function parseByType(raw: string, valueType: ValueType | undefined): unknown {
  if (valueType === 'JSON') {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`The edited file is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (valueType === 'NUMBER') return Number(raw.trim());
  if (valueType === 'BOOLEAN') return raw.trim() === 'true';
  // STRING (and unknown): trailing newline from editors shouldn't count as a change.
  return raw.replace(/\n$/, '');
}

/** Write the fresh live value to a new temp file and return its path. */
export function freshEditFile(project: string, key: string, value: unknown): string {
  fs.mkdirSync(tempRoot(), { recursive: true });
  const name = `${sanitize(project)}__${sanitize(key)}__${randomBytes(6).toString('hex')}.json`;
  const filePath = path.join(tempRoot(), name);
  fs.writeFileSync(filePath, serialize(value));
  return filePath;
}

export function readEditFileRaw(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Edit file not found at ${filePath}. Call rc_pull again to start fresh.`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function deleteEditFile(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* best effort */
  }
}

/** Remove orphaned temp files left by crashed/abandoned sessions. Called on startup. */
export function sweepStaleTemps(maxAgeMs = 24 * 60 * 60 * 1000): void {
  const root = tempRoot();
  if (!fs.existsSync(root)) return;
  const now = Date.now();
  for (const f of fs.readdirSync(root)) {
    const p = path.join(root, f);
    try {
      const stat = fs.statSync(p);
      if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}
