/* =============================================================================
   storage.js — Offline persistence using IndexedDB (schema v3, Phase 3).

   Object stores (keyPath):
     files        id      { id, data(ArrayBuffer), name, size, type }  — raw PDF bytes
     documents    id      { id, name, size, pageCount, addedAt, lastOpened, projectId }
     annotations  docId   { docId, items:[...] }                       — per-document array
     ocr          docId   { docId, pages:{n:text}, updatedAt }          — OCR results
     notes        id      research notes (indexes: docId, projectId)
     literature   id      literature-review entries (index: projectId)
     citations    id      citation records (index: projectId)
     figures      id      figure / table captures (index: projectId)
     projects     id      project containers
     formulas     id      engineering formula library (index: projectId)   [v3]
     checklists   id      technical checklists w/ items[] (index: projectId)[v3]
     safety       id      safety limit reference rows                      [v3]
     comparisons  id      saved document-comparison reports                [v3]
     meta         key     { key, value }                               — session + settings

   Storing PDF bytes lets the app fully restore a session (re-open the same
   document) without re-picking the file. Backups exclude the heavy PDF bytes
   but include all research data (notes, OCR, literature, citations, figures,
   projects, formulas, checklists, safety table, comparison reports, settings).
   Exposed as window.App.Storage.
   ========================================================================== */
