/* =============================================================================
   search.js — Find text inside the current PDF.

   Builds a match list across every page (per text-item substring scan),
   reports the total count, highlights matches on the rendered page, and
   supports next / previous navigation that jumps to the right page and
   scrolls the active match into view.

   Listens : page:rendered, doc:closed
   Exposed as window.App.Search.

   Limitation: matches that span across two text runs / lines may not be
   highlighted (each PDF text item is scanned independently).
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, bus, util } = App;

  let bar, input, countEl, prevBtn, nextBtn, caseBtn;
  let searchToken = 0;
  // ranges for the currently rendered page: itemIndex -> [{start,len,globalIdx}]
  let pageRanges = {};

  function init() {
    bar = document.getElementById("search-bar");
    input = document.getElementById("search-input");
    countEl = document.getElementById("search-count");
    prevBtn = document.getElementById("search-prev");
    nextBtn = document.getElementById("search-next");
    caseBtn = document.getElementById("search-case");

    const run = util.debounce(() => doSearch(input.value), 220);
    input.addEventListener("input", run);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? prev() : next(); }
      if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    prevBtn.addEventListener("click", prev);
    nextBtn.addEventListener("click", next);
    document.getElementById("search-close").addEventListener("click", close);
    caseBtn.addEventListener("click", () => {
      state.search.caseSensitive = !state.search.caseSensitive;
      caseBtn.classList.toggle("active", state.search.caseSensitive);
      doSearch(input.value);
    });

    bus.on("page:rendered", applyHighlights);
    bus.on("doc:closed", () => { reset(); close(); });
  }

  function reset() {
    state.search.query = ""; state.search.matches = []; state.search.current = -1;
    pageRanges = {};
    if (countEl) countEl.textContent = "";
  }

  async function doSearch(query) {
    query = (query || "").trim();
    state.search.query = query;
    state.search.matches = [];
    state.search.current = -1;
    if (!state.pdfDoc || !query) { updateCount(); applyHighlights(); return; }

    const token = ++searchToken;
    const cs = state.search.caseSensitive;
    const needle = cs ? query : query.toLowerCase();
    const matches = [];

    for (let p = 1; p <= state.totalPages; p++) {
      if (token !== searchToken) return;
      let tc;
      try { tc = await App.Viewer.getPageText(p); } catch (e) { continue; }
      tc.items.forEach((it, idx) => {
        const raw = it.str || "";
        if (!raw) return;
        const hay = cs ? raw : raw.toLowerCase();
        let from = 0, at;
        while ((at = hay.indexOf(needle, from)) !== -1) {
          matches.push({ page: p, itemIndex: idx, start: at, len: needle.length });
          from = at + Math.max(needle.length, 1);
        }
      });
    }
    if (token !== searchToken) return;

    matches.forEach((m, i) => (m.globalIdx = i));
    state.search.matches = matches;
    state.search.current = matches.length ? 0 : -1;
    updateCount();

    if (matches.length) goToMatch(0);
    else applyHighlights();
  }

  function updateCount() {
    const m = state.search.matches;
    if (!countEl) return;
    if (!state.search.query) countEl.textContent = "";
    else countEl.textContent = m.length ? (state.search.current + 1) + " / " + m.length : "No results";
    const none = m.length === 0;
    if (prevBtn) prevBtn.disabled = none;
    if (nextBtn) nextBtn.disabled = none;
  }

  function goToMatch(i) {
    const m = state.search.matches[i];
    if (!m) return;
    state.search.current = i;
    updateCount();
    if (m.page !== state.page) {
      App.Viewer.goToPage(m.page);   // page:rendered -> applyHighlights -> scroll
    } else {
      applyHighlights();
    }
  }
  function next() { const m = state.search.matches; if (m.length) goToMatch((state.search.current + 1) % m.length); }
  function prev() { const m = state.search.matches; if (m.length) goToMatch((state.search.current - 1 + m.length) % m.length); }

  // Rebuild highlight spans for the page that was just rendered.
  function applyHighlights() {
    const divs = App.Viewer.getCurrentTextDivs();
    const items = state.textItems;
    if (!divs || !divs.length) return;

    // Group this page's matches by text-item index.
    pageRanges = {};
    state.search.matches.forEach((m) => {
      if (m.page !== state.page) return;
      (pageRanges[m.itemIndex] || (pageRanges[m.itemIndex] = [])).push(m);
    });

    // Reset any item we previously touched, then decorate matched items.
    divs.forEach((div, idx) => {
      const ranges = pageRanges[idx];
      if (!ranges) {
        if (div.dataset.hl === "1") { div.textContent = (items[idx] && items[idx].str) || div.textContent; div.dataset.hl = "0"; }
        return;
      }
      const text = (items[idx] && items[idx].str) || div.textContent || "";
      ranges.sort((a, b) => a.start - b.start);
      let html = "", cursor = 0;
      ranges.forEach((r) => {
        if (r.start < cursor) return;            // overlapping guard
        html += esc(text.slice(cursor, r.start));
        const isCur = r.globalIdx === state.search.current;
        html += '<span class="hl' + (isCur ? " current" : "") + '" data-gi="' + r.globalIdx + '">' +
                esc(text.slice(r.start, r.start + r.len)) + "</span>";
        cursor = r.start + r.len;
      });
      html += esc(text.slice(cursor));
      div.innerHTML = html;
      div.dataset.hl = "1";
    });

    // Scroll the active match into view.
    const curSpan = document.querySelector('.text-layer .hl.current');
    if (curSpan) curSpan.scrollIntoView({ block: "center", inline: "center" });
  }

  function esc(s) { return App.util.escapeHtml(s); }

  /* ------------------------------ Open / close --------------------------- */
  function open() {
    document.querySelector(".app-shell").classList.remove("search-hidden");
    bar.classList.add("open");
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }
  function close() {
    document.querySelector(".app-shell").classList.add("search-hidden");
    bar.classList.remove("open");
  }
  function toggle() {
    if (document.querySelector(".app-shell").classList.contains("search-hidden")) open();
    else close();
  }

  App.Search = { init, open, close, toggle, run: () => doSearch(input.value) };
})();
