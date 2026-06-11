# Engineering PDF Research Workspace

An **offline engineering PDF research workspace** that combines PDF reading,
annotation, OCR, citation management, literature‑review organisation, formula
management, technical checklist building, document comparison and engineering
reference tools in one **local‑first** application.

It runs entirely from local files — no server, no accounts, no cloud, no API
keys, no paid services. Everything you create (annotations, notes, literature,
citations, figures, projects, formulas, checklists, the safety reference table
and saved comparison reports) is stored locally in your browser.

Built with plain **HTML + CSS + JavaScript**. No framework, no build step.

---

## 1. Quick start

1. Keep the whole folder together (the `vendor/`, `css/` and `js/` folders must
   stay next to `index.html`).
2. **Double‑click `index.html`** to open it in your browser.
3. Drag a PDF onto the window, or click **Open**.

That's it for reading and annotating.

### Recommended: run a tiny local server (optional, but better)

Opening from `file://` works for the viewer and all research features, but
browsers (Chrome especially) are stricter about Web Workers on `file://`. Running
a one‑line local server makes large PDFs smoother **and is required for OCR in
Chrome** (see §4).

From inside the project folder:

```bash
# Python 3 (already on macOS / Linux; on Windows install Python first)
python -m http.server 8000
```

Then open <http://localhost:8000> in your browser. Nothing leaves your machine —
the server only serves the local files to your own browser.

> Firefox can run OCR directly from `file://` without a server.

---

## 2. Folder structure

```
engineering-pdf-workspace/
├── index.html                      Main app (open this)
├── README.md                       This file
├── css/
│   └── styles.css                  Design system + all layout/components
├── js/
│   ├── icons.js                    Inline SVG icon set
│   ├── core.js                     App namespace, state, event bus, helpers
│   ├── storage.js                  IndexedDB v3 + localStorage persistence
│   ├── tags.js                     Engineering tag system (presets + custom)
│   ├── pdfEdit.js                  PDF editing engine (bake annotations, page ops) via pdf‑lib
│   ├── pdfViewer.js                PDF.js integration, rendering, navigation
│   ├── annotations.js              9 annotation tools (canvas + DOM layers)
│   ├── thumbnails.js               Page thumbnail rail
│   ├── search.js                   Find‑in‑PDF (highlight + next/prev)
│   ├── notes.js                    Research notes (page‑linked, categorised)
│   ├── literature.js               Literature review database
│   ├── citations.js                Citation manager (APA 7 + IEEE)
│   ├── figures.js                  Figure/table capture + gallery
│   ├── projects.js                 Projects + active‑project filtering
│   ├── ocr.js                      Offline OCR (Tesseract.js)
│   ├── globalSearch.js             Search across everything
│   ├── shortcuts.js                Keyboard shortcuts
│   ├── exporter.js                 Notes/annotation export, edited‑PDF export, backup/restore
│   ├── pageManager.js              Page management modal (reorder/delete/rotate/merge)
│   ├── formulas.js                 Formula Library (Engineering Workspace)
│   ├── checklists.js               Technical Checklist Builder
│   ├── safety.js                   Safety Limit Reference table
│   ├── converter.js                Unit Converter (10 categories)
│   ├── diff.js                     Pure Myers text‑diff engine
│   ├── compare.js                  Side‑by‑side PDF comparison
│   ├── engineering.js              Engineering Workspace tab coordinator
│   ├── exportCentre.js             Advanced Export Centre
│   ├── palette.js                  Ctrl/Cmd+K command palette
│   └── app.js                      Orchestrator: nav, toolbar, library, session
└── vendor/                         Bundled third‑party libraries (offline)
    ├── pdfjs/                      PDF.js 3.11 (viewer + worker)
    ├── pdf-lib/                    pdf‑lib 1.17.1 (PDF writing/editing) + LICENSE
    ├── fonts/                      IBM Plex Sans / Mono (woff2)
    └── tesseract/                  Tesseract.js 5.1 engine, worker,
        ├── core/                   WASM cores (SIMD + fallback, LSTM)
        └── lang/                   English language model (eng.traineddata.gz)
```

