/* =============================================================================
   palette.js — Ctrl/Cmd+K command palette.

   A VS Code-style launcher: press Ctrl+K (or ⌘K) anywhere — including inside
   inputs — to open it. Type to filter, ↑/↓ to move, Enter to run, Esc to
   close. Commands cover opening PDFs, adding notes/citations/formulas/
   checklists/literature, every Engineering tool, backup/restore, theme,
   views, and the five most recent documents.

   The keydown listener uses the capture phase so it runs before the global
   shortcuts module; Esc inside the palette never leaks to other handlers.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;

  let backdrop = null, inputEl = null, listEl = null;
  let open = false, selIdx = 0, current = [];

  function init() {
    document.addEventListener("keydown", onGlobalKey, true); // capture phase
  }

  function onGlobalKey(e) {
    const k = e.key ? e.key.toLowerCase() : "";
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === "k") {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggle();
    } else if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  }

  function toggle() { if (open) close(); else openPalette(); }

  /* ------------------------------ Commands -------------------------------- */
  function commands() {
    const c = [];
    const add = (title, icon, hint, run) => c.push({ title, icon, hint, run });

    add("Open PDF…", "upload", "Reader", () => {
      App.switchView("reader");
      const f = document.getElementById("file-input");
      if (f) f.click();
    });
    add("Search everything", "search", "Global search", () => App.switchView("search"));
    add("Add research note", "note", "Notes", () => { if (App.Notes && App.Notes.openNew) App.Notes.openNew(); });
    add("Add citation", "quote", "Citations", () => {
      App.switchView("citations");
      const f = document.getElementById("cite-authors");
      if (f) setTimeout(() => f.focus(), 60);
    });
    add("Add formula", "sigma", "Formula library", () => { if (App.Formulas) App.Formulas.openNew(); });
    add("New checklist", "checkSquare", "Checklists", () => {
      App.Engineering.showTab("checklists");
      if (App.Checklists) App.Checklists.openNew();
    });
    add("New checklist from notes", "listChecks", "Checklists", () => {
      App.Engineering.showTab("checklists");
      const b = document.getElementById("chk-from-notes");
      if (b) b.click();
    });
    add("Add literature entry", "book", "Literature", () => {
      App.switchView("literature");
      const b = document.getElementById("lit-add");
      if (b) b.click();
    });
    add("Capture figure / table", "crop", "Reader", () => {
      App.switchView("reader");
      const b = document.getElementById("capture-toggle");
      if (b) b.click();
    });
    add("Run OCR on current PDF", "scan", "Reader", () => {
      App.switchView("reader");
      const b = document.getElementById("ocr-open");
      if (b) b.click();
    });
    add("Export edited PDF", "download", "Reader", () => {
      App.switchView("reader");
      if (App.Exporter) App.Exporter.exportEditedPdf();
    });
    add("Manage pages (reorder / delete / rotate / merge)", "layers", "Reader", () => {
      App.switchView("reader");
      if (App.PageManager) App.PageManager.open();
    });
    add("Compare two documents", "compare", "Engineering", () => App.Engineering.showTab("compare"));
    add("Unit converter", "repeat", "Engineering", () => App.Engineering.showTab("convert"));
    add("Safety limit reference", "shield", "Engineering", () => App.Engineering.showTab("safety"));
    add("Formula library", "sigma", "Engineering", () => App.Engineering.showTab("formulas"));
    add("Engineering tags", "tag", "Engineering", () => App.Engineering.showTab("tags"));
    add("Export centre", "download", "Engineering", () => App.Engineering.showTab("export"));
    add("Go to Engineering Workspace", "wrench", "View", () => App.switchView("engineering"));
    add("Back up everything", "download", "Backup", () => { if (App.Exporter) App.Exporter.backupAll(); });
    add("Restore from backup", "upload", "Backup", () => {
      const b = document.querySelector('[data-act="restore"]');
      if (b) b.click(); else App.toast("Restore is available from the toolbar menu", "info");
    });
    add("Toggle dark / light mode", "sun", "Theme", () => {
      const b = document.getElementById("btn-theme");
      if (b) b.click();
    });
    add("Save session", "save", "Session", () => { if (App.saveSession) App.saveSession(true); });

    [["reader", "Reader", "fileText"], ["notes", "Research notes", "note"],
     ["literature", "Literature", "book"], ["citations", "Citations", "quote"],
     ["figures", "Figures & tables", "image"], ["projects", "Projects", "folder"],
     ["search", "Global search", "search"]].forEach((v) => {
      add("Go to " + v[1], v[2], "View", () => App.switchView(v[0]));
    });

    (App.getDocuments ? App.getDocuments() : []).slice(0, 5).forEach((d) => {
      add("Open: " + d.name, "file", "Document", () => App.openDocumentById(d.id));
    });
    return c;
  }

  function filtered(q) {
    const all = commands();
    if (!q) return all;
    q = q.toLowerCase();
    const scored = [];
    all.forEach((c) => {
      const t = c.title.toLowerCase();
      const h = (c.hint || "").toLowerCase();
      let s = -1;
      const i = t.indexOf(q);
      if (i === 0) s = 0;
      else if (i > 0) s = 10 + i;
      else if (h.indexOf(q) !== -1) s = 100;
      if (s >= 0) scored.push([s, c]);
    });
    scored.sort((a, b) => a[0] - b[0]);
    return scored.map((x) => x[1]);
  }

  /* -------------------------------- DOM ----------------------------------- */
  function ensureDom() {
    if (backdrop) return;
    backdrop = document.createElement("div");
    backdrop.className = "cmdk-backdrop";
    backdrop.innerHTML =
      '<div class="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<div class="cmdk-inputwrap">' + App.Icons.get("command") +
          '<input class="cmdk-input" type="text" placeholder="Type a command… (formula, compare, backup…)" aria-label="Search commands">' +
        "</div>" +
        '<div class="cmdk-list" role="listbox" aria-label="Commands"></div>' +
        '<div class="cmdk-hint"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>' +
      "</div>";
    document.body.appendChild(backdrop);
    inputEl = backdrop.querySelector(".cmdk-input");
    listEl = backdrop.querySelector(".cmdk-list");

    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    inputEl.addEventListener("input", () => { selIdx = 0; renderList(); });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); runSelected(); }
    });
  }

  function openPalette() {
    ensureDom();
    open = true;
    inputEl.value = "";
    selIdx = 0;
    renderList();
    backdrop.classList.add("show");
    setTimeout(() => inputEl.focus(), 20);
  }

  function close() {
    if (!backdrop) return;
    open = false;
    backdrop.classList.remove("show");
  }

  function renderList() {
    current = filtered(inputEl.value.trim());
    listEl.innerHTML = "";
    if (!current.length) {
      listEl.innerHTML = '<div class="cmdk-empty">No matching commands</div>';
      return;
    }
    if (selIdx >= current.length) selIdx = current.length - 1;
    current.forEach((c, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cmdk-item" + (i === selIdx ? " sel" : "");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", i === selIdx ? "true" : "false");
      item.innerHTML = '<span class="cmdk-ico">' + App.Icons.get(c.icon || "command") + "</span>" +
        '<span class="cmdk-title"></span><span class="cmdk-hint-r"></span>';
      item.querySelector(".cmdk-title").textContent = c.title;
      item.querySelector(".cmdk-hint-r").textContent = c.hint || "";
      item.addEventListener("click", () => { selIdx = i; runSelected(); });
      listEl.appendChild(item);
    });
  }

  function move(d) {
    if (!current.length) return;
    selIdx = Math.max(0, Math.min(current.length - 1, selIdx + d));
    Array.from(listEl.children).forEach((el, i) => {
      el.classList.toggle("sel", i === selIdx);
      if (el.setAttribute) el.setAttribute("aria-selected", i === selIdx ? "true" : "false");
    });
    const selEl = listEl.children[selIdx];
    if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: "nearest" });
  }

  function runSelected() {
    const cmd = current[selIdx];
    if (!cmd) return;
    close();
    setTimeout(() => {
      try { cmd.run(); }
      catch (err) { console.error("palette command failed", err); App.toast("Command failed", "err"); }
    }, 10);
  }

  App.Palette = { init };
})();
