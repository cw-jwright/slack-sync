// Options page: edit pattern -> section rules, browse/search the move ledger.
//
// The section column is a dropdown of the workspace's existing sections.
// This page can't call Slack itself (no host permissions, no token here) —
// the content script caches section and channel names whenever a Slack tab
// is open, and we read those caches. Choosing "Create new section…" swaps
// the dropdown for a text field; the section is created in Slack the first
// time a channel actually needs it.
(() => {
  "use strict";

  const MAX_LEN = 80;
  const NEW_SECTION = " new"; // sentinel <option> value; not a legal name
  const PAGE_SIZE = 20;

  const rulesBody = document.getElementById("rules-body");
  const ledgerBody = document.getElementById("ledger-body");
  const emptyLedger = document.getElementById("empty-ledger");
  const statusEl = document.getElementById("status");
  const sectionsNote = document.getElementById("sections-note");
  const emptyRules = document.getElementById("empty-rules");
  const searchEl = document.getElementById("ledger-search");
  const countEl = document.getElementById("ledger-count");
  const pagerEl = document.getElementById("ledger-pager");
  const rangeEl = document.getElementById("ledger-range");

  let knownSections = [];
  let knownChannels = [];
  let ledgerEntries = []; // [key, entry], newest first
  let page = 0;
  let dirty = false;

  const rulesTable = document.getElementById("rules-table");
  const saveBtn = document.getElementById("save-rules");
  const unsavedEl = document.getElementById("unsaved");

  // Edits only take effect on Save, so say so rather than letting the user
  // assume the rules are already live.
  function setDirty(next) {
    dirty = next;
    unsavedEl.hidden = !dirty;
    saveBtn.disabled = !dirty;
  }

  // The rules table is meaningless with no rows — hide it so a fresh install
  // shows just the notice and the Add rule button.
  function syncRulesTable() {
    rulesTable.hidden = !rulesBody.querySelector("tr");
  }

  window.addEventListener("beforeunload", (ev) => {
    if (!dirty) return;
    ev.preventDefault();
    ev.returnValue = "";
  });

  // Must stay identical to the matcher in content/isolated.js.
  function globToRegExp(glob) {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$", "i");
  }

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.className = ok ? "ok" : "err";
    if (text) setTimeout(() => { statusEl.textContent = ""; }, 4000);
  }

  // ------------------------------------------------------------------ rules

  function fillSelect(select, current) {
    const names = knownSections.slice();
    if (current && !names.some((n) => n.toLowerCase() === current.toLowerCase())) {
      names.push(current);
    }
    select.textContent = "";
    // Placeholder first, so an untouched row carries no section and is
    // treated as blank on save rather than half-filled.
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = names.length
      ? "— choose a section —"
      : "— no sections cached —";
    select.appendChild(placeholder);
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    const newOpt = document.createElement("option");
    newOpt.value = NEW_SECTION;
    newOpt.textContent = "＋ Create new section…";
    select.appendChild(newOpt);
    select.value = current && names.includes(current) ? current : "";
  }

  function addRow(pattern, section) {
    const tr = document.createElement("tr");

    // --- pattern cell: input + live match preview -------------------------
    const tdPattern = document.createElement("td");
    const inPattern = document.createElement("input");
    inPattern.type = "text";
    inPattern.className = "pattern";
    inPattern.value = pattern || "";
    inPattern.placeholder = "incident-*";
    inPattern.maxLength = MAX_LEN;
    const preview = document.createElement("div");
    preview.className = "preview";
    tdPattern.append(inPattern, preview);

    // Patterns are anchored globs, so a bare prefix like "internal-" matches
    // only a channel named exactly that. Showing the match count against the
    // real channel list makes that obvious before saving.
    const updatePreview = () => {
      const raw = inPattern.value.trim();
      preview.textContent = "";
      preview.className = "preview";
      if (!raw) return;
      if (!knownChannels.length) {
        preview.textContent = "open a Slack tab to preview matches";
        return;
      }
      const matches = knownChannels.filter((n) => globToRegExp(raw).test(n));
      if (matches.length) {
        preview.textContent =
          "matches " + matches.length + " channel" + (matches.length === 1 ? "" : "s") +
          ": " + matches.slice(0, 3).map((n) => "#" + n).join(", ") +
          (matches.length > 3 ? ", …" : "");
        return;
      }
      preview.classList.add("warn");
      preview.textContent = "matches no current channels. ";
      if (!raw.includes("*")) {
        const suggestion = raw + "*";
        const n = knownChannels.filter((c) => globToRegExp(suggestion).test(c)).length;
        if (n) {
          const fix = document.createElement("button");
          fix.type = "button";
          fix.className = "link";
          fix.textContent = "Use " + suggestion + " (" + n + ")";
          fix.title = "Patterns are exact unless they contain *";
          fix.addEventListener("click", () => {
            inPattern.value = suggestion;
            updatePreview();
          });
          preview.append(fix);
          return;
        }
      }
      preview.append("It will still apply to channels you join later.");
    };
    inPattern.addEventListener("input", () => {
      updatePreview();
      setDirty(true);
    });
    tr.updatePreview = updatePreview;

    // --- section cell: dropdown that becomes a text field in place --------
    const tdSection = document.createElement("td");
    const cell = document.createElement("div");
    cell.className = "section-cell";

    const select = document.createElement("select");
    select.className = "section-select";
    const inNew = document.createElement("input");
    inNew.type = "text";
    inNew.className = "new-section";
    inNew.placeholder = "New section name";
    inNew.maxLength = MAX_LEN;
    const back = document.createElement("button");
    back.type = "button";
    back.className = "icon";
    back.textContent = "↩";
    back.title = "Pick an existing section instead";

    // Exactly one of {select} / {inNew + back} is in the DOM at a time.
    function showCreate(initial) {
      inNew.value = initial || "";
      select.remove();
      cell.append(inNew, back);
      inNew.focus();
    }
    function showPicker(current) {
      inNew.remove();
      back.remove();
      fillSelect(select, current || "");
      cell.prepend(select);
    }

    select.addEventListener("change", () => {
      if (select.value === NEW_SECTION) showCreate("");
      setDirty(true);
    });
    inNew.addEventListener("input", () => setDirty(true));
    back.addEventListener("click", () => {
      showPicker("");
      setDirty(true);
    });

    fillSelect(select, section || "");
    cell.append(select);
    tdSection.appendChild(cell);
    // A rule naming a section that isn't in the cache starts in the text
    // field so its value is never silently lost.
    if (section && select.value !== section) showCreate(section);

    // --- row actions ------------------------------------------------------
    const tdActions = document.createElement("td");
    tdActions.className = "row-actions";
    const mkBtn = (label, title, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icon";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", onClick);
      tdActions.appendChild(b);
    };
    mkBtn("↑", "Move up", () => {
      const prev = tr.previousElementSibling;
      if (prev) { rulesBody.insertBefore(tr, prev); setDirty(true); }
    });
    mkBtn("↓", "Move down", () => {
      const next = tr.nextElementSibling;
      if (next) { rulesBody.insertBefore(next, tr); setDirty(true); }
    });
    mkBtn("✕", "Remove", () => {
      tr.remove();
      syncRulesTable();
      setDirty(true);
    });

    tr.append(tdPattern, tdSection, tdActions);
    tr.showPicker = showPicker;
    rulesBody.appendChild(tr);
    updatePreview();
    return tr;
  }

  // Whichever control is currently mounted holds the value.
  function rowSection(tr) {
    const select = tr.querySelector(".section-select");
    const inNew = tr.querySelector(".new-section");
    if (inNew) return inNew.value.trim();
    return select && select.value !== NEW_SECTION ? select.value.trim() : "";
  }

  function collectRules() {
    const rules = [];
    let valid = true;
    for (const tr of rulesBody.querySelectorAll("tr")) {
      const inPattern = tr.querySelector(".pattern");
      const target = tr.querySelector(".new-section") || tr.querySelector(".section-select");
      const pattern = inPattern.value.trim();
      const section = rowSection(tr);
      // A wholly untouched row is a placeholder, not an error — skip it.
      if (!pattern && !section) {
        inPattern.classList.remove("invalid");
        if (target) target.classList.remove("invalid");
        continue;
      }
      const patternOk = pattern.length > 0 && pattern.length <= MAX_LEN;
      const sectionOk = section.length > 0 && section.length <= MAX_LEN;
      inPattern.classList.toggle("invalid", !patternOk);
      if (target) target.classList.toggle("invalid", !sectionOk);
      if (!patternOk || !sectionOk) {
        valid = false;
        continue;
      }
      rules.push({ pattern, section });
    }
    return valid ? rules : null;
  }

  function refreshPreviews() {
    for (const tr of rulesBody.querySelectorAll("tr")) {
      if (typeof tr.updatePreview === "function") tr.updatePreview();
    }
  }

  // Re-render dropdowns when a fresh section list arrives, preserving values.
  function refreshSelects() {
    for (const tr of rulesBody.querySelectorAll("tr")) {
      const select = tr.querySelector(".section-select");
      if (!select) continue; // row is in "create new" mode — leave it alone
      fillSelect(select, rowSection(tr));
    }
  }

  function renderEmptyRulesHint() {
    chrome.storage.local.get(["rules"], (data) => {
      emptyRules.hidden = Array.isArray(data.rules) && data.rules.length > 0;
    });
  }

  function renderSectionsNote(cache) {
    if (!cache || !Array.isArray(cache.names) || !cache.names.length) {
      sectionsNote.textContent =
        "No sections cached yet — open a Slack tab and reload this page to " +
        "populate the dropdown. Until then, use “Create new section…”.";
      return;
    }
    sectionsNote.textContent =
      cache.names.length + " section(s) from your workspace, last read " +
      (cache.ts ? new Date(cache.ts).toLocaleString() : "recently") + ".";
  }

  document.getElementById("add-rule").addEventListener("click", () => {
    const tr = addRow("", "");
    syncRulesTable();
    setDirty(true);
    tr.querySelector(".pattern").focus();
  });

  saveBtn.addEventListener("click", () => {
    const rules = collectRules();
    if (rules === null) {
      setStatus("Fix the highlighted fields first.", false);
      return;
    }
    chrome.storage.local.set({ rules }, () => {
      setStatus(
        rules.length
          ? "Saved — active immediately in open Slack tabs."
          : "Saved. No rules, so no channels will be moved.",
        true
      );
      setDirty(false);
      renderEmptyRulesHint();
    });
  });

  // ----------------------------------------------------------------- ledger

  function filteredEntries() {
    const q = searchEl.value.trim().toLowerCase();
    if (!q) return ledgerEntries;
    return ledgerEntries.filter(([key, e]) =>
      (e.name || "").toLowerCase().includes(q) ||
      (e.section || "").toLowerCase().includes(q) ||
      key.toLowerCase().includes(q)
    );
  }

  function renderLedgerPage() {
    const entries = filteredEntries();
    const total = entries.length;
    const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
    if (page > maxPage) page = maxPage;
    const start = page * PAGE_SIZE;
    const slice = entries.slice(start, start + PAGE_SIZE);

    ledgerBody.textContent = "";
    for (const [, e] of slice) {
      const tr = document.createElement("tr");
      const cells = [
        "#" + (e.name || "?"),
        e.section || "?",
        (e.status || "?") + (e.stage && e.status !== "done" ? " (" + e.stage + ")" : "") +
          (e.stage === "already-filed" ? " (already there)" : ""),
        e.ts ? new Date(e.ts).toLocaleString() : "",
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (i === 2) td.className = "status-" + (e.status || "unknown");
        tr.appendChild(td);
      });
      ledgerBody.appendChild(tr);
    }

    const searching = searchEl.value.trim().length > 0;
    emptyLedger.hidden = total > 0;
    emptyLedger.textContent = searching
      ? "No channels in the history match that search."
      : "No moves recorded yet.";
    countEl.textContent = ledgerEntries.length
      ? (searching ? total + " of " + ledgerEntries.length + " entries" : ledgerEntries.length + " entries")
      : "";
    pagerEl.hidden = total <= PAGE_SIZE;
    rangeEl.textContent = total
      ? (start + 1) + "–" + Math.min(start + PAGE_SIZE, total) + " of " + total
      : "";
    document.getElementById("ledger-prev").disabled = page <= 0;
    document.getElementById("ledger-next").disabled = page >= maxPage;
  }

  function loadLedger(ledger) {
    ledgerEntries = Object.entries(ledger || {}).sort(
      (a, b) => (b[1].ts || 0) - (a[1].ts || 0)
    );
    renderLedgerPage();
  }

  searchEl.addEventListener("input", () => { page = 0; renderLedgerPage(); });
  document.getElementById("ledger-prev").addEventListener("click", () => {
    if (page > 0) { page--; renderLedgerPage(); }
  });
  document.getElementById("ledger-next").addEventListener("click", () => {
    page++; renderLedgerPage();
  });

  document.getElementById("clear-ledger").addEventListener("click", () => {
    if (!confirm("Forget all move history? Matching channels may be re-filed on the next Slack reload.")) return;
    chrome.storage.local.set({ ledger: {} }, () => {
      page = 0;
      loadLedger({});
      setStatus("Move history cleared.", true);
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.ledger) loadLedger(changes.ledger.newValue);
    if (changes.knownSections) {
      const cache = changes.knownSections.newValue;
      knownSections = (cache && cache.names) || [];
      refreshSelects();
      renderSectionsNote(cache);
    }
    if (changes.knownChannels) {
      const cache = changes.knownChannels.newValue;
      knownChannels = (cache && cache.names) || [];
      refreshPreviews();
    }
  });

  // ------------------------------------------------------------------- init

  chrome.storage.local.get(
    ["rules", "ledger", "knownSections", "knownChannels"],
    (data) => {
      knownSections = (data.knownSections && data.knownSections.names) || [];
      knownChannels = (data.knownChannels && data.knownChannels.names) || [];
      renderSectionsNote(data.knownSections);

      // No rules ship by default, and no blank row is conjured either — a
      // fresh install shows the notice and an Add rule button, nothing more.
      const rules = Array.isArray(data.rules) ? data.rules : [];
      for (const r of rules) {
        if (r && typeof r.pattern === "string" && typeof r.section === "string") {
          addRow(r.pattern, r.section);
        }
      }
      syncRulesTable();
      setDirty(false);
      renderEmptyRulesHint();
      loadLedger(data.ledger);

      // Nudge any open Slack tab to re-read its section list.
      chrome.storage.local.set({ sectionsRequestedAt: Date.now() });
    }
  );
})();
