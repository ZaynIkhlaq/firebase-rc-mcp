import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot } from './workspace.js';

// Optional per-project semantic hints. If a user wants Claude to know that
// certain keys in their project have invariants ("keep monthly/quarterly/yearly
// in sync", "this is a feature flag — be careful with boolean coercion", etc.),
// they drop a JSON file at <workspace>/<project>/.semantics.json shaped like:
//   { "<key>": { "description": "...", "shape": "...", "rules": ["..."] } }
// This file is generic — the tool ships no built-in domain knowledge.

export type SemanticHint = {
  description?: string;
  shape?: string;
  rules?: string[];
};

export function semanticHintFor(project: string, key: string): SemanticHint | undefined {
  const file = path.join(workspaceRoot(), project, '.semantics.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, SemanticHint>;
    return j[key];
  } catch {
    return undefined;
  }
}
