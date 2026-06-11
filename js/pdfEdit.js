/* =============================================================================
   pdfEdit.js — Real PDF output via pdf-lib (bundled offline under vendor/).

   Two jobs, both producing a brand-new PDF file the browser downloads:

     1. bakeAnnotations(srcBytes, annotations)  → Uint8Array
        Burns the workspace's vector + text annotations (highlight, underline,
        strikethrough, rectangle, circle, arrow, freehand, sticky, free text)
        permanently into the page content, so the exported PDF shows them in any
        viewer. Annotations are stored in PDF user space (origin bottom-left),
        which is exactly pdf-lib's drawing space, so coordinates map directly.

     2. Page management on a pdf-lib document:
          reorderPages / deletePages / rotatePages / mergeDocuments
        then save() to a new PDF.

   pdf-lib is a pure-JS, dependency-free library (no network, no workers); it is
   loaded as a classic <script> exposing window.PDFLib. This module wraps it so
   the rest of the app never touches pdf-lib directly.

   Exposed as window.App.PdfEdit.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;

  function lib() {
    const L = window.PDFLib;
    if (!L) throw new Error("PDF engine (pdf-lib) not loaded");
    return L;
  }

  /* --------------------------------------------------------------------------
     Loading helpers
     ------------------------------------------------------------------------ */
  async function load(bytes) {
    const { PDFDocument } = lib();
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // ignoreEncryption lets us still open (most) protected PDFs for export.
    return PDFDocument.load(data, { ignoreEncryption: true });
  }

  function colorOf(hex) {
    const { rgb } = lib();
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "#ffb020");
    if (!m) return rgb(1, 0.69, 0.13);
    return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
  }

  /* --------------------------------------------------------------------------
     1. Bake annotations into a new PDF
     ------------------------------------------------------------------------ */
  async function bakeAnnotations(srcBytes, annotations) {
    const { degrees, StandardFonts } = lib();
    const doc = await load(srcBytes);
    const pages = doc.getPages();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    // Group annotations by 1-based page number.
    const byPage = new Map();
    (annotations || []).forEach((a) => {
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(a);
    });

    byPage.forEach((list, pageNum) => {
      const page = pages[pageNum - 1];
      if (!page) return;
      const ph = page.getHeight();
      const rot = (page.getRotation && page.getRotation().angle) || 0;

      // Annotations are stored in unrotated PDF user space with a top-left
      // viewport convention already converted to PDF points by PDF.js. pdf-lib
      // uses bottom-left origin, which matches convertToPdfPoint output, so the
      // y values are already correct. We draw on the unrotated page; if the page
      // has a /Rotate we temporarily clear it so our coordinates line up, then
      // restore it (the visual result is identical because the burned content
      // rotates with the page).
      if (rot) page.setRotation(degrees(0));

      list.forEach((a) => drawAnno(page, a, font, ph));

      if (rot) page.setRotation(degrees(rot));
    });

    return doc.save();   // Uint8Array
  }

  function drawAnno(page, a, font, ph) {
    const col = colorOf(a.color);
    if (a.type === "highlight" && a.a && a.b) {
      const x = Math.min(a.a[0], a.b[0]);
      const y = Math.min(a.a[1], a.b[1]);
      const w = Math.abs(a.a[0] - a.b[0]);
      const h = Math.abs(a.a[1] - a.b[1]);
      page.drawRectangle({ x, y, width: w, height: h, color: col, opacity: 0.32 });
    } else if (a.type === "rectangle" && a.a && a.b) {
      const x = Math.min(a.a[0], a.b[0]);
      const y = Math.min(a.a[1], a.b[1]);
      page.drawRectangle({ x, y, width: Math.abs(a.a[0] - a.b[0]), height: Math.abs(a.a[1] - a.b[1]), borderColor: col, borderWidth: 1.5 });
    } else if (a.type === "circle" && a.a && a.b) {
      const cx = (a.a[0] + a.b[0]) / 2;
      const cy = (a.a[1] + a.b[1]) / 2;
      page.drawEllipse({ x: cx, y: cy, xScale: Math.max(Math.abs(a.a[0] - a.b[0]) / 2, 1), yScale: Math.max(Math.abs(a.a[1] - a.b[1]) / 2, 1), borderColor: col, borderWidth: 1.5 });
    } else if ((a.type === "underline" || a.type === "strikethrough") && a.a && a.b) {
      // a/b are two corners of the dragged box; draw a horizontal rule.
      const y = a.type === "underline" ? Math.min(a.a[1], a.b[1]) : (a.a[1] + a.b[1]) / 2;
      page.drawLine({ start: { x: Math.min(a.a[0], a.b[0]), y }, end: { x: Math.max(a.a[0], a.b[0]), y }, color: col, thickness: 1.5 });
    } else if (a.type === "arrow" && a.a && a.b) {
      drawArrow(page, a.a, a.b, col);
    } else if (a.type === "freehand" && a.points && a.points.length > 1) {
      for (let i = 1; i < a.points.length; i++) {
        page.drawLine({ start: { x: a.points[i - 1][0], y: a.points[i - 1][1] }, end: { x: a.points[i][0], y: a.points[i][1] }, color: col, thickness: 1.6 });
      }
    } else if (a.type === "freetext" && a.at) {
      const size = 12;
      page.drawText(String(a.text || ""), { x: a.at[0], y: a.at[1] - size, size, font, color: col, lineHeight: size * 1.2 });
    } else if (a.type === "sticky" && a.at) {
      // A small filled note glyph + the note text beside it.
      const s = 14;
      page.drawRectangle({ x: a.at[0], y: a.at[1] - s, width: s, height: s, color: col, opacity: 0.9 });
      if (a.text) {
        page.drawText(String(a.text), { x: a.at[0] + s + 4, y: a.at[1] - s + 3, size: 9, font, color: colorOf("#1a1f29"), maxWidth: 220, lineHeight: 11 });
      }
    }
  }

  function drawArrow(page, a, b, col) {
    page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, color: col, thickness: 1.6 });
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const head = 9;
    const left = { x: b[0] - head * Math.cos(ang - Math.PI / 7), y: b[1] - head * Math.sin(ang - Math.PI / 7) };
    const right = { x: b[0] - head * Math.cos(ang + Math.PI / 7), y: b[1] - head * Math.sin(ang + Math.PI / 7) };
    page.drawLine({ start: { x: b[0], y: b[1] }, end: left, color: col, thickness: 1.6 });
    page.drawLine({ start: { x: b[0], y: b[1] }, end: right, color: col, thickness: 1.6 });
  }

  /* --------------------------------------------------------------------------
     2. Page management — operate on a fresh pdf-lib doc, return new bytes
     ------------------------------------------------------------------------ */

  // order: array of 0-based source indices, in the desired output order.
  async function buildFromOrder(srcBytes, order, rotations) {
    const { PDFDocument, degrees } = lib();
    const src = await load(srcBytes);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, order);
    copied.forEach((p, i) => {
      out.addPage(p);
      const extra = rotations && rotations[i];
      if (extra) {
        const base = (p.getRotation && p.getRotation().angle) || 0;
        p.setRotation(degrees(((base + extra) % 360 + 360) % 360));
      }
    });
    return out.save();
  }

  // Merge several { bytes } documents (optionally a subset/ordering of pages)
  // into one. items: [{ bytes, pages? (0-based indices, default all) }]
  async function mergeDocuments(items) {
    const { PDFDocument } = lib();
    const out = await PDFDocument.create();
    for (const item of items) {
      const src = await load(item.bytes);
      const count = src.getPageCount();
      const idx = item.pages && item.pages.length ? item.pages : range(count);
      const valid = idx.filter((i) => i >= 0 && i < count);
      const copied = await out.copyPages(src, valid);
      copied.forEach((p) => out.addPage(p));
    }
    return out.save();
  }

  function range(n) { const a = []; for (let i = 0; i < n; i++) a.push(i); return a; }

  // Quick metadata read (page count + per-page size) without rendering.
  async function inspect(bytes) {
    const doc = await load(bytes);
    return {
      pageCount: doc.getPageCount(),
      pages: doc.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight(), rotation: (p.getRotation && p.getRotation().angle) || 0 })),
    };
  }

  App.PdfEdit = {
    available: () => !!window.PDFLib,
    load, inspect,
    bakeAnnotations,
    buildFromOrder, mergeDocuments,
  };
})();
