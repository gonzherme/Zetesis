"""Zetesis note body format: validation and derived text for editor documents.

A text note's body is one JSON tree produced by the block editor (Tiptap /
ProseMirror). This module is the server-side contract for that tree. It must
accept exactly what frontend/src/schema.js can load: node and mark names,
attributes, and content rules mirror that file, and any change to either side
must bump BODY_FORMAT_VERSION.
"""

from __future__ import annotations

import json
import re
import secrets

BODY_FORMAT = "zetesis.blocks"
BODY_FORMAT_VERSION = 1
MAX_BODY_BYTES = 5 * 1024 * 1024
MAX_DEPTH = 64
MAX_NODES = 250_000

CALLOUT_KINDS = {"note", "definition", "tip", "warning"}
BLOCK_TYPES = {
    "paragraph", "heading", "blockquote", "callout", "bulletList", "orderedList", "taskList",
    "codeBlock", "rawSource", "horizontalRule", "table", "image", "fileBlock", "embed",
}
INLINE_TYPES = {"text", "hardBreak"}
CALLOUT_CHILDREN = {"paragraph", "bulletList", "orderedList", "taskList", "codeBlock", "image"}
CODE_TYPES = {"codeBlock", "rawSource"}
MARK_TYPES = {"link", "bold", "code", "italic", "strike", "underline", "highlight"}

ASSET_ID_RE = re.compile(r"^[0-9a-f]{32}$")
BLOCK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LANGUAGE_RE = re.compile(r"^[A-Za-z0-9_+#.-]{0,64}$")
MIME_RE = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")
HTTP_URL_RE = re.compile(r"^https?://\S+$", re.I)
HREF_RES = (
    HTTP_URL_RE,
    re.compile(r"^mailto:\S+$", re.I),
    re.compile(r"^/\?note=\S+$"),
    re.compile(r"^/api/file\?path=\S+$"),
    re.compile(r"^/api/assets/[0-9a-f]{32}$"),
)


class BodyValidationError(ValueError):
    """The submitted note body does not match the editor schema."""


def new_block_id() -> str:
    """Same shape as the editor's generated block IDs (12 hex characters)."""
    return secrets.token_hex(6)


def empty_document() -> dict:
    return {"type": "doc", "content": [{"type": "paragraph", "attrs": {"id": new_block_id()}}]}


def is_allowed_href(value: object) -> bool:
    return isinstance(value, str) and len(value) <= 4096 and any(pattern.match(value) for pattern in HREF_RES)


def _fail(where: str, message: str) -> None:
    raise BodyValidationError(f"{where}: {message}")


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _optional_string(where: str, value: object, limit: int) -> None:
    if value is not None and (not isinstance(value, str) or len(value) > limit):
        _fail(where, f"must be text of at most {limit} characters")


def _safe_relative_path(value: object) -> bool:
    if not isinstance(value, str) or not value or len(value) > 1024:
        return False
    if value.startswith("/") or "\\" in value or "\x00" in value:
        return False
    return all(part not in {"", ".", ".."} for part in value.split("/"))


def _check_block_id(where: str, value: object) -> None:
    if value is not None and (not isinstance(value, str) or not BLOCK_ID_RE.match(value)):
        _fail(where, "block id is invalid")


