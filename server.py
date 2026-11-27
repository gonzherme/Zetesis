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
from contextlib import contextmanager, suppress
import ctypes
import hashlib
import json
import math
import mimetypes
import os
import plistlib
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from blocks import (
    ASSET_ID_RE, BODY_FORMAT, BODY_FORMAT_VERSION, MAX_BODY_BYTES, BodyValidationError,
    document_asset_ids, document_excerpt, document_text, empty_document, is_allowed_href,
    new_block_id, serialize_document, validate_document,
)
from legacy_convert import CONVERTER_VERSION, convert_legacy_note

APP_DIR = Path(__file__).resolve().parent
NOTES_DIR = APP_DIR / "notes"
ASSETS_DIR = APP_DIR / "assets"
STATIC = APP_DIR / "static"
DB_PATH = APP_DIR / "zetesis.sqlite3"
LAUNCH_AGENT_LABEL = "local.zetesis.server"
LAUNCH_AGENT_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCH_AGENT_LABEL}.plist"
LAUNCH_AGENT_LOG = Path.home() / "Library" / "Logs" / "Zetesis" / "server.log"
# Zetesis's own Mac app.
MAC_APP_SOURCE = APP_DIR / "mac" / "main.swift"
MAC_APP = Path.home() / "Applications" / "Zetesis.app"
LSREGISTER = ("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework"
              "/Support/lsregister")
PRESENCE_CLIENT_RE = re.compile(r"^[0-9a-f-]{8,64}$")
# Roadmap, in the sidebar: a map of boxes of text joined by arrows, like a mind map. (Its code says
# "map"; "roadmap" in the code is what the sidebar calls Explore.) Deleted boxes and arrows are kept a
# while for Undo.
MAP_ID_RE = re.compile(r"^[0-9a-f-]{8,64}$")
MAX_MAP_BOX_TEXT = 2000
MAX_MAP_NOTES = 20000
MAX_MAP_DISTANCE = 1_000_000
MAP_DELETED_DAYS = 30

NOTE_EXTENSIONS = {".md", ".org", ".pdf"}
TEXT_EXTENSIONS = {".md", ".org"}
# Following is one note, kept in this topic, which the sidebar shows as its
# own entry rather than as a topic. The Inbox and Following topics stay at the
# top level and can't be deleted.
FOLLOWING_TOPIC = "following"
PINNED_TOPICS = {"inbox", FOLLOWING_TOPIC}
SCAN_EXCLUDED_SUBDIRS = {".git", "ltximg", "org-imgs", "__pycache__"}
SECURITY_EXCLUDED = {".git", "__pycache__"}
MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
MAX_ASSET_BYTES = 25 * 1024 * 1024
# New notes made from a file: a PDF is kept in the notes tree (each in a folder
# of its own, under its own name) and read like the PDFs already there; a
# Markdown, Org or text file becomes a note with its text.
MAX_PDF_NOTE_BYTES = 200 * 1024 * 1024
UPLOADED_FILES_DIR = "uploaded-files"
TEXT_NOTE_UPLOADS = {".md": ".md", ".markdown": ".md", ".txt": ".md", ".org": ".org"}

# Files that can be pasted or dropped into a note, with the stored extension.
ASSET_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/zip": ".zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
}
_ZIP_SIGNATURE = (b"PK\x03\x04", b"PK\x05\x06")
ASSET_SIGNATURES = {
    "image/png": lambda head: head.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": lambda head: head.startswith(b"\xff\xd8\xff"),
    "image/gif": lambda head: head[:6] in {b"GIF87a", b"GIF89a"},
    "image/webp": lambda head: head[:4] == b"RIFF" and head[8:12] == b"WEBP",
    "image/avif": lambda head: head[4:8] == b"ftyp" and head[8:12] in {b"avif", b"avis"},
    "image/svg+xml": lambda head: b"<svg" in head.lower(),
    "application/pdf": lambda head: head.startswith(b"%PDF-"),
    "application/zip": lambda head: head.startswith(_ZIP_SIGNATURE),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": lambda head: head.startswith(_ZIP_SIGNATURE),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": lambda head: head.startswith(_ZIP_SIGNATURE),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": lambda head: head.startswith(_ZIP_SIGNATURE),
}
INLINE_ASSET_PREFIXES = ("image/", "audio/", "video/", "text/", "application/pdf", "application/json")

TRACKED_COLLECTIONS = {
    "cs": "Computer Science",    
    "knowledge": "Knowledge",
    "thoughts": "Thoughts",
    "cooking": "Cooking",
    "life": "Life",
    "poker": "Poker",
}

ROADMAP_FILE = NOTES_DIR / "roadmap.org"


ROADMAP_STATUS_RE = re.compile(r"^(NEXT|TODO|IDEA|DONE|READING|IN_PROGRESS)\s+(.*)$")
ROADMAP_TAGS_RE = re.compile(r"\s+:[A-Za-z0-9_:]+:\s*$")
ROADMAP_LINK_RE = re.compile(r"^\s*-\s+link:\s*(\[\[[^\]]+\]\]|https?://\S+)\s*$", re.I)
ROADMAP_MAX_AREAS = 500
ROADMAP_MAX_ITEMS = 2000
ROADMAP_MAX_SECTIONS = 200
# Sections inside sections, counting from the area's own.
ROADMAP_MAX_DEPTH = 5


def _parse_roadmap(content: str | None = None) -> dict:
    """Explore's outline: `* Area` headings holding `** TODO/DONE Item` lines.

    A plain subheading is a section: it holds the items and sections one
    level below it, and an area or section lists its items before its
    sections. Older outlines also tagged items by medium and gave them detail
    bullets. A tagged heading still reads as an item; details are dropped,
    except that a `Link:` detail becomes a link on the item's title.
    """
    if content is None:
        content = _get_setting("roadmap_content", "")
    areas = []
    # (level, list) for the area and the sections open at this line.
    open_lists: list[tuple[int, dict]] = []
    item = None
    for line in content.splitlines():
        heading = re.match(r"^(\*+)\s+(.*?)\s*$", line)
        if heading:
            item = None
            level, text = len(heading.group(1)), heading.group(2)
            if level == 1:
                area = {"name": ROADMAP_TAGS_RE.sub("", text).strip() or "Untitled", "items": [], "sections": []}
                areas.append(area)
                open_lists = [(1, area)]
                continue
            if not open_lists:
                continue
            while open_lists[-1][0] >= level:
                open_lists.pop()
            parent = open_lists[-1][1]
            tagged = bool(ROADMAP_TAGS_RE.search(text))
            text = ROADMAP_TAGS_RE.sub("", text).strip()
            status = ROADMAP_STATUS_RE.match(text)
            if status or tagged:
                item = {"title": status.group(2).strip() if status else text, "done": bool(status and status.group(1) == "DONE")}
                parent["items"].append(item)
            elif len(open_lists) <= ROADMAP_MAX_DEPTH:
                name = text or "Untitled"
                # Two sections with one name (written by hand) become one.
                section = next((s for s in parent["sections"] if s["name"].casefold() == name.casefold()), None)
                if section is None:
                    section = {"name": name, "items": [], "sections": []}
                    parent["sections"].append(section)
                open_lists.append((level, section))
            continue
        link = ROADMAP_LINK_RE.match(line)
        if link and item and "[[" not in item["title"]:
            target = link.group(1)
            target = target[2:-2].split("][", 1)[0] if target.startswith("[[") else target
            item["title"] = f"[[{target}][{item['title']}]]"
    return {"areas": areas}


