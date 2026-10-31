#!/usr/bin/env python3
"""Zetesis (ζήτησις) — Local, SQLite-backed note inquiry & browser.

Imports existing notes from zetesis/notes/ and manages them in SQLite:
- Cooking
- Computer Science (algorithms, architecture, c++, cloud, compilers, etc.)
- Knowledge (economics, geopolitics, history, investing, worldview)
- Poker
- Thoughts
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import math
import mimetypes
import os
import re
import sqlite3
import tempfile
import uuid
import zipfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

APP_DIR = Path(__file__).resolve().parent
NOTES_DIR = APP_DIR / "notes"
STATIC = APP_DIR / "static"
DB_PATH = APP_DIR / "zetesis.sqlite3"

NOTE_EXTENSIONS = {".md", ".org", ".pdf"}
TEXT_EXTENSIONS = {".md", ".org"}
PROJECT_STATUSES = {"planned", "active", "on_hold", "completed", "archived"}
TASK_STATUSES = {"todo", "in_progress", "blocked", "done"}
FOLLOWING_TYPES = {"site", "blog", "youtube", "podcast", "article", "other"}
SCAN_EXCLUDED_SUBDIRS = {".git", "ltximg", "org-imgs", "__pycache__"}
SECURITY_EXCLUDED = {".git", "__pycache__"}
MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

TRACKED_COLLECTIONS = {
    "cs": "Computer Science",    
    "knowledge": "Knowledge",
    "thoughts": "Thoughts",
    "cooking": "Cooking",
    "life": "Life",
    "poker": "Poker",
}

ROADMAP_FILE = NOTES_DIR / "roadmap.org"


def _parse_roadmap(content: str | None = None) -> dict:
    if content is None:
        content = _get_setting("roadmap_content", "")
    if not content:
        return {"topics": [], "counts": {"all": 0, "book": 0, "podcast": 0, "video": 0, "idea": 0, "next": 0}}
    lines = content.splitlines()

    topics = []
    current_topic = None
    current_subtopic = ""
    current_item = None
    counts = {"all": 0, "book": 0, "podcast": 0, "video": 0, "idea": 0, "next": 0}

    for line in lines:
        line_str = line.strip()
        if not line_str or line_str.startswith("#+"):
            continue

        m_top = re.match(r"^\*\s+([^:*]+?)\s*(?::([a-zA-Z0-9_:]+):)?\s*$", line)
        if m_top:
            topic_name = m_top.group(1).strip()
            current_topic = {"name": topic_name, "items": []}
            topics.append(current_topic)
            current_subtopic = ""
            current_item = None
            continue

        m_head = re.match(r"^(\*{2,6})\s+(.+)$", line)
        if m_head:
            heading_level = len(m_head.group(1))
            heading_text = m_head.group(2).strip()
            tag_match = re.search(r":([a-zA-Z0-9_]+):\s*$", heading_text)
            item_type = ""
            if tag_match:
                item_type = tag_match.group(1).lower()
                heading_text = heading_text[:tag_match.start()].strip()

            status_match = re.match(r"^(NEXT|TODO|IDEA|DONE|READING|IN_PROGRESS)\s+(.+)$", heading_text, re.I)
            if status_match:
                status = status_match.group(1).upper()
                title = status_match.group(2).strip()
                if not item_type and status == "IDEA":
                    item_type = "idea"
            else:
                status = "TODO" if item_type else ""
                title = heading_text

            if item_type or status in {"NEXT", "TODO", "IDEA", "DONE", "READING", "IN_PROGRESS"}:
                if not item_type:
                    item_type = "idea" if status == "IDEA" else "book"

                # Resources directly under a topic have no subtopic. In
                # particular, clear a previous subtopic when a level-two
                # resource follows a grouped section.
                item_subtopic = current_subtopic if heading_level > 2 else ""
                if heading_level == 2:
                    current_subtopic = ""

                counts["all"] += 1
                counts[item_type] = counts.get(item_type, 0) + 1
                if status == "NEXT":
                    counts["next"] += 1

                current_item = {
                    "title": title,
                    "type": item_type,
                    "status": status,
                    "subtopic": item_subtopic,
                    "details": {},
                    "notes": [],
                }
                if current_topic is None:
                    current_topic = {"name": "General", "items": []}
                    topics.append(current_topic)
                current_topic["items"].append(current_item)
            else:
                current_subtopic = heading_text
                current_item = None
            continue

        m_bullet = re.match(r"^\s*-\s+([^:]+?)\s*:\s*(.+)$", line)
        if m_bullet and current_item:
            k = m_bullet.group(1).strip().lower()
            v = m_bullet.group(2).strip()
            current_item["details"][k] = v
            continue
        elif current_item and re.match(r"^\s*-\s+(.+)$", line):
            text_note = re.match(r"^\s*-\s+(.+)$", line).group(1).strip()
            current_item["notes"].append(text_note)

    return {"topics": topics, "counts": counts}


def _read_text(path: Path) -> str:
    with path.open("rb") as source:
        data = source.read(MAX_DOCUMENT_BYTES + 1)
    return data[:MAX_DOCUMENT_BYTES].decode("utf-8", errors="replace")


def _fallback_title(path: Path) -> str:
    title = path.stem.replace("_", " ").replace("-", " ").strip()
    return title[:1].upper() + title[1:] if title else path.name


def _extract_title(path: Path, content: str) -> str:
    if path.suffix.lower() == ".pdf":
        return _fallback_title(path)
    if path.suffix.lower() == ".org":
        match = re.search(r"^\s*#\+title:\s*(.*?)\s*$", content, re.I | re.M)
        if match and match.group(1):
            return match.group(1).strip()
    for line in content.splitlines()[:30]:
        match = re.match(r"^\s{0,3}#\s+(.+?)\s*#*\s*$", line)
        if match:
            return match.group(1).strip()
    return _fallback_title(path)


def _excerpt(content: str) -> str:
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith(("#+", "<!--", "```", "* ", "|")):
            continue
        line = re.sub(r"\s+", " ", line)
        if len(line) > 150:
            return line[:147].rstrip() + "…"
        return line
    return ""


def _iter_document_paths():
    for collection in TRACKED_COLLECTIONS:
        root = NOTES_DIR / collection
        if not root.is_dir():
            continue
        for current, directories, files in os.walk(root):
            directories[:] = sorted(
                d for d in directories
                if not d.startswith(".") and d not in SCAN_EXCLUDED_SUBDIRS
            )
            for filename in sorted(files):
                if filename.startswith("."):
                    continue
                path = Path(current) / filename
                if path.suffix.lower() in NOTE_EXTENSIONS:
                    yield path


def _document_for(path: Path) -> tuple[dict, str]:
    relative = path.relative_to(NOTES_DIR).as_posix()
    stat = path.stat()
    content = path.read_text(encoding="utf-8", errors="replace") if path.suffix.lower() in TEXT_EXTENSIONS else ""
    folder = path.parent.relative_to(NOTES_DIR).as_posix()
    collection = relative.split("/", 1)[0]

    document = {
        "path": relative,
        "collection": collection,
        "folder": folder,
        "title": _extract_title(path, content),
        "extension": path.suffix.lower(),
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "excerpt": _excerpt(content),
    }
    return document, content


def _all_documents() -> list[tuple[dict, str]]:
    return [_document_for(path) for path in _iter_document_paths()]


def _is_in_folder(document: dict, folder: str) -> bool:
    if not folder:
        return True
    doc_folder = document["folder"]
    return doc_folder == folder or doc_folder.startswith(folder.rstrip("/") + "/")


def _safe_note_file(relative: str) -> Path | None:
    """Ensure requested file resolves strictly within NOTES_DIR."""
    if not relative or "\\" in relative:
        return None
    try:
        candidate = (NOTES_DIR / relative).resolve()
        notes_root = NOTES_DIR.resolve()
        if not candidate.is_relative_to(notes_root) or not candidate.is_file():
            return None
        rel_parts = candidate.relative_to(notes_root).parts
        for part in rel_parts:
            if part in SECURITY_EXCLUDED or part.startswith("."):
                return None
        return candidate
    except Exception:
        return None


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


@contextmanager
def _database():
    connection = _connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _get_setting(key: str, default: str = "") -> str:
    with _database() as connection:
        row = connection.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else default


def _set_setting(connection: sqlite3.Connection, key: str, value: str) -> None:
    connection.execute(
        "INSERT INTO app_meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def initialize_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _database() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS collections (
                key TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS notes (
                path TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                extension TEXT NOT NULL,
                content TEXT,
                attachment_path TEXT,
                collection TEXT NOT NULL,
                folder TEXT NOT NULL,
                created TEXT NOT NULL,
                modified TEXT NOT NULL,
                excerpt TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1,
                deleted_at TEXT
            );
            CREATE TABLE IF NOT EXISTS pdf_highlights (
                id TEXT PRIMARY KEY,
                note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
                page_number INTEGER NOT NULL,
                quote TEXT NOT NULL DEFAULT '',
                rects TEXT NOT NULL,
                created TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS pdf_highlights_note_page
                ON pdf_highlights(note_path, page_number, created);
            CREATE INDEX IF NOT EXISTS notes_collection_folder
                ON notes(collection, folder, deleted_at);
            CREATE INDEX IF NOT EXISTS notes_modified ON notes(modified);
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'planned',
                created TEXT NOT NULL,
                modified TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS project_tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'todo',
                created TEXT NOT NULL,
                modified TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS project_tasks_project
                ON project_tasks(project_id, sort_order, created);
            CREATE TABLE IF NOT EXISTS followed_content (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'other',
                description TEXT NOT NULL DEFAULT '',
                created TEXT NOT NULL,
                modified TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS followed_content_order
                ON followed_content(sort_order, title COLLATE NOCASE);
        """)

        # Older versions kept deleted notes in Trash. Preserve those notes by
        # making them visible again now that deletion is permanent.
        connection.execute("UPDATE notes SET deleted_at = NULL WHERE deleted_at IS NOT NULL")

        for sort_order, (key, label) in enumerate(TRACKED_COLLECTIONS.items()):
            connection.execute(
                "INSERT OR IGNORE INTO collections(key, label, sort_order) VALUES(?, ?, ?)",
                (key, label.strip(), sort_order),
            )
        connection.execute(
            "INSERT OR IGNORE INTO collections(key, label, sort_order) VALUES('inbox', 'Inbox', 999)",
        )

        seeded_projects = connection.execute(
            "SELECT value FROM app_meta WHERE key = 'initial_projects_seeded'"
        ).fetchone()
        if not seeded_projects:
            now = datetime.now().astimezone().isoformat(timespec="seconds")
            examples = [
                ("Learn OS by implementing Stanford's PintOS",
                 "Learn operating-systems concepts by implementing Stanford's PintOS teaching OS.",
                 "planned"),
                ("Build Zetesis",
                 "Develop Zetesis into a personal notes and knowledge-management app.",
                 "active"),
                ("Code an HTTP server",
                 "Build an HTTP server and learn how requests, responses, and connections work.",
                 "planned"),
            ]
            for sort_order, (title, description, status) in enumerate(examples):
                connection.execute(
                    """INSERT INTO projects(id, title, description, status, created, modified, sort_order)
                       VALUES(?, ?, ?, ?, ?, ?, ?)""",
                    (uuid.uuid4().hex, title, description, status, now, now, sort_order),
                )
            _set_setting(connection, "initial_projects_seeded", "1")

        seeded_following = connection.execute(
            "SELECT value FROM app_meta WHERE key = 'initial_following_seeded'"
        ).fetchone()
        if not seeded_following:
            now = datetime.now().astimezone().isoformat(timespec="seconds")
            connection.execute(
                """INSERT INTO followed_content(id, title, url, kind, description, created, modified, sort_order)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
                (uuid.uuid4().hex, "Hacker News", "https://news.ycombinator.com/", "site",
                 "", now, now, 0),
            )
            _set_setting(connection, "initial_following_seeded", "1")

        imported = connection.execute(
            "SELECT value FROM app_meta WHERE key = 'initial_import_complete'"
        ).fetchone()
        if imported:
            return

        # The database becomes the app's source of truth. Copy existing text into
        # it once; retain the source files as an untouched recovery/export copy.
        for path in _iter_document_paths():
            relative = path.relative_to(NOTES_DIR).as_posix()
            extension = path.suffix.lower()
            stat = path.stat()
            modified = datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(timespec="seconds")
            collection = relative.split("/", 1)[0]
            folder = path.parent.relative_to(NOTES_DIR).as_posix()
            if extension in TEXT_EXTENSIONS:
                content = path.read_text(encoding="utf-8", errors="replace")
                title = _extract_title(path, content)
                excerpt = _excerpt(content)
                attachment_path = None
            else:
                content = None
                title = _fallback_title(path)
                excerpt = ""
                attachment_path = relative
            connection.execute(
                """INSERT OR IGNORE INTO notes
                   (path, title, extension, content, attachment_path, collection, folder,
                    created, modified, excerpt)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (relative, title, extension, content, attachment_path, collection, folder,
                 modified, modified, excerpt),
            )

        if ROADMAP_FILE.is_file():
            _set_setting(connection, "roadmap_content", ROADMAP_FILE.read_text(encoding="utf-8", errors="replace"))
        _set_setting(connection, "initial_import_complete", "1")


