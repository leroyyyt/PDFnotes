/* =============================================================================
   pageManager.js — PDF page management modal (reorder · delete · rotate · merge).

   Opens a modal showing every page of the current document as a thumbnail.
   The user can:
     • Drag thumbnails to reorder pages (smooth, Safari-tab-style live shuffle).
     • Toggle pages for deletion (removed from the output).
     • Rotate individual pages 90° (visual preview + baked into output).
     • Merge: append other PDFs (picked from the local Library or a file) whose
       pages are added to the end and can then be reordered/rotated/deleted too.
   "Export PDF" writes a brand-new PDF (via pdf-lib) reflecting the final order,
   rotations and deletions, then downloads it.

   ── Why this version is self-contained ──────────────────────────────────────
   This module injects ALL the CSS it needs (PM_STYLE) with `!important`, so it
   no longer depends on `css/styles.css` for the grid/card sizing. That fixes two
   things the old build got wrong:

     1. Tabs shrinking when many PDFs are merged in. The grid now uses a FIXED
        column width (no `1fr`), so thumbnails keep a constant size and the panel
        simply WRAPS and SCROLLS vertically instead of squeezing every tab smaller.

     2. The reorder snapping / feeling unnatural. Reordering is a pointer-driven
        FLIP animation: the dragged page lifts and follows the cursor, a dashed
        placeholder shows exactly where it will land, and every other page slides
        smoothly into its new position (like dragging a Safari tab). Each tab also
        has a FIXED thumbnail box, so rows are uniform and the slide looks clean.

   Thumbnails are rendered with PDF.js (already bundled). Source page bytes come
   from IndexedDB (the open document) or from the picked merge sources, so this
   stays fully offline.

   DROP-IN: replace js/pageManager.js with this file. No other file needs editing.

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

  // Active drag state (null when not dragging).
  let drag = null;

  /* --------- Fixed geometry (kept in sync between JS render and CSS) -------- */
  const CARD_W   = 160;   // fixed card / column width (px)
  const THUMB_H  = 196;   // fixed thumbnail box height (px) -> uniform rows
  const THUMB_PAD = 8;    // padding inside the thumb box (px)
  const DRAG_THRESHOLD = 5;

  /* ------------------------------ Injected CSS --------------------------- */
  const PM_STYLE = `
    /* ---- Modal shell: a column that never grows past the viewport. ---- */
    .pm-modal {
      width: min(1040px, calc(100vw - 40px)) !important;
      max-height: calc(100vh - 60px) !important;
      display: flex !important; flex-direction: column !important; gap: 12px !important;
    }

    /* ---- Fixed-width, wrapping, vertically scrolling grid. ----
       FIXED columns (no 1fr) = tabs never resize; they wrap + scroll instead. */
    .pm-grid {
      display: grid !important;
      grid-template-columns: repeat(auto-fill, ${CARD_W}px) !important;
      justify-content: center !important;
      align-content: start !important;
      gap: 14px !important;
      padding: 6px !important;
      flex: 1 1 auto !important;
      min-height: 140px !important;
      overflow-y: auto !important;   /* the scrolling action you wanted */
      overflow-x: hidden !important;
    }

    /* ---- Each tab: a fixed-size card. ---- */
    .pm-card {
      width: ${CARD_W}px !important;
      box-sizing: border-box !important;
      cursor: grab;
      touch-action: none;            /* let pointer events drive the drag */
      will-change: transform;
    }
    .pm-card .pm-thumb {
      height: ${THUMB_H}px !important;
      min-height: ${THUMB_H}px !important;
      padding: ${THUMB_PAD}px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      background: #fff;
      overflow: hidden;
    }
    .pm-card .pm-thumb canvas {
      max-width: 100% !important;
      max-height: 100% !important;
      width: auto !important;
      height: auto !important;
    }

    /* ---- The page being dragged: floats under the cursor. ---- */
    .pm-card.pm-lifting {
      box-shadow: 0 18px 42px rgba(0,0,0,.45);
      border-color: var(--accent);
      cursor: grabbing;
      opacity: .98;
    }
    /* ---- The gap that shows where the page will drop. ---- */
    .pm-card.pm-placeholder {
      background: var(--accent-soft);
      border: 2px dashed var(--accent) !important;
      box-shadow: none;
      pointer-events: none;
    }
    .pm-card.pm-placeholder > * { visibility: hidden; }

    @media (max-width: 720px) {
      .pm-grid { grid-template-columns: repeat(auto-fill, 132px) !important; }
      .pm-card { width: 132px !important; }
      .pm-card .pm-thumb { height: 164px !important; min-height: 164px !important; }
    }
  `;
  function injectStyle() {
    let s = document.getElementById("pm-style");
    if (!s) { s = document.createElement("style"); s.id = "pm-style"; document.head.appendChild(s); }
    s.textContent = PM_STYLE;   // (re)write so updates take effect on reload
  }

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
    injectStyle();                 // ensure styles are present even if shell was reused
    backdrop.classList.add("show");
    drawGrid();
    updateCount();
  }

  function buildShell() {
    injectStyle();
    backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop pm-backdrop";
    backdrop.innerHTML =
      '<div class="modal pm-modal" role="dialog" aria-modal="true" aria-label="Manage PDF pages">' +
        '<div class="pm-head">' +
          '<h3>Manage pages</h3>' +
          '<span class="pm-count" id="pm-count"></span>' +
          '<span class="pm-spacer"></span>' +
          '<button class="btn has-label" data-act="merge-lib"><span data-icon="plus"></span><span>Add from Library</span></button>' +
          '<button class="btn has-label" data-act="merge-file"><span data-icon="upload"></span><span>Add PDF file</span></button>' +
        '</div>' +
        '<p class="pm-hint">Drag a page to reorder — the others slide aside to show where it will land. Use the buttons on each page to rotate or remove it. Removed pages are excluded from the exported PDF.</p>' +
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
    el.dataset.uid = entry.uid;
    el.innerHTML =
      '<div class="pm-thumb"><canvas></canvas>' +
        '<span class="pm-num">' + (index + 1) + '</span>' +
        (entry.deleted ? '<span class="pm-del-badge">Removed</span>' : '') +
      '</div>' +
      '<div class="pm-card-bar">' +
        '<button class="pm-ic" data-op="rotate" title="Rotate 90 degrees" aria-label="Rotate page">' + ic("rotateCw") + '</button>' +
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

    // Smooth pointer-driven reorder (replaces native drag-and-drop).
    el.addEventListener("pointerdown", (e) => onCardPointerDown(e, entry, el));

    return el;
  }

  // Render the page so it fits INSIDE the fixed thumbnail box (both axes),
  // giving uniform rows regardless of portrait/landscape pages.
  async function renderThumb(entry, canvas) {
    const src = sources.get(entry.srcKey);
    if (!src || !canvas) return;
    try {
      const page = await src.pdf.getPage(entry.srcIndex + 1);
      const base = page.getViewport({ scale: 1, rotation: entry.rotation });
      // Available area inside the thumb box (minus padding).
      const maxW = CARD_W - 2 * THUMB_PAD - 4;     // a little inner breathing room
      const maxH = THUMB_H - 2 * THUMB_PAD;
      const scale = Math.min(maxW / base.width, maxH / base.height);
      const vp = page.getViewport({ scale, rotation: entry.rotation });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(vp.width * dpr));
      canvas.height = Math.max(1, Math.floor(vp.height * dpr));
      canvas.style.width = Math.floor(vp.width) + "px";
      canvas.style.height = Math.floor(vp.height) + "px";
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
      await page.render({ canvasContext: ctx, viewport: vp, transform }).promise;
    } catch (e) { /* leave blank on failure */ }
  }

  /* --------------------- Smooth reorder (FLIP) --------------------------- */
  function onCardPointerDown(e, entry, el) {
    if (busy) return;
    if (e.button != null && e.button !== 0) return;     // left button / primary touch only
    if (entry.deleted) return;                          // removed pages aren't reorderable
    if (e.target.closest(".pm-ic")) return;             // let rotate / delete buttons work
    if (drag) return;

    const rect = el.getBoundingClientRect();
    drag = {
      entry, card: el, pointerId: e.pointerId,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      startX: e.clientX, startY: e.clientY,
      w: rect.width, h: rect.height,
      active: false, placeholder: null
    };
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.active) {
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      activateDrag(e);
    }
    // Follow the cursor.
    drag.card.style.left = (e.clientX - drag.offsetX) + "px";
    drag.card.style.top  = (e.clientY - drag.offsetY) + "px";
    updateDropTarget(e);
    autoScroll(e);
  }

  function activateDrag(e) {
    const el = drag.card;

    // Placeholder occupies the page's grid cell so siblings keep their flow.
    const ph = document.createElement("div");
    ph.className = "pm-card pm-placeholder";
    ph.style.width = drag.w + "px";
    ph.style.height = drag.h + "px";
    drag.placeholder = ph;
    gridEl.insertBefore(ph, el);

    // Lift the page out of flow so it can float under the cursor.
    el.classList.add("pm-lifting");
    el.style.position = "fixed";
    el.style.zIndex = "1000";
    el.style.margin = "0";
    el.style.width = drag.w + "px";
    el.style.height = drag.h + "px";
    el.style.left = (e.clientX - drag.offsetX) + "px";
    el.style.top  = (e.clientY - drag.offsetY) + "px";
    el.style.pointerEvents = "none";
    el.style.transition = "none";
    drag.active = true;
  }

  // Auto-scroll the grid when the dragged page nears the top/bottom edge.
  function autoScroll(e) {
    const r = gridEl.getBoundingClientRect();
    const margin = 48, speed = 14;
    if (e.clientY < r.top + margin)        gridEl.scrollTop -= speed;
    else if (e.clientY > r.bottom - margin) gridEl.scrollTop += speed;
  }

  function updateDropTarget(e) {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const overCard = under && under.closest(".pm-card");
    if (!overCard || overCard === drag.card || overCard === drag.placeholder) return;
    if (!gridEl.contains(overCard)) return;

    const r = overCard.getBoundingClientRect();
    const midX = r.left + r.width / 2;
    const midY = r.top + r.height / 2;
    // Reading-order test: past the vertical midline => after; same row & past
    // the horizontal midline => after; otherwise before.
    const after = (e.clientY > midY) || (e.clientY > r.top && e.clientX > midX);

    const ref = after ? overCard.nextSibling : overCard;
    if (ref === drag.placeholder) return;               // already in that slot
    if (after && overCard.nextSibling === drag.placeholder) return;

    flipReorder(() => gridEl.insertBefore(drag.placeholder, ref));
  }

  // FLIP: record positions, mutate the DOM, then animate each card from where
  // it was to where it now is — the smooth "slide aside" effect.
  function flipReorder(mutate) {
    const items = Array.from(gridEl.children).filter((c) => c !== drag.card);
    const first = new Map();
    items.forEach((c) => first.set(c, c.getBoundingClientRect()));

    mutate();

    items.forEach((c) => {
      const f = first.get(c);
      if (!f) return;
      const last = c.getBoundingClientRect();
      const dx = f.left - last.left;
      const dy = f.top - last.top;
      if (!dx && !dy) return;
      c.style.transition = "none";
      c.style.transform = "translate(" + dx + "px," + dy + "px)";
      // Next frame: release to the final position with a transition.
      requestAnimationFrame(() => {
        c.style.transition = "transform 200ms cubic-bezier(.2,.8,.2,1)";
        c.style.transform = "";
      });
    });
  }

  function onPointerUp() {
    if (!drag) return;
    const el = drag.card;
    try { el.releasePointerCapture(drag.pointerId); } catch (_) {}
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerUp);

    if (!drag.active) { drag = null; return; }          // a click, not a drag

    const ph = drag.placeholder;
    const target = ph.getBoundingClientRect();
    const cur = el.getBoundingClientRect();

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", finish);

      // Drop the page into the placeholder's slot and clear all drag styling.
      el.classList.remove("pm-lifting");
      ["position", "zIndex", "margin", "width", "height", "left", "top", "pointerEvents", "transition", "transform"]
        .forEach((p) => { el.style[p] = ""; });
      gridEl.insertBefore(el, ph);
      ph.remove();

      commitOrderFromDom();
      renumber();
      drag = null;
    };

    // Animate the lifted page home, then snap it into the grid.
    el.style.transition = "left 180ms cubic-bezier(.2,.8,.2,1), top 180ms cubic-bezier(.2,.8,.2,1)";
    el.style.left = target.left + "px";
    el.style.top = target.top + "px";
    el.addEventListener("transitionend", finish);
    setTimeout(finish, 240);                            // fallback if no transitionend fires
  }

  // Rebuild model order to match the on-screen page order.
  function commitOrderFromDom() {
    const order = {};
    let i = 0;
    gridEl.querySelectorAll(".pm-card:not(.pm-placeholder)").forEach((c) => { order[c.dataset.uid] = i++; });
    model.sort((a, b) => (order[a.uid] ?? 0) - (order[b.uid] ?? 0));
  }

  // Refresh the visible page numbers without re-rendering thumbnails.
  function renumber() {
    let n = 0;
    gridEl.querySelectorAll(".pm-card:not(.pm-placeholder)").forEach((c) => {
      n += 1;
      const num = c.querySelector(".pm-num");
      if (num) num.textContent = n;
    });
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
    App.toast("Building PDF...", "info");
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
    drag = null;
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
