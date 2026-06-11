/* =============================================================================
   notes.js — Research Notes (Phase 2 upgrade of the Phase 1 notes panel).

   Owns all note UI:
     • Reader right-sidebar "Notes" pane (notes for the open document).
     • The dedicated "Research Notes" view (all notes, with filters).
     • A floating "+ Note" button that appears over a text selection.
     • A modal composer/editor.

   Note shape:
     { id, projectId, docId, source, page, quote, body, tags[],
       category, importance, createdAt, updatedAt }

   Listens : doc:loaded, doc:closed, page:changed, note:fromSelection, projects:changed
   Emits   : notes:changed { counts }
   Exposed as window.App.Notes.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus, util } = App;

  const CATEGORIES = [
    "Literature Review", "Methodology", "Results", "Discussion",
    "Safety", "Standards", "Useful Quote", "Formula", "To Verify",
  ];
  const CAT_COLOR = {
    "Literature Review": "#5b9dff", "Methodology": "#c879ff", "Results": "#38cf90",
    "Discussion": "#ffb020", "Safety": "#ff5f5f", "Standards": "#21c7d6",
    "Useful Quote": "#9aa6b2", "Formula": "#f78fb3", "To Verify": "#ffa94d",
  };
  const IMPORTANCE = ["low", "medium", "high", "critical"];

  let allNotes = [];                 // cache of every note (for view + search)

  // Reader sidebar elements
  let sideList, sideFilter, sideAddBtn;
  // Research view elements
  let viewList, viewSearch, viewCat, viewImp, viewProj, viewCount;
  // Floating selection button
  let selBtn = null, lastSelection = null;

  function init() {
    sideList = document.getElementById("notes-list");
    sideFilter = document.getElementById("notes-filter");
    sideAddBtn = document.getElementById("notes-add");

    viewList = document.getElementById("research-list");
    viewSearch = document.getElementById("research-search");
    viewCat = document.getElementById("research-cat");
    viewImp = document.getElementById("research-imp");
    viewProj = document.getElementById("research-project");
    viewCount = document.getElementById("research-count");

    if (sideAddBtn) sideAddBtn.addEventListener("click", () => openComposer(blankNote()));
    if (sideFilter) sideFilter.addEventListener("input", renderSidebar);

    populateCategorySelect(viewCat, true);
    if (viewImp) {
      viewImp.innerHTML = '<option value="">All importance</option>' +
        IMPORTANCE.map((i) => '<option value="' + i + '">' + cap(i) + "</option>").join("");
    }
    [viewSearch, viewCat, viewImp, viewProj].forEach((el) => el && el.addEventListener("input", renderView));

    bus.on("doc:loaded", loadForDoc);
    bus.on("doc:closed", () => { state.notes = []; renderSidebar(); });
    bus.on("page:changed", renderSidebar);
    bus.on("note:fromSelection", (p) => openComposer(blankNote(p && p.text, p && p.page)));
    bus.on("projects:changed", () => { refreshProjectFilter(); renderSidebar(); renderView(); });

    setupSelectionButton();
    loadAll();
  }

  /* ------------------------------ Data ----------------------------------- */
  function blankNote(quote, page) {
    return {
      id: null, projectId: App.activeProjectId || null,
      docId: state.docId || null,
      source: (state.docMeta && state.docMeta.name) || "",
      page: page || state.page || 1,
      quote: quote || "", body: "", tags: [],
      category: CATEGORIES[0], importance: "medium",
      createdAt: null, updatedAt: null,
    };
  }

  async function loadAll() { allNotes = await App.Storage.getAllNotes(); renderView(); emitCounts(); }

  async function loadForDoc() {
    if (!state.docId) { state.notes = []; renderSidebar(); return; }
    state.notes = await App.Storage.getNotesByDoc(state.docId);
    renderSidebar();
    emitCounts();
  }

  function emitCounts() {
    const counts = {};
    state.notes.forEach((n) => { counts[n.page] = (counts[n.page] || 0) + 1; });
    bus.emit("notes:changed", { counts });
  }

  async function save(note) {
    const now = Date.now();
    if (!note.id) { note.id = util.uid("note"); note.createdAt = now; }
    note.updatedAt = now;
    await App.Storage.saveNote(note);
    // refresh caches
    const i = allNotes.findIndex((n) => n.id === note.id);
    if (i === -1) allNotes.push(note); else allNotes[i] = note;
    if (note.docId === state.docId) {
      const j = state.notes.findIndex((n) => n.id === note.id);
      if (j === -1) state.notes.push(note); else state.notes[j] = note;
    }
    renderSidebar(); renderView(); emitCounts();
    App.toast("Note saved", "ok");
  }

  async function remove(id) {
    const ok = await App.confirmDialog({ title: "Delete note?", message: "This note will be permanently removed.", okText: "Delete", danger: true });
    if (!ok) return;
    await App.Storage.deleteNote(id);
    allNotes = allNotes.filter((n) => n.id !== id);
    state.notes = state.notes.filter((n) => n.id !== id);
    renderSidebar(); renderView(); emitCounts();
  }

  /* --------------------------- Sidebar render ---------------------------- */
  function renderSidebar() {
    if (!sideList) return;
    const q = (sideFilter && sideFilter.value.trim().toLowerCase()) || "";
    let notes = state.notes.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (q) notes = notes.filter((n) => matchText(n, q));

    if (!state.docId) { sideList.innerHTML = empty("inbox", "Open a PDF to take notes on it."); return; }
    if (!notes.length) { sideList.innerHTML = empty("note", q ? "No notes match your filter." : "No notes yet. Select text in the page or use “Add note”."); return; }
    sideList.innerHTML = "";
    notes.forEach((n) => sideList.appendChild(card(n, "sidebar")));
    updateTabPill();
  }

  function updateTabPill() {
    const pill = document.getElementById("notes-count-pill");
    if (pill) { pill.textContent = state.notes.length || ""; pill.style.display = state.notes.length ? "" : "none"; }
  }

  /* ----------------------------- View render ----------------------------- */
  function renderView() {
    if (!viewList) return;
    const q = (viewSearch && viewSearch.value.trim().toLowerCase()) || "";
    const cat = (viewCat && viewCat.value) || "";
    const imp = (viewImp && viewImp.value) || "";
    const proj = (viewProj && viewProj.value) || "";

    let notes = allNotes.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (App.activeProjectId) notes = notes.filter((n) => n.projectId === App.activeProjectId);
    if (proj) notes = notes.filter((n) => (proj === "__none__" ? !n.projectId : n.projectId === proj));
    if (cat) notes = notes.filter((n) => n.category === cat);
    if (imp) notes = notes.filter((n) => n.importance === imp);
    if (q) notes = notes.filter((n) => matchText(n, q));

    if (viewCount) viewCount.textContent = notes.length + (notes.length === 1 ? " note" : " notes");
    if (!notes.length) { viewList.innerHTML = empty("note", "No research notes yet. Notes you capture while reading appear here."); return; }
    viewList.innerHTML = "";
    notes.forEach((n) => viewList.appendChild(card(n, "view")));
  }

  function matchText(n, q) {
    return [n.body, n.quote, n.source, n.category, (n.tags || []).join(" ")]
      .join(" ").toLowerCase().indexOf(q) !== -1;
  }

  /* ------------------------------ Note card ------------------------------ */
  function card(n, ctx) {
    const el = document.createElement("div");
    el.className = "note-card";
    el.dataset.id = n.id;

    const top = document.createElement("div");
    top.className = "note-top";
    const badge = document.createElement("span");
    badge.className = "note-page-badge";
    badge.innerHTML = App.Icons.get("fileText") + "<span>p." + n.page + "</span>";
    badge.title = "Go to page " + n.page + (n.source ? " · " + n.source : "");
    badge.addEventListener("click", () => jumpTo(n));
    const actions = document.createElement("div");
    actions.className = "note-actions";
    actions.appendChild(iconBtn("edit", "Edit", () => openComposer(Object.assign({}, n))));
    actions.appendChild(iconBtn("trash", "Delete", () => remove(n.id), "del"));
    top.appendChild(badge); top.appendChild(actions);
    el.appendChild(top);

    // category + importance row
    const meta = document.createElement("div");
    meta.className = "note-meta-row";
    meta.appendChild(catChip(n.category));
    meta.appendChild(impBadge(n.importance));
    if (ctx === "view" && n.source) {
      const src = document.createElement("span");
      src.className = "note-source"; src.textContent = n.source;
      src.title = n.source;
      meta.appendChild(src);
    }
    el.appendChild(meta);

    if (n.quote) {
      const q = document.createElement("div");
      q.className = "note-quote"; q.textContent = "“" + n.quote + "”";
      el.appendChild(q);
    }
    const body = document.createElement("div");
    body.className = "note-body" + (n.body ? "" : " placeholder");
    body.textContent = n.body || "No comment.";
    el.appendChild(body);

    if (n.tags && n.tags.length) {
      const tags = document.createElement("div");
      tags.className = "note-tags";
      n.tags.forEach((t) => { const c = document.createElement("span"); c.className = "tag-chip"; c.textContent = t; tags.appendChild(c); });
      el.appendChild(tags);
    }
    const date = document.createElement("div");
    date.className = "note-date";
    date.textContent = (n.updatedAt && n.updatedAt !== n.createdAt ? "Updated " : "") + util.formatDate(n.updatedAt || n.createdAt);
    el.appendChild(date);
    return el;
  }

  function catChip(cat) {
    const c = document.createElement("span");
    c.className = "note-cat";
    const color = CAT_COLOR[cat] || "#9aa6b2";
    c.style.color = color;
    c.style.borderColor = "color-mix(in srgb," + color + " 45%, transparent)";
    c.style.background = "color-mix(in srgb," + color + " 14%, transparent)";
    c.textContent = cat;
    return c;
  }
  function impBadge(imp) {
    const b = document.createElement("span");
    b.className = "imp-badge imp-" + (imp || "medium");
    b.textContent = cap(imp || "medium");
    return b;
  }

  function jumpTo(n) {
    if (n.docId && App.openDocumentById) {
      App.openDocumentById(n.docId, n.page);
    } else if (state.docId && (!n.docId || n.docId === state.docId)) {
      App.switchView("reader"); App.Viewer.goToPage(n.page);
    } else {
      App.toast("Source PDF isn’t in the library anymore", "warn");
    }
  }

  /* ----------------------------- Composer -------------------------------- */
  function openComposer(note) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form" role="dialog" aria-modal="true">' +
      "<h3>" + (note.id ? "Edit note" : "New research note") + "</h3>" +
      '<div class="form-meta"></div>' +
      '<label class="fld"><span>Selected text / quote</span><textarea data-f="quote" rows="2" placeholder="Optional quoted text from the PDF"></textarea></label>' +
      '<label class="fld"><span>Your note</span><textarea data-f="body" rows="4" placeholder="Your comment, insight, or summary"></textarea></label>' +
      '<div class="form-grid">' +
        '<label class="fld"><span>Category</span><select data-f="category"></select></label>' +
        '<label class="fld"><span>Importance</span><select data-f="importance"></select></label>' +
        '<label class="fld"><span>Project</span><select data-f="projectId"></select></label>' +
        '<label class="fld"><span>Tags (comma separated)</span><input data-f="tags" type="text" placeholder="e.g. ammonia, NH3, safety"></label>' +
      "</div>" +
      '<div class="row">' +
        '<button class="btn has-label" data-act="cancel">Cancel</button>' +
        '<button class="btn has-label primary" data-act="save">Save note</button>' +
      "</div></div>";

    const q = (s) => backdrop.querySelector(s);
    q(".form-meta").innerHTML = App.Icons.get("file") +
      "<span>" + (note.source ? esc(note.source) : "No source document") + " · page " + note.page + "</span>";
    q('[data-f="quote"]').value = note.quote || "";
    q('[data-f="body"]').value = note.body || "";
    populateCategorySelect(q('[data-f="category"]'), false, note.category);
    q('[data-f="importance"]').innerHTML = IMPORTANCE.map((i) => '<option value="' + i + '"' + (i === note.importance ? " selected" : "") + ">" + cap(i) + "</option>").join("");
    fillProjectOptions(q('[data-f="projectId"]'), note.projectId);
    q('[data-f="tags"]').value = (note.tags || []).join(", ");
    if (App.Tags) App.Tags.attachSuggestions(q('[data-f="tags"]'));

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    setTimeout(() => q('[data-f="body"]').focus(), 30);

    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    q('[data-act="cancel"]').addEventListener("click", close);
    q('[data-act="save"]').addEventListener("click", () => {
      note.quote = q('[data-f="quote"]').value.trim();
      note.body = q('[data-f="body"]').value.trim();
      note.category = q('[data-f="category"]').value;
      note.importance = q('[data-f="importance"]').value;
      const pv = q('[data-f="projectId"]').value;
      note.projectId = pv === "__none__" ? null : pv;
      note.tags = q('[data-f="tags"]').value.split(",").map((s) => s.trim()).filter(Boolean);
      close();
      save(note);
    });
  }

  /* ------------------------- Selection → note ---------------------------- */
  function setupSelectionButton() {
    const wrap = document.getElementById("viewer-wrap");
    if (!wrap) return;
    selBtn = document.createElement("div");
    selBtn.className = "sel-note-btn sel-actions";
    selBtn.innerHTML =
      '<button type="button" data-act="note">' + App.Icons.get("plus") + "<span>Note</span></button>" +
      '<button type="button" data-act="formula">' + App.Icons.get("sigma") + "<span>Formula</span></button>";
    selBtn.style.display = "none";
    wrap.appendChild(selBtn);
    selBtn.addEventListener("mousedown", (e) => e.preventDefault());
    selBtn.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn || !lastSelection) return;
      if (btn.getAttribute("data-act") === "formula" && App.Formulas) {
        App.Formulas.openFromSelection(lastSelection.text, lastSelection.page);
      } else {
        openComposer(blankNote(lastSelection.text, lastSelection.page));
      }
      hideSelBtn();
    });

    wrap.addEventListener("mouseup", () => setTimeout(checkSelection, 0));
    document.addEventListener("selectionchange", () => { if (!isSelectionInViewer()) hideSelBtn(); });
    const viewer = App.Viewer.getViewer();
    if (viewer) viewer.addEventListener("scroll", hideSelBtn);
  }
  function isSelectionInViewer() {
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return false;
    const node = s.anchorNode;
    const tl = document.getElementById("text-layer");
    return !!(tl && node && tl.contains(node.nodeType === 1 ? node : node.parentElement));
  }
  function checkSelection() {
    const s = window.getSelection();
    const text = s ? s.toString().trim() : "";
    if (!text || !isSelectionInViewer()) { hideSelBtn(); return; }
    lastSelection = { text: text.replace(/\s+/g, " ").slice(0, 1000), page: state.page };
    const range = s.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const wrap = document.getElementById("viewer-wrap");
    const wr = wrap.getBoundingClientRect();
    selBtn.style.display = "inline-flex";
    let left = rect.right - wr.left + 6;
    let top = rect.top - wr.top - 6;
    left = Math.min(left, wrap.clientWidth - 170);
    top = Math.max(6, top);
    selBtn.style.left = left + "px";
    selBtn.style.top = top + "px";
  }
  function hideSelBtn() { if (selBtn) selBtn.style.display = "none"; lastSelection = null; }

  /* ------------------------------ Helpers -------------------------------- */
  function populateCategorySelect(sel, withAll, selected) {
    if (!sel) return;
    sel.innerHTML = (withAll ? '<option value="">All categories</option>' : "") +
      CATEGORIES.map((c) => '<option value="' + esc(c) + '"' + (c === selected ? " selected" : "") + ">" + esc(c) + "</option>").join("");
  }
  function fillProjectOptions(sel, selectedId) {
    if (!sel) return;
    const projects = (App.getProjects && App.getProjects()) || [];
    sel.innerHTML = '<option value="__none__">Unfiled</option>' +
      projects.map((p) => '<option value="' + p.id + '"' + (p.id === selectedId ? " selected" : "") + ">" + esc(p.name) + "</option>").join("");
  }
  function refreshProjectFilter() {
    if (!viewProj) return;
    const projects = (App.getProjects && App.getProjects()) || [];
    const cur = viewProj.value;
    viewProj.innerHTML = '<option value="">All projects</option><option value="__none__">Unfiled</option>' +
      projects.map((p) => '<option value="' + p.id + '">' + esc(p.name) + "</option>").join("");
    viewProj.value = cur;
  }

  function iconBtn(icon, title, fn, extra) {
    const b = document.createElement("button");
    b.className = extra || ""; b.title = title; b.innerHTML = App.Icons.get(icon);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function empty(icon, msg) { return '<div class="empty-state">' + App.Icons.get(icon) + "<p>" + esc(msg) + "</p></div>"; }
  function esc(s) { return util.escapeHtml(s); }
  function cap(s) { return (s || "").charAt(0).toUpperCase() + (s || "").slice(1); }

  App.Notes = {
    init,
    getAll: () => allNotes,
    CATEGORIES, IMPORTANCE,
    refreshProjectFilter,
    addForCurrentSelection: () => { if (lastSelection) openComposer(blankNote(lastSelection.text, lastSelection.page)); else openComposer(blankNote()); },
    openNew: () => openComposer(blankNote()),
    reloadAll: loadAll,
  };
})();
