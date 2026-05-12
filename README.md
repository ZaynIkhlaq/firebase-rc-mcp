# firebase-rc-mcp

Edit Firebase Remote Config from chat. Works with any project your Google account can access.

Pull a key to a local file, edit it (by hand or by asking the model), see a diff, publish. Every publish is gated by a fresh diff token — you can't push without seeing what's about to change first. Versions in Firebase history are attributed to your Google account, not a service account.

## Install (one click)

| Client | Install |
|---|---|
| **Cursor** | [![Add to Cursor](https://img.shields.io/badge/Add%20to%20Cursor-000?logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=firebase-rc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImZpcmViYXNlLXJjLW1jcCJdfQ==) |
| **Claude Code** | `claude mcp add firebase-rc -- npx -y firebase-rc-mcp` |
| Anything else (Claude Desktop, etc.) | `{"firebase-rc": {"command": "npx", "args": ["-y", "firebase-rc-mcp"]}}` in your `mcpServers` config |

That's it. No login command, no terminal step, no Firebase console.

The first time you ask the model to do anything Remote-Config-related, it'll open your browser to a Google sign-in page. Pick the account that has access to your Firebase project. Done.

Try it: *"What Firebase projects can I see?"*

## Tools

| | |
|---|---|
| `rc_login` | Opens the browser for Google sign-in. Auto-called by the model on first use. |
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

The MCP runs Google's standard "OAuth for installed apps" flow — a browser sign-in that redirects to a one-off local port on your machine. The refresh token is stored at `~/.config/firebase-rc-mcp/auth.json` (mode 0600); short-lived access tokens are minted from it on demand. If you've already done `firebase login` with the `firebase` CLI, that token is auto-detected and you skip sign-in entirely.

No service-account JSON. No GCP console setup. No secrets shipped in this package.

## Per-project hints (optional)

Add `~/firebase-rc/<project>/.semantics.json` to teach the model about invariants in your keys:

```json
{
  "subscription_plans": {
    "rules": [
      "Apply changes to monthly, quarterly, and yearly versions together.",
      "discountPercentage is the only field that legitimately differs by interval."
    ]
  }
}
```

The model reads these automatically on `rc_pull`. Commit it to your repo so the whole team gets the same rules.

## Terminal commands (rarely needed)

The MCP handles auth on its own. These exist for debugging / scripting:

```
npx firebase-rc-mcp login     Sign in with Google (also triggered automatically by the MCP).
npx firebase-rc-mcp logout    Remove stored credentials.
npx firebase-rc-mcp status    Show current account + projects.
```

## Requirements

- Node.js ≥ 18.
- Your Google account needs `roles/cloudconfig.admin` on the project you want to edit. Without it, reads work and writes return a clean 403.

## License

MIT.
