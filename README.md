# Slack Sync

Chrome extension (Manifest V3) that watches for channel joins in the Slack
**web client** (`app.slack.com`) and automatically files matching channels
into named sidebar sections — e.g. `incident-*` → **Incidents**. Missing
sections are created automatically. Zero npm dependencies, no build step.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `section-sync/` repo root (it contains `manifest.json`).
3. Reload any open `app.slack.com` tab (this also caches your section names
   for the options dropdown).
4. Open the extension's **Options** page and add your rules.

**The extension ships with no rules and does nothing until you add one.** A
fresh install never moves a channel on its own — important, since catch-up
sees your whole channel list on first load.

**Editing rules:** the **Section** column is a dropdown of the sections
already in your sidebar; pick **＋ Create new section…** to type a name that
doesn't exist yet — it gets created in Slack the first time a channel needs
it. Each pattern shows a live preview of how many of your channels it
matches — trust that number over your intuition about the syntax. Rules are
checked top to bottom, first match wins.

Edits are not live until saved: any change marks **● Unsaved changes** and
enables the **Save** button (leaving the page with edits pending prompts
first). Saving takes effect immediately in open Slack tabs, no reload needed. Because the ledger is
permanent, changing a rule won't re-file a channel already decided on — use
**Forget move history** to re-test against an existing channel.

Requires Chrome 111+ (declarative `"world": "MAIN"` content scripts) and a
Slack paid plan (sidebar sections don't exist on the free plan — the
extension detects this and silently disables itself for the session).

## How it works

Two content scripts, both injected at `document_start`:

| | `content/isolated.js` (trusted) | `content/main-world.js` (page world) |
|---|---|---|
| Runs in | extension's isolated world | the page's own JS world |
| Owns | rules, processed-channel ledger, `chrome.storage`, all decisions | websocket listener, `xoxc` token access, Slack API calls |
| Never | sees the token, touches the DOM | touches `chrome.*`, stores/logs/relays the token |

- **Join detection**: a passive `Proxy` over `window.WebSocket` adds a
  read-only `message` listener to sockets pointed at
  `wss-primary.slack.com` / `wss-backup.slack.com` and reacts to
  `channel_joined`, `group_joined`, and `member_joined_channel`
  (self-joins only). It never sends, closes, or interferes.
- **Moves**: the same internal `users.channelSections.*` calls the official
  UI makes, as form-encoded POSTs. Single attempt, 15 s timeout, no retries.
- **Catch-up**: once per page load, the extension enumerates the channels
  you're a member of and reconciles joins that happened while Slack was
  closed. It tries `users.conversations` first (documented, member-only,
  paginated), and falls back to `client.userBoot` — which is what actually
  works on Enterprise Grid, where a client token gets
  `enterprise_is_restricted` from the former. The permanent ledger makes
  this idempotent. With no rules configured, catch-up still runs (it
  refreshes the section list) but matches nothing.
- **Caches for the options page**: whenever a Slack tab is open, the content
  script caches your workspace's custom section **names** (`knownSections`)
  and your channel **names** (`knownChannels`) in `chrome.storage.local` —
  names only, no ids, no message content. These drive the section dropdown
  and the per-rule match preview. Both stay local; nothing is ever sent
  anywhere.
- **Ledger**: every channel the extension ever decided on is recorded as
  `teamId:channelId` (`done`/`failed`, both terminal). A channel you
  deliberately drag elsewhere is never re-moved; failures never retry.
  Pruned oldest-first past 5000 entries. Searchable and paginated in
  Options (20 per page).

  A channel that already sits in its rule's target section is recorded as
  `done (already there)` **without** issuing a move — so a first run over a
  large workspace doesn't spend its budget re-filing channels that are
  already correct.

  Because failures are terminal, a channel lost to a transient problem stays
  lost. Options has a **Retry N failed moves** button (shown only when there
  are any) that drops just the failed entries, leaving successful history
  intact, so the next Slack reload reconsiders them.
- **Move queue**: matched channels are moved one at a time, starting at one
  every 2 s, for as long as the tab stays open — a few hundred channels take
  several minutes rather than being truncated. A ledger entry is written when
  a move is *issued*, not when queued, and any `pending` entry found at load
  (the residue of a tab closed mid-drain) is cleared so those channels are
  reconsidered. A 400-move per-load guard exists only to bound a runaway;
  anything past it is left unrecorded and picked up on the next load.
