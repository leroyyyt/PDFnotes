/* =============================================================================
   engineering.js — Engineering Workspace coordinator.

   Owns the sub-tab bar inside #view-engineering and switches between the
   seven tool panels:
     formulas · checklists · safety · convert · tags · compare · export

   App.Engineering.showTab(name) can be called from anywhere (command palette,
   global search, other modules); it switches to the Engineering view first if
   needed, then activates the tab and lets lazy panels refresh themselves.

   Emits : eng:tab {name}
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { bus } = App;

  const TABS = ["formulas", "checklists", "safety", "convert", "tags", "compare", "export"];

  function init() {
    document.querySelectorAll(".eng-tab[data-etab]").forEach((btn) => {
      btn.addEventListener("click", () => showTab(btn.getAttribute("data-etab")));
    });
    // Initial active tab comes from the markup (formulas).
  }

  function showTab(name) {
    if (TABS.indexOf(name) === -1) name = TABS[0];
    if (App.currentView !== "engineering" && App.switchView) App.switchView("engineering");
    document.querySelectorAll(".eng-tab[data-etab]").forEach((b) =>
      b.classList.toggle("active", b.getAttribute("data-etab") === name));
    document.querySelectorAll(".eng-panel").forEach((p) =>
      p.classList.toggle("active", p.id === "eng-panel-" + name));

    // Lazy refreshes for panels that depend on live data.
    if (name === "tags" && App.Tags) App.Tags.renderManager(document.getElementById("tags-root"));
    if (name === "compare" && App.Compare) App.Compare.onShow();
    if (name === "export" && App.ExportCentre) App.ExportCentre.refresh();

    bus.emit("eng:tab", { name });
  }

  App.Engineering = { init, showTab, TABS };
})();
