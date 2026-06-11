/* =============================================================================
   app.js — Application orchestrator.

   Boots every module, owns top-level navigation between the seven views,
   wires the reader toolbar + document library, restores/saves the session,
   handles file open & drag-drop, and renders the annotations list.

   Provides shared helpers used across modules:
     App.currentView, App.switchView(name),
     App.openDocumentById(docId, page), App.getDocuments(), App.saveSession()
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus, util } = App;
  App.Icons = window.Icons;   // defensive alias

  const VIEWS = ["reader", "notes", "literature", "citations", "figures", "projects", "engineering", "search"];
  let docsCache = [];

  App.currentView = "reader";
  App.getDocuments = () => docsCache.slice();

  document.addEventListener("DOMContentLoaded", boot);

  async function boot() {
    applyStoredTheme();

    // Initialise modules. Order: viewer + reader pieces, then data modules.
    App.Viewer.init();
    App.Annotations.init();
    App.Thumbs.init();
    App.Search.init();
    App.Notes.init();
    App.Projects.init();      // sets up App.activeProjectId + helpers
    App.Literature.init();
    App.Citations.init();
    App.Figures.init();
    App.OCR.init();
    App.GlobalSearch.init();
    App.Shortcuts.init();

    // Phase 3 — Engineering Workspace modules.
    App.Tags.init();
    App.Formulas.init();
    App.Checklists.init();
    App.Safety.init();
    App.Converter.init();
    App.Compare.init();
    App.ExportCentre.init();
    App.Engineering.init();
    App.Palette.init();

    wireNav();
    wireToolbar();
    wireSidebars();
    wireFileInput();
    wireMenu();
    bindStateSync();

    // Accessibility polish: every icon-only button with a tooltip gets a
    // matching aria-label (later-created buttons set their own).
    document.querySelectorAll("button[title]:not([aria-label])").forEach((b) => b.setAttribute("aria-label", b.title));

    App.Viewer.showDrop();
    await refreshDocsList();
    await restoreSession();
  }

  /* ============================ Navigation =============================== */
  function wireNav() {
    document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });
  }
  function switchView(name) {
    if (VIEWS.indexOf(name) === -1) name = "reader";
    App.currentView = name;
    VIEWS.forEach((v) => {
      const view = document.getElementById("view-" + v);
      if (view) view.classList.toggle("active", v === name);
      const nav = document.querySelector('.nav-item[data-view="' + v + '"]');
      if (nav) nav.classList.toggle("active", v === name);
    });
    bus.emit("view:changed", { name });
    if (name === "reader" && state.pdfDoc) {
      // re-fit in case the window changed while away
      if (state.fitMode === "width") App.Viewer.fitWidth();
      else if (state.fitMode === "page") App.Viewer.fitPage();
    }
  }
  App.switchView = switchView;

  /* ============================== Toolbar ================================ */
  function wireToolbar() {
    on("open-file", "click", () => document.getElementById("file-input").click());

    on("btn-prev", "click", () => App.Viewer.prevPage());
    on("btn-next", "click", () => App.Viewer.nextPage());
    const pageInput = document.getElementById("page-input");
    if (pageInput) pageInput.addEventListener("change", () => App.Viewer.goToPage(parseInt(pageInput.value, 10) || 1));

    on("btn-zoom-in", "click", () => App.Viewer.zoomIn());
    on("btn-zoom-out", "click", () => App.Viewer.zoomOut());
    on("btn-fit-width", "click", () => App.Viewer.fitWidth());
    on("btn-fit-page", "click", () => App.Viewer.fitPage());
    on("btn-rotate-ccw", "click", () => App.Viewer.rotate(-90));
    on("btn-rotate-cw", "click", () => App.Viewer.rotate(90));
    on("btn-fullscreen", "click", () => App.Viewer.toggleFullscreen());

    // annotation tools
    document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
      btn.addEventListener("click", () => App.Annotations.setTool(btn.dataset.tool));
    });
    on("btn-clear-page", "click", () => App.Annotations.clearPage());

    // colours
    document.querySelectorAll("#swatches .swatch[data-color]").forEach((sw) => {
      sw.addEventListener("click", () => App.Annotations.setColor(sw.dataset.color));
    });
    const picker = document.getElementById("color-picker");
    if (picker) picker.addEventListener("input", () => App.Annotations.setColor(picker.value));

    on("btn-search", "click", () => App.Search.toggle());
    on("btn-export-pdf", "click", () => App.Exporter.exportEditedPdf());
    on("btn-pages", "click", () => App.PageManager.open());
    on("btn-save", "click", () => saveSession(true));
    on("btn-theme", "click", toggleTheme);
    on("btn-toggle-left", "click", () => document.querySelector(".app-shell").classList.toggle("left-collapsed"));
    on("btn-toggle-right", "click", () => document.querySelector(".app-shell").classList.toggle("right-collapsed"));

    // reflect the initial tool / colour
    markActiveTool(state.tool);
    markActiveColor(state.color);
  }

  function bindStateSync() {
    bus.on("tool:changed", (p) => markActiveTool(p.tool));
    bus.on("color:changed", (p) => markActiveColor(p.color));
    bus.on("zoom:changed", (p) => { const z = document.getElementById("zoom-level"); if (z) z.textContent = Math.round(p.scale * 100) + "%"; syncFitButtons(p.fitMode); });
    bus.on("page:changed", syncPageUI);
    bus.on("doc:loaded", () => { syncPageUI(); enableReaderControls(true); });
    bus.on("doc:closed", () => { enableReaderControls(false); renderAnnoList(); });
    bus.on("annotations:changed", renderAnnoList);
    bus.on("annotations:selection", highlightAnnoInList);

    // session autosave
    const save = util.debounce(() => saveSession(false), 600);
    ["page:changed", "zoom:changed", "rotation:changed"].forEach((ev) => bus.on(ev, save));

    // documents / projects refresh
    bus.on("documents:reload", refreshDocsList);
    bus.on("data:imported", refreshDocsList);
    bus.on("projects:changed", refreshDocsList);
  }

  function markActiveTool(tool) {
    document.querySelectorAll(".tool-btn[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  }
  function markActiveColor(color) {
    document.querySelectorAll("#swatches .swatch[data-color]").forEach((s) => s.classList.toggle("sel", s.dataset.color === color));
    const picker = document.getElementById("color-picker");
    if (picker && /^#([0-9a-f]{6})$/i.test(color)) picker.value = color;
  }
  function syncPageUI() {
    const pi = document.getElementById("page-input");
    const pt = document.getElementById("page-total");
    if (pi) pi.value = state.page || 1;
    if (pt) pt.textContent = "/ " + (state.totalPages || 0);
    const prev = document.getElementById("btn-prev"), next = document.getElementById("btn-next");
    if (prev) prev.disabled = !state.pdfDoc || state.page <= 1;
    if (next) next.disabled = !state.pdfDoc || state.page >= state.totalPages;
  }
  function syncFitButtons(fitMode) {
    const fw = document.getElementById("btn-fit-width"), fp = document.getElementById("btn-fit-page");
    if (fw) fw.classList.toggle("active", fitMode === "width");
    if (fp) fp.classList.toggle("active", fitMode === "page");
  }
  function enableReaderControls(on) {
    const ids = ["btn-prev", "btn-next", "page-input", "btn-zoom-in", "btn-zoom-out", "btn-fit-width",
      "btn-fit-page", "btn-rotate-ccw", "btn-rotate-cw", "btn-fullscreen", "btn-clear-page", "btn-search",
      "ocr-open", "capture-toggle", "btn-export-pdf", "btn-pages"];
    ids.forEach((id) => { const el = document.getElementById(id); if (el) el.disabled = !on; });
    document.querySelectorAll(".tool-btn[data-tool]").forEach((b) => (b.disabled = !on));
    if (on) syncPageUI();
  }

  /* ============================== Sidebars =============================== */
  function wireSidebars() {
    tabPair("tab-docs", "tab-pages", "pane-docs", "pane-pages");
    tabPair("tab-notes", "tab-anno", "pane-notes", "pane-anno");
    on("docs-clear", "click", clearLibrary);
  }
  function tabPair(aId, bId, paneA, paneB) {
    const a = document.getElementById(aId), b = document.getElementById(bId);
    const pa = document.getElementById(paneA), pb = document.getElementById(paneB);
    if (!a || !b) return;
    const sel = (showA) => {
      a.classList.toggle("active", showA); b.classList.toggle("active", !showA);
      if (pa) pa.classList.toggle("active", showA);
      if (pb) pb.classList.toggle("active", !showA);
    };
    a.addEventListener("click", () => sel(true));
    b.addEventListener("click", () => sel(false));
  }

  /* ====================== Annotations list (right) ======================= */
  const ANNO_LABEL = {
    highlight: "Highlight", underline: "Underline", strikethrough: "Strikethrough",
    rectangle: "Rectangle", circle: "Circle", arrow: "Arrow", freehand: "Freehand",
    sticky: "Sticky note", freetext: "Text box",
  };
  const ANNO_ICON = {
    highlight: "highlighter", underline: "underline", strikethrough: "strike",
    rectangle: "square", circle: "circle", arrow: "arrow", freehand: "pen",
    sticky: "note", freetext: "text",
  };
  function renderAnnoList() {
    const list = document.getElementById("anno-list");
    if (!list) return;
    const anns = state.annotations.slice().sort((a, b) => (a.page - b.page) || (a.createdAt - b.createdAt));
    const pill = document.getElementById("anno-count-pill");
    if (pill) { pill.textContent = anns.length || ""; pill.style.display = anns.length ? "" : "none"; }
    if (!state.pdfDoc) { list.innerHTML = emptyState("layers", "Open a PDF to see its annotations."); return; }
    if (!anns.length) { list.innerHTML = emptyState("layers", "No annotations yet. Pick a tool from the toolbar and mark up the page."); return; }
    list.innerHTML = "";
    anns.forEach((a) => list.appendChild(annoItem(a)));
  }
  function annoItem(a) {
    const el = document.createElement("div");
    el.className = "anno-item"; el.dataset.id = a.id;
    const label = ANNO_LABEL[a.type] || a.type;
    const sub = a.text ? a.text : (a.quote ? "“" + a.quote + "”" : "");
    el.innerHTML =
      '<span class="anno-ico" style="color:' + (a.color || "#ffb020") + '">' + App.Icons.get(ANNO_ICON[a.type] || "square") + "</span>" +
      '<div class="anno-main"><div class="anno-line"><b></b><span class="anno-page">p.' + a.page + "</span></div>" +
      (sub ? '<div class="anno-sub"></div>' : "") + "</div>" +
      '<div class="anno-ops"></div>';
    el.querySelector("b").textContent = label;
    if (sub) el.querySelector(".anno-sub").textContent = sub;

    const ops = el.querySelector(".anno-ops");
    if (a.type === "highlight" || a.type === "underline" || a.type === "strikethrough") {
      ops.appendChild(miniBtn("note", "Save as research note", (e) => { e.stopPropagation(); App.Annotations.annotationToNote(a.id); }));
    }
    ops.appendChild(miniBtn("trash", "Delete", (e) => { e.stopPropagation(); App.Annotations.remove(a.id); }, "del"));

    el.addEventListener("click", () => {
      switchView("reader");
      App.Viewer.goToPage(a.page);
      setTimeout(() => App.Annotations.select(a.id), 60);
    });
    return el;
  }
  function highlightAnnoInList(p) {
    document.querySelectorAll("#anno-list .anno-item").forEach((el) => el.classList.toggle("active", p && el.dataset.id === p.id));
  }

  /* ============================ File loading ============================= */
  function wireFileInput() {
    const input = document.getElementById("file-input");
    if (input) input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      handleFiles(files);
      input.value = "";
    });

    const wrap = document.getElementById("viewer-wrap");
    if (wrap) {
      ["dragenter", "dragover"].forEach((ev) => wrap.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add("drag-over"); }));
      ["dragleave", "drop"].forEach((ev) => wrap.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === wrap) wrap.classList.remove("drag-over"); }));
      wrap.addEventListener("drop", (e) => {
        const files = Array.from(e.dataTransfer.files || []).filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
        if (files.length) handleFiles(files);
      });
    }
  }

  async function handleFiles(files) {
    const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { App.toast("Please choose a PDF file", "warn"); return; }
    let lastId = null;
    for (const file of pdfs) {
      try { lastId = await importFile(file); }
      catch (e) { console.error(e); App.toast("Couldn’t open " + file.name, "err"); }
    }
    await refreshDocsList();
    if (lastId) await openDocumentById(lastId, 1);
  }

  async function importFile(file) {
    const buf = await file.arrayBuffer();
    const id = await App.Storage.computeDocId(file, buf);
    await App.Storage.putFile(id, buf, { name: file.name, size: file.size, type: file.type });
    const existing = await App.Storage.getDoc(id);
    const meta = existing || {
      id, name: file.name, size: file.size, pageCount: 0,
      addedAt: Date.now(), lastOpened: Date.now(),
      projectId: App.activeProjectId || null,
    };
    meta.lastOpened = Date.now();
    if (App.activeProjectId && !existing) meta.projectId = App.activeProjectId;
    await App.Storage.putDoc(meta);
    return id;
  }

  async function openDocumentById(docId, page) {
    page = page || 1;
    if (state.docId === docId && state.pdfDoc) { switchView("reader"); App.Viewer.goToPage(page); return; }
    const fileRec = await App.Storage.getFile(docId);
    if (!fileRec || !fileRec.data) { App.toast("This PDF isn’t stored anymore — re-open the file", "warn"); return; }
    const meta = (await App.Storage.getDoc(docId)) || { id: docId, name: fileRec.name, size: fileRec.size };

    // Load annotations BEFORE the first render so they paint immediately.
    state.annotations = await App.Storage.getAnnotations(docId);

    meta.lastPage = page;
    switchView("reader");
    try {
      await App.Viewer.loadDocument(fileRec.data, meta);
    } catch (e) {
      console.error(e); App.toast("Failed to render this PDF", "err"); return;
    }
    // Persist page count + lastOpened now that it's known.
    meta.pageCount = state.totalPages;
    meta.lastOpened = Date.now();
    await App.Storage.putDoc(meta);
    if (page > 1) App.Viewer.goToPage(page);

    renderAnnoList();
    saveSession(false);
    bus.emit("documents:changed", {});
    await refreshDocsList();
  }
  App.openDocumentById = openDocumentById;

  /* =========================== Document library ========================== */
  async function refreshDocsList() {
    docsCache = await App.Storage.getAllDocs();
    const list = document.getElementById("docs-list");
    if (!list) return;

    let docs = docsCache.slice();
    if (App.activeProjectId) docs = docs.filter((d) => d.projectId === App.activeProjectId);

    if (!docs.length) {
      list.innerHTML = emptyState("file", App.activeProjectId ? "No PDFs in this project yet." : "No documents yet. Open a PDF to get started.");
      bus.emit("documents:changed", {});
      return;
    }
    list.innerHTML = "";
    docs.forEach((d) => list.appendChild(docItem(d)));
    bus.emit("documents:changed", {});
  }

  function docItem(d) {
    const el = document.createElement("div");
    el.className = "doc-item" + (d.id === state.docId ? " current" : "");
    el.innerHTML =
      '<span class="doc-ico">' + App.Icons.get("file") + "</span>" +
      '<div class="doc-info"><div class="doc-name"></div>' +
      '<div class="doc-sub">' + (d.pageCount ? d.pageCount + " pages · " : "") + util.formatBytes(d.size || 0) + "</div></div>" +
      '<div class="doc-ops"></div>';
    el.querySelector(".doc-name").textContent = d.name;
    el.querySelector(".doc-name").title = d.name;

    const ops = el.querySelector(".doc-ops");
    ops.appendChild(miniBtn("folder", "Assign to project", (e) => { e.stopPropagation(); assignDocProject(d); }));
    ops.appendChild(miniBtn("trash", "Remove", (e) => { e.stopPropagation(); removeDoc(d); }, "del"));
    el.addEventListener("click", () => openDocumentById(d.id, d.id === state.docId ? state.page : 1));
    return el;
  }

  async function assignDocProject(d) {
    const projects = App.getProjects();
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form" role="dialog" aria-modal="true"><h3>Assign “' + util.escapeHtml(d.name) + '” to a project</h3>' +
      '<label class="fld"><span>Project</span><select data-f="projectId"></select></label>' +
      '<div class="row"><button class="btn has-label" data-act="cancel">Cancel</button>' +
      '<button class="btn has-label primary" data-act="save">Save</button></div></div>';
    App.fillProjectSelect(backdrop.querySelector('[data-f="projectId"]'), d.projectId);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); };
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
    backdrop.querySelector('[data-act="save"]').addEventListener("click", async () => {
      const v = backdrop.querySelector('[data-f="projectId"]').value;
      d.projectId = v === "__none__" ? null : v;
      await App.Storage.putDoc(d);
      close(); await refreshDocsList(); bus.emit("projects:changed", {});
      App.toast("Document moved", "ok");
    });
  }

  async function removeDoc(d) {
    const ok = await App.confirmDialog({
      title: "Remove document?",
      message: "“" + d.name + "” and its stored file, annotations and OCR text will be deleted. Notes that reference it are kept (unlinked).",
      okText: "Remove", danger: true,
    });
    if (!ok) return;
    await App.Storage.deleteDoc(d.id);
    if (state.docId === d.id) App.Viewer.closeDocument();
    await refreshDocsList();
    bus.emit("projects:changed", {});
    App.toast("Document removed", "ok");
  }

  async function clearLibrary() {
    const ok = await App.confirmDialog({
      title: "Clear everything?",
      message: "This deletes ALL documents, annotations, notes, OCR text, literature, citations, figures, projects, formulas, checklists, safety entries and comparison reports from this browser. This cannot be undone.",
      okText: "Delete all", danger: true,
    });
    if (!ok) return;
    await App.Storage.clearAll();
    App.Viewer.closeDocument();
    await App.Storage.setMeta("session", null);
    if (App.Projects) await App.Projects.reload();
    if (App.Notes) await App.Notes.reloadAll();
    if (App.Literature) await App.Literature.reload();
    if (App.Citations) await App.Citations.reload();
    if (App.Figures) await App.Figures.reload();
    if (App.Formulas) await App.Formulas.reload();
    if (App.Checklists) await App.Checklists.reload();
    if (App.Safety) await App.Safety.reload();
    if (App.Compare) await App.Compare.reload();
    await refreshDocsList();
    App.toast("Workspace cleared", "ok");
  }

  /* ============================ Toolbar menu ============================= */
  function wireMenu() {
    const btn = document.getElementById("btn-menu");
    const menu = document.getElementById("menu");
    if (!btn || !menu) return;
    btn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); });
    document.addEventListener("click", () => menu.classList.remove("open"));
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.querySelectorAll("[data-act]").forEach((item) => {
      item.addEventListener("click", () => {
        const act = item.dataset.act;
        menu.classList.remove("open");
        if (act === "export-pdf") App.Exporter.exportEditedPdf();
        else if (act === "manage-pages") App.PageManager.open();
        else if (act === "export-notes-txt") App.Exporter.exportNotesTxt();
        else if (act === "export-notes-json") App.Exporter.exportNotesJson();
        else if (act === "export-anno-json") App.Exporter.exportAnnotationsJson();
        else if (act === "backup") App.Exporter.backupAll();
        else if (act === "restore") App.Exporter.importBackupPrompt();
        else if (act === "close-doc") { if (state.pdfDoc) { App.Viewer.closeDocument(); App.Storage.setMeta("session", null); refreshDocsList(); } }
      });
    });
  }

  /* ============================== Session ================================ */
  function saveSession(announce) {
    if (state.docId) {
      App.Storage.setMeta("session", {
        docId: state.docId, page: state.page, scale: state.scale,
        rotation: state.rotation, fitMode: state.fitMode,
      });
      const meta = state.docMeta;
      if (meta) {
        meta.lastPage = state.page; meta.rotation = state.rotation;
        meta.fitMode = state.fitMode; meta.scale = state.scale;
        meta.lastOpened = Date.now();
        App.Storage.putDoc(meta);
      }
    }
    if (announce) App.toast("Session saved", "ok");
  }
  App.saveSession = saveSession;

  async function restoreSession() {
    const s = await App.Storage.getMeta("session");
    if (!s || !s.docId) return;
    const fileRec = await App.Storage.getFile(s.docId);
    if (!fileRec || !fileRec.data) return;
    const meta = (await App.Storage.getDoc(s.docId)) || { id: s.docId, name: fileRec.name, size: fileRec.size };
    meta.lastPage = s.page || 1; meta.rotation = s.rotation || 0;
    meta.fitMode = s.fitMode || "width"; meta.scale = s.scale;
    state.annotations = await App.Storage.getAnnotations(s.docId);
    try { await App.Viewer.loadDocument(fileRec.data, meta); renderAnnoList(); }
    catch (e) { console.warn("Could not restore session:", e); }
  }

  /* =============================== Theme ================================= */
  function applyStoredTheme() {
    let theme = "dark";
    try { theme = localStorage.getItem("epdf-theme") || "dark"; } catch (e) {}
    setTheme(theme);
  }
  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    document.body && document.body.setAttribute("data-theme", theme);
    const btn = document.getElementById("btn-theme");
    if (btn) { btn.innerHTML = App.Icons.get(theme === "dark" ? "sun" : "moon"); btn.title = theme === "dark" ? "Light mode" : "Dark mode"; }
  }
  function toggleTheme() {
    const next = state.theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("epdf-theme", next); } catch (e) {}
  }

  /* =============================== Helpers =============================== */
  function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
  function miniBtn(icon, title, fn, extra) {
    const b = document.createElement("button");
    b.className = "mini-btn " + (extra || ""); b.title = title; b.innerHTML = App.Icons.get(icon);
    b.addEventListener("click", fn);
    return b;
  }
  function emptyState(icon, msg) { return '<div class="empty-state">' + App.Icons.get(icon) + "<p>" + util.escapeHtml(msg) + "</p></div>"; }
})();
