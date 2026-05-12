# firebase-rc-mcp

Edit Firebase Remote Config from chat. Works with any project your Google account can access.

Pull a key to a local file, edit it (by hand or by asking the model), see a diff, publish. Every publish is gated by a fresh diff token — you can't push without seeing what's about to change first. Versions in Firebase history are attributed to your Google account, not a service account.

## Install

**1. Sign in**

```bash
npx -y firebase-rc-mcp login
```

Opens a browser. Pick the Google account that has access to your Firebase project.

**2. Add to your MCP client**

| Client | |
|---|---|
| Claude Code | `claude mcp add firebase-rc -- npx -y firebase-rc-mcp` |
| Cursor | [![Add to Cursor](https://img.shields.io/badge/Add%20to%20Cursor-000?logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=firebase-rc&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImZpcmViYXNlLXJjLW1jcCJdfQ==) |
| Claude Desktop, others | add to your `mcpServers` config: `{"firebase-rc": {"command": "npx", "args": ["-y", "firebase-rc-mcp"]}}` |

Open a conversation and try: *"What Firebase projects can I see?"*

## Tools

| | |
|---|---|
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

`firebase-rc-mcp login` runs a browser-based Google sign-in, stores a refresh token at `~/.config/firebase-rc-mcp/auth.json` (mode 0600), and refreshes short-lived access tokens on demand. If you've already done `firebase login` with the `firebase` CLI on this machine, that token is auto-detected and you don't need to log in again.

No service-account JSON. No GCP console setup. No secrets baked into this package.

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

## Commands

```
firebase-rc-mcp login     Sign in with Google.
firebase-rc-mcp logout    Remove stored credentials.
firebase-rc-mcp status    Show current account + projects.
firebase-rc-mcp           Start the MCP server (invoked by your client).
```

## Requirements

- Node.js ≥ 18.
- Your Google account needs `roles/cloudconfig.admin` on the project you want to edit. Without it, reads work and writes return a clean 403.

## License

MIT.
