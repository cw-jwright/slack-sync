// Slack Sync — MAIN-world side.
//
// Runs in the page's own JS world at document_start. This is the ONLY place
// that touches the xoxc session token, the Slack API, or the client
// websocket. The token is read from localStorage per call and never stored,
// logged, or posted anywhere. All communication with the trusted isolated
// side goes through window.postMessage guarded by a per-load nonce.
(() => {
  "use strict";

  const ORIGIN = "https://app.slack.com";
  const WS_HOSTS = new Set(["wss-primary.slack.com", "wss-backup.slack.com"]);
  const API_ALLOWLIST = new Set([
    "users.channelSections.list",
    "users.channelSections.create",
    "users.channelSections.channels.bulkUpdate",
    "users.conversations",
    "client.userBoot",
    "conversations.info",
  ]);
  const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
  const TEAM_ID = /^[TE][A-Z0-9]{6,}$/;
  const API_TIMEOUT_MS = 15000;
  const CATCHUP_PAGE_LIMIT = 500;
  const CATCHUP_MAX_PAGES = 4;

  const DBG = (...args) => {
    try { console.debug("[slack-sync]", ...args); } catch { /* ignore */ }
  };

  let nonce = null;        // latched from the first init message, never replaced
  let disabled = false;    // set when the sections API looks absent/changed; sticky for the session
  let catchupDone = false; // one catch-up pass per page load

  function post(msg) {
    if (!nonce) return;
    window.postMessage(Object.assign({ ssync: 1, nonce }, msg), ORIGIN);
  }

  // ---------------------------------------------------------------------
  // Token / team resolution — lazy, per call, never held in a global.
  // ---------------------------------------------------------------------

  function activeTeamId() {
    const m = location.pathname.match(/^\/client\/([A-Z0-9]+)/);
    return m ? m[1] : null;
  }

  function teamAuth(teamId) {
    let cfg;
    try {
      const raw = localStorage.getItem("localConfig_v2");
      if (!raw) return null;
      cfg = JSON.parse(raw);
    } catch {
      return null;
    }
    const teams = cfg && cfg.teams;
    if (!teams || typeof teams !== "object") return null;
    // Direct key first; on Enterprise Grid the map key may differ from the
    // team id seen in WS frames / the URL, so fall back to the entry's own id.
    let team = teams[teamId];
    if (!team) {
      team = Object.values(teams).find(
        (t) => t && (t.id === teamId || t.enterprise_id === teamId)
      );
    }
    if (!team || typeof team.token !== "string" || !team.token.startsWith("xoxc-")) return null;
    let base;
    try {
      const u = new URL(team.url);
      if (u.protocol !== "https:") return null;
      if (u.hostname !== "slack.com" && !u.hostname.endsWith(".slack.com")) return null;
      base = u.origin;
    } catch {
      return null;
    }
    const urlTeam = activeTeamId();
    const enterpriseId = typeof team.enterprise_id === "string" ? team.enterprise_id : null;
    return {
      token: team.token,
      base,
      // Grid routing hint, mirroring the captured client URL
      // (?slack_route=<enterprise>:<team>).
      slackRoute: urlTeam ? (enterpriseId || urlTeam) + ":" + urlTeam : null,
    };
  }

  // Every user id this browser session belongs to. On Enterprise Grid the
  // same human has a workspace user id (U…) and often a separate enterprise
  // one (W…); a `member_joined_channel` frame may name either. Comparing
  // against a single team's `user_id` silently dropped our own joins, so
  // gather them all.
  function selfUserIds() {
    const ids = new Set();
    try {
      const cfg = JSON.parse(localStorage.getItem("localConfig_v2") || "{}");
      for (const t of Object.values(cfg.teams || {})) {
        if (!t) continue;
        for (const field of ["user_id", "enterprise_user_id", "enterprise_user"]) {
          const v = t[field];
          if (typeof v === "string" && v) ids.add(v);
          else if (v && typeof v.id === "string") ids.add(v.id);
        }
      }
    } catch { /* unreadable config — treat as no known ids */ }
    return ids;
  }

  // ---------------------------------------------------------------------
  // Transport probing.
  //
  // The workspace API host (e.g. <org>.enterprise.slack.com) is a
  // DIFFERENT origin from the page (app.slack.com). Slack answers those
  // cross-origin calls with `Access-Control-Allow-Origin: *`, which the
  // browser refuses to combine with `credentials:"include"` — so the
  // credentialed cross-origin call never reaches Slack at all.
  //
  // Same-origin (app.slack.com/api/...) sidesteps CORS entirely and sends
  // cookies normally, so it is tried first. We probe the candidates once,
  // latch the first that authenticates, and reuse it for the session.
  // ---------------------------------------------------------------------

  const AUTH_ERRORS = new Set([
    "not_authed", "invalid_auth", "account_inactive",
    "org_login_required", "team_added_to_org",
  ]);

  let transport = null;       // latched winner
  let transportProbe = null;  // in-flight probe, so concurrent calls share one
  let probeFailures = 0;      // give up after a couple of full sweeps
  const MAX_PROBE_FAILURES = 2;

  function transportCandidates(auth) {
    const list = [];
    // Same-origin first: no CORS preflight, cookies sent as first-party.
    if (auth.slackRoute) {
      list.push({
        name: "same-origin+route",
        url: ORIGIN + "/api/",
        credentials: "include",
        route: auth.slackRoute,
      });
    }
    list.push({
      name: "same-origin",
      url: ORIGIN + "/api/",
      credentials: "include",
      route: null,
    });
    // Cross-origin fallbacks. "omit" is the only credentials mode compatible
    // with a wildcard ACAO; it works only if the xoxc token alone suffices.
    if (auth.base !== ORIGIN) {
      list.push({
        name: "workspace-host+omit",
        url: auth.base + "/api/",
        credentials: "omit",
        route: auth.slackRoute,
      });
      list.push({
        name: "workspace-host+creds",
        url: auth.base + "/api/",
        credentials: "include",
        route: auth.slackRoute,
      });
    }
    return list;
  }

  // Returns parsed JSON, or null on network/HTTP failure.
  async function rawCall(candidate, method, fields, token) {
    const body = new URLSearchParams(fields || {});
    body.set("token", token);
    // The official client tags calls with _x_* telemetry params. Not required,
    // but they keep our traffic legible in the client's own Network tab.
    body.set("_x_reason", "slack-sync");
    body.set("_x_mode", "online");
    let url = candidate.url + method;
    if (candidate.route) url += "?slack_route=" + encodeURIComponent(candidate.route);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        body,
        credentials: candidate.credentials,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        DBG(method, "via", candidate.name, "— http", res.status);
        return null;
      }
      return await res.json();
    } catch (err) {
      const why = ctrl.signal.aborted
        ? "timed out after " + API_TIMEOUT_MS + "ms"
        : (err && err.name ? err.name + ": " : "") + (err && err.message);
      DBG(method, "via", candidate.name, "—", why);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const authenticated = (resp) =>
    resp && (resp.ok === true || !AUTH_ERRORS.has(resp.error));

  // Probe with a cheap, harmless read. Latches the first candidate that
  // both reaches Slack and authenticates.
  async function resolveTransport(auth) {
    if (transport) return transport;
    if (transportProbe) return transportProbe;
    if (probeFailures >= MAX_PROBE_FAILURES) return null;
    transportProbe = (async () => {
      for (const candidate of transportCandidates(auth)) {
        const resp = await rawCall(candidate, "users.channelSections.list", {}, auth.token);
        if (authenticated(resp)) {
          transport = candidate;
          DBG("transport latched:", candidate.name);
          return candidate;
        }
        if (resp && resp.error) DBG("transport", candidate.name, "rejected:", resp.error);
      }
      probeFailures++;
      DBG(
        "no working transport found (attempt " + probeFailures + "/" +
        MAX_PROBE_FAILURES + ") — every candidate failed"
      );
      return null;
    })();
    try {
      return await transportProbe;
    } finally {
      transportProbe = null;
    }
  }

  // ---------------------------------------------------------------------
  // API helper: form POST, allowlisted methods, *.slack.com only,
  // timeout, single attempt, no retries.
  // ---------------------------------------------------------------------

  async function slackApi(teamId, method, fields) {
    if (disabled) return null;
    if (!API_ALLOWLIST.has(method)) {
      DBG("refused non-allowlisted method:", method);
      return null;
    }
    const auth = teamAuth(teamId);
    if (!auth) {
      DBG("no session token for team", teamId);
      return null;
    }
    const candidate = await resolveTransport(auth);
    if (!candidate) return null;
    const resp = await rawCall(candidate, method, fields, auth.token);
    if (resp && resp.ok !== true && resp.error) DBG(method, "→", resp.error);
    return resp;
  }

  // ---------------------------------------------------------------------
  // Sections: list → name match → create if absent → bulkUpdate.
  // ---------------------------------------------------------------------

  function sectionChannelIds(section) {
    const page = section && section.channel_ids_page;
    return page && Array.isArray(page.channel_ids) ? page.channel_ids : [];
  }

  // Errors that mean sidebar sections genuinely aren't usable here (free
  // plan, wrong token type). Anything else — a restricted team, a transient
  // failure — fails just the operation in hand. Standing down for the whole
  // session on a contextual error kills every later move for no reason.
  const FATAL_SECTION_ERRORS = new Set([
    "plan_upgrade_required",
    "not_allowed_token_type",
    "unknown_method",
    "method_deprecated",
  ]);

  async function listSections(teamId) {
    const resp = await slackApi(teamId, "users.channelSections.list", {});
    if (resp === null) return null; // transient failure — fail this op only
    if (resp.ok !== true || !Array.isArray(resp.channel_sections)) {
      if (resp.ok !== false || FATAL_SECTION_ERRORS.has(resp.error)) {
        // Unrecognised shape, or a hard "not available here": stand down.
        disabled = true;
        DBG(
          "channelSections.list unavailable (" + (resp.error || "unknown shape") +
          ") — disabled for this session"
        );
      } else {
        DBG("channelSections.list failed (" + resp.error + ") — this operation only");
      }
      return null;
    }
    return resp.channel_sections;
  }

  // Publish the user's custom section names so the options page can offer
  // them as a dropdown. Names only — no ids, no channel contents.
  async function publishSections(teamId) {
    const sections = await listSections(teamId);
    if (!sections) return;
    const names = sections
      .filter((s) => s && s.type === "standard" && typeof s.name === "string" && s.name.trim())
      .map((s) => s.name.trim())
      .slice(0, 200);
    post({ kind: "sections", teamId, names });
    DBG("published", names.length, "custom section name(s)");
  }

  // Verified live: `emoji` is REQUIRED but may be empty, and `name` alone
  // returns `invalid_arguments`. `next_channel_section_id` points at the
  // current head so a new section lands at the top of the sidebar, matching
  // what the official client does.
  async function createSection(teamId, name, sections) {
    const head = sections && sections[0] && sections[0].channel_section_id;
    const fields = { name, emoji: "" };
    if (head) fields.next_channel_section_id = head;
    const resp = await slackApi(teamId, "users.channelSections.create", fields);
    const sid =
      resp && resp.ok === true
        ? resp.channel_section_id ||
          (resp.channel_section && resp.channel_section.channel_section_id)
        : null;
    if (typeof sid !== "string" || !sid) return null;
    DBG('created section "' + name + '"');
    return sid;
  }

  async function handleMove(d) {
    const { teamId, channelId, sectionName, opId } = d;
    const result = (ok, stage) =>
      post({ kind: "move-result", opId, ok, stage, teamId, channelId });

    const sections = await listSections(teamId);
    if (!sections) return result(false, "list");

    const wanted = sectionName.trim().toLowerCase();
    let target = sections.find(
      (s) => typeof s.name === "string" && s.name.trim().toLowerCase() === wanted
    );
    const current = sections.find((s) => sectionChannelIds(s).includes(channelId));

    if (target && current &&
        current.channel_section_id === target.channel_section_id) {
      return result(true, "noop");
    }

    if (!target) {
      const sid = await createSection(teamId, sectionName, sections);
      if (!sid) return result(false, "create");
      target = { channel_section_id: sid };
      publishSections(teamId); // keep the options dropdown current
    }

    // Captured behavior: the official client always sends BOTH fields,
    // with "[]" when a side is empty. "remove" carries the channel's current
    // custom section (if any) so a move never duplicates.
    const fields = {
      insert: JSON.stringify([
        { channel_section_id: target.channel_section_id, channel_ids: [channelId] },
      ]),
      remove: JSON.stringify(
        current
          ? [{ channel_section_id: current.channel_section_id, channel_ids: [channelId] }]
          : []
      ),
    };
    const upd = await slackApi(teamId, "users.channelSections.channels.bulkUpdate", fields);
    if (!upd || upd.ok !== true) return result(false, "bulkUpdate");
    result(true, "moved");
  }

  // ---------------------------------------------------------------------
  // Websocket join detection — passive Proxy over the constructor.
  // Read-only: never sends, never closes, never preventDefaults.
  // Stateless per socket, so reconnects and parallel sockets just work.
  // ---------------------------------------------------------------------

  // The team in the URL comes FIRST, deliberately.
  //
  // On Enterprise Grid a `member_joined_channel` frame carries the workspace
  // team (e.g. T…) while the client — and the token/route we authenticate
  // with — operates as the enterprise (E…). Trusting the frame's team picked
  // a sibling workspace's credentials and got `team_is_restricted`. It also
  // keyed the ledger inconsistently: the same channel could be filed under
  // both `T…:C…` from a live join and `E…:C…` from catch-up, and so be moved
  // twice. Anchoring on the active client keeps both correct.
  function pickTeamId(frame) {
    const candidates = [
      activeTeamId(),
      frame.team_id,
      frame.team,
      frame.channel && frame.channel.context_team_id,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && TEAM_ID.test(c)) return c;
    }
    return null;
  }

  // Slack sends both `channel_joined` and `member_joined_channel` for the
  // same self-join. The ledger already dedupes the decision, but the second
  // frame carries no channel name and would spend a `conversations.info`
  // call re-resolving one we already had — so drop it here instead.
  const recentJoins = new Map(); // channelId -> first-seen timestamp
  const JOIN_DEDUPE_MS = 60000;

  function alreadyEmitted(channelId) {
    const now = Date.now();
    for (const [id, ts] of recentJoins) {
      if (now - ts > JOIN_DEDUPE_MS) recentJoins.delete(id);
    }
    if (recentJoins.has(channelId)) return true;
    recentJoins.set(channelId, now);
    return false;
  }

  async function emitJoin(frame, channelId, channelName) {
    if (!CHANNEL_ID.test(channelId)) return;
    if (alreadyEmitted(channelId)) return DBG("duplicate join frame for", channelId, "— ignored");
    const teamId = pickTeamId(frame);
    if (!teamId) return DBG("join for", channelId, "— no team id resolvable");
    if (!channelName) {
      // Single resolution attempt; give up silently on failure.
      const info = await slackApi(teamId, "conversations.info", { channel: channelId });
      if (info && info.ok === true && info.channel && typeof info.channel.name === "string") {
        channelName = info.channel.name;
      } else {
        return DBG("could not resolve name for", channelId);
      }
    }
    DBG("live join → #" + channelName, "(team " + teamId + ")");
    post({ kind: "channel-joined", teamId, channelId, channelName, source: "ws" });
  }

  function onWsMessage(ev) {
    if (disabled || typeof ev.data !== "string") return;
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    if (frame.type === "channel_joined" || frame.type === "group_joined") {
      const ch = frame.channel;
      if (!ch || typeof ch.id !== "string") return;
      DBG("ws " + frame.type + ":", ch.id, ch.name ? "#" + ch.name : "(unnamed)");
      emitJoin(frame, ch.id, typeof ch.name === "string" ? ch.name : null);
    } else if (frame.type === "member_joined_channel") {
      if (typeof frame.user !== "string" || typeof frame.channel !== "string") return;
      const ids = selfUserIds();
      // Only act on OUR join; if no self id is readable, drop the event —
      // channel_joined is the primary signal for self joins anyway.
      if (!ids.size) {
        return DBG("ws member_joined_channel:", frame.channel, "— no self user id, ignored");
      }
      if (!ids.has(frame.user)) return; // somebody else joined
      DBG("ws member_joined_channel (self):", frame.channel);
      emitJoin(frame, frame.channel, null);
    }
  }

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const ws = Reflect.construct(target, args);
      try {
        const host = new URL(args[0], location.href).hostname;
        if (WS_HOSTS.has(host)) {
          ws.addEventListener("message", onWsMessage);
          DBG("watching socket:", host);
        }
      } catch { /* non-URL first arg — not ours */ }
      return ws;
    },
  });
  DBG("main world loaded (pre-socket breadcrumb)");

  // ---------------------------------------------------------------------
  // Catch-up: enumerate the channels we're a member of, so joins that
  // happened while Slack was closed still get filed.
  //
  // Primary: users.conversations — documented, member-only, paginated,
  // and a small response. Fallback: client.userBoot (internal, one call,
  // huge response) for the case where users.conversations is unavailable
  // to a client token.
  // ---------------------------------------------------------------------

  function collectChannels(list, out) {
    if (!Array.isArray(list)) return;
    for (const ch of list) {
      if (!ch || typeof ch.id !== "string" || typeof ch.name !== "string") continue;
      if (ch.is_member === false || ch.is_archived === true) continue;
      if (ch.is_im || ch.is_mpim) continue;
      out.push({ id: ch.id, name: ch.name });
    }
  }

  async function catchupViaUsersConversations(teamId) {
    const channels = [];
    let cursor = "";
    for (let page = 0; page < CATCHUP_MAX_PAGES; page++) {
      const fields = {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: String(CATCHUP_PAGE_LIMIT),
      };
      if (cursor) fields.cursor = cursor;
      const resp = await slackApi(teamId, "users.conversations", fields);
      if (!resp || resp.ok !== true || !Array.isArray(resp.channels)) return null;
      collectChannels(resp.channels, channels);
      cursor = (resp.response_metadata && resp.response_metadata.next_cursor) || "";
      if (!cursor) break;
    }
    return channels;
  }

  async function catchupViaUserBoot(teamId) {
    const boot = await slackApi(teamId, "client.userBoot", {});
    if (!boot || boot.ok !== true) return null;
    const channels = [];
    collectChannels(boot.channels, channels);
    return channels.length ? channels : null;
  }

  async function handleCatchup() {
    const teamId = activeTeamId();
    if (!teamId) return DBG("catch-up skipped: no active team in URL");

    // Fetch sections once and reuse: publishing them for the options
    // dropdown, and tagging each channel with the section it's already in so
    // the isolated side can skip channels that are already filed correctly
    // instead of spending a move on a no-op.
    const sections = await listSections(teamId);
    if (sections) {
      post({
        kind: "sections",
        teamId,
        names: sections
          .filter((s) => s && s.type === "standard" && typeof s.name === "string" && s.name.trim())
          .map((s) => s.name.trim())
          .slice(0, 200),
      });
    }
    const sectionOf = new Map();
    for (const s of sections || []) {
      if (!s || typeof s.name !== "string") continue;
      for (const id of sectionChannelIds(s)) sectionOf.set(id, s.name.trim());
    }

    let channels = await catchupViaUsersConversations(teamId);
    if (channels === null) {
      DBG("users.conversations unavailable — trying client.userBoot");
      channels = await catchupViaUserBoot(teamId);
    }
    if (channels === null) return DBG("catch-up skipped: no channel source available");

    const tagged = channels.slice(0, 2000).map((c) => {
      const section = sectionOf.get(c.id);
      return section ? { id: c.id, name: c.name, section } : c;
    });
    DBG(
      "catch-up enumerated " + channels.length + " channel(s); " +
      sectionOf.size + " already in a custom section"
    );
    post({ kind: "catchup-channels", teamId, channels: tagged });
  }

  // ---------------------------------------------------------------------
  // Wire protocol: latch the first init, then require the nonce on
  // everything. Both content scripts run at document_start, so the init
  // is delivered before any page script can race it.
  // ---------------------------------------------------------------------

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const d = ev.data;
    if (!d || d.ssync !== 1) return;

    if (d.kind === "init") {
      if (!nonce && typeof d.nonce === "string" && d.nonce.length >= 16) {
        nonce = d.nonce;
        DBG("handshake latched");
      }
      return;
    }
    if (!nonce || d.nonce !== nonce) return;

    if (d.kind === "move-channel") {
      if (
        typeof d.opId !== "string" ||
        typeof d.teamId !== "string" || !TEAM_ID.test(d.teamId) ||
        typeof d.channelId !== "string" || !CHANNEL_ID.test(d.channelId) ||
        typeof d.sectionName !== "string" ||
        !d.sectionName.trim() || d.sectionName.length > 80
      ) return;
      handleMove(d);
    } else if (d.kind === "request-catchup") {
      if (catchupDone) return;
      catchupDone = true;
      handleCatchup();
    } else if (d.kind === "request-sections") {
      const teamId = activeTeamId();
      if (teamId) publishSections(teamId);
    }
  });
})();
