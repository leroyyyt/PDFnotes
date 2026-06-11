/* =============================================================================
   core.js — Central application state, a tiny event bus, shared constants,
   and common UI utilities (toasts, confirm dialog, formatters).
   Exposed as window.App.
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------------------
     Constants
     ------------------------------------------------------------------------ */
  const TOOLS = [
    "select", "highlight", "underline", "strikethrough",
    "sticky", "freetext", "rectangle", "circle", "arrow", "freehand",
  ];

  // Tools that draw on the vector canvas (capture pointer events on the page).
  const DRAW_TOOLS = ["highlight", "underline", "strikethrough", "rectangle", "circle", "arrow", "freehand"];
  // Tools placed as a single click (DOM annotations).
  const CLICK_TOOLS = ["sticky", "freetext"];

  const SWATCHES = ["#ffb020", "#5b9dff", "#38cf90", "#ff5f5f", "#c879ff", "#1a1f29"];

  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 5.0;
  const ZOOM_STEP = 0.2;

  /* ---------------------------------------------------------------------------
     Central state (single source of truth)
     ------------------------------------------------------------------------ */
  const state = {
    pdfDoc: null,          // PDF.js PDFDocumentProxy
    docId: null,           // identifier of the current document
    docMeta: null,         // { id, name, size, pageCount, addedAt, lastOpened }
    page: 1,
    totalPages: 0,
    scale: 1.0,
    rotation: 0,           // 0 | 90 | 180 | 270
    fitMode: "width",      // 'width' | 'page' | 'custom'
    tool: "select",
    color: SWATCHES[0],
    viewport: null,        // current rendered page viewport (for coord conversion)
    textItems: [],         // text items for the currently rendered page
    annotations: [],       // annotations for the current document
    notes: [],             // notes for the current document
    selectedAnnoId: null,
    search: { query: "", caseSensitive: false, matches: [], current: -1 },
    theme: "dark",
    rendering: false,
  };

  /* ---------------------------------------------------------------------------
     Event bus (pub/sub) — modules communicate without hard references.
     ------------------------------------------------------------------------ */
  const listeners = {};
  const bus = {
    on(evt, fn) {
      (listeners[evt] || (listeners[evt] = [])).push(fn);
      return () => bus.off(evt, fn);
    },
    off(evt, fn) {
      if (listeners[evt]) listeners[evt] = listeners[evt].filter((f) => f !== fn);
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((fn) => {
        try { fn(payload); } catch (e) { console.error("bus handler error for", evt, e); }
      });
    },
  };

  /* ---------------------------------------------------------------------------
     Small utilities
     ------------------------------------------------------------------------ */
  function uid(prefix) {
    return (prefix || "id") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB"];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v < 10 ? 1 : 0) + " " + units[i];
  }

  function formatDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return "Today " + time;
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString([], opts) + " " + time;
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /* ---------------------------------------------------------------------------
     Toast notifications
     ------------------------------------------------------------------------ */
  let toastStack = null;
  function ensureToastStack() {
    if (!toastStack) {
      toastStack = document.createElement("div");
      toastStack.className = "toast-stack";
      document.body.appendChild(toastStack);
    }
    return toastStack;
  }
  function toast(message, type) {
    type = type || "info";
    const iconName = { ok: "check", err: "alert", warn: "alert", info: "info" }[type] || "info";
    const node = document.createElement("div");
    node.className = "toast " + type;
    node.innerHTML = window.Icons.get(iconName) + "<span></span>";
    node.querySelector("span").textContent = message;
    ensureToastStack().appendChild(node);
    const remove = () => {
      node.classList.add("hide");
      setTimeout(() => node.remove(), 220);
    };
    const timer = setTimeout(remove, 3200);
    node.addEventListener("click", () => { clearTimeout(timer); remove(); });
  }

  /* ---------------------------------------------------------------------------
     Confirm dialog (promise-based)
     ------------------------------------------------------------------------ */
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        "<h3></h3><p></p>" +
        '<div class="row">' +
        '<button class="btn has-label" data-act="cancel"></button>' +
        '<button class="btn has-label" data-act="ok"></button>' +
        "</div></div>";
      backdrop.querySelector("h3").textContent = opts.title || "Are you sure?";
      backdrop.querySelector("p").textContent = opts.message || "";
      const cancelBtn = backdrop.querySelector('[data-act="cancel"]');
      const okBtn = backdrop.querySelector('[data-act="ok"]');
      cancelBtn.textContent = opts.cancelText || "Cancel";
      okBtn.textContent = opts.okText || "Confirm";
      okBtn.classList.add(opts.danger ? "danger" : "primary");
      if (opts.danger) { okBtn.style.background = "var(--danger)"; okBtn.style.color = "#fff"; }

      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add("show"));

      const close = (val) => {
        backdrop.classList.remove("show");
        setTimeout(() => backdrop.remove(), 160);
        document.removeEventListener("keydown", onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === "Escape") close(false);
        if (e.key === "Enter") close(true);
      };
      cancelBtn.addEventListener("click", () => close(false));
      okBtn.addEventListener("click", () => close(true));
      backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(false); });
      document.addEventListener("keydown", onKey);
      setTimeout(() => okBtn.focus(), 30);
    });
  }

  /* ---------------------------------------------------------------------------
     Download helper (works on file:// — no server needed)
     ------------------------------------------------------------------------ */
  function downloadFile(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
  }

  /* ---------------------------------------------------------------------------
     Expose
     ------------------------------------------------------------------------ */
  window.App = {
    state, bus,
    Icons: window.Icons,   // icons.js is loaded before core.js
    TOOLS, DRAW_TOOLS, CLICK_TOOLS, SWATCHES, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP,
    util: { uid, escapeHtml, formatBytes, formatDate, debounce, clamp, downloadFile },
    toast, confirmDialog,
    // sub-modules attach themselves below (Storage, Viewer, Thumbs, Search, Annotations, Notes, Exporter)
  };
})();