def _check_attrs(where: str, node_type: str, attrs: dict) -> None:
    def check_id() -> None:
        _check_block_id(f"{where}.attrs.id", attrs.get("id"))

    if node_type in {"paragraph", "blockquote", "bulletList", "taskList", "listItem", "horizontalRule", "table"}:
        check_id()
    elif node_type == "heading":
        check_id()
        level = attrs.get("level", 1)
        if not _is_int(level) or not 1 <= level <= 6:
            _fail(where, "heading level must be 1–6")
    elif node_type == "orderedList":
        check_id()
        start = attrs.get("start", 1)
        if not _is_int(start) or not -1_000_000 <= start <= 1_000_000_000:
            _fail(where, "list start must be a whole number")
        if attrs.get("type") not in {None, "1", "a", "A", "i", "I"}:
            _fail(where, "list numbering type is invalid")
    elif node_type == "taskItem":
        check_id()
        if not isinstance(attrs.get("checked", False), bool):
            _fail(where, "checked must be true or false")
    elif node_type == "codeBlock":
        check_id()
        language = attrs.get("language")
        if language is not None and (not isinstance(language, str) or not LANGUAGE_RE.match(language)):
            _fail(where, "code language is invalid")
    elif node_type == "rawSource":
        check_id()
        if attrs.get("format", "org") not in {"org", "md"}:
            _fail(where, "source format must be org or md")
    elif node_type == "callout":
        check_id()
        if attrs.get("kind", "note") not in CALLOUT_KINDS:
            _fail(where, "callout kind is invalid")
    elif node_type in {"tableCell", "tableHeader"}:
        for key in ("colspan", "rowspan"):
            value = attrs.get(key, 1)
            if not _is_int(value) or not 1 <= value <= 1000:
                _fail(where, f"{key} must be 1–1000")
        widths = attrs.get("colwidth")
        if widths is not None and (
            not isinstance(widths, list) or len(widths) > 1000
            or not all(_is_int(width) and 0 <= width <= 100_000 for width in widths)
        ):
            _fail(where, "column widths are invalid")
        if attrs.get("align") not in {None, "left", "center", "right", "justify"}:
            _fail(where, "cell alignment is invalid")
    elif node_type == "image":
        check_id()
        asset_id, path, src = attrs.get("assetId"), attrs.get("path"), attrs.get("src")
        if asset_id is not None and (not isinstance(asset_id, str) or not ASSET_ID_RE.match(asset_id)):
            _fail(where, "image asset id is invalid")
        if path is not None and not _safe_relative_path(path):
            _fail(where, "image path is invalid")
        if src is not None and (not isinstance(src, str) or len(src) > 4096 or not HTTP_URL_RE.match(src)):
            _fail(where, "image address must be an http(s) URL")
        if asset_id is None and path is None and src is None:
            _fail(where, "image needs an uploaded asset, a notes file, or a URL")
        _optional_string(f"{where}.attrs.alt", attrs.get("alt", ""), 2000)
        width = attrs.get("width")
        if width is not None and (not _is_int(width) or not 1 <= width <= 10_000):
            _fail(where, "image width must be 1–10000 pixels")
    elif node_type == "fileBlock":
        check_id()
        asset_id, note_path = attrs.get("assetId"), attrs.get("notePath")
        if asset_id is not None and (not isinstance(asset_id, str) or not ASSET_ID_RE.match(asset_id)):
            _fail(where, "file asset id is invalid")
        if note_path is not None and not _safe_relative_path(note_path):
            _fail(where, "linked note path is invalid")
        if asset_id is None and note_path is None:
            _fail(where, "file block needs an uploaded asset or a note")
        _optional_string(f"{where}.attrs.name", attrs.get("name", ""), 500)
        mime_type = attrs.get("mimeType")
        if mime_type is not None and (not isinstance(mime_type, str) or len(mime_type) > 200 or not MIME_RE.match(mime_type)):
            _fail(where, "file type is invalid")
        size = attrs.get("size")
        if size is not None and (not _is_int(size) or size < 0):
            _fail(where, "file size is invalid")
    elif node_type == "embed":
        check_id()
        url = attrs.get("url")
        if not isinstance(url, str) or len(url) > 4096 or not HTTP_URL_RE.match(url):
            _fail(where, "embed address must be an http(s) URL")
        _optional_string(f"{where}.attrs.label", attrs.get("label"), 4096)
        width = attrs.get("width")
        if width is not None and (not _is_int(width) or not 1 <= width <= 10_000):
            _fail(where, "embed width must be 1–10000 pixels")


