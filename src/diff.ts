export type Change =
  | { kind: 'add'; path: string; after: unknown }
  | { kind: 'remove'; path: string; before: unknown }
  | { kind: 'change'; path: string; before: unknown; after: unknown };

export function diff(before: unknown, after: unknown, basePath = ''): Change[] {
  const changes: Change[] = [];
  const walk = (a: unknown, b: unknown, p: string) => {
    if (a === b) return;
    if (a === undefined) { changes.push({ kind: 'add', path: p, after: b }); return; }
    if (b === undefined) { changes.push({ kind: 'remove', path: p, before: a }); return; }
    const aIsObj = a !== null && typeof a === 'object';
    const bIsObj = b !== null && typeof b === 'object';
    if (!aIsObj || !bIsObj || Array.isArray(a) !== Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ kind: 'change', path: p, before: a, after: b });
      return;
    }
    if (Array.isArray(a)) {
      const arrA = a as unknown[];
      const arrB = b as unknown[];
      const max = Math.max(arrA.length, arrB.length);
      for (let i = 0; i < max; i++) walk(arrA[i], arrB[i], `${p}[${i}]`);
      return;
    }
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
    for (const k of keys) {
      const nextP = p ? `${p}.${k}` : k;
      walk(objA[k], objB[k], nextP);
    }
  };
  walk(before, after, basePath);
  return changes;
}

export function renderDiff(changes: Change[], opts: { maxValueLen?: number } = {}): string {
  const maxValueLen = opts.maxValueLen ?? 200;
  if (!changes.length) return '(no changes)';
  const trim = (v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length <= maxValueLen) return s;
    return s.slice(0, maxValueLen) + `… (${s.length} chars)`;
  };
  const lines: string[] = [];
  for (const c of changes) {
    if (c.kind === 'add') lines.push(`+ ${c.path}: ${trim(c.after)}`);
    else if (c.kind === 'remove') lines.push(`- ${c.path}: ${trim(c.before)}`);
    else lines.push(`~ ${c.path}\n    before: ${trim(c.before)}\n    after:  ${trim(c.after)}`);
  }
  return lines.join('\n');
}

export function summarizeDiff(changes: Change[]): string {
  if (!changes.length) return 'No changes.';
  const adds = changes.filter(c => c.kind === 'add').length;
  const removes = changes.filter(c => c.kind === 'remove').length;
  const updates = changes.filter(c => c.kind === 'change').length;
  const parts: string[] = [];
  if (updates) parts.push(`${updates} change${updates === 1 ? '' : 's'}`);
  if (adds) parts.push(`${adds} addition${adds === 1 ? '' : 's'}`);
  if (removes) parts.push(`${removes} removal${removes === 1 ? '' : 's'}`);
  const topPaths = changes.slice(0, 5).map(c => c.path).filter(Boolean);
  return `${parts.join(', ')}${topPaths.length ? ` — paths include: ${topPaths.join(', ')}${changes.length > 5 ? ', …' : ''}` : ''}`;
}
