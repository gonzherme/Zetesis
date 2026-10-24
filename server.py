#!/usr/bin/env python3
"""Zetesis (ζήτησις) — Local, file-based note inquiry & browser.

Manages and browses your notes stored directly within zetesis/notes/:
- Cooking
- Computer Science (algorithms, architecture, c++, cloud, compilers, etc.)
- Knowledge (economics, geopolitics, history, investing, worldview)
- Poker
- Thoughts
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

APP_DIR = Path(__file__).resolve().parent
NOTES_DIR = APP_DIR / "notes"
STATIC = APP_DIR / "static"

NOTE_EXTENSIONS = {".md", ".org", ".pdf"}
TEXT_EXTENSIONS = {".md", ".org"}
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

# Cache text and extracted metadata: relative_path -> (mtime_ns, size, document_dict, content_str)
_DOCUMENT_CACHE: dict[str, tuple[int, int, dict, str]] = {}


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
    cached = _DOCUMENT_CACHE.get(relative)
    if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
        return cached[2], cached[3]

    content = _read_text(path) if path.suffix.lower() in TEXT_EXTENSIONS else ""
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
    _DOCUMENT_CACHE[relative] = (stat.st_mtime_ns, stat.st_size, document, content)
    return document, content


def _all_documents() -> list[tuple[dict, str]]:
    documents = [_document_for(path) for path in _iter_document_paths()]
    live_paths = {document["path"] for document, _ in documents}
    for stale_path in set(_DOCUMENT_CACHE) - live_paths:
        del _DOCUMENT_CACHE[stale_path]
    return documents


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
        elif parsed.path.startswith("/static/"):
            self._serve_static(unquote(parsed.path.removeprefix("/static/")))
        elif parsed.path == "/api/catalog":
            self._catalog()
        elif parsed.path == "/api/search":
            self._search(params)
        elif parsed.path == "/api/document":
            self._document(params)
        elif parsed.path == "/api/file":
            self._file(params)
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
        documents = [doc for doc, _ in _all_documents()]
        documents.sort(key=lambda item: (item["title"].casefold(), item["path"].casefold()))

        counts = {col: 0 for col in TRACKED_COLLECTIONS}
        for doc in documents:
            if doc["collection"] in counts:
                counts[doc["collection"]] += 1

        self._send_json({
            "documents": documents,
            "collections": TRACKED_COLLECTIONS,
            "counts": counts,
        })

    def _search(self, params: dict[str, list[str]]) -> None:
        query = params.get("q", [""])[0].strip()
        folder = params.get("folder", [""])[0]
        if not query:
            self._send_json({"results": [], "total": 0})
            return

        terms = [term.casefold() for term in query.split()[:8]]
        matches = []

        for document, content in _all_documents():
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
        path = _safe_note_file(relative)
        if path is None or path.suffix.lower() not in TEXT_EXTENSIONS:
            self._error("Note not found", 404)
            return
        text = _read_text(path)
        self._send_json({
            "path": relative,
            "content": text,
            "truncated": path.stat().st_size > MAX_DOCUMENT_BYTES,
        })

    def _file(self, params: dict[str, list[str]]) -> None:
        relative = params.get("path", [""])[0]
        path = _safe_note_file(relative)
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
