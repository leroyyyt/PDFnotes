/* =============================================================================
   figures.js — Figure & Table collector.

   Capture a rectangular region of the rendered PDF page (PDF canvas + drawn
   annotations are composited) into a PNG, then save it as a Figure or Table
   with title, source, page, notes and tags. Browse everything in a gallery and
   export the metadata as CSV / JSON.

   Record shape:
     { id, projectId, docId, kind('figure'|'table'), title, source, page,
       notes, tags[], image(dataURL), createdAt, updatedAt }

   Exposed as window.App.Figures.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus, util } = App;

  let cache = [];
  let listEl, searchEl, kindEl, projEl, countEl;
  let capturing = false, captureOverlay = null, startPt = null, rectEl = null;

  function init() {
    listEl = document.getElementById("fig-list");
    searchEl = document.getElementById("fig-search");
    kindEl = document.getElementById("fig-kind");
    projEl = document.getElementById("fig-project");
    countEl = document.getElementById("fig-count");

    const capBtn = document.getElementById("capture-toggle");
    if (capBtn) capBtn.addEventListener("click", toggleCapture);
    document.getElementById("fig-add").addEventListener("click", () => openEditor(blank(), null));
    document.getElementById("fig-export-csv").addEventListener("click", exportCsv);
    document.getElementById("fig-export-json").addEventListener("click", exportJson);
    [searchEl, kindEl, projEl].forEach((el) => el && el.addEventListener("input", render));

    bus.on("projects:changed", () => { refreshProjectFilter(); render(); });
    bus.on("doc:closed", () => { if (capturing) stopCapture(); });
    bus.on("page:changed", () => { /* selection invalidated by re-render */ });
    load();
  }

  function blank() {
    return {
      id: null, projectId: App.activeProjectId || null,
      docId: state.docId || null, kind: "figure",
      title: "", source: (state.docMeta && state.docMeta.name) || "",
      page: state.page || 1, notes: "", tags: [], image: "",
      createdAt: null, updatedAt: null,
    };
  }

  async function load() { cache = await App.Storage.getAllFigures(); render(); }

  async function save(rec) {
    const now = Date.now();
    if (!rec.id) { rec.id = util.uid("fig"); rec.createdAt = now; }
    rec.updatedAt = now;
    await App.Storage.saveFigure(rec);
    const i = cache.findIndex((r) => r.id === rec.id);
    if (i === -1) cache.push(rec); else cache[i] = rec;
    render();
    bus.emit("figures:changed", {});
    App.toast(rec.kind === "table" ? "Table saved" : "Figure saved", "ok");
  }

  async function remove(id) {
    const ok = await App.confirmDialog({ title: "Delete item?", message: "This figure/table will be permanently removed.", okText: "Delete", danger: true });
    if (!ok) return;
    await App.Storage.deleteFigure(id);
    cache = cache.filter((r) => r.id !== id);
    render();
    bus.emit("figures:changed", {});
  }

  /* --------------------------- Capture mode ------------------------------ */
  function toggleCapture() {
    if (capturing) { stopCapture(); return; }
    if (!state.pdfDoc) { App.toast("Open a PDF first", "warn"); return; }
    App.switchView("reader");
    startCapture();
  }

  function startCapture() {
    const container = document.getElementById("page-container");
    if (!container) return;
    capturing = true;
    document.getElementById("capture-toggle").classList.add("active");
    App.toast("Drag a box over the figure or table to capture it", "info");

    captureOverlay = document.createElement("div");
    captureOverlay.className = "capture-overlay";
    container.appendChild(captureOverlay);

    captureOverlay.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.addEventListener("keydown", onEsc);
  }

  function stopCapture() {
    capturing = false;
    const btn = document.getElementById("capture-toggle");
    if (btn) btn.classList.remove("active");
    if (captureOverlay) {
      captureOverlay.removeEventListener("pointerdown", onDown);
      captureOverlay.remove();
      captureOverlay = null;
    }
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.removeEventListener("keydown", onEsc);
    startPt = null; rectEl = null;
  }
  function onEsc(e) { if (e.key === "Escape") stopCapture(); }

  function onDown(e) {
    e.preventDefault();
    const r = captureOverlay.getBoundingClientRect();
    startPt = { x: e.clientX - r.left, y: e.clientY - r.top };
    rectEl = document.createElement("div");
    rectEl.className = "capture-rect";
    rectEl.style.left = startPt.x + "px"; rectEl.style.top = startPt.y + "px";
    captureOverlay.appendChild(rectEl);
  }
  function onMove(e) {
    if (!startPt || !rectEl) return;
    const r = captureOverlay.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    rectEl.style.left = Math.min(startPt.x, x) + "px";
    rectEl.style.top = Math.min(startPt.y, y) + "px";
    rectEl.style.width = Math.abs(x - startPt.x) + "px";
    rectEl.style.height = Math.abs(y - startPt.y) + "px";
  }
  function onUp(e) {
    if (!startPt || !rectEl) return;
    const r = captureOverlay.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const sel = {
      x: Math.min(startPt.x, x), y: Math.min(startPt.y, y),
      w: Math.abs(x - startPt.x), h: Math.abs(y - startPt.y),
    };
    startPt = null;
    const keep = sel.w > 8 && sel.h > 8;
    const dataUrl = keep ? cropRegion(sel) : "";
    stopCapture();
    if (!keep) { App.toast("Selection too small", "warn"); return; }
    const rec = blank();
    rec.image = dataUrl;
    openEditor(rec, null);
  }

  // Composite the PDF canvas + annotation canvas for the selected CSS region.
  function cropRegion(sel) {
    const pdfCanvas = document.getElementById("pdf-canvas");
    const annoCanvas = document.getElementById("anno-canvas");
    const dpr = window.devicePixelRatio || 1;
    const sx = sel.x * dpr, sy = sel.y * dpr, sw = sel.w * dpr, sh = sel.h * dpr;

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sw));
    out.height = Math.max(1, Math.round(sh));
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out.width, out.height);
    try {
      if (pdfCanvas) ctx.drawImage(pdfCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
      if (annoCanvas && annoCanvas.width) ctx.drawImage(annoCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
      return out.toDataURL("image/png");
    } catch (e) {
      console.error("capture failed", e);
      App.toast("Could not capture this region", "err");
      return "";
    }
  }

  /* ------------------------------ Render --------------------------------- */
  function render() {
    if (!listEl) return;
    const q = val(searchEl).toLowerCase();
    const kind = val(kindEl);
    const proj = val(projEl);

    let rows = cache.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    if (proj) rows = rows.filter((r) => (proj === "__none__" ? !r.projectId : r.projectId === proj));
    if (kind) rows = rows.filter((r) => r.kind === kind);
    if (q) rows = rows.filter((r) => [r.title, r.source, r.notes, (r.tags || []).join(" ")].join(" ").toLowerCase().indexOf(q) !== -1);

    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? " item" : " items");
    if (!rows.length) { listEl.innerHTML = empty(); return; }
    listEl.innerHTML = "";
    rows.forEach((r) => listEl.appendChild(card(r)));
  }

  function card(r) {
    const el = document.createElement("div");
    el.className = "fig-card";
    el.innerHTML =
      '<div class="fig-thumb"></div>' +
      '<div class="fig-meta">' +
        '<div class="fig-titlerow"><span class="fig-kind ' + r.kind + '">' + (r.kind === "table" ? "Table" : "Figure") + "</span>" +
          '<span class="fig-title"></span></div>' +
        '<div class="fig-src"></div>' +
        (r.notes ? '<div class="fig-notes"></div>' : "") +
        (r.tags && r.tags.length ? '<div class="note-tags">' + r.tags.map((t) => '<span class="tag-chip">' + esc(t) + "</span>").join("") + "</div>" : "") +
      "</div>" +
      '<div class="fig-actions"></div>';

    const thumb = el.querySelector(".fig-thumb");
    if (r.image) {
      const img = document.createElement("img"); img.src = r.image; img.alt = r.title || "captured region";
      img.addEventListener("click", () => previewImage(r));
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = App.Icons.get(r.kind === "table" ? "table" : "image");
      thumb.classList.add("no-img");
    }
    el.querySelector(".fig-title").textContent = r.title || "Untitled " + (r.kind === "table" ? "table" : "figure");
    const src = [r.source, r.page ? "p. " + r.page : ""].filter(Boolean).join(" · ");
    el.querySelector(".fig-src").textContent = src;
    el.querySelector(".fig-src").title = src;
    if (r.notes) el.querySelector(".fig-notes").textContent = r.notes;

    const actions = el.querySelector(".fig-actions");
    if (r.docId) actions.appendChild(iconBtn("fileText", "Go to source", () => { if (App.openDocumentById) App.openDocumentById(r.docId, r.page); }));
    actions.appendChild(iconBtn("edit", "Edit", () => openEditor(Object.assign({}, r), r.id)));
    actions.appendChild(iconBtn("trash", "Delete", () => remove(r.id), "del"));
    return el;
  }

  function previewImage(r) {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop show img-preview";
    bd.innerHTML = '<div class="img-preview-box"><img alt=""><div class="img-preview-cap"></div></div>';
    bd.querySelector("img").src = r.image;
    bd.querySelector(".img-preview-cap").textContent = (r.title || "Captured region") + (r.source ? " — " + r.source + (r.page ? ", p. " + r.page : "") : "");
    bd.addEventListener("click", () => bd.remove());
    document.body.appendChild(bd);
  }

  /* ------------------------------ Editor --------------------------------- */
  function openEditor(rec, id) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form" role="dialog" aria-modal="true">' +
      "<h3>" + (id ? "Edit item" : "Save figure / table") + "</h3>" +
      (rec.image ? '<div class="fig-edit-preview"><img alt="preview"></div>' : "") +
      '<div class="form-grid">' +
        '<label class="fld"><span>Type</span><select data-f="kind"><option value="figure">Figure</option><option value="table">Table</option></select></label>' +
        '<label class="fld"><span>Page</span><input data-f="page" type="number" min="1"></label>' +
        '<label class="fld span2"><span>Title</span><input data-f="title" type="text" placeholder="e.g. Fig. 3 — NH3 phase diagram"></label>' +
        '<label class="fld span2"><span>Source PDF</span><input data-f="source" type="text"></label>' +
        '<label class="fld span2"><span>Notes</span><textarea data-f="notes" rows="2"></textarea></label>' +
        '<label class="fld span2"><span>Tags (comma separated)</span><input data-f="tags" type="text"></label>' +
        '<label class="fld span2"><span>Project</span><select data-f="projectId"></select></label>' +
      "</div>" +
      '<div class="row">' +
        '<button class="btn has-label" data-act="cancel">Cancel</button>' +
        '<button class="btn has-label primary" data-act="save">Save</button>' +
      "</div></div>";

    if (rec.image) backdrop.querySelector(".fig-edit-preview img").src = rec.image;
    const q = (s) => backdrop.querySelector(s);
    q('[data-f="kind"]').value = rec.kind || "figure";
    q('[data-f="page"]').value = rec.page || 1;
    q('[data-f="title"]').value = rec.title || "";
    q('[data-f="source"]').value = rec.source || "";
    q('[data-f="notes"]').value = rec.notes || "";
    q('[data-f="tags"]').value = (rec.tags || []).join(", ");
    App.fillProjectSelect(q('[data-f="projectId"]'), rec.projectId);
    if (App.Tags) App.Tags.attachSuggestions(q('[data-f="tags"]'));

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    setTimeout(() => q('[data-f="title"]').focus(), 30);

    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    q('[data-act="cancel"]').addEventListener("click", close);
    q('[data-act="save"]').addEventListener("click", () => {
      rec.kind = q('[data-f="kind"]').value;
      rec.page = parseInt(q('[data-f="page"]').value, 10) || rec.page || 1;
      rec.title = q('[data-f="title"]').value.trim();
      rec.source = q('[data-f="source"]').value.trim();
      rec.notes = q('[data-f="notes"]').value.trim();
      rec.tags = q('[data-f="tags"]').value.split(",").map((s) => s.trim()).filter(Boolean);
      const pv = q('[data-f="projectId"]').value;
      rec.projectId = pv === "__none__" ? null : pv;
      close(); save(rec);
      App.switchView("figures");
    });
  }

  /* ------------------------------ Export --------------------------------- */
  function currentRows() {
    let rows = cache.slice();
    if (App.activeProjectId) rows = rows.filter((r) => r.projectId === App.activeProjectId);
    return rows;
  }
  function exportJson() {
    const rows = currentRows().map((r) => Object.assign({}, r)); // include image data URLs
    if (!rows.length) return App.toast("Nothing to export", "warn");
    util.downloadFile("figures-tables-" + stamp() + ".json", JSON.stringify(rows, null, 2), "application/json");
  }
  function exportCsv() {
    const rows = currentRows();
    if (!rows.length) return App.toast("Nothing to export", "warn");
    const cols = ["kind", "title", "source", "page", "notes", "tags", "hasImage"];
    const head = cols.join(",");
    const body = rows.map((r) => [
      r.kind, csvCell(r.title), csvCell(r.source), r.page,
      csvCell(r.notes), csvCell((r.tags || []).join("; ")), r.image ? "yes" : "no",
    ].join(",")).join("\n");
    util.downloadFile("figures-tables-" + stamp() + ".csv", head + "\n" + body, "text/csv");
  }

  /* ------------------------------ Helpers -------------------------------- */
  function refreshProjectFilter() {
    if (!projEl) return;
    const cur = projEl.value;
    const projects = (App.getProjects && App.getProjects()) || [];
    projEl.innerHTML = '<option value="">All projects</option><option value="__none__">Unfiled</option>' +
      projects.map((p) => '<option value="' + p.id + '">' + esc(p.name) + "</option>").join("");
    projEl.value = cur;
  }
  function iconBtn(icon, title, fn, extra) {
    const b = document.createElement("button");
    b.className = "ghost-icon " + (extra || ""); b.title = title; b.innerHTML = App.Icons.get(icon);
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function val(el) { return el ? el.value.trim() : ""; }
  function empty() { return '<div class="empty-state">' + App.Icons.get("image") + "<p>No figures or tables yet. Open a PDF, click “Capture”, and drag a box around a figure.</p></div>"; }
  function esc(s) { return util.escapeHtml(s); }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  App.Figures = { init, getAll: () => cache, refreshProjectFilter, reload: load };
})();
