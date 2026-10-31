# Zetesis block editor redesign: implementation handoff

## Goal

Make note pages feel like an interactive Notion-style editor: the page the user sees is the page they edit; paragraphs, headings, callouts, lists, and media are structured blocks that can be inserted, formatted, and reordered. The browser editor model—not HTML or Markdown text—is the source of truth for the note body.

Keep Zetesis's local Python server, SQLite database, topic/search/project/following sections, note paths, and PDF viewer. This is a redesign of note content and editing, not a rewrite of the application.

## Current implementation

- `server.py` stores editable note bodies as one `notes.content` string. Imported `.md`/`.org` files are copied into SQLite once; the database is the app's source of truth and original files are left alone.
- `static/app.js:renderTextDocument` parses that string into HTML. The in-place editor uses `contentEditable`; `serializeEditedNote` then tries to reconstruct Markdown/Org from the mutated DOM. This parser/DOM/serializer round trip is the main constraint.
- `GET /api/document`, `POST/PUT /api/notes`, search, excerpts, and the backup endpoint all depend on the current string content. Updates already use a `version` check; preserve it.
- PDFs are separate note rows with `attachment_path`; `pdf_highlights.note_path` references the stable note path. Keep that behavior and those paths intact.
- The front end is plain JS/CSS served from `static/`; there is no build tool or npm manifest in Zetesis yet. The Python server uses only the standard library.

## Recommended design

Use Tiptap (ProseMirror) for the editor, bundled locally for Zetesis. Tiptap's JSON document becomes the active body format. Start with one JSON tree per note in SQLite rather than a separate database row for every block. Give blocks stable IDs so the editor can move and update them reliably. Add an explicit body-format/schema version separate from the existing `.md`/`.org` extension; extension remains useful as legacy/import metadata and for the `.pdf` distinction, but must no longer select the editor's content model.

Example shape (the actual schema should match the editor extensions):

```json
{
  "type": "doc",
  "content": [
    {"type": "heading", "attrs": {"id": "...", "level": 2}, "content": [{"type": "text", "text": "Term"}]},
    {"type": "callout", "attrs": {"id": "...", "kind": "definition"}, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Meaning of the term."}]}]},
    {"type": "image", "attrs": {"id": "...", "assetId": "...", "alt": ""}}
  ]
}
```

Store uploaded media as files with database metadata and reference them by asset ID; never store binary media in the JSON body. Keep PDFs that are already standalone Zetesis notes in the existing PDF viewer. A PDF/file block inside a text note can link to an uploaded or existing attachment.

Do not build realtime collaboration, sharing/permissions, or a Notion-style database block in this pass. The app is local and single-user; local editor state plus version-checked SQLite saves are sufficient.

## Implementation steps

### 1. Inventory and protect current data

1. Read the live `zetesis.sqlite3` schema and count text/PDF notes before making schema changes. Do not assume the original files are current; they are recovery copies, while SQLite is authoritative.
2. Make a backup using Zetesis's existing backup flow and confirm it contains the database and `notes/` assets. Do not move, rewrite, or delete original note files as part of this migration.
3. Inventory the real Org/Markdown constructs in `notes.content` and the current renderer: headings, inline emphasis/code, lists, links, local images, tables, quotes, code blocks, Org metadata/directives, drawers, and any other constructs in actual use. Define the conversion coverage from this inventory.
4. Keep standalone PDFs and their `pdf_highlights` rows out of the text-body migration. Preserve every current `notes.path` value because deep links and highlight foreign keys use it.

### 2. Add a locally bundled editor

1. Add a minimal frontend build setup (for example, Vite) and install Tiptap/ProseMirror packages. Commit the built local assets under `static/` so running `python3 zetesis/server.py` does not require Node or internet access.
2. Define and document a versioned editor schema. Initial block types: paragraph, headings, bulleted/numbered list, checklist, quote, definition/general callout, code, divider, table, image, file/PDF, and external embed. Initial inline marks: bold, italic, underline, strike, code, link, and text highlight.
3. Implement the page as the editable surface in its rendered form. Provide a slash/insert menu, selection toolbar for inline marks, and a block handle/menu for changing type, inserting, and drag-reordering blocks. Do not make users edit raw Markdown or expose an HTML source pane.
4. Keep existing reader actions that still apply (close/fullscreen where appropriate, title, move, delete). A PDF remains in its current dedicated viewer; its highlight behavior must not be replaced by text-note editing.
5. Replace the note-specific `contentEditable` setup, manual block syntax conversion, and `serializeEditedNote` flow with editor state and schema commands. Do not use the live DOM as the stored document model.

### 3. Version and validate the storage/API contract

