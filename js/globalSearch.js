/* =============================================================================
   globalSearch.js — Search across every kind of content.

   Sources:
     • Research notes        (App.Notes)
     • Literature database    (App.Literature)
     • Citations              (App.Citations)
     • Figures / tables       (App.Figures)
     • OCR text               (any document that has been OCR'd)
     • PDF text               (the currently open document's text layer)

   Results are grouped by source with counts; clicking a result navigates to it
   (opens the source PDF + page, or switches to the relevant section filtered to
   the query). Exposed as window.App.GlobalSearch.

   Note: full-text PDF search covers the open document. Other PDFs are searchable
   once their text has been captured via OCR.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, util } = App;

  let inputEl, resultsEl, summaryEl;
  let docNameById = {};
  let runToken = 0;

  function init() {
    inputEl = document.getElementById("gsearch-input");
    resultsEl = document.getElementById("gsearch-results");
    summaryEl = document.getElementById("gsearch-summary");
    if (inputEl) inputEl.addEventListener("input", util.debounce(run, 250));
    App.bus.on("view:changed", (p) => { if (p && p.name === "search" && inputEl) setTimeout(() => inputEl.focus(), 50); });
  }

  async function run() {
    const q = (inputEl.value || "").trim();
    const token = ++runToken;
    if (q.length < 2) { resultsEl.innerHTML = ""; summaryEl.textContent = "Type at least two characters to search across all your research."; return; }
    summaryEl.textContent = "Searching…";

    // map docId -> name for OCR/PDF results
    const docs = await App.Storage.getAllDocs();
    if (token !== runToken) return;
    docNameById = {};
    docs.forEach((d) => { docNameById[d.id] = d.name; });

    const groups = [];
    groups.push(searchNotes(q));
    groups.push(searchLiterature(q));
    groups.push(searchCitations(q));
    groups.push(searchFigures(q));
    groups.push(searchFormulas(q));
    groups.push(searchChecklists(q));
    groups.push(searchSafety(q));
    groups.push(await searchOcr(q));
    if (token !== runToken) return;
    groups.push(await searchPdf(q));
    if (token !== runToken) return;

    const total = groups.reduce((s, g) => s + g.items.length, 0);
    summaryEl.textContent = total ? (total + " result" + (total === 1 ? "" : "s") + " for “" + q + "”") : "No results for “" + q + "”.";
    resultsEl.innerHTML = "";
    groups.filter((g) => g.items.length).forEach((g) => resultsEl.appendChild(renderGroup(g)));
  }

  /* ----------------------------- Searchers ------------------------------- */
  function searchNotes(q) {
    const ql = q.toLowerCase();
    const items = (App.Notes ? App.Notes.getAll() : []).filter((n) =>
      [n.body, n.quote, n.source, n.category, (n.tags || []).join(" ")].join(" ").toLowerCase().indexOf(ql) !== -1
    ).map((n) => ({
      title: n.body ? clip(n.body, 80) : (n.quote ? "“" + clip(n.quote, 70) + "”" : "(note)"),
      snippet: snippetOf([n.body, n.quote, (n.tags || []).join(", ")].filter(Boolean).join(" — "), q),
      meta: [n.category, n.source, n.page ? "p. " + n.page : ""].filter(Boolean).join(" · "),
      onClick: () => jumpNote(n),
    }));
    return { key: "notes", label: "Research notes", icon: "note", items };
  }

  function searchLiterature(q) {
    const ql = q.toLowerCase();
    const items = (App.Literature ? App.Literature.getAll() : []).filter((r) =>
      [r.title, r.authors, r.topic, r.venue, r.findings, r.relevance, r.methodology, r.limitations, r.notes, (r.tags || []).join(" ")]
        .join(" ").toLowerCase().indexOf(ql) !== -1
    ).map((r) => ({
      title: r.title || "Untitled entry",
      snippet: snippetOf([r.authors, r.year, r.topic, r.findings].filter(Boolean).join(" — "), q),
      meta: [r.authors, r.year, r.venue].filter(Boolean).join(" · "),
      onClick: () => gotoView("literature", "lit-search", q),
    }));
    return { key: "literature", label: "Literature database", icon: "book", items };
  }

  function searchCitations(q) {
    const ql = q.toLowerCase();
    const items = (App.Citations ? App.Citations.getAll() : []).filter((c) =>
      [c.authors, c.year, c.title, c.journal, c.doi, c.volume, c.issue, c.pages].join(" ").toLowerCase().indexOf(ql) !== -1
    ).map((c) => ({
      title: c.title || (c.authors ? c.authors : "Citation"),
      snippet: snippetOf([c.authors, c.year, c.journal].filter(Boolean).join(" — "), q),
      meta: [c.journal, c.year].filter(Boolean).join(" · "),
      onClick: () => gotoView("citations"),
    }));
    return { key: "citations", label: "Citations", icon: "quote", items };
  }

  function searchFigures(q) {
    const ql = q.toLowerCase();
    const items = (App.Figures ? App.Figures.getAll() : []).filter((f) =>
      [f.title, f.source, f.notes, (f.tags || []).join(" ")].join(" ").toLowerCase().indexOf(ql) !== -1
    ).map((f) => ({
      title: f.title || ("Untitled " + (f.kind || "figure")),
      snippet: snippetOf([f.notes, (f.tags || []).join(", ")].filter(Boolean).join(" — "), q),
      meta: [(f.kind === "table" ? "Table" : "Figure"), f.source, f.page ? "p. " + f.page : ""].filter(Boolean).join(" · "),
      onClick: () => gotoView("figures", "fig-search", q),
    }));
    return { key: "figures", label: "Figures & tables", icon: "image", items };
  }

  function searchFormulas(q) {
    const ql = q.toLowerCase();
    const items = (App.Formulas ? App.Formulas.getAll() : []).filter((f) =>
      [f.name, f.equation, f.description, f.variables, f.units, f.notes, f.category, (f.tags || []).join(" ")]
        .join(" ").toLowerCase().indexOf(ql) !== -1
    ).map((f) => ({
      title: f.name || clip(f.equation || "(formula)", 70),
      snippet: snippetOf([f.equation, f.description].filter(Boolean).join(" — "), q),
      meta: [f.category, f.source, f.page ? "p. " + f.page : ""].filter(Boolean).join(" · "),
      onClick: () => engTab("formulas", "fx-search", q),
    }));
    return { key: "formulas", label: "Formulas", icon: "sigma", items };
  }

  function searchChecklists(q) {
    const ql = q.toLowerCase();
    const items = [];
    (App.Checklists ? App.Checklists.getAll() : []).forEach((c) => {
      const nameHit = (c.name || "").toLowerCase().indexOf(ql) !== -1;
      const hits = (c.items || []).filter((it) => (it.text || "").toLowerCase().indexOf(ql) !== -1);
      if (!nameHit && !hits.length) return;
      items.push({
        title: c.name,
        snippet: snippetOf(hits.length ? hits.map((h) => h.text).join(" · ") : c.name, q),
        meta: [c.category, ((c.items || []).filter((i) => i.done).length) + "/" + (c.items || []).length + " done"].filter(Boolean).join(" · "),
        onClick: () => { engTab("checklists"); if (App.Checklists.select) App.Checklists.select(c.id); },
      });
    });
    return { key: "checklists", label: "Checklists", icon: "checkSquare", items };
  }

  function searchSafety(q) {
    const ql = q.toLowerCase();
    const items = (App.Safety ? App.Safety.getAll() : []).filter((r) =>
      [r.substance, r.limitType, r.value, r.unit, r.source, r.notes].join(" ").toLowerCase().indexOf(ql) !== -1
    ).map((r) => ({
      title: r.substance + " — " + r.limitType,
      snippet: snippetOf([r.value + " " + r.unit, r.notes].filter(Boolean).join(" — "), q),
      meta: r.source || "",
      onClick: () => engTab("safety", "saf-search", q),
    }));
    return { key: "safety", label: "Safety limits", icon: "shield", items };
  }

  function engTab(tab, searchId, q) {
    if (App.Engineering) App.Engineering.showTab(tab);
    if (searchId && q != null) {
      const el = document.getElementById(searchId);
      if (el) { el.value = q; el.dispatchEvent(new Event("input", { bubbles: true })); }
    }
  }

  async function searchOcr(q) {
    const ql = q.toLowerCase();
    const recs = await App.Storage.getAll("ocr");
    const items = [];
    recs.forEach((rec) => {
      if (!rec.pages) return;
      Object.keys(rec.pages).forEach((pg) => {
        const text = rec.pages[pg] || "";
        if (text.toLowerCase().indexOf(ql) !== -1) {
          items.push({
            title: snippetOf(text, q) || ("Match on page " + pg),
            snippet: "",
            meta: (docNameById[rec.docId] || "Document") + " · p. " + pg + " · OCR",
            onClick: () => { if (App.openDocumentById) App.openDocumentById(rec.docId, +pg); },
          });
        }
      });
    });
    return { key: "ocr", label: "OCR text", icon: "scan", items };
  }

  async function searchPdf(q) {
    const items = [];
    if (state.pdfDoc && state.docId) {
      const ql = q.toLowerCase();
      for (let p = 1; p <= state.totalPages; p++) {
        let tc;
        try { tc = await App.Viewer.getPageText(p); } catch (e) { continue; }
        const pageText = tc.items.map((it) => it.str).join(" ");
        if (pageText.toLowerCase().indexOf(ql) !== -1) {
          items.push({
            title: snippetOf(pageText, q),
            snippet: "",
            meta: (state.docMeta && state.docMeta.name ? state.docMeta.name : "Open PDF") + " · p. " + p,
            onClick: () => { App.switchView("reader"); App.Viewer.goToPage(p); App.Search.open(); if (document.getElementById("search-input")) { document.getElementById("search-input").value = q; App.Search.run(); } },
          });
        }
      }
    }
    return { key: "pdf", label: "PDF text (open document)", icon: "fileText", items };
  }

  /* ------------------------------ Render --------------------------------- */
  function renderGroup(g) {
    const sec = document.createElement("section");
    sec.className = "gs-group";
    sec.innerHTML = '<div class="gs-group-head">' + App.Icons.get(g.icon) +
      "<span>" + g.label + "</span><span class=\"gs-group-count\">" + g.items.length + "</span></div>";
    const list = document.createElement("div");
    list.className = "gs-items";
    g.items.slice(0, 50).forEach((it) => {
      const row = document.createElement("button");
      row.className = "gs-item";
      row.innerHTML = '<div class="gs-item-title"></div>' +
        (it.snippet ? '<div class="gs-item-snippet"></div>' : "") +
        '<div class="gs-item-meta"></div>';
      row.querySelector(".gs-item-title").innerHTML = it.title; // title may carry <mark>
      if (it.snippet) row.querySelector(".gs-item-snippet").innerHTML = it.snippet;
      row.querySelector(".gs-item-meta").textContent = it.meta || "";
      row.addEventListener("click", it.onClick);
      list.appendChild(row);
    });
    if (g.items.length > 50) {
      const more = document.createElement("div"); more.className = "gs-more";
      more.textContent = "+" + (g.items.length - 50) + " more…";
      list.appendChild(more);
    }
    sec.appendChild(list);
    return sec;
  }

  /* --------------------------- Navigation -------------------------------- */
  function jumpNote(n) {
    if (n.docId && App.openDocumentById) App.openDocumentById(n.docId, n.page);
    else { App.switchView("notes"); }
  }
  function gotoView(name, searchId, q) {
    App.switchView(name);
    if (searchId && q) {
      const el = document.getElementById(searchId);
      if (el) { el.value = q; el.dispatchEvent(new Event("input", { bubbles: true })); }
    }
  }

  /* ------------------------------ Helpers -------------------------------- */
  function snippetOf(text, q) {
    if (!text) return "";
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return esc(clip(text, 140));
    const start = Math.max(0, i - 50);
    const end = Math.min(text.length, i + q.length + 80);
    const pre = (start > 0 ? "…" : "") + text.slice(start, i);
    const hit = text.slice(i, i + q.length);
    const post = text.slice(i + q.length, end) + (end < text.length ? "…" : "");
    return esc(pre) + "<mark>" + esc(hit) + "</mark>" + esc(post);
  }
  function clip(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function esc(s) { return util.escapeHtml(s); }

  App.GlobalSearch = { init, run };
})();
