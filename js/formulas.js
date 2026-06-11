/* =============================================================================
   formulas.js — Engineering Formula Library.

   Record shape:
     { id, name, equation, description, variables, units, category, notes,
       source, page, docId, tags[], projectId, createdAt, updatedAt }

   Features:
     • Add manually, or save selected text from a PDF as a formula
       (App.Formulas.openFromSelection — wired to the viewer selection button).
     • Search, filter by category / project (and the global active project).
     • Export the formula sheet as TXT, CSV and JSON (also reused by the
       Export Centre).

   Emits : formulas:changed
   Exposed as window.App.Formulas.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus, util } = App;

  const CATEGORIES = [
    "Fluid Mechanics", "Heat Transfer", "Thermodynamics", "Process Safety",
    "Solar PV", "Chemical Engineering", "Structural/Infrastructure",
    "Mathematics", "Other",
  ];
  const CAT_COLOR = {
    "Fluid Mechanics": "#5b9dff", "Heat Transfer": "#ff8a5b", "Thermodynamics": "#ffb020",
    "Process Safety": "#ff5f5f", "Solar PV": "#38cf90", "Chemical Engineering": "#c879ff",
    "Structural/Infrastructure": "#21c7d6", "Mathematics": "#9aa3b3", "Other": "#7b8494",
  };

  let cache = [];
  let listEl, searchEl, catEl, projEl, countEl;

  function init() {
    listEl = document.getElementById("fx-list");
    searchEl = document.getElementById("fx-search");
    catEl = document.getElementById("fx-cat");
    projEl = document.getElementById("fx-project");
    countEl = document.getElementById("fx-count");

    if (catEl) catEl.innerHTML = '<option value="">All categories</option>' +
      CATEGORIES.map((c) => '<option value="' + c + '">' + c + "</option>").join("");

    on("fx-add", () => openEditor(blank(), null));
    on("fx-export-txt", exportTxt);
    on("fx-export-csv", exportCsv);
    on("fx-export-json", exportJson);
    [searchEl, catEl, projEl].forEach((el) => el && el.addEventListener("input", render));

    bus.on("projects:changed", () => { refreshProjectFilter(); render(); });
    load();
  }

  function blank() {
    return {
      id: null, projectId: App.activeProjectId || null, docId: state.docId || null,
      name: "", equation: "", description: "", variables: "", units: "",
      category: CATEGORIES[0], notes: "",
      source: (state.docMeta && state.docMeta.name) || "", page: state.page || null,
      tags: [], createdAt: null, updatedAt: null,
    };
  }

  async function load() { cache = await App.Storage.getAllFormulas(); render(); }

  async function save(rec) {
    const now = Date.now();
    if (!rec.id) { rec.id = util.uid("fx"); rec.createdAt = now; }
    rec.updatedAt = now;
    await App.Storage.saveFormula(rec);
    const i = cache.findIndex((r) => r.id === rec.id);
    if (i === -1) cache.push(rec); else cache[i] = rec;
    render();
    bus.emit("formulas:changed", {});
    App.toast("Formula saved", "ok");
  }

  async function remove(id) {
    const ok = await App.confirmDialog({ title: "Delete formula?", message: "This formula will be permanently removed from the library.", okText: "Delete", danger: true });
    if (!ok) return;
    await App.Storage.deleteFormula(id);
    cache = cache.filter((r) => r.id !== id);
    render();
    bus.emit("formulas:changed", {});
  }

  /* ------------------------------ Render --------------------------------- */
  function render() {
    if (!listEl) return;
    const q = val(searchEl).toLowerCase();
    const cat = val(catEl);
    const proj = val(projEl);

    let rows = cache.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    if (proj) rows = rows.filter((r) => (proj === "__none__" ? !r.projectId : r.projectId === proj));
    if (cat) rows = rows.filter((r) => r.category === cat);
    if (q) rows = rows.filter((r) =>
      [r.name, r.equation, r.description, r.variables, r.units, r.notes, r.source, (r.tags || []).join(" ")]
        .join(" ").toLowerCase().indexOf(q) !== -1);

    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? " formula" : " formulas");
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty-state">' + App.Icons.get("sigma") +
        "<p>No formulas yet. Add one manually, or select an equation in a PDF and choose “Formula”.</p></div>";
      return;
    }
    listEl.innerHTML = "";
    rows.forEach((r) => listEl.appendChild(card(r)));
  }

  function card(r) {
    const el = document.createElement("div");
    el.className = "formula-card";
    const col = CAT_COLOR[r.category] || CAT_COLOR.Other;
    el.innerHTML =
      '<div class="fx-head">' +
        '<div class="fx-title-wrap">' +
          '<span class="fx-cat" style="--cat:' + col + '"></span>' +
          '<span class="fx-name"></span>' +
        "</div>" +
        '<div class="fx-actions"></div>' +
      "</div>" +
      '<div class="formula-eq mono"></div>' +
      (r.description ? '<div class="fx-desc"></div>' : "") +
      '<div class="fx-details"></div>' +
      '<div class="fx-foot">' +
        (r.tags && r.tags.length ? '<div class="note-tags">' + r.tags.map((t) => '<span class="tag-chip">' + esc(t) + "</span>").join("") + "</div>" : "<span></span>") +
        '<span class="fx-src"></span>' +
      "</div>";

    el.querySelector(".fx-cat").textContent = r.category;
    el.querySelector(".fx-name").textContent = r.name || "Untitled formula";
    el.querySelector(".formula-eq").textContent = r.equation || "—";
    if (r.description) el.querySelector(".fx-desc").textContent = r.description;

    const details = el.querySelector(".fx-details");
    [["Variables", r.variables], ["Units", r.units], ["Notes", r.notes]].filter((p) => p[1]).forEach((p) => {
      const d = document.createElement("div");
      d.className = "lit-field";
      d.innerHTML = "<b>" + p[0] + "</b><span></span>";
      d.querySelector("span").textContent = p[1];
      details.appendChild(d);
    });

    const srcBits = [r.source, r.page ? "p. " + r.page : ""].filter(Boolean).join(" · ");
    el.querySelector(".fx-src").textContent = srcBits;

    const actions = el.querySelector(".fx-actions");
    actions.appendChild(iconBtn("file", "Copy equation", () => copyEq(r)));
    if (r.docId) actions.appendChild(iconBtn("fileText", "Go to source page", () => { if (App.openDocumentById) App.openDocumentById(r.docId, r.page || 1); }));
    actions.appendChild(iconBtn("edit", "Edit", () => openEditor(Object.assign({}, r), r.id)));
    actions.appendChild(iconBtn("trash", "Delete", () => remove(r.id), "del"));
    return el;
  }

  function copyEq(r) {
    const text = r.equation || "";
    if (!text) return App.toast("No equation to copy", "warn");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => App.toast("Equation copied", "ok"), () => App.toast("Copy failed", "err"));
    } else { App.toast("Clipboard unavailable", "warn"); }
  }

  /* ------------------------------ Editor --------------------------------- */
  function openEditor(rec, id) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form wide" role="dialog" aria-modal="true">' +
      "<h3>" + (id ? "Edit formula" : "Add formula") + "</h3>" +
      '<div class="form-grid">' +
        '<label class="fld span2"><span>Formula name</span><input data-f="name" type="text" placeholder="e.g. Darcy–Weisbach pressure drop"></label>' +
        '<label class="fld span2"><span>Equation</span><textarea data-f="equation" rows="2" class="mono" placeholder="ΔP = f · (L/D) · (ρ·v²/2)"></textarea></label>' +
        '<label class="fld span2"><span>Description</span><textarea data-f="description" rows="2" placeholder="What it calculates and when to use it"></textarea></label>' +
        '<label class="fld"><span>Variables</span><textarea data-f="variables" rows="3" placeholder="f = friction factor [-]&#10;L = pipe length [m]&#10;D = diameter [m]"></textarea></label>' +
        '<label class="fld"><span>Units</span><textarea data-f="units" rows="3" placeholder="ΔP in Pa; v in m/s; ρ in kg/m³"></textarea></label>' +
        '<label class="fld"><span>Category</span><select data-f="category">' + CATEGORIES.map((c) => "<option>" + c + "</option>").join("") + "</select></label>" +
        '<label class="fld"><span>Project</span><select data-f="projectId"></select></label>' +
        '<label class="fld span2"><span>Notes</span><textarea data-f="notes" rows="2" placeholder="Assumptions, validity range, references…"></textarea></label>' +
        '<label class="fld"><span>Source PDF</span><input data-f="source" type="text"></label>' +
        '<label class="fld"><span>Page</span><input data-f="page" type="number" min="1"></label>' +
        '<label class="fld span2"><span>Tags (comma separated)</span><input data-f="tags" type="text"></label>' +
      "</div>" +
      '<div class="row">' +
        '<button class="btn has-label" data-act="cancel">Cancel</button>' +
        '<button class="btn has-label primary" data-act="save">Save formula</button>' +
      "</div></div>";

    const q = (s) => backdrop.querySelector(s);
    q('[data-f="name"]').value = rec.name || "";
    q('[data-f="equation"]').value = rec.equation || "";
    q('[data-f="description"]').value = rec.description || "";
    q('[data-f="variables"]').value = rec.variables || "";
    q('[data-f="units"]').value = rec.units || "";
    q('[data-f="category"]').value = rec.category || CATEGORIES[0];
    q('[data-f="notes"]').value = rec.notes || "";
    q('[data-f="source"]').value = rec.source || "";
    q('[data-f="page"]').value = rec.page || "";
    q('[data-f="tags"]').value = (rec.tags || []).join(", ");
    App.fillProjectSelect(q('[data-f="projectId"]'), rec.projectId);
    if (App.Tags) App.Tags.attachSuggestions(q('[data-f="tags"]'));

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    setTimeout(() => q('[data-f="name"]').focus(), 30);

    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    q('[data-act="cancel"]').addEventListener("click", close);
    q('[data-act="save"]').addEventListener("click", () => {
      rec.name = q('[data-f="name"]').value.trim();
      rec.equation = q('[data-f="equation"]').value.trim();
      if (!rec.name && !rec.equation) { App.toast("Give the formula a name or an equation", "warn"); return; }
      rec.description = q('[data-f="description"]').value.trim();
      rec.variables = q('[data-f="variables"]').value.trim();
      rec.units = q('[data-f="units"]').value.trim();
      rec.category = q('[data-f="category"]').value;
      rec.notes = q('[data-f="notes"]').value.trim();
      rec.source = q('[data-f="source"]').value.trim();
      rec.page = parseInt(q('[data-f="page"]').value, 10) || null;
      rec.tags = q('[data-f="tags"]').value.split(",").map((s) => s.trim()).filter(Boolean);
      const pv = q('[data-f="projectId"]').value;
      rec.projectId = pv === "__none__" ? null : pv;
      close(); save(rec);
      if (App.Engineering) App.Engineering.showTab("formulas");
    });
  }

  function openNew() { openEditor(blank(), null); }

  // Called from the viewer's selection button: seed a formula from selected text.
  function openFromSelection(text, page) {
    const rec = blank();
    rec.equation = (text || "").trim();
    rec.page = page || state.page || null;
    openEditor(rec, null);
  }

  /* ------------------------------ Export --------------------------------- */
  function rowsForExport(allRows) {
    let rows = cache.slice().sort((a, b) => (a.category || "").localeCompare(b.category || "") || (a.name || "").localeCompare(b.name || ""));
    if (!allRows && App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    return rows;
  }
  function exportTxt(ev, allRows) {
    const rows = rowsForExport(allRows);
    if (!rows.length) return App.toast("No formulas to export", "warn");
    const lines = ["ENGINEERING FORMULA SHEET", "Exported: " + new Date().toLocaleString(), "Formulas: " + rows.length, ""];
    let lastCat = null;
    rows.forEach((r) => {
      if (r.category !== lastCat) { lastCat = r.category; lines.push("=== " + lastCat.toUpperCase() + " ==="); lines.push(""); }
      lines.push("• " + (r.name || "Untitled"));
      if (r.equation) lines.push("    " + r.equation);
      if (r.description) lines.push("    " + r.description);
      if (r.variables) r.variables.split("\n").forEach((v) => lines.push("    var: " + v.trim()));
      if (r.units) lines.push("    units: " + r.units.replace(/\n/g, "; "));
      if (r.notes) lines.push("    notes: " + r.notes.replace(/\n/g, " "));
      const src = [r.source, r.page ? "p. " + r.page : ""].filter(Boolean).join(", ");
      if (src) lines.push("    source: " + src);
      if (r.tags && r.tags.length) lines.push("    tags: " + r.tags.join(", "));
      lines.push("");
    });
    util.downloadFile("formula-sheet-" + stamp() + ".txt", lines.join("\n"), "text/plain");
  }
  function exportCsv(ev, allRows) {
    const rows = rowsForExport(allRows);
    if (!rows.length) return App.toast("No formulas to export", "warn");
    const cols = ["name", "equation", "description", "variables", "units", "category", "notes", "source", "page", "tags"];
    const head = cols.join(",");
    const body = rows.map((r) => cols.map((c) => csvCell(c === "tags" ? (r.tags || []).join("; ") : r[c])).join(",")).join("\n");
    util.downloadFile("formula-library-" + stamp() + ".csv", head + "\n" + body, "text/csv");
  }
  function exportJson(ev, allRows) {
    const rows = rowsForExport(allRows);
    if (!rows.length) return App.toast("No formulas to export", "warn");
    util.downloadFile("formula-library-" + stamp() + ".json", JSON.stringify(rows, null, 2), "application/json");
  }

  /* ------------------------------ Helpers -------------------------------- */
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
    b.className = "ghost-icon " + (extra || ""); b.title = title; b.setAttribute("aria-label", title);
    b.innerHTML = App.Icons.get(icon);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function on(id, fn) { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); }
  function val(el) { return el ? el.value.trim() : ""; }
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function esc(s) { return util.escapeHtml(s); }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  App.Formulas = {
    init, getAll: () => cache, refreshProjectFilter, reload: load,
    openNew, openFromSelection, CATEGORIES,
    exportTxt, exportCsv, exportJson,
  };
})();
