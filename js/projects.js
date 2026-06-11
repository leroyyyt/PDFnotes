/* =============================================================================
   projects.js — Local project organisation.

   A project is a lightweight container { id, name, color, createdAt, updatedAt }.
   PDFs, notes, literature entries, citations and figures each carry a nullable
   projectId. Choosing an "active" project filters every section to that
   project; "All projects" clears the filter.

   This module also provides the shared helpers other modules depend on:
     App.activeProjectId, App.getProjects(), App.fillProjectSelect(sel, id),
     App.setActiveProject(id).

   Emits : projects:changed
   Exposed as window.App.Projects.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { bus, util } = App;

  const COLORS = ["#ffb020", "#5b9dff", "#38cf90", "#ff5f5f", "#c879ff", "#21c7d6", "#ffa94d", "#f78fb3"];
  const SEEDS = ["Dissertation", "Internship", "CN2106", "Ammonia Safety Guideline", "CO2 Safety Guideline"];

  let cache = [];
  let listEl, navSelect;

  // ---- shared helpers exposed immediately (used by other modules) ----------
  App.activeProjectId = null;
  App.getProjects = () => cache.slice();
  App.fillProjectSelect = function (sel, selectedId) {
    if (!sel) return;
    sel.innerHTML = '<option value="__none__">Unfiled</option>' +
      cache.map((p) => '<option value="' + p.id + '"' + (p.id === selectedId ? " selected" : "") + ">" + esc(p.name) + "</option>").join("");
  };
  App.setActiveProject = setActive;

  function init() {
    listEl = document.getElementById("proj-list");
    navSelect = document.getElementById("nav-project-select");

    const addBtn = document.getElementById("proj-add");
    if (addBtn) addBtn.addEventListener("click", () => openEditor(blank()));
    const seedBtn = document.getElementById("proj-seed");
    if (seedBtn) seedBtn.addEventListener("click", seedExamples);
    if (navSelect) navSelect.addEventListener("change", () => setActive(navSelect.value || null));

    // re-render counts when any underlying data changes
    ["notes:changed", "literature:changed", "citations:changed", "figures:changed", "documents:changed"].forEach((ev) => bus.on(ev, render));

    load();
  }

  function blank() {
    return { id: null, name: "", color: COLORS[cache.length % COLORS.length], createdAt: null, updatedAt: null };
  }

  async function load() {
    cache = await App.Storage.getAllProjects();
    cache.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const active = await App.Storage.getMeta("activeProject");
    App.activeProjectId = active || null;
    syncNavSelect();
    render();
    bus.emit("projects:changed", {});
  }

  async function save(p) {
    const now = Date.now();
    if (!p.id) { p.id = util.uid("proj"); p.createdAt = now; }
    p.updatedAt = now;
    await App.Storage.saveProject(p);
    const i = cache.findIndex((x) => x.id === p.id);
    if (i === -1) cache.push(p); else cache[i] = p;
    syncNavSelect();
    render();
    bus.emit("projects:changed", {});
    App.toast("Project saved", "ok");
  }

  async function remove(id) {
    const ok = await App.confirmDialog({
      title: "Delete project?",
      message: "The project will be removed. PDFs, notes, literature, citations and figures inside it are kept but moved to “Unfiled”.",
      okText: "Delete", danger: true,
    });
    if (!ok) return;
    await App.Storage.deleteProject(id);
    cache = cache.filter((p) => p.id !== id);
    if (App.activeProjectId === id) { App.activeProjectId = null; await App.Storage.setMeta("activeProject", null); }
    // children were detached in storage — refresh modules that cache them
    reloadDependents();
    syncNavSelect();
    render();
    bus.emit("projects:changed", {});
  }

  function reloadDependents() {
    if (App.Notes && App.Notes.reloadAll) App.Notes.reloadAll();
    if (App.Literature && App.Literature.reload) App.Literature.reload();
    if (App.Citations && App.Citations.reload) App.Citations.reload();
    if (App.Figures && App.Figures.reload) App.Figures.reload();
    if (App.Formulas && App.Formulas.reload) App.Formulas.reload();
    if (App.Checklists && App.Checklists.reload) App.Checklists.reload();
    bus.emit("documents:reload", {});
  }

  async function setActive(id) {
    App.activeProjectId = id || null;
    await App.Storage.setMeta("activeProject", App.activeProjectId);
    syncNavSelect();
    render();
    bus.emit("projects:changed", {});
    const name = id ? (cache.find((p) => p.id === id) || {}).name : null;
    App.toast(name ? "Active project: " + name : "Showing all projects", "info");
  }

  function syncNavSelect() {
    if (!navSelect) return;
    navSelect.innerHTML = '<option value="">All projects</option>' +
      cache.map((p) => '<option value="' + p.id + '">' + esc(p.name) + "</option>").join("");
    navSelect.value = App.activeProjectId || "";
  }

  /* ------------------------------ Counts --------------------------------- */
  function countsFor(id) {
    const byProj = (arr) => (arr || []).filter((r) => r.projectId === id).length;
    return {
      docs: byProj(App.getDocuments ? App.getDocuments() : []),
      notes: byProj(App.Notes ? App.Notes.getAll() : []),
      lit: byProj(App.Literature ? App.Literature.getAll() : []),
      cites: byProj(App.Citations ? App.Citations.getAll() : []),
      figs: byProj(App.Figures ? App.Figures.getAll() : []),
      fxs: byProj(App.Formulas ? App.Formulas.getAll() : []),
      chks: byProj(App.Checklists ? App.Checklists.getAll() : []),
    };
  }

  /* ------------------------------ Render --------------------------------- */
  function render() {
    if (!listEl) return;
    if (!cache.length) {
      listEl.innerHTML =
        '<div class="empty-state">' + App.Icons.get("folder") +
        "<p>No projects yet. Create one to group PDFs, notes, literature, citations and figures.</p></div>";
      return;
    }
    listEl.innerHTML = "";
    cache.forEach((p) => listEl.appendChild(card(p)));
  }

  function card(p) {
    const c = countsFor(p.id);
    const active = App.activeProjectId === p.id;
    const el = document.createElement("div");
    el.className = "proj-card" + (active ? " active" : "");
    el.innerHTML =
      '<div class="proj-top">' +
        '<span class="proj-dot" style="background:' + p.color + '"></span>' +
        '<span class="proj-name"></span>' +
        (active ? '<span class="proj-active-badge">Active</span>' : "") +
        '<div class="proj-actions"></div>' +
      "</div>" +
      '<div class="proj-counts">' +
        chip("file", c.docs, "PDFs") + chip("note", c.notes, "notes") +
        chip("book", c.lit, "lit.") + chip("quote", c.cites, "cites") +
        chip("image", c.figs, "figs") +
        chip("sigma", c.fxs, "formulas") + chip("listChecks", c.chks, "lists") +
      "</div>";
    el.querySelector(".proj-name").textContent = p.name;

    const actions = el.querySelector(".proj-actions");
    if (!active) actions.appendChild(textBtn("Set active", () => setActive(p.id), "primary"));
    else actions.appendChild(textBtn("Show all", () => setActive(null)));
    actions.appendChild(iconBtn("edit", "Rename", () => openEditor(Object.assign({}, p))));
    actions.appendChild(iconBtn("trash", "Delete", () => remove(p.id), "del"));
    return el;
  }
  function chip(icon, n, label) {
    return '<span class="proj-count"><span class="pc-ico">' + App.Icons.get(icon) + "</span>" + n + " <em>" + label + "</em></span>";
  }

  /* ------------------------------ Editor --------------------------------- */
  function openEditor(p) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form" role="dialog" aria-modal="true">' +
      "<h3>" + (p.id ? "Rename project" : "New project") + "</h3>" +
      '<label class="fld"><span>Project name</span><input data-f="name" type="text" placeholder="e.g. Ammonia Safety Guideline"></label>' +
      '<label class="fld"><span>Colour</span><div class="swatch-row" data-f="color"></div></label>' +
      '<div class="row">' +
        '<button class="btn has-label" data-act="cancel">Cancel</button>' +
        '<button class="btn has-label primary" data-act="save">Save</button>' +
      "</div></div>";

    const nameEl = backdrop.querySelector('[data-f="name"]');
    nameEl.value = p.name || "";
    const swRow = backdrop.querySelector('[data-f="color"]');
    let chosen = p.color || COLORS[0];
    COLORS.forEach((col) => {
      const b = document.createElement("button");
      b.className = "swatch" + (col === chosen ? " sel" : "");
      b.style.background = col; b.type = "button"; b.title = col;
      b.addEventListener("click", () => { chosen = col; swRow.querySelectorAll(".swatch").forEach((s) => s.classList.remove("sel")); b.classList.add("sel"); });
      swRow.appendChild(b);
    });

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    setTimeout(() => nameEl.focus(), 30);

    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); if (e.key === "Enter") doSave(); };
    const doSave = () => {
      const name = nameEl.value.trim();
      if (!name) { App.toast("Enter a project name", "warn"); return; }
      p.name = name; p.color = chosen;
      close(); save(p);
    };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", close);
    backdrop.querySelector('[data-act="save"]').addEventListener("click", doSave);
  }

  async function seedExamples() {
    const existing = new Set(cache.map((p) => p.name.toLowerCase()));
    const toAdd = SEEDS.filter((n) => !existing.has(n.toLowerCase()));
    if (!toAdd.length) { App.toast("Example projects already exist", "info"); return; }
    let i = cache.length;
    for (const name of toAdd) {
      await App.Storage.saveProject({ id: util.uid("proj"), name, color: COLORS[i % COLORS.length], createdAt: Date.now() + i, updatedAt: Date.now() });
      i++;
    }
    await load();
    App.toast("Added " + toAdd.length + " example projects", "ok");
  }

  /* ------------------------------ Helpers -------------------------------- */
  function iconBtn(icon, title, fn, extra) {
    const b = document.createElement("button");
    b.className = "ghost-icon " + (extra || ""); b.title = title; b.innerHTML = App.Icons.get(icon);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function textBtn(label, fn, extra) {
    const b = document.createElement("button");
    b.className = "btn has-label tiny " + (extra || ""); b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function esc(s) { return util.escapeHtml(s); }

  App.Projects = { init, list: () => cache.slice(), reload: load };
})();
