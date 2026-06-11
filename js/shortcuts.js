/* =============================================================================
   shortcuts.js — Global keyboard shortcuts.

     Ctrl/Cmd + F   Toggle find-in-PDF (reader)
     Ctrl/Cmd + S   Save session locally
     + / =          Zoom in           (reader)
     -              Zoom out          (reader)
     ← / →          Previous / next page (reader)
     Esc            Exit fullscreen → close search → deselect annotation

   Page/zoom keys are ignored while typing in an input, textarea or editable
   field, and only act in the reader view. Exposed as window.App.Shortcuts.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;

  function init() { document.addEventListener("keydown", onKey); }

  function typing(e) {
    const t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }
  function inReader() { return App.currentView === "reader"; }

  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;

    if (mod && (e.key === "f" || e.key === "F")) {
      if (!inReader()) App.switchView("reader");
      e.preventDefault(); App.Search.open(); return;
    }
    if (mod && (e.key === "s" || e.key === "S")) {
      e.preventDefault(); if (App.saveSession) App.saveSession(true); return;
    }

    if (e.key === "Escape") {
      if (App.Viewer && App.Viewer.isFullscreen && App.Viewer.isFullscreen()) { App.Viewer.toggleFullscreen(); return; }
      const shell = document.querySelector(".app-shell");
      if (shell && !shell.classList.contains("search-hidden")) { App.Search.close(); return; }
      if (App.state.selectedAnnoId) { App.Annotations.deselect(); return; }
      return;
    }

    if (typing(e) || mod) return;        // remaining shortcuts need a "clean" key press
    if (!inReader() || !App.state.pdfDoc) return;

    if (e.key === "+" || e.key === "=") { e.preventDefault(); App.Viewer.zoomIn(); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); App.Viewer.zoomOut(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); App.Viewer.prevPage(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); App.Viewer.nextPage(); }
    else if (e.key === "Home") { e.preventDefault(); App.Viewer.goToPage(1); }
    else if (e.key === "End") { e.preventDefault(); App.Viewer.goToPage(App.state.totalPages); }
  }

  App.Shortcuts = { init };
})();
