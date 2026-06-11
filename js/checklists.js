/* =============================================================================
   checklists.js — Technical Checklist Builder.

   Record shape:
     { id, name, category, projectId,
       items: [{ id, text, done,
                 link: null | {type:'pdf', docId, page, label}
                            | {type:'note', noteId, label} }],
       createdAt, updatedAt }

   Features:
     • Create checklists (with suggested engineering categories).
     • Add items, tick complete/incomplete, delete, link to a PDF page or note.
     • "New from notes" converts selected research notes into a checklist.
     • Export a checklist (or all) as TXT / CSV / JSON.

   Layout: list of checklist cards on the left, the selected checklist's items
   on the right (#chk-detail).

   Emits : checklists:changed
   Exposed as window.App.Checklists.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus, util } = App;

  const CATEGORIES = [
    "Safety Review", "Design Review", "Literature Review",
    "Dissertation Review", "Internship Action Items", "Regulatory Compliance", "Other",
  ];

  let cache = [];
  let currentId = null;
  let listEl, detailEl, countEl;

  function init() {
    listEl = document.getElementById("chk-list");
    detailEl = document.getElementById("chk-detail");
    countEl = document.getElementById("chk-count");
    on("chk-add", () => openNew());
    on("chk-from-notes", fromNotesModal);
    bus.on("projects:changed", render);
    load();
  }

  async function load() {
    cache = await App.Storage.getAllChecklists();
    if (currentId && !cache.some((c) => c.id === currentId)) currentId = null;
    render();
  }

  async function persist(rec) {
    rec.updatedAt = Date.now();
    await App.Storage.saveChecklist(rec);
    bus.emit("checklists:changed", {});
  }

  async function remove(id) {
    const ok = await App.confirmDialog({ title: "Delete checklist?", message: "The checklist and all its items will be permanently removed.", okText: "Delete", danger: true });
    if (!ok) return;
    await App.Storage.deleteChecklist(id);
    cache = cache.filter((c) => c.id !== id);
    if (currentId === id) currentId = null;
    render();
    bus.emit("checklists:changed", {});
  }

  /* ------------------------------ Render --------------------------------- */
  function visible() {
    let rows = cache.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    return rows;
  }

  function render() {
    if (!listEl) return;
    const rows = visible();
    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? " checklist" : " checklists");

    listEl.innerHTML = "";
    if (!rows.length) {
      listEl.innerHTML = '<div class="empty-state">' + App.Icons.get("checkSquare") +
        "<p>No checklists yet. Create one, or build one from your research notes.</p></div>";
    } else {
      rows.forEach((c) => listEl.appendChild(card(c)));
      if (!currentId || !rows.some((r) => r.id === currentId)) currentId = rows[0].id;
    }
    renderDetail();
  }

  function progressOf(c) {
    const total = (c.items || []).length;
    const done = (c.items || []).filter((i) => i.done).length;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function card(c) {
    const p = progressOf(c);
    const el = document.createElement("button");
    el.className = "chk-card" + (c.id === currentId ? " active" : "");
    el.innerHTML =
      '<div class="chk-card-top"><span class="chk-name"></span><span class="chk-cat"></span></div>' +
      '<div class="chk-progress"><span style="width:' + p.pct + '%"></span></div>' +
      '<div class="chk-stats">' + p.done + " / " + p.total + " done</div>";
    el.querySelector(".chk-name").textContent = c.name;
    el.querySelector(".chk-cat").textContent = c.category || "";
    el.addEventListener("click", () => { currentId = c.id; render(); });
    return el;
  }

  function renderDetail() {
    if (!detailEl) return;
    const c = cache.find((x) => x.id === currentId);
    if (!c) {
      detailEl.innerHTML = '<div class="empty-state">' + App.Icons.get("listChecks") + "<p>Select a checklist on the left, or create a new one.</p></div>";
      return;
    }
    const p = progressOf(c);
    detailEl.innerHTML =
      '<div class="chk-detail-head">' +
        '<div><h2 class="chk-title"></h2><div class="chk-sub"></div></div>' +
        '<div class="chk-detail-actions">' +
          btnHtml("export-txt", "download", "TXT") + btnHtml("export-csv", "download", "CSV") + btnHtml("export-json", "download", "JSON") +
          '<button class="ghost-icon" data-act="rename" title="Rename / settings" aria-label="Rename checklist">' + App.Icons.get("edit") + "</button>" +
          '<button class="ghost-icon del" data-act="delete" title="Delete checklist" aria-label="Delete checklist">' + App.Icons.get("trash") + "</button>" +
        "</div>" +
      "</div>" +
      '<div class="chk-progress big"><span style="width:' + p.pct + '%"></span></div>' +
      '<div class="chk-items" id="chk-items"></div>' +
      '<div class="chk-add-row">' +
        '<input id="chk-new-item" type="text" placeholder="Add an item and press Enter…" aria-label="New checklist item" />' +
        '<button id="chk-item-add" class="btn has-label primary">' + App.Icons.get("plus") + "<span>Add</span></button>" +
      "</div>";

    detailEl.querySelector(".chk-title").textContent = c.name;
    detailEl.querySelector(".chk-sub").textContent = [c.category, p.done + " of " + p.total + " complete"].filter(Boolean).join(" · ");

    const itemsEl = detailEl.querySelector("#chk-items");
    if (!(c.items || []).length) {
      itemsEl.innerHTML = '<div class="chk-empty">No items yet — add the first one below.</div>';
    } else {
      c.items.forEach((it) => itemsEl.appendChild(itemRow(c, it)));
    }

    const input = detailEl.querySelector("#chk-new-item");
    const add = () => {
      const text = input.value.trim();
      if (!text) return;
      c.items.push({ id: util.uid("ci"), text, done: false, link: null });
      input.value = "";
      persist(c); renderDetail(); renderListOnly();
      detailEl.querySelector("#chk-new-item").focus();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    detailEl.querySelector("#chk-item-add").addEventListener("click", add);

    detailEl.querySelector('[data-act="rename"]').addEventListener("click", () => openEditor(Object.assign({}, c), c.id));
    detailEl.querySelector('[data-act="delete"]').addEventListener("click", () => remove(c.id));
    detailEl.querySelector('[data-act="export-txt"]').addEventListener("click", () => exportTxtOne(c));
    detailEl.querySelector('[data-act="export-csv"]').addEventListener("click", () => exportCsvFor([c], c.name));
    detailEl.querySelector('[data-act="export-json"]').addEventListener("click", () => util.downloadFile(slug(c.name) + ".json", JSON.stringify(c, null, 2), "application/json"));
  }
  function btnHtml(act, icon, label) {
    return '<button class="btn has-label tiny" data-act="' + act + '">' + App.Icons.get(icon) + "<span>" + label + "</span></button>";
  }
  // refresh card list (progress numbers) without rebuilding detail
  function renderListOnly() {
    if (!listEl) return;
    const rows = visible();
    listEl.innerHTML = "";
    rows.forEach((c) => listEl.appendChild(card(c)));
  }

  function itemRow(c, it) {
    const row = document.createElement("div");
    row.className = "chk-item" + (it.done ? " done" : "");
    row.innerHTML =
      '<label class="chk-tick"><input type="checkbox" ' + (it.done ? "checked" : "") + ' aria-label="Mark complete"><span class="chk-box">' + App.Icons.get("check") + "</span></label>" +
      '<div class="chk-item-main"><div class="chk-item-text"></div></div>' +
      '<div class="chk-item-ops">' +
        '<button class="ghost-icon" data-act="link" title="Link to a PDF page or note" aria-label="Link item">' + App.Icons.get("fileText") + "</button>" +
        '<button class="ghost-icon" data-act="edit" title="Edit item" aria-label="Edit item">' + App.Icons.get("edit") + "</button>" +
        '<button class="ghost-icon del" data-act="del" title="Delete item" aria-label="Delete item">' + App.Icons.get("trash") + "</button>" +
      "</div>";
    row.querySelector(".chk-item-text").textContent = it.text;

    if (it.link) {
      const chip = document.createElement("button");
      chip.className = "chk-link-chip";
      chip.innerHTML = App.Icons.get(it.link.type === "note" ? "note" : "file") + "<span></span>";
      chip.querySelector("span").textContent = it.link.label || (it.link.type === "note" ? "Linked note" : "Linked page");
      chip.title = "Open linked " + (it.link.type === "note" ? "note" : "page");
      chip.addEventListener("click", () => followLink(it.link));
      const x = document.createElement("button");
      x.className = "chk-link-x"; x.title = "Remove link"; x.setAttribute("aria-label", "Remove link");
      x.innerHTML = App.Icons.get("x");
      x.addEventListener("click", (e) => { e.stopPropagation(); it.link = null; persist(c); renderDetail(); });
      chip.appendChild(x);
      row.querySelector(".chk-item-main").appendChild(chip);
    }

    row.querySelector("input").addEventListener("change", (e) => {
      it.done = e.target.checked;
      row.classList.toggle("done", it.done);
      persist(c); renderListOnly();
      const ph = detailEl.querySelector(".chk-progress.big span");
      const sub = detailEl.querySelector(".chk-sub");
      const p = progressOf(c);
      if (ph) ph.style.width = p.pct + "%";
      if (sub) sub.textContent = [c.category, p.done + " of " + p.total + " complete"].filter(Boolean).join(" · ");
    });
    row.querySelector('[data-act="del"]').addEventListener("click", () => {
      c.items = c.items.filter((x) => x.id !== it.id);
      persist(c); renderDetail(); renderListOnly();
    });
    row.querySelector('[data-act="edit"]').addEventListener("click", () => {
      const next = window.prompt("Edit item", it.text);
      if (next != null && next.trim()) { it.text = next.trim(); persist(c); renderDetail(); }
    });
    row.querySelector('[data-act="link"]').addEventListener("click", () => openLinkModal(c, it));
    return row;
  }

  function followLink(link) {
    if (link.type === "pdf" && link.docId && App.openDocumentById) {
      App.openDocumentById(link.docId, link.page || 1);
    } else if (link.type === "note") {
      const note = (App.Notes ? App.Notes.getAll() : []).find((n) => n.id === link.noteId);
      if (note && note.docId && App.openDocumentById) App.openDocumentById(note.docId, note.page || 1);
      else { App.switchView("notes"); App.toast("Showing research notes", "info"); }
    }
  }

  /* --------------------------- Link modal --------------------------------- */
  function openLinkModal(c, it) {
    const docs = App.getDocuments ? App.getDocuments() : [];
    const notes = App.Notes ? App.Notes.getAll() : [];
    const hasOpen = !!(state.pdfDoc && state.docId);

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form" role="dialog" aria-modal="true"><h3>Link checklist item</h3>' +
      '<div class="link-opts">' +
        (hasOpen ? '<button class="btn has-label" data-act="current">' + App.Icons.get("fileText") + "<span>Current page (" + esc((state.docMeta && state.docMeta.name) || "open PDF") + ", p. " + state.page + ")</span></button>" : "") +
      "</div>" +
      '<label class="fld"><span>…or a document &amp; page</span><div class="link-row"><select data-f="doc"><option value="">Choose PDF…</option>' +
        docs.map((d) => '<option value="' + d.id + '">' + esc(d.name) + "</option>").join("") +
      '</select><input data-f="page" type="number" min="1" value="1" aria-label="Page number"></div></label>' +
      '<label class="fld"><span>…or a research note</span><select data-f="note"><option value="">Choose note…</option>' +
        notes.slice(0, 200).map((n) => '<option value="' + n.id + '">' + esc(clip(n.body || n.quote || "(note)", 70)) + "</option>").join("") +
      "</select></label>" +
      '<div class="row"><button class="btn has-label" data-act="cancel">Cancel</button>' +
      '<button class="btn has-label primary" data-act="save">Link</button></div></div>';

    const q = (s) => backdrop.querySelector(s);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); };
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    q('[data-act="cancel"]').addEventListener("click", close);

    const cur = q('[data-act="current"]');
    if (cur) cur.addEventListener("click", () => {
      it.link = { type: "pdf", docId: state.docId, page: state.page, label: ((state.docMeta && state.docMeta.name) || "PDF") + " · p. " + state.page };
      persist(c); close(); renderDetail();
    });
    q('[data-act="save"]').addEventListener("click", () => {
      const noteId = q('[data-f="note"]').value;
      const docId = q('[data-f="doc"]').value;
      if (noteId) {
        const n = notes.find((x) => x.id === noteId);
        it.link = { type: "note", noteId, label: "Note: " + clip((n && (n.body || n.quote)) || "", 40) };
      } else if (docId) {
        const d = docs.find((x) => x.id === docId);
        const page = parseInt(q('[data-f="page"]').value, 10) || 1;
        it.link = { type: "pdf", docId, page, label: ((d && d.name) || "PDF") + " · p. " + page };
      } else { App.toast("Choose a page or a note to link", "warn"); return; }
      persist(c); close(); renderDetail();
    });
  }

  /* ----------------------- Create / rename modal -------------------------- */
  function openEditor(rec, id) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form" role="dialog" aria-modal="true"><h3>' + (id ? "Checklist settings" : "New checklist") + "</h3>" +
      '<label class="fld"><span>Checklist name</span><input data-f="name" type="text" placeholder="e.g. NH₃ storage HAZOP actions"></label>' +
      '<label class="fld"><span>Category</span><select data-f="category">' + CATEGORIES.map((c) => "<option>" + c + "</option>").join("") + "</select></label>" +
      '<label class="fld"><span>Project</span><select data-f="projectId"></select></label>' +
      '<div class="row"><button class="btn has-label" data-act="cancel">Cancel</button>' +
      '<button class="btn has-label primary" data-act="save">' + (id ? "Save" : "Create") + "</button></div></div>";

    const q = (s) => backdrop.querySelector(s);
    q('[data-f="name"]').value = rec.name || "";
    q('[data-f="category"]').value = rec.category || CATEGORIES[0];
    App.fillProjectSelect(q('[data-f="projectId"]'), rec.projectId);

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    setTimeout(() => q('[data-f="name"]').focus(), 30);
    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); };
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    q('[data-act="cancel"]').addEventListener("click", close);
    q('[data-act="save"]').addEventListener("click", async () => {
      const name = q('[data-f="name"]').value.trim();
      if (!name) { App.toast("Give the checklist a name", "warn"); return; }
      rec.name = name;
      rec.category = q('[data-f="category"]').value;
      const pv = q('[data-f="projectId"]').value;
      rec.projectId = pv === "__none__" ? null : pv;
      if (!rec.id) { rec.id = util.uid("chk"); rec.createdAt = Date.now(); rec.items = rec.items || []; cache.push(rec); }
      else { const i = cache.findIndex((x) => x.id === rec.id); if (i !== -1) cache[i] = rec; }
      currentId = rec.id;
      await persist(rec);
      close(); render();
    });
  }

  function openNew() {
    openEditor({ id: null, name: "", category: CATEGORIES[0], projectId: App.activeProjectId || null, items: [] }, null);
  }

  /* --------------------------- From notes --------------------------------- */
  function fromNotesModal() {
    const notes = (App.Notes ? App.Notes.getAll() : []).slice()
      .filter((n) => !App.activeProjectId || n.projectId === App.activeProjectId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!notes.length) { App.toast("No research notes to convert yet", "warn"); return; }

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form wide" role="dialog" aria-modal="true"><h3>New checklist from research notes</h3>' +
      '<p class="modal-hint">Tick the notes to convert. Each becomes a checklist item linked back to the note.</p>' +
      '<label class="fld"><span>Checklist name</span><input data-f="name" type="text" placeholder="e.g. Safety guideline follow-ups"></label>' +
      '<label class="fld"><span>Category</span><select data-f="category">' + CATEGORIES.map((cx) => "<option>" + cx + "</option>").join("") + "</select></label>" +
      '<div class="fn-list"></div>' +
      '<div class="row"><button class="btn has-label" data-act="cancel">Cancel</button>' +
      '<button class="btn has-label primary" data-act="save">Create checklist</button></div></div>';

    const list = backdrop.querySelector(".fn-list");
    notes.slice(0, 300).forEach((n) => {
      const row = document.createElement("label");
      row.className = "fn-row";
      row.innerHTML = '<input type="checkbox" value="' + n.id + '"><span class="fn-text"></span><span class="fn-meta"></span>';
      row.querySelector(".fn-text").textContent = clip(n.body || n.quote || "(note)", 90);
      row.querySelector(".fn-meta").textContent = [n.category, n.source, n.page ? "p." + n.page : ""].filter(Boolean).join(" · ");
      list.appendChild(row);
    });

    const q = (s) => backdrop.querySelector(s);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    setTimeout(() => q('[data-f="name"]').focus(), 30);
    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); };
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    q('[data-act="cancel"]').addEventListener("click", close);
    q('[data-act="save"]').addEventListener("click", async () => {
      const ids = Array.from(list.querySelectorAll("input:checked")).map((i) => i.value);
      if (!ids.length) { App.toast("Tick at least one note", "warn"); return; }
      const name = q('[data-f="name"]').value.trim() || "Checklist from notes";
      const rec = {
        id: util.uid("chk"), name, category: q('[data-f="category"]').value,
        projectId: App.activeProjectId || null, createdAt: Date.now(),
        items: ids.map((nid) => {
          const n = notes.find((x) => x.id === nid);
          return { id: util.uid("ci"), text: clip((n && (n.body || n.quote)) || "(note)", 200), done: false,
                   link: { type: "note", noteId: nid, label: "Note" + (n && n.page ? " · p." + n.page : "") } };
        }),
      };
      cache.push(rec); currentId = rec.id;
      await persist(rec);
      close(); render();
      App.toast("Checklist created from " + ids.length + " notes", "ok");
    });
  }

  /* ------------------------------ Export ---------------------------------- */
  function checklistTxt(c) {
    const p = progressOf(c);
    const lines = ["CHECKLIST: " + c.name, "Category: " + (c.category || "—"), "Progress: " + p.done + " / " + p.total, ""];
    (c.items || []).forEach((it) => {
      lines.push((it.done ? "[x] " : "[ ] ") + it.text + (it.link && it.link.label ? "   (" + it.link.label + ")" : ""));
    });
    return lines.join("\n");
  }
  function exportTxtOne(c) {
    util.downloadFile(slug(c.name) + ".txt", checklistTxt(c), "text/plain");
  }
  function exportTxtAll() {
    const rows = cache.slice();
    if (!rows.length) return App.toast("No checklists to export", "warn");
    util.downloadFile("checklists-" + stamp() + ".txt", rows.map(checklistTxt).join("\n\n" + "=".repeat(50) + "\n\n"), "text/plain");
  }
  function exportCsvFor(rows, nameHint) {
    if (!rows.length) return App.toast("No checklists to export", "warn");
    const head = ["checklist", "category", "item", "done", "link"].join(",");
    const body = [];
    rows.forEach((c) => (c.items || []).forEach((it) => {
      body.push([csvCell(c.name), csvCell(c.category), csvCell(it.text), it.done ? "yes" : "no", csvCell(it.link ? it.link.label : "")].join(","));
    }));
    util.downloadFile(slug(nameHint || "checklists") + "-" + stamp() + ".csv", head + "\n" + body.join("\n"), "text/csv");
  }
  function exportCsvAll() { exportCsvFor(cache.slice(), "checklists"); }
  function exportJsonAll() {
    if (!cache.length) return App.toast("No checklists to export", "warn");
    util.downloadFile("checklists-" + stamp() + ".json", JSON.stringify(cache, null, 2), "application/json");
  }

  /* ------------------------------ Helpers --------------------------------- */
  function on(id, fn) { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); }
  function clip(s, n) { s = s || ""; return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function esc(s) { return util.escapeHtml(s); }
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function slug(s) { return (s || "checklist").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "checklist"; }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  App.Checklists = {
    init, getAll: () => cache, reload: load, openNew, CATEGORIES,
    select: (id) => { currentId = id; render(); },
    exportTxtAll, exportCsvAll, exportJsonAll,
  };
})();
