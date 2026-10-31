# Zetesis (ζήτησις)

A local, database-backed note application for your Org-mode, Markdown, and PDF documents.

In the Greek philosophical tradition, **Zetesis** (ζήτησις) means search, examination, and inquiry. Zetesis runs locally and uses SQLite from Python's standard library; no separate database service is needed.

## Tracked Folders

On first launch, Zetesis imports supported notes from these folders into `zetesis/zetesis.sqlite3`:

- **`cooking/`** (Cooking) — Recipes and kitchen notes
- **`cs/`** (Computer Science) — All nested technical topics (`algorithms/`, `architecture/`, `c++/`, `cloud/`, `compilers/`, `hft/`, `machine-learning/`, `networking/`, `os/`, `programming-languages/`, etc.)
- **`knowledge/`** (Knowledge) — Domain studies (`economics/`, `geopolitics/`, `history/`, `investing/`, `worldview/`)
- **`life/`** (Life) — Personal notes on finances, travel, free time, and relationships
- **`poker/`** (Poker) — Game theory and tournament concepts
- **`thoughts/`** (Thoughts) — Personal reflections, reviews, and formalizations

The import copies text into the database and leaves the original source files unchanged. After import, the database is the app's source of truth; edits made in Zetesis do not write back to the original files. PDF and image files in Zetesis' notes tree are read-only app-managed copies and are removed when their note is permanently deleted.

## Features

- **Create and edit notes in place**: Edit the rendered note directly in the reader, change its title in the header, and see Org/Markdown headings and lists render as you type.
- **Organize notes**: Create topics and drag notes between topics or existing subfolders. These are virtual locations managed by Zetesis.
- **Permanent deletion**: Zetesis asks for confirmation before permanently deleting a note and its app-managed copy or attachment.
- **Full-text search**: Search titles, note paths, and note content with `⌘ K`.
- **Document preview**: Renders Org-mode and Markdown headings, code blocks, lists, blockquotes, tables, links, embedded images, and PDFs.
- **Roadmap & Queue**: Browse resources by topic and edit its Org outline in the app.
- **Projects**: Track projects by status, add tasks, update task progress, and see completion at a glance.
- **Following**: Save and organize links to websites, blogs, YouTube channels, and individual articles; includes Hacker News as a starting item.
- **Export backup**: Download a ZIP containing the SQLite database and original notes tree.
- **Automatic Dark Mode**: Seamlessly matches your macOS light/dark appearance preference.

## Roadmap & Queue

The **Roadmap & Queue** view keeps its Org outline in SQLite. Add or edit a resource to assign it to a topic and an optional subtopic. Existing subtopics are suggested as you type, and you can enter a new one. Open a topic to see its resources grouped by subtopic; drag a resource into another group to recategorize it.

Topics are top-level headings. A plain second-level heading starts a subtopic, and resource headings beneath it belong to that subtopic. Resources without a subtopic sit directly under the topic. Resource headings can be tagged with their medium and prefixed with a status. For example:

```org
* Computer Systems
** Distributed Systems
*** NEXT Designing Data-Intensive Applications :book:
- Author: Martin Kleppmann
- Focus: Replication, partitioning, and consensus
- Link: [[file:cs/cloud/03-distributed-computing/00-intro-to-distributed-programming.org]]

*** TODO Distributed Systems Podcast #42 - Raft Consensus :podcast:
- Link: https://example.com/raft

* Machine Learning
** Transformers
*** TODO Transformer Architecture Explained :video:
- Link: https://www.youtube.com/watch?v=VIDEO_ID

** TODO A resource directly under Machine Learning :book:
```

Supported tags are `:book:`, `:podcast:`, `:video:`, and `:idea:`. Supported statuses are `NEXT`, `TODO`, `DONE`, `READING`, and `IN_PROGRESS`. Additional metadata bullets (`Author`, `Host`, `Focus`, `Why`, `Note`, `Link`, etc.) are displayed on each resource card. Links to files already in the catalog open directly in the note reader; external URLs open in a new tab.

The dashboard provides filter pills for **All**, **Next Up**, **Books**, **Podcasts**, **Videos**, and **Ideas**, plus live counts in the sidebar.

## Projects

The **Projects** view tracks projects and their tasks in SQLite. Change a project's status among Planned, Active, On hold, Completed, and Archived. Add tasks to a project and update each task as To do, In progress, Blocked, or Done. The initial projects are **Learn OS by implementing Stanford's PintOS**, **Build Zetesis**, and **Code an HTTP server**; you can edit or delete them and create your own.

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
