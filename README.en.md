# Admin Gate (admin-gate)

[English](README.en.md) | [中文](README.md)

A gate in front of DeepSeek Harness — admins sign in with a password, guests enter without one and get a curated allowlist of endpoints and tools, and every account's conversations are invisible to the others.

> **This project was built with AI assistance.** Code, tests, and documentation were produced by AI. Free to use, modify, and redistribute.

## Install

```bash
dsh plugin --profile web add github:fish133/dsh-admin-gate
```

Restart Harness after it installs (or toggle the plugin off and on in the plugins
settings page), then visit `/admin-gate` to set the first password.

To install from a local checkout instead, use
`dsh plugin --profile web add link:/path/to/dsh-admin-gate`.

## Features

- **Admin password**: scrypt salted hash — only the hash is stored, never the password
- **Passwordless guests**: an allowlist of `/api` endpoints and agent tools, nothing more
- **Multiple accounts**: several admins, each with their own password
- **Isolated conversations**: each account sees only its own; guests see no admin history
- **No-guest mode**: close guest entry entirely — admins only
- **Three modes**: `admin-only` / `guest` / `open`, switchable at any time
- **Login throttling**: 5 failures in 10 minutes locks the door for 5 minutes
- **Atomic writes**: the state file is written to a temp file and renamed, so a power
  loss cannot leave half a JSON behind

## Modes

| Mode | Who gets in | Purpose |
|---|---|---|
| `admin-only` (default) | Admins only | No-guest mode: the door opens for the owner alone |
| `guest` | Admins + guests | Guests skip the password; the allowlist decides what they get |
| `open` | Everyone | Gate disabled — equivalent to removing the plugin |

Switching to `admin-only` **kicks out every guest immediately**; nobody keeps working
on a stale cookie.

## Usage

1. Visit `/admin-gate` the first time. The page asks for an admin password (4+ chars)
   and lets you in.
2. Afterwards `/` redirects to `/admin-gate` on every visit.
3. From the gate page, or the "Admin Gate" section in Web settings, you can:
   - change the password (other admin sessions get dropped)
   - add or remove admin accounts
   - switch modes
   - edit the guest allowlist

## Why the gate lives on the host

A client-side full-screen overlay only blocks eyes, not hands: `fetch('/api/...')`
from inside the page still goes out. So every decision is made on the host:

| Location | What it does |
|---|---|
| `connection.admit` / `admitConnection` / `authorizeIndex` | The gate decides *who you are* and issues a Peer carrying that identity (guest, or a specific account) |
| `connection/request` | Ungated `/api` calls get 401; in guest mode the endpoint allowlist runs first, 403 on violation |
| `sessionController` method wrappers | Conversation methods check ownership by `sessionId`; refuse or filter |
| `tools.guard()` | Inside a guest-triggered agent turn, only allowlisted tools run |
| `webserver/index-inject` | On load, `GET /admin-gate/api/state`; if the gate is not passed, the page is replaced |
| `/admin-gate/*` | The gate page and its JSON API — mounted outside `/api`, so it does not need Harness's cookie |

Even if the injected redirect is bypassed, the refusal at `/api` still stands — the
page is just the surface.

## Conversation ownership: yours is yours

**Gating `/api` endpoints is not enough.** Once `session/list` is open to guests, a
guest sees the *titles of every conversation*; once `session/page` is open, knowing a
sessionId is enough to read the whole transcript. An endpoint allowlist answers "may
you call this method" — it cannot answer "whose conversation does this method return".

So there is a second layer:

| Layer | What it does |
|---|---|
| HTTP | Conversation methods check ownership against the `sessionId` in their arguments |
| Streams (WebSocket) | `session/follow` and friends check once, at open |
| Lists | `list` / `search` **filter** rather than refuse — never reveal "exists but you can't see it" |
| Create | Whoever opens a conversation is recorded as its owner |

Ownership lives in the state file under `sessions: { "<sessionId>": "acct:<id>" | "guest" }`.

- Unregistered legacy conversations count as unowned: only admins see them
- Upgrading to v3 assigns every conversation already on disk to the **earliest-created
  account** (they were its conversations), and afterwards whoever opens one claims it

## What guests get

The default allowlists are deliberately conservative — they decide whether the owner's
identity can be lent out, which is not a call this plugin should make for you:

- **Endpoints default to read-only**: conversation list/history, workspace files, the
  model catalog, the skill list, `settings/describe`, and so on. `session/prompt` is
  deliberately **not** included — opening it lets a guest put the agent to work, and
  the agent runs on this machine as the owner.
- **Tools default to `web_search` / `web_fetch` only**. No `read` / `bash` / `write`:
  `read` can reach the credentials under `~/.dsh`, `bash` can run anything.

Want guests to chat? Add `session/prompt` to the endpoint list. Want them to read files?
Add `read`. Every one of those is an explicit choice.

## Where state lives

`$DSH_HOME/admin-gate.json` (default `/root/.dsh/admin-gate.json`):

```json
{
  "version": 3,
  "mode": "guest",
  "accounts": {
    "<id>": { "name": "admin", "salt": "...", "hash": "...", "n": 16384, "r": 8, "p": 1, "createdAt": 0 }
  },
  "sessions": { "session-abc": "acct:<id>" },
  "guest": { "endpoints": ["..."], "tools": ["..."], "customized": false }
}
```

The state file holds password hashes and the guest allowlist and is **listed in
`.gitignore`** — do not commit it. Forgot the password? Delete the file and visit
`/admin-gate` again to set a new one.

## Development

```bash
node tests/gate.test.mjs      # host half, against a fake ctx
node tests/identity.test.mjs  # identity and ownership layer
```

## License

MIT, see [LICENSE](LICENSE).
