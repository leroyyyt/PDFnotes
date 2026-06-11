/* =============================================================================
   tags.js — Engineering tag system.

   A predefined set of engineering tags plus user-defined custom tags. Tags are
   plain strings used by notes, formulas, figures and literature entries. This
   module provides:

     • App.Tags.all()                     → preset + custom (deduped)
     • App.Tags.addCustom / removeCustom  → persisted in meta 'customTags'
     • App.Tags.attachSuggestions(input)  → clickable chip row under any
                                            comma-separated tags input
     • App.Tags.renderManager(container)  → the Tags panel in the Engineering
                                            Workspace

   Emits : tags:changed
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { bus, util } = App;

  const PRESET = [
    "PV", "Solar", "Bifacial", "Monofacial", "Green Roof", "Performance Ratio",
    "Temperature Correction", "Ammonia", "Hydrogen", "CO2", "CCUS",
    "Process Safety", "Piping", "Pumps", "Storage Tanks", "Risk Assessment",
    "ALARP", "Fluid Mechanics", "Heat Transfer", "Thermodynamics",
  ];

  let custom = [];
  let managerEl = null;

  function init() {
    load();
  }

  async function load() {
    const stored = await App.Storage.getMeta("customTags");
    custom = Array.isArray(stored) ? stored : [];
    bus.emit("tags:changed", {});
    if (managerEl) renderManager(managerEl);
  }

  function all() {
    const seen = new Set();
    return PRESET.concat(custom).filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  async function persist() {
    await App.Storage.setMeta("customTags", custom);
    bus.emit("tags:changed", {});
  }

  async function addCustom(name) {
    name = (name || "").trim();
    if (!name) return false;
    const exists = all().some((t) => t.toLowerCase() === name.toLowerCase());
    if (exists) { App.toast("Tag already exists", "info"); return false; }
    custom.push(name);
    await persist();
    if (managerEl) renderManager(managerEl);
    App.toast("Tag added", "ok");
    return true;
  }

  async function removeCustom(name) {
    custom = custom.filter((t) => t !== name);
    await persist();
    if (managerEl) renderManager(managerEl);
  }

  /* --------------------- Suggestion chips for editors --------------------- *
     Renders a row of clickable tag chips directly below a comma-separated
     tags <input>. Clicking a chip appends the tag (no duplicates).           */
  function attachSuggestions(input) {
    if (!input || input._tagSuggest) return;
    input._tagSuggest = true;

    const row = document.createElement("div");
    row.className = "tag-suggest";
    input.insertAdjacentElement("afterend", row);

    const current = () => input.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const render = () => {
      row.innerHTML = "";
      const have = new Set(current());
      all().slice(0, 28).forEach((t) => {
        if (have.has(t.toLowerCase())) return;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tag-suggest-chip";
        b.textContent = t;
        b.title = "Add tag “" + t + "”";
        b.addEventListener("click", () => {
          const v = input.value.trim();
          input.value = v ? v.replace(/,\s*$/, "") + ", " + t : t;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          render();
        });
        row.appendChild(b);
      });
    };
    input.addEventListener("input", util.debounce(render, 200));
    render();
  }

  /* ----------------------- Tags manager (Engineering) --------------------- */
  function renderManager(container) {
    managerEl = container;
    if (!container) return;
    container.innerHTML = "";

    const intro = document.createElement("p");
    intro.className = "tags-intro";
    intro.textContent = "Tags are shared across research notes, formulas, figures and literature entries. Click a tag in any editor to apply it.";
    container.appendChild(intro);

    container.appendChild(section("Predefined engineering tags", PRESET, false));
    container.appendChild(section("Custom tags", custom, true));

    // Add-tag row
    const addRow = document.createElement("div");
    addRow.className = "tag-add-row";
    addRow.innerHTML =
      '<input type="text" placeholder="New custom tag, e.g. Heat Exchanger" aria-label="New custom tag" />' +
      '<button class="btn has-label primary">' + App.Icons.get("plus") + "<span>Add tag</span></button>";
    const inp = addRow.querySelector("input");
    const doAdd = async () => { if (await addCustom(inp.value)) inp.value = ""; inp.focus(); };
    addRow.querySelector("button").addEventListener("click", doAdd);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
    container.appendChild(addRow);
  }

  function section(title, list, removable) {
    const sec = document.createElement("div");
    sec.className = "tags-section";
    sec.innerHTML = "<h3>" + title + ' <span class="vh-count">' + list.length + "</span></h3>";
    const grid = document.createElement("div");
    grid.className = "tags-grid";
    if (!list.length) {
      grid.innerHTML = '<span class="tags-empty">' + (removable ? "No custom tags yet — add one below." : "—") + "</span>";
    }
    list.forEach((t) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip-lg " + (removable ? "custom" : "preset");
      chip.innerHTML = "<span></span>";
      chip.querySelector("span").textContent = t;
      if (removable) {
        const x = document.createElement("button");
        x.className = "tag-x"; x.title = "Remove custom tag"; x.setAttribute("aria-label", "Remove tag " + t);
        x.innerHTML = App.Icons.get("x");
        x.addEventListener("click", async () => {
          const ok = await App.confirmDialog({ title: "Remove tag?", message: "“" + t + "” will be removed from suggestions. Items already tagged with it keep the tag.", okText: "Remove", danger: true });
          if (ok) removeCustom(t);
        });
        chip.appendChild(x);
      }
      grid.appendChild(chip);
    });
    sec.appendChild(grid);
    return sec;
  }

  App.Tags = { init, all, addCustom, removeCustom, attachSuggestions, renderManager, PRESET };
})();