- **Rate limiting**: a long run trips Slack's limit on `bulkUpdate` with HTTP
  429. That is treated as "later", never as a verdict on the channel: the
  page side holds *all* API calls for the `Retry-After` window (refusing them
  locally rather than hammering a limiter), and the queue pauses, doubles its
  spacing up to 30 s, and pushes the channel back to the front. Pace eases
  back toward 2 s as moves succeed. After 5 rate-limited attempts a channel
  is left unrecorded for the next load rather than marked failed.
- **Rules**: ordered, first-match-wins globs (`*` only — patterns are
  regex-escaped first, so there is no user-regex/ReDoS surface). Hot-reload
  on save. Moves are issued sequentially — see **Move queue** above.

  Patterns are **anchored**: they must match the whole channel name. A bare
  `internal-` matches only a channel named exactly `internal-`; use
  `internal-*` to catch `#internal-acme`. The options page previews how many
  of your current channels a pattern matches, and offers to add the `*` when
  a wildcard-less pattern would match nothing.

### Transport (why not the workspace host?)

On Enterprise Grid the workspace API host is a different origin from the
page, and Slack answers cross-origin `/api/` calls with
`Access-Control-Allow-Origin: *`. The browser will not combine a wildcard
ACAO with `credentials: "include"`, so a credentialed cross-origin call is
blocked before it is ever sent:

```
Access to fetch at 'https://<workspace>.enterprise.slack.com/api/users.channelSections.list'
from origin 'https://app.slack.com' has been blocked by CORS policy: the value of the
'Access-Control-Allow-Origin' header ... must not be the wildcard '*' when the
request's credentials mode is 'include'.
```

So the extension calls **same-origin** — `https://app.slack.com/api/<method>`
— which skips CORS entirely and sends the session cookie as first-party,
passing `?slack_route=<enterprise_id>:<team_id>` so Grid routes the call to
the right org (the format the official client uses).

Because this varies by workspace type, the transport is **probed once per
page load**: candidates are tried in order (same-origin with route,
same-origin bare, workspace host with `credentials:"omit"`, workspace host
credentialed) using a cheap `users.channelSections.list` read. The first one
that both reaches Slack and authenticates is latched for the session and
logged as `transport latched: <name>`. After two full failed sweeps the
extension stops probing.

### Which team a call is made as

Everything is anchored on the team in the page URL (`/client/<id>/…`), not
the team named in a websocket frame. On Enterprise Grid those differ: a
`member_joined_channel` frame carries the *workspace* team (`T…`) while the
client authenticates as the *enterprise* (`E…`). Trusting the frame picked a
sibling workspace's token and produced:

```
[slack-sync] users.channelSections.list → team_is_restricted
```

It also split the ledger — the same channel could be recorded as both
`T…:C…` (live join) and `E…:C…` (catch-up), so it could be filed twice.
Anchoring on the active client fixes both.

Relatedly, only errors that mean sections are genuinely unusable here
(`plan_upgrade_required`, `not_allowed_token_type`, `unknown_method`,
`method_deprecated`) or an unrecognised response shape disable the extension
for the session. A contextual error like `team_is_restricted` fails only the
operation in hand, and a failure at the `list` stage is not written to the
ledger at all — nothing was read and nothing changed, so the channel is
reconsidered on the next load instead of being excluded forever.

### Wire protocol (postMessage, same-window, origin-pinned)

`isolated.js` generates a `crypto.randomUUID()` nonce at `document_start`
and posts `{ssync:1, kind:"init", nonce}`; `main-world.js` latches onto the
**first** init only. Both scripts run before any page script, so a page
script cannot win that race. Every subsequent message carries the nonce;
both sides require `event.source === window` and
`event.origin === "https://app.slack.com"` and drop mismatches silently.
The isolated side additionally validates every field (types, length caps,
channel id `/^[CG][A-Z0-9]{6,}$/`, team id `/^[TE][A-Z0-9]{6,}$/`).