def _one_line(value, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _clean_roadmap_list(payload, depth: int) -> dict | None:
    """A validated area (depth 0) or section, with the sections inside it, or None."""
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        return None
    sections = payload.get("sections", [])
    name = _one_line(payload.get("name"), 100)
    if (not name or not isinstance(sections, list) or len(payload["items"]) > ROADMAP_MAX_ITEMS
            or len(sections) > ROADMAP_MAX_SECTIONS or (sections and depth >= ROADMAP_MAX_DEPTH)):
        return None
    # A section named like an item would read back as one.
    if depth and (ROADMAP_STATUS_RE.match(name) or ROADMAP_TAGS_RE.search(name)):
        return None
    items = []
    for item in payload["items"]:
        if not isinstance(item, dict):
            return None
        # Long enough for a few links' addresses in an item's text.
        title = _one_line(item.get("title"), 2000)
        if title:
            items.append({"title": title, "done": bool(item.get("done"))})
    cleaned, names = [], set()
    for section in sections:
        section = _clean_roadmap_list(section, depth + 1)
        if section is None or section["name"].casefold() in names:
            return None
        names.add(section["name"].casefold())
        cleaned.append(section)
    return {"name": name, "items": items, "sections": cleaned}


def _clean_roadmap(payload) -> list[dict] | None:
    """Validated areas from a client, or None if they are malformed."""
    if not isinstance(payload, list) or len(payload) > ROADMAP_MAX_AREAS:
        return None
    areas, names = [], set()
    for area in payload:
        area = _clean_roadmap_list(area, 0)
        if area is None or area["name"].casefold() in names:
            return None
        names.add(area["name"].casefold())
        areas.append(area)
    return areas


def _serialize_roadmap(areas: list[dict]) -> str:
    lines = ["#+title: Explore", ""]

    def write(entry: dict, level: int) -> None:
        lines.append(f"{'*' * level} {entry['name']}")
        for item in entry["items"]:
            lines.append(f"{'*' * (level + 1)} {'DONE' if item['done'] else 'TODO'} {item['title']}")
        for section in entry["sections"]:
            write(section, level + 1)

    for area in areas:
        write(area, 1)
        lines.append("")
    return "\n".join(lines)


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


def initialize_database(convert_bodies: bool = True) -> None:
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
            -- Folders inside topics (top-level topics are collections), by
            -- full path such as "cs/os/in-depth". A folder with notes in it
            -- gets a row automatically; empty folders exist only as rows.
            CREATE TABLE IF NOT EXISTS folders (
                path TEXT PRIMARY KEY,
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
            CREATE TABLE IF NOT EXISTS attachments (
                id TEXT PRIMARY KEY,
                storage_path TEXT NOT NULL UNIQUE,
                original_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                created TEXT NOT NULL,
                owner_note_path TEXT
            );
            CREATE TABLE IF NOT EXISTS note_assets (
                note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
                asset_id TEXT NOT NULL,
                PRIMARY KEY (note_path, asset_id)
            );
            CREATE INDEX IF NOT EXISTS note_assets_asset ON note_assets(asset_id);
            -- Roadmap: boxes of text on a map, joined by arrows.
            CREATE TABLE IF NOT EXISTS map_boxes (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '', -- its note, opened with a right-click
                x REAL NOT NULL,             -- where its top left corner is on the map
                y REAL NOT NULL,
                deleted_at TEXT,
                created TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS map_arrows (
                id TEXT PRIMARY KEY,
                from_id TEXT NOT NULL REFERENCES map_boxes(id),
                to_id TEXT NOT NULL REFERENCES map_boxes(id),
                deleted_at TEXT,
                created TEXT NOT NULL
            );
        """)
        # Boxes made before they could hold notes.
        map_columns = {row["name"] for row in connection.execute("PRAGMA table_info(map_boxes)")}
        for column, definition in (("notes", "TEXT NOT NULL DEFAULT ''"),):
            if column not in map_columns:
                connection.execute(f"ALTER TABLE map_boxes ADD COLUMN {column} {definition}")
        cutoff = (datetime.now() - timedelta(days=MAP_DELETED_DAYS)).isoformat(timespec="seconds")
        connection.execute("""
            DELETE FROM map_arrows WHERE deleted_at < ?
               OR from_id IN (SELECT id FROM map_boxes WHERE deleted_at < ?)
               OR to_id IN (SELECT id FROM map_boxes WHERE deleted_at < ?)
        """, (cutoff, cutoff, cutoff))
        connection.execute("DELETE FROM map_boxes WHERE deleted_at < ?", (cutoff,))

        # Structured note bodies (block editor JSON). `content` stays as the
        # legacy Org/Markdown snapshot; once `body_json` is set it is canonical.
        note_columns = {row["name"] for row in connection.execute("PRAGMA table_info(notes)")}
        for column, definition in (
            ("body_json", "TEXT"),
            ("body_format_version", "INTEGER"),
            ("search_text", "TEXT"),
            ("body_origin", "TEXT"),
            ("legacy_hash", "TEXT"),
        ):
            if column not in note_columns:
                connection.execute(f"ALTER TABLE notes ADD COLUMN {column} {definition}")

        # Older versions kept deleted notes in Trash. Preserve those notes by
        # making them visible again now that deletion is permanent.
        connection.execute("UPDATE notes SET deleted_at = NULL WHERE deleted_at IS NOT NULL")

        # Seed the default topics once, so topics the user moves into other
        # folders or deletes stay that way.
        if not connection.execute("SELECT 1 FROM app_meta WHERE key = 'collections_seeded'").fetchone():
            for sort_order, (key, label) in enumerate(TRACKED_COLLECTIONS.items()):
                connection.execute(
                    "INSERT OR IGNORE INTO collections(key, label, sort_order) VALUES(?, ?, ?)",
                    (key, label.strip(), sort_order),
                )
            _set_setting(connection, "collections_seeded", "1")
        connection.execute(
            "INSERT OR IGNORE INTO collections(key, label, sort_order) VALUES('inbox', 'Inbox', 999)",
        )
        connection.execute(
            "INSERT OR IGNORE INTO collections(key, label, sort_order) VALUES(?, 'Following', 1000)",
            (FOLLOWING_TOPIC,),
        )

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
        if not imported:
            _import_notes(connection)
        _sync_folders(connection)

        # Following used to be a list of links; it became a note, which starts
        # with those links. Done once, so deleting the note doesn't bring it back.
        if not connection.execute("SELECT 1 FROM app_meta WHERE key = 'following_note_created'").fetchone():
            if not connection.execute("SELECT 1 FROM notes WHERE collection = ?", (FOLLOWING_TOPIC,)).fetchone():
                _create_following_note(connection)
            _set_setting(connection, "following_note_created", "1")

        # Explore became a flat list of items; keep the outline from before.
        roadmap = connection.execute("SELECT value FROM app_meta WHERE key = 'roadmap_content'").fetchone()
        if roadmap and not connection.execute(
            "SELECT 1 FROM app_meta WHERE key = 'roadmap_content_before_simple'"
        ).fetchone():
            _set_setting(connection, "roadmap_content_before_simple", roadmap["value"])

    if not convert_bodies:
        return
    # Idempotent: converts only bodies that are missing (or whose legacy
    # snapshot changed and were never edited in the block editor).
    with _database() as connection:
        report = _convert_legacy_bodies(connection)
    if report["converted"] or report["failed"]:
        print(_conversion_summary(report))


def _import_notes(connection: sqlite3.Connection) -> None:
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


def _legacy_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _body_fields(document: dict) -> tuple[str, str, str]:
    """Serialized body plus the search text and excerpt derived from it."""
    text = document_text(document)
    return serialize_document(document), text, document_excerpt(text)


def _insert_editor_note(connection: sqlite3.Connection, path: str, title: str, extension: str,
                        collection: str, folder: str, document: dict) -> sqlite3.Row:
    """Add a block-editor note at the top of its folder; returns its row."""
    body_json, search_text, excerpt = _body_fields(document)
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    connection.execute(
        f"""INSERT INTO notes
           (path, title, extension, content, collection, folder, created, modified, excerpt,
            body_json, body_format_version, search_text, body_origin, sort_order)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'editor', {TOP_SORT_ORDER})""",
        (path, title, extension, collection, folder, now, now, excerpt,
         body_json, BODY_FORMAT_VERSION, search_text),
    )
    _sync_note_assets(connection, path, document)
    return _note_row(connection, path)


def _create_following_note(connection: sqlite3.Connection) -> None:
    items = []
    for row in connection.execute("SELECT title, url FROM followed_content ORDER BY sort_order, title COLLATE NOCASE"):
        text = {"type": "text", "text": str(row["title"])}
        if is_allowed_href(row["url"]):
            text["marks"] = [{"type": "link", "attrs": {"href": str(row["url"])}}]
        paragraph = {"type": "paragraph", "attrs": {"id": new_block_id()}, "content": [text]}
        items.append({"type": "listItem", "attrs": {"id": new_block_id()}, "content": [paragraph]})
    document = empty_document()
    if items:
        document = validate_document({"type": "doc", "content": [
            {"type": "bulletList", "attrs": {"id": new_block_id()}, "content": items},
        ]})
    body_json, search_text, excerpt = _body_fields(document)
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    connection.execute(
        f"""INSERT INTO notes
           (path, title, extension, content, collection, folder, created, modified, excerpt,
            body_json, body_format_version, search_text, body_origin, sort_order)
           VALUES (?, 'Following', '.md', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'editor', 0)""",
        (f"notes/{uuid.uuid4().hex}.md", FOLLOWING_TOPIC, FOLLOWING_TOPIC, now, now, excerpt,
         body_json, BODY_FORMAT_VERSION, search_text),
    )


def _sync_note_assets(connection: sqlite3.Connection, note_path: str, document: dict) -> None:
    connection.execute("DELETE FROM note_assets WHERE note_path = ?", (note_path,))
    connection.executemany(
        "INSERT OR IGNORE INTO note_assets(note_path, asset_id) VALUES(?, ?)",
        [(note_path, asset_id) for asset_id in sorted(document_asset_ids(document))],
    )


def _convert_note_row(connection: sqlite3.Connection, row: sqlite3.Row, *, dry_run: bool = False):
    """Convert one legacy body; returns the conversion report or raises."""
    content = row["content"] or ""
    document, conversion = convert_legacy_note(
        content,
        note_path=str(row["path"]),
        extension=str(row["extension"]),
        title=str(row["title"]),
        notes_dir=NOTES_DIR,
    )
    validate_document(document)
    body_json, search_text, excerpt = _body_fields(document)
    if not dry_run:
        # Re-check body_origin in the WHERE clause so a body saved from the
        # editor in the meantime is never overwritten.
        connection.execute(
            """UPDATE notes SET body_json = ?, body_format_version = ?, search_text = ?, excerpt = ?,
                      body_origin = 'converter', legacy_hash = ?
               WHERE path = ? AND (body_json IS NULL OR body_origin = 'converter')""",
            (body_json, BODY_FORMAT_VERSION, search_text, excerpt, _legacy_hash(content), row["path"]),
        )
        _sync_note_assets(connection, str(row["path"]), document)
    return conversion


def _convert_legacy_bodies(connection: sqlite3.Connection, *, reconvert: bool = False, dry_run: bool = False) -> dict:
    """Give every legacy text note a block body; never touch editor-saved bodies.

    Converts notes without `body_json`, and refreshes converted (never edited)
    bodies whose legacy snapshot changed — or all of them with `reconvert`.
    """
    report = {"converted": [], "fallback": [], "failed": [], "unchanged": 0, "edited": 0, "details": {}}
    rows = connection.execute(
        "SELECT * FROM notes WHERE extension IN ('.md', '.org') ORDER BY path"
    ).fetchall()
    for row in rows:
        if row["body_json"] is not None:
            if row["body_origin"] != "converter":
                report["edited"] += 1
                continue
            if not reconvert and row["legacy_hash"] == _legacy_hash(row["content"] or ""):
                report["unchanged"] += 1
                continue
        try:
            conversion = _convert_note_row(connection, row, dry_run=dry_run)
        except Exception as error:  # noqa: BLE001 - one bad note must not block the rest
            report["failed"].append((str(row["path"]), f"{type(error).__name__}: {error}"))
            continue
        report["converted"].append(str(row["path"]))
        report["details"][str(row["path"])] = conversion
        if conversion.uses_fallback:
            report["fallback"].append(str(row["path"]))
    if not dry_run:
        _set_setting(connection, "block_body_converter_version", str(CONVERTER_VERSION))
    return report


def _conversion_summary(report: dict, verbose: bool = False) -> str:
    lines = [
        f"Note bodies: {len(report['converted'])} converted "
        f"({len(report['fallback'])} with preserved Org/Markdown source), "
        f"{len(report['failed'])} failed and kept in the legacy reader, "
        f"{report['unchanged']} already converted, {report['edited']} edited in the block editor."
    ]
    for path, error in report["failed"]:
        lines.append(f"  failed: {path}: {error}")
    if verbose:
        for path, conversion in report["details"].items():
            notes = []
            if conversion.raw_blocks:
                notes.append(f"{len(conversion.raw_blocks)} preserved source block(s): "
                             + "; ".join(repr(block) for block in conversion.raw_blocks))
            if conversion.literal_links:
                notes.append("links kept as text: " + "; ".join(conversion.literal_links))
            if conversion.missing_images:
                notes.append(f"{len(conversion.missing_images)} image file(s) not found on disk")
            if notes:
                lines.append(f"  {path}: " + " | ".join(notes))
    return "\n".join(lines)


def _collections(connection: sqlite3.Connection | None = None) -> dict[str, str]:
    if connection is None:
        with _database() as owned:
            return _collections(owned)
    rows = connection.execute("SELECT key, label FROM collections ORDER BY sort_order, label COLLATE NOCASE").fetchall()
    return {str(row["key"]): str(row["label"]) for row in rows}


def _folder_label(segment: str) -> str:
    """The default name of a folder: its path segment in title case."""
    return " ".join(word[:1].upper() + word[1:] for word in re.split(r"[-_\s]+", segment) if word)


def _parent_path(path: str) -> str:
    return path.rpartition("/")[0]


def _in_subtree(column: str) -> str:
    """SQL condition: `column` is the folder bound to ?1 or inside it (?2 is its length + 1, ?3 the folder + "/")."""
    return f"({column} = ?1 OR substr({column}, 1, ?2) = ?3)"


def _subtree_args(path: str) -> tuple:
    return (path, len(path) + 1, path + "/")


def _sync_folders(connection: sqlite3.Connection) -> None:
    """Give every folder that holds notes a row, ordered by name after any existing siblings."""
    known = {row["path"] for row in connection.execute("SELECT path FROM folders")}
    missing = set()
    for row in connection.execute("SELECT DISTINCT collection, folder FROM notes"):
        parts = str(row["folder"]).split("/")
        if parts[0] != row["collection"]:
            continue
        for depth in range(2, len(parts) + 1):
            path = "/".join(parts[:depth])
            if path not in known:
                missing.add(path)
    for path in sorted(missing, key=lambda value: (_parent_path(value), _folder_label(value.rpartition("/")[2]).casefold())):
        connection.execute(
            "INSERT INTO folders(path, label, sort_order) VALUES(?, ?, ?)",
            (path, _folder_label(path.rpartition("/")[2]), _next_folder_order(connection, _parent_path(path))),
        )


def _folder_children(connection: sqlite3.Connection, parent: str) -> list[str]:
    """Paths directly inside `parent` ("" for the top level), in display order."""
    if not parent:
        return [row["key"] for row in connection.execute(
            "SELECT key FROM collections ORDER BY sort_order, label COLLATE NOCASE")]
    rows = connection.execute(
        "SELECT path FROM folders WHERE substr(path, 1, ?) = ? ORDER BY sort_order, label COLLATE NOCASE",
        (len(parent) + 1, parent + "/"),
    )
    return [row["path"] for row in rows if "/" not in row["path"][len(parent) + 1:]]


def _next_folder_order(connection: sqlite3.Connection, parent: str) -> int:
    """A sort order after every folder directly inside `parent`."""
    table, column = ("folders", "path") if parent else ("collections", "key")
    orders = [connection.execute(f"SELECT sort_order FROM {table} WHERE {column} = ?", (path,)).fetchone()[0]
              for path in _folder_children(connection, parent)]
    return max(orders, default=-1) + 1


def _folder_row(connection: sqlite3.Connection, path: str):
    """(label, is_topic) for an existing folder or topic, else None."""
    if not path:
        return None
    if "/" not in path:
        row = connection.execute("SELECT label FROM collections WHERE key = ?", (path,)).fetchone()
        return (row["label"], True) if row else None
    row = connection.execute("SELECT label FROM folders WHERE path = ?", (path,)).fetchone()
    return (row["label"], False) if row else None


def _new_child_path(connection: sqlite3.Connection, parent: str, name: str) -> str:
    """An unused path for a folder called `name` inside `parent`."""
    # Topic keys must match _clean_location's pattern, suffix included.
    base = _slugify(name)[:72].strip("-") or "folder"
    taken = {path.rpartition("/")[2] for path in _folder_children(connection, parent)}
    segment, suffix = base, 2
    while segment in taken:
        segment = f"{base}-{suffix}"
        suffix += 1
    return f"{parent}/{segment}" if parent else segment


def _place_folder(connection: sqlite3.Connection, path: str, before: str | None) -> None:
    """Order `path` among its siblings, before `before` (or last)."""
    if before == path:
        return
    parent = _parent_path(path)
    siblings = [sibling for sibling in _folder_children(connection, parent) if sibling != path]
    index = siblings.index(before) if before in siblings else len(siblings)
    siblings.insert(index, path)
    for order, sibling in enumerate(siblings):
        if parent:
            connection.execute("UPDATE folders SET sort_order = ? WHERE path = ?", (order, sibling))
        else:
            connection.execute("UPDATE collections SET sort_order = ? WHERE key = ?", (order, sibling))


def _relocate_folder(connection: sqlite3.Connection, old: str, new: str, label: str) -> None:
    """Move folder `old` and everything in it to path `new`."""
    connection.execute(
        f"UPDATE notes SET collection = ?4, folder = ?5 || substr(folder, ?2) WHERE {_in_subtree('folder')}",
        (*_subtree_args(old), new.split("/")[0], new),
    )
    inside = connection.execute(
        f"SELECT path, label, sort_order FROM folders WHERE {_in_subtree('path')} AND path != ?1",
        _subtree_args(old),
    ).fetchall()
    connection.execute(f"DELETE FROM folders WHERE {_in_subtree('path')}", _subtree_args(old))
    for row in inside:
        connection.execute(
            "INSERT INTO folders(path, label, sort_order) VALUES(?, ?, ?)",
            (new + row["path"][len(old):], row["label"], row["sort_order"]),
        )
    if "/" not in old:
        connection.execute("DELETE FROM collections WHERE key = ?", (old,))
    if "/" in new:
        connection.execute("INSERT INTO folders(path, label, sort_order) VALUES(?, ?, 0)", (new, label))
    else:
        connection.execute("INSERT INTO collections(key, label, sort_order) VALUES(?, ?, 0)", (new, label))


def _row_to_document(row: sqlite3.Row) -> dict:
    content = row["body_json"] if row["body_json"] is not None else (row["content"] or "")
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


# Notes list in the order the user arranged them (dragging in the note list);
# notes never arranged share sort_order 0 and fall back to title order.
NOTE_ORDER = "sort_order, title COLLATE NOCASE, path COLLATE NOCASE"
# New and moved notes go to the top of the list.
TOP_SORT_ORDER = "(SELECT COALESCE(MIN(sort_order), 0) - 1 FROM notes)"


def _document_rows() -> list[sqlite3.Row]:
    with _database() as connection:
        return connection.execute(f"SELECT * FROM notes ORDER BY {NOTE_ORDER}").fetchall()


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


# Roadmap's map. Changes raise ValueError for what can't be done, and LookupError for what isn't there.

def _map() -> dict:
    with _database() as connection:
        boxes = connection.execute(
            "SELECT id, text, notes, x, y FROM map_boxes WHERE deleted_at IS NULL ORDER BY created, rowid"
        ).fetchall()
        arrows = connection.execute("""
            SELECT map_arrows.id, map_arrows.from_id, map_arrows.to_id FROM map_arrows
            JOIN map_boxes AS source ON source.id = map_arrows.from_id
            JOIN map_boxes AS target ON target.id = map_arrows.to_id
            WHERE map_arrows.deleted_at IS NULL AND source.deleted_at IS NULL AND target.deleted_at IS NULL
            ORDER BY map_arrows.created, map_arrows.rowid
        """).fetchall()
    return {"boxes": [dict(row) for row in boxes], "arrows": [dict(row) for row in arrows]}


def _map_id(value) -> str:
    if not isinstance(value, str) or not MAP_ID_RE.match(value):
        raise ValueError("Invalid id.")
    return value


def _map_text(value) -> str:
    """A box's text, which can run over several lines."""
    lines = [line.strip() for line in value.strip().splitlines()] if isinstance(value, str) else []
    text = "\n".join(lines)
    if not text:
        raise ValueError("A box needs some text.")
    if len(text) > MAX_MAP_BOX_TEXT:
        raise ValueError(f"A box holds at most {MAX_MAP_BOX_TEXT} characters.")
    return text


def _map_notes(value) -> str:
    """A box's note, which can be empty."""
    if not isinstance(value, str):
        raise ValueError("A box's notes are text.")
    notes = "\n".join(line.rstrip() for line in value.splitlines()).strip("\n")
    if len(notes) > MAX_MAP_NOTES:
        raise ValueError(f"A box's notes hold at most {MAX_MAP_NOTES} characters.")
    return notes


def _map_place(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not abs(value) <= MAX_MAP_DISTANCE:
        raise ValueError("That is not a place on the map.")
    return float(value)


def _create_map_box(payload: dict) -> None:
    box_id = _map_id(payload.get("id"))
    text = _map_text(payload.get("text"))
    x, y = _map_place(payload.get("x")), _map_place(payload.get("y"))
    created = datetime.now().astimezone().isoformat(timespec="seconds")
    with _database() as connection:
        if connection.execute("SELECT 1 FROM map_boxes WHERE id = ?", (box_id,)).fetchone():
            raise ValueError("That box already exists.")
        connection.execute("INSERT INTO map_boxes(id, text, x, y, created) VALUES(?, ?, ?, ?, ?)",
                           (box_id, text, x, y, created))


def _update_map_box(box_id: str, payload: dict) -> None:
    with _database() as connection:
        box = connection.execute("SELECT * FROM map_boxes WHERE id = ?", (box_id,)).fetchone()
        if box is None:
            raise LookupError("That box does not exist.")
        if "text" in payload:
            connection.execute("UPDATE map_boxes SET text = ? WHERE id = ?", (_map_text(payload["text"]), box_id))
        if "notes" in payload:
            connection.execute("UPDATE map_boxes SET notes = ? WHERE id = ?", (_map_notes(payload["notes"]), box_id))
        if "x" in payload or "y" in payload:
            connection.execute("UPDATE map_boxes SET x = ?, y = ? WHERE id = ?", (
                _map_place(payload.get("x", box["x"])), _map_place(payload.get("y", box["y"])), box_id))
        if payload.get("deleted") is True and not box["deleted_at"]:
            # Its arrows share its timestamp, so restoring it brings back exactly these. It's to the
            # microsecond, so an arrow deleted on its own a moment before stays deleted.
            now = datetime.now().isoformat(timespec="microseconds")
            connection.execute("UPDATE map_boxes SET deleted_at = ? WHERE id = ?", (now, box_id))
            connection.execute("""
                UPDATE map_arrows SET deleted_at = ? WHERE (from_id = ? OR to_id = ?) AND deleted_at IS NULL
            """, (now, box_id, box_id))
        elif payload.get("deleted") is False and box["deleted_at"]:
            connection.execute("UPDATE map_boxes SET deleted_at = NULL WHERE id = ?", (box_id,))
            connection.execute("""
                UPDATE map_arrows SET deleted_at = NULL WHERE (from_id = ? OR to_id = ?) AND deleted_at = ?
            """, (box_id, box_id, box["deleted_at"]))


def _create_map_arrow(payload: dict) -> None:
    arrow_id = _map_id(payload.get("id"))
    start, end = _map_id(payload.get("from_id")), _map_id(payload.get("to_id"))
    if start == end:
        raise ValueError("An arrow joins two different boxes.")
    created = datetime.now().astimezone().isoformat(timespec="seconds")
    with _database() as connection:
        found = connection.execute("SELECT COUNT(*) FROM map_boxes WHERE id IN (?, ?) AND deleted_at IS NULL",
                                   (start, end)).fetchone()[0]
        if found != 2:
            raise LookupError("That box does not exist.")
        # Two boxes are joined once, whichever way the arrow points.
        if connection.execute("""
            SELECT 1 FROM map_arrows WHERE deleted_at IS NULL
              AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
        """, (start, end, end, start)).fetchone():
            raise ValueError("Those boxes are already joined.")
        if connection.execute("SELECT 1 FROM map_arrows WHERE id = ?", (arrow_id,)).fetchone():
            raise ValueError("That arrow already exists.")
        connection.execute("INSERT INTO map_arrows(id, from_id, to_id, created) VALUES(?, ?, ?, ?)",
                           (arrow_id, start, end, created))


def _update_map_arrow(arrow_id: str, payload: dict) -> None:
    with _database() as connection:
        if connection.execute("SELECT 1 FROM map_arrows WHERE id = ?", (arrow_id,)).fetchone() is None:
            raise LookupError("That arrow does not exist.")
        if "deleted" in payload:
            deleted = datetime.now().isoformat(timespec="microseconds") if payload["deleted"] else None
            connection.execute("UPDATE map_arrows SET deleted_at = ? WHERE id = ?", (deleted, arrow_id))


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


def _document_payload(row: sqlite3.Row) -> dict:
    payload = {
        "path": str(row["path"]),
        "title": row["title"],
        "extension": row["extension"],
        "version": row["version"],
        "truncated": False,
    }
    if row["body_json"] is not None:
        payload["body_format"] = BODY_FORMAT
        payload["body_format_version"] = row["body_format_version"]
        payload["body"] = json.loads(row["body_json"])
    else:
        # Not converted yet (or conversion failed): the legacy reader shows it.
        payload["body_format"] = "legacy-org" if row["extension"] == ".org" else "legacy-md"
        payload["body_format_version"] = None
        payload["content"] = row["content"] or ""
    return payload


def _parse_body(payload: dict) -> tuple[dict | None, str | None]:
    """Validate a submitted editor document; returns (document, error message)."""
    body = payload.get("body")
    if body is None:
        return None, None
    if payload.get("body_format_version") != BODY_FORMAT_VERSION:
        return None, f"This version of Zetesis saves note format {BODY_FORMAT_VERSION}. Reload the page and try again."
    try:
        validate_document(body)
    except BodyValidationError as error:
        return None, f"The note was not saved because its content is invalid ({error})."
    if len(serialize_document(body).encode("utf-8")) > MAX_BODY_BYTES:
        return None, "The note is too large to save (5 MB maximum)."
    return body, None


def _safe_asset_file(relative: str) -> Path | None:
    try:
        candidate = (ASSETS_DIR / relative).resolve()
        if candidate.is_relative_to(ASSETS_DIR.resolve()) and candidate.is_file():
            return candidate
    except (OSError, ValueError):
        pass
    return None


def _clean_filename(value: str, extension: str) -> str:
    name = value.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(character for character in name if character.isprintable() and character not in '<>:"|?*')
    name = name.strip(" .")[:200]
    return name or f"file{extension}"


class IdleMonitor:
    """Stops a server that launchd started on demand once nothing uses it: no
    request for a short while and no open Zetesis window checking in. launchd
    keeps listening on the port and starts the server again on the next
    connection, so stopping never loses a request."""

    CHECK_SECONDS = 5
    # Quiet time after the last request before stopping (covers reloads).
    GRACE_SECONDS = 20
    # Windows check in every minute; one silent this long has gone away.
    WINDOW_TIMEOUT_SECONDS = 150

    def __init__(self, server: ThreadingHTTPServer) -> None:
        self.server = server
        self.lock = threading.Lock()
        self.active = 0
        self.last_request = time.monotonic()
        self.windows: dict[str, float] = {}

    def request_started(self) -> None:
        with self.lock:
            self.active += 1

    def request_finished(self) -> None:
        with self.lock:
            self.active -= 1
            self.last_request = time.monotonic()

    def presence(self, client: str, closed: bool) -> None:
        with self.lock:
            if closed:
                self.windows.pop(client, None)
            else:
                self.windows[client] = time.monotonic()

    def idle(self) -> bool:
        with self.lock:
            now = time.monotonic()
            self.windows = {
                client: seen for client, seen in self.windows.items()
                if now - seen < self.WINDOW_TIMEOUT_SECONDS
            }
            return self.active == 0 and not self.windows and now - self.last_request >= self.GRACE_SECONDS

    def watch(self) -> None:
        while not self.idle():
            time.sleep(self.CHECK_SECONDS)
        self.server.shutdown()

    def wait_for_requests(self, timeout: float = 30) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if self.active == 0:
                    return
            time.sleep(0.1)


class ZetesisHandler(BaseHTTPRequestHandler):
    server_version = "Zetesis/1.0"

    # Requests count toward the idle monitor once their request line is read;
    # browsers open spare connections that may never carry a request.
    def handle_one_request(self) -> None:
        self._counted = False
        try:
            super().handle_one_request()
        finally:
            if self._counted:
                self.server.idle_monitor.request_finished()

    def parse_request(self) -> bool:
        parsed = super().parse_request()
        monitor = getattr(self.server, "idle_monitor", None)
        if parsed and monitor is not None:
            monitor.request_started()
            self._counted = True
        return parsed

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
        elif parsed.path == "/api/map":
            self._send_json(_map())
        elif parsed.path == "/api/search":
            self._search(params)
        elif parsed.path == "/api/document":
            self._document(params)
        elif parsed.path == "/api/pdf-highlights":
            self._pdf_highlights(params.get("path", [""])[0])
        elif parsed.path == "/api/file":
            self._file(params)
        elif parsed.path.startswith("/api/assets/"):
            self._asset(parsed.path.removeprefix("/api/assets/"))
        elif parsed.path == "/api/backup":
            self._backup()
        else:
            self._error("Not found", 404)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)
        if parsed.path == "/api/assets":
            # Uploads are raw file bytes, not JSON.
            self._upload_asset(params)
            return
        if parsed.path == "/api/notes/file":
            self._create_note_from_file(params)
            return
        if parsed.path == "/api/presence":
            # Bodyless check-ins (including sendBeacon) from open windows.
            self._presence(params)
            return
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
        elif parsed.path == "/api/notes/convert":
            self._convert_note(params.get("path", [""])[0])
        elif parsed.path == "/api/notes/order":
            self._reorder_notes(payload)
        elif parsed.path == "/api/folders":
            self._create_folder(payload)
        elif parsed.path == "/api/folders/move":
            self._move_folder(payload)
        elif parsed.path == "/api/pdf-highlights":
            self._create_pdf_highlight(params.get("path", [""])[0], payload)
        elif parsed.path == "/api/map/boxes":
            self._change_map(_create_map_box, payload)
        elif parsed.path == "/api/map/arrows":
            self._change_map(_create_map_arrow, payload)
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
            areas = _clean_roadmap(payload.get("areas"))
            if areas is None:
                self._error("Explore needs areas with distinct names, each with items and sections. "
                            "Sections in one place need distinct names that don't start with TODO or DONE, "
                            f"and go {ROADMAP_MAX_DEPTH} deep at most.")
                return
            content = _serialize_roadmap(areas)
            with _database() as connection:
                _set_setting(connection, "roadmap_content", content)
            try:
                ROADMAP_FILE.write_text(content, encoding="utf-8")
            except OSError:
                pass
            self._send_json(_parse_roadmap(content))
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
        elif parsed.path == "/api/folders":
            self._rename_folder(payload)
        elif parsed.path.startswith("/api/map/boxes/"):
            self._change_map(_update_map_box, parsed.path.removeprefix("/api/map/boxes/"), payload)
        elif parsed.path.startswith("/api/map/arrows/"):
            self._change_map(_update_map_arrow, parsed.path.removeprefix("/api/map/arrows/"), payload)
        else:
            self._error("Not found", 404)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)
        if parsed.path == "/api/notes":
            self._delete_note(params.get("path", [""])[0])
        elif parsed.path == "/api/folders":
            self._delete_folder(params.get("path", [""])[0])
        elif parsed.path == "/api/pdf-highlights":
            self._delete_pdf_highlight(params.get("path", [""])[0], params.get("id", [""])[0])
        else:
            self._error("Not found", 404)

    def _change_map(self, change, *args) -> None:
        try:
            change(*args)
        except LookupError as error:
            self._error(str(error), 404)
        except ValueError as error:
            self._error(str(error))
        else:
            self._send_json({"ok": True})

    def _serve_static(self, name: str) -> None:
        candidate = (STATIC / name).resolve()
        static_root = STATIC.resolve()
        if not candidate.is_relative_to(static_root) or not candidate.is_file():
            self._error("Not found", 404)
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix == ".webmanifest":
            content_type = "application/manifest+json"
        self._send_bytes(candidate.read_bytes(), content_type)

    def _catalog(self) -> None:
        with _database() as connection:
            _sync_folders(connection)
            rows = connection.execute(f"SELECT * FROM notes ORDER BY {NOTE_ORDER}").fetchall()
            collections = _collections(connection)
            folders = [
                {"path": row["path"], "label": row["label"]}
                for row in connection.execute("SELECT path, label FROM folders ORDER BY sort_order, label COLLATE NOCASE")
            ]
        documents = [_row_to_document(row) for row in rows]
        counts = {key: 0 for key in collections}
        for document in documents:
            if document["collection"] in counts:
                counts[document["collection"]] += 1

        self._send_json({"documents": documents, "collections": collections, "folders": folders, "counts": counts})

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
            # Converted and edited notes search their derived plain text.
            content = str(row["search_text"] or "") if row["body_json"] is not None else str(row["content"] or "")
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
            self._send_json(_document_payload(row))

    def _convert_note(self, relative: str) -> None:
        """Convert one legacy note now so it can be opened in the block editor."""
        with _database() as connection:
            row = _note_row(connection, relative)
            if row is None or row["extension"] not in TEXT_EXTENSIONS:
                self._error("Note not found", 404)
                return
            if row["body_json"] is None:
                try:
                    _convert_note_row(connection, row)
                except Exception as error:  # noqa: BLE001
                    self._error(f"This note could not be converted ({type(error).__name__}: {error}). "
                                "It stays readable in its original format.", 500)
                    return
            self._send_json(_document_payload(_note_row(connection, relative)))

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

    def _asset(self, asset_id: str) -> None:
        if not ASSET_ID_RE.match(asset_id):
            self._error("File not found", 404)
            return
        with _database() as connection:
            row = connection.execute("SELECT * FROM attachments WHERE id = ?", (asset_id,)).fetchone()
        path = _safe_asset_file(str(row["storage_path"])) if row else None
        if path is None:
            self._error("File not found", 404)
            return
        mime_type = str(row["mime_type"])
        content_type = "text/plain; charset=utf-8" if mime_type.startswith("text/") else mime_type
        disposition = "inline" if mime_type.startswith(INLINE_ASSET_PREFIXES) else "attachment"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{quote(str(row['original_name']))}")
        # Asset IDs are never reused, so their bytes never change.
        self.send_header("Cache-Control", "private, max-age=31536000, immutable")
        self.send_header("X-Content-Type-Options", "nosniff")
        if mime_type == "image/svg+xml":
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        self.end_headers()
        with path.open("rb") as source:
            while chunk := source.read(64 * 1024):
                try:
                    self.wfile.write(chunk)
                except BrokenPipeError:
                    break

    def _upload_length(self, limit: int) -> int | None:
        """The upload's size from Content-Length, or None after sending an error."""
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._error("The upload size is missing.", 411)
            return None
        if length <= 0:
            self._error("The file is empty.")
            return None
        if length > limit:
            self._error(f"Files can be at most {limit // (1024 * 1024)} MB.", 413)
            return None
        return length

    def _receive_file(self, destination: Path, length: int, mime_type: str) -> str:
        """Write the request body to `destination`; returns its SHA-256.

        Raises ValueError (with a message for the user) or OSError, leaving nothing behind."""
        partial = destination.with_name(destination.name + ".part")
        digest = hashlib.sha256()
        head = b""
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with partial.open("wb") as output:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(remaining, 256 * 1024))
                    if not chunk:
                        raise ValueError("The upload was interrupted.")
                    if len(head) < 4096:
                        head += chunk[: 4096 - len(head)]
                    digest.update(chunk)
                    output.write(chunk)
                    remaining -= len(chunk)
            check = ASSET_SIGNATURES.get(mime_type)
            if check is not None and not check(head):
                raise ValueError("The file's contents don't match its type.")
            os.replace(partial, destination)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        return digest.hexdigest()

    def _upload_asset(self, params: dict[str, list[str]]) -> None:
        """Store raw request bytes as a new asset; the server picks the file name."""
        length = self._upload_length(MAX_ASSET_BYTES)
        if length is None:
            return
        mime_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        extension = ASSET_TYPES.get(mime_type)
        if extension is None:
            self._error("This type of file can't be added to a note.", 415)
            return
        original_name = _clean_filename(params.get("filename", [""])[0], extension)
        owner = params.get("note", [""])[0] or None
        if owner is not None:
            with _database() as connection:
                if _note_row(connection, owner) is None:
                    self._error("Note not found.", 404)
                    return

        asset_id = uuid.uuid4().hex
        storage_path = f"{asset_id[:2]}/{asset_id}{extension}"
        try:
            sha256 = self._receive_file(ASSETS_DIR / storage_path, length, mime_type)
        except ValueError as error:
            self._error(str(error))
            return
        except OSError:
            self._error("The file could not be stored.", 500)
            return

        created = datetime.now().astimezone().isoformat(timespec="seconds")
        with _database() as connection:
            connection.execute(
                """INSERT INTO attachments
                   (id, storage_path, original_name, mime_type, byte_size, sha256, created, owner_note_path)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (asset_id, storage_path, original_name, mime_type, length, sha256, created, owner),
            )
        self._send_json({
            "id": asset_id,
            "url": f"/api/assets/{asset_id}",
            "name": original_name,
            "mimeType": mime_type,
            "size": length,
        }, 201)

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
                # Files pasted or dropped into notes; `attachments` in the
                # database copy maps asset IDs to these paths.
                if ASSETS_DIR.is_dir():
                    for path in sorted(ASSETS_DIR.rglob("*")):
                        relative = path.relative_to(ASSETS_DIR)
                        safe_path = _safe_asset_file(relative.as_posix())
                        if safe_path is not None and safe_path == path.resolve() and path.suffix != ".part":
                            archive.write(safe_path, Path("assets") / relative)

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
        body, body_error = _parse_body(payload)
        if body_error:
            self._error(body_error)
            return
        document = body or empty_document()
        # The extension is legacy metadata only; the body format decides the editor.
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
        path = f"notes/{uuid.uuid4().hex}{extension}"
        with _database() as connection:
            if not connection.execute("SELECT 1 FROM collections WHERE key = ?", (collection,)).fetchone():
                self._error("Topic not found.", 404)
                return
            row = _insert_editor_note(connection, path, title, extension, collection, folder, document)
            self._send_json(_row_to_document(row), 201)

    def _create_note_from_file(self, params: dict[str, list[str]]) -> None:
        """A new note from an uploaded file: a PDF note, or a note with a text file's text."""
        filename = params.get("filename", [""])[0]
        suffix = Path(filename.replace("\\", "/").rsplit("/", 1)[-1]).suffix.lower()
        if suffix != ".pdf" and suffix not in TEXT_NOTE_UPLOADS:
            self._error("Only PDFs and Markdown, Org or text files become notes this way.", 415)
            return
        collection = params.get("collection", [""])[0] or "inbox"
        location = _clean_location(collection, params.get("folder", [""])[0] or collection)
        if location is None:
            self._error("Invalid topic or folder.")
            return
        collection, folder = location
        with _database() as connection:
            if not connection.execute("SELECT 1 FROM collections WHERE key = ?", (collection,)).fetchone():
                self._error("Topic not found.", 404)
                return
        length = self._upload_length(MAX_PDF_NOTE_BYTES if suffix == ".pdf" else MAX_DOCUMENT_BYTES)
        if length is None:
            return
        name = _clean_filename(filename, suffix)
        title = str(params.get("title", [""])[0]).strip()[:300] or _fallback_title(Path(name))

        if suffix == ".pdf":
            relative = f"{UPLOADED_FILES_DIR}/{uuid.uuid4().hex}/{name}"
            try:
                self._receive_file(NOTES_DIR / relative, length, "application/pdf")
            except (ValueError, OSError) as error:
                # The PDF's folder was made for it; don't leave it behind empty.
                with suppress(OSError):
                    (NOTES_DIR / relative).parent.rmdir()
                if isinstance(error, ValueError):
                    self._error(str(error))
                else:
                    self._error("The file could not be stored.", 500)
                return
            now = datetime.now().astimezone().isoformat(timespec="seconds")
            with _database() as connection:
                connection.execute(
                    f"""INSERT INTO notes
                       (path, title, extension, content, attachment_path, collection, folder,
                        created, modified, excerpt, sort_order)
                       VALUES (?, ?, '.pdf', NULL, ?, ?, ?, ?, ?, '', {TOP_SORT_ORDER})""",
                    (relative, title, relative, collection, folder, now, now),
                )
                self._send_json(_row_to_document(_note_row(connection, relative)), 201)
            return

        data = self.rfile.read(length)
        if len(data) < length:
            self._error("The upload was interrupted.")
            return
        extension = TEXT_NOTE_UPLOADS[suffix]
        path = f"notes/{uuid.uuid4().hex}{extension}"
        try:
            document, _ = convert_legacy_note(
                data.decode("utf-8-sig", errors="replace"),
                note_path=path, extension=extension, title=title, notes_dir=NOTES_DIR,
            )
            validate_document(document)
        except Exception as error:  # noqa: BLE001
            self._error(f"This file could not be turned into a note ({type(error).__name__}: {error}).", 422)
            return
        with _database() as connection:
            row = _insert_editor_note(connection, path, title, extension, collection, folder, document)
            self._send_json(_row_to_document(row), 201)

    def _update_note(self, path: str, payload: dict) -> None:
        title = str(payload.get("title") or "Untitled").strip()[:300] or "Untitled"
        if "content" in payload and "body" not in payload:
            self._error("Zetesis now saves notes as editor documents. Reload the page to keep editing.")
            return
        body, body_error = _parse_body(payload)
        if body_error:
            self._error(body_error)
            return
        try:
            expected_version = int(payload["version"])
        except (KeyError, TypeError, ValueError):
            self._error("A valid note version is required.")
            return
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with _database() as connection:
            row = _note_row(connection, path)
            if row is None or row["extension"] not in TEXT_EXTENSIONS:
                self._error("Editable note not found.", 404)
                return
            if body is None:
                cursor = connection.execute(
                    "UPDATE notes SET title = ?, modified = ?, version = version + 1 WHERE path = ? AND version = ?",
                    (title, now, path, expected_version),
                )
            else:
                body_json, search_text, excerpt = _body_fields(body)
                cursor = connection.execute(
                    """UPDATE notes SET title = ?, body_json = ?, body_format_version = ?, search_text = ?,
                              excerpt = ?, body_origin = 'editor', modified = ?, version = version + 1
                       WHERE path = ? AND version = ?""",
                    (title, body_json, BODY_FORMAT_VERSION, search_text, excerpt, now, path, expected_version),
                )
            # The version check and the write are one statement, so a stale
            # save can never overwrite a newer one.
            if cursor.rowcount == 0:
                current = _note_row(connection, path)
                self._send_json({
                    "error": "This note was changed elsewhere. Reload it to see the latest version.",
                    "version": current["version"] if current else None,
                }, 409)
                return
            if body is not None:
                _sync_note_assets(connection, path, body)
            updated = _note_row(connection, path)
            self._send_json(_row_to_document(updated))

    # Folders. A top-level folder is a topic (collections); the rest are rows
    # in `folders`. Moving a folder rewrites its notes' locations, never their
    # files or versions.
    def _create_folder(self, payload: dict) -> None:
        parent = str(payload.get("parent") or "").strip("/")
        label = _one_line(payload.get("name"), 100)
        if not label:
            self._error("A folder needs a name.")
            return
        with _database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            _sync_folders(connection)
            if parent and _folder_row(connection, parent) is None:
                self._error("Folder not found.", 404)
                return
            path = _new_child_path(connection, parent, label)
            if parent:
                connection.execute("INSERT INTO folders(path, label, sort_order) VALUES(?, ?, ?)",
                                   (path, label, _next_folder_order(connection, parent)))
            else:
                connection.execute("INSERT INTO collections(key, label, sort_order) VALUES(?, ?, ?)",
                                   (path, label, _next_folder_order(connection, "")))
            self._send_json({"path": path, "label": label}, 201)

    def _rename_folder(self, payload: dict) -> None:
        path = str(payload.get("path") or "").strip("/")
        label = _one_line(payload.get("label"), 100)
        if not label:
            self._error("A folder needs a name.")
            return
        with _database() as connection:
            found = _folder_row(connection, path)
            if found is None:
                self._error("Folder not found.", 404)
                return
            if found[1]:
                connection.execute("UPDATE collections SET label = ? WHERE key = ?", (label, path))
            else:
                connection.execute("UPDATE folders SET label = ? WHERE path = ?", (label, path))
            self._send_json({"path": path, "label": label})

    def _move_folder(self, payload: dict) -> None:
        """Put folder `path` inside `parent` ("" for the top level), before sibling `before` (or last)."""
        path = str(payload.get("path") or "").strip("/")
        parent = str(payload.get("parent") or "").strip("/")
        before = payload.get("before") if isinstance(payload.get("before"), str) else None
        with _database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            _sync_folders(connection)
            found = _folder_row(connection, path)
            if found is None or (parent and _folder_row(connection, parent) is None):
                self._error("Folder not found.", 404)
                return
            if parent == path or parent.startswith(path + "/"):
                self._error("A folder can't go inside itself.")
                return
            if path in PINNED_TOPICS and parent:
                self._error(f"{found[0]} stays at the top level.")
                return
            new_path = path
            if parent != _parent_path(path):
                new_path = _new_child_path(connection, parent, path.rpartition("/")[2])
                _relocate_folder(connection, path, new_path, found[0])
            _place_folder(connection, new_path, before)
            self._send_json({"path": new_path})

    def _delete_folder(self, path: str) -> None:
        path = path.strip("/")
        with _database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            _sync_folders(connection)
            found = _folder_row(connection, path)
            if found is None:
                self._error("Folder not found.", 404)
                return
            if path in PINNED_TOPICS:
                self._error(f"{found[0]} can't be deleted.")
                return
            count = connection.execute(
                f"SELECT COUNT(*) FROM notes WHERE {_in_subtree('folder')}", _subtree_args(path)
            ).fetchone()[0]
            if count:
                self._error(f"“{found[0]}” still has {count} note{'s' if count != 1 else ''} in it. "
                            "Move or delete them first.", 409)
                return
            connection.execute(f"DELETE FROM folders WHERE {_in_subtree('path')}", _subtree_args(path))
            connection.execute("DELETE FROM collections WHERE key = ?", (path,))
            self._send_json({"ok": True})

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
                f"""UPDATE notes SET collection = ?, folder = ?, modified = ?, version = version + 1,
                       sort_order = {TOP_SORT_ORDER}
                   WHERE path = ?""",
                (collection, folder, now, path),
            )
            self._send_json(_row_to_document(_note_row(connection, path)))

    def _reorder_notes(self, payload: dict) -> None:
        # `paths` is the list the user rearranged (one folder's notes, in their
        # new order). Those notes swap among the positions they already hold in
        # the overall order, so notes elsewhere keep their places and every
        # folder view stays consistent with the others.
        paths = payload.get("paths")
        if (not isinstance(paths, list) or not paths or len(paths) > 100_000
                or not all(isinstance(path, str) for path in paths) or len(set(paths)) != len(paths)):
            self._error("Send the reordered note paths as a list without duplicates.")
            return
        with _database() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(f"SELECT path, sort_order FROM notes ORDER BY {NOTE_ORDER}").fetchall()
            order = [str(row["path"]) for row in rows]
            index = {path: position for position, path in enumerate(order)}
            if any(path not in index for path in paths):
                self._error("Note not found.", 404)
                return
            for slot, path in zip(sorted(index[path] for path in paths), paths):
                order[slot] = path
            current = {str(row["path"]): int(row["sort_order"]) for row in rows}
            connection.executemany(
                "UPDATE notes SET sort_order = ? WHERE path = ?",
                [(position, path) for position, path in enumerate(order) if current[path] != position],
            )
        self._send_json({"order": order})

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

            # Assets this note used or uploaded are removed only when no other
            # note still references them.
            asset_ids = {
                str(asset["asset_id"]) for asset in
                connection.execute("SELECT asset_id FROM note_assets WHERE note_path = ?", (path,))
            } | {
                str(asset["id"]) for asset in
                connection.execute("SELECT id FROM attachments WHERE owner_note_path = ?", (path,))
            }
            connection.execute("DELETE FROM notes WHERE path = ?", (path,))
            for asset_id in sorted(asset_ids):
                still_used = connection.execute(
                    "SELECT 1 FROM note_assets WHERE asset_id = ? LIMIT 1", (asset_id,)
                ).fetchone() or connection.execute(
                    "SELECT 1 FROM notes WHERE instr(body_json, ?) > 0 LIMIT 1", (asset_id,)
                ).fetchone()
                if still_used:
                    continue
                attachment = connection.execute(
                    "SELECT storage_path FROM attachments WHERE id = ?", (asset_id,)
                ).fetchone()
                if attachment is None:
                    continue
                connection.execute("DELETE FROM attachments WHERE id = ?", (asset_id,))
                asset_file = _safe_asset_file(str(attachment["storage_path"]))
                if asset_file is not None:
                    files_to_remove.append(asset_file)

        cleanup_failed = False
        uploads_root = (NOTES_DIR / UPLOADED_FILES_DIR).resolve()
        for file_path in set(files_to_remove):
            try:
                file_path.unlink(missing_ok=True)
                if file_path.parent.parent == uploads_root and not any(file_path.parent.iterdir()):
                    file_path.parent.rmdir()
            except OSError:
                cleanup_failed = True
        response = {"ok": True}
        if cleanup_failed:
            response["warning"] = "The note was deleted from Zetesis, but a stored file could not be removed."
        self._send_json(response)

    def _presence(self, params: dict) -> None:
        client = params.get("client", [""])[0]
        monitor = getattr(self.server, "idle_monitor", None)
        if monitor is not None and PRESENCE_CLIENT_RE.match(client):
            monitor.presence(client, closed=params.get("closed", [""])[0] == "1")
        self._send_json({"ok": True})

    def log_message(self, _format: str, *args) -> None:
        if getattr(self.server, "verbose", False):
            super().log_message(_format, *args)


