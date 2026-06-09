# firebase-rc

Edit Firebase Remote Config from your AI agent. Works with any project your Google account can access.

Pull a key, edit it (by hand or by asking your agent), see a diff, publish — and the right cache gets invalidated automatically. There are **no local copies of your config**: every edit is read live from Firebase and written back live. Versions in Firebase history are attributed to your Google account, not a service account.

## Install

```bash
claude mcp add firebase-rc -- npx -y firebase-rc
```

Then, in a conversation, say:

> **"Set up firebase-rc"**

That runs a one-time onboarding: it opens your browser to sign in with Google, then records the projects you actually work with (env + a one-line purpose) and — optionally — a post-push cache-invalidation curl. **You only do this once.** Every session afterward starts warm: your agent already knows your projects and the keys you touch most, so it never cold-lists everything again.

## How editing works

No local config files. The flow is always live:

1. **pull** — your agent fetches the *current* live value into a throwaway temp file.
2. **edit** — you (or the agent) edit that temp file.
3. **diff** — the temp file is compared against current live; you see exactly what will change.
4. **push** — after you say yes, it publishes, deletes the temp file, and fires your revalidate curl so the change takes effect.

Just talk to it: *"set the checkout flag to true in prod"* → it shows you the diff → *"yes"* → published and revalidated.

## Auto cache-invalidation

If your app needs a `revalidate` (or similar) call after a config change, paste that curl during setup — one per env (dev/staging/prod). After every push to that project, firebase-rc fires it automatically. Turn it off for a single push by telling your agent to skip revalidation, or trigger it manually with `rc_revalidate`.

## Self-improving context

firebase-rc keeps a small **local-only** knowledge file (`~/.config/firebase-rc/knowledge.json`, mode `0600`) that gets sharper as you work:

- which projects/keys you touch and how often (automatic),
- durable notes about what keys do (the agent records these as it learns; you can also just say *"remember that…"*),
- a recent change log per key, with the *why*.

It never stores config values — only context — so it can't go stale in a harmful way, and nothing is ever uploaded.

## Tools

| | |
|---|---|
| `rc_setup` | One-time guided onboarding (sign in + record your projects + optional revalidate curl). |
| `rc_context` | Recall what firebase-rc has learned about your projects/keys. |
| `rc_remember` | Record a durable note about a key or project. |
| `rc_pull` | Fetch a key's live value into a temp file to edit. |
| `rc_diff` | Compare the temp file vs live. Returns a single-use diff token. |
| `rc_push` | Publish (requires fresh diff token); deletes the temp file and auto-revalidates. |
| `rc_revalidate` | Manually fire a project's stored revalidate curl. |
| `rc_list_versions` | Recent versions: who, when, from where. |
| `rc_rollback` | Restore a previous version (requires `confirmPhrase: "rollback"`). |
| `rc_list_projects` / `rc_list_keys` | List projects / keys (rarely needed once set up). |
| `rc_login` / `rc_auth_status` | Sign in / check sign-in. |

## Safety

- `rc_push` won't run without a token from a recent `rc_diff`. Tokens are bound to `{project, key, sha256(value)}`, expire in 10 minutes, single-use.
- If live Firebase changed between your `rc_diff` and `rc_push`, the push is refused — pull and re-diff.
- Every push runs Firebase's `validate_only=true` first.
- No allowlist. Access is gated by Google IAM — you can only edit projects where your account has Remote Config Admin (or higher).
- The knowledge file and any revalidate curls live only on your machine (mode `0600`), never uploaded.

## Auth

Standard Google OAuth for installed apps: browser sign-in redirects to a one-off local port, refresh token stored at `~/.config/firebase-rc/auth.json` (mode `0600`), short-lived access tokens minted on demand. If you've already done `firebase login` with the `firebase` CLI, that token is auto-detected and you skip sign-in entirely. No service-account JSON, no GCP console setup, no secrets shipped in this package.

## Terminal commands (rarely needed)

```
npx firebase-rc setup     Sign in and start onboarding (finish in your agent).
npx firebase-rc login     Sign in with Google.
npx firebase-rc logout    Remove stored credentials.
npx firebase-rc status    Show current account + projects.
```

## Requirements

- Node.js ≥ 18.
- Your Google account needs `roles/cloudconfig.admin` on the project you want to edit. Without it, reads work and writes return a clean 403.

## License

MIT.
