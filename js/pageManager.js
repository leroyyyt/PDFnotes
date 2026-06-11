/* =============================================================================
   pageManager.js — PDF page management modal (reorder · delete · rotate · merge).

   Opens a modal showing every page of the current document as a thumbnail.
   The user can:
     • Drag thumbnails to reorder pages.
     • Toggle pages for deletion (removed from the output).
     • Rotate individual pages 90° (visual preview + baked into output).
     • Merge: append other PDFs (picked from the local Library or a file) whose
       pages are added to the end and can then be reordered/rotated/deleted too.
   "Export PDF" writes a brand-new PDF (via pdf-lib) reflecting the final order,
   rotations and deletions, then downloads it.

   Thumbnails are rendered with PDF.js (already bundled). Source page bytes come
   from IndexedDB (the open document) or from the picked merge sources, so this
   stays fully offline.

   Exposed as window.App.PageManager.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const pdfjsLib = window.pdfjsLib;

  // One entry per page currently in the working set.
  // { uid, srcKey, srcIndex, rotation(extra 0/90/180/270), deleted, label }
  let model = [];
  // srcKey -> { bytes, pdf(PDF.js doc), name }
  const sources = new Map();
  let backdrop = null, gridEl = null, busy = false;

  async function open() {
    if (!App.PdfEdit || !App.PdfEdit.available()) { App.toast("PDF engine not available", "err"); return; }
    if (!App.state.docId) { App.toast("Open a PDF first", "warn"); return; }
    const bytes = await App.Exporter.currentDocBytes();
    if (!bytes) { App.toast("Could not read the PDF bytes", "err"); return; }

    sources.clear();
    model = [];
    await addSource(App.state.docId, bytes, (App.state.docMeta && App.state.docMeta.name) || "Document");
    render();
  }

  async function addSource(key, bytes, name) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Clone for PDF.js (it may detach the buffer) and keep a pristine copy for export.
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
    sources.set(key, { bytes: data, pdf, name });
    for (let i = 0; i < pdf.numPages; i++) {
      model.push({ uid: App.util.uid("pg"), srcKey: key, srcIndex: i, rotation: 0, deleted: false, label: name + " · p." + (i + 1) });
    }
  }

  /* ------------------------------ Rendering ------------------------------ */
  function render() {
    if (!backdrop) buildShell();
    backdrop.classList.add("show");
    drawGrid();
    updateCount();
  }

  function buildShell() {
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop pm-backdrop";
    backdrop.innerHTML =
      '<div class="modal pm-modal" role="dialog" aria-modal="true" aria-label="Manage PDF pages">' +
        '<div class="pm-head">' +
          '<h3>Manage pages</h3>' +
          '<span class="pm-count" id="pm-count"></span>' +
          '<span class="pm-spacer"></span>' +
          '<button class="btn has-label" data-act="merge-lib"><span data-icon="plus"></span><span>Add from Library</span></button>' +
          '<button class="btn has-label" data-act="merge-file"><span data-icon="upload"></span><span>Add PDF file…</span></button>' +
        '</div>' +
        '<p class="pm-hint">Drag to reorder. Use the buttons on each page to rotate or remove it. Removed pages are excluded from the exported PDF.</p>' +
        '<div class="pm-grid" id="pm-grid"></div>' +
        '<div class="pm-foot">' +
          '<button class="btn has-label" data-act="reset">Reset</button>' +
          '<span class="pm-spacer"></span>' +
          '<button class="btn has-label" data-act="cancel">Cancel</button>' +
          '<button class="btn has-label primary" data-act="export"><span data-icon="download"></span><span>Export PDF</span></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(backdrop);
    gridEl = backdrop.querySelector("#pm-grid");

    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
    backdrop.querySelector('[data-act="reset"]').addEventListener("click", () => { open(); });
    backdrop.querySelector('[data-act="export"]').addEventListener("click", exportPdf);
    backdrop.querySelector('[data-act="merge-lib"]').addEventListener("click", mergeFromLibrary);
    backdrop.querySelector('[data-act="merge-file"]').addEventListener("click", mergeFromFile);
    document.addEventListener("keydown", onKey);
    if (window.App.Icons) hydrateIcons(backdrop);
  }

  function onKey(e) { if (e.key === "Escape" && backdrop && backdrop.classList.contains("show")) close(); }

  function drawGrid() {
    gridEl.innerHTML = "";
    model.forEach((entry, i) => gridEl.appendChild(card(entry, i)));
  }

  function card(entry, index) {
    const el = document.createElement("div");
    el.className = "pm-card" + (entry.deleted ? " deleted" : "");
    el.draggable = !entry.deleted;
    el.dataset.uid = entry.uid;
    el.innerHTML =
      '<div class="pm-thumb"><canvas></canvas>' +
        '<span class="pm-num">' + (index + 1) + '</span>' +
        (entry.deleted ? '<span class="pm-del-badge">Removed</span>' : '') +
      '</div>' +
      '<div class="pm-card-bar">' +
        '<button class="pm-ic" data-op="rotate" title="Rotate 90°" aria-label="Rotate page">' + ic("rotateCw") + '</button>' +
        '<span class="pm-src" title="' + esc(entry.label) + '">' + esc(entry.label) + '</span>' +
        '<button class="pm-ic ' + (entry.deleted ? 'restore' : 'del') + '" data-op="toggle" title="' + (entry.deleted ? "Restore page" : "Remove page") + '" aria-label="Toggle page removal">' +
          ic(entry.deleted ? "plus" : "trash") + '</button>' +
      '</div>';

    // Render the thumbnail (async).
    const canvas = el.querySelector("canvas");
    renderThumb(entry, canvas);

    el.querySelector('[data-op="rotate"]').addEventListener("click", (e) => {
      e.stopPropagation();
      entry.rotation = (entry.rotation + 90) % 360;
      renderThumb(entry, el.querySelector("canvas"));
    });
    el.querySelector('[data-op="toggle"]').addEventListener("click", (e) => {
      e.stopPropagation();
      entry.deleted = !entry.deleted;
      drawGrid(); updateCount();
    });

    // Drag to reorder
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", entry.uid); e.dataTransfer.effectAllowed = "move"; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop-target"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", (e) => {
      e.preventDefault(); el.classList.remove("drop-target");
      const fromUid = e.dataTransfer.getData("text/plain");
      if (!fromUid || fromUid === entry.uid) return;
      const from = model.findIndex((m) => m.uid === fromUid);
      const to = model.findIndex((m) => m.uid === entry.uid);
      if (from === -1 || to === -1) return;
      const [moved] = model.splice(from, 1);
      model.splice(to, 0, moved);
      drawGrid(); updateCount();
    });

    return el;
  }

  async function renderThumb(entry, canvas) {
    const src = sources.get(entry.srcKey);
    if (!src || !canvas) return;
    try {
      const page = await src.pdf.getPage(entry.srcIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const targetW = 150;
      const scale = targetW / base.width;
      const vp = page.getViewport({ scale, rotation: entry.rotation });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = Math.floor(vp.width) + "px";
      canvas.style.height = Math.floor(vp.height) + "px";
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
      await page.render({ canvasContext: ctx, viewport: vp, transform }).promise;
    } catch (e) { /* leave blank on failure */ }
  }

  function updateCount() {
    const kept = model.filter((m) => !m.deleted).length;
    const el = backdrop.querySelector("#pm-count");
    if (el) el.textContent = kept + " of " + model.length + " pages kept";
  }

  /* ------------------------------- Merge --------------------------------- */
  async function mergeFromLibrary() {
    const docs = (App.getDocuments ? App.getDocuments() : []).filter((d) => d.id !== App.state.docId);
    if (!docs.length) { App.toast("No other PDFs in the Library to merge", "info"); return; }
    const picked = await pickFromList(docs);
    if (!picked) return;
    setBusy(true);
    try {
      for (const id of picked) {
        if (sources.has(id)) continue;
        const rec = await App.Storage.getFile(id);
        const meta = docs.find((d) => d.id === id);
        if (rec && rec.data) await addSource(id, rec.data, (meta && meta.name) || "PDF");
      }
      drawGrid(); updateCount();
      App.toast("Pages added — drag to position them", "ok");
    } catch (e) { console.error(e); App.toast("Could not add that PDF", "err"); }
    finally { setBusy(false); }
  }

  function mergeFromFile() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "application/pdf,.pdf"; input.multiple = true;
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      setBusy(true);
      try {
        for (const file of files) {
          const buf = new Uint8Array(await file.arrayBuffer());
          await addSource(App.util.uid("ext"), buf, file.name.replace(/\.pdf$/i, ""));
        }
        drawGrid(); updateCount();
        App.toast(files.length + " PDF(s) added", "ok");
      } catch (e) { console.error(e); App.toast("Could not read that file", "err"); }
      finally { setBusy(false); }
    });
    input.click();
  }

  // Small inline multi-select dialog for Library docs.
  function pickFromList(docs) {
    return new Promise((resolve) => {
      const bd = document.createElement("div");
      bd.className = "modal-backdrop";
      bd.style.zIndex = 300;
      bd.innerHTML =
        '<div class="modal modal-form" role="dialog" aria-modal="true"><h3>Add pages from Library</h3>' +
        '<p class="modal-hint">Tick the PDFs whose pages you want to append.</p>' +
        '<div class="fn-list">' +
          docs.map((d) => '<label class="fn-row"><input type="checkbox" value="' + d.id + '"><span class="fn-text">' + esc(d.name) + '</span><span class="fn-meta">' + (d.pageCount || "?") + ' pp.</span></label>').join("") +
        '</div>' +
        '<div class="row"><button class="btn has-label" data-act="cancel">Cancel</button>' +
        '<button class="btn has-label primary" data-act="ok">Add selected</button></div></div>';
      document.body.appendChild(bd);
      requestAnimationFrame(() => bd.classList.add("show"));
      if (window.App.Icons) hydrateIcons(bd);
      const done = (val) => { bd.classList.remove("show"); setTimeout(() => bd.remove(), 160); resolve(val); };
      bd.addEventListener("mousedown", (e) => { if (e.target === bd) done(null); });
      bd.querySelector('[data-act="cancel"]').addEventListener("click", () => done(null));
      bd.querySelector('[data-act="ok"]').addEventListener("click", () => {
        const ids = Array.from(bd.querySelectorAll("input:checked")).map((i) => i.value);
        done(ids.length ? ids : null);
      });
    });
  }

  /* ------------------------------- Export -------------------------------- */
  async function exportPdf() {
    const kept = model.filter((m) => !m.deleted);
    if (!kept.length) { App.toast("All pages are removed — nothing to export", "warn"); return; }
    setBusy(true);
    App.toast("Building PDF…", "info");
    try {
      const { PDFDocument, degrees } = window.PDFLib;
      const out = await PDFDocument.create();
      // Cache loaded pdf-lib source docs by key.
      const libDocs = new Map();
      for (const [key, src] of sources) {
        libDocs.set(key, await PDFDocument.load(src.bytes, { ignoreEncryption: true }));
      }
      for (const entry of kept) {
        const srcDoc = libDocs.get(entry.srcKey);
        const [copied] = await out.copyPages(srcDoc, [entry.srcIndex]);
        out.addPage(copied);
        if (entry.rotation) {
          const base = (copied.getRotation && copied.getRotation().angle) || 0;
          copied.setRotation(degrees((base + entry.rotation) % 360));
        }
      }
      const bytes = await out.save();
      const base = ((App.state.docMeta && App.state.docMeta.name) || "document").replace(/\.pdf$/i, "");
      App.util.downloadFile(base + "-edited.pdf", bytes, "application/pdf");
      App.toast("PDF exported (" + kept.length + " pages)", "ok");
      close();
    } catch (e) {
      console.error(e); App.toast("Export failed: " + (e.message || "error"), "err");
    } finally { setBusy(false); }
  }

  /* ------------------------------ Helpers -------------------------------- */
  function setBusy(b) {
    busy = b;
    if (!backdrop) return;
    backdrop.querySelectorAll("button").forEach((btn) => { btn.disabled = b; });
  }
  function close() {
    if (!backdrop) return;
    backdrop.classList.remove("show");
    document.removeEventListener("keydown", onKey);
    // Release PDF.js docs.
    sources.forEach((s) => { try { s.pdf.destroy(); } catch (e) {} });
    sources.clear(); model = [];
    setTimeout(() => { if (backdrop) { backdrop.remove(); backdrop = null; } }, 160);
  }
  function ic(name) { return (window.App.Icons && window.App.Icons.get(name)) || ""; }
  function esc(s) { return App.util.escapeHtml(s); }
  function hydrateIcons(root) {
    root.querySelectorAll("[data-icon]").forEach((sp) => { if (!sp.innerHTML.trim()) sp.innerHTML = ic(sp.getAttribute("data-icon")); });
  }

  App.PageManager = { open };
})();
