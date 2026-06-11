/* =============================================================================
   citations.js — Citation Manager (APA 7 + IEEE).

   Record shape:
     { id, projectId, authors, year, title, journal, volume, issue, pages,
       doi, style, createdAt, updatedAt }

   Generates formatted references from structured fields, lets the user copy or
   save them, and exports all citations as a numbered TXT file.
   Exposed as window.App.Citations.

   Author input: separate multiple authors with semicolons. Each author may be
   written "Last, First M." or "First M. Last".
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { bus, util } = App;

  let cache = [];
  let editingId = null;
  let listEl, countEl, projEl, styleEl, apaOut, ieeeOut;
  const F = {};   // field elements keyed by name

  const FIELDS = ["authors", "year", "title", "journal", "volume", "issue", "pages", "doi"];

  function init() {
    listEl = document.getElementById("cite-list");
    countEl = document.getElementById("cite-count");
    projEl = document.getElementById("cite-project");
    styleEl = document.getElementById("cite-style");
    apaOut = document.getElementById("cite-apa");
    ieeeOut = document.getElementById("cite-ieee");
    FIELDS.forEach((f) => { F[f] = document.getElementById("cite-" + f); });

    FIELDS.forEach((f) => F[f] && F[f].addEventListener("input", livePreview));
    document.getElementById("cite-save").addEventListener("click", saveCurrent);
    document.getElementById("cite-clear").addEventListener("click", () => { clearForm(); livePreview(); });
    document.getElementById("cite-copy-apa").addEventListener("click", () => copy(apaOut.textContent));
    document.getElementById("cite-copy-ieee").addEventListener("click", () => copy(ieeeOut.textContent));
    document.getElementById("cite-export-txt").addEventListener("click", exportTxt);
    if (projEl) projEl.addEventListener("input", render);

    bus.on("projects:changed", () => { refreshProjectFilter(); render(); });
    load();
    livePreview();
  }

  /* --------------------------- Author parsing ---------------------------- */
  function parseAuthors(str) {
    if (!str) return [];
    let parts = str.split(";");
    if (parts.length === 1) parts = str.split(/\s+and\s+|\s*&\s*/i);
    return parts.map((s) => s.trim()).filter(Boolean).map((a) => {
      let last, given;
      if (a.indexOf(",") !== -1) {
        const seg = a.split(",");
        last = seg[0].trim();
        given = (seg[1] || "").trim();
      } else {
        const tok = a.split(/\s+/);
        last = tok.pop();
        given = tok.join(" ");
      }
      const initials = given.split(/[\s.]+/).filter(Boolean).map((g) => g[0].toUpperCase() + ".");
      return { last, initials, given };
    });
  }
  function apaName(a) { return a.last + (a.initials.length ? ", " + a.initials.join(" ") : ""); }
  function ieeeName(a) { return (a.initials.length ? a.initials.join(" ") + " " : "") + a.last; }

  function apaAuthors(list) {
    if (!list.length) return "";
    const n = list.map(apaName);
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[0] + ", & " + n[1];
    if (n.length <= 20) return n.slice(0, -1).join(", ") + ", & " + n[n.length - 1];
    return n.slice(0, 19).join(", ") + ", … " + n[n.length - 1];
  }
  function ieeeAuthors(list) {
    if (!list.length) return "";
    const n = list.map(ieeeName);
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[0] + " and " + n[1];
    return n.slice(0, -1).join(", ") + ", and " + n[n.length - 1];
  }

  function doiInfo(s) {
    s = (s || "").trim();
    if (!s) return { doi: "", url: "" };
    const bare = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
    if (/^10\.\d{3,}\//.test(bare)) return { doi: bare, url: "" };
    if (/^https?:\/\//i.test(s)) return { doi: "", url: s };
    return { doi: bare, url: "" };
  }

  /* ----------------------------- Formatting ------------------------------ */
  function gather() {
    const o = {};
    FIELDS.forEach((f) => { o[f] = F[f] ? F[f].value.trim() : ""; });
    return o;
  }

  function formatAPA(d) {
    const authors = apaAuthors(parseAuthors(d.authors));
    let s = "";
    if (authors) s += authors + " ";
    s += "(" + (d.year || "n.d.") + "). ";
    if (d.title) s += stripDot(d.title) + ". ";
    const tail = [];
    if (d.journal) tail.push(d.journal);
    let vp = "";
    if (d.volume) vp += d.volume;
    if (d.issue) vp += "(" + d.issue + ")";
    if (vp) tail.push(vp);
    if (d.pages) tail.push(d.pages);
    if (tail.length) s += tail.join(", ") + ".";
    const { doi, url } = doiInfo(d.doi);
    if (doi) s += " https://doi.org/" + doi;
    else if (url) s += " " + url;
    return s.trim();
  }

  function formatIEEE(d) {
    const authors = ieeeAuthors(parseAuthors(d.authors));
    let s = "";
    if (authors) s += authors + ", ";
    if (d.title) s += '"' + stripDot(d.title) + ',"';
    const seg = [];
    if (d.journal) seg.push(" " + d.journal);
    if (d.volume) seg.push("vol. " + d.volume);
    if (d.issue) seg.push("no. " + d.issue);
    if (d.pages) seg.push("pp. " + d.pages);
    seg.push(d.year || "n.d.");
    s += seg.join(", ").replace(/^,\s*/, "") ;
    s = s.replace(/,\s*$/, "");
    s += ".";
    const { doi, url } = doiInfo(d.doi);
    if (doi) s += " doi: " + doi + ".";
    else if (url) s += " [Online]. Available: " + url;
    return s.replace(/\s+/g, " ").trim();
  }

  function livePreview() {
    const d = gather();
    const empty = FIELDS.every((f) => !d[f]);
    apaOut.textContent = empty ? "Fill in the fields to generate an APA 7 reference." : formatAPA(d);
    ieeeOut.textContent = empty ? "Fill in the fields to generate an IEEE reference." : formatIEEE(d);
    apaOut.classList.toggle("placeholder", empty);
    ieeeOut.classList.toggle("placeholder", empty);
  }

  /* ------------------------------- CRUD ---------------------------------- */
  async function load() { cache = await App.Storage.getAllCitations(); render(); }

  async function saveCurrent() {
    const d = gather();
    if (FIELDS.every((f) => !d[f])) return App.toast("Enter citation details first", "warn");
    const now = Date.now();
    let rec;
    if (editingId) {
      rec = cache.find((c) => c.id === editingId) || {};
      Object.assign(rec, d);
    } else {
      rec = Object.assign({ id: util.uid("cite"), projectId: App.activeProjectId || null, createdAt: now }, d);
    }
    rec.style = (styleEl && styleEl.value) || "apa";
    rec.updatedAt = now;
    await App.Storage.saveCitation(rec);
    const i = cache.findIndex((c) => c.id === rec.id);
    if (i === -1) cache.push(rec); else cache[i] = rec;
    editingId = null;
    document.getElementById("cite-save").textContent = "Save citation";
    clearForm(); livePreview(); render();
    bus.emit("citations:changed", {});
    App.toast("Citation saved", "ok");
  }

  async function remove(id) {
    const ok = await App.confirmDialog({ title: "Delete citation?", message: "This citation will be permanently removed.", okText: "Delete", danger: true });
    if (!ok) return;
    await App.Storage.deleteCitation(id);
    cache = cache.filter((c) => c.id !== id);
    render();
    bus.emit("citations:changed", {});
  }

  function edit(id) {
    const rec = cache.find((c) => c.id === id);
    if (!rec) return;
    editingId = id;
    FIELDS.forEach((f) => { if (F[f]) F[f].value = rec[f] || ""; });
    if (styleEl) styleEl.value = rec.style || "apa";
    document.getElementById("cite-save").textContent = "Update citation";
    livePreview();
    const form = document.getElementById("cite-form");
    if (form) form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Called by the Literature module to seed a citation from an entry.
  function createFrom(data) {
    editingId = null;
    clearForm();
    if (F.authors) F.authors.value = data.authors || "";
    if (F.year) F.year.value = data.year || "";
    if (F.title) F.title.value = data.title || "";
    if (F.journal) F.journal.value = data.journal || "";
    if (F.doi) F.doi.value = data.doi || "";
    livePreview();
  }

  /* ------------------------------ Render --------------------------------- */
  function render() {
    if (!listEl) return;
    const proj = projEl ? projEl.value : "";
    let rows = cache.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    if (proj) rows = rows.filter((r) => (proj === "__none__" ? !r.projectId : r.projectId === proj));

    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? " citation" : " citations");
    if (!rows.length) { listEl.innerHTML = empty(); return; }
    listEl.innerHTML = "";
    rows.forEach((r) => listEl.appendChild(card(r)));
  }

  function card(r) {
    const el = document.createElement("div");
    el.className = "cite-card";
    const apa = formatAPA(r), ieee = formatIEEE(r);
    el.innerHTML =
      '<div class="cite-card-head"><div class="cite-refs"></div><div class="cite-actions"></div></div>';
    const refs = el.querySelector(".cite-refs");
    refs.appendChild(refBlock("APA 7", apa));
    refs.appendChild(refBlock("IEEE", ieee));
    const actions = el.querySelector(".cite-actions");
    actions.appendChild(iconBtn("edit", "Edit", () => edit(r.id)));
    actions.appendChild(iconBtn("trash", "Delete", () => remove(r.id), "del"));
    return el;
  }
  function refBlock(label, text) {
    const d = document.createElement("div");
    d.className = "cite-ref";
    d.innerHTML = '<span class="cite-style-tag">' + label + "</span><p></p>";
    d.querySelector("p").textContent = text;
    const c = iconBtn("download", "Copy " + label, () => copy(text));
    c.classList.add("cite-copy");
    c.innerHTML = App.Icons.get("file");
    c.title = "Copy " + label + " reference";
    d.appendChild(c);
    return d;
  }

  /* ------------------------------ Export --------------------------------- */
  function exportTxt(ev, allRows) {
    let rows = cache.slice();
    if (!allRows && App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    if (!rows.length) return App.toast("No citations to export", "warn");
    const apa = rows.map((r, i) => (i + 1) + ". " + formatAPA(r)).join("\n\n");
    const ieee = rows.map((r, i) => "[" + (i + 1) + "] " + formatIEEE(r)).join("\n");
    const txt =
      "ENGINEERING PDF RESEARCH WORKSPACE — CITATIONS\nGenerated " + new Date().toLocaleString() +
      "\n\n===== APA 7 =====\n\n" + apa +
      "\n\n\n===== IEEE =====\n\n" + ieee + "\n";
    util.downloadFile("citations-" + new Date().toISOString().slice(0, 10) + ".txt", txt, "text/plain");
  }

  /* ------------------------------ Helpers -------------------------------- */
  function copy(text) {
    if (!text) return;
    const done = () => App.toast("Copied to clipboard", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { App.toast("Copy failed", "err"); }
    ta.remove();
  }
  function clearForm() { FIELDS.forEach((f) => { if (F[f]) F[f].value = ""; }); editingId = null; document.getElementById("cite-save").textContent = "Save citation"; }
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
  function stripDot(s) { return (s || "").replace(/\s*\.\s*$/, ""); }
  function esc(s) { return util.escapeHtml(s); }
  function empty() { return '<div class="empty-state">' + App.Icons.get("quote") + "<p>No saved citations yet. Fill in the form and click “Save citation”.</p></div>"; }

  App.Citations = { init, createFrom, getAll: () => cache, refreshProjectFilter, reload: load, formatAPA, formatIEEE, exportTxt };
})();