def _collections(connection: sqlite3.Connection | None = None) -> dict[str, str]:
    if connection is None:
        with _database() as owned:
            return _collections(owned)
    rows = connection.execute("SELECT key, label FROM collections ORDER BY sort_order, label COLLATE NOCASE").fetchall()
    return {str(row["key"]): str(row["label"]) for row in rows}


def _row_to_document(row: sqlite3.Row) -> dict:
    content = row["content"] or ""
    if not isinstance(content, str):
        content = bytes(content).decode("utf-8", errors="replace")
    size = len(content.encode("utf-8")) if content else 0
    attachment = row["attachment_path"]
    if attachment:
        attachment_file = _safe_note_file(str(attachment))
        if attachment_file:
            size = attachment_file.stat().st_size
    return {
        "path": str(row["path"]),
        "collection": str(row["collection"]),
        "folder": str(row["folder"]),
        "title": str(row["title"]),
        "extension": str(row["extension"]),
        "size": size,
        "modified": str(row["modified"]),
        "excerpt": str(row["excerpt"] or ""),
        "version": int(row["version"]),
    }


def _note_row(connection: sqlite3.Connection, path: str):
    return connection.execute("SELECT * FROM notes WHERE path = ?", (path,)).fetchone()


def _document_rows() -> list[sqlite3.Row]:
    with _database() as connection:
        query = "SELECT * FROM notes ORDER BY title COLLATE NOCASE, path COLLATE NOCASE"
        return connection.execute(query).fetchall()


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug or "topic"


