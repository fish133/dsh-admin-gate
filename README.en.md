# Admin Gate (admin-gate)

[English](README.en.md) | [中文](README.md)

A gate in front of DeepSeek Harness — admins sign in with a password, guests enter without one and get a curated allowlist of endpoints and tools, and every account's conversations are invisible to the others.

> **This project was built with AI assistance.** Code, tests, and documentation were produced by AI. Free to use, modify, and redistribute.

## Install

```bash
# add the repo as a profile dependency
cd /root/.dsh/profiles/web
pnpm add link:/path/to/dsh-admin-gate
```

Then reference it from the profile's `dsh.profile.bundles`:

```json
"@local/dsh-admin-gate"
```

Restart Harness, or toggle `@local/dsh-admin-gate` off and on in the plugins settings
page. Once installed, visit `/admin-gate` to set the first password.

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
| Creation | `create` records the creator as owner |

Ownership lives in the state file as
`sessions: { "<sessionId>": "acct:<accountId>" | "guest" }`.

- An unregistered old conversation counts as "unowned" — admins only
- The v3 upgrade assigns every existing conversation to the **oldest account** (they
  were its conversations to begin with); from then on, whoever creates one owns it

## What guests get

The default allowlists are deliberately conservative — they decide whether the owner's
identity can be lent out, which is not a call the plugin should make for you:

- **Read-only endpoints by default**: conversation list/history, workspace files, model
  catalog, skill list, `settings/describe`, and so on. `session/prompt` is deliberately
  **excluded** — allowing it lets a guest put an agent to work, and that agent runs as
  the owner on this machine.
- **Only `web_search` / `web_fetch` as tools.** No `read` / `bash` / `write`: `read`
  can reach credentials under `~/.dsh`, and `bash` can run anything.

Want guests to chat? Add `session/prompt` to the endpoint list. Want them to read
files? Add `read`. Both are explicit choices.

## Where state lives

`$DSH_HOME/admin-gate.json` (default `/root/.dsh/admin-gate.json`):

```json
{
  "version": 3,
  "mode": "guest",
  "accounts": {
    "<id>": { "name": "Admin", "salt": "...", "hash": "...", "n": 16384, "r": 8, "p": 1, "createdAt": 0 }
  },
  "sessions": { "session-abc": "acct:<id>" },
  "guest": { "endpoints": ["..."], "tools": ["..."], "customized": false }
}
```

- Passwords are scrypt salted hashes; no plaintext, and nothing goes into the profile
  patch (patches are overwritten by upgrades)
- **Forgot the password?** Delete this file and reopen `/admin-gate` to set a new one
- Session tokens live in memory only — a Harness restart means passing the gate again
- v1's single `password` and v2's older shape are **migrated automatically** on read

## Changelog

### v1.2.0
- Fix: guests had **no identity of their own** — Harness's `browserAuth` returned 401
  before the gate ever ran, so a guest could only enter by borrowing an admin's cookie,
  running as owner and seeing every admin conversation
- New identity layer: wraps `connection.admit` / `admitConnection` / `authorizeIndex`;
  the gate issues its own identity-tagged Peer
- New ownership layer: state goes to v3 with a `sessions` map; 15 conversation methods
  are wrapped to check `sessionId` ownership; `list` / `search` filter instead of
  refusing
- New `tests/identity.test.mjs` (22 cases): identity issuance, ownership isolation,
  per-account separation
- Existing conversations are assigned to the oldest account on upgrade

### v1.1.0
- Multiple admin accounts, each with its own password
- No-guest mode (`admin-only` becomes the default)
- 8 bugs fixed (see below)

### v1.0.0
- First release: admin password, guest allowlist, three modes

## Fixed bugs

### v1.1.0

| # | Problem | Impact |
|---|---|---|
| 1 | Wildcard `a*b` also matched `ab` | Guests could reach endpoints not meant for them |
| 2 | A malformed cookie (`%E4%`) threw `URIError` | One bad cookie turned the whole request into a 500 |
| 3 | All guests shared one `guestPeer` | One guest disconnecting could take others down |
| 4 | Tool allowlist read a stale closure Set | Allowlist edits needed a restart to apply |
| 5 | Every request read the state file | Slow, and concurrent writes raced |
| 6 | Guest sessions survived a password change | Old guests kept working |
| 7 | No login failure limit | Passwords could be brute-forced |
| 8 | State file written non-atomically | A power loss left half a JSON behind |

### v1.2.0

| # | Problem | Impact |
|---|---|---|
| 9 | Guests had no identity and borrowed the owner's | Every admin conversation was visible to guests |
| 10 | Guests got 401 on `/` — not even the UI | Guests could not use the app at all |
| 11 | Endpoint allowlist governed calls, not returned rows | Knowing a sessionId was enough to read it |
| 12 | Newly created conversations had no owner | Guests could see conversations created later |

## Known limits

- **Browser traffic only.** The local CLI and API tokens minted via `/connect` do not
  pass through this gate — they are the owner using their own machine, not a remote guest
- The gate page is a self-contained HTML page with its own styles; it does not follow the
  Harness theme (it lives outside Harness)
- Guest detection rides `AsyncLocalStorage` for "who started this call", with agent
  ownership as a fallback. A call chain that bypasses HTTP entirely (a timer firing on
  its own, say) is treated as the owner

## Tests

```bash
node tests/gate.test.mjs      # 47 cases: the gate, accounts, modes, allowlists, migration
node tests/identity.test.mjs  # 22 cases: identity issuance, ownership isolation, separation
```

Run both. `gate.test.mjs` has no `connection` or `sessionController`, so the identity and
ownership layers are entirely skipped there — only `identity.test.mjs` actually covers
them.

## Layout

```
admin-gate/
├── index.js                  # host half: gate, identity, ownership, gate page
├── client.js                 # browser half: the "Admin Gate" settings section
├── cordis.patch.yml          # bundle declaration
├── locale/{zh,en}.json       # strings
├── icon.svg                  # icon
├── tests/
│   ├── gate.test.mjs         # gate and state
│   └── identity.test.mjs     # identity and conversation isolation
└── README.en.md
```

## License

MIT License