def _launchd_socket() -> socket.socket:
    """The listening socket launchd opened for this job (see LAUNCH_AGENT_PLIST)."""
    libc = ctypes.CDLL(None, use_errno=True)
    descriptors = ctypes.POINTER(ctypes.c_int)()
    count = ctypes.c_size_t(0)
    error = libc.launch_activate_socket(b"Listeners", ctypes.byref(descriptors), ctypes.byref(count))
    if error:
        raise OSError(error, f"launchd did not pass a socket: {os.strerror(error)}")
    try:
        sockets = [socket.socket(fileno=descriptors[index]) for index in range(count.value)]
    finally:
        libc.free(descriptors)
    if len(sockets) != 1:
        raise OSError(f"Expected one socket from launchd, got {len(sockets)}.")
    return sockets[0]


def _launchctl(*arguments: str) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", *arguments], capture_output=True, text=True)


def _install_launch_agent(host: str, port: int, database: Path | None) -> int:
    if sys.platform != "darwin":
        print("Starting Zetesis on demand uses macOS launchd; this is not a Mac.")
        return 1
    domain = f"gui/{os.getuid()}"
    _launchctl("bootout", f"{domain}/{LAUNCH_AGENT_LABEL}")
    try:
        with socket.create_connection((host, port), timeout=1):
            print(f"Something is already running at http://{host}:{port}. Stop it (Ctrl+C in its "
                  "terminal) and run this again.")
            return 1
    except OSError:
        pass
    arguments = [sys.executable, str(APP_DIR / "server.py"), "--launchd"]
    if database:
        arguments += ["--database", str(database.resolve())]
    LAUNCH_AGENT_LOG.parent.mkdir(parents=True, exist_ok=True)
    LAUNCH_AGENT_PLIST.parent.mkdir(parents=True, exist_ok=True)
    LAUNCH_AGENT_PLIST.write_bytes(plistlib.dumps({
        "Label": LAUNCH_AGENT_LABEL,
        "ProgramArguments": arguments,
        "WorkingDirectory": str(APP_DIR),
        # launchd owns the port and starts the server when something connects.
        "Sockets": {"Listeners": {"SockNodeName": host, "SockServiceName": str(port)}},
        "StandardOutPath": str(LAUNCH_AGENT_LOG),
        "StandardErrorPath": str(LAUNCH_AGENT_LOG),
    }))
    result = _launchctl("bootstrap", domain, str(LAUNCH_AGENT_PLIST))
    if result.returncode != 0:
        print(f"launchctl could not load {LAUNCH_AGENT_PLIST}: {result.stderr.strip() or result.returncode}")
        return 1
    print(f"Zetesis now starts on its own when you open http://{host}:{port}/ and stops shortly after "
          f"the last Zetesis window closes.\nLog: {LAUNCH_AGENT_LOG}\n"
          "Run this again after moving Zetesis or upgrading Python; undo with --uninstall-launch-agent.")
    return 0