def _clean_location(collection: str, folder: str) -> tuple[str, str] | None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", collection):
        return None
    parts = [part for part in folder.strip("/").split("/") if part]
    if not parts or parts[0] != collection or any(part in {".", ".."} for part in parts):
        return collection, collection
    return collection, "/".join(parts)


def _read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    raw_length = handler.headers.get("Content-Length", "0")
    try:
        length = int(raw_length)
    except ValueError as error:
        raise ValueError("Invalid request length.") from error
    if length < 0 or length > 20 * 1024 * 1024:
        raise OverflowError("Request is too large (maximum 20 MB).")
    try:
        payload = json.loads(handler.rfile.read(length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Request body must be valid JSON.") from error
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    return payload


class ZetesisHandler(BaseHTTPRequestHandler):
    server_version = "Zetesis/1.0"

    def _send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _send_json(self, value, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status)

    def _error(self, message: str, status: int = 400) -> None:
        self._send_json({"error": message}, status)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)

        if parsed.path in {"/", "/index.html"}:
            self._serve_static("index.html")
        elif parsed.path == "/favicon.ico":
            self._serve_static("favicon.svg")
        elif parsed.path.startswith("/static/"):
            self._serve_static(unquote(parsed.path.removeprefix("/static/")))
        elif parsed.path == "/api/catalog":
            self._catalog()
        elif parsed.path == "/api/roadmap":
            self._send_json(_parse_roadmap())
        elif parsed.path == "/api/roadmap/source":
            self._send_json({"content": _get_setting("roadmap_content", "")})
        elif parsed.path == "/api/projects":
            self._projects()
        elif parsed.path == "/api/following":
            self._following()
        elif parsed.path == "/api/search":
            self._search(params)
        elif parsed.path == "/api/document":
            self._document(params)
        elif parsed.path == "/api/pdf-highlights":
            self._pdf_highlights(params.get("path", [""])[0])
        elif parsed.path == "/api/file":
            self._file(params)
        elif parsed.path == "/api/backup":
            self._backup()
        else:
            self._error("Not found", 404)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)
        try:
            payload = _read_json_body(self)
        except OverflowError as error:
            self._error(str(error), 413)
            return
        except ValueError as error:
            self._error(str(error), 400)
            return

        if parsed.path == "/api/notes":
            self._create_note(payload)
        elif parsed.path == "/api/topics":
            self._create_topic(payload)
        elif parsed.path == "/api/projects":
            self._create_project(payload)
        elif parsed.path == "/api/following":
            self._create_followed_content(payload)
        elif parsed.path == "/api/project-tasks":
            self._create_project_task(payload)
        elif parsed.path == "/api/pdf-highlights":
            self._create_pdf_highlight(params.get("path", [""])[0], payload)
        else:
            self._error("Not found", 404)

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)
        try:
            payload = _read_json_body(self)
        except OverflowError as error:
            self._error(str(error), 413)
            return
        except ValueError as error:
            self._error(str(error), 400)
            return

        if parsed.path == "/api/notes":
            self._update_note(params.get("path", [""])[0], payload)
        elif parsed.path == "/api/roadmap":
            content = payload.get("content")
            if not isinstance(content, str):
                self._error("Roadmap content must be text.")
                return
            with _database() as connection:
                _set_setting(connection, "roadmap_content", content)
            try:
                ROADMAP_FILE.write_text(content, encoding="utf-8")
            except OSError:
                pass
            self._send_json(_parse_roadmap(content))
        elif parsed.path == "/api/projects":
            self._update_project(params.get("id", [""])[0], payload)
        elif parsed.path == "/api/following":
            self._update_followed_content(params.get("id", [""])[0], payload)
        else:
            self._error("Not found", 404)

    def do_PATCH(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        try:
            payload = _read_json_body(self)
        except OverflowError as error:
            self._error(str(error), 413)
            return
        except ValueError as error:
            self._error(str(error), 400)
            return
        if parsed.path == "/api/notes/location":
            self._move_note(payload)
        elif parsed.path == "/api/project-tasks":
            self._update_project_task(parse_qs(parsed.query).get("id", [""])[0], payload)
        else:
            self._error("Not found", 404)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)
        if parsed.path == "/api/notes":
            self._delete_note(params.get("path", [""])[0])
        elif parsed.path == "/api/projects":
            self._delete_project(params.get("id", [""])[0])
        elif parsed.path == "/api/following":
            self._delete_followed_content(params.get("id", [""])[0])
        elif parsed.path == "/api/project-tasks":
            self._delete_project_task(params.get("id", [""])[0])
        elif parsed.path == "/api/pdf-highlights":
            self._delete_pdf_highlight(params.get("path", [""])[0], params.get("id", [""])[0])
        else:
            self._error("Not found", 404)

    def _serve_static(self, name: str) -> None:
        candidate = (STATIC / name).resolve()
        static_root = STATIC.resolve()
        if not candidate.is_relative_to(static_root) or not candidate.is_file():
            self._error("Not found", 404)
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self._send_bytes(candidate.read_bytes(), content_type)

    def _catalog(self) -> None:
        with _database() as connection:
            query = "SELECT * FROM notes ORDER BY title COLLATE NOCASE, path COLLATE NOCASE"
            rows = connection.execute(query).fetchall()
            collections = _collections(connection)
        documents = [_row_to_document(row) for row in rows]
        counts = {key: 0 for key in collections}
        for document in documents:
            if document["collection"] in counts:
                counts[document["collection"]] += 1

        self._send_json({"documents": documents, "collections": collections, "counts": counts})

    def _search(self, params: dict[str, list[str]]) -> None:
        query = params.get("q", [""])[0].strip()
        folder = params.get("folder", [""])[0]
        if not query:
            self._send_json({"results": [], "total": 0})
            return

        terms = [term.casefold() for term in query.split()[:8]]
        matches = []

        for row in _document_rows():
            document = _row_to_document(row)
            content = str(row["content"] or "")
            if not _is_in_folder(document, folder):
                continue
            haystack = f"{document['title']}\n{document['path']}\n{content}".casefold()
            if not all(term in haystack for term in terms):
                continue

            snippet = document["excerpt"]
            if content:
                position = haystack.find(terms[0])
                content_start = len(document["title"]) + len(document["path"]) + 2
                content_position = max(0, position - content_start)
                if position >= content_start:
                    start = max(0, content_position - 70)
                    snippet = re.sub(r"\s+", " ", content[start : start + 170]).strip()
                    if start:
                        snippet = "…" + snippet
                    if start + 170 < len(content):
                        snippet += "…"

            result = dict(document)
            result["match"] = snippet
            matches.append(result)

        query_folded = query.casefold()
        matches.sort(
            key=lambda item: (
                0 if item["title"].casefold().startswith(query_folded) else 1,
                0 if query_folded in item["title"].casefold() else 1,
                item["title"].casefold(),
            )
        )
        self._send_json({"results": matches, "total": len(matches)})

    def _document(self, params: dict[str, list[str]]) -> None:
        relative = params.get("path", [""])[0]
        with _database() as connection:
            row = _note_row(connection, relative)
            if row is None or row["extension"] not in TEXT_EXTENSIONS:
                self._error("Note not found", 404)
                return
            self._send_json({
                "path": relative,
                "title": row["title"],
                "content": row["content"] or "",
                "version": row["version"],
                "truncated": False,
            })

    def _pdf_highlights(self, relative: str) -> None:
        with _database() as connection:
            note = _note_row(connection, relative)
            if note is None or note["extension"] != ".pdf":
                self._error("PDF not found.", 404)
                return
            attachment = _safe_note_file(str(note["attachment_path"] or relative))
            if attachment is None:
                self._error("PDF file not found.", 404)
                return
            rows = connection.execute(
                "SELECT id, page_number, quote, rects, created FROM pdf_highlights "
                "WHERE note_path = ? ORDER BY page_number, created, id",
                (relative,),
            ).fetchall()
            highlights = [{
                "id": str(row["id"]),
                "page_number": int(row["page_number"]),
                "quote": str(row["quote"]),
                "rects": json.loads(row["rects"]),
                "created": str(row["created"]),
            } for row in rows]
        self._send_json({"highlights": highlights})

    def _create_pdf_highlight(self, relative: str, payload: dict) -> None:
        page_number = payload.get("page_number")
        quote = payload.get("quote", "")
        rects = payload.get("rects")
        if isinstance(page_number, bool) or not isinstance(page_number, int) or not 1 <= page_number <= 200000:
            self._error("A valid PDF page number is required.")
            return
        if not isinstance(quote, str) or len(quote) > 10000:
            self._error("Highlight text is invalid.")
            return
        if not isinstance(rects, list) or not 1 <= len(rects) <= 500:
            self._error("Highlight position is invalid.")
            return

        normalized_rects = []
        for rect in rects:
            if not isinstance(rect, dict):
                self._error("Highlight position is invalid.")
                return
            try:
                x, y, width, height = (float(rect[key]) for key in ("x", "y", "width", "height"))
            except (KeyError, TypeError, ValueError):
                self._error("Highlight position is invalid.")
                return
            if not all(math.isfinite(value) for value in (x, y, width, height)):
                self._error("Highlight position is invalid.")
                return
            if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1.01 or y + height > 1.01:
                self._error("Highlight position is outside the page.")
                return
            x = min(max(x, 0.0), 1.0)
            y = min(max(y, 0.0), 1.0)
            width = min(width, 1.0 - x)
            height = min(height, 1.0 - y)
            if width > 0 and height > 0:
                normalized_rects.append({"x": x, "y": y, "width": width, "height": height})
        if not normalized_rects:
            self._error("Highlight position is invalid.")
            return

        with _database() as connection:
            note = _note_row(connection, relative)
            if note is None or note["extension"] != ".pdf":
                self._error("PDF not found.", 404)
                return
            attachment = _safe_note_file(str(note["attachment_path"] or relative))
            if attachment is None:
                self._error("PDF file not found.", 404)
                return
            highlight = {
                "id": uuid.uuid4().hex,
                "page_number": page_number,
                "quote": quote.strip(),
                "rects": normalized_rects,
                "created": datetime.now().astimezone().isoformat(timespec="seconds"),
            }
            connection.execute(
                "INSERT INTO pdf_highlights(id, note_path, page_number, quote, rects, created) "
                "VALUES(?, ?, ?, ?, ?, ?)",
                (highlight["id"], relative, page_number, highlight["quote"],
                 json.dumps(normalized_rects, separators=(",", ":")), highlight["created"]),
            )
        self._send_json(highlight, 201)

    def _delete_pdf_highlight(self, relative: str, highlight_id: str) -> None:
        with _database() as connection:
            note = _note_row(connection, relative)
            if note is None or note["extension"] != ".pdf":
                self._error("PDF not found.", 404)
                return
            cursor = connection.execute(
                "DELETE FROM pdf_highlights WHERE id = ? AND note_path = ?",
                (highlight_id, relative),
            )
            if cursor.rowcount == 0:
                self._error("Highlight not found.", 404)
                return
        self._send_json({"ok": True})

    def _file(self, params: dict[str, list[str]]) -> None:
        relative = params.get("path", [""])[0]
        with _database() as connection:
            row = _note_row(connection, relative)
            attachment_path = row["attachment_path"] if row else None
        path = _safe_note_file(str(attachment_path)) if attachment_path else _safe_note_file(relative)
        if path is None:
            self._error("File not found", 404)
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", f"inline; filename*=UTF-8''{quote(path.name)}")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with path.open("rb") as source:
            while chunk := source.read(64 * 1024):
                try:
                    self.wfile.write(chunk)
                except BrokenPipeError:
                    break

    def _backup(self) -> None:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        with tempfile.TemporaryDirectory(prefix="zetesis-backup-") as temporary_directory:
            temporary = Path(temporary_directory)
            database_copy = temporary / "zetesis.sqlite3"
            with _database() as source:
                destination = sqlite3.connect(database_copy)
                try:
                    source.backup(destination)
                finally:
                    destination.close()

            archive_path = temporary / f"zetesis-backup-{timestamp}.zip"
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                archive.write(database_copy, "zetesis.sqlite3")
                if NOTES_DIR.is_dir():
                    for path in NOTES_DIR.rglob("*"):
                        relative = path.relative_to(NOTES_DIR)
                        safe_path = _safe_note_file(relative.as_posix())
                        if safe_path is not None and safe_path == path.resolve():
                            archive.write(safe_path, Path("notes") / relative)

            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(archive_path.stat().st_size))
            self.send_header("Content-Disposition", f'attachment; filename="zetesis-backup-{timestamp}.zip"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            with archive_path.open("rb") as backup:
                while chunk := backup.read(256 * 1024):
                    try:
                        self.wfile.write(chunk)
                    except BrokenPipeError:
                        break

    def _create_note(self, payload: dict) -> None:
        title = str(payload.get("title") or "Untitled").strip()[:300] or "Untitled"
        content = payload.get("content", "")
        if not isinstance(content, str):
            self._error("Note content must be text.")
            return
        extension = str(payload.get("extension") or ".md").lower()
        if extension not in TEXT_EXTENSIONS:
            self._error("New notes must use .md or .org.")
            return
        collection = str(payload.get("collection") or "inbox").strip()
        folder = str(payload.get("folder") or collection).strip()
        location = _clean_location(collection, folder)
        if location is None:
            self._error("Invalid topic or folder.")
            return
        collection, folder = location
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        path = f"notes/{uuid.uuid4().hex}{extension}"
        with _database() as connection:
            if not connection.execute("SELECT 1 FROM collections WHERE key = ?", (collection,)).fetchone():
                self._error("Topic not found.", 404)
                return
            connection.execute(
                """INSERT INTO notes
                   (path, title, extension, content, collection, folder, created, modified, excerpt)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (path, title, extension, content, collection, folder, now, now, _excerpt(content)),
            )
            row = _note_row(connection, path)
            self._send_json(_row_to_document(row), 201)

    def _update_note(self, path: str, payload: dict) -> None:
        title = str(payload.get("title") or "Untitled").strip()[:300] or "Untitled"
        content = payload.get("content")
        if not isinstance(content, str):
            self._error("Note content must be text.")
            return
        expected_version = payload.get("version")
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with _database() as connection:
            row = _note_row(connection, path)
            if row is None or row["extension"] not in TEXT_EXTENSIONS:
                self._error("Editable note not found.", 404)
                return
            if expected_version is not None:
                try:
                    is_stale = int(expected_version) != int(row["version"])
                except (TypeError, ValueError):
                    self._error("Invalid note version.")
                    return
                if is_stale:
                    self._send_json({"error": "This note changed in another tab. Reload it before saving.", "version": row["version"]}, 409)
                    return
            connection.execute(
                """UPDATE notes SET title = ?, content = ?, excerpt = ?, modified = ?, version = version + 1
                   WHERE path = ?""",
                (title, content, _excerpt(content), now, path),
            )
            updated = _note_row(connection, path)
            self._send_json(_row_to_document(updated))

    def _create_topic(self, payload: dict) -> None:
        label = str(payload.get("name") or "").strip()[:100]
        if not label:
            self._error("Topic name is required.")
            return
        base = _slugify(label)
        with _database() as connection:
            key = base
            suffix = 2
            while connection.execute("SELECT 1 FROM collections WHERE key = ?", (key,)).fetchone():
                key = f"{base}-{suffix}"
                suffix += 1
            order = connection.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM collections").fetchone()[0]
            connection.execute("INSERT INTO collections(key, label, sort_order) VALUES(?, ?, ?)", (key, label, order))
            self._send_json({"key": key, "label": label}, 201)

    def _move_note(self, payload: dict) -> None:
        path = str(payload.get("path") or "")
        collection = str(payload.get("collection") or "")
        folder = str(payload.get("folder") or "")
        location = _clean_location(collection, folder)
        if location is None:
            self._error("Invalid topic or folder.")
            return
        collection, folder = location
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with _database() as connection:
            row = _note_row(connection, path)
            if row is None:
                self._error("Note not found.", 404)
                return
            if not connection.execute("SELECT 1 FROM collections WHERE key = ?", (collection,)).fetchone():
                self._error("Topic not found.", 404)
                return
            connection.execute(
                "UPDATE notes SET collection = ?, folder = ?, modified = ?, version = version + 1 WHERE path = ?",
                (collection, folder, now, path),
            )
            self._send_json(_row_to_document(_note_row(connection, path)))

    def _delete_note(self, path: str) -> None:
        files_to_remove = []
        with _database() as connection:
            row = _note_row(connection, path)
            if row is None:
                self._error("Note not found.", 404)
                return
            candidates = {str(row["path"])}
            if row["attachment_path"]:
                candidates.add(str(row["attachment_path"]))
            for relative in candidates:
                file_path = _safe_note_file(relative)
                if file_path is None:
                    continue
                shared = connection.execute(
                    "SELECT 1 FROM notes WHERE path != ? AND (path = ? OR attachment_path = ?) LIMIT 1",
                    (path, relative, relative),
                ).fetchone()
                if not shared:
                    files_to_remove.append(file_path)
            connection.execute("DELETE FROM notes WHERE path = ?", (path,))

        cleanup_failed = False
        for file_path in set(files_to_remove):
            try:
                file_path.unlink(missing_ok=True)
            except OSError:
                cleanup_failed = True
        response = {"ok": True}
        if cleanup_failed:
            response["warning"] = "The note was deleted from Zetesis, but a stored file could not be removed."
        self._send_json(response)

    def _followed_content_payload(self, row: sqlite3.Row) -> dict:
        return {
            "id": str(row["id"]),
            "title": str(row["title"]),
            "url": str(row["url"]),
            "kind": str(row["kind"]),
            "description": str(row["description"] or ""),
            "created": str(row["created"]),
            "modified": str(row["modified"]),
        }

    def _following(self) -> None:
        with _database() as connection:
            rows = connection.execute(
                "SELECT * FROM followed_content ORDER BY sort_order, title COLLATE NOCASE, created"
            ).fetchall()
        self._send_json({"items": [self._followed_content_payload(row) for row in rows]})

    def _followed_content_fields(self, payload: dict, current: sqlite3.Row | None = None) -> tuple[str, str, str, str] | None:
        title = str(payload.get("title", current["title"] if current else "") or "").strip()[:300]
        url = str(payload.get("url", current["url"] if current else "") or "").strip()[:2048]
        kind = str(payload.get("kind", current["kind"] if current else "other") or "other").strip().lower()
        description = payload.get("description", current["description"] if current else "")
        if not title:
            self._error("A title is required.")
            return None
        if not isinstance(description, str):
            self._error("Description must be text.")
            return None
        try:
            parsed_url = urlsplit(url)
            valid_url = parsed_url.scheme in {"http", "https"} and bool(parsed_url.hostname)
        except ValueError:
            valid_url = False
        if not valid_url:
            self._error("Enter a valid http or https URL.")
            return None
        if kind not in FOLLOWING_TYPES:
            self._error("Choose a valid content type.")
            return None
        return title, url, kind, description.strip()[:3000]

    def _create_followed_content(self, payload: dict) -> None:
        fields = self._followed_content_fields(payload)
        if fields is None:
            return
        title, url, kind, description = fields
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        item_id = uuid.uuid4().hex
        with _database() as connection:
            order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM followed_content"
            ).fetchone()[0]
            connection.execute(
                """INSERT INTO followed_content(id, title, url, kind, description, created, modified, sort_order)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
                (item_id, title, url, kind, description, now, now, order),
            )
            row = connection.execute("SELECT * FROM followed_content WHERE id = ?", (item_id,)).fetchone()
            self._send_json(self._followed_content_payload(row), 201)

    def _update_followed_content(self, item_id: str, payload: dict) -> None:
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with _database() as connection:
            row = connection.execute("SELECT * FROM followed_content WHERE id = ?", (item_id,)).fetchone()
            if row is None:
                self._error("Following item not found.", 404)
                return
            fields = self._followed_content_fields(payload, row)
            if fields is None:
                return
            title, url, kind, description = fields
            connection.execute(
                "UPDATE followed_content SET title = ?, url = ?, kind = ?, description = ?, modified = ? WHERE id = ?",
                (title, url, kind, description, now, item_id),
            )
            updated = connection.execute("SELECT * FROM followed_content WHERE id = ?", (item_id,)).fetchone()
            self._send_json(self._followed_content_payload(updated))

    def _delete_followed_content(self, item_id: str) -> None:
        with _database() as connection:
            cursor = connection.execute("DELETE FROM followed_content WHERE id = ?", (item_id,))
            if cursor.rowcount == 0:
                self._error("Following item not found.", 404)
                return
        self._send_json({"ok": True})

    def _project_payload(self, connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
        task_rows = connection.execute(
            "SELECT * FROM project_tasks WHERE project_id = ? ORDER BY sort_order, created, id",
            (row["id"],),
        ).fetchall()
        tasks = [{
            "id": str(task["id"]),
            "project_id": str(task["project_id"]),
            "title": str(task["title"]),
            "status": str(task["status"]),
            "created": str(task["created"]),
            "modified": str(task["modified"]),
        } for task in task_rows]
        completed = sum(task["status"] == "done" for task in tasks)
        return {
            "id": str(row["id"]),
            "title": str(row["title"]),
            "description": str(row["description"]),
            "status": str(row["status"]),
            "created": str(row["created"]),
            "modified": str(row["modified"]),
            "tasks": tasks,
            "task_count": len(tasks),
            "completed_count": completed,
        }

    def _projects(self) -> None:
        with _database() as connection:
            rows = connection.execute(
                "SELECT * FROM projects ORDER BY sort_order, created, title COLLATE NOCASE"
            ).fetchall()
            projects = [self._project_payload(connection, row) for row in rows]
        self._send_json({"projects": projects})

    def _create_project(self, payload: dict) -> None:
        title = str(payload.get("title") or "").strip()[:300]
        description = payload.get("description", "")
        status = str(payload.get("status") or "planned").strip().lower()
        if not title:
            self._error("Project title is required.")
            return
        if not isinstance(description, str):
            self._error("Project description must be text.")
            return
        if status not in PROJECT_STATUSES:
            self._error("Invalid project status.")
            return
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        project_id = uuid.uuid4().hex
        with _database() as connection:
            order = connection.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects").fetchone()[0]
            connection.execute(
                """INSERT INTO projects(id, title, description, status, created, modified, sort_order)
                   VALUES(?, ?, ?, ?, ?, ?, ?)""",
                (project_id, title, description[:5000], status, now, now, order),
            )
            row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            self._send_json(self._project_payload(connection, row), 201)

    def _update_project(self, project_id: str, payload: dict) -> None:
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with _database() as connection:
            row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if row is None:
                self._error("Project not found.", 404)
                return
            title = str(payload.get("title", row["title"]) or "").strip()[:300]
            description = payload.get("description", row["description"])
            status = str(payload.get("status", row["status"]) or "").strip().lower()
            if not title:
                self._error("Project title is required.")
                return
            if not isinstance(description, str):
                self._error("Project description must be text.")
                return
            if status not in PROJECT_STATUSES:
                self._error("Invalid project status.")
                return
            connection.execute(
                "UPDATE projects SET title = ?, description = ?, status = ?, modified = ? WHERE id = ?",
                (title, description[:5000], status, now, project_id),
            )
            updated = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            self._send_json(self._project_payload(connection, updated))

    def _delete_project(self, project_id: str) -> None:
        with _database() as connection:
            cursor = connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            if cursor.rowcount == 0:
                self._error("Project not found.", 404)
                return
        self._send_json({"ok": True})

    def _create_project_task(self, payload: dict) -> None:
        project_id = str(payload.get("project_id") or "")
        title = str(payload.get("title") or "").strip()[:500]
        if not title:
            self._error("Task title is required.")
            return
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        task_id = uuid.uuid4().hex
        with _database() as connection:
            if not connection.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
                self._error("Project not found.", 404)
                return
            order = connection.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM project_tasks WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0]
            connection.execute(
                """INSERT INTO project_tasks(id, project_id, title, status, created, modified, sort_order)
                   VALUES(?, ?, ?, 'todo', ?, ?, ?)""",
                (task_id, project_id, title, now, now, order),
            )
            row = connection.execute("SELECT * FROM project_tasks WHERE id = ?", (task_id,)).fetchone()
            self._send_json({
                "id": str(row["id"]),
                "project_id": str(row["project_id"]),
                "title": str(row["title"]),
                "status": str(row["status"]),
                "created": str(row["created"]),
                "modified": str(row["modified"]),
            }, 201)

    def _update_project_task(self, task_id: str, payload: dict) -> None:
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with _database() as connection:
            row = connection.execute("SELECT * FROM project_tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                self._error("Task not found.", 404)
                return
            title = str(payload.get("title", row["title"]) or "").strip()[:500]
            status = str(payload.get("status", row["status"]) or "").strip().lower()
            if not title:
                self._error("Task title is required.")
                return
            if status not in TASK_STATUSES:
                self._error("Invalid task status.")
                return
            connection.execute(
                "UPDATE project_tasks SET title = ?, status = ?, modified = ? WHERE id = ?",
                (title, status, now, task_id),
            )
            updated = connection.execute("SELECT * FROM project_tasks WHERE id = ?", (task_id,)).fetchone()
            self._send_json({
                "id": str(updated["id"]),
                "project_id": str(updated["project_id"]),
                "title": str(updated["title"]),
                "status": str(updated["status"]),
                "created": str(updated["created"]),
                "modified": str(updated["modified"]),
            })

    def _delete_project_task(self, task_id: str) -> None:
        with _database() as connection:
            cursor = connection.execute("DELETE FROM project_tasks WHERE id = ?", (task_id,))
            if cursor.rowcount == 0:
                self._error("Task not found.", 404)
                return
        self._send_json({"ok": True})

    def log_message(self, _format: str, *args) -> None:
        if getattr(self.server, "verbose", False):
            super().log_message(_format, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description="Zetesis (ζήτησις) — local note inquiry & browser.")
    parser.add_argument("--host", default="127.0.0.1", help="interface to listen on (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default: 8000)")
    parser.add_argument("--verbose", action="store_true", help="enable verbose request logging")
    args = parser.parse_args()

    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    initialize_database()
    server = ThreadingHTTPServer((args.host, args.port), ZetesisHandler)
    server.verbose = args.verbose
    print(f"Zetesis is ready at http://{args.host}:{args.port}  (press Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nZetesis stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