| Message | Direction | Payload |
|---|---|---|
| `channel-joined` | main → iso | `teamId, channelId, channelName, source:"ws"\|"catchup"` |
| `catchup-channels` | main → iso | `teamId, channels:[{id, name, section?}]` (`section` = the custom section it's already in) |
| `request-catchup` | iso → main | — (honored once per page load) |
| `move-channel` | iso → main | `teamId, channelId, sectionName, opId` |
| `move-result` | main → iso | `opId, ok, stage?, teamId, channelId` |
| `request-sections` | iso → main | — (triggered by the options page) |
| `sections` | main → iso | `teamId, names:[…]` (custom section names only) |

## Threat model

**Permissions**: `"storage"` only. Deliberately absent: `host_permissions`,
`background`/service worker, `tabs`, `cookies`, `webRequest`, `scripting`,
remote code, `eval`.

- **The token never leaves page context.** `xoxc` is read from the page's
  own `localStorage` inside the main-world API helper, per call, and used
  only in fetches to the workspace's `*.slack.com` origin. It is never
  messaged, logged, stored, or visible to the extension's isolated side.
  The `d` cookie is HttpOnly and is never read — the browser attaches it
  via `credentials: "include"`.
- **No non-Slack host is ever contacted.** API targets are either the page's
  own origin (`https://app.slack.com`) or the team's own workspace URL,
  which is validated to be `https://*.slack.com` before use;
  method names are restricted to a hardcoded six-entry allowlist.
- **If `isolated.js` were compromised**: the attacker gains the rules and
  ledger (non-secret) and the ability to ask for channel moves — no token,
  no API access beyond the move verbs.
- **If `main-world.js` were compromised**: that is equivalent to the Slack
  page itself being compromised; the extension adds no capability the page
  does not already have.
- **A malicious page script** cannot forge commands: it never sees the
  nonce (delivered before page scripts run, held in closures), and
  nonce-less messages are dropped silently.
- **Failure posture**: every failure is a single attempt and a
  `console.debug("[slack-sync] …")` line — never a retry storm, never a visible
  error, never interference with Slack's own traffic.

## Verified-payloads table

> **Status: verified end to end 2026-08-25** against a Slack **Enterprise
> Grid** workspace (a `*.enterprise.slack.com` host). Both paths are
> confirmed working: **live** — a join arrives on the websocket, the section
> is created, the channel is filed within seconds; and **catch-up** — a few
> hundred channels enumerated and reconciled on load. The code fails safe on
> mismatch (single `console.debug`, and it stands down for the session only
> when sections are genuinely unavailable).
>
> Everything below was observed on Grid. A single-workspace (non-Grid) Slack
> may differ — most likely in the transport (it may not be cross-origin at
> all) and in `users.conversations`, which Grid refuses. Both are probed or
> fall back automatically, so re-verify rather than assume.

| Item | Captured shape | Verified |
|---|---|---|
| Token | `JSON.parse(localStorage.localConfig_v2).teams[<key>].token` (`xoxc-…`) | ☑ |
| Self user id | `teams[<key>].user_id` (entry also has `id`, `url`). On Grid a frame may name either the workspace (`U…`) or enterprise user id, so **every** id across all team entries is collected and matched against | ☑ |
| Workspace URL | `teams[<key>].url` | ☑ |
| API host | **Must be same-origin.** The workspace host (`<org>.enterprise.slack.com`) answers cross-origin calls from `app.slack.com` with `Access-Control-Allow-Origin: *`, which the browser refuses to pair with `credentials:"include"` — the call never reaches Slack. We POST to `https://app.slack.com/api/<method>?slack_route=<enterprise>:<team>` instead. See **Transport** below | ☑ (that the cross-origin form is blocked) |
| `users.channelSections.list` | POST → `{ok:true, channel_sections:[{channel_section_id:"L…", name, type, emoji, next_channel_section_id, channel_ids_page:{channel_ids:[…], count}, is_redacted}]}`; custom sections have `type:"standard"`, built-ins e.g. `type:"channels"` | ☑ |
| `users.channelSections.create` | POST `name, emoji, next_channel_section_id` → `{ok:true, channel_section_id:"L…"}` (top-level). **`emoji` is required but may be empty** — `name` alone (even with `next_channel_section_id`) returns `invalid_arguments`. `next_channel_section_id` = the current head, so new sections land at the top as the client's do | ☑ |
| `…channels.bulkUpdate` | POST with **both** `insert` and `remove` always present as JSON-string form fields, `[]` when empty. Into a section from default: `remove=[]`. Between sections: both populated. Back to default: `insert=[]` | ☑ |
| `users.conversations` (catch-up, primary) | Reaches Slack but returns `ok:false, error:"enterprise_is_restricted"` on Grid — a client token can't call it there, so the fallback carries catch-up in practice | ☑ (as unavailable) |
| `client.userBoot` (catch-up, fallback) | POST, `token` only → `{ok, channels:[…]}`; enumerated several hundred channels. **This is the working catch-up source on Enterprise Grid** | ☑ |
| WS join frames | `{type:"channel_joined", channel:{id, name, is_channel, …}}`; `{type:"member_joined_channel", user, channel, channel_type, team, enterprise, ts}`. **Both fire for the same self-join** — deduped for 60 s so the second doesn't spend a `conversations.info` call. Neither carries a usable team id for API purposes; see **Which team a call is made as** | ☑ |
| Injection timing | Confirmed in console: `isolated world loaded, init posted` → `main world loaded (pre-socket breadcrumb)` → `handshake latched` → … → `watching socket: wss-primary.slack.com`. Both worlds load and the handshake completes before the client socket opens | ☑ |

### Capture procedure (repeat whenever Slack breaks something)

1. Open `app.slack.com` with DevTools → **Network**, filter `channelSections`.
2. Drag a channel between sections and create a new section in the UI.
   For each request, record the exact method name, the form-encoded body
   (Payload tab), and the JSON response.
3. In **Network → WS**, select the `wss-primary.slack.com` socket →
   Messages. Have a second account add you to a channel; record the join
   frame verbatim.
4. In Console: `JSON.parse(localStorage.localConfig_v2).teams` — confirm the
   `token`, `url`, and self-user-id field names.
5. Update this table (tick ☑) and adjust `content/main-world.js` where the
   shapes differ.

**Seeing the `[slack-sync]` breadcrumbs:** all extension logging uses
`console.debug`, which DevTools hides by default. In the Console, open the
log-levels dropdown (usually says "Default levels") and enable **Verbose**,
then reload the tab.

## Verification checklist

- **Inert on install**: with no rules saved, load the extension and reload
  Slack → `loaded 0 rule(s)`, catch-up enumerates channels, and **no move
  is issued**. Nothing in the sidebar changes.
- **Live path**: add a rule `incident-*` → `Incidents` and save. From
  another account create `incident-9999` and invite
  yourself → the channel appears under **Incidents** within seconds;
  **Incidents** is auto-created if absent; the ledger entry shows in Options.
- **Ledger respect**: drag the channel out of Incidents, leave and rejoin →
  it must NOT move back.
- **Catch-up**: disable the extension, join `incident-8888`, re-enable,
  reload → moved exactly once; a second reload issues no duplicate
  `bulkUpdate` (check the Network tab).
- **Security**: Network tab filtered to non-`slack.com` → zero requests
  from the tab; a console `message` listener sees no `xoxc` substring in
  any postMessage; forging `{ssync:1, kind:"move-channel", …}` from the page
  console without the nonce is dropped.
- **Failure mode**: break a method name in the allowlist → one attempt,
  `console.debug` only, Slack UI unaffected.

## Limitations & caveats

- **Undocumented API.** `users.channelSections.*` and `client.userBoot` are
  Slack-internal and may change or break without notice; automating them
  may not be sanctioned by Slack's ToS. This is a personal-productivity
  tool acting on your own account at a deliberately slow rate (one move per
  1.2 s, sequential, never concurrent) — use your own judgment. When Slack changes
  something, re-run the capture procedure above.
- Rules match the channel name **at join time** only; renames later don't
  re-file, and the ledger prevents surprise re-moves.
- Web client only — the desktop app (Electron) doesn't load Chrome
  extensions.
- `member_joined_channel` events are honored only when the self user id can
  be read from `localConfig_v2`; otherwise `channel_joined` (the primary
  self-join signal) still covers joins.
- Multi-workspace tabs follow the team in the URL (`/client/<id>/…`), which
  is re-read per event, so switching workspaces switches credentials too.
  Catch-up and the cached section list cover whichever team is active.
- The options dropdown reads a cache, so it's only as fresh as the last
  time a Slack tab was open. Opening the options page nudges any open tab
  to re-read; with no tab open, use **＋ Create new section…**.
- Catch-up enumerates at most 4 × 500 channels; beyond that, older
  memberships are simply never back-filled (the live path still catches new
  joins).