def _uninstall_launch_agent() -> int:
    _launchctl("bootout", f"gui/{os.getuid()}/{LAUNCH_AGENT_LABEL}")
    LAUNCH_AGENT_PLIST.unlink(missing_ok=True)
    print("Zetesis no longer starts on its own. Run `python3 zetesis/server.py` to start it.")
    return 0


def _install_mac_app(host: str, port: int) -> int:
    """Builds Zetesis's own Mac app into ~/Applications: Zetesis's page in a window, with Zetesis's menus."""
    if sys.platform != "darwin":
        print("Zetesis's app is for macOS; this is not a Mac.")
        return 1
    if shutil.which("swiftc") is None:
        print("Building Zetesis's app needs Apple's command line tools. Run `xcode-select --install` and try again.")
        return 1
    # Built aside, so a failed build leaves an installed app as it was.
    with tempfile.TemporaryDirectory(prefix="zetesis-app-") as directory:
        app = Path(directory) / "Zetesis.app"
        contents = app / "Contents"
        resources = contents / "Resources"
        (contents / "MacOS").mkdir(parents=True)
        resources.mkdir()
        compiled = subprocess.run(["swiftc", "-O", str(MAC_APP_SOURCE), "-o", str(contents / "MacOS" / "Zetesis")],
                                  capture_output=True, text=True)
        if compiled.returncode != 0:
            print(f"Could not compile Zetesis's app:\n{compiled.stderr.strip()}")
            return 1
        # The icon, drawn from the web app's, with tools macOS comes with.
        iconset = Path(directory) / "Zetesis.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale, suffix in ((1, ""), (2, "@2x")):
                subprocess.run(["sips", "-z", str(size * scale), str(size * scale), str(STATIC / "icon-512.png"),
                                "--out", str(iconset / f"icon_{size}x{size}{suffix}.png")], capture_output=True)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(resources / "Zetesis.icns")],
                       capture_output=True)
        (contents / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "local.zetesis.app",
            "CFBundleName": "Zetesis",
            "CFBundleDisplayName": "Zetesis",
            "CFBundleExecutable": "Zetesis",
            "CFBundleIconFile": "Zetesis",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": "1",
            "LSMinimumSystemVersion": "14.0",
            "LSApplicationCategoryType": "public.app-category.productivity",
            "NSHighResolutionCapable": True,
            # Notes hold images and embeds from anywhere, which a browser would show, plain http included.
            "NSAppTransportSecurity": {"NSAllowsArbitraryLoadsInWebContent": True},
            "ZetesisURL": f"http://{host}:{port}/",
        }))
        signed = subprocess.run(["codesign", "--force", "--sign", "-", str(app)], capture_output=True, text=True)
        if signed.returncode != 0:
            print(f"Could not sign Zetesis's app: {signed.stderr.strip()}")
            return 1
        shutil.rmtree(MAC_APP, ignore_errors=True)
        MAC_APP.parent.mkdir(exist_ok=True)
        shutil.move(app, MAC_APP)
    subprocess.run([LSREGISTER, "-f", str(MAC_APP)], capture_output=True)
    print(f"Zetesis's app is in {MAC_APP}. Open it from Spotlight or Launchpad, and keep it in the Dock; if it was "
          "open, quit it and open it again.\nRun this again when mac/main.swift changes; undo with --uninstall-mac-app.")
    return 0


