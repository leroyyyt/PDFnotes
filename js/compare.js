/* =============================================================================
   compare.js — PDF Document Comparison.

   Two library PDFs render side by side (independent PDF.js instances, separate
   from the main Reader). "Compare text" extracts every page's text from both
   documents (reconstructing lines from text-item positions; pages with no
   extractable text fall back to stored OCR results), diffs them with App.Diff
   and renders added / removed / changed lines with word-level marks.

   • Only-changes view with 2 context lines and expandable "⋯ N unchanged" gaps
     (full view is capped at ~4000 rendered rows to keep the DOM responsive).
   • Click a diff row to jump the panes to that page.
   • Export the report as TXT / JSON; save reports locally (comparisons store)
     and re-open them later without the PDFs.

   Emits : comparisons:changed
   Exposed as window.App.Compare.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { bus, util } = App;

  const ROW_CAP = 4000;

  const st = {
    a: { docId: null, pdf: null, page: 1, total: 0 },
    b: { docId: null, pdf: null, page: 1, total: 0 },
    linked: false,
    running: false,
    report: null,          // {a:{id,name,pages}, b:{…}, createdAt, stats, blocks, capped}
    expanded: new Set(),   // indexes of expanded "same" blocks
    saved: [],
  };

  function init() {
    ["a", "b"].forEach((side) => {
      const s = sel(side);
      if (s) s.addEventListener("change", () => loadSide(side, s.value));
      on("cmp-prev-" + side, () => nav(side, -1));
      on("cmp-next-" + side, () => nav(side, +1));
      const pg = el("cmp-page-" + side);
      if (pg) pg.addEventListener("change", () => {
        const sd = st[side];
        const p = clamp(parseInt(pg.value, 10) || 1, 1, sd.total || 1);
        sd.page = p; pg.value = p; renderSide(side);
      });
    });
    const link = el("cmp-link");
    if (link) link.addEventListener("change", (e) => { st.linked = e.target.checked; });
    on("cmp-run", runCompare);
    const oc = el("cmp-only-changes");
    if (oc) oc.addEventListener("change", () => renderDiff());
    on("cmp-export-txt", () => { if (guardReport()) util.downloadFile(slug(reportName(st.report)) + ".txt", reportToTxt(st.report), "text/plain"); });
    on("cmp-export-json", () => { if (guardReport()) util.downloadFile(slug(reportName(st.report)) + ".json", reportToJsonString(st.report), "application/json"); });
    on("cmp-save", saveReport);
    bus.on("documents:changed", refreshSelects);
    bus.on("documents:reload", refreshSelects);
    loadSaved();
  }

  function onShow() { refreshSelects(); renderSide("a"); renderSide("b"); }

  /* ---------------------------- Doc loading ------------------------------- */
  function refreshSelects() {
    const docs = App.getDocuments ? App.getDocuments() : [];
    ["a", "b"].forEach((side) => {
      const s = sel(side);
      if (!s) return;
      const cur = st[side].docId || "";
      s.innerHTML = '<option value="">Choose PDF…</option>' +
        docs.map((d) => '<option value="' + d.id + '">' + esc(d.name) + "</option>").join("");
      s.value = cur;
      if (cur && s.value !== cur) { // document was deleted
        st[side] = { docId: null, pdf: null, page: 1, total: 0 };
        updateNav(side); clearCanvas(side);
      }
    });
  }

  async function loadSide(side, docId) {
    const s = st[side];
    if (s.pdf && s.pdf.destroy) { try { s.pdf.destroy(); } catch (e) { /* noop */ } }
    s.pdf = null; s.docId = null; s.total = 0; s.page = 1;
    updateNav(side); clearCanvas(side);
    if (!docId) return;
    const rec = await App.Storage.getFile(docId);
    if (!rec || !rec.data) {
      App.toast("Stored PDF bytes not found — open this document once in the Reader first", "warn");
      const sl = sel(side); if (sl) sl.value = "";
      return;
    }
    try {
      const task = pdfjsLib.getDocument({ data: new Uint8Array(rec.data), isEvalSupported: false });
      const pdf = await task.promise;
      s.pdf = pdf; s.docId = docId; s.total = pdf.numPages || 0; s.page = 1;
      updateNav(side);
      renderSide(side);
    } catch (err) {
      console.error("compare load failed", err);
      App.toast("Could not open that PDF for comparison", "err");
    }
  }

  function nav(side, delta) {
    if (st.linked) { step("a", delta); step("b", delta); }
    else step(side, delta);
  }
  function step(side, delta) {
    const s = st[side];
    if (!s.pdf) return;
    const p = clamp(s.page + delta, 1, s.total);
    if (p === s.page) return;
    s.page = p;
    const pg = el("cmp-page-" + side); if (pg) pg.value = p;
    renderSide(side);
  }
  function goTo(side, page) {
    const s = st[side];
    if (!s.pdf) return;
    s.page = clamp(page, 1, s.total);
    const pg = el("cmp-page-" + side); if (pg) pg.value = s.page;
    renderSide(side);
  }

  function updateNav(side) {
    const s = st[side];
    const pg = el("cmp-page-" + side);
    const tot = el("cmp-total-" + side);
    if (pg) { pg.value = s.page; pg.disabled = !s.pdf; pg.max = s.total || 1; }
    if (tot) tot.textContent = s.total ? "/ " + s.total : "/ —";
    ["cmp-prev-" + side, "cmp-next-" + side].forEach((id) => { const b = el(id); if (b) b.disabled = !s.pdf; });
  }
  function clearCanvas(side) {
    const c = el("cmp-canvas-" + side);
    if (c) { c.width = c.width || 1; const ctx = c.getContext && c.getContext("2d"); if (ctx && ctx.clearRect) ctx.clearRect(0, 0, c.width, c.height); }
  }

  async function renderSide(side) {
    const s = st[side];
    const canvas = el("cmp-canvas-" + side);
    if (!canvas || !s.pdf) return;
    try {
      const page = await s.pdf.getPage(s.page);
      const wrap = canvas.parentElement;
      const avail = Math.max(280, ((wrap && wrap.clientWidth) || 620) - 20);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, avail / (base.width || 600));
      const vp = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = Math.floor(vp.width) + "px";
      canvas.style.height = Math.floor(vp.height) + "px";
      const ctx = canvas.getContext("2d");
      const task = page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      if (task && task.promise) await task.promise;
    } catch (err) { console.warn("compare render failed", err); }
  }

  /* -------------------------- Text extraction ----------------------------- */
  async function extractLines(side, onProgress) {
    const s = st[side];
    const lines = [];
    let ocrRec = null;
    if (s.docId) { try { ocrRec = await App.Storage.getOcr(s.docId); } catch (e) { /* noop */ } }
    for (let p = 1; p <= s.total; p++) {
      let count = 0;
      try {
        const page = await s.pdf.getPage(p);
        const tc = await page.getTextContent();
        const rows = [];
        (tc.items || []).forEach((it) => {
          if (!it.str || !it.str.trim() || !it.transform) return;
          rows.push({ x: it.transform[4], y: it.transform[5], str: it.str });
        });
        rows.sort((r1, r2) => (r2.y - r1.y) || (r1.x - r2.x));
        const TOL = 3.5;
        const grouped = [];
        let cur = null;
        rows.forEach((r) => {
          if (!cur || Math.abs(r.y - cur.y) > TOL) { cur = { y: r.y, parts: [r] }; grouped.push(cur); }
          else cur.parts.push(r);
        });
        grouped.forEach((g) => {
          g.parts.sort((p1, p2) => p1.x - p2.x);
          const text = g.parts.map((pp) => pp.str).join(" ").replace(/\s+/g, " ").trim();
          if (text) { lines.push({ page: p, text }); count++; }
        });
      } catch (err) { console.warn("extract failed on page", p, err); }
      // Scanned page fallback: use stored OCR text when the PDF has none.
      if (!count && ocrRec && ocrRec.pages && ocrRec.pages[p]) {
        String(ocrRec.pages[p]).split(/\n+/).forEach((t) => {
          t = t.replace(/\s+/g, " ").trim();
          if (t) lines.push({ page: p, text: t });
        });
      }
      if (onProgress) onProgress(p, s.total);
      await new Promise((r) => setTimeout(r, 0));
    }
    return lines;
  }

  /* ------------------------------ Compare --------------------------------- */
  async function runCompare() {
    if (st.running) return;
    if (!st.a.pdf || !st.b.pdf) { App.toast("Choose two PDFs to compare first", "warn"); return; }
    if (st.a.docId === st.b.docId) App.toast("You are comparing a document with itself", "info");
    st.running = true;
    const runBtn = el("cmp-run"); if (runBtn) runBtn.disabled = true;
    progress(true, "Preparing…", 0);
    try {
      const linesA = await extractLines("a", (p, t) => progress(true, "Extracting A — page " + p + " / " + t, (p / t) * 0.48));
      const linesB = await extractLines("b", (p, t) => progress(true, "Extracting B — page " + p + " / " + t, 0.48 + (p / t) * 0.48));
      if (!linesA.length || !linesB.length) {
        App.toast("No extractable text in document " + (!linesA.length ? "A" : "B") + " — if it is scanned, run OCR on it first", "warn");
        return;
      }
      progress(true, "Computing differences…", 0.97);
      await new Promise((r) => setTimeout(r, 15));
      const res = App.Diff.diffSeq(linesA.map((l) => l.text), linesB.map((l) => l.text));
      const blocks = App.Diff.buildBlocks(res.ops, linesA, linesB);
      st.report = {
        a: docInfo("a"), b: docInfo("b"),
        createdAt: Date.now(),
        stats: computeStats(blocks),
        blocks, capped: !!res.capped,
      };
      st.expanded = new Set();
      renderStats();
      renderDiff();
      setActionsEnabled(true);
      if (res.capped) App.toast("Documents differ extensively — showing a block-level comparison", "info");
    } catch (err) {
      console.error(err);
      App.toast("Comparison failed: " + ((err && err.message) || err), "err");
    } finally {
      progress(false);
      st.running = false;
      if (runBtn) runBtn.disabled = false;
    }
  }

  function computeStats(blocks) {
    const s = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    blocks.forEach((b) => {
      if (b.type === "same") s.unchanged += b.rows.length;
      else if (b.type === "del") s.removed += b.rows.length;
      else if (b.type === "ins") s.added += b.rows.length;
      else { s.changed += b.pairs.length; s.removed += b.dels.length; s.added += b.inss.length; }
    });
    return s;
  }

  function docInfo(side) {
    const docs = App.getDocuments ? App.getDocuments() : [];
    const d = docs.find((x) => x.id === st[side].docId);
    return { id: st[side].docId, name: (d && d.name) || "Document " + side.toUpperCase(), pages: st[side].total };
  }

  /* ------------------------------ Rendering ------------------------------- */
  function renderStats() {
    const host = el("cmp-stats");
    if (!host) return;
    const rep = st.report;
    if (!rep) { host.innerHTML = ""; return; }
    const s = rep.stats;
    host.innerHTML =
      '<span class="cmp-stat add">+' + s.added + " added</span>" +
      '<span class="cmp-stat del">−' + s.removed + " removed</span>" +
      '<span class="cmp-stat chg">~' + s.changed + " changed</span>" +
      '<span class="cmp-stat ctx">' + s.unchanged + " unchanged</span>" +
      (rep.capped ? '<span class="cmp-stat warn">block-level (capped)</span>' : "");
  }

  function renderDiff() {
    const host = el("cmp-diff");
    if (!host) return;
    const rep = st.report;
    if (!rep) {
      host.innerHTML = '<div class="empty-state">' + App.Icons.get("compare") +
        "<p>Pick a PDF on each side and press “Compare text” to see what was added, removed or changed.</p></div>";
      return;
    }
    const s = rep.stats;
    if (s.added + s.removed + s.changed === 0) {
      host.innerHTML = '<div class="empty-state">' + App.Icons.get("check") +
        "<p>No differences found — the extracted text of both documents is identical.</p></div>";
      return;
    }
    const only = el("cmp-only-changes") ? el("cmp-only-changes").checked : true;
    host.innerHTML = "";
    const frag = document.createDocumentFragment();
    let rendered = 0;

    const addRow = (cls, marker, text, aPage, bPage, html) => {
      if (rendered >= ROW_CAP) return;
      const row = document.createElement("div");
      row.className = "diff-row " + cls;
      row.innerHTML = '<span class="d-mark"></span><span class="d-page"></span><span class="d-text"></span>';
      row.querySelector(".d-mark").textContent = marker;
      row.querySelector(".d-page").textContent = pageLabel(aPage, bPage);
      const tEl = row.querySelector(".d-text");
      if (html != null) tEl.innerHTML = html; else tEl.textContent = text;
      if (aPage || bPage) {
        row.title = "Click to show this page above";
        row.addEventListener("click", () => { if (aPage) goTo("a", aPage); if (bPage) goTo("b", bPage); });
      }
      frag.appendChild(row);
      rendered++;
    };

    rep.blocks.forEach((blk, bi) => {
      if (rendered >= ROW_CAP) return;
      if (blk.type === "same") {
        if (!only || st.expanded.has(bi)) {
          blk.rows.forEach((r) => addRow("ctx", "", r.a.text, r.a.page, r.b.page));
        } else {
          const lead = blk.rows.slice(0, 2);
          const trail = blk.rows.length > 4 ? blk.rows.slice(-2) : blk.rows.slice(2);
          const hidden = blk.rows.length - lead.length - trail.length;
          lead.forEach((r) => addRow("ctx", "", r.a.text, r.a.page, r.b.page));
          if (hidden > 0) {
            const gap = document.createElement("button");
            gap.type = "button";
            gap.className = "diff-row gap";
            gap.innerHTML = '<span class="d-mark">⋯</span><span class="d-text"></span>';
            gap.querySelector(".d-text").textContent = hidden + " unchanged line" + (hidden === 1 ? "" : "s") + " — click to expand";
            gap.addEventListener("click", () => { st.expanded.add(bi); renderDiff(); });
            frag.appendChild(gap);
            rendered++;
          }
          trail.forEach((r) => addRow("ctx", "", r.a.text, r.a.page, r.b.page));
        }
      } else if (blk.type === "del") {
        blk.rows.forEach((r) => addRow("del", "−", r.text, r.page, null));
      } else if (blk.type === "ins") {
        blk.rows.forEach((r) => addRow("add", "+", r.text, null, r.page));
      } else {
        blk.pairs.forEach((p) => {
          addRow("del chg", "−", p.a.text, p.a.page, null, p.aHtml);
          addRow("add chg", "+", p.b.text, null, p.b.page, p.bHtml);
        });
        blk.dels.forEach((r) => addRow("del", "−", r.text, r.page, null));
        blk.inss.forEach((r) => addRow("add", "+", r.text, null, r.page));
      }
    });

    if (rendered >= ROW_CAP) {
      const note = document.createElement("div");
      note.className = "diff-row gap";
      note.innerHTML = '<span class="d-mark">!</span><span class="d-text">Display capped at ' + ROW_CAP +
        " rows — keep “Only changes” on, or export the report for the complete diff.</span>";
      frag.appendChild(note);
    }
    host.appendChild(frag);
  }

  function pageLabel(aPage, bPage) {
    if (aPage && bPage) return aPage === bPage ? "p." + aPage : "A p." + aPage + " · B p." + bPage;
    if (aPage) return "A p." + aPage;
    if (bPage) return "B p." + bPage;
    return "";
  }

  function setActionsEnabled(onOff) {
    ["cmp-export-txt", "cmp-export-json", "cmp-save"].forEach((id) => { const b = el(id); if (b) b.disabled = !onOff; });
  }
  function guardReport() {
    if (!st.report) { App.toast("Run a comparison first", "warn"); return false; }
    return true;
  }

  /* ------------------------------ Reports --------------------------------- */
  function reportName(rep) { return rep.a.name + " vs " + rep.b.name; }

  function reportToTxt(rep) {
    const s = rep.stats;
    const lines = [
      "DOCUMENT COMPARISON REPORT",
      "A: " + rep.a.name + " (" + rep.a.pages + " pages)",
      "B: " + rep.b.name + " (" + rep.b.pages + " pages)",
      "Generated: " + new Date(rep.createdAt).toLocaleString(),
      "Added: " + s.added + " · Removed: " + s.removed + " · Changed: " + s.changed + " · Unchanged: " + s.unchanged,
    ];
    if (rep.capped) lines.push("Note: documents differ extensively; this is a block-level comparison.");
    lines.push("-".repeat(64), "");
    rep.blocks.forEach((blk) => {
      if (blk.type === "same") {
        const lead = blk.rows.slice(0, 2);
        const trail = blk.rows.length > 4 ? blk.rows.slice(-2) : blk.rows.slice(2);
        const hidden = blk.rows.length - lead.length - trail.length;
        lead.forEach((r) => lines.push("   [p." + r.a.page + "] " + r.a.text));
        if (hidden > 0) lines.push("   ⋯ " + hidden + " unchanged line" + (hidden === 1 ? "" : "s") + " ⋯");
        trail.forEach((r) => lines.push("   [p." + r.a.page + "] " + r.a.text));
      } else if (blk.type === "del") {
        blk.rows.forEach((r) => lines.push("−  [A p." + r.page + "] " + r.text));
      } else if (blk.type === "ins") {
        blk.rows.forEach((r) => lines.push("+  [B p." + r.page + "] " + r.text));
      } else {
        blk.pairs.forEach((p) => {
          lines.push("−  [A p." + p.a.page + "] " + p.a.text);
          lines.push("+  [B p." + p.b.page + "] " + p.b.text);
        });
        blk.dels.forEach((r) => lines.push("−  [A p." + r.page + "] " + r.text));
        blk.inss.forEach((r) => lines.push("+  [B p." + r.page + "] " + r.text));
      }
    });
    return lines.join("\n");
  }

  // JSON export: structured data without the derived word-diff HTML.
  function reportToJsonString(rep) {
    const stripLine = (l) => ({ page: l.page, text: l.text });
    const blocks = rep.blocks.map((b) => {
      if (b.type === "same") return { type: "same", rows: b.rows.map((r) => ({ a: stripLine(r.a), b: stripLine(r.b) })) };
      if (b.type === "del") return { type: "removed", lines: b.rows.map(stripLine) };
      if (b.type === "ins") return { type: "added", lines: b.rows.map(stripLine) };
      return {
        type: "changed",
        pairs: b.pairs.map((p) => ({ a: stripLine(p.a), b: stripLine(p.b) })),
        removed: b.dels.map(stripLine), added: b.inss.map(stripLine),
      };
    });
    return JSON.stringify({
      app: "Engineering PDF Research Workspace", kind: "comparison-report",
      a: rep.a, b: rep.b,
      generatedAt: new Date(rep.createdAt).toISOString(),
      stats: rep.stats, capped: !!rep.capped, blocks,
    }, null, 2);
  }

  async function saveReport() {
    if (!guardReport()) return;
    const rec = {
      id: util.uid("cmp"),
      name: reportName(st.report),
      a: st.report.a, b: st.report.b,
      createdAt: st.report.createdAt,
      stats: st.report.stats, capped: st.report.capped,
      blocks: st.report.blocks,
    };
    await App.Storage.saveComparison(rec);
    st.saved.push(rec);
    renderSaved();
    bus.emit("comparisons:changed", {});
    App.toast("Comparison report saved", "ok");
  }

  async function deleteSaved(id) {
    await App.Storage.deleteComparison(id);
    st.saved = st.saved.filter((r) => r.id !== id);
    renderSaved();
    bus.emit("comparisons:changed", {});
  }

  async function loadSaved() {
    st.saved = await App.Storage.getAllComparisons();
    st.saved.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderSaved();
  }

  function renderSaved() {
    const host = el("cmp-saved");
    if (!host) return;
    host.innerHTML = "";
    if (!st.saved.length) {
      host.innerHTML = '<p class="tags-empty">No saved reports yet — run a comparison and press “Save report”.</p>';
      return;
    }
    st.saved.forEach((r) => {
      const row = document.createElement("div");
      row.className = "exp-row";
      row.innerHTML =
        '<span class="exp-ico">' + App.Icons.get("compare") + "</span>" +
        '<div class="exp-name-wrap"><span class="exp-name"></span><span class="exp-sub"></span></div>' +
        '<div class="exp-fmt"></div>';
      row.querySelector(".exp-name").textContent = r.name;
      row.querySelector(".exp-sub").textContent = util.formatDate(r.createdAt) + " · +" + r.stats.added + " −" + r.stats.removed + " ~" + r.stats.changed;
      const fmt = row.querySelector(".exp-fmt");
      fmt.appendChild(miniBtn("View", () => viewSaved(r)));
      fmt.appendChild(miniBtn("TXT", () => util.downloadFile(slug(r.name) + ".txt", reportToTxt(r), "text/plain")));
      fmt.appendChild(miniBtn("JSON", () => util.downloadFile(slug(r.name) + ".json", reportToJsonString(r), "application/json")));
      fmt.appendChild(miniBtn("Delete", async () => {
        const ok = await App.confirmDialog({ title: "Delete report?", message: "“" + r.name + "” will be permanently removed.", okText: "Delete", danger: true });
        if (ok) deleteSaved(r.id);
      }, "danger"));
      host.appendChild(row);
    });
  }

  function viewSaved(rec) {
    st.report = rec;
    st.expanded = new Set();
    renderStats();
    renderDiff();
    setActionsEnabled(true);
    const d = el("cmp-diff");
    if (d && d.scrollIntoView) d.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------ Helpers --------------------------------- */
  function progress(show, text, frac) {
    const box = el("cmp-progress");
    if (!box) return;
    box.style.display = show ? "" : "none";
    const bar = box.querySelector(".ocr-bar span");
    const status = box.querySelector(".ocr-status");
    if (bar && frac != null) bar.style.width = Math.round(frac * 100) + "%";
    if (status && text != null) status.textContent = text;
  }
  function el(id) { return document.getElementById(id); }
  function sel(side) { return el("cmp-select-" + side); }
  function miniBtn(label, fn, extra) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn tiny" + (extra ? " " + extra : "");
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }
  function on(id, fn) { const e = el(id); if (e) e.addEventListener("click", fn); }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function esc(s) { return util.escapeHtml(s); }
  function slug(s) { return (s || "comparison").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "comparison"; }

  App.Compare = {
    init, onShow, refreshSelects,
    getSaved: () => st.saved, reload: loadSaved, deleteSaved,
    reportToTxt, reportToJsonString,
  };
})();
