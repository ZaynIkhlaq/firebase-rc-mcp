// Project IDs are validated only by Firebase's documented ID shape — no allowlist.
// Authorization is delegated to Google IAM: the signed-in user can see and edit
// only the projects their account has Remote Config Admin (or higher) on.
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,29}[a-z0-9]$/;

export function isProjectIdShape(p: string): boolean {
  return PROJECT_ID_RE.test(p);
}

export function assertProjectIdShape(p: string): string {
  if (!isProjectIdShape(p)) {
    throw new Error(
      `"${p}" is not a valid Firebase project ID. Project IDs are lowercase, 6-30 chars, start with a letter, contain only letters/digits/hyphens, and don't end with a hyphen.`
    );
  }
  return p;
}