NODE_ATTRS = {
    "doc": set(),
    "paragraph": {"id"},
    "heading": {"id", "level"},
    "blockquote": {"id"},
    "callout": {"id", "kind"},
    "bulletList": {"id"},
    "orderedList": {"id", "start", "type"},
    "taskList": {"id"},
    "listItem": {"id"},
    "taskItem": {"id", "checked"},
    "codeBlock": {"id", "language"},
    "rawSource": {"id", "format"},
    "horizontalRule": {"id"},
    "table": {"id"},
    "tableRow": set(),
    "tableCell": {"colspan", "rowspan", "colwidth", "align"},
    "tableHeader": {"colspan", "rowspan", "colwidth", "align"},
    "image": {"id", "assetId", "path", "src", "alt", "width"},
    "fileBlock": {"id", "assetId", "notePath", "name", "mimeType", "size"},
    "embed": {"id", "url", "label", "width"},
    "hardBreak": set(),
    "text": set(),
}
LEAF_TYPES = {"horizontalRule", "image", "fileBlock", "embed", "hardBreak", "text"}


def _check_content(where: str, node_type: str, children: list[str]) -> None:
    if node_type in {"doc", "blockquote", "tableCell", "tableHeader"}:
        if not children or any(child not in BLOCK_TYPES for child in children):
            _fail(where, "must contain one or more blocks")
    elif node_type in {"paragraph", "heading"}:
        if any(child not in INLINE_TYPES for child in children):
            _fail(where, "may only contain text")
    elif node_type in CODE_TYPES:
        if any(child != "text" for child in children):
            _fail(where, "may only contain plain text")
    elif node_type == "callout":
        if not children or any(child not in CALLOUT_CHILDREN for child in children):
            _fail(where, "must contain paragraphs, lists, code, or images")
    elif node_type in {"bulletList", "orderedList"}:
        if not children or any(child != "listItem" for child in children):
            _fail(where, "must contain list items")
    elif node_type == "taskList":
        if not children or any(child != "taskItem" for child in children):
            _fail(where, "must contain checklist items")
    elif node_type in {"listItem", "taskItem"}:
        if not children or children[0] != "paragraph" or any(child not in BLOCK_TYPES for child in children[1:]):
            _fail(where, "must start with a paragraph")
    elif node_type == "table":
        if not children or any(child != "tableRow" for child in children):
            _fail(where, "must contain rows")
    elif node_type == "tableRow":
        if any(child not in {"tableCell", "tableHeader"} for child in children):
            _fail(where, "must contain cells")
    elif node_type in LEAF_TYPES and children:
        _fail(where, "cannot contain other nodes")


def _check_marks(where: str, marks: object, parent_type: str) -> None:
    if not isinstance(marks, list):
        _fail(where, "marks must be a list")
    if marks and parent_type in CODE_TYPES:
        _fail(where, "code text cannot be formatted")
    seen = set()
    for index, mark in enumerate(marks):
        mark_where = f"{where}.marks[{index}]"
        if not isinstance(mark, dict) or set(mark) - {"type", "attrs"}:
            _fail(mark_where, "is not a valid mark")
        mark_type = mark.get("type")
        if mark_type not in MARK_TYPES:
            _fail(mark_where, f"unknown mark {mark_type!r}")
        if mark_type in seen:
            _fail(mark_where, "is repeated")
        seen.add(mark_type)
        attrs = mark.get("attrs", {})
        if not isinstance(attrs, dict):
            _fail(mark_where, "attrs must be an object")
        if mark_type == "link":
            if set(attrs) - {"href", "target", "rel", "class", "title", "playerWidth"}:
                _fail(mark_where, "has unknown attributes")
            if not is_allowed_href(attrs.get("href")):
                _fail(mark_where, "link address is not allowed")
            if attrs.get("target") not in {None, "_blank"}:
                _fail(mark_where, "link target is invalid")
            for key in ("rel", "class", "title"):
                _optional_string(f"{mark_where}.{key}", attrs.get(key), 500)
            width = attrs.get("playerWidth")
            if width is not None and (not _is_int(width) or not 1 <= width <= 10_000):
                _fail(mark_where, "player width must be 1–10000 pixels")
        elif attrs:
            _fail(mark_where, "takes no attributes")
    # Inline code excludes every other mark in the editor schema.
    if "code" in seen and len(seen) > 1:
        _fail(where, "inline code cannot be combined with other formatting")


