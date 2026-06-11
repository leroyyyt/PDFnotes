/* =============================================================================
   ocr.js — Optical Character Recognition for scanned PDFs (Tesseract.js).

   Everything runs locally: the engine, worker, WASM core and English language
   data are all bundled under vendor/tesseract/. No network is used.

   Capabilities:
     • OCR the current page or the entire document.
     • Live progress (per-page + overall).
     • Save recognised text locally (IndexedDB) per page.
     • Make text searchable through Global Search.
     • Copy text / export as .txt.

   IMPORTANT: Tesseract.js needs Web Workers + local file access. Browsers block
   both for pages opened directly from disk (file://) — most notably Chrome.
   OCR therefore works when the app is served over a local HTTP server
   (e.g. `python -m http.server`) or, for file://, in Firefox. The panel detects
   failures and explains this.

   Exposed as window.App.OCR.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, util } = App;

  const PATHS = {
    workerPath: "vendor/tesseract/worker.min.js",
    corePath: "vendor/tesseract/core",
    langPath: "vendor/tesseract/lang",
  };

  let worker = null;       // reused Tesseract worker
  let busy = false;        // an OCR run is in progress
  let cancelRequested = false;
  let overlay = null;      // DOM panel
  let resultsByPage = {};  // page -> text (current session view cache)

  function init() {
    const btn = document.getElementById("ocr-open");
    if (btn) btn.addEventListener("click", open);
    App.bus.on("doc:closed", () => { resultsByPage = {}; if (overlay) close(); });
  }

  /* ------------------------------- Panel --------------------------------- */
  function open() {
    if (!state.pdfDoc) { App.toast("Open a PDF first", "warn"); return; }
    if (overlay) { close(); return; }

    overlay = document.createElement("div");
    overlay.className = "modal-backdrop show";
    overlay.innerHTML =
      '<div class="modal ocr-modal" role="dialog" aria-modal="true">' +
        '<div class="ocr-head">' +
          "<h3>" + App.Icons.get("scan") + " Text recognition (OCR)</h3>" +
          '<button class="btn icon-only" data-act="close" title="Close">' + App.Icons.get("x") + "</button>" +
        "</div>" +
        '<p class="ocr-note"></p>' +
        '<div class="ocr-controls">' +
          '<button class="btn has-label primary" data-act="page">' + App.Icons.get("fileText") + "<span>OCR current page</span></button>" +
          '<button class="btn has-label" data-act="all">' + App.Icons.get("book") + "<span>OCR entire PDF</span></button>" +
          '<button class="btn has-label danger" data-act="stop" disabled>' + App.Icons.get("x") + "<span>Stop</span></button>" +
        "</div>" +
        '<div class="ocr-progress" hidden><div class="ocr-bar"><span></span></div><div class="ocr-status"></div></div>' +
        '<div class="ocr-result">' +
          '<div class="ocr-result-head"><span class="ocr-result-label">Recognised text</span>' +
            '<div class="ocr-result-actions">' +
              '<button class="btn has-label" data-act="copy">' + App.Icons.get("file") + "<span>Copy</span></button>" +
              '<button class="btn has-label" data-act="export">' + App.Icons.get("download") + "<span>Export .txt</span></button>" +
            "</div>" +
          "</div>" +
          '<textarea class="ocr-text" spellcheck="false" placeholder="Recognised text will appear here."></textarea>' +
          '<div class="ocr-saved"></div>' +
        "</div>" +
      "</div>";

    document.body.appendChild(overlay);

    const isFile = location.protocol === "file:";
    overlay.querySelector(".ocr-note").innerHTML = App.Icons.get("info") + "<span>" +
      (isFile
        ? "You opened this app from a file path. OCR needs Web Workers, which Chrome blocks on <code>file://</code>. If OCR fails, run a local server (<code>python -m http.server</code>) and open <code>http://localhost:8000</code>, or use Firefox."
        : "OCR runs fully offline in your browser. The first run loads the English model (~10&nbsp;MB) from local files — please allow a few seconds.") +
      "</span>";

    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay && !busy) close(); });
    overlay.querySelector('[data-act="close"]').addEventListener("click", () => { if (!busy) close(); });
    overlay.querySelector('[data-act="page"]').addEventListener("click", () => runPages([state.page]));
    overlay.querySelector('[data-act="all"]').addEventListener("click", runAll);
    overlay.querySelector('[data-act="stop"]').addEventListener("click", () => { cancelRequested = true; });
    overlay.querySelector('[data-act="copy"]').addEventListener("click", copyText);
    overlay.querySelector('[data-act="export"]').addEventListener("click", exportTxt);

    loadSavedSummary();
  }

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  /* ----------------------------- OCR engine ------------------------------ */
  async function ensureWorker(onProgress) {
    if (worker) return worker;
    if (typeof window.Tesseract === "undefined") throw new Error("Tesseract engine not loaded");
    worker = await window.Tesseract.createWorker("eng", 1, {
      workerPath: PATHS.workerPath,
      corePath: PATHS.corePath,
      langPath: PATHS.langPath,
      workerBlobURL: false,   // load worker from our path, not a blob (file:// safe-ish)
      gzip: true,
      logger: (m) => { if (onProgress) onProgress(m); },
    });
    return worker;
  }

  // Render a PDF page to an offscreen canvas suitable for OCR.
  async function rasterize(pageNum) {
    const page = await state.pdfDoc.getPage(pageNum);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1.5, 1700 / base.width)); // aim for a crisp ~150–200dpi
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas;
  }

  async function runPages(pages) {
    if (busy) return;
    busy = true; cancelRequested = false;
    setControls(true);
    showProgress(true);
    const textEl = overlay.querySelector(".ocr-text");

    try {
      const wk = await ensureWorker(handleLogger(pages.length));
      let done = 0;
      for (const n of pages) {
        if (cancelRequested) break;
        status("Rendering page " + n + "…", done / pages.length);
        const canvas = await rasterize(n);
        if (cancelRequested) break;
        status("Recognising page " + n + " (" + (done + 1) + " of " + pages.length + ")…", done / pages.length);
        const res = await wk.recognize(canvas);
        const text = (res && res.data && res.data.text ? res.data.text : "").trim();
        resultsByPage[n] = text;
        await App.Storage.saveOcrPage(state.docId, n, text);
        done++;
        // show the most recent page's text (or accumulate for multi-page)
        textEl.value = pages.length === 1 ? text : buildAccumulated(pages);
        status("Recognised page " + n, done / pages.length);
      }
      status(cancelRequested ? "Stopped." : "Done — " + done + " page" + (done === 1 ? "" : "s") + " recognised.", 1);
      App.bus.emit("ocr:changed", { docId: state.docId });
      if (!cancelRequested) App.toast("OCR complete — text saved & searchable", "ok");
      loadSavedSummary();
    } catch (err) {
      console.error("OCR error:", err);
      failMessage(err);
    } finally {
      busy = false;
      setControls(false);
    }
  }

  function buildAccumulated(pages) {
    return pages.filter((n) => resultsByPage[n] != null)
      .map((n) => "===== Page " + n + " =====\n" + (resultsByPage[n] || "")).join("\n\n");
  }

  function runAll() {
    const pages = [];
    for (let n = 1; n <= state.totalPages; n++) pages.push(n);
    runPages(pages);
  }

  /* --------------------------- Progress / status ------------------------- */
  function handleLogger(totalPages) {
    return (m) => {
      if (!overlay) return;
      if (m && m.status && /recogniz/i.test(m.status) && typeof m.progress === "number") {
        // refine the within-page fraction onto the current status line
        const bar = overlay.querySelector(".ocr-bar span");
        const cur = parseFloat(bar.dataset.base || "0");
        const frac = cur + (m.progress / totalPages);
        bar.style.width = Math.min(100, Math.round(frac * 100)) + "%";
      } else if (m && m.status) {
        const st = overlay.querySelector(".ocr-status");
        if (st && /load|initiali/i.test(m.status)) st.textContent = "Loading OCR engine…";
      }
    };
  }
  function status(text, frac) {
    if (!overlay) return;
    const bar = overlay.querySelector(".ocr-bar span");
    const st = overlay.querySelector(".ocr-status");
    if (typeof frac === "number") { bar.style.width = Math.round(frac * 100) + "%"; bar.dataset.base = String(frac); }
    if (st) st.textContent = text;
  }
  function showProgress(on) { const p = overlay.querySelector(".ocr-progress"); if (p) p.hidden = !on; }
  function setControls(running) {
    if (!overlay) return;
    overlay.querySelector('[data-act="page"]').disabled = running;
    overlay.querySelector('[data-act="all"]').disabled = running;
    overlay.querySelector('[data-act="stop"]').disabled = !running;
    overlay.querySelector('[data-act="close"]').disabled = running;
  }
  function failMessage(err) {
    const st = overlay && overlay.querySelector(".ocr-status");
    const msg = location.protocol === "file:"
      ? "OCR couldn’t start. Your browser blocked the Web Worker on file://. Please run a local server (python -m http.server) or use Firefox."
      : "OCR failed to start: " + (err && err.message ? err.message : "unknown error");
    if (st) st.textContent = msg;
    App.toast("OCR unavailable in this context", "err");
    // a failed worker is unusable — drop it so a later attempt can retry cleanly
    if (worker) { try { worker.terminate(); } catch (_) {} worker = null; }
  }

  /* ------------------------------ Saved list ----------------------------- */
  async function loadSavedSummary() {
    if (!overlay) return;
    const box = overlay.querySelector(".ocr-saved");
    const rec = await App.Storage.getOcr(state.docId);
    const pages = rec && rec.pages ? Object.keys(rec.pages).map(Number).sort((a, b) => a - b) : [];
    if (!pages.length) { box.innerHTML = '<span class="ocr-saved-empty">No saved OCR text for this document yet.</span>'; return; }
    box.innerHTML = '<span class="ocr-saved-label">Saved pages:</span>';
    pages.forEach((n) => {
      const chip = document.createElement("button");
      chip.className = "ocr-page-chip"; chip.textContent = "p." + n;
      chip.title = "View OCR text for page " + n;
      chip.addEventListener("click", () => {
        resultsByPage[n] = rec.pages[n];
        overlay.querySelector(".ocr-text").value = rec.pages[n] || "";
        App.Viewer.goToPage(n);
      });
      box.appendChild(chip);
    });
  }

  /* ------------------------------ Copy/export ---------------------------- */
  function copyText() {
    const text = overlay.querySelector(".ocr-text").value;
    if (!text.trim()) return App.toast("No OCR text to copy", "warn");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => App.toast("Copied", "ok"), () => App.toast("Copy failed", "err"));
    } else {
      const ta = overlay.querySelector(".ocr-text"); ta.select();
      try { document.execCommand("copy"); App.toast("Copied", "ok"); } catch (e) { App.toast("Copy failed", "err"); }
    }
  }
  async function exportTxt() {
    const rec = await App.Storage.getOcr(state.docId);
    const pages = rec && rec.pages ? Object.keys(rec.pages).map(Number).sort((a, b) => a - b) : [];
    let text;
    if (pages.length) {
      text = pages.map((n) => "===== Page " + n + " =====\n" + (rec.pages[n] || "")).join("\n\n");
    } else {
      text = overlay.querySelector(".ocr-text").value;
    }
    if (!text.trim()) return App.toast("Nothing to export", "warn");
    const name = ((state.docMeta && state.docMeta.name) || "document").replace(/\.pdf$/i, "");
    util.downloadFile(name + "-ocr.txt", text, "text/plain");
  }

  /* --------------- Text accessor for Global Search ----------------------- */
  async function getText(docId) {
    const rec = await App.Storage.getOcr(docId);
    if (!rec || !rec.pages) return { full: "", pages: {} };
    const full = Object.keys(rec.pages).sort((a, b) => a - b).map((n) => rec.pages[n]).join("\n");
    return { full, pages: rec.pages };
  }

  App.OCR = { init, open, getText };
})();
