/* =============================================================================
   pdfViewer.js — PDF.js integration and the core viewing surface.

   Responsibilities:
     - Configure PDF.js (with a main-thread fallback that works on file://).
     - Load a document from raw bytes.
     - Render the current page to a HiDPI canvas + a selectable text layer.
     - Page navigation, zoom (incl. fit-to-width / fit-to-page), rotation,
       and fullscreen reading mode.
     - Expose the page viewport (used by the annotation layer to convert
       between screen and PDF coordinates) and cached page text (for search).

   Emits on App.bus:
     doc:loaded { meta }     doc:closed
     page:rendered { page, viewport, container }
     page:changed { page }   zoom:changed { scale }   rotation:changed { rotation }
     fullscreen:changed { active }
   Exposed as window.App.Viewer.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus, util } = App;
  const pdfjsLib = window.pdfjsLib;

  // Use the bundled worker. On file:// in Chrome the Worker constructor is
  // blocked; PDF.js then transparently loads this same file as a classic
  // <script> and runs on the main thread, so viewing still works offline.
  pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";

  const VIEWER_PAD = 28;   // matches .viewer padding in CSS
  let els = {};
  let renderTask = null;
  let renderToken = 0;     // guards against overlapping renders
  const textCache = new Map();   // pageNum -> textContent
  let currentTextDivs = [];

  function init() {
    els = {
      viewerWrap: document.getElementById("viewer-wrap"),
      viewer: document.getElementById("viewer"),
      container: document.getElementById("page-container"),
      canvas: document.getElementById("pdf-canvas"),
      textLayer: document.getElementById("text-layer"),
      loader: document.getElementById("page-loader"),
      drop: document.getElementById("drop-overlay"),
      indicator: document.getElementById("page-indicator"),
    };

    // Recompute fit when the viewport size changes.
    const onResize = util.debounce(() => {
      if (!state.pdfDoc) return;
      if (state.fitMode === "width") fitWidth();
      else if (state.fitMode === "page") fitPage();
    }, 150);
    window.addEventListener("resize", onResize);

    document.addEventListener("fullscreenchange", () => {
      const active = !!document.fullscreenElement;
      bus.emit("fullscreen:changed", { active });
      if (state.pdfDoc && (state.fitMode === "width" || state.fitMode === "page")) {
        // give the browser a tick to settle fullscreen size
        setTimeout(() => (state.fitMode === "page" ? fitPage() : fitWidth()), 60);
      }
    });
  }

  /* ----------------------------- Loading --------------------------------- */
  async function loadDocument(bytes, meta) {
    // Tear down any previous document.
    if (state.pdfDoc) { try { await state.pdfDoc.destroy(); } catch (e) {} }
    textCache.clear();
    currentTextDivs = [];

    // Clone the bytes — PDF.js may detach the underlying buffer.
    const data = bytes instanceof Uint8Array
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.slice(0));

    const loadingTask = pdfjsLib.getDocument({
      data,
      // standardFontDataUrl/cMapUrl omitted: we run fully offline. Documents
      // using non-embedded CJK/exotic fonts may show fallback glyphs.
      isEvalSupported: false,
    });
    const pdf = await loadingTask.promise;

    state.pdfDoc = pdf;
    state.docId = meta.id;
    state.docMeta = meta;
    state.totalPages = pdf.numPages;
    state.page = util.clamp(meta.lastPage || 1, 1, pdf.numPages);
    state.rotation = ((meta.rotation || 0) % 360 + 360) % 360;
    state.selectedAnnoId = null;

    hideDrop();
    bus.emit("doc:loaded", { meta });

    if (meta.fitMode === "custom" && meta.scale) {
      state.fitMode = "custom";
      await setScale(meta.scale, "custom");
    } else if (meta.fitMode === "page") {
      await fitPage();
    } else {
      await fitWidth();
    }
    flashIndicator();
  }

  function closeDocument() {
    if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch (e) {} }
    state.pdfDoc = null; state.docId = null; state.docMeta = null;
    state.totalPages = 0; state.page = 1; state.viewport = null;
    state.textItems = []; state.annotations = []; state.notes = [];
    textCache.clear(); currentTextDivs = [];
    els.textLayer.innerHTML = "";
    const ctx = els.canvas.getContext("2d");
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    showDrop();
    bus.emit("doc:closed", {});
  }

  /* ----------------------------- Rendering ------------------------------- */
  async function renderPage() {
    if (!state.pdfDoc) return;
    const token = ++renderToken;
    state.rendering = true;
    showLoader(true);

    if (renderTask) { try { renderTask.cancel(); } catch (e) {} renderTask = null; }

    let page;
    try {
      page = await state.pdfDoc.getPage(state.page);
    } catch (e) {
      if (token === renderToken) { showLoader(false); state.rendering = false; }
      return;
    }
    if (token !== renderToken) return; // superseded

    const viewport = page.getViewport({ scale: state.scale, rotation: state.rotation });
    state.viewport = viewport;

    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    const dpr = window.devicePixelRatio || 1;

    // Size the page container and its layers.
    els.container.style.width = w + "px";
    els.container.style.height = h + "px";
    els.container.classList.remove("hidden");

    els.canvas.width = Math.floor(viewport.width * dpr);
    els.canvas.height = Math.floor(viewport.height * dpr);
    els.canvas.style.width = w + "px";
    els.canvas.style.height = h + "px";

    const ctx = els.canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);

    const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
    renderTask = page.render({ canvasContext: ctx, viewport, transform });

    try {
      await renderTask.promise;
    } catch (e) {
      if (e && e.name === "RenderingCancelledException") return;
      console.error("Render error:", e);
    }
    if (token !== renderToken) return;
    renderTask = null;

    await renderTextLayer(page, viewport, token);
    if (token !== renderToken) return;

    showLoader(false);
    state.rendering = false;
    bus.emit("page:rendered", { page: state.page, viewport, container: els.container });
  }

  async function renderTextLayer(page, viewport, token) {
    let textContent = textCache.get(state.page);
    if (!textContent) {
      textContent = await page.getTextContent();
      textCache.set(state.page, textContent);
    }
    if (token !== renderToken) return;

    state.textItems = textContent.items;
    els.textLayer.innerHTML = "";
    els.textLayer.style.width = Math.floor(viewport.width) + "px";
    els.textLayer.style.height = Math.floor(viewport.height) + "px";
    // Required by PDF.js renderTextLayer for correct glyph scaling.
    els.textLayer.style.setProperty("--scale-factor", viewport.scale);

    const textDivs = [];
    try {
      const task = pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        container: els.textLayer,
        viewport,
        textDivs,
      });
      await task.promise;
    } catch (e) {
      // Non-fatal: selection/search highlighting degrade gracefully.
      console.warn("Text layer render issue:", e);
    }
    currentTextDivs = textDivs;
  }

  /* --------------------------- Navigation -------------------------------- */
  function goToPage(n) {
    if (!state.pdfDoc) return;
    n = util.clamp(Math.round(n), 1, state.totalPages);
    if (n === state.page && state.viewport) { bus.emit("page:changed", { page: n }); return; }
    state.page = n;
    state.selectedAnnoId = null;
    renderPage();
    bus.emit("page:changed", { page: n });
    flashIndicator();
  }
  function nextPage() { goToPage(state.page + 1); }
  function prevPage() { goToPage(state.page - 1); }

  /* ------------------------------- Zoom ---------------------------------- */
  async function setScale(scale, fitMode) {
    if (!state.pdfDoc) return;
    state.scale = util.clamp(scale, App.ZOOM_MIN, App.ZOOM_MAX);
    state.fitMode = fitMode || "custom";
    await renderPage();
    bus.emit("zoom:changed", { scale: state.scale, fitMode: state.fitMode });
  }
  function zoomIn()  { setScale(state.scale + App.ZOOM_STEP, "custom"); }
  function zoomOut() { setScale(state.scale - App.ZOOM_STEP, "custom"); }
  function resetZoom() { setScale(1.0, "custom"); }

  async function baseViewportSize() {
    const page = await state.pdfDoc.getPage(state.page);
    const vp = page.getViewport({ scale: 1, rotation: state.rotation });
    return { w: vp.width, h: vp.height };
  }
  async function fitWidth() {
    if (!state.pdfDoc) return;
    const { w } = await baseViewportSize();
    const avail = els.viewer.clientWidth - VIEWER_PAD * 2;
    await setScale(avail / w, "width");
  }
  async function fitPage() {
    if (!state.pdfDoc) return;
    const { w, h } = await baseViewportSize();
    const availW = els.viewer.clientWidth - VIEWER_PAD * 2;
    const availH = els.viewer.clientHeight - VIEWER_PAD * 2;
    await setScale(Math.min(availW / w, availH / h), "page");
  }

  /* ------------------------------ Rotate --------------------------------- */
  async function rotate(delta) {
    if (!state.pdfDoc) return;
    state.rotation = (((state.rotation + delta) % 360) + 360) % 360;
    if (state.fitMode === "width") await fitWidth();
    else if (state.fitMode === "page") await fitPage();
    else await renderPage();
    bus.emit("rotation:changed", { rotation: state.rotation });
  }

  /* ---------------------------- Fullscreen ------------------------------- */
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (els.viewerWrap.requestFullscreen) {
      els.viewerWrap.requestFullscreen().catch((e) => App.toast("Fullscreen blocked: " + e.message, "warn"));
    } else {
      App.toast("Fullscreen not supported in this browser", "warn");
    }
  }
  function isFullscreen() { return !!document.fullscreenElement; }

  /* ----------------------------- Helpers --------------------------------- */
  function showLoader(on) { els.loader.classList.toggle("show", !!on); }
  function showDrop() { els.drop.classList.remove("hidden"); els.container.classList.add("hidden"); els.viewer.classList.add("empty"); }
  function hideDrop() { els.drop.classList.add("hidden"); els.viewer.classList.remove("empty"); }

  let indicatorTimer = null;
  function flashIndicator() {
    if (!state.pdfDoc) return;
    els.indicator.textContent = "Page " + state.page + " / " + state.totalPages;
    els.indicator.classList.add("show");
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => els.indicator.classList.remove("show"), 1100);
  }

  // Cached page text used by the search module (string + per-item ranges).
  async function getPageText(pageNum) {
    let tc = textCache.get(pageNum);
    if (!tc) {
      const page = await state.pdfDoc.getPage(pageNum);
      tc = await page.getTextContent();
      textCache.set(pageNum, tc);
    }
    return tc;
  }
  function getCurrentTextDivs() { return currentTextDivs; }
  function getViewer() { return els.viewer; }
  function getContainer() { return els.container; }

  App.Viewer = {
    init, loadDocument, closeDocument, renderPage,
    goToPage, nextPage, prevPage,
    setScale, zoomIn, zoomOut, resetZoom, fitWidth, fitPage,
    rotate, toggleFullscreen, isFullscreen,
    getPageText, getCurrentTextDivs, getViewer, getContainer,
    showDrop, hideDrop,
  };
})();