def validate_document(document: object) -> dict:
    """Check an editor document against the schema; raise BodyValidationError."""
    if not isinstance(document, dict) or document.get("type") != "doc":
        raise BodyValidationError("The note body must be an editor document.")
    count = 0

    def visit(node: object, where: str, depth: int, parent_type: str | None) -> None:
        nonlocal count
        count += 1
        if count > MAX_NODES:
            raise BodyValidationError("The note body has too many blocks.")
        if depth > MAX_DEPTH:
            _fail(where, "is nested too deeply")
        if not isinstance(node, dict):
            _fail(where, "is not a node")
        unknown_keys = set(node) - {"type", "attrs", "content", "text", "marks"}
        if unknown_keys:
            _fail(where, f"has unknown fields {sorted(unknown_keys)}")
        node_type = node.get("type")
        if node_type not in NODE_ATTRS:
            _fail(where, f"unknown block type {node_type!r}")
        where = f"{where}<{node_type}>"
        attrs = node.get("attrs", {})
        if not isinstance(attrs, dict):
            _fail(where, "attrs must be an object")
        unknown_attrs = set(attrs) - NODE_ATTRS[node_type]
        if unknown_attrs:
            _fail(where, f"has unknown attributes {sorted(unknown_attrs)}")
        _check_attrs(where, node_type, attrs)

        if node_type == "text":
            text = node.get("text")
            if not isinstance(text, str) or not text or len(text) > 2_000_000:
                _fail(where, "text must be a non-empty string")
            if "content" in node:
                _fail(where, "text cannot have children")
            _check_marks(where, node.get("marks", []), parent_type or "")
            return
        if "text" in node or "marks" in node:
            _fail(where, "only text can carry text or marks")

        content = node.get("content", [])
        if not isinstance(content, list):
            _fail(where, "content must be a list")
        children = []
        for index, child in enumerate(content):
            visit(child, f"{where}.content[{index}]", depth + 1, node_type)
            children.append(child["type"])
        _check_content(where, node_type, children)

    visit(document, "doc", 0, None)
    return document


def serialize_document(document: dict) -> str:
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


def parse_stored_document(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _inline_text(node: dict) -> str:
    parts = []
    for child in node.get("content", []):
        if child.get("type") == "text":
            parts.append(child.get("text", ""))
        elif child.get("type") == "hardBreak":
            parts.append("\n")
    return "".join(parts)


def _block_lines(node: dict) -> list[str]:
    node_type = node.get("type")
    attrs = node.get("attrs") or {}
    if node_type in {"paragraph", "heading", "codeBlock", "rawSource"}:
        text = _inline_text(node)
        return [text] if text.strip() else []
    if node_type == "image":
        return [str(attrs["alt"])] if attrs.get("alt") else []
    if node_type == "fileBlock":
        return [str(attrs["name"])] if attrs.get("name") else []
    if node_type == "embed":
        return ([str(attrs["label"])] if attrs.get("label") else []) + [str(attrs.get("url", ""))]
    if node_type == "tableRow":
        cells = [
            " ".join(line.replace("\n", " ") for child in cell.get("content", []) for line in _block_lines(child))
            for cell in node.get("content", [])
        ]
        return [" | ".join(cells)] if any(cell.strip() for cell in cells) else []
    return [line for child in node.get("content", []) for line in _block_lines(child)]


def document_text(document: dict) -> str:
    """Plain text of a document for search and excerpts; one line per block."""
    return "\n".join(_block_lines(document))


def document_excerpt(text: str) -> str:
    for line in text.splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        return line[:147].rstrip() + "…" if len(line) > 150 else line
    return ""


def document_asset_ids(document: dict) -> set[str]:
    found: set[str] = set()

    def visit(node: dict) -> None:
        if node.get("type") in {"image", "fileBlock"}:
            asset_id = (node.get("attrs") or {}).get("assetId")
            if isinstance(asset_id, str) and ASSET_ID_RE.match(asset_id):
                found.add(asset_id)
        for child in node.get("content", []) or []:
            if isinstance(child, dict):
                visit(child)

    visit(document)
    return found