1. Add nullable `body_json` and `body_format_version` columns to `notes` using an idempotent schema migration. Keep the existing `content` column untouched as the legacy Org/Markdown source snapshot during rollout; do not treat that snapshot as current after a structured edit.
2. Add a `search_text` (or equivalent derived plain-text) column. Derive it from validated editor JSON on the server whenever a body is created or updated; update `excerpt` from that text. Search must continue to match titles, paths, and note text.
3. Extend `GET /api/document` to return the body format/version and either structured JSON or legacy content. Extend create/update to accept a validated structured document, enforce the current request-size cap, update modified/excerpt/search fields, and increment/check `version` in the same transaction. Reject invalid JSON/schema versions with a useful error; do not silently save a partial tree.
4. Keep a legacy read path until migration completes. During rollout, a note with no `body_json` must still open through the existing reader and remain searchable. Once converted, `body_json` is canonical; never silently fall back to stale legacy text after an edit.
5. Update catalog document metadata only as needed. Do not send full editor JSON for every item in `/api/catalog`; load the body through `/api/document` as today.

### 4. Migrate legacy notes safely

1. Implement a deterministic converter from the inventoried Org/Markdown subset to the editor JSON schema. Reuse parsing knowledge from the existing renderer, but return structured nodes rather than generating HTML. Map internal links and local image paths without changing their targets.
2. Preserve unsupported or ambiguous Org/Markdown source visibly and losslessly (for example, a dedicated legacy/raw block or a per-note legacy fallback). Never drop directives, drawers, comments, or content simply because the new schema has no matching block.
3. Add a separate schema/data migration marker in `app_meta`; do not reuse `initial_import_complete`, which controls the original note import. Make the converter idempotent: only populate missing `body_json`, and never overwrite a body that a user has edited in the new editor.
4. Run conversion first against a copied database/backup. Report converted, skipped, and fallback note counts. Inspect representative `.org` and `.md` notes, including notes with images, links, tables, code, and uncommon Org syntax. Only then run the migration against the live database.
5. Keep legacy `content` snapshots through rollout so a conversion bug can be repaired without going back to user files. Do not delete these snapshots as part of the first release.

### 5. Add drag/drop and media storage

1. Add an `attachments` table with stable asset ID, generated storage path, original filename, MIME type, byte size, created time, and ownership/reference information. Store uploaded files in an app-managed directory that is not scanned as notes.
2. Add an upload endpoint that accepts file bytes, enforces size/type limits, generates filenames server-side, and rejects path traversal. Prefer a raw binary request with filename/MIME metadata over hand-parsing multipart bodies in the standard-library server.
3. Connect editor paste/drop events to the upload endpoint. Show a temporary upload state, then insert an image/file/embed block with the returned asset ID. Support external URL embeds separately from local uploads.
4. Serve assets by asset ID through a safe file endpoint. Update the backup endpoint to include the new asset directory and metadata. On permanent note deletion, remove only assets no longer referenced by another block/note; retain the existing shared-file protection for current `attachment_path` files.

### 6. Preserve surrounding Zetesis behavior

1. Update editor open/close, note selection, URL deep links, fullscreen, unsaved-change handling, and Ctrl/Cmd+S to use the editor instance and its JSON state.
2. Add debounced autosave with visible saving/saved/error status. Keep immediate local typing, the current optimistic version check, a retryable save error, and an explicit save shortcut. Avoid overwriting a newer server version on conflict.
3. Update note excerpts and search to use derived plain text from JSON. Ensure home suggestions and folder/topic counts continue using metadata only.
4. Leave roadmap, projects, following, note organization, and PDF highlights unchanged except where shared CSS/layout requires adjustments. Check that note callout styles do not leak into those sections.
5. Update backup and README documentation. The Python server remains the runtime entry point; document the one-time frontend build command for developers.

### 7. Completion criteria

- Existing notes and their paths remain present; original source files remain untouched; every old body is either converted or visibly preserved in a legacy fallback.
- Opening, typing, formatting, inserting a definition callout, creating/deleting/reordering blocks, and reopening the note retain the same structure and formatting.
- Dragging/pasting an image uploads it, embeds it at the cursor, survives reload and backup/restore, and is deleted only when no longer referenced.
- Search/excerpts work for structured notes; internal note links still open the right note; standalone PDFs still open and their saved highlights remain intact.
- A stale version conflict cannot overwrite newer content. Failed uploads/saves are visible and do not discard the editor's current content.
- A fresh start using only `python3 zetesis/server.py` serves the locally bundled editor without a network connection or Node installed.

## Suggested first release boundary

If implementation needs to be staged, deliver the schema/API migration plus paragraph, headings, lists, quote, definition callout, links, and local images first. Keep tables, video/audio embeds, block nesting, and advanced layout for a later pass. Do not ship a partial migration that makes old notes unreadable or switches the live database before the converter and fallback path are ready.

## Reference docs

- [Notion: The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion)
- [Tiptap editor concepts and JSON document model](https://tiptap.dev/docs/editor/core-concepts/introduction)
- [Tiptap file drop/paste handler](https://tiptap.dev/docs/editor/extensions/functionality/filehandler)