(function () {
  "use strict";
  const App = window.App;

  const DB_NAME = "epdf_workspace";
  const DB_VERSION = 3;

  // Stores that hold individual id-keyed records (generic CRUD).
  const RECORD_STORES = ["notes", "literature", "citations", "figures", "projects",
    "formulas", "checklists", "safety", "comparisons"];
  // Every store, used for clearAll.
  const ALL_STORES = ["files", "documents", "annotations", "ocr", "meta"].concat(RECORD_STORES);

  let dbPromise = null;
  let available = true;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { available = false; return reject(new Error("IndexedDB unavailable")); }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const txn = e.target.transaction;

        if (!db.objectStoreNames.contains("files"))       db.createObjectStore("files", { keyPath: "id" });
        if (!db.objectStoreNames.contains("documents"))   db.createObjectStore("documents", { keyPath: "id" });
        if (!db.objectStoreNames.contains("annotations")) db.createObjectStore("annotations", { keyPath: "docId" });
        if (!db.objectStoreNames.contains("ocr"))         db.createObjectStore("ocr", { keyPath: "docId" });
        if (!db.objectStoreNames.contains("meta"))        db.createObjectStore("meta", { keyPath: "key" });

        // notes: in v1 this was keyed by docId with an items[] array. Phase 2
        // stores each note as its own record so notes can be browsed globally
        // and grouped by project. Recreate the store with the new shape.
        if (db.objectStoreNames.contains("notes")) {
          const existing = txn.objectStore("notes");
          if (existing.keyPath !== "id") db.deleteObjectStore("notes");
        }
        if (!db.objectStoreNames.contains("notes")) {
          const s = db.createObjectStore("notes", { keyPath: "id" });
          s.createIndex("docId", "docId", { unique: false });
          s.createIndex("projectId", "projectId", { unique: false });
        }

        if (!db.objectStoreNames.contains("literature")) {
          const s = db.createObjectStore("literature", { keyPath: "id" });
          s.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains("citations")) {
          const s = db.createObjectStore("citations", { keyPath: "id" });
          s.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains("figures")) {
          const s = db.createObjectStore("figures", { keyPath: "id" });
          s.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains("projects")) {
          db.createObjectStore("projects", { keyPath: "id" });
        }

        // --- v3 additions (a v2 → v3 upgrade keeps all existing data) -----
        if (!db.objectStoreNames.contains("formulas")) {
          const s = db.createObjectStore("formulas", { keyPath: "id" });
          s.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains("checklists")) {
          const s = db.createObjectStore("checklists", { keyPath: "id" });
          s.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains("safety")) {
          db.createObjectStore("safety", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("comparisons")) {
          db.createObjectStore("comparisons", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { available = false; reject(req.error); };
    });
    return dbPromise;
  }

  // Generic transaction helper returning a promise that resolves on commit.
  function tx(storeNames, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeNames, mode);
          let result;
          t.oncomplete = () => resolve(result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error("transaction aborted"));
          result = fn(t);
        }),
      (err) => { console.warn("Storage disabled:", err && err.message); return null; }
    );
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /* ----------------------- Generic record CRUD --------------------------- */
  function putRecord(store, record) {
    return tx(store, "readwrite", (t) => t.objectStore(store).put(record));
  }
  async function getRecord(store, id) {
    return tx(store, "readonly", (t) => reqToPromise(t.objectStore(store).get(id)));
  }
  async function getAll(store) {
    const all = await tx(store, "readonly", (t) => reqToPromise(t.objectStore(store).getAll()));
    return all || [];
  }
  async function getByIndex(store, index, value) {
    const all = await tx(store, "readonly", (t) =>
      reqToPromise(t.objectStore(store).index(index).getAll(value))
    );
    return all || [];
  }
  function deleteRecord(store, id) {
    return tx(store, "readwrite", (t) => t.objectStore(store).delete(id));
  }

  /* ----------------------------- Files ----------------------------------- */
  function putFile(id, arrayBuffer, info) {
    return tx("files", "readwrite", (t) =>
      t.objectStore("files").put({
        id, data: arrayBuffer,
        name: info.name, size: info.size, type: info.type || "application/pdf",
      })
    );
  }
  async function getFile(id) {
    return tx("files", "readonly", (t) => reqToPromise(t.objectStore("files").get(id)));
  }

  /* --------------------------- Documents --------------------------------- */
  function putDoc(meta) {
    return tx("documents", "readwrite", (t) => t.objectStore("documents").put(meta));
  }
  async function getDoc(id) {
    return tx("documents", "readonly", (t) => reqToPromise(t.objectStore("documents").get(id)));
  }
  async function getAllDocs() {
    const all = await tx("documents", "readonly", (t) => reqToPromise(t.objectStore("documents").getAll()));
    return (all || []).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  }
  async function deleteDoc(id) {
    // Remove the file, its metadata, annotations, OCR, and any notes/figures/
    // formulas that referenced it (their docId is cleared, the record is kept).
    const notes = await getByIndex("notes", "docId", id);
    const figures = await getAll("figures");
    const formulas = await getAll("formulas");
    return tx(["files", "documents", "annotations", "ocr", "notes", "figures", "formulas"], "readwrite", (t) => {
      t.objectStore("files").delete(id);
      t.objectStore("documents").delete(id);
      t.objectStore("annotations").delete(id);
      t.objectStore("ocr").delete(id);
      // Keep notes but detach them from the deleted document.
      notes.forEach((n) => { n.docId = null; t.objectStore("notes").put(n); });
      figures.filter((f) => f.docId === id).forEach((f) => { f.docId = null; t.objectStore("figures").put(f); });
      formulas.filter((f) => f.docId === id).forEach((f) => { f.docId = null; t.objectStore("formulas").put(f); });
    });
  }
  async function clearAll() {
    return tx(ALL_STORES, "readwrite", (t) => { ALL_STORES.forEach((s) => t.objectStore(s).clear()); });
  }

  /* -------------------------- Annotations -------------------------------- */
  function saveAnnotations(docId, items) {
    return tx("annotations", "readwrite", (t) =>
      t.objectStore("annotations").put({ docId, items: items || [] })
    );
  }
  async function getAnnotations(docId) {
    const rec = await tx("annotations", "readonly", (t) =>
      reqToPromise(t.objectStore("annotations").get(docId))
    );
    return (rec && rec.items) || [];
  }

  /* ------------------------------- OCR ----------------------------------- */
  async function getOcr(docId) {
    return tx("ocr", "readonly", (t) => reqToPromise(t.objectStore("ocr").get(docId)));
  }
  function saveOcr(rec) {
    rec.updatedAt = Date.now();
    return tx("ocr", "readwrite", (t) => t.objectStore("ocr").put(rec));
  }
  async function saveOcrPage(docId, pageNum, text) {
    const rec = (await getOcr(docId)) || { docId, pages: {} };
    rec.pages[pageNum] = text;
    return saveOcr(rec);
  }

  /* --------------- Typed helpers over the generic CRUD ------------------- */
  // Notes
  function saveNote(note)         { return putRecord("notes", note); }
  function deleteNote(id)         { return deleteRecord("notes", id); }
  function getAllNotes()          { return getAll("notes"); }
  function getNotesByDoc(docId)   { return getByIndex("notes", "docId", docId); }
  // Literature
  function saveLiterature(rec)    { return putRecord("literature", rec); }
  function deleteLiterature(id)   { return deleteRecord("literature", id); }
  function getAllLiterature()     { return getAll("literature"); }
  // Citations
  function saveCitation(rec)      { return putRecord("citations", rec); }
  function deleteCitation(id)     { return deleteRecord("citations", id); }
  function getAllCitations()      { return getAll("citations"); }
  // Figures / tables
  function saveFigure(rec)        { return putRecord("figures", rec); }
  function deleteFigure(id)       { return deleteRecord("figures", id); }
  function getAllFigures()        { return getAll("figures"); }
  // Projects
  function saveProject(rec)       { return putRecord("projects", rec); }
  async function deleteProject(id) {
    // Detach (don't destroy) everything that belonged to the project.
    const [notes, lit, cites, figs, docs, fxs, chks] = await Promise.all([
      getAll("notes"), getAll("literature"), getAll("citations"), getAll("figures"),
      getAll("documents"), getAll("formulas"), getAll("checklists"),
    ]);
    return tx(["projects", "notes", "literature", "citations", "figures", "documents", "formulas", "checklists"], "readwrite", (t) => {
      t.objectStore("projects").delete(id);
      const detach = (store, list) => list.filter((r) => r.projectId === id)
        .forEach((r) => { r.projectId = null; t.objectStore(store).put(r); });
      detach("notes", notes); detach("literature", lit); detach("citations", cites);
      detach("figures", figs); detach("documents", docs);
      detach("formulas", fxs); detach("checklists", chks);
    });
  }
  function getAllProjects()       { return getAll("projects"); }
  // Formulas (Phase 3)
  function saveFormula(rec)       { return putRecord("formulas", rec); }
  function deleteFormula(id)      { return deleteRecord("formulas", id); }
  function getAllFormulas()       { return getAll("formulas"); }
  // Checklists (Phase 3)
  function saveChecklist(rec)     { return putRecord("checklists", rec); }
  function deleteChecklist(id)    { return deleteRecord("checklists", id); }
  function getAllChecklists()     { return getAll("checklists"); }
  // Safety limit reference (Phase 3)
  function saveSafety(rec)        { return putRecord("safety", rec); }
  function deleteSafety(id)       { return deleteRecord("safety", id); }
  function getAllSafety()         { return getAll("safety"); }
  // Comparison reports (Phase 3)
  function saveComparison(rec)    { return putRecord("comparisons", rec); }
  function deleteComparison(id)   { return deleteRecord("comparisons", id); }
  function getAllComparisons()    { return getAll("comparisons"); }

  /* ------------------------------ Meta ----------------------------------- */
  function setMeta(key, value) {
    return tx("meta", "readwrite", (t) => t.objectStore("meta").put({ key, value }));
  }
  async function getMeta(key) {
    const rec = await tx("meta", "readonly", (t) => reqToPromise(t.objectStore("meta").get(key)));
    return rec ? rec.value : undefined;
  }
  async function getAllMeta() {
    const all = await getAll("meta");
    const out = {};
    all.forEach((m) => { out[m.key] = m.value; });
    return out;
  }

  /* ------------------- Backup: dump / import everything ------------------ *
     PDF bytes (the `files` store) are intentionally excluded — they are large
     and tied to a specific machine. Everything else (research data + settings)
     is portable JSON.                                                        */
  async function dumpAll() {
    const [documents, ocrRecs, notes, literature, citations, figures, projects,
      formulas, checklists, safety, comparisons, meta] =
      await Promise.all([
        getAll("documents"), getAll("ocr"), getAll("notes"), getAll("literature"),
        getAll("citations"), getAll("figures"), getAll("projects"),
        getAll("formulas"), getAll("checklists"), getAll("safety"), getAll("comparisons"),
        getAllMeta(),
      ]);
    // Annotations are per-document; gather them keyed by docId.
    const annotations = {};
    for (const d of documents) annotations[d.id] = await getAnnotations(d.id);
    return {
      app: "Engineering PDF Research Workspace",
      schema: DB_VERSION,
      exportedAt: new Date().toISOString(),
      documents, annotations, ocr: ocrRecs,
      notes, literature, citations, figures, projects,
      formulas, checklists, safety, comparisons,
      settings: meta,
    };
  }

  // Merge an exported backup back into the database (id-based upsert).
  async function importAll(data) {
    if (!data || typeof data !== "object") throw new Error("Invalid backup file");
    const stats = { documents: 0, notes: 0, literature: 0, citations: 0, figures: 0, projects: 0,
      formulas: 0, checklists: 0, safety: 0, comparisons: 0, ocr: 0, annotations: 0 };

    const putList = (store, list, key) => tx(store, "readwrite", (t) => {
      (list || []).forEach((r) => { if (r && r[key] != null) { t.objectStore(store).put(r); stats[store]++; } });
    });

    await putList("projects", data.projects, "id");
    await putList("documents", data.documents, "id");   // metadata only; bytes restored separately if present
    await putList("notes", data.notes, "id");
    await putList("literature", data.literature, "id");
    await putList("citations", data.citations, "id");
    await putList("figures", data.figures, "id");
    await putList("formulas", data.formulas, "id");
    await putList("checklists", data.checklists, "id");
    await putList("safety", data.safety, "id");
    await putList("comparisons", data.comparisons, "id");
    await putList("ocr", data.ocr, "docId");

    if (data.annotations) {
      await tx("annotations", "readwrite", (t) => {
        Object.keys(data.annotations).forEach((docId) => {
          t.objectStore("annotations").put({ docId, items: data.annotations[docId] || [] });
          stats.annotations++;
        });
      });
    }
    if (data.settings) {
      await tx("meta", "readwrite", (t) => {
        Object.keys(data.settings).forEach((k) => {
          // Don't clobber the live session pointer on import.
          if (k === "session") return;
          t.objectStore("meta").put({ key: k, value: data.settings[k] });
        });
      });
    }
    return stats;
  }

  /* --------------------- Deterministic document id ----------------------- *
     crypto.subtle is unavailable on file:// (insecure context), so we use a
     fast non-cryptographic hash over name + size + a content sample. Stable
     enough to recognise the same file when it is re-opened.                  */
  async function computeDocId(file, arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const sampleLen = Math.min(bytes.length, 65536);
    let h1 = 0x811c9dc5, h2 = 0x1000193;
    for (let i = 0; i < sampleLen; i++) {
      const c = bytes[i];
      h1 = (h1 ^ c) >>> 0; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (Math.imul(h2 ^ c, 0x85ebca6b)) >>> 0;
    }
    const sizePart = (file.size >>> 0).toString(16);
    const namePart = Array.from(file.name).reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0, 7).toString(16);
    return "doc_" + h1.toString(16) + h2.toString(16) + sizePart + namePart;
  }

  App.Storage = {
    open, isAvailable: () => available,
    // generic
    putRecord, getRecord, getAll, getByIndex, deleteRecord,
    // files + documents
    putFile, getFile, putDoc, getDoc, getAllDocs, deleteDoc, clearAll,
    // annotations
    saveAnnotations, getAnnotations,
    // ocr
    getOcr, saveOcr, saveOcrPage,
    // typed entities
    saveNote, deleteNote, getAllNotes, getNotesByDoc,
    saveLiterature, deleteLiterature, getAllLiterature,
    saveCitation, deleteCitation, getAllCitations,
    saveFigure, deleteFigure, getAllFigures,
    saveProject, deleteProject, getAllProjects,
    saveFormula, deleteFormula, getAllFormulas,
    saveChecklist, deleteChecklist, getAllChecklists,
    saveSafety, deleteSafety, getAllSafety,
    saveComparison, deleteComparison, getAllComparisons,
    // meta + backup
    setMeta, getMeta, getAllMeta,
    dumpAll, importAll,
    computeDocId,
  };
})();
