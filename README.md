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

Imported Org and Markdown text is then converted into Zetesis' block format (see [Note format](#note-format)), which is what you edit.

## Features

- **Block editor**: A note page is the editing surface. Write paragraphs, headings, lists, checklists, quotes, definition and other callouts, code, tables, dividers, images, files, and embeds; format text inline; and reorder blocks by dragging. Changes save automatically.
- **Organize notes**: Topics and their folders are virtual locations managed by Zetesis (see [Organizing the sidebar](#organizing-the-sidebar)). Drag notes onto a folder to move them, or up and down in a folder's list to arrange them; the order is saved. New and moved notes start at the top.
- **Permanent deletion**: Zetesis asks for confirmation before permanently deleting a note and its app-managed copy or attachment.
- **Full-text search**: Search titles, note paths, and note content. `⌘ L` (or `⌘ K`) searches all your notes from anywhere in the app, along with Explore's areas and items, and finds **Explore**, **Roadmap** and **Following** by name. `⌘ F` searches the folder you're in, including its subfolders, or the folder of the open note; outside a folder it searches everything. In Zetesis, `⌘ F` replaces the browser's find-in-page, except in an open note, where it's the browser's find and searches the note's text. As you type, the top result is selected; `⌃ N`/`⌃ P` (or `↓`/`↑`) move through the results and Enter opens one. Press `?` for all the [keyboard shortcuts](#keyboard).
- **PDF reader**: PDFs open in a dedicated viewer where you can save highlights.
- **Explore**: A simple list of the areas you want to explore, like Mathematics or Operating Systems, each with a checklist of things to read, watch, or try.
- **Roadmap**: A map of boxes of text joined by arrows, like a mind map, for thinking through where you're headed; see [Roadmap](#roadmap).
- **Following**: A note of your own for the sites, people, and channels you follow, written and organized however you like.
- **Export backup**: Download a ZIP containing the SQLite database, the original notes tree, and files added to notes (bottom of the sidebar).
- **Automatic Dark Mode**: Seamlessly matches your macOS light/dark appearance preference.

## Writing Notes

Open a note and start typing; the title is the large heading at the top. Type `/` to insert a block (text, headings, lists, checklist, quote, definition, callout, code, divider, table, image, file, a PDF already in Zetesis, or an embedded link). Move the pointer into the margin left of a block to show its handle (it stays out of the way while the pointer is over text): `+` adds a block below, and `⋮⋮` opens a menu (turn into another type, duplicate, move, delete) or reorders the block when dragged.

Sections fold: hover over a heading and click the arrow to its left to hide everything under it, up to the next heading of the same or a higher level (a folded heading ends in "…"); click it again to unfold. Zetesis remembers which sections of each note you left folded, in this browser (`localStorage`); folding never changes or saves the note. Folded text stays findable: `⌘ F` finds it and opens its section. Nothing disappears into a fold: typing, Enter on a folded heading, or moving a block into a folded section opens it, and the arrow keys step over folded sections. Dragging a folded heading, or **Move up**/**Move down** in its menu, moves the whole section.

A note with two or more headings has an **outline** in the margin to its left: its headings as a tree, with the section you're reading marked as you scroll. Click a heading to jump to it; one inside a folded section (shown dimmed) unfolds on the way. The outline button next to ← hides or shows it for every note (remembered in this browser). In a window narrower than 900px the outline stays hidden.

Select text to bold, italicize, underline, strike, highlight, mark as code, or link it. `⌘ K` with text selected adds a link: paste a URL or type to search your notes. Links to notes open in Zetesis. Markdown-style shortcuts also work as you type (`#`, `-`, `1.`, `[ ]`, or `>` followed by a space, and ```` ``` ```` for code).

A YouTube, Vimeo or Instagram link (a post or a reel) in a note has a ▶ after it: click it to watch the video in the note, and click **Show as link** on the player to go back to the link. A line that is only the link becomes the player; a link inside a sentence keeps its place and gets its player below the line (click the ▶ again to hide it). A player shown as a link and back keeps the size you gave it. YouTube playlist links play the playlist. YouTube refuses some videos (music, mostly) inside a page at a bare IP address like `127.0.0.1`, so there its players load through `static/player.html` at `localhost`, the same server under a name YouTube accepts.

**New note** can also start from a file: choose one in the dialog (or drop it on the dialog). A PDF becomes a PDF note (up to 200 MB) that opens in the PDF reader, even when its name has lost the `.pdf` (Zetesis checks the file's first bytes); a Markdown, Org, or text file (up to 5 MB) becomes a note with its text, ready to edit; any other file becomes a note holding it (up to 25 MB). Uploaded PDFs are kept in `zetesis/notes/uploaded-files/`.

Paste or drop images and files into a note to upload them (up to 25 MB; images, PDFs, text, Office, audio, and video files). Uploads are stored in `zetesis/assets/`, not in the note itself. To resize an image or a video player, hover over it and drag the handle on its right edge; double-click the handle to return to the original size (a YouTube or Vimeo player's is the full width; an Instagram post's is 400px, and it goes up to 540px, the widest Instagram draws it).

Notes save automatically a moment after you stop typing; the status beside the note's actions shows *Saving…*, *Saved*, or an error with **Retry**. `⌘ S` saves immediately. If the same note was changed elsewhere (another tab, for example), Zetesis does not overwrite it: it shows *Changed elsewhere* and lets you reload the latest version.

## Note Format

Each text note's body is stored in SQLite as one JSON document from the editor (`notes.body_json`), with its format version in `notes.body_format_version`. Version 1 has these blocks: paragraph, heading (1–6), bulleted, numbered, and checklist items (nestable), quote, callout (`note`, `definition`, `tip`, `warning`), code, preserved source, divider, table, image, file, and embed; and these inline marks: bold, italic, underline, strike, code, link, and highlight. Every block has a stable `id`. An embed can carry a `label`, the words of the link it was shown from. Images and files refer to uploads by asset ID (`attachments` table) or to an existing notes file by path; media bytes never go in the JSON.

`frontend/src/schema.js` defines the format for the editor and `blocks.py` validates it on the server; change both together and bump the version. The server rejects invalid documents rather than saving part of one, and derives each note's search text and excerpt from the document.

### Legacy Org and Markdown notes

Converting imported notes keeps the original text: `notes.content` is left untouched as a recovery snapshot, and the files in `notes/` are never modified. Anything the converter cannot map to a block (for example `#+STARTUP` lines or drawers) appears in the note as a gray *Org source* or *Markdown source* block instead of being dropped. A note whose conversion fails stays readable in the original Org/Markdown reader, with a button to try converting it again.

The server converts unconverted notes when it starts. To preview or rerun the conversion:

```sh
python3 zetesis/server.py --migrate-bodies --dry-run   # report only; converts a temporary copy
python3 zetesis/server.py --migrate-bodies             # convert notes that have no block body
python3 zetesis/server.py --migrate-bodies --reconvert # also redo converted notes you have not edited
```

Notes edited in the block editor are never reconverted. Add `--database PATH` to work on another copy of the database.

## Organizing the Sidebar

Right-click in the sidebar for what you can do there:

- On a topic or folder: **New note** (created there and opened), **New note from a file…** (the same, starting from a file you pick), **New folder** (inside it), **Rename**, and **Delete**. Only empty folders can be deleted; the menu shows how many notes are still inside. The Inbox can't be deleted or moved into another folder.
- On empty space or the **Topics** heading: **New topic**, **Expand all**, and **Collapse all**.

Double-click a folder to rename it. Drag a folder to rearrange the sidebar: drop it on the top or bottom edge of another folder to place it before or after, on the middle to put it inside (a closed folder opens if you hold it there), or below the last topic to make it a topic. A folder's notes and subfolders go with it. Folders can be empty, and keep the order you give them.

The **⋯** button beside a folder's title has the same actions, and right-clicking a note in the list opens or deletes it.

## Explore

**Explore** lists your areas, one per line. Type in **New area** and press Enter to add one; drag areas to reorder them; right-click one to rename or delete it. Open an area to see its items, again one per line:

Lists work like Ergon's tasks:

- The cursor starts in the box at the bottom. Type and press Enter to add an item; the box wraps long text the way the item will show it, and stays ready for the next one. Pasted text comes in as one line.
- Click anywhere on an item to edit it, with the cursor where you clicked. Enter saves (or, with nothing changed, checks the item off), Escape cancels, and clearing it deletes it.
- Check an item off and it moves to **done** at the bottom; uncheck it to bring it back.
- Drag items to reorder them. Right-click an item to edit it, check it off, move it to a section or another area, or delete it.
- To link part of an item, click it, select the words (double-click selects one), and paste a web address: they become a link. Pasting over a link changes where it goes. This works in **Add item** too, and `⌘ Z` undoes it. A pasted address with nothing selected goes in as is and shows as a link.
- Links stay links while you edit. They're stored in the text as `[[https://example.com][words]]`; `[[file:path/to/note][words]]` links a note in Zetesis, which opens in the reader.
- From the keyboard: `⌃ N`/`⌃ P` (or `↑` from the box, then `↓`/`↑`, `j`/`k`) select an item; Enter checks it off; `e` edits it; `⌥ ↑`/`⌥ ↓` move it; `⌫` deletes it; `n` returns to the box. While editing, `⌃ N`/`⌃ P` save and move on. Escape clears the box, or, when it's empty, goes back: from an area to Explore, and from Explore to search.

### Sections

Group an area's items into sections, such as **Transformers** under Machine Learning, and sections into sections (up to 5 deep). An area shows its own items first, then its sections, each with its items, its own **Add item** box, the sections inside it, and what's done in it.

- **Make one**: type `# Transformers` in an **Add item** box and press Enter. The box shows it in bold before you do. In an area's box, it makes a section in the area; in a section's box, a section inside that one. Or use **New section** in the **⋯** menu or on right-clicking beside the lines; **New section inside** on right-clicking a section; or **Move to › New section…** on right-clicking an item, which makes the section with that item in it.
- **Fill it**: drag an item onto a section's heading (it goes first in the section), between items in it, or onto its **Add item** box (it goes last); or right-click the item and pick the section under **Move to**.
- **Open and close it**: click its heading, or select it and press Enter. Each heading shows how many items are left in it, sections inside included. Zetesis remembers which are closed on this computer.
- **Arrange it**: drag a heading onto another's top or bottom edge to put it before or after, or onto its middle to put it inside. `⌥ ↑`/`⌥ ↓` move a selected section past the one beside it. Right-click a heading to rename it (or select it and press `e`), move it, or delete it with what's in it (**Undo** puts it back).
- With an item or heading selected, `n` goes to that section's **Add item** box.

Two sections in one place can't share a name, and a section's name can't start with `TODO`, `DONE`, `NEXT`, `IDEA`, `READING`, or `IN_PROGRESS`, or end in an Org `:tag:`; the outline would read it back as an item.

Search (`⌘ L`) finds areas and sections by name and items by their words, showing where each is (`Explore / Machine Learning / Transformers`). Opening one shows its area with it selected, opening the sections around it. The **⋯** button beside an area's title adds a section, or renames or deletes the area. Deleting an item, section, or area shows **Undo** for a few seconds.

Explore is stored in SQLite as an Org outline, `* Area` headings with `** TODO item` or `** DONE item` under them, and written to `notes/roadmap.org` when it changes. A section is a plain heading one level below its area or section, with its items and sections one level below it:

```org
* Machine Learning
** TODO Probabilistic graphical models
** Transformers
*** TODO Attention Is All You Need
*** Implementations
**** TODO nanoGPT
```

Outlines from earlier versions still load: their tagged headings and detail bullets read as plain items, and a `Link:` detail becomes a link on the item. The outline as it was before Explore was simplified is kept in the database's `app_meta` table under `roadmap_content_before_simple`.

## Roadmap

**Roadmap** in the sidebar is a space you can move around in, where you write boxes of text and join them with arrows, like a mind map.

- **Add a box** by double-clicking anywhere, or pressing `n`. Type, then press `Enter`; `⇧ Enter` starts a new line. `Esc` throws a new box away.
- **Join boxes** by dragging from the dot on a box's right edge onto another box. Let go on empty space instead, and a new box starts there, already joined. With a box selected, `Tab` adds a box joined to it, to its right; `Tab` while writing does the same, so a chain of ideas can be typed out in one go. Two boxes are joined once, whichever way the arrow points.
- **Edit** by double-clicking a box, clicking the selected box, or pressing `Enter` (or `e`). Clicking away saves; `Esc` puts the text back. Emptying a box deletes it.
- **Move** a box by dragging it; its arrows follow.
- **Notes**: right-click a box (or `⌃`-click it) to open its note, a large card over most of the map, and write more about it. It saves as you type; `Enter` starts a new line. `Esc`, `⌘ Enter`, its `×`, or a click on the map closes it.
- **Delete** a box or an arrow by clicking it and pressing `⌫`, with Undo in the message that follows. Deleting a box takes its arrows with it, and Undo brings them back.
- **Move around** by dragging empty space, or scrolling with two fingers; pinch to zoom, or use `−` and `+` at the top. **Show All** fits every box on screen. Each browser, and the Mac app, remembers where you were.
- **Find boxes** with `⌘ F`: the boxes that don't match what you type, in their text or notes, are dimmed. `Esc` puts the find box away.

Boxes and arrows are kept in the database (tables `map_boxes` and `map_arrows`), so Export backup includes them. Deleted ones are kept for 30 days, for Undo, then removed when the server starts.

## Following

**Following** in the sidebar opens a single note, written in the block editor like any other, for keeping track of what you follow however you like. It opens over whatever is on screen; close it to go back. It isn't listed under a topic, but search finds it. If you delete it, clicking **Following** starts a new, empty one.

It began with the links Following used to list (they stay in the database's `followed_content` table too). It's kept in a topic of its own, `following`, which the sidebar shows only as this entry.

## Keyboard

Press `?` (or **Shortcuts** at the bottom of the sidebar) for the list.

| Keys | Does |
|---|---|
| `⌘ L` (or `⌘ K`) | Search all notes |
| `⌘ F` | Search the folder you're in. In an open note, find text in the note; in Roadmap, find boxes |
| `⌃ N` `⌃ P` (or `↓` `↑`) | Next or previous search result, note, or item; also in menus, including the editor's `/` menu |
| Enter | Open the selection, check an item off, or save an edit |
| Escape | Go back a level: an Explore area to Explore, a folder to the folder above it, and Explore or a topic to search. It first cancels an edit or clears a search or add box; in an open note, it only closes the note |
| `e` | Edit or rename the selection |
| `⌥ ↑` `⌥ ↓` | Move the selected item (Explore) |
| `⌫` | Delete the selected item (Explore), or the selected box or arrow (Roadmap) |
| `n` | Back to the add box (Explore), or add a box (Roadmap) |
| `Tab` | Add a box joined to the selected one (Roadmap) |
| `⌘ S` | Save the open note now |

## Start the App

From the workspace root:

```sh
python3 zetesis/server.py
```

Then open <http://127.0.0.1:8000> in your browser, or in Zetesis's own app (see [The Mac app](#the-mac-app)). You can also install it from the browser, with the install button in the address bar, for a window and Dock icon of its own (the green ζ). The icon comes from `static/manifest.webmanifest`; `static/icon-192.png` and `static/icon-512.png` are drawn from `static/favicon.svg`, so keep them in step if the favicon changes.

To stop the server, press `Ctrl+C`. To choose a custom port:

```sh
python3 zetesis/server.py --port 8080
```

The server needs only Python's standard library, and everything it serves, including the editor, is in `static/`; no Node.js or internet connection is needed to run Zetesis. (PDFs are rendered with PDF.js from a CDN.)

### Start automatically (macOS)

Instead of running the server yourself, let macOS start it whenever Zetesis is opened (in the browser or as a web app). Stop any server you started by hand, then run once:

```sh
python3 zetesis/server.py --install-launch-agent
```

macOS's `launchd` then listens on `127.0.0.1:8000` and starts the server on the first connection. Open Zetesis windows check in every minute. The server stops itself about 20 seconds after the last window closes, or after 2½ minutes if a window disappears without closing (a crash, for example). The next visit starts it again. The log is in `~/Library/Logs/Zetesis/server.log`. Run the command again after moving Zetesis or upgrading Python. Use `--port` to choose another port. To go back to starting it by hand:

```sh
python3 zetesis/server.py --uninstall-launch-agent
```

### The Mac app

To give Zetesis an app of its own, run once:

```sh
python3 zetesis/server.py --install-mac-app
```

It builds `Zetesis.app` into `~/Applications` with Apple's command line tools (`xcode-select --install`). It is Zetesis in a window of its own, with Zetesis's menus instead of a browser's, and works with the launch agent above, which starts the server when the app opens.

- **Leaving a note:** quitting, or **View › Reload** (`⌘ R`), saves the open note first. If something still can't be saved, it asks before going on, as a browser does.
- **Finding text:** `⌘ F` in an open note opens a find bar. `⌘ G` and `⇧ ⌘ G` move between matches, and `⌘ E` finds the selected text.
- **Edit menu:** it has spelling, grammar and substitutions (smart quotes and dashes) for writing.
- **Text size:** it starts a little larger than in a browser. **View › Zoom In** and **Zoom Out** (`⌘ +`, `⌘ −`) change it, and it stays as you leave it.
- **Files and links:** **Start from a file…**, and adding an image or file to a note, show the Mac's Open panel. **Export backup** saves to Downloads. A file in a note opens in its own app, as from the Finder. Links to other sites open in the browser.
- **Closing:** closing the window leaves the app in the Dock, as Notes does.

Run the command again only if `mac/main.swift` changes; changes to the rest of Zetesis need only `⌘ R`. To remove the app:

```sh
python3 zetesis/server.py --uninstall-mac-app
```

## Backup and Restore

**Export backup** downloads a ZIP with `zetesis.sqlite3`, `notes/`, and `assets/`. To restore, stop the server and extract the ZIP into the `zetesis/` folder, replacing those three.

## Developing the Editor

The editor is built from `frontend/` with Tiptap and Vite, and the built file `static/editor/zetesis-editor.js` is committed. After changing anything in `frontend/src/`, rebuild it (requires Node.js 22 or later):

```sh
cd zetesis/frontend
npm install
npm run build
npm run check-docs -- ../zetesis.sqlite3   # optional: check stored notes against the editor schema
```
