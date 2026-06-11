/* =============================================================================
   literature.js — Literature Review database.

   Entry shape:
     { id, projectId, title, authors, year, venue, doi, topic, methodology,
       findings, limitations, relevance, notes, tags[], createdAt, updatedAt }

   Features: add / edit / delete, full-text search, filter by tag / year /
   project, export to CSV and JSON, and a one-click bridge to the Citation
   manager. Exposed as window.App.Literature.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { bus, util } = App;

  let cache = [];
  let listEl, searchEl, tagEl, yearEl, projEl, countEl;

  const FIELDS = [
    ["title", "Paper title", "text"],
    ["authors", "Authors", "text"],
    ["year", "Year", "text"],
    ["venue", "Journal / Conference", "text"],
    ["doi", "DOI / URL", "text"],
    ["topic", "Research topic", "text"],
    ["methodology", "Methodology", "area"],
    ["findings", "Key findings", "area"],
    ["limitations", "Limitations", "area"],
    ["relevance", "Relevance to my work", "area"],
    ["notes", "Personal notes", "area"],
    ["tags", "Tags (comma separated)", "text"],
  ];

  function init() {
    listEl = document.getElementById("lit-list");
    searchEl = document.getElementById("lit-search");
    tagEl = document.getElementById("lit-tag");
    yearEl = document.getElementById("lit-year");
    projEl = document.getElementById("lit-project");
    countEl = document.getElementById("lit-count");

    document.getElementById("lit-add").addEventListener("click", () => openEditor(blank()));
    document.getElementById("lit-export-csv").addEventListener("click", () => exportCsv());
    document.getElementById("lit-export-json").addEventListener("click", () => exportJson());
    [searchEl, tagEl, yearEl, projEl].forEach((el) => el && el.addEventListener("input", render));

    bus.on("projects:changed", () => { refreshProjectFilter(); render(); });
    load();
  }

  function blank() {
    return {
      id: null, projectId: App.activeProjectId || null,
      title: "", authors: "", year: "", venue: "", doi: "", topic: "",
      methodology: "", findings: "", limitations: "", relevance: "", notes: "",
      tags: [], createdAt: null, updatedAt: null,
    };
  }

  async function load() { cache = await App.Storage.getAllLiterature(); refreshYearFilter(); render(); }

  async function save(rec) {
    const now = Date.now();
    if (!rec.id) { rec.id = util.uid("lit"); rec.createdAt = now; }
    rec.updatedAt = now;
    await App.Storage.saveLiterature(rec);
    const i = cache.findIndex((r) => r.id === rec.id);
    if (i === -1) cache.push(rec); else cache[i] = rec;
    refreshYearFilter(); render();
    bus.emit("literature:changed", {});
    App.toast("Literature entry saved", "ok");
  }

  async function remove(id) {
    const ok = await App.confirmDialog({ title: "Delete entry?", message: "This literature entry will be permanently removed.", okText: "Delete", danger: true });
    if (!ok) return;
    await App.Storage.deleteLiterature(id);
    cache = cache.filter((r) => r.id !== id);
    refreshYearFilter(); render();
    bus.emit("literature:changed", {});
  }

  /* ------------------------------ Render --------------------------------- */
  function render() {
    if (!listEl) return;
    const q = val(searchEl).toLowerCase();
    const tag = val(tagEl).toLowerCase();
    const yr = val(yearEl);
    const proj = val(projEl);

    let rows = cache.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    if (proj) rows = rows.filter((r) => (proj === "__none__" ? !r.projectId : r.projectId === proj));
    if (yr) rows = rows.filter((r) => String(r.year) === yr);
    if (tag) rows = rows.filter((r) => (r.tags || []).some((t) => t.toLowerCase().indexOf(tag) !== -1));
    if (q) rows = rows.filter((r) => matchText(r, q));

    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? " entry" : " entries");
    if (!rows.length) { listEl.innerHTML = empty(); return; }
    listEl.innerHTML = "";
    rows.forEach((r) => listEl.appendChild(card(r)));
  }

  function matchText(r, q) {
    return [r.title, r.authors, r.topic, r.venue, r.findings, r.relevance, r.methodology, r.limitations, r.notes, (r.tags || []).join(" ")]
      .join(" ").toLowerCase().indexOf(q) !== -1;
  }

  function card(r) {
    const el = document.createElement("div");
    el.className = "lit-card";
    const authors = r.authors ? esc(r.authors) : "Unknown authors";
    const sub = [authors, r.year, r.venue].filter(Boolean).map(esc).join(" · ");

    el.innerHTML =
      '<div class="lit-head">' +
        '<div class="lit-title-wrap">' +
          '<div class="lit-title">' + (esc(r.title) || "Untitled") + "</div>" +
          '<div class="lit-sub">' + sub + "</div>" +
        "</div>" +
        '<div class="lit-actions"></div>' +
      "</div>" +
      (r.topic ? '<div class="lit-topic">' + App.Icons.get("tag") + "<span>" + esc(r.topic) + "</span></div>" : "") +
      '<div class="lit-details"></div>' +
      (r.tags && r.tags.length ? '<div class="note-tags">' + r.tags.map((t) => '<span class="tag-chip">' + esc(t) + "</span>").join("") + "</div>" : "");

    const details = el.querySelector(".lit-details");
    [["Methodology", r.methodology], ["Key findings", r.findings], ["Limitations", r.limitations], ["Relevance", r.relevance], ["Notes", r.notes]]
      .filter((p) => p[1])
      .forEach((p) => {
        const d = document.createElement("div"); d.className = "lit-field";
        d.innerHTML = "<b>" + p[0] + "</b><span>" + esc(p[1]) + "</span>";
        details.appendChild(d);
      });
    if (r.doi) {
      const d = document.createElement("div"); d.className = "lit-field";
      d.innerHTML = "<b>DOI / URL</b><span>" + linkify(r.doi) + "</span>";
      details.appendChild(d);
    }

    const actions = el.querySelector(".lit-actions");
    actions.appendChild(iconBtn("quote", "Create citation", () => toCitation(r)));
    actions.appendChild(iconBtn("edit", "Edit", () => openEditor(Object.assign({}, r))));
    actions.appendChild(iconBtn("trash", "Delete", () => remove(r.id), "del"));
    return el;
  }

  /* ------------------------------ Editor --------------------------------- */
  function openEditor(rec) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const fieldsHtml = FIELDS.map((f) => {
      const v = f[0] === "tags" ? (rec.tags || []).join(", ") : (rec[f[0]] || "");
      if (f[2] === "area") return '<label class="fld span2"><span>' + f[1] + '</span><textarea data-f="' + f[0] + '" rows="2"></textarea></label>';
      return '<label class="fld"><span>' + f[1] + '</span><input data-f="' + f[0] + '" type="text"></label>';
    }).join("");

    backdrop.innerHTML =
      '<div class="modal modal-form wide" role="dialog" aria-modal="true">' +
      "<h3>" + (rec.id ? "Edit literature entry" : "Add literature entry") + "</h3>" +
      '<div class="form-grid lit-grid">' + fieldsHtml +
        '<label class="fld"><span>Project</span><select data-f="projectId"></select></label>' +
      "</div>" +
      '<div class="row">' +
        '<button class="btn has-label" data-act="cancel">Cancel</button>' +
        '<button class="btn has-label primary" data-act="save">Save entry</button>' +
      "</div></div>";

    FIELDS.forEach((f) => {
      const node = backdrop.querySelector('[data-f="' + f[0] + '"]');
      node.value = f[0] === "tags" ? (rec.tags || []).join(", ") : (rec[f[0]] || "");
    });
    App.fillProjectSelect(backdrop.querySelector('[data-f="projectId"]'), rec.projectId);
    if (App.Tags) App.Tags.attachSuggestions(backdrop.querySelector('[data-f="tags"]'));

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    setTimeout(() => backdrop.querySelector('[data-f="title"]').focus(), 30);

    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
    backdrop.querySelector('[data-act="save"]').addEventListener("click", () => {
      FIELDS.forEach((f) => {
        const node = backdrop.querySelector('[data-f="' + f[0] + '"]');
        if (f[0] === "tags") rec.tags = node.value.split(",").map((s) => s.trim()).filter(Boolean);
        else rec[f[0]] = node.value.trim();
      });
      const pv = backdrop.querySelector('[data-f="projectId"]').value;
      rec.projectId = pv === "__none__" ? null : pv;
      close(); save(rec);
    });
  }

  function toCitation(r) {
    if (App.Citations && App.Citations.createFrom) {
      App.Citations.createFrom({
        authors: r.authors, year: r.year, title: r.title,
        journal: r.venue, doi: r.doi, projectId: r.projectId,
      });
      App.switchView("citations");
      App.toast("Draft citation created from entry", "ok");
    }
  }

  /* ------------------------------ Export --------------------------------- */
  function currentRows(allRows) {
    // export respects the active project but not the transient text filters;
    // the Export Centre passes allRows=true to export everything.
    let rows = cache.slice();
    if (!allRows && App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    return rows;
  }
  function exportJson(ev, allRows) {
    const rows = currentRows(allRows);
    if (!rows.length) return App.toast("Nothing to export", "warn");
    util.downloadFile("literature-" + stamp() + ".json", JSON.stringify(rows, null, 2), "application/json");
  }
  function exportCsv(ev, allRows) {
    const rows = currentRows(allRows);
    if (!rows.length) return App.toast("Nothing to export", "warn");
    const cols = ["title", "authors", "year", "venue", "doi", "topic", "methodology", "findings", "limitations", "relevance", "notes", "tags"];
    const head = cols.join(",");
    const body = rows.map((r) => cols.map((c) => csvCell(c === "tags" ? (r.tags || []).join("; ") : r[c])).join(",")).join("\n");
    util.downloadFile("literature-" + stamp() + ".csv", head + "\n" + body, "text/csv");
  }

  /* ------------------------------ Helpers -------------------------------- */
  function refreshYearFilter() {
    if (!yearEl) return;
    const cur = yearEl.value;
    const years = Array.from(new Set(cache.map((r) => String(r.year)).filter((y) => y && y !== "undefined"))).sort().reverse();
    yearEl.innerHTML = '<option value="">All years</option>' + years.map((y) => '<option value="' + esc(y) + '">' + esc(y) + "</option>").join("");
    yearEl.value = cur;
  }
  function refreshProjectFilter() {
    if (!projEl) return;
    const cur = projEl.value;
    const projects = (App.getProjects && App.getProjects()) || [];
    projEl.innerHTML = '<option value="">All projects</option><option value="__none__">Unfiled</option>' +
      projects.map((p) => '<option value="' + p.id + '">' + esc(p.name) + "</option>").join("");
    projEl.value = cur;
  }

  function iconBtn(icon, title, fn, extra) {
    const b = document.createElement("button");
    b.className = "ghost-icon " + (extra || ""); b.title = title; b.innerHTML = App.Icons.get(icon);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function linkify(s) { const u = esc(s); return /^https?:\/\//i.test(s) ? '<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>" : u; }
  function val(el) { return el ? el.value.trim() : ""; }
  function empty() { return '<div class="empty-state">' + App.Icons.get("book") + "<p>No literature entries yet. Click “Add entry” to start building your review.</p></div>"; }
  function esc(s) { return util.escapeHtml(s); }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  App.Literature = { init, getAll: () => cache, refreshProjectFilter, reload: load, exportCsv, exportJson };
})();
