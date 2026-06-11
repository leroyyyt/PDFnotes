/* =============================================================================
   diff.js — Pure text-diff engine (Myers O(ND)) used by the PDF comparison.

   App.Diff.diffSeq(a, b, cap?)
     a, b : arrays of strings (lines or word tokens)
     →     { ops: [{t:'='|'-'|'+', ai?, bi?}], capped: bool }
     Common prefix/suffix are trimmed first; the middle is solved with Myers'
     greedy O(ND) algorithm using compact per-layer Int32Arrays. If the edit
     distance exceeds `cap` (default 3000) the middle falls back to a coarse
     "everything removed, everything added" block and `capped` is set — this
     keeps very dissimilar documents from freezing the page.

   App.Diff.buildBlocks(ops, linesA, linesB)
     Groups ops into renderable blocks:
       {type:'same',   rows:[{a:lineA, b:lineB}]}
       {type:'del',    rows:[lineA…]}
       {type:'ins',    rows:[lineB…]}
       {type:'change', pairs:[{a, b, aHtml, bHtml}], dels:[…], inss:[…]}
     Contiguous non-equal regions are paired sequentially; each pair gets a
     word-level diff with <span class="w-del">/<span class="w-ins"> marks.

   App.Diff.wordDiff(aText, bText) → {aHtml, bHtml}   (HTML-escaped)

   No DOM access — safe to unit-test in plain Node with a window shim.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;

  const DEFAULT_CAP = 3000;
  const WORD_CAP = 600;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ----------------------- Myers core (trimmed mid) ----------------------- */
  // Operates on a[s..ea) vs b[s..eb). Returns ops with absolute indices, or
  // null if the edit distance exceeds `cap`.
  function myers(a, b, s, ea, eb, cap) {
    const N = ea - s, M = eb - s;
    if (!N && !M) return [];
    if (!N) { const o = []; for (let i = 0; i < M; i++) o.push({ t: "+", bi: s + i }); return o; }
    if (!M) { const o = []; for (let i = 0; i < N; i++) o.push({ t: "-", ai: s + i }); return o; }
    const A = (i) => a[s + i], B = (i) => b[s + i];
    const maxD = Math.min(N + M, cap);

    // layers[d] is an Int32Array of length 2d+1: furthest x for diagonal k,
    // stored at index k+d.
    const layers = [];
    let solved = -1;

    // d = 0: just the initial snake.
    let x0 = 0;
    while (x0 < N && x0 < M && A(x0) === B(x0)) x0++;
    layers.push(Int32Array.of(x0));
    if (x0 >= N && x0 >= M) solved = 0;

    for (let d = 1; solved < 0 && d <= maxD; d++) {
      const lp = layers[d - 1];
      const l = new Int32Array(2 * d + 1);
      for (let k = -d; k <= d; k += 2) {
        const down = k > -d ? lp[(k - 1) + (d - 1)] : -1; // came from k-1 (deletion)
        const up   = k <  d ? lp[(k + 1) + (d - 1)] : -1; // came from k+1 (insertion)
        let x = (k === -d || (k !== d && down < up)) ? up : down + 1;
        let y = x - k;
        while (x < N && y < M && A(x) === B(y)) { x++; y++; }
        l[k + d] = x;
        if (x >= N && y >= M) solved = d;
      }
      layers.push(l);
    }
    if (solved < 0) return null;

    // Backtrack from (N, M) to (0, 0).
    const rev = [];
    let x = N, y = M;
    for (let d = solved; d > 0; d--) {
      const lp = layers[d - 1];
      const k = x - y;
      const down = k > -d ? lp[(k - 1) + (d - 1)] : -1;
      const up   = k <  d ? lp[(k + 1) + (d - 1)] : -1;
      const cameUp = (k === -d || (k !== d && down < up));
      const prevK = cameUp ? k + 1 : k - 1;
      const prevX = lp[prevK + (d - 1)];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { rev.push({ t: "=", ai: s + x - 1, bi: s + y - 1 }); x--; y--; }
      if (cameUp) { rev.push({ t: "+", bi: s + y - 1 }); y--; }
      else        { rev.push({ t: "-", ai: s + x - 1 }); x--; }
    }
    while (x > 0 && y > 0) { rev.push({ t: "=", ai: s + x - 1, bi: s + y - 1 }); x--; y--; }
    return rev.reverse();
  }

  function diffSeq(a, b, cap) {
    cap = cap || DEFAULT_CAP;
    let start = 0;
    const minLen = Math.min(a.length, b.length);
    while (start < minLen && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    const mid = myers(a, b, start, endA, endB, cap);
    const ops = [];
    for (let i = 0; i < start; i++) ops.push({ t: "=", ai: i, bi: i });
    let capped = false;
    if (mid === null) {
      capped = true;
      for (let i = start; i < endA; i++) ops.push({ t: "-", ai: i });
      for (let i = start; i < endB; i++) ops.push({ t: "+", bi: i });
    } else {
      for (let i = 0; i < mid.length; i++) ops.push(mid[i]);
    }
    const tail = a.length - endA;
    for (let i = 0; i < tail; i++) ops.push({ t: "=", ai: endA + i, bi: endB + i });
    return { ops, capped };
  }

  /* --------------------------- Word-level diff ---------------------------- */
  function wordDiff(aText, bText) {
    const ta = String(aText || "").split(/\s+/).filter(Boolean);
    const tb = String(bText || "").split(/\s+/).filter(Boolean);
    if (ta.length + tb.length > WORD_CAP * 2) return { aHtml: esc(aText), bHtml: esc(bText) };
    const res = diffSeq(ta, tb, WORD_CAP);
    if (res.capped) return { aHtml: esc(aText), bHtml: esc(bText) };
    const aParts = [], bParts = [];
    res.ops.forEach((op) => {
      if (op.t === "=") { aParts.push(esc(ta[op.ai])); bParts.push(esc(tb[op.bi])); }
      else if (op.t === "-") aParts.push('<span class="w-del">' + esc(ta[op.ai]) + "</span>");
      else bParts.push('<span class="w-ins">' + esc(tb[op.bi]) + "</span>");
    });
    return { aHtml: aParts.join(" "), bHtml: bParts.join(" ") };
  }

  /* ------------------------------- Blocks --------------------------------- */
  function buildBlocks(ops, linesA, linesB) {
    const blocks = [];
    let i = 0;
    while (i < ops.length) {
      if (ops[i].t === "=") {
        const rows = [];
        while (i < ops.length && ops[i].t === "=") {
          rows.push({ a: linesA[ops[i].ai], b: linesB[ops[i].bi] });
          i++;
        }
        blocks.push({ type: "same", rows });
      } else {
        // A contiguous non-equal region: collect deletions and insertions in
        // order, then pair them sequentially as "changed" lines.
        const dels = [], inss = [];
        while (i < ops.length && ops[i].t !== "=") {
          if (ops[i].t === "-") dels.push(linesA[ops[i].ai]);
          else inss.push(linesB[ops[i].bi]);
          i++;
        }
        if (dels.length && inss.length) {
          const n = Math.min(dels.length, inss.length);
          const pairs = [];
          for (let j = 0; j < n; j++) {
            const wd = wordDiff(dels[j].text, inss[j].text);
            pairs.push({ a: dels[j], b: inss[j], aHtml: wd.aHtml, bHtml: wd.bHtml });
          }
          blocks.push({ type: "change", pairs, dels: dels.slice(n), inss: inss.slice(n) });
        } else if (dels.length) {
          blocks.push({ type: "del", rows: dels });
        } else if (inss.length) {
          blocks.push({ type: "ins", rows: inss });
        }
      }
    }
    return blocks;
  }

  App.Diff = { diffSeq, buildBlocks, wordDiff };
})();
