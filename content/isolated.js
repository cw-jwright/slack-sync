// Slack Sync — isolated-world side (trusted).
//
// Owns chrome.storage, the rules, the processed-channel ledger, and all
// decisions. Never touches the DOM, never sees the Slack token. Talks to
// the MAIN-world side only via postMessage guarded by a per-load nonce
// that this side generates first (both scripts run at document_start,
// before any page script).
(() => {
  "use strict";

  const ORIGIN = "https://app.slack.com";
  const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
  const TEAM_ID = /^[TE][A-Z0-9]{6,}$/;
  const MAX_NAME_LEN = 200;
  const MAX_RULES = 100;
  // Runaway guard, not a throttle: moves drain one at a time for as long as
  // the tab is open, and anything past the guard is retried on the next load
  // rather than dropped.
  const MAX_MOVES_PER_BOOT = 400;
  // Slack rate-limits bursts of bulkUpdate with HTTP 429, so pacing adapts:
  // start here, double (up to MAX) on a 429, and ease back down on success.
  const MOVE_SPACING_MS = 2000;
  const MAX_SPACING_MS = 30000;
  const SPACING_RECOVERY_MS = 250;
  const MAX_MOVE_ATTEMPTS = 5;
  const LEDGER_MAX = 5000;
  const CATCHUP_DELAY_MS = 5000;
  // No rules ship with the extension: on a fresh install it must not move
  // anything until the user has explicitly said what to move where.

  const DBG = (...args) => {
    try { console.debug("[slack-sync]", ...args); } catch { /* ignore */ }
  };

  const nonce = crypto.randomUUID();
  window.postMessage({ ssync: 1, kind: "init", nonce }, ORIGIN);
  DBG("isolated world loaded, init posted");

  function post(msg) {
    window.postMessage(Object.assign({ ssync: 1, nonce }, msg), ORIGIN);
  }

  // ---------------------------------------------------------------------
  // Rules: ordered, first-match-wins, glob-only (no user regex).
  // ---------------------------------------------------------------------

  function globToRegExp(glob) {
    // Escape everything regex-special except "*", then "*" -> ".*", anchored.
    const escaped = glob
      .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$", "i");
  }

  function compileRules(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const r of raw.slice(0, MAX_RULES)) {
      if (!r || typeof r.pattern !== "string" || typeof r.section !== "string") continue;
      const pattern = r.pattern.trim();
      const section = r.section.trim();
      if (!pattern || !section || pattern.length > 80 || section.length > 80) continue;
      out.push({ re: globToRegExp(pattern), section });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // State: rules (hot-reloaded), permanent ledger, sequential move queue.
  // ---------------------------------------------------------------------

  let rules = null; // null until storage loads; drops early events (catch-up covers them)
  let ledger = {};
  let queued = 0;       // enqueued this session (runaway guard)
  let issued = 0;       // actually sent to the page side
  let alreadyFiled = 0; // matched a rule but were already in the right section
  let deferred = 0;     // over the guard; left for the next page load
  const pendingOps = new Map(); // opId -> the in-flight job (so it can be re-queued)
  const queue = [];
  let draining = false;
  let spacing = MOVE_SPACING_MS; // current pace, widened by rate limits
  let pauseUntil = 0;            // hard stop while Slack is rate limiting us
  let rateLimitHits = 0;

  function saveLedger() {
    const keys = Object.keys(ledger);
    if (keys.length > LEDGER_MAX) {
      keys.sort((a, b) => (ledger[a].ts || 0) - (ledger[b].ts || 0));
      for (const k of keys.slice(0, keys.length - LEDGER_MAX)) delete ledger[k];
    }
    chrome.storage.local.set({ ledger });
  }

  chrome.storage.local.get(["rules", "ledger"], (data) => {
    rules = compileRules(data.rules);
    ledger = data.ledger && typeof data.ledger === "object" ? data.ledger : {};
    // A "pending" entry at load time is the residue of a session that ended
    // mid-drain — the move was never confirmed. Drop it so the channel is
    // reconsidered instead of being stuck pending forever.
    let stale = 0;
    for (const [k, e] of Object.entries(ledger)) {
      if (e && e.status === "pending") { delete ledger[k]; stale++; }
    }
    if (stale) {
      DBG("cleared", stale, "unfinished move(s) from a previous session");
      saveLedger();
    }
    DBG("loaded", rules.length, "rule(s),", Object.keys(ledger).length, "ledger entries");
    // Still run catch-up with zero rules: it costs one read and populates the
    // section list for the options dropdown. With no rules nothing matches,
    // so nothing moves.
    setTimeout(() => post({ kind: "request-catchup" }), CATCHUP_DELAY_MS);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.rules) {
      rules = compileRules(changes.rules.newValue);
      DBG("rules hot-reloaded:", rules.length);
    }
    if (changes.ledger) {
      // Adopt external clears/edits (options page); our own writes echo back
      // the same content, so this is a no-op for them.
      const next = changes.ledger.newValue;
      ledger = next && typeof next === "object" ? next : {};
    }
    if (changes.sectionsRequestedAt) {
      // The options page asks for a refresh by bumping this key.
      post({ kind: "request-sections" });
    }
  });

  // ---------------------------------------------------------------------
  // Decision path: ledger guard -> first matching rule -> queue a move.
  // Ledger entries are permanent (pending/done/failed all terminal) so a
  // channel the user deliberately drags elsewhere is never re-moved and
  // failures never become retry storms.
  // ---------------------------------------------------------------------

  const sameSection = (a, b) =>
    typeof a === "string" && typeof b === "string" &&
    a.trim().toLowerCase() === b.trim().toLowerCase();

  // `currentSection` is the section the channel already sits in, when known
  // (catch-up supplies it). A channel already in the right place is recorded
  // as done without spending a move.
  function onChannelJoined(teamId, channelId, channelName, source, currentSection) {
    // Live joins are the headline feature, so never let one fail silently —
    // catch-up stays quiet per channel and reports totals instead.
    const trace = source === "ws" ? DBG : () => {};
    if (!rules) return trace("join #" + channelName, "— rules not loaded yet, ignored");
    const key = teamId + ":" + channelId;
    if (Object.prototype.hasOwnProperty.call(ledger, key)) {
      return trace("join #" + channelName, "— already in the ledger, ignored");
    }
    const rule = rules.find((r) => r.re.test(channelName));
    if (!rule) return trace("join #" + channelName, "— no rule matched");
    trace("join #" + channelName, "→ matched rule for section", JSON.stringify(rule.section));

    if (sameSection(currentSection, rule.section)) {
      ledger[key] = {
        status: "done",
        stage: "already-filed",
        section: rule.section,
        name: channelName,
        source,
        ts: Date.now(),
      };
      alreadyFiled++;
      saveLedger();
      return;
    }

    if (queued >= MAX_MOVES_PER_BOOT) {
      // Runaway guard only. Nothing is written to the ledger, so anything
      // beyond it is picked up by the next page load rather than lost.
      deferred++;
      return;
    }
    queued++;
    queue.push({ teamId, channelId, sectionName: rule.section, name: channelName, source, key });
    drain();
  }

  // Moves are issued one at a time, MOVE_SPACING_MS apart, for as long as the
  // tab stays open. The ledger entry is written when a move is actually
  // ISSUED, not when queued — so a tab closed mid-drain leaves the remaining
  // channels unrecorded and they are simply retried next load.
  function drain() {
    if (draining) return;
    draining = true;
    const next = () => {
      // Wait out any rate-limit cooldown before touching the queue.
      const hold = pauseUntil - Date.now();
      if (hold > 0) return setTimeout(next, Math.min(hold, 5000));

      const job = queue.shift();
      if (!job) {
        draining = false;
        if (issued) {
          DBG(
            "move queue drained — " + issued + " issued this session" +
            (rateLimitHits ? ", " + rateLimitHits + " rate-limit pause(s)" : "")
          );
        }
        return;
      }
      const opId = crypto.randomUUID();
      ledger[job.key] = {
        status: "pending",
        section: job.sectionName,
        name: job.name,
        source: job.source,
        ts: Date.now(),
      };
      saveLedger();
      pendingOps.set(opId, job);
      issued++;
      post({
        kind: "move-channel",
        teamId: job.teamId,
        channelId: job.channelId,
        sectionName: job.sectionName,
        opId,
      });
      setTimeout(next, spacing);
    };
    next();
  }

  // Slack said "too fast": hold the queue for as long as it asked, widen the
  // pace, and put the channel back at the front — it was never attempted.
  function onRateLimited(job, retryAfterSec) {
    rateLimitHits++;
    const wait = Math.max(
      (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 30) * 1000,
      spacing
    );
    pauseUntil = Math.max(pauseUntil, Date.now() + wait);
    spacing = Math.min(spacing * 2, MAX_SPACING_MS);
    delete ledger[job.key];

    job.attempts = (job.attempts || 0) + 1;
    if (job.attempts >= MAX_MOVE_ATTEMPTS) {
      // Leave it unrecorded rather than marking it failed — the next page
      // load reconsiders it with a fresh rate-limit budget.
      saveLedger();
      DBG("giving up on #" + job.name, "after", job.attempts, "rate-limited attempts — next load will retry");
      return;
    }
    queue.unshift(job);
    saveLedger();
    DBG(
      "rate limited — pausing " + Math.ceil(wait / 1000) + "s, pace now " +
      (spacing / 1000) + "s/move, " + (queue.length) + " left"
    );
  }

  function onMoveResult(d) {
    const job = pendingOps.get(d.opId);
    if (!job) return;
    pendingOps.delete(d.opId);
    const key = job.key;

    // Rate limited: nothing was attempted, so this is a scheduling problem,
    // not a verdict on the channel. Back off and re-queue.
    if (d.ok !== true && d.stage === "rate-limited") {
      return onRateLimited(job, d.retryAfter);
    }

    const entry = ledger[key];
    if (!entry || entry.status !== "pending") return;

    // A failure at the "list" stage means we never read the sections, so no
    // decision was made about this channel and nothing changed. Recording it
    // as a terminal failure would exclude it forever over what is usually a
    // transient or environmental problem — drop the entry and let the next
    // load reconsider it.
    if (d.ok !== true && d.stage === "list") {
      delete ledger[key];
      saveLedger();
      DBG("move deferred (sections unreadable)", key, "— will retry next load");
      return;
    }

    // A clean result means the current pace is tolerable — creep back toward
    // the base rate so one 429 doesn't slow the rest of the run forever.
    if (d.ok === true && spacing > MOVE_SPACING_MS) {
      spacing = Math.max(MOVE_SPACING_MS, spacing - SPACING_RECOVERY_MS);
    }

    entry.status = d.ok === true ? "done" : "failed";
    if (typeof d.stage === "string" && d.stage.length <= 32) entry.stage = d.stage;
    entry.ts = Date.now();
    saveLedger();
    DBG("move", entry.status, key, entry.stage || "");
  }

  // Cache channel names (names only, no ids) so the options page can show
  // how many channels a rule would actually match before you save it.
  function cacheChannelNames(teamId, names) {
    const clean = [];
    for (const n of names) {
      if (typeof n === "string" && n && n.length <= MAX_NAME_LEN) clean.push(n);
      if (clean.length >= 2000) break;
    }
    clean.sort();
    chrome.storage.local.set({
      knownChannels: { teamId, names: clean, ts: Date.now() },
    });
  }

  // Cache the workspace's custom section names so the options page can
  // offer them as a dropdown. Names only — never ids or channel contents.
  function onSections(teamId, names) {
    const clean = [];
    for (const n of names.slice(0, 200)) {
      if (typeof n !== "string") continue;
      const name = n.trim();
      if (name && name.length <= 80 && !clean.includes(name)) clean.push(name);
    }
    chrome.storage.local.set({
      knownSections: { teamId, names: clean, ts: Date.now() },
    });
  }

  // ---------------------------------------------------------------------
  // Inbound wire protocol — validate everything, drop mismatches silently.
  // ---------------------------------------------------------------------

  const validTeam = (v) => typeof v === "string" && TEAM_ID.test(v);
  const validChannel = (v) => typeof v === "string" && CHANNEL_ID.test(v);
  const validName = (v) =>
    typeof v === "string" && v.length > 0 && v.length <= MAX_NAME_LEN;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const d = ev.data;
    if (!d || d.ssync !== 1 || d.nonce !== nonce || typeof d.kind !== "string") return;

    switch (d.kind) {
      case "channel-joined": {
        if (!validTeam(d.teamId) || !validChannel(d.channelId) || !validName(d.channelName)) return;
        onChannelJoined(
          d.teamId,
          d.channelId,
          d.channelName,
          d.source === "catchup" ? "catchup" : "ws"
        );
        break;
      }
      case "catchup-channels": {
        if (!validTeam(d.teamId) || !Array.isArray(d.channels)) return;
        const names = [];
        let seen = 0, matched = 0, known = 0;
        for (const ch of d.channels.slice(0, 2000)) {
          if (!ch || !validChannel(ch.id) || !validName(ch.name)) continue;
          seen++;
          names.push(ch.name);
          if (Object.prototype.hasOwnProperty.call(ledger, d.teamId + ":" + ch.id)) known++;
          else if (rules && rules.some((r) => r.re.test(ch.name))) matched++;
          const section = validName(ch.section) ? ch.section : null;
          onChannelJoined(d.teamId, ch.id, ch.name, "catchup", section);
        }
        // Say what happened — "no rule matched" used to be silent.
        DBG(
          "catch-up: " + seen + " channel(s), " + matched + " matched a rule, " +
          known + " already in the ledger" +
          (rules && !rules.length ? " (no rules configured)" : "")
        );
        if (alreadyFiled) DBG(alreadyFiled, "already in the right section — recorded, not moved");
        if (queued) {
          DBG(
            "queued " + queued + " move(s), one every " + (MOVE_SPACING_MS / 1000) +
            "s (~" + Math.ceil((queued * MOVE_SPACING_MS) / 60000) + " min) — keep this tab open"
          );
        }
        if (deferred) {
          DBG(deferred, "channel(s) over the per-load guard — they will be picked up on the next reload");
        }
        cacheChannelNames(d.teamId, names);
        break;
      }
      case "sections": {
        if (!validTeam(d.teamId) || !Array.isArray(d.names)) return;
        onSections(d.teamId, d.names);
        break;
      }
      case "move-result": {
        if (typeof d.opId !== "string" || d.opId.length > 64) return;
        // Clamp the retry hint: a hostile or buggy value must not be able to
        // stall the queue indefinitely.
        if (d.retryAfter !== undefined) {
          const n = Number(d.retryAfter);
          d.retryAfter = Number.isFinite(n) ? Math.min(Math.max(n, 0), 300) : undefined;
        }
        onMoveResult(d);
        break;
      }
      // "init" (our own echo) and unknown kinds: ignore.
    }
  });
})();
