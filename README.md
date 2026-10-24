# Zetesis (ζήτησις)

A local, file-based note browser and inquiry tool for your Org-mode, Markdown, and PDF documents.

In the Greek philosophical tradition, **Zetesis** (ζήτησις) means search, examination, and inquiry. The app is self-contained: notes are stored directly within `zetesis/notes/`, and the server reads from them with zero external database dependencies.

## Tracked Folders

Only the following folders are tracked and stored inside `zetesis/notes/`:

- **`cooking/`** (Cooking) — Recipes and kitchen notes
- **`cs/`** (Computer Science) — All nested technical topics (`algorithms/`, `architecture/`, `c++/`, `cloud/`, `compilers/`, `hft/`, `machine-learning/`, `networking/`, `os/`, `programming-languages/`, etc.)
- **`knowledge/`** (Knowledge) — Domain studies (`economics/`, `geopolitics/`, `history/`, `investing/`, `worldview/`)
- **`poker/`** (Poker) — Game theory and tournament concepts
- **`thoughts/`** (Thoughts) — Personal reflections, reviews, and formalizations

Other folders outside `zetesis/` (such as `admin/`, `archive/`, `projects/`, `recruiting/`, and `two-sigma/`) are not tracked.

## Features

- **Full Hierarchical Tree**: Preserves your exact nested folder hierarchy at any depth (1st, 2nd, 3rd, 4th, 5th layers) with interactive expand/collapse chevrons and real-time note counts.
- **Clickable Breadcrumb Navigation**: Drill down into any subfolder and easily jump back to parent categories.
- **Emacs Workflow**: Open and edit any note in Emacs directly inside `zetesis/notes/`. Edits appear in the browser on refresh without server restarts.
- **Fast Full-Text Search**: Instant search across titles, file paths, and note contents with `⌘ K` shortcut and context snippets.
- **Rich Document Preview**: Renders Org-mode and Markdown headings, code blocks, lists, blockquotes, tables, embedded screenshots (`org-imgs/`), and PDF documents.
- **Automatic Dark Mode**: Seamlessly matches your macOS light/dark appearance preference.

## Start the App

From the workspace root:

```sh
python3 zetesis/server.py
```

Then open <http://127.0.0.1:8000> in your browser.

To stop the server, press `Ctrl+C`. To choose a custom port:

```sh
python3 zetesis/server.py --port 8080
```
