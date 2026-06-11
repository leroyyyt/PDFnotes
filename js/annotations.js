/* =============================================================================
   annotations.js — Vector + DOM annotations drawn directly on the page.

   Annotation families:
     DRAW (vector, drawn on #anno-canvas by dragging):
       highlight | underline | strikethrough | rectangle | circle | arrow | freehand
     CLICK (DOM elements placed with a single click, in #anno-dom):
       sticky | freetext

   Coordinates are stored in PDF user space so they survive zoom and rotation.
   On input we convert viewport px -> PDF points (viewport.convertToPdfPoint);
   on render we convert PDF points -> viewport px (viewport.convertToViewportPoint).

   Listens : page:rendered, doc:closed
   Emits   : annotations:changed, tool:changed, note:fromSelection { text, page }
   Exposed as window.App.Annotations.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus, util } = App;

  let canvas, ctx, domLayer, container;
  let dpr = 1;

  // in-progress drawing
  let drawing = false;
  let startVp = null;        // {x,y} viewport px at pointer-down
  let curVp = null;          // {x,y} current viewport px
  let freehandPts = null;    // array of {x,y} viewport px while drawing freehand

  let outlineEl = null;      // selection outline element
  let popupEl = null;        // sticky text popup

  const HIT_TOL = 6;         // px tolerance for selecting line-like annotations

  function init() {
    canvas = document.getElementById("anno-canvas");
    ctx = canvas.getContext("2d");
    domLayer = document.getElementById("anno-dom");
    container = document.getElementById("page-container");

    canvas.addEventListener("pointerdown", onCanvasPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    // Selection / deselection of vector annotations happens in select mode.
    container.addEventListener("click", onContainerClick);
    document.addEventListener("keydown", onKeyDown);

    bus.on("page:rendered", renderLayer);
    bus.on("doc:closed", () => { clearOutline(); closePopup(); if (ctx) clearCanvas(); if (domLayer) domLayer.innerHTML = ""; });
  }

  /* --------------------------- Coordinate maths -------------------------- */
  function toView(pt) {
    const v = state.viewport.convertToViewportPoint(pt[0], pt[1]);
    return { x: v[0], y: v[1] };
  }
  function toPdf(x, y) {
    return state.viewport.convertToPdfPoint(x, y);
  }
  function relPos(evt) {
    const r = canvas.getBoundingClientRect();
    return { x: evt.clientX - r.left, y: evt.clientY - r.top };
  }
  // Bounding box (viewport px) for an annotation, used for hit-test + outline.
  function bboxOf(a) {
    if (a.kind === "rect" || a.type === "highlight" || a.type === "underline" ||
        a.type === "strikethrough" || a.type === "rectangle" || a.type === "circle") {
      const p = toView(a.a), q = toView(a.b);
      return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) };
    }
    if (a.type === "arrow") {
      const p = toView(a.a), q = toView(a.b);
      return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(p.x - q.x), h: Math.abs(p.y - q.y) };
    }
    if (a.type === "freehand") {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      a.points.forEach((pt) => { const v = toView(pt); minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); });
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return null;
  }

  /* ------------------------------ Colours -------------------------------- */
  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "#ffb020");
    if (!m) return "rgba(255,176,32," + alpha + ")";
    return "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + alpha + ")";
  }

  /* ------------------------------ Rendering ------------------------------ */
  function clearCanvas() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function renderLayer() {
    if (!state.viewport) return;
    const vp = state.viewport;
    const w = Math.floor(vp.width), h = Math.floor(vp.height);
    dpr = window.devicePixelRatio || 1;

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    domLayer.innerHTML = "";
    clearCanvas();

    const onPage = state.annotations.filter((a) => a.page === state.page);
    onPage.forEach((a) => {
      if (a.type === "sticky" || a.type === "freetext") placeDomAnno(a);
      else drawVector(a);
    });

    // Re-show selection outline if the selected annotation is on this page.
    if (state.selectedAnnoId) {
      const sel = onPage.find((a) => a.id === state.selectedAnnoId);
      if (sel) drawOutline(sel); else clearOutline();
    }
  }

  function drawVector(a) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (a.type === "highlight") {
      const b = bboxOf(a);
      ctx.fillStyle = hexToRgba(a.color, 0.32);
      ctx.fillRect(b.x, b.y, b.w, b.h);
    } else if (a.type === "underline" || a.type === "strikethrough") {
      const p = toView(a.a), q = toView(a.b);
      const y = a.type === "underline" ? Math.max(p.y, q.y) - 1.5 : (p.y + q.y) / 2;
      ctx.strokeStyle = a.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(Math.min(p.x, q.x), y); ctx.lineTo(Math.max(p.x, q.x), y); ctx.stroke();
    } else if (a.type === "rectangle") {
      const b = bboxOf(a);
      ctx.strokeStyle = a.color; ctx.lineWidth = 2;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    } else if (a.type === "circle") {
      const b = bboxOf(a);
      ctx.strokeStyle = a.color; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w / 2, 1), Math.max(b.h / 2, 1), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (a.type === "arrow") {
      drawArrow(toView(a.a), toView(a.b), a.color);
    } else if (a.type === "freehand") {
      ctx.strokeStyle = a.color; ctx.lineWidth = 2.25;
      ctx.beginPath();
      a.points.forEach((pt, i) => { const v = toView(pt); i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y); });
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawArrow(p, q, color) {
    const head = 11, ang = Math.atan2(q.y - p.y, q.x - p.x);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.25;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(q.x, q.y);
    ctx.lineTo(q.x - head * Math.cos(ang - Math.PI / 7), q.y - head * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(q.x - head * Math.cos(ang + Math.PI / 7), q.y - head * Math.sin(ang + Math.PI / 7));
    ctx.closePath(); ctx.fill();
  }

  /* ----------------------- DOM annotations (sticky/text) ----------------- */
  function placeDomAnno(a) {
    const pos = toView(a.at);
    if (a.type === "sticky") {
      const el = document.createElement("div");
      el.className = "sticky"; el.dataset.id = a.id;
      el.style.left = pos.x + "px"; el.style.top = pos.y + "px";
      el.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="' + a.color + '"/>' +
        '<path d="M16 3v5h5z" fill="rgba(0,0,0,.22)"/></svg>' +
        (a.text ? '<span class="sticky-dot">●</span>' : "");
      el.title = a.text || "Empty note — click to edit";
      makeDraggable(el, a, () => openStickyPopup(el, a));
      domLayer.appendChild(el);
    } else if (a.type === "freetext") {
      const el = document.createElement("div");
      el.className = "freetext-anno"; el.dataset.id = a.id;
      el.style.left = pos.x + "px"; el.style.top = pos.y + "px";
      el.style.color = a.color;
      el.textContent = a.text || "";
      makeDraggable(el, a, () => startEditFreetext(el, a));
      domLayer.appendChild(el);
    }
  }

  // Drag handler that also distinguishes a click (no movement) for editing.
  function makeDraggable(el, a, onClick) {
    let dragging = false, moved = false, sx = 0, sy = 0, origVp = null;
    el.addEventListener("pointerdown", (e) => {
      if (state.tool !== "select") return;       // only movable in select mode
      if (el.getAttribute("contenteditable") === "true") return;
      e.stopPropagation();
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      origVp = toView(a.at);
      select(a.id);
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      el.style.left = origVp.x + dx + "px";
      el.style.top = origVp.y + dy + "px";
      if (outlineEl) { outlineEl.style.left = (origVp.x + dx - 3) + "px"; outlineEl.style.top = (origVp.y + dy - 3) + "px"; }
    });
    el.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) {
        const nx = parseFloat(el.style.left), ny = parseFloat(el.style.top);
        a.at = toPdf(nx, ny);
        persist();
        drawOutline(a);
      } else if (onClick) {
        onClick();
      }
    });
  }

  function startEditFreetext(el, a) {
    el.setAttribute("contenteditable", "true");
    el.focus();
    // place caret at end
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const finish = () => {
      el.removeEventListener("blur", finish);
      el.setAttribute("contenteditable", "false");
      a.text = el.textContent.trim();
      if (!a.text) { remove(a.id); } else { persist(); }
    };
    el.addEventListener("blur", finish);
  }

  function openStickyPopup(anchorEl, a) {
    closePopup();
    select(a.id);
    popupEl = document.createElement("div");
    popupEl.className = "anno-popup";
    popupEl.innerHTML =
      '<textarea placeholder="Sticky note…"></textarea>' +
      '<div class="row">' +
      '<button class="btn has-label" data-act="del">Delete</button>' +
      '<button class="btn has-label primary" data-act="save">Save</button>' +
      "</div>";
    const ta = popupEl.querySelector("textarea");
    ta.value = a.text || "";
    document.body.appendChild(popupEl);

    const r = anchorEl.getBoundingClientRect();
    const px = Math.min(r.left, window.innerWidth - 270);
    const py = Math.min(r.bottom + 8, window.innerHeight - 160);
    popupEl.style.left = Math.max(8, px) + "px";
    popupEl.style.top = py + "px";
    setTimeout(() => ta.focus(), 20);

    popupEl.querySelector('[data-act="save"]').addEventListener("click", () => {
      a.text = ta.value.trim(); persist(); closePopup(); renderLayer();
    });
    popupEl.querySelector('[data-act="del"]').addEventListener("click", () => {
      closePopup(); remove(a.id);
    });
  }
  function closePopup() { if (popupEl) { popupEl.remove(); popupEl = null; } }

  /* ----------------------------- Selection ------------------------------- */
  function onContainerClick(e) {
    if (state.tool !== "select" || drawing) return;
    if (e.target.closest(".anno-dom > *")) return;   // DOM anno handles itself
    const pos = relPosFromClient(e.clientX, e.clientY);
    const hit = hitTest(pos.x, pos.y);
    if (hit) select(hit.id); else deselect();
  }
  function relPosFromClient(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  }

  function hitTest(x, y) {
    const onPage = state.annotations.filter((a) => a.page === state.page && a.type !== "sticky" && a.type !== "freetext");
    for (let i = onPage.length - 1; i >= 0; i--) {
      const a = onPage[i];
      if (a.type === "arrow") {
        if (distToSeg({ x, y }, toView(a.a), toView(a.b)) <= HIT_TOL) return a;
      } else if (a.type === "freehand") {
        for (let j = 1; j < a.points.length; j++) {
          if (distToSeg({ x, y }, toView(a.points[j - 1]), toView(a.points[j])) <= HIT_TOL) return a;
        }
      } else {
        const b = bboxOf(a);
        if (x >= b.x - HIT_TOL && x <= b.x + b.w + HIT_TOL && y >= b.y - HIT_TOL && y <= b.y + b.h + HIT_TOL) return a;
      }
    }
    return null;
  }
  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx, cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  }

  function select(id) {
    state.selectedAnnoId = id;
    const a = state.annotations.find((x) => x.id === id);
    if (a) drawOutline(a);
    bus.emit("annotations:selection", { id });
  }
  function deselect() { state.selectedAnnoId = null; clearOutline(); bus.emit("annotations:selection", { id: null }); }

  function drawOutline(a) {
    clearOutline();
    let box;
    if (a.type === "sticky" || a.type === "freetext") {
      const el = domLayer.querySelector('[data-id="' + a.id + '"]');
      if (!el) return;
      const er = el.getBoundingClientRect(), cr = container.getBoundingClientRect();
      box = { x: er.left - cr.left, y: er.top - cr.top, w: er.width, h: er.height };
    } else {
      box = bboxOf(a);
    }
    outlineEl = document.createElement("div");
    outlineEl.className = "anno-selected-outline";
    outlineEl.style.left = (box.x - 3) + "px";
    outlineEl.style.top = (box.y - 3) + "px";
    outlineEl.style.width = (box.w + 6) + "px";
    outlineEl.style.height = (box.h + 6) + "px";
    container.appendChild(outlineEl);
  }
  function clearOutline() { if (outlineEl) { outlineEl.remove(); outlineEl = null; } }

  /* ------------------------------ Pointer -------------------------------- */
  function onCanvasPointerDown(e) {
    if (state.tool === "select") return;
    e.preventDefault();
    const pos = relPos(e);

    if (App.CLICK_TOOLS.indexOf(state.tool) !== -1) {
      placeClickTool(state.tool, pos);
      return;
    }
    drawing = true;
    startVp = pos;
    curVp = pos;
    freehandPts = state.tool === "freehand" ? [pos] : null;
    canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!drawing) return;
    curVp = relPos(e);
    if (freehandPts) freehandPts.push(curVp);
    renderLayer();
    drawPreview();
  }

  function onPointerUp(e) {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    commitDraw();
    startVp = curVp = freehandPts = null;
  }

  function drawPreview() {
    if (!startVp || !curVp) return;
    ctx.save();
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const c = state.color;
    if (state.tool === "highlight") {
      ctx.fillStyle = hexToRgba(c, 0.32);
      ctx.fillRect(Math.min(startVp.x, curVp.x), Math.min(startVp.y, curVp.y), Math.abs(curVp.x - startVp.x), Math.abs(curVp.y - startVp.y));
    } else if (state.tool === "underline" || state.tool === "strikethrough") {
      const y = state.tool === "underline" ? Math.max(startVp.y, curVp.y) : (startVp.y + curVp.y) / 2;
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(Math.min(startVp.x, curVp.x), y); ctx.lineTo(Math.max(startVp.x, curVp.x), y); ctx.stroke();
    } else if (state.tool === "rectangle") {
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(startVp.x, curVp.x), Math.min(startVp.y, curVp.y), Math.abs(curVp.x - startVp.x), Math.abs(curVp.y - startVp.y));
    } else if (state.tool === "circle") {
      ctx.strokeStyle = c; ctx.lineWidth = 2;
      const w = Math.abs(curVp.x - startVp.x), h = Math.abs(curVp.y - startVp.y);
      ctx.beginPath();
      ctx.ellipse(Math.min(startVp.x, curVp.x) + w / 2, Math.min(startVp.y, curVp.y) + h / 2, Math.max(w / 2, 1), Math.max(h / 2, 1), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (state.tool === "arrow") {
      drawArrow(startVp, curVp, c);
    } else if (state.tool === "freehand" && freehandPts) {
      ctx.strokeStyle = c; ctx.lineWidth = 2.25;
      ctx.beginPath();
      freehandPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.restore();
  }

  function commitDraw() {
    if (!startVp || !curVp) return;
    const tool = state.tool;
    const tiny = Math.abs(curVp.x - startVp.x) < 3 && Math.abs(curVp.y - startVp.y) < 3;

    if (tool === "freehand") {
      if (!freehandPts || freehandPts.length < 2) return;
      add({ type: "freehand", points: freehandPts.map((p) => toPdf(p.x, p.y)) });
      return;
    }
    if (tiny) return; // ignore accidental micro-drags for region/line tools

    const a = toPdf(startVp.x, startVp.y);
    const b = toPdf(curVp.x, curVp.y);
    const base = { type: tool, a, b };

    // Highlight/underline/strikethrough try to capture the underlying selected
    // text so they can later be turned into a research note.
    if (tool === "highlight" || tool === "underline" || tool === "strikethrough") {
      const sel = (window.getSelection && window.getSelection().toString()) || "";
      if (sel.trim()) base.quote = sel.trim().replace(/\s+/g, " ").slice(0, 1000);
    }
    add(base);
  }

  function placeClickTool(tool, pos) {
    const at = toPdf(pos.x, pos.y);
    if (tool === "sticky") {
      const a = add({ type: "sticky", at, text: "" });
      setTool("select");
      renderLayer();
      const el = domLayer.querySelector('[data-id="' + a.id + '"]');
      if (el) openStickyPopup(el, a);
    } else if (tool === "freetext") {
      const a = add({ type: "freetext", at, text: "" });
      setTool("select");
      renderLayer();
      const el = domLayer.querySelector('[data-id="' + a.id + '"]');
      if (el) startEditFreetext(el, a);
    }
  }

  /* --------------------------- Mutators ---------------------------------- */
  function add(partial) {
    const a = Object.assign(
      { id: util.uid("anno"), page: state.page, color: state.color, createdAt: Date.now() },
      partial
    );
    state.annotations.push(a);
    persist();
    renderLayer();
    return a;
  }
  function remove(id) {
    const i = state.annotations.findIndex((a) => a.id === id);
    if (i === -1) return;
    state.annotations.splice(i, 1);
    if (state.selectedAnnoId === id) deselect();
    closePopup();
    persist();
    renderLayer();
  }
  function clearPage() {
    const before = state.annotations.length;
    state.annotations = state.annotations.filter((a) => a.page !== state.page);
    if (state.annotations.length !== before) { deselect(); persist(); renderLayer(); }
  }
  function persist() {
    if (state.docId) App.Storage.saveAnnotations(state.docId, state.annotations);
    bus.emit("annotations:changed", {});
  }

  /* ---------------------------- Key handling ----------------------------- */
  function onKeyDown(e) {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (!state.selectedAnnoId) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    remove(state.selectedAnnoId);
  }

  /* ------------------------------ Tools API ------------------------------ */
  function setTool(tool) {
    state.tool = tool;
    deselect();
    closePopup();
    const drawMode = tool !== "select";
    canvas.classList.toggle("drawing", drawMode);
    bus.emit("tool:changed", { tool });
  }
  function setColor(color) { state.color = color; bus.emit("color:changed", { color }); }

  // Turn an existing highlight-type annotation into a research note request.
  function annotationToNote(id) {
    const a = state.annotations.find((x) => x.id === id);
    if (!a) return;
    bus.emit("note:fromSelection", { text: a.quote || "", page: a.page });
  }

  App.Annotations = {
    init, setTool, setColor, clearPage,
    remove, select, deselect, annotationToNote,
    redraw: renderLayer,
  };
})();
