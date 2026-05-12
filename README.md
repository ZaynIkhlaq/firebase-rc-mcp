# firebase-rc-mcp

Chat-driven Firebase Remote Config from your MCP client.

Pull, edit, diff, publish, and roll back Remote Config keys on **any Firebase project your Google account can access** — talking to Claude (or Cursor, or any MCP client) in plain English. No Firebase console, no JSON copy-pasting, no service-account files.

## Why

Firebase Remote Config is a JSON store with a real audit trail and an OK web UI for tiny changes. The moment you're editing a 200-line JSON blob — a subscription catalog, a feature flag matrix, an in-app message bundle — the console becomes painful: no diffs, no atomic edits, no rollback. Most teams end up downloading the JSON, editing locally, then re-uploading, with nothing tying the steps together.

This MCP makes that loop conversational and safe:
- "Pull `subscription_plans` from acme-prod." → it lands as a local file you can edit.
- "Change the Pro plan's yearly price to $89." → I edit the file.
- "Show me the diff." → before/after of just the paths that changed, not the whole blob.
- "Publish." → validated, published, attributed to *your* Google account in Firebase's history.
- "Roll back the last change." → done.

Every publish is gated by a fresh diff token — you cannot publish without seeing what's about to change first.

## Install (one-time, ~30 seconds)

**1. Sign in with Google.** Pick the account that has access to your Firebase project.

```bash
npx -y firebase-rc-mcp login
```

A browser opens. Pick your account. Done. Credentials land in `~/.config/configstore/firebase-tools.json`.

**2. Register the MCP server with your client.**

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add firebase-rc -- npx -y firebase-rc-mcp
```
</details>

<details>
<summary><b>Cursor</b></summary>

[![Add to Cursor](https://img.shields.io/badge/Add%20to-Cursor-black?style=for-the-badge)](cursor://anysphere.cursor-deeplink/mcp/install?name=firebase-rc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImZpcmViYXNlLXJjLW1jcCJdfQ==)

Or add manually to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "firebase-rc": { "command": "npx", "args": ["-y", "firebase-rc-mcp"] }
  }
}
```
</details>

<details>
<summary><b>Claude Desktop</b> / <b>any MCP client</b></summary>

Add to your client's MCP config:
```json
{
  "mcpServers": {
    "firebase-rc": { "command": "npx", "args": ["-y", "firebase-rc-mcp"] }
  }
}
```
</details>

That's it. Open a conversation and try: *"What Firebase projects can I see?"*

## How you use it

Just talk:

> *"Pull `feature_flags` from acme-staging."*
> *"Turn on the new onboarding flag for users in Germany."*
> *"What about to change?"*
> *"Publish."*
> *"Roll back the last change."*
> *"Who edited configs in this project today?"*

The model will:
1. Pull the current value from Firebase to a local JSON file at `~/firebase-rc/<project>/<key>.json`.
2. Make the edit you described.
3. **Show you a structured diff** before doing anything.
4. Ask for confirmation.
5. Validate, then publish. Your Google account shows up in Firebase's version history as the editor.

## Tools exposed to the MCP client

| Tool | Purpose |
|---|---|
| `rc_auth_status` | Is the user signed in? Which account? |
| `rc_list_projects` | Every Firebase project the account can see, via Firebase Management API. |
| `rc_list_keys` | List Remote Config keys in a project (with type + size). |
| `rc_pull` | Download a key's current live value to a local file. |
| `rc_diff` | Compare local file vs live; returns a single-use diff token. |
| `rc_push` | Publish (requires fresh, matching diff token). |
| `rc_list_versions` | Recent template versions: who edited, when, from where. |
| `rc_rollback` | Restore a previous template version (requires `confirmPhrase: "rollback"`). |
| `rc_workspace_info` | Show where local files live on this machine. |

## Safety mechanics

- **Diff-token gating.** `rc_push` requires a token from a recent `rc_diff`. Tokens are bound to `{project, key, sha256(value)}` and expire in 10 minutes. Single-use.
- **ETag enforcement.** If the live template changed between your `rc_diff` and `rc_push`, the push is refused — pull again, re-diff, retry.
- **Validate before publish.** Every push runs Firebase's `validate_only=true` pass first; malformed templates are rejected *before* anything goes live.
- **Per-pull backups.** Every pull and pre-push writes a timestamped backup to `<workspace>/<project>/.backups/`.
- **No allowlist, no shared credentials.** Authorization is delegated entirely to Google IAM — you can only see/edit projects where your account has the role. Use Firebase IAM to scope who can do what.

## Auth model

This server piggybacks on `firebase-tools`. Running `firebase-rc-mcp login` is a passthrough to `firebase login` — same refresh token, same `~/.config/configstore/firebase-tools.json` file. If you've already done `firebase login` in the past, you don't need to log in again.

Access tokens are minted on demand from the refresh token using firebase-tools' public OAuth client identity (same one shipped in every `firebase-tools` install). No service-account JSON keys, no GCP console setup, no maintainer secrets baked into this package.

## Per-project semantic hints (optional)

If certain keys in your project have invariants the model should know about ("keep monthly/quarterly/yearly in sync," "this is a feature flag, never stringify the boolean"), drop a JSON file at `~/firebase-rc/<project>/.semantics.json`:

```json
{
  "subscription_plans": {
    "description": "Plan definitions across billing intervals.",
    "rules": [
      "Edits to a plan should apply to monthly, quarterly, AND yearly versions unless told otherwise.",
      "discountPercentage is the field that legitimately differs across intervals."
    ]
  }
}
```

The model will read these hints automatically when you pull the key. Ship as part of your repo if you want every teammate to inherit the same rules.

## Commands

```
firebase-rc-mcp login     Sign in with Google (one-time per machine).
firebase-rc-mcp logout    Remove stored credentials.
firebase-rc-mcp status    Show current account + projects reachable.
firebase-rc-mcp           Start the MCP server (stdio) — invoked by your MCP client.
```

## Requirements

- Node.js ≥ 18.
- Your Google account needs **Firebase Remote Config Admin** (`roles/cloudconfig.admin`) — or higher — on the project you want to edit. Without it, reads work and writes return a clean 403.

## License

MIT.
