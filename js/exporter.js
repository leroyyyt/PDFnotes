/* =============================================================================
   exporter.js — Export & backup.

     • Notes (open document)      → TXT / JSON
     • Annotations (open document)→ JSON
     • Full backup                → one JSON file containing notes, OCR text,
                                     literature, citations, figure/table
                                     metadata, project structure, annotations
                                     and settings (PDF bytes are excluded).
     • Restore                    → merge a backup JSON back in (id-based upsert).

   Exposed as window.App.Exporter.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;
  const { state, util } = App;

  /* ----------------------------- Notes ----------------------------------- */
  function notesForDoc() {
    const all = App.Notes ? App.Notes.getAll() : [];
    if (state.docId) return all.filter((n) => n.docId === state.docId);
    return all;
  }

  function exportNotesTxt() {
    const notes = notesForDoc().slice().sort((a, b) => (a.page || 0) - (b.page || 0));
    if (!notes.length) return App.toast("No notes to export", "warn");
    const title = (state.docMeta && state.docMeta.name) || "All documents";
    const lines = [
      "ENGINEERING PDF RESEARCH WORKSPACE — NOTES",
      "Document: " + title,
      "Exported: " + new Date().toLocaleString(),
      "Total notes: " + notes.length,
      "",
    ];
    notes.forEach((n, i) => {
      lines.push((i + 1) + ". [" + n.category + " · " + cap(n.importance) + "] — page " + n.page);
      if (n.quote) lines.push('   Quote: "' + n.quote + '"');
      if (n.body) lines.push("   Note: " + n.body);
      if (n.tags && n.tags.length) lines.push("   Tags: " + n.tags.join(", "));
      lines.push("   Saved: " + util.formatDate(n.updatedAt || n.createdAt));
      lines.push("");
    });
    download(baseName() + "-notes.txt", lines.join("\n"), "text/plain");
  }

  function exportNotesJson() {
    const notes = notesForDoc();
    if (!notes.length) return App.toast("No notes to export", "warn");
    download(baseName() + "-notes.json", JSON.stringify(notes, null, 2), "application/json");
  }

  /* -------------------------- Annotations -------------------------------- */
  function exportAnnotationsJson() {
    if (!state.docId || !state.annotations.length) return App.toast("No annotations to export", "warn");
    const payload = {
      document: (state.docMeta && state.docMeta.name) || state.docId,
      exportedAt: new Date().toISOString(),
      count: state.annotations.length,
      annotations: state.annotations,
    };
    download(baseName() + "-annotations.json", JSON.stringify(payload, null, 2), "application/json");
  }

  /* ---------------------------- Full backup ------------------------------ */
  async function backupAll() {
    try {
      const data = await App.Storage.dumpAll();
      download("epdf-backup-" + new Date().toISOString().slice(0, 10) + ".json", JSON.stringify(data, null, 2), "application/json");
      App.toast("Backup downloaded", "ok");
    } catch (e) {
      console.error(e); App.toast("Backup failed", "err");
    }
  }

  // Open a file picker and restore the chosen backup.
  function importBackupPrompt() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "application/json,.json";
    input.addEventListener("change", () => { if (input.files && input.files[0]) restoreFromFile(input.files[0]); });
    input.click();
  }

  async function restoreFromFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (e) { return App.toast("That file isn’t valid JSON", "err"); }

    const counts = [
      ["projects", data.projects], ["notes", data.notes], ["literature", data.literature],
      ["citations", data.citations], ["figures", data.figures],
      ["formulas", data.formulas], ["checklists", data.checklists],
      ["safety rows", data.safety], ["comparison reports", data.comparisons],
    ].map(([k, v]) => (v ? v.length : 0) + " " + k).join(", ");

    const ok = await App.confirmDialog({
      title: "Restore backup?",
      message: "This merges the backup into your current data (existing items with the same id are overwritten). Found: " + counts + ".",
      okText: "Restore",
    });
    if (!ok) return;

    try {
      const stats = await App.Storage.importAll(data);
      App.toast("Restored backup", "ok");
      // refresh everything that caches data
      if (App.Projects) await App.Projects.reload();
      if (App.Notes) await App.Notes.reloadAll();
      if (App.Literature) await App.Literature.reload();
      if (App.Citations) await App.Citations.reload();
      if (App.Figures) await App.Figures.reload();
      if (App.Formulas) await App.Formulas.reload();
      if (App.Checklists) await App.Checklists.reload();
      if (App.Safety) await App.Safety.reload();
      if (App.Compare) await App.Compare.reload();
      App.bus.emit("data:imported", stats);
      // if a document is open, reload its annotations (may have been imported)
      if (state.docId) {
        state.annotations = await App.Storage.getAnnotations(state.docId);
        App.bus.emit("annotations:changed", {});
        if (App.Annotations) App.Annotations.redraw();
      }
    } catch (e) {
      console.error(e); App.toast("Restore failed: " + (e.message || "error"), "err");
    }
  }

  /* ----------------------- Export edited (flattened) PDF ----------------- */
  // Fetch the raw bytes for the currently open document.
  async function currentDocBytes() {
    if (!state.docId) return null;
    const rec = await App.Storage.getFile(state.docId);
    if (!rec || !rec.data) return null;
    return rec.data instanceof Uint8Array ? rec.data : new Uint8Array(rec.data);
  }

  // Generate a new PDF with the visible annotations burned in, then download it.
  async function exportEditedPdf() {
    if (!state.docId) return App.toast("Open a PDF first", "warn");
    if (!App.PdfEdit || !App.PdfEdit.available()) return App.toast("PDF engine not available", "err");
    const annos = state.annotations || [];
    App.toast("Building annotated PDF…", "info");
    try {
      const bytes = await currentDocBytes();
      if (!bytes) return App.toast("Could not read the original PDF bytes", "err");
      const out = await App.PdfEdit.bakeAnnotations(bytes, annos);
      util.downloadFile(baseName() + "-annotated.pdf", out, "application/pdf");
      App.toast(annos.length ? "Annotated PDF exported" : "PDF exported (no annotations on this document)", "ok");
    } catch (e) {
      console.error(e);
      App.toast("Export failed: " + (e.message || "error"), "err");
    }
  }

  /* ------------------------------ Helpers -------------------------------- */
  function baseName() { return ((state.docMeta && state.docMeta.name) || "workspace").replace(/\.pdf$/i, ""); }
  function download(name, text, mime) { util.downloadFile(name, text, mime); }
  function cap(s) { return (s || "").charAt(0).toUpperCase() + (s || "").slice(1); }

  App.Exporter = {
    exportNotesTxt, exportNotesJson, exportAnnotationsJson,
    exportEditedPdf, currentDocBytes,
    backupAll, importBackupPrompt,
  };
})();