def _uninstall_mac_app() -> int:
    subprocess.run([LSREGISTER, "-u", str(MAC_APP)], capture_output=True)
    shutil.rmtree(MAC_APP, ignore_errors=True)
    print(f"Removed {MAC_APP}. Zetesis still opens in the browser.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Zetesis (ζήτησις) — local note inquiry & browser.")
    parser.add_argument("--host", default="127.0.0.1", help="interface to listen on (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default: 8000)")
    parser.add_argument("--verbose", action="store_true", help="enable verbose request logging")
    parser.add_argument("--database", type=Path, help="use this SQLite file instead of zetesis/zetesis.sqlite3")
    parser.add_argument("--migrate-bodies", action="store_true",
                        help="convert legacy Org/Markdown bodies to block documents, print a report, and exit")
    parser.add_argument("--dry-run", action="store_true",
                        help="with --migrate-bodies: convert a temporary copy of the database and change nothing")
    parser.add_argument("--reconvert", action="store_true",
                        help="with --migrate-bodies: also redo converted bodies that were never edited")
    parser.add_argument("--install-launch-agent", action="store_true",
                        help="macOS: start Zetesis automatically when it is opened (uses --host/--port)")
    parser.add_argument("--uninstall-launch-agent", action="store_true",
                        help="macOS: stop starting Zetesis automatically")
    parser.add_argument("--install-mac-app", action="store_true",
                        help="macOS: build Zetesis's own app into ~/Applications (uses --host/--port)")
    parser.add_argument("--uninstall-mac-app", action="store_true", help="macOS: remove Zetesis's own app")
    parser.add_argument("--launchd", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.install_launch_agent:
        sys.exit(_install_launch_agent(args.host, args.port, args.database))
    if args.uninstall_launch_agent:
        sys.exit(_uninstall_launch_agent())
    if args.install_mac_app:
        sys.exit(_install_mac_app(args.host, args.port))
    if args.uninstall_mac_app:
        sys.exit(_uninstall_mac_app())

    global DB_PATH
    if args.database:
        DB_PATH = args.database.resolve()
    NOTES_DIR.mkdir(parents=True, exist_ok=True)

    if args.migrate_bodies:
        with tempfile.TemporaryDirectory(prefix="zetesis-migration-") as temporary_directory:
            if args.dry_run:
                copy = Path(temporary_directory) / "zetesis.sqlite3"
                source, destination = sqlite3.connect(DB_PATH), sqlite3.connect(copy)
                try:
                    source.backup(destination)
                finally:
                    source.close()
                    destination.close()
                DB_PATH = copy
            initialize_database(convert_bodies=False)
            with _database() as connection:
                report = _convert_legacy_bodies(connection, reconvert=args.reconvert)
        if args.dry_run:
            print("Dry run on a temporary copy of the database; nothing was changed.")
        print(_conversion_summary(report, verbose=True))
        return

    if args.launchd:
        listener = _launchd_socket()
        initialize_database()
        host, port = listener.getsockname()[:2]
        server = ThreadingHTTPServer((host, port), ZetesisHandler, bind_and_activate=False)
        server.socket.close()
        server.socket = listener
        server.server_name, server.server_port = host, port
        server.verbose = args.verbose
        monitor = server.idle_monitor = IdleMonitor(server)
        threading.Thread(target=monitor.watch, daemon=True).start()
        print(f"{datetime.now():%Y-%m-%d %H:%M:%S} Zetesis started on demand at http://{host}:{port}", flush=True)
        try:
            server.serve_forever()
        finally:
            monitor.wait_for_requests()
            server.server_close()
        print(f"{datetime.now():%Y-%m-%d %H:%M:%S} Zetesis stopped (no open windows)", flush=True)
        return

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
