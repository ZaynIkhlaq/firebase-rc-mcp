import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const DEFAULT_WORKSPACE = path.join(os.homedir(), 'firebase-rc');

export function workspaceRoot(): string {
  return process.env.FIREBASE_RC_WORKSPACE || DEFAULT_WORKSPACE;
}

export function projectDir(project: string): string {
  return path.join(workspaceRoot(), project);
}

export function keyFilePath(project: string, key: string): string {
  return path.join(projectDir(project), `${key}.json`);
}

export function metaFilePath(project: string, key: string): string {
  return path.join(projectDir(project), `.${key}.meta.json`);
}

export function backupsDir(project: string): string {
  return path.join(projectDir(project), '.backups');
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export type KeyMeta = {
  project: string;
  key: string;
  valueType: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'JSON';
  pulledAt: string;
  pulledTemplateVersion: string;
  pulledEtag: string;
  description?: string;
};

export function writeKeyFile(project: string, key: string, value: unknown, meta: KeyMeta): { filePath: string; metaPath: string } {
  ensureDir(projectDir(project));
  const filePath = keyFilePath(project, key);
  const metaPath = metaFilePath(project, key);
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  fs.writeFileSync(filePath, text);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  return { filePath, metaPath };
}

export function readKeyFile(project: string, key: string): { exists: boolean; raw?: string; parsed?: unknown; meta?: KeyMeta; filePath: string; metaPath: string } {
  const filePath = keyFilePath(project, key);
  const metaPath = metaFilePath(project, key);
  if (!fs.existsSync(filePath)) return { exists: false, filePath, metaPath };
  const raw = fs.readFileSync(filePath, 'utf8');
  const meta = fs.existsSync(metaPath) ? (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as KeyMeta) : undefined;
  let parsed: unknown = raw;
  if (meta?.valueType === 'JSON') {
    try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`Local file ${filePath} is not valid JSON: ${(e as Error).message}`); }
  } else if (meta?.valueType === 'NUMBER') {
    parsed = Number(raw);
  } else if (meta?.valueType === 'BOOLEAN') {
    parsed = raw.trim() === 'true';
  }
  return { exists: true, raw, parsed, meta, filePath, metaPath };
}

export function writeBackup(project: string, key: string, value: unknown, label: string): string {
  ensureDir(backupsDir(project));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(backupsDir(project), `${key}__${label}__${stamp}.json`);
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  fs.writeFileSync(file, text);
  return file;
}

export function listWorkspace(): {
  root: string;
  projects: Array<{
    project: string;
    keys: Array<{ key: string; sizeChars: number; pulledAt?: string; pulledVersion?: string }>;
  }>;
} {
  const root = workspaceRoot();
  const out: ReturnType<typeof listWorkspace>['projects'] = [];
  if (!fs.existsSync(root)) return { root, projects: [] };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    const keys: Array<{ key: string; sizeChars: number; pulledAt?: string; pulledVersion?: string }> = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const key = f.slice(0, -5);
      const filePath = path.join(dir, f);
      const stat = fs.statSync(filePath);
      const metaPath = path.join(dir, `.${key}.meta.json`);
      let pulledAt: string | undefined;
      let pulledVersion: string | undefined;
      if (fs.existsSync(metaPath)) {
        try {
          const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as KeyMeta;
          pulledAt = m.pulledAt;
          pulledVersion = m.pulledTemplateVersion;
        } catch (_) { /* ignore */ }
      }
      keys.push({ key, sizeChars: stat.size, pulledAt, pulledVersion });
    }
    out.push({ project: entry.name, keys });
  }
  return { root, projects: out };
}
