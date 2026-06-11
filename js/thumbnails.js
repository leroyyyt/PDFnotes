/* =============================================================================
   thumbnails.js — Page thumbnail strip in the left sidebar ("Pages" tab).

   Renders every page at a small scale (sequentially, cancellable), highlights
   the current page, lets the user jump to a page on click, and shows a small
   badge on pages that carry annotations or notes.

   Listens : doc:loaded, doc:closed, page:changed, annotations:changed, notes:changed
   Exposed as window.App.Thumbs.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus } = App;

  const THUMB_W = 150;     // target CSS width of a thumbnail
  let listEl = null;
  let buildToken = 0;      // cancels an in-flight build when the doc changes
  let noteCounts = {};     // pageNum -> note count

  function init() {
    listEl = document.getElementById("thumbs-list");
    bus.on("doc:loaded", build);
    bus.on("doc:closed", clear);
    bus.on("page:changed", highlight);
    bus.on("annotations:changed", refreshBadges);
    bus.on("notes:changed", onNotesChanged);
  }

  function clear() {
    buildToken++;
    if (listEl) listEl.innerHTML = "";
  }

  async function build() {
    if (!state.pdfDoc || !listEl) return;
    const token = ++buildToken;
    listEl.innerHTML = "";

    const dpr = window.devicePixelRatio || 1;
    for (let n = 1; n <= state.totalPages; n++) {
      if (token !== buildToken) return;   // a newer document started loading

      const slot = document.createElement("div");
      slot.className = "thumb" + (n === state.page ? " current" : "");
      slot.dataset.page = n;
      slot.title = "Page " + n;

      const canvas = document.createElement("canvas");
      const num = document.createElement("span");
      num.className = "thumb-num"; num.textContent = n;
      slot.appendChild(canvas);
      slot.appendChild(num);
      slot.addEventListener("click", () => App.Viewer.goToPage(n));
      listEl.appendChild(slot);

      try {
        const page = await state.pdfDoc.getPage(n);
        if (token !== buildToken) return;
        const base = page.getViewport({ scale: 1, rotation: state.rotation });
        const scale = THUMB_W / base.width;
        const vp = page.getViewport({ scale, rotation: state.rotation });

        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = Math.floor(vp.width) + "px";
        canvas.style.height = Math.floor(vp.height) + "px";

        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
          canvasContext: ctx, viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        }).promise;
      } catch (e) {
        // Leave a blank slot if a page fails to rasterise.
      }
      // Yield so the UI stays responsive on large documents.
      if (n % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    refreshBadges();
  }

  function highlight() {
    if (!listEl) return;
    listEl.querySelectorAll(".thumb.current").forEach((el) => el.classList.remove("current"));
    const cur = listEl.querySelector('.thumb[data-page="' + state.page + '"]');
    if (cur) { cur.classList.add("current"); cur.scrollIntoView({ block: "nearest" }); }
  }

  function onNotesChanged(payload) {
    if (payload && payload.counts) noteCounts = payload.counts;
    refreshBadges();
  }

  // Count annotations per page (+ notes via noteCounts) and stamp a badge.
  function refreshBadges() {
    if (!listEl) return;
    const annoCounts = {};
    state.annotations.forEach((a) => { annoCounts[a.page] = (annoCounts[a.page] || 0) + 1; });

    listEl.querySelectorAll(".thumb").forEach((slot) => {
      const n = +slot.dataset.page;
      const total = (annoCounts[n] || 0) + (noteCounts[n] || 0);
      let badge = slot.querySelector(".thumb-badge");
      if (total > 0) {
        if (!badge) { badge = document.createElement("span"); badge.className = "thumb-badge"; slot.appendChild(badge); }
        badge.textContent = total;
      } else if (badge) {
        badge.remove();
      }
    });
  }

  App.Thumbs = { init };
})();
