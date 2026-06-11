/* =============================================================================
   converter.js — Engineering unit converter (fully offline).

   Ten categories: pressure, temperature, energy, power, flow rate, mass,
   volume, concentration (gas), length, area.

   • Factor-table conversion through a base unit; temperature handled through
     Kelvin; gas concentration (ppm ↔ mg/m³ ↔ %vol) handled with molar mass at
     the NIOSH convention of 25 °C / 101.325 kPa (molar volume 24.45 L/mol).
   • Shows the converted value plus an "all units" grid for the category.
   • Pure conversion functions are exposed for reuse/tests:
       App.Converter.convert(cat, value, from, to)
       App.Converter.ppmToMg / mgToPpm / pctToPpm / ppmToPct

   Exposed as window.App.Converter.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;

  const DEFS = {
    pressure: { label: "Pressure", units: {
      "Pa": 1, "kPa": 1e3, "MPa": 1e6, "bar": 1e5, "mbar": 100, "atm": 101325,
      "psi": 6894.757, "mmHg (torr)": 133.322, "kgf/cm²": 98066.5 } },
    temperature: { label: "Temperature", special: "temp", units: ["°C", "°F", "K", "°R"] },
    energy: { label: "Energy", units: {
      "J": 1, "kJ": 1e3, "MJ": 1e6, "Wh": 3600, "kWh": 3.6e6, "cal": 4.184,
      "kcal": 4184, "BTU": 1055.06, "ft·lbf": 1.35582 } },
    power: { label: "Power", units: {
      "W": 1, "kW": 1e3, "MW": 1e6, "hp": 745.699872, "BTU/h": 0.293071, "ton refrigeration": 3516.85 } },
    flow: { label: "Flow rate", units: {
      "m³/s": 1, "m³/h": 1 / 3600, "L/s": 1e-3, "L/min": 1 / 60000, "L/h": 1 / 3.6e6,
      "ft³/min (CFM)": 4.719474e-4, "US gal/min (GPM)": 6.30902e-5 } },
    mass: { label: "Mass", units: {
      "kg": 1, "g": 1e-3, "mg": 1e-6, "tonne": 1000, "lb": 0.45359237, "oz": 0.0283495231, "US ton": 907.18474 } },
    volume: { label: "Volume", units: {
      "m³": 1, "L": 1e-3, "mL": 1e-6, "ft³": 0.0283168466, "in³": 1.6387064e-5,
      "US gal": 0.003785411784, "UK gal": 0.00454609, "oil barrel": 0.158987295 } },
    concentration: { label: "Concentration (gas)", special: "conc" },
    length: { label: "Length", units: {
      "m": 1, "mm": 1e-3, "cm": 1e-2, "km": 1e3, "in": 0.0254, "ft": 0.3048, "yd": 0.9144, "mile": 1609.344 } },
    area: { label: "Area", units: {
      "m²": 1, "mm²": 1e-6, "cm²": 1e-4, "km²": 1e6, "in²": 6.4516e-4,
      "ft²": 0.09290304, "acre": 4046.8564224, "hectare": 1e4 } },
  };
  const ORDER = ["pressure", "temperature", "energy", "power", "flow", "mass", "volume", "concentration", "length", "area"];

  const MOLAR_VOL = 24.45; // L/mol at 25 °C, 101.325 kPa (NIOSH convention)
  const GASES = [
    ["Ammonia (NH₃)", 17.031], ["Hydrogen (H₂)", 2.016], ["Carbon dioxide (CO₂)", 44.01],
    ["Oxygen (O₂)", 31.998], ["Nitrogen (N₂)", 28.014], ["Methane (CH₄)", 16.043],
    ["Carbon monoxide (CO)", 28.010], ["Hydrogen sulfide (H₂S)", 34.08],
    ["Chlorine (Cl₂)", 70.90], ["Sulfur dioxide (SO₂)", 64.066], ["Custom…", null],
  ];

  /* ------------------------- Pure conversions ----------------------------- */
  function toK(v, u) {
    if (u === "°C") return v + 273.15;
    if (u === "°F") return (v + 459.67) * 5 / 9;
    if (u === "°R") return v * 5 / 9;
    return v; // K
  }
  function fromK(k, u) {
    if (u === "°C") return k - 273.15;
    if (u === "°F") return k * 9 / 5 - 459.67;
    if (u === "°R") return k * 1.8;
    return k;
  }
  function convert(cat, v, from, to) {
    const def = DEFS[cat];
    if (!def) return NaN;
    if (def.special === "temp") return fromK(toK(v, from), to);
    const u = def.units;
    if (!(from in u) || !(to in u)) return NaN;
    return v * u[from] / u[to];
  }
  function ppmToMg(ppm, molar) { return ppm * molar / MOLAR_VOL; }
  function mgToPpm(mg, molar)  { return mg * MOLAR_VOL / molar; }
  function pctToPpm(pct)       { return pct * 1e4; }
  function ppmToPct(ppm)       { return ppm / 1e4; }

  /* ------------------------------- UI ------------------------------------- */
  let catEl, valEl, fromEl, toEl, resEl, gridEl, mainEl, concEl;
  let cDirEl, cGasEl, cMolarEl, cValEl, cResEl;

  function init() {
    catEl = el("conv-cat"); valEl = el("conv-value"); fromEl = el("conv-from");
    toEl = el("conv-to"); resEl = el("conv-result"); gridEl = el("conv-grid");
    mainEl = el("conv-main"); concEl = el("conv-conc");
    cDirEl = el("conc-dir"); cGasEl = el("conc-gas"); cMolarEl = el("conc-molar");
    cValEl = el("conc-value"); cResEl = el("conc-result");
    if (!catEl) return;

    catEl.innerHTML = ORDER.map((k) => '<option value="' + k + '">' + DEFS[k].label + "</option>").join("");
    catEl.addEventListener("input", onCategory);
    [valEl, fromEl, toEl].forEach((e) => e && e.addEventListener("input", calc));
    const swap = el("conv-swap");
    if (swap) swap.addEventListener("click", () => {
      const f = fromEl.value; fromEl.value = toEl.value; toEl.value = f; calc();
    });

    if (cDirEl) {
      cDirEl.innerHTML = ["ppm → mg/m³", "mg/m³ → ppm", "%vol → ppm", "ppm → %vol"]
        .map((d, i) => '<option value="' + i + '">' + d + "</option>").join("");
      cDirEl.addEventListener("input", calcConc);
    }
    if (cGasEl) {
      cGasEl.innerHTML = GASES.map((g, i) => '<option value="' + i + '">' + g[0] + (g[1] ? " — " + g[1] + " g/mol" : "") + "</option>").join("");
      cGasEl.addEventListener("input", () => {
        const g = GASES[parseInt(cGasEl.value, 10)];
        if (g && g[1] != null && cMolarEl) cMolarEl.value = g[1];
        calcConc();
      });
    }
    [cMolarEl, cValEl].forEach((e) => e && e.addEventListener("input", calcConc));
    if (cMolarEl) cMolarEl.value = GASES[0][1];

    onCategory();
  }

  function onCategory() {
    const cat = catEl.value || ORDER[0];
    const def = DEFS[cat];
    const isConc = def.special === "conc";
    if (mainEl) mainEl.style.display = isConc ? "none" : "";
    if (concEl) concEl.style.display = isConc ? "" : "none";
    if (isConc) { calcConc(); return; }

    const names = def.special === "temp" ? def.units : Object.keys(def.units);
    fromEl.innerHTML = names.map((n) => "<option>" + n + "</option>").join("");
    toEl.innerHTML = fromEl.innerHTML;
    fromEl.value = names[0];
    toEl.value = names[1] || names[0];
    if (valEl && !valEl.value) valEl.value = "1";
    calc();
  }

  function calc() {
    if (!resEl) return;
    const cat = catEl.value;
    const def = DEFS[cat];
    if (!def || def.special === "conc") return;
    const v = parseFloat(valEl.value);
    if (!isFinite(v)) { resEl.textContent = "Enter a value to convert"; if (gridEl) gridEl.innerHTML = ""; return; }
    const out = convert(cat, v, fromEl.value, toEl.value);
    resEl.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = fmt(v) + " " + fromEl.value;
    resEl.appendChild(strong);
    resEl.appendChild(document.createTextNode("  =  "));
    const strong2 = document.createElement("strong");
    strong2.className = "conv-out";
    strong2.textContent = fmt(out) + " " + toEl.value;
    resEl.appendChild(strong2);

    if (gridEl) {
      gridEl.innerHTML = "";
      const names = def.special === "temp" ? def.units : Object.keys(def.units);
      names.forEach((n) => {
        if (n === fromEl.value) return;
        const cell = document.createElement("div");
        cell.className = "conv-cell";
        cell.innerHTML = '<span class="conv-cell-val mono"></span><span class="conv-cell-unit"></span>';
        cell.querySelector(".conv-cell-val").textContent = fmt(convert(cat, v, fromEl.value, n));
        cell.querySelector(".conv-cell-unit").textContent = n;
        gridEl.appendChild(cell);
      });
    }
  }

  function calcConc() {
    if (!cResEl) return;
    const dir = parseInt(cDirEl.value, 10) || 0;
    const v = parseFloat(cValEl.value);
    const M = parseFloat(cMolarEl.value);
    const needsM = dir === 0 || dir === 1;
    if (cMolarEl) cMolarEl.disabled = !needsM;
    if (cGasEl) cGasEl.disabled = !needsM;
    if (!isFinite(v) || (needsM && (!isFinite(M) || M <= 0))) {
      cResEl.textContent = "Enter a value" + (needsM ? " and a molar mass" : "") + " to convert";
      return;
    }
    let out, fromU, toU;
    if (dir === 0) { out = ppmToMg(v, M); fromU = "ppm"; toU = "mg/m³"; }
    else if (dir === 1) { out = mgToPpm(v, M); fromU = "mg/m³"; toU = "ppm"; }
    else if (dir === 2) { out = pctToPpm(v); fromU = "%vol"; toU = "ppm"; }
    else { out = ppmToPct(v); fromU = "ppm"; toU = "%vol"; }
    cResEl.innerHTML = "";
    const s1 = document.createElement("strong"); s1.textContent = fmt(v) + " " + fromU;
    const s2 = document.createElement("strong"); s2.className = "conv-out"; s2.textContent = fmt(out) + " " + toU;
    cResEl.appendChild(s1);
    cResEl.appendChild(document.createTextNode("  =  "));
    cResEl.appendChild(s2);
    if (needsM) {
      const note = document.createElement("span");
      note.className = "conv-note-inline";
      note.textContent = "at 25 °C, 101.325 kPa (Vm = 24.45 L/mol)";
      cResEl.appendChild(note);
    }
  }

  function fmt(n) {
    if (!isFinite(n)) return "—";
    if (n === 0) return "0";
    const a = Math.abs(n);
    if (a >= 1e9 || a < 1e-6) return n.toExponential(5).replace(/(\.\d*?)0+e/, "$1e").replace(/\.e/, "e");
    let s = n.toPrecision(8);
    if (s.indexOf("e") === -1 && s.indexOf(".") !== -1) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }
  function el(id) { return document.getElementById(id); }

  App.Converter = {
    init, convert, toK, fromK, ppmToMg, mgToPpm, pctToPpm, ppmToPct,
    MOLAR_VOL, DEFS, GASES,
  };
})();
