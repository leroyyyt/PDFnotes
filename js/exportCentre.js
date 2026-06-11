/* =============================================================================
   exportCentre.js — Advanced Export Centre (Engineering Workspace tab).

   One place to export every dataset in the workspace:
     research notes · citations · literature · formulas · safety table ·
     checklists · saved comparison reports · full project backup
   in TXT / CSV / JSON as applicable.

   Unlike the per-view export buttons (which respect the active project),
   everything here exports ALL records across every project — the per-module
   export functions are called with their `allRows` flag where they support
   project scoping.

   Exposed as window.App.ExportCentre.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { bus, util } = App;

  let rootEl = null;

  function init() {
    rootEl = document.getElementById("exp-root");
    ["notes:changed", "citations:changed", "literature:changed", "formulas:changed",
     "checklists:changed", "safety:changed", "comparisons:changed", "data:imported"]
      .forEach((ev) => bus.on(ev, () => { if (isVisible()) refresh(); }));
  }

  function isVisible() {
    const p = document.getElementById("eng-panel-export");
    return !!(p && p.classList.contains("active") && App.currentView === "engineering");
  }

  function refresh() {
    if (!rootEl) return;
    rootEl.innerHTML = "";

    const intro = document.createElement("p");
    intro.className = "tags-intro";
    intro.textContent = "Everything exported from here includes all records across every project (the per-view export buttons respect the active project instead).";
    rootEl.appendChild(intro);

    const grid = document.createElement("div");
    grid.className = "exp-grid";
    rootEl.appendChild(grid);

    grid.appendChild(row("note", "Research notes", countOf(App.Notes), [
      ["TXT", exportNotesTxt], ["CSV", exportNotesCsv],
      ["JSON", () => json("research-notes", allOf(App.Notes))],
    ]));
    grid.appendChild(row("quote", "Citations (APA 7 + IEEE)", countOf(App.Citations), [
      ["TXT", (e) => App.Citations.exportTxt(e, true)], ["CSV", exportCitationsCsv],
      ["JSON", () => json("citations", allOf(App.Citations))],
    ]));
    grid.appendChild(row("book", "Literature database", countOf(App.Literature), [
      ["TXT", exportLitTxt], ["CSV", (e) => App.Literature.exportCsv(e, true)],
      ["JSON", (e) => App.Literature.exportJson(e, true)],
    ]));
    grid.appendChild(row("sigma", "Formula library", countOf(App.Formulas), [
      ["TXT", (e) => App.Formulas.exportTxt(e, true)], ["CSV", (e) => App.Formulas.exportCsv(e, true)],
      ["JSON", (e) => App.Formulas.exportJson(e, true)],
    ]));
    grid.appendChild(row("shield", "Safety limit reference", countOf(App.Safety), [
      ["CSV", () => App.Safety.exportCsv()], ["JSON", () => App.Safety.exportJson()],
    ]));
    grid.appendChild(row("checkSquare", "Checklists", countOf(App.Checklists), [
      ["TXT", () => App.Checklists.exportTxtAll()], ["CSV", () => App.Checklists.exportCsvAll()],
      ["JSON", () => App.Checklists.exportJsonAll()],
    ]));

    // --- Saved comparison reports (listed individually) -------------------
    const h = document.createElement("h3");
    h.className = "exp-h";
    h.textContent = "Document comparison reports";
    rootEl.appendChild(h);
    const reports = App.Compare ? App.Compare.getSaved() : [];
    if (!reports.length) {
      const none = document.createElement("p");
      none.className = "tags-empty";
      none.textContent = "No saved comparison reports yet — run a comparison in the Compare tab and press “Save report”.";
      rootEl.appendChild(none);
    } else {
      const g2 = document.createElement("div");
      g2.className = "exp-grid";
      reports.forEach((r) => {
        g2.appendChild(row("compare", r.name,
          util.formatDate(r.createdAt) + " · +" + r.stats.added + " −" + r.stats.removed + " ~" + r.stats.changed, [
          ["TXT", () => util.downloadFile(slug(r.name) + ".txt", App.Compare.reportToTxt(r), "text/plain")],
          ["JSON", () => util.downloadFile(slug(r.name) + ".json", App.Compare.reportToJsonString(r), "application/json")],
          ["Delete", async () => {
            const ok = await App.confirmDialog({ title: "Delete report?", message: "“" + r.name + "” will be permanently removed.", okText: "Delete", danger: true });
            if (ok) { await App.Compare.deleteSaved(r.id); refresh(); }
          }, "danger"],
        ]));
      });
      rootEl.appendChild(g2);
    }

    // --- Full backup -------------------------------------------------------
    const h2 = document.createElement("h3");
    h2.className = "exp-h";
    h2.textContent = "Project backup";
    rootEl.appendChild(h2);
    const g3 = document.createElement("div");
    g3.className = "exp-grid";
    g3.appendChild(row("database", "Full backup — every dataset, annotations, OCR and settings (PDF bytes excluded)", "Restores via the toolbar menu", [
      ["JSON", () => App.Exporter.backupAll()],
    ]));
    rootEl.appendChild(g3);
  }

  /* ----------------------- Centre-side generators ------------------------- */
  function exportNotesTxt() {
    const rows = allOf(App.Notes);
    if (!rows.length) return App.toast("No research notes to export", "warn");
    const lines = ["ALL RESEARCH NOTES", "Exported: " + new Date().toLocaleString(), "Notes: " + rows.length, ""];
    rows.slice().sort((a, b) => (a.source || "").localeCompare(b.source || "") || (a.page || 0) - (b.page || 0))
      .forEach((n) => {
        lines.push("• [" + (n.category || "Note") + " · " + (n.importance || "medium") +
          (n.source ? " · " + n.source : "") + (n.page ? " p." + n.page : "") + "]");
        if (n.quote) lines.push('    "' + n.quote + '"');
        if (n.body) lines.push("    " + n.body.replace(/\n/g, "\n    "));
        if (n.tags && n.tags.length) lines.push("    tags: " + n.tags.join(", "));
        lines.push("");
      });
    util.downloadFile("research-notes-" + stamp() + ".txt", lines.join("\n"), "text/plain");
  }

  function exportNotesCsv() {
    const rows = allOf(App.Notes);
    if (!rows.length) return App.toast("No research notes to export", "warn");
    const head = ["category", "importance", "quote", "note", "source", "page", "tags", "created", "updated"].join(",");
    const body = rows.map((n) => [
      csv(n.category), csv(n.importance), csv(n.quote), csv(n.body), csv(n.source), csv(n.page),
      csv((n.tags || []).join("; ")), csv(iso(n.createdAt)), csv(iso(n.updatedAt)),
    ].join(",")).join("\n");
    util.downloadFile("research-notes-" + stamp() + ".csv", head + "\n" + body, "text/csv");
  }

  function exportCitationsCsv() {
    const rows = allOf(App.Citations);
    if (!rows.length) return App.toast("No citations to export", "warn");
    const head = ["authors", "year", "title", "journal", "volume", "issue", "pages", "doi", "apa", "ieee"].join(",");
    const body = rows.map((r) => [
      csv(r.authors), csv(r.year), csv(r.title), csv(r.journal), csv(r.volume), csv(r.issue), csv(r.pages), csv(r.doi),
      csv(App.Citations.formatAPA ? App.Citations.formatAPA(r) : ""),
      csv(App.Citations.formatIEEE ? App.Citations.formatIEEE(r) : ""),
    ].join(",")).join("\n");
    util.downloadFile("citations-" + stamp() + ".csv", head + "\n" + body, "text/csv");
  }

  function exportLitTxt() {
    const rows = allOf(App.Literature);
    if (!rows.length) return App.toast("No literature entries to export", "warn");
    const lines = ["LITERATURE DATABASE", "Exported: " + new Date().toLocaleString(), "Entries: " + rows.length, ""];
    rows.forEach((r) => {
      lines.push("• " + (r.title || "Untitled") + (r.year ? " (" + r.year + ")" : ""));
      if (r.authors) lines.push("    authors: " + r.authors);
      if (r.venue) lines.push("    venue: " + r.venue);
      if (r.doi) lines.push("    doi/url: " + r.doi);
      [["topic", r.topic], ["methodology", r.methodology], ["findings", r.findings],
       ["limitations", r.limitations], ["relevance", r.relevance], ["notes", r.notes]]
        .forEach((p) => { if (p[1]) lines.push("    " + p[0] + ": " + String(p[1]).replace(/\n/g, " ")); });
      if (r.tags && r.tags.length) lines.push("    tags: " + r.tags.join(", "));
      lines.push("");
    });
    util.downloadFile("literature-" + stamp() + ".txt", lines.join("\n"), "text/plain");
  }

  /* ------------------------------ Helpers --------------------------------- */
  function row(icon, name, sub, buttons) {
    const el = document.createElement("div");
    el.className = "exp-row";
    el.innerHTML =
      '<span class="exp-ico">' + App.Icons.get(icon) + "</span>" +
      '<div class="exp-name-wrap"><span class="exp-name"></span><span class="exp-sub"></span></div>' +
      '<div class="exp-fmt"></div>';
    el.querySelector(".exp-name").textContent = name;
    el.querySelector(".exp-sub").textContent = sub || "";
    const fmt = el.querySelector(".exp-fmt");
    buttons.forEach((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn tiny" + (b[2] ? " " + b[2] : "");
      btn.textContent = b[0];
      btn.addEventListener("click", b[1]);
      fmt.appendChild(btn);
    });
    return el;
  }
  function allOf(mod) { return (mod && mod.getAll) ? mod.getAll() : []; }
  function countOf(mod) {
    const n = allOf(mod).length;
    return n + (n === 1 ? " record" : " records");
  }
  function json(name, rows) {
    if (!rows.length) return App.toast("Nothing to export", "warn");
    util.downloadFile(name + "-" + stamp() + ".json", JSON.stringify(rows, null, 2), "application/json");
  }
  function csv(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function iso(ts) { return ts ? new Date(ts).toISOString() : ""; }
  function slug(s) { return (s || "export").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "export"; }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  App.ExportCentre = { init, refresh };
})();