> **About pdf‑lib.** `vendor/pdf-lib/pdf-lib.min.js` is the
> [pdf‑lib](https://pdf-lib.js.org/) library (MIT‑licensed), a pure‑JavaScript
> PDF creator/editor with **no dependencies, no network calls and no web
> workers**. PDF.js (already bundled) *reads/renders* PDFs but cannot write them;
> pdf‑lib does the *writing*. It is used in exactly two places —
> `js/pdfEdit.js` (burning annotations into a new PDF, and the page
> reorder/delete/rotate/merge operations) — and is loaded as a plain `<script>`
> exposing a global `PDFLib`. Nothing about it phones home; the app stays fully
> offline.

---

## 3. What's inside (features)

### Reading & annotating (PDF Reader view)
- Open by drag‑and‑drop or file picker; multiple PDFs build a local **Library**.
- Page navigation, zoom, fit‑width / fit‑page, rotate, fullscreen.
- Page **thumbnails** with badges showing how many marks/notes each page has.
- **Find in document** with highlighted matches and next/previous.
- **Nine annotation tools:** highlight, underline, strikethrough, sticky note,
  free text, rectangle, ellipse, arrow, freehand pen — each in six colours plus a
  custom picker. Vector annotations are stored in PDF coordinates, so they stay
  put across zoom and rotation.
- The session is remembered: re‑opening the app re‑opens your last PDF on the
  right page with your annotations.

### Editing & exporting PDFs (new)
- **Export edited PDF** — generates a brand‑new PDF with your annotations
  (highlights, underlines, strikethroughs, rectangles, ellipses, arrows,
  freehand strokes, sticky notes and text boxes) **burned permanently into the
  pages**, then triggers a normal browser download (`<name>-annotated.pdf`). The
  exported file shows the marks in any PDF viewer — unlike the in‑app
  annotations, which are stored separately. Available from the toolbar
  (**Export PDF**), the **⋯ menu → Export edited PDF…**, and the command palette.
- **Manage pages** — a page‑management modal (toolbar **Pages**, ⋯ menu, or
  palette) showing every page as a thumbnail. You can:
  - **Reorder** pages by dragging thumbnails.
  - **Rotate** individual pages 90° at a time (preview updates live).
  - **Delete / restore** pages (removed pages are excluded from the export).
  - **Merge** other PDFs in — append pages from another document in your
    **Library**, or from a **PDF file** you pick — then reorder/rotate/delete the
    combined set.
  - **Export PDF** writes the final reordered/rotated/merged result as a new file
    (`<name>-edited.pdf`).
  All of this runs locally with the bundled **pdf‑lib** engine (see §2) — no
  upload, no server, fully offline.

### Research tools (separate views in the left nav rail)
- **Research Notes** — page‑linked notes with a captured quote, your comment,
  tags, a **research category** (Literature Review, Methodology, Results,
  Discussion, Safety, Standards, Useful Quote, Formula, To Verify), an
  **importance** level, and created/updated dates. Select text in a PDF and a
  floating **“＋ Note”** button appears; highlight/underline/strikethrough marks
  can also be **saved as research notes** from the Marks panel.
- **Literature Database** — structured entries (title, authors, year,
  journal/conference, DOI/URL, topic, methodology, key findings, limitations,
  relevance, personal notes, tags). Search and filter by tag / year / project;
  export **CSV** or **JSON**. One click turns an entry into a citation.
- **Citations** — generate **APA 7** and **IEEE** references from the same
  fields, copy either, save them, and export all as a `.txt` reference list.
- **Figures & Tables** — **capture a region** of any page (the diagram + your
  annotations are included) and save it as a Figure or Table with title, source,
  page, notes and tags. Browse them in a gallery; export CSV/JSON.
- **Projects** — group PDFs, notes, literature, citations and figures (e.g.
  *Dissertation*, *Internship*, *CN2106*, *Ammonia Safety Guideline*, *CO₂ Safety
  Guideline*). Choosing an **active project** (top of the nav rail) filters every
  section to that project; “All projects” clears the filter. One button seeds the
  example projects.
- **Global Search** — one query across PDF text (open document), OCR text,
  research notes, literature, citations, figure/table metadata, **formulas,
  checklist items and safety‑limit rows**, grouped by source; click a result to
  jump straight to it.

### Engineering Workspace (Phase 3)
A dedicated **Engineering** view in the nav rail, organised into seven tabs:

- **Formula Library** — store formulas with name, equation, description,
  variables, units, category (Fluid Mechanics, Heat Transfer, Thermodynamics,
  Process Safety, Solar PV, Chemical Engineering, Structural/Infrastructure,
  Mathematics, Other), notes, source PDF, page and tags. Add manually, or
  **select an equation in a PDF and choose “Formula”** to capture it. Search,
  filter by category/project, copy any equation, jump back to its source page,
  and export the sheet as **TXT / CSV / JSON**.
- **Technical Checklist Builder** — create checklists in suggested categories
  (Safety Review, Design Review, Literature Review, Dissertation Review,
  Internship Action Items, Regulatory Compliance, Other), add items, tick them
  complete/incomplete with a live progress bar, and **link any item to a PDF
  page or a research note** (click the link chip to jump there). **“New from
  notes”** converts selected research notes into a ready‑made checklist. Export
  one or all as **TXT / CSV / JSON**.
- **Safety Limit Reference** — a local, fully editable table of exposure /
  flammability limits (substance, limit type, value, unit, source, notes). One
  click seeds widely‑published example values for NH₃, H₂, CO₂, O₂ and N₂
  (PEL/REL/STEL/IDLH/AEGL/LEL/UEL/auto‑ignition, each with its source). Add,
  edit, delete, search, filter by limit type, and export **CSV / JSON**. Every
  row carries its source and the panel reminds you to verify against the current
  authoritative source for your jurisdiction.
- **Unit Converter** — ten categories: pressure, temperature, energy, power,
  flow rate, mass, volume, **gas concentration** (ppm ↔ mg/m³ ↔ %vol with a gas
  molar‑mass picker), length and area. Shows the conversion plus an “all units”
  grid. Fully offline arithmetic.
- **Engineering Tags** — a predefined set (PV, Solar, Bifacial, Monofacial,
  Green Roof, Performance Ratio, Temperature Correction, Ammonia, Hydrogen, CO2,
  CCUS, Process Safety, Piping, Pumps, Storage Tanks, Risk Assessment, ALARP,
  Fluid Mechanics, Heat Transfer, Thermodynamics) plus your own **custom tags**.
  These appear as clickable suggestion chips in every editor (notes, formulas,
  figures, literature).
- **Compare PDFs** — open two library PDFs **side by side**, then **Compare
  text** extracts and diffs them, marking **added / removed / changed** lines
  (with word‑level highlights inside changed lines). Toggle *Only changes* with
  expandable context, link page navigation, click any diff line to jump both
  panes to that page, and export the report as **TXT / JSON**. Save reports
  locally and re‑open them later without the PDFs. Ideal for draft guideline
  versions, safety documents and report revisions. Scanned pages fall back to
  stored OCR text.
- **Advanced Export Centre** — one place to export **every** dataset across all
  projects: research notes, citations, literature, formulas, the safety table,
  checklists, each saved comparison report, and a full project backup — in TXT /
  CSV / JSON as applicable.

### Command palette
Press **`Ctrl/Cmd + K`** anywhere to open a VS Code‑style launcher: open a PDF,
search everything, add a note / citation / formula / checklist / literature
entry, capture a figure, run OCR, jump to any Engineering tool or view, back up
or restore, toggle dark mode, save the session, or re‑open a recent document.
Type to filter, ↑/↓ to move, Enter to run, Esc to close.

### Data
- **Back up everything** to a single JSON file (annotations, notes, OCR text,
  literature, citations, figures, projects, **formulas, checklists, the safety
  table and saved comparison reports** plus settings — PDF file bytes are
  excluded to keep it small) and **restore** it later (merge / upsert).

### Keyboard shortcuts
`Ctrl/Cmd+K` command palette · `Ctrl/Cmd+F` find · `Ctrl/Cmd+S` save session ·
`+`/`-` zoom · `←`/`→` page · `Home`/`End` first/last page · `Esc` exit
fullscreen → close palette/find → deselect.

---

## 4. How to use OCR (scanned PDFs)

OCR lets you extract text from **scanned / image‑only** PDFs so they become
searchable. The engine, WASM and English model are all bundled — it runs offline.

1. Open the scanned PDF.
2. Click **OCR** in the toolbar.
3. Choose **OCR current page** or **OCR entire PDF**. A progress bar shows status;
   you can **Stop** at any time.
4. Recognised text appears in the panel — **Copy** it or **Export .txt**.
5. Saved pages are listed as chips; the text is now included in **Global Search**.

**Requirements / where it runs.** Tesseract.js needs Web Workers and local file
access. Browsers block these for pages opened directly from disk (`file://`) —
most notably Chrome.

- ✅ **Best:** run the local server (see §1) and open `http://localhost:8000`.
- ✅ **Firefox** can run OCR from `file://` directly.
- ❌ **Chrome from `file://`** will not start OCR — the panel detects this and
  tells you what to do. (Viewing and all other features still work.)

The first OCR run loads the ~10 MB English model from the local files, so give it
a few seconds. OCR works best on clear, high‑resolution scans.

---

## 5. How to use the research database

A typical workflow:

1. **Make a project** (Projects view → *New project*, or *Add examples*) and set
   it **active** in the nav rail so everything you add is filed under it.
2. **Read & mark up** the PDF. Select an important sentence and click **＋ Note** —
   choose a category (e.g. *Safety*), set importance, add tags, and save. The note
   stores the quote, the source PDF and the page automatically.
3. **Record the paper** in the **Literature Database**: add authors, year,
   journal, DOI, topic, key findings, limitations and your relevance notes.
4. **Generate a citation**: click *Create citation* on a literature card (or open
   the Citations view), then copy the **APA 7** or **IEEE** string, or export the
   whole reference list as `.txt`.
5. **Capture figures/tables**: click **Capture**, drag a box over a diagram, and
   save it as a Figure or Table with a caption and tags.
6. **Find anything later** via **Global Search** — it looks through notes,
   literature, citations, figures, OCR text and the open PDF at once.
7. **Work in the Engineering Workspace** (nav rail → *Engineering*): build a
   **formula library** (or capture equations straight from a PDF), convert units,
   keep an editable **safety‑limit reference**, turn notes into **checklists**,
   and **compare two PDFs** to see exactly what changed between revisions.
8. **Press `Ctrl/Cmd+K`** any time for the command palette — the fastest way to
   jump to any tool or action.
9. **Back up** regularly (toolbar menu → *Back up everything*, or the Export
   Centre). Restore on another machine or browser with *Restore from backup*.

Everything is filtered by the **active project**, so you can keep *Dissertation*
research separate from an *Ammonia Safety Guideline*, etc. Switching to “All
projects” shows everything together.

---

## 6. Known limitations

- **Storage is per‑browser and per‑device.** Data lives in this browser's
  IndexedDB/localStorage. It isn't shared between browsers or computers — use
  **Backup / Restore** to move it. Clearing site data / “Clear” deletes it.
- **Backups exclude PDF file bytes** (to stay small). After restoring on a new
  machine, re‑open the PDFs themselves; your annotations/notes re‑link by document.
- **OCR needs Web Workers** → it does **not** run in Chrome from `file://`. Use a
  local server or Firefox (see §4). OCR is **English‑only** unless you add more
  `*.traineddata` files to `vendor/tesseract/lang/`.
- **Annotations are stored in PDF coordinates but are region/point based**, not
  anchored to the underlying text runs. They track zoom/rotation correctly, but
  if the same logical text reflows in a different file it won't follow.
- **Find‑in‑PDF** matches within each text item; a phrase split across separate
  text runs in the PDF may not highlight. Global full‑text search covers the
  **open** PDF and any document you've **OCR'd**; other unopened PDFs aren't
  full‑text indexed.
- **One page is rendered at a time** (no continuous scroll); thumbnails jump
  between pages.
- **Fonts:** PDFs relying on non‑embedded CJK or exotic fonts may show fallback
  glyphs, because the app ships no external font data.
- **Capture** grabs the rendered raster of the selected region (diagram + drawn
  annotations); it is an image, not extracted vector/table data.
- **PDF comparison compares extracted text, not layout.** It needs the PDF's
  **stored bytes**, so open each document once in the Reader (or have it in the
  Library) before comparing. Scanned pages with no text layer fall back to
  stored **OCR** text — run OCR on them first, or those pages compare as empty.
  Word‑level diffing is skipped on extremely long lines, and very dissimilar
  documents fall back to a block‑level comparison (the diff is capped at roughly
  3,000 line edits / 4,000 rendered rows to keep the page responsive — export
  the report for the complete diff).
- **The Safety Limit Reference is a convenience table, not an authority.** Seeded
  values are widely published figures with their source noted, but standards
  change and vary by jurisdiction — always verify against the current
  authoritative source before relying on any value.
- **The Formula Library stores formulas as text; it does not evaluate them.**
  Equations are for reference, capture and export, not computation.

---

## 7. Suggested future upgrades

Natural next steps beyond this build:

- Continuous / two‑up scrolling and a multi‑document tab bar.
- **True text‑anchored highlights** that survive reflow and copy with the text.
- Reference / DOI **auto‑import** (paste a DOI → fields fill in) and BibTeX/RIS
  export, plus more citation styles via CSL.
- A computable formula engine (evaluate stored formulas with unit‑aware inputs),
  building on the existing converter.
- Cross‑document linking and a **knowledge graph** of notes ↔ papers ↔ figures
  ↔ formulas.
- AI‑assisted **summaries**, key‑point extraction and table extraction.
- Optional encrypted **cloud sync** and real‑time **collaboration**.

---

## 8. Debugging notes

- **Storage / migration.** Data lives in IndexedDB database `epdf_workspace`
  (now **schema v3**). Opening a Phase‑2 (v2) database triggers an automatic
  `onupgradeneeded` that **adds** the `formulas`, `checklists`, `safety` and
  `comparisons` stores without touching existing data. Inspect everything in
  DevTools → **Application → IndexedDB**. **“Clear”** (toolbar menu) wipes all
  stores and the saved session.
- **OCR on `file://`.** Tesseract needs Web Workers, which Chrome blocks on
  `file://`. Symptom: OCR silently fails or hangs. Fix: run the one‑line local
  server (see §4) or use Firefox. Worker/core/lang paths are
  `vendor/tesseract/...` and must stay next to `index.html`.
- **PDF comparison empties.** If a comparison shows no text, the document is
  likely scanned (no text layer) — run **OCR** on it first; the comparison reads
  stored OCR text as a fallback. Comparison also needs the PDF's stored bytes, so
  open each file once in the Reader beforehand.
- **Diff cap.** The Myers diff caps at ~3,000 line edits; beyond that you get a
  block‑level (“capped”) comparison and a notice. The rendered list caps at
  ~4,000 rows — keep *Only changes* on, or export the report (TXT/JSON) for the
  full diff.
- **Command palette.** `Ctrl/Cmd+K` is bound on `document` in the **capture**
  phase so it works even from inside inputs; `Esc` closes it first. If it ever
  seems unresponsive, another modal may be open — close it and retry.
- **Exported PDF looks different from the screen.** The exported file bakes
  annotations using pdf‑lib's vector drawing, so highlights/shapes render
  cleanly in any viewer but may differ by a pixel or two from the on‑screen
  canvas preview. Sticky notes are drawn as a small coloured square plus their
  text. If **Export edited PDF** reports the engine is unavailable, confirm
  `vendor/pdf-lib/pdf-lib.min.js` is present and loaded (it must sit next to
  `index.html`).
- **Page manager / merge.** Merging needs each source PDF's stored bytes:
  Library sources are read from IndexedDB, and "Add PDF file…" reads the picked
  file directly. Rotations in the page manager are *relative* (each +90° adds to
  the page's existing rotation). Removed pages are only excluded on **export** —
  nothing is deleted from your stored copy.
- **Layout looked zoomed‑in at 100%? (fixed).** The earlier glitch came from the
  reader shell using viewport units (`100vh/100vw`) while nested inside another
  full‑viewport container offset by the nav rail, so the units double‑counted and
  overflowed (it only "looked right" around 80% zoom). The shell now uses
  `height/width: 100%` flowing from a single locked root, with `min-width:0;
  min-height:0` on the flex/grid children so tracks shrink instead of
  overflowing. If you fork the CSS, avoid putting `100vw/100vh` on anything below
  `.workspace-root`.
- **Everything is namespaced on `window.App`.** Modules attach themselves
  (`App.Formulas`, `App.Compare`, `App.PdfEdit`, `App.PageManager`, …) and
  communicate via the `App.bus` pub/sub. From the console you can call e.g.
  `App.Storage.dumpAll()`, `App.Exporter.exportEditedPdf()` or
  `App.PageManager.open()` to poke at state.

---

*Offline by design. Your documents and research never leave your device.*
