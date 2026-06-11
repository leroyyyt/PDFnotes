/* =============================================================================
   safety.js — Safety Limit Reference table.

   A local, fully editable reference table of exposure / flammability limits:
     { id, substance, limitType, value, unit, source, notes, createdAt, updatedAt }

   • Add / edit / delete rows, search, filter by limit type.
   • One-click seeding with widely published example values (OSHA / NIOSH /
     EPA AEGL / common literature) — every row carries its source, and the
     panel reminds the user to verify against the authoritative source.
   • Export CSV / JSON (also reused by the Export Centre).

   Emits : safety:changed
   Exposed as window.App.Safety.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { bus, util } = App;

  const LIMIT_TYPES = [
    "PEL (TWA)", "REL (TWA)", "STEL", "Ceiling", "IDLH",
    "AEGL-1 (60 min)", "AEGL-2 (60 min)", "AEGL-3 (60 min)",
    "LEL", "UEL", "Auto-ignition temperature",
    "Deficiency limit", "Enrichment limit", "Asphyxiant", "Other",
  ];

  // substance, limitType, value, unit, source, notes
  const SEED = [
    ["Ammonia (NH₃)", "PEL (TWA)", "50", "ppm", "OSHA 29 CFR 1910.1000", "8-h time-weighted average"],
    ["Ammonia (NH₃)", "REL (TWA)", "25", "ppm", "NIOSH", "10-h TWA"],
    ["Ammonia (NH₃)", "STEL", "35", "ppm", "NIOSH", "15-min short-term limit"],
    ["Ammonia (NH₃)", "IDLH", "300", "ppm", "NIOSH", "Immediately dangerous to life or health"],
    ["Ammonia (NH₃)", "AEGL-2 (60 min)", "160", "ppm", "US EPA AEGL", "Irreversible / serious-effect threshold"],
    ["Ammonia (NH₃)", "AEGL-3 (60 min)", "1100", "ppm", "US EPA AEGL", "Life-threatening threshold"],
    ["Ammonia (NH₃)", "LEL", "15", "%vol", "Common literature value", "Flammable range ≈ 15–28 %vol"],
    ["Ammonia (NH₃)", "Auto-ignition temperature", "651", "°C", "Common literature value", ""],
    ["Hydrogen (H₂)", "LEL", "4", "%vol", "Common literature value", "Flammable range ≈ 4–75 %vol"],
    ["Hydrogen (H₂)", "UEL", "75", "%vol", "Common literature value", ""],
    ["Hydrogen (H₂)", "Auto-ignition temperature", "585", "°C", "Common literature value", "Sources vary ≈ 500–585 °C"],
    ["Carbon dioxide (CO₂)", "PEL (TWA)", "5000", "ppm", "OSHA 29 CFR 1910.1000", "8-h TWA"],
    ["Carbon dioxide (CO₂)", "STEL", "30000", "ppm", "NIOSH", "15-min"],
    ["Carbon dioxide (CO₂)", "IDLH", "40000", "ppm", "NIOSH", "= 4 %vol"],
    ["Oxygen (O₂)", "Deficiency limit", "19.5", "%vol", "OSHA", "Minimum for entry without supplied air"],
    ["Oxygen (O₂)", "Enrichment limit", "23.5", "%vol", "Common practice", "Increased fire risk above this"],
    ["Nitrogen (N₂)", "Asphyxiant", "—", "—", "—", "Simple asphyxiant; control by O₂ monitoring"],
  ];

  let cache = [];
  let bodyEl, searchEl, typeEl, countEl;

  function init() {
    bodyEl = document.getElementById("saf-body");
    searchEl = document.getElementById("saf-search");
    typeEl = document.getElementById("saf-type");
    countEl = document.getElementById("saf-count");

    if (typeEl) typeEl.innerHTML = '<option value="">All limit types</option>' +
      LIMIT_TYPES.map((t) => "<option>" + t + "</option>").join("");

    on("saf-add", () => openEditor(blank(), null));
    on("saf-seed", seedExamples);
    on("saf-export-csv", exportCsv);
    on("saf-export-json", exportJson);
    [searchEl, typeEl].forEach((el) => el && el.addEventListener("input", render));
    load();
  }

  function blank() {
    return { id: null, substance: "", limitType: LIMIT_TYPES[0], value: "", unit: "ppm", source: "", notes: "", createdAt: null, updatedAt: null };
  }

  async function load() { cache = await App.Storage.getAllSafety(); render(); }

  async function save(rec) {
    const now = Date.now();
    if (!rec.id) { rec.id = util.uid("saf"); rec.createdAt = now; }
    rec.updatedAt = now;
    await App.Storage.saveSafety(rec);
    const i = cache.findIndex((r) => r.id === rec.id);
    if (i === -1) cache.push(rec); else cache[i] = rec;
    render();
    bus.emit("safety:changed", {});
  }

  async function remove(id) {
    const ok = await App.confirmDialog({ title: "Delete entry?", message: "This safety-limit row will be permanently removed.", okText: "Delete", danger: true });
    if (!ok) return;
    await App.Storage.deleteSafety(id);
    cache = cache.filter((r) => r.id !== id);
    render();
    bus.emit("safety:changed", {});
  }

  async function seedExamples() {
    const have = new Set(cache.map((r) => (r.substance + "|" + r.limitType).toLowerCase()));
    const toAdd = SEED.filter((s) => !have.has((s[0] + "|" + s[1]).toLowerCase()));
    if (!toAdd.length) { App.toast("All example rows are already in the table", "info"); return; }
    const now = Date.now();
    for (const s of toAdd) {
      const rec = { id: util.uid("saf"), substance: s[0], limitType: s[1], value: s[2], unit: s[3], source: s[4], notes: s[5], createdAt: now, updatedAt: now };
      await App.Storage.saveSafety(rec);
      cache.push(rec);
    }
    render();
    bus.emit("safety:changed", {});
    App.toast(toAdd.length + " example rows added — verify values before relying on them", "ok");
  }

  /* ------------------------------ Render --------------------------------- */
  function visibleRows() {
    const q = (searchEl ? searchEl.value : "").trim().toLowerCase();
    const type = typeEl ? typeEl.value : "";
    let rows = cache.slice().sort((a, b) =>
      (a.substance || "").localeCompare(b.substance || "") || (a.limitType || "").localeCompare(b.limitType || ""));
    if (type) rows = rows.filter((r) => r.limitType === type);
    if (q) rows = rows.filter((r) =>
      [r.substance, r.limitType, r.value, r.unit, r.source, r.notes].join(" ").toLowerCase().indexOf(q) !== -1);
    return rows;
  }

  function render() {
    if (!bodyEl) return;
    const rows = visibleRows();
    if (countEl) countEl.textContent = rows.length + (rows.length === 1 ? " entry" : " entries");
    bodyEl.innerHTML = "";
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="7"><div class="empty-state">' + App.Icons.get("shield") +
        "<p>No entries" + (cache.length ? " match the current filter." : " yet. Press “Add example values” to seed common reference limits, or add your own.") + "</p></div></td>";
      bodyEl.appendChild(tr);
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td class='saf-sub'></td><td class='saf-typ'></td><td class='saf-val mono'></td>" +
        "<td class='saf-unit mono'></td><td class='saf-src'></td><td class='saf-notes'></td>" +
        "<td class='saf-ops'></td>";
      tr.querySelector(".saf-sub").textContent = r.substance;
      tr.querySelector(".saf-typ").textContent = r.limitType;
      tr.querySelector(".saf-val").textContent = r.value;
      tr.querySelector(".saf-unit").textContent = r.unit;
      tr.querySelector(".saf-src").textContent = r.source;
      tr.querySelector(".saf-notes").textContent = r.notes;
      const ops = tr.querySelector(".saf-ops");
      ops.appendChild(iconBtn("edit", "Edit entry", () => openEditor(Object.assign({}, r), r.id)));
      ops.appendChild(iconBtn("trash", "Delete entry", () => remove(r.id), "del"));
      bodyEl.appendChild(tr);
    });
  }

  /* ------------------------------ Editor --------------------------------- */
  function openEditor(rec, id) {
    const types = LIMIT_TYPES.slice();
    if (rec.limitType && types.indexOf(rec.limitType) === -1) types.unshift(rec.limitType);

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML =
      '<div class="modal modal-form" role="dialog" aria-modal="true"><h3>' + (id ? "Edit safety limit" : "Add safety limit") + "</h3>" +
      '<div class="form-grid">' +
        '<label class="fld span2"><span>Substance</span><input data-f="substance" type="text" placeholder="e.g. Ammonia (NH₃)"></label>' +
        '<label class="fld"><span>Limit type</span><select data-f="limitType">' + types.map((t) => "<option>" + t + "</option>").join("") + "</select></label>" +
        '<label class="fld"><span>Value</span><input data-f="value" type="text" placeholder="e.g. 50 or 15–28"></label>' +
        '<label class="fld"><span>Unit</span><input data-f="unit" type="text" placeholder="ppm, %vol, °C, mg/m³…"></label>' +
        '<label class="fld"><span>Source</span><input data-f="source" type="text" placeholder="e.g. NIOSH, OSHA, EPA AEGL"></label>' +
        '<label class="fld span2"><span>Notes</span><input data-f="notes" type="text" placeholder="Averaging time, conditions, caveats…"></label>' +
      "</div>" +
      '<div class="row"><button class="btn has-label" data-act="cancel">Cancel</button>' +
      '<button class="btn has-label primary" data-act="save">Save entry</button></div></div>';

    const q = (s) => backdrop.querySelector(s);
    q('[data-f="substance"]').value = rec.substance || "";
    q('[data-f="limitType"]').value = rec.limitType || LIMIT_TYPES[0];
    q('[data-f="value"]').value = rec.value || "";
    q('[data-f="unit"]').value = rec.unit || "";
    q('[data-f="source"]').value = rec.source || "";
    q('[data-f="notes"]').value = rec.notes || "";

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    setTimeout(() => q('[data-f="substance"]').focus(), 30);
    const close = () => { backdrop.classList.remove("show"); setTimeout(() => backdrop.remove(), 160); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) close(); });
    q('[data-act="cancel"]').addEventListener("click", close);
    q('[data-act="save"]').addEventListener("click", () => {
      rec.substance = q('[data-f="substance"]').value.trim();
      if (!rec.substance) { App.toast("Give the entry a substance name", "warn"); return; }
      rec.limitType = q('[data-f="limitType"]').value;
      rec.value = q('[data-f="value"]').value.trim();
      rec.unit = q('[data-f="unit"]').value.trim();
      rec.source = q('[data-f="source"]').value.trim();
      rec.notes = q('[data-f="notes"]').value.trim();
      close(); save(rec);
    });
  }

  /* ------------------------------ Export --------------------------------- */
  function exportCsv() {
    const rows = visibleAll();
    if (!rows.length) return App.toast("No safety entries to export", "warn");
    const cols = ["substance", "limitType", "value", "unit", "source", "notes"];
    const head = cols.join(",");
    const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
    util.downloadFile("safety-limits-" + stamp() + ".csv", head + "\n" + body, "text/csv");
  }
  function exportJson() {
    const rows = visibleAll();
    if (!rows.length) return App.toast("No safety entries to export", "warn");
    util.downloadFile("safety-limits-" + stamp() + ".json", JSON.stringify(rows, null, 2), "application/json");
  }
  function visibleAll() {
    return cache.slice().sort((a, b) =>
      (a.substance || "").localeCompare(b.substance || "") || (a.limitType || "").localeCompare(b.limitType || ""));
  }

  /* ------------------------------ Helpers -------------------------------- */
  function iconBtn(icon, title, fn, extra) {
    const b = document.createElement("button");
    b.className = "ghost-icon " + (extra || ""); b.title = title; b.setAttribute("aria-label", title);
    b.innerHTML = App.Icons.get(icon);
    b.addEventListener("click", fn);
    return b;
  }
  function on(id, fn) { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); }
  function csvCell(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  App.Safety = { init, getAll: () => cache, reload: load, seedExamples, exportCsv, exportJson, LIMIT_TYPES };
})();
