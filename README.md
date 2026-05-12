# firebase-rc-mcp

Edit Firebase Remote Config from Claude Code. Works with any project your Google account can access.

Pull a key to a local file, edit it (by hand or by asking Claude), see a diff, publish. Every publish is gated by a fresh diff token — you can't push without seeing what's about to change first. Versions in Firebase history are attributed to your Google account, not a service account.

## Install

```bash
claude mcp add firebase-rc -- npx -y firebase-rc-mcp
```

That's it. Open a conversation and try: *"What Firebase projects can I see?"*

The first time you ask Claude to do anything Remote-Config-related, it'll open your browser to a Google sign-in page. Pick the account that has access to your Firebase project. Done.

## Tools

| | |
|---|---|
| `rc_login` | Opens the browser for Google sign-in. Auto-called on first use. |
| `rc_auth_status` | Signed in? Which account? |
| `rc_list_projects` | Projects this account can see. |
| `rc_list_keys` | Keys in a project (type, size). |
| `rc_pull` | Download a key's live value to a local file. |
| `rc_diff` | Compare local file vs live. Returns a single-use diff token. |
| `rc_push` | Publish (requires fresh diff token). |
| `rc_list_versions` | Recent versions: who, when, from where. |
| `rc_rollback` | Restore a previous version (requires `confirmPhrase: "rollback"`). |
| `rc_workspace_info` | Where local files live on this machine. |

## Safety

- `rc_push` won't run without a token from a recent `rc_diff`. Tokens are bound to `{project, key, sha256(value)}`, expire in 10 minutes, single-use.
- If live Firebase changed between your `rc_diff` and `rc_push`, the push is refused.
- Every push runs Firebase's `validate_only=true` first.
- Every pull and pre-push writes a timestamped backup under `<workspace>/<project>/.backups/`.
- No allowlist. Access is gated by Google IAM — you can only edit projects where your account has Remote Config Admin (or higher).

## Auth

Standard Google OAuth for installed apps: browser sign-in redirects to a one-off local port, refresh token stored at `~/.config/firebase-rc-mcp/auth.json` (mode 0600), short-lived access tokens minted on demand. If you've already done `firebase login` with the `firebase` CLI, that token is auto-detected and you skip sign-in entirely.

No service-account JSON. No GCP console setup. No secrets shipped in this package.

## Terminal commands (rarely needed)

The MCP handles auth on its own. These exist for debugging:

```
npx firebase-rc-mcp login     Sign in with Google (also triggered automatically).
npx firebase-rc-mcp logout    Remove stored credentials.
npx firebase-rc-mcp status    Show current account + projects.
```

## Requirements

- Node.js ≥ 18.
- Your Google account needs `roles/cloudconfig.admin` on the project you want to edit. Without it, reads work and writes return a clean 403.

## License

MIT.
