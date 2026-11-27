"""Convert legacy Org/Markdown note bodies into block editor documents.

Coverage follows the constructs actually used in Zetesis notes: headings,
paragraphs, nested bulleted/numbered lists, checklists, quotes (`>` lines and
Org quote blocks), tables, source/fenced code blocks, horizontal rules, Org and
Markdown links, local and remote images (with Org `#+ATTR_*: :width`), raw
URLs, and inline emphasis. Anything else — other directives, drawers, comments,
unknown block types, unsupported link types — is kept verbatim in a visible
`rawSource` block or as literal text, so no source is dropped.

The conversion is deterministic: block IDs derive from the note path and the
order in which blocks are created.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, unquote

from blocks import HTTP_URL_RE, LANGUAGE_RE, is_allowed_href

CONVERTER_VERSION = 1

IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")
NOTE_SUFFIXES = (".org", ".md", ".pdf")
MARK_ORDER = ("link", "bold", "code", "italic", "strike", "underline", "highlight")

BEGIN_RE = re.compile(r"^\s*#\+begin_(\w+)(.*)$", re.I)
FENCE_RE = re.compile(r"^(\s*)(`{3,})\s*([^\s`]*)(.*)$")
DIRECTIVE_RE = re.compile(r"^\s*#\+\S")
KEYWORD_RE = re.compile(r"^\s*#\+(\w+)(?:\[[^\]]*\])?:\s*(.*?)\s*$")
DRAWER_RE = re.compile(r"^\s*:([A-Za-z][\w-]*):\s*$")
DRAWER_END_RE = re.compile(r"^\s*:END:\s*$", re.I)
ORG_HEADING_RE = re.compile(r"^(\*+)\s+(\S.*?)\s*$")
MD_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$")
HR_RE = re.compile(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$")
TABLE_RE = re.compile(r"^\s*\|")
TABLE_RULE_RE = re.compile(r"^\|[-+:|\s]*-[-+:|\s]*$")
QUOTE_RE = re.compile(r"^\s*>")
LIST_RE = re.compile(r"^(?P<indent>[ \t]*)(?P<marker>[-+*]|\d{1,9}[.)])(?:[ \t]+(?P<text>.*?)|[ \t]*)$")
CHECKBOX_RE = re.compile(r"^\[([ xX])\](?:[ \t]+(.*))?$")
ORG_LINK_RE = re.compile(r"\[\[([^\]]+)\](?:\[([^\]]*)\])?\]")
MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
AUTOLINK_RE = re.compile(r"<(https?://[^>\s]+)>")
URL_RE = re.compile(r"https?://[^\s<>]+", re.I)
WIDTH_RE = re.compile(r":width\s+(\d{1,5})(?:px)?", re.I)

ORG_MARKERS = {"*": "bold", "/": "italic", "_": "underline", "+": "strike", "=": "code", "~": "code"}
ORG_PRE = set(" \t-('\"{")
ORG_POST = set(" \t-.,;:!?')}\"[\\")


@dataclass
class ListMatch:
    indent: int
    kind: str
    number: int
    text: str
    content_column: int


@dataclass
class ConversionReport:
    raw_blocks: list[str] = field(default_factory=list)
    literal_links: list[str] = field(default_factory=list)
    title_directive: bool = False
    title_heading: bool = False
    images: int = 0
    missing_images: list[str] = field(default_factory=list)
    note_links: int = 0
    web_links: int = 0
    tables: int = 0
    code_blocks: int = 0
    lists: int = 0

    @property
    def uses_fallback(self) -> bool:
        return bool(self.raw_blocks or self.literal_links)


def _columns(whitespace: str, tab_width: int) -> int:
    column = 0
    for character in whitespace:
        column = (column // tab_width + 1) * tab_width if character == "\t" else column + 1
    return column


def _leading(line: str) -> str:
    return line[: len(line) - len(line.lstrip(" \t"))]


def _dedent_columns(line: str, columns: int, tab_width: int) -> str:
    """Remove up to `columns` columns of leading whitespace."""
    column = 0
    index = 0
    while index < len(line) and line[index] in " \t" and column < columns:
        column = (column // tab_width + 1) * tab_width if line[index] == "\t" else column + 1
        index += 1
    return " " * max(0, column - columns) + line[index:]


def _strip_common_indent(lines: list[str]) -> list[str]:
    prefixes = [_leading(line) for line in lines if line.strip()]
    if not prefixes:
        return lines
    common = prefixes[0]
    for prefix in prefixes[1:]:
        while not prefix.startswith(common):
            common = common[:-1]
    if not common:
        return lines
    return [line[len(common):] if line.startswith(common) else line.lstrip(" \t") for line in lines]


def _encode_uri_component(value: str) -> str:
    return quote(value, safe="-_.!~*'()")


class LegacyConverter:
    def __init__(self, note_path: str, extension: str, title: str, notes_dir: Path | None = None):
        self.note_path = note_path
        self.org = extension.lower() == ".org"
        self.format = "org" if self.org else "md"
        self.tab_width = 8 if self.org else 4
        self.title = title
        self.notes_dir = notes_dir
        self.report = ConversionReport()
        self._block_count = 0

    # Nodes ---------------------------------------------------------------

    def _id(self) -> str:
        self._block_count += 1
        key = f"{self.note_path}\0{self._block_count}".encode("utf-8")
        return hashlib.blake2b(key, digest_size=6).hexdigest()

    def _node(self, node_type: str, content: list[dict] | None = None, **attrs) -> dict:
        node = {"type": node_type, "attrs": {"id": self._id(), **attrs}}
        if content:
            node["content"] = content
        return node

    def _raw(self, lines: list[str]) -> dict:
        text = "\n".join(lines)
        self.report.raw_blocks.append(text if len(text) <= 160 else text[:157] + "…")
        return self._node("rawSource", [{"type": "text", "text": text}] if text else None, format=self.format)

    def _code(self, lines: list[str], language: str | None) -> dict:
        self.report.code_blocks += 1
        text = "\n".join(_strip_common_indent(lines))
        return self._node("codeBlock", [{"type": "text", "text": text}] if text else None, language=language or None)

    @staticmethod
    def _text(text: str, marks: tuple[dict, ...]) -> list[dict]:
        if not text:
            return []
        by_type: dict[str, dict] = {}
        for mark in marks:
            by_type.setdefault(mark["type"], mark)
        # Inline code excludes all other marks in the editor; a link outranks it.
        if "code" in by_type and len(by_type) > 1:
            by_type = {key: value for key, value in by_type.items() if key != "code"} if "link" in by_type else {"code": by_type["code"]}
        node = {"type": "text", "text": text}
        if by_type:
            node["marks"] = [by_type[name] for name in MARK_ORDER if name in by_type]
        return [node]

    # Document ------------------------------------------------------------

    def convert(self, content: str) -> dict:
        lines = content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        blocks = self._drop_title_heading(self._blocks(lines, top=True))
        return {"type": "doc", "content": blocks or [self._node("paragraph")]}

    def _drop_title_heading(self, blocks: list[dict]) -> list[dict]:
        """The note title is shown above the body; drop a leading heading that repeats it."""
        normalize = lambda value: " ".join(value.split()).casefold()  # noqa: E731
        for index, block in enumerate(blocks):
            if block["type"] == "rawSource":
                continue
            if block["type"] == "heading":
                content = block.get("content", [])
                plain = all(child["type"] == "text" and not child.get("marks") for child in content)
                text = "".join(child.get("text", "") for child in content)
                if plain and text and normalize(text) == normalize(self.title):
                    self.report.title_heading = True
                    return blocks[:index] + blocks[index + 1:]
            break
        return blocks

    # Blocks --------------------------------------------------------------

    def _blocks(self, lines: list[str], *, top: bool = False, nested: bool = False, first_is_text: bool = False) -> list[dict]:
        out: list[dict] = []
        paragraph: list[str] = []
        raw: list[str] = []
        pending_attr: tuple[str, int] | None = None

        def emit(nodes: list[dict]) -> None:
            nonlocal pending_attr
            if pending_attr is not None:
                source, width = pending_attr
                pending_attr = None
                # Org attaches #+ATTR_* to the next element; for a paragraph that
                # is the image inside it (now split out as its own block).
                image = next((node for node in nodes if node["type"] == "image"), None)
                if image is not None and nodes[0]["type"] in {"image", "paragraph"}:
                    image["attrs"]["width"] = width
                else:
                    out.append(self._raw([source]))
            out.extend(nodes)

        def flush_paragraph() -> None:
            if paragraph:
                emit(self._paragraph_blocks(paragraph))
                paragraph.clear()

        def flush_raw() -> None:
            if raw:
                out.append(self._raw(raw))
                raw.clear()

        def flush() -> None:
            flush_paragraph()
            flush_raw()

        index = 0
        count = len(lines)
        while index < count:
            line = lines[index]
            stripped = line.strip()

            if first_is_text and index == 0:
                if stripped:
                    paragraph.append(stripped)
                index += 1
                continue

            if not stripped:
                flush()
                index += 1
                continue

            begin = BEGIN_RE.match(line)
            if begin:
                end = self._block_end(lines, index, begin.group(1))
                if end is not None or begin.group(1).lower() == "src":
                    flush()
                    stop = end if end is not None else count
                    source = lines[index: stop + 1] if end is not None else lines[index:]
                    emit(self._begin_block(begin, lines[index + 1: stop], source))
                    index = stop + 1
                    continue

            fence = FENCE_RE.match(line)
            if fence:
                flush()
                marker = fence.group(2)
                end = next((position for position in range(index + 1, count)
                            if lines[position].strip().startswith(marker[0] * len(marker))
                            and not lines[position].strip().strip(marker[0])), None)
                stop = end if end is not None else count
                language = fence.group(3) if LANGUAGE_RE.match(fence.group(3)) and not fence.group(4).strip() else None
                if fence.group(3) and language is None:
                    out.append(self._raw(lines[index: stop + 1]))
                else:
                    emit([self._code(lines[index + 1: stop], language)])
                index = stop + 1
                continue

            if DIRECTIVE_RE.match(line):
                flush_paragraph()
                keyword = KEYWORD_RE.match(line)
                name = keyword.group(1).lower() if keyword else ""
                value = keyword.group(2) if keyword else ""
                width = WIDTH_RE.fullmatch(value) if name.startswith("attr_") else None
                if name == "title" and top and not self.report.title_directive and value == self.title.strip():
                    self.report.title_directive = True
                elif width and 0 < int(width.group(1)) <= 10_000:
                    flush_raw()
                    if pending_attr is not None:
                        out.append(self._raw([pending_attr[0]]))
                    pending_attr = (line, int(width.group(1)))
                else:
                    raw.append(line)
                index += 1
                continue

            if stripped.startswith("<!--"):
                flush()
                end = next((position for position in range(index, count) if "-->" in lines[position]), index)
                out.append(self._raw(lines[index: end + 1]))
                index = end + 1
                continue

            drawer = DRAWER_RE.match(line) if self.org else None
            if drawer and drawer.group(1).upper() != "END":
                end = None
                for position in range(index + 1, count):
                    if DRAWER_END_RE.match(lines[position]):
                        end = position
                        break
                    if ORG_HEADING_RE.match(lines[position]):
                        break
                if end is not None:
                    flush()
                    out.append(self._raw(lines[index: end + 1]))
                    index = end + 1
                    continue

            heading = None if nested else self._heading(line)
            if heading:
                flush()
                level, text = heading
                emit([self._node("heading", self._heading_inline(text), level=level)])
                index += 1
                continue

            if HR_RE.match(line):
                flush()
                emit([self._node("horizontalRule")])
                index += 1
                continue

            if TABLE_RE.match(line):
                flush()
                end = index
                while end < count and TABLE_RE.match(lines[end]):
                    end += 1
                emit([self._table(lines[index:end])])
                index = end
                continue

            if QUOTE_RE.match(line):
                flush()
                end = index
                while end < count and QUOTE_RE.match(lines[end]):
                    end += 1
                inner = [re.sub(r"^\s*>\s?", "", source) for source in lines[index:end]]
                emit([self._node("blockquote", self._blocks(inner) or [self._node("paragraph")])])
                index = end
                continue

            if self._list_item(line, nested):
                flush()
                node, index = self._list(lines, index, nested)
                emit([node])
                continue

            paragraph.append(stripped)
            index += 1

        flush()
        if pending_attr is not None:
            out.append(self._raw([pending_attr[0]]))
        return out

    @staticmethod
    def _block_end(lines: list[str], start: int, name: str) -> int | None:
        end_re = re.compile(rf"^\s*#\+end_{re.escape(name)}\s*$", re.I)
        return next((index for index in range(start + 1, len(lines)) if end_re.match(lines[index])), None)

    def _begin_block(self, begin: re.Match, body: list[str], source: list[str]) -> list[dict]:
        name = begin.group(1).lower()
        arguments = begin.group(2).split()
        if name == "src" and len(arguments) <= 1 and (not arguments or LANGUAGE_RE.match(arguments[0])):
            return [self._code(body, arguments[0] if arguments else None)]
        if name == "quote" and not arguments:
            inner = self._blocks(_strip_common_indent(body))
            return [self._node("blockquote", inner or [self._node("paragraph")])]
        return [self._raw(source)]

    def _heading(self, line: str) -> tuple[int, str] | None:
        if self.org:
            match = ORG_HEADING_RE.match(line)
        else:
            match = MD_HEADING_RE.match(line)
        if not match:
            return None
        return min(6, len(match.group(1))), match.group(2)

    def _list_item(self, line: str, nested: bool) -> ListMatch | None:
        match = LIST_RE.match(line)
        if not match:
            return None
        indent_text = match.group("indent")
        marker = match.group("marker")
        # An Org star at the first column is a heading, never a bullet.
        if self.org and marker == "*" and not indent_text and not nested:
            return None
        indent = _columns(indent_text, self.tab_width)
        text = match.group("text") or ""
        after_marker = line[len(indent_text) + len(marker):]
        gap = len(after_marker) - len(after_marker.lstrip(" \t")) if text else 1
        ordered = marker[0].isdigit()
        return ListMatch(
            indent=indent,
            kind="ordered" if ordered else "bullet",
            number=int(marker[:-1]) if ordered else 1,
            text=text,
            content_column=indent + len(marker) + max(1, gap),
        )

    def _list(self, lines: list[str], index: int, nested: bool) -> tuple[dict, int]:
        first = self._list_item(lines[index], nested)
        items: list[tuple[ListMatch, list[str]]] = []
        count = len(lines)
        while index < count:
            match = self._list_item(lines[index], nested)
            if not match or match.indent != first.indent or match.kind != first.kind:
                break
            content = [match.text]
            position = index + 1
            blanks = 0
            while position < count:
                line = lines[position]
                if not line.strip():
                    blanks += 1
                    position += 1
                    if self.org and blanks >= 2:
                        break
                    continue
                if _columns(_leading(line), self.tab_width) <= first.indent:
                    break
                # Keep a block's lines with the item even where they are less indented.
                stop = position
                begin = BEGIN_RE.match(line)
                if begin:
                    stop = self._block_end(lines, position, begin.group(1)) or position
                content.extend([""] * blanks)
                blanks = 0
                content.extend(_dedent_columns(lines[offset], match.content_column, self.tab_width)
                               for offset in range(position, stop + 1))
                position = stop + 1
            items.append((match, content))
            index = position
            if self.org and blanks >= 2:
                break

        is_task = all(CHECKBOX_RE.match(content[0]) for _match, content in items)
        children = []
        for _match, content in items:
            checked = False
            if is_task:
                checkbox = CHECKBOX_RE.match(content[0])
                checked = checkbox.group(1) in "xX"
                content = [checkbox.group(2) or "", *content[1:]]
            blocks = self._blocks(content, nested=True, first_is_text=True)
            if not blocks or blocks[0]["type"] != "paragraph":
                blocks.insert(0, self._node("paragraph"))
            children.append(self._node("taskItem", blocks, checked=checked) if is_task else self._node("listItem", blocks))

        self.report.lists += 1
        if is_task:
            return self._node("taskList", children), index
        if first.kind == "ordered":
            return self._node("orderedList", children, start=first.number), index
        return self._node("bulletList", children), index

    def _table(self, lines: list[str]) -> dict:
        rows = []
        for line in lines:
            row = line.strip()
            if TABLE_RULE_RE.match(row):
                continue
            row = row[1:]
            if row.endswith("|"):
                row = row[:-1]
            rows.append([cell.strip() for cell in row.split("|")])
        if not rows:
            return self._raw(lines)
        width = max(len(row) for row in rows)
        table_rows = []
        for row_index, cells in enumerate(rows):
            cell_type = "tableHeader" if row_index == 0 else "tableCell"
            row_cells = []
            for cell in cells + [""] * (width - len(cells)):
                blocks = self._paragraph_blocks([cell]) if cell else []
                row_cells.append({"type": cell_type, "content": blocks or [self._node("paragraph")]})
            table_rows.append({"type": "tableRow", "content": row_cells})
        self.report.tables += 1
        return self._node("table", table_rows)

    # Paragraphs ----------------------------------------------------------

    def _paragraph_blocks(self, lines: list[str]) -> list[dict]:
        """A paragraph's lines joined by line breaks, split around images."""
        inline: list[dict] = []
        for position, line in enumerate(lines):
            if position:
                inline.append({"type": "hardBreak"})
            inline.extend(self._inline(line))

        blocks: list[dict] = []
        current: list[dict] = []

        def close() -> None:
            while current and current[0]["type"] == "hardBreak":
                current.pop(0)
            while current and current[-1]["type"] == "hardBreak":
                current.pop()
            if current and current[0]["type"] == "text":
                current[0] = {**current[0], "text": current[0]["text"].lstrip()}
            if current and current[-1]["type"] == "text":
                current[-1] = {**current[-1], "text": current[-1]["text"].rstrip()}
            merged: list[dict] = []
            for node in current:
                if node["type"] == "text" and not node["text"]:
                    continue
                if merged and node["type"] == "text" and merged[-1]["type"] == "text" \
                        and merged[-1].get("marks") == node.get("marks"):
                    merged[-1] = {**merged[-1], "text": merged[-1]["text"] + node["text"]}
                else:
                    merged.append(node)
            if merged:
                blocks.append(self._node("paragraph", merged))
            current.clear()

        for node in inline:
            if node["type"] == "image":
                close()
                blocks.append({"type": "image", "attrs": {"id": self._id(), **node["attrs"]}})
            else:
                current.append(node)
        close()
        return blocks

    def _heading_inline(self, text: str) -> list[dict]:
        nodes = []
        for node in self._inline(text):
            if node["type"] == "image":
                attrs = node["attrs"]
                href = attrs.get("src") or f"/api/file?path={_encode_uri_component(attrs['path'])}"
                label = attrs.get("alt") or (attrs.get("path") or attrs.get("src", "")).rsplit("/", 1)[-1]
                nodes.extend(self._text(label, ({"type": "link", "attrs": {"href": href}},)))
            else:
                nodes.append(node)
        return nodes

    # Inline --------------------------------------------------------------

    def _inline(self, text: str, marks: tuple[dict, ...] = (), in_link: bool = False) -> list[dict]:
        nodes: list[dict] = []
        buffer: list[str] = []
        index = 0
        length = len(text)
        while index < length:
            character = text[index]
            matched = None
            if character == "[" and not in_link:
                matched = self._org_link(text, index, marks) or self._md_link(text, index, marks)
            elif character == "!" and not in_link and text.startswith("![", index):
                matched = self._md_image(text, index, marks)
            elif character == "<" and not in_link and not self.org:
                autolink = AUTOLINK_RE.match(text, index)
                if autolink:
                    matched = autolink.end(), self._web_link(autolink.group(1), autolink.group(1), marks)
            elif character in "hH" and not in_link and (index == 0 or not text[index - 1].isalnum()):
                matched = self._raw_url(text, index, marks)
            elif character == "`":
                matched = self._code_span(text, index, marks)
            elif character in "*_~=/+":
                matched = self._emphasis(text, index, marks, in_link)
            if matched:
                nodes.extend(self._text("".join(buffer), marks))
                buffer.clear()
                index, produced = matched
                nodes.extend(produced)
                continue
            buffer.append(character)
            index += 1
        nodes.extend(self._text("".join(buffer), marks))
        return nodes

    def _resolve(self, target: str) -> str | None:
        """Resolve a link target relative to the note, as the old reader did."""
        clean = re.split(r"[?#]", target, maxsplit=1)[0]
        decoded = unquote(clean)
        candidates = []
        for value in dict.fromkeys([decoded, clean]):
            if value.startswith("/"):
                parts = [part for part in value.lstrip("/").split("/") if part and part != "."]
            else:
                parts = self.note_path.split("/")[:-1]
                for part in value.split("/"):
                    if not part or part == ".":
                        continue
                    if part == "..":
                        if parts:
                            parts.pop()
                    else:
                        parts.append(part)
            path = "/".join(parts)
            if parts and ".." not in parts and "\\" not in path and "\x00" not in path:
                candidates.append(path)
        if not candidates:
            return None
        # Some files keep percent-escapes in their names; prefer whichever exists.
        if self.notes_dir is not None:
            for candidate in candidates:
                if (self.notes_dir / candidate).is_file():
                    return candidate
        return candidates[0]

    def _link_target(self, target: str) -> tuple[str, str] | None:
        value = target.strip()
        if re.match(r"(?i)^(https?|mailto):", value):
            return ("web", value) if is_allowed_href(value) else None
        if value.lower().startswith("file:"):
            value = value[5:]
        elif re.match(r"^[A-Za-z][\w+.-]*:", value):
            return None
        value, _separator, search = value.partition("::")
        if not value:
            return None
        path = self._resolve(value)
        if path is None:
            return None
        lower = path.lower()
        if lower.endswith(IMAGE_SUFFIXES):
            return "image", path
        # An Org search option ("file.org::*Heading") is kept as the fragment.
        fragment = f"#{_encode_uri_component(search)}" if search else ""
        if lower.endswith(NOTE_SUFFIXES):
            return "note", f"/?note={_encode_uri_component(path)}{fragment}"
        return "file", f"/api/file?path={_encode_uri_component(path)}{fragment}"

    def _image(self, attrs: dict) -> list[dict]:
        self.report.images += 1
        path = attrs.get("path")
        if path and self.notes_dir is not None and not (self.notes_dir / path).is_file():
            self.report.missing_images.append(path)
        return [{"type": "image", "attrs": attrs}]

    def _web_link(self, href: str, label: str, marks: tuple[dict, ...]) -> list[dict]:
        self.report.web_links += 1
        return self._inline(label, marks + ({"type": "link", "attrs": {"href": href}},), in_link=True)

    def _linked(self, kind: str, href: str, label: str, marks: tuple[dict, ...]) -> list[dict]:
        if kind == "note":
            self.report.note_links += 1
        elif kind == "web":
            self.report.web_links += 1
        return self._inline(label, marks + ({"type": "link", "attrs": {"href": href}},), in_link=True)

    def _literal(self, source: str, marks: tuple[dict, ...]) -> list[dict]:
        self.report.literal_links.append(source)
        return self._text(source, marks)

    def _org_link(self, text: str, index: int, marks: tuple[dict, ...]):
        match = ORG_LINK_RE.match(text, index)
        if not match:
            return None
        target, label = match.group(1), match.group(2)
        resolved = self._link_target(target)
        if resolved is None:
            return match.end(), self._literal(match.group(0), marks)
        kind, value = resolved
        if kind == "image":
            return match.end(), self._image({"path": value, "alt": label or ""})
        return match.end(), self._linked(kind, value, label or target, marks)

    def _md_link(self, text: str, index: int, marks: tuple[dict, ...]):
        # "items[i](x)" is code, not a link.
        if index > 0 and (text[index - 1].isalnum() or text[index - 1] in ")]"):
            return None
        match = MD_LINK_RE.match(text, index)
        if not match:
            return None
        label, url = match.group(1), match.group(2)
        resolved = self._link_target(url)
        if resolved is None:
            return match.end(), self._literal(match.group(0), marks)
        kind, value = resolved
        if kind == "image":
            kind, value = "file", f"/api/file?path={_encode_uri_component(value)}"
        return match.end(), self._linked(kind, value, label, marks)

    def _md_image(self, text: str, index: int, marks: tuple[dict, ...]):
        match = MD_IMAGE_RE.match(text, index)
        if not match:
            return None
        alt, url = match.group(1), match.group(2)
        if HTTP_URL_RE.match(url):
            return match.end(), self._image({"src": url, "alt": alt})
        resolved = self._link_target(url)
        if resolved is None or resolved[0] != "image":
            return match.end(), self._literal(match.group(0), marks)
        return match.end(), self._image({"path": resolved[1], "alt": alt})

    def _raw_url(self, text: str, index: int, marks: tuple[dict, ...]):
        match = URL_RE.match(text, index)
        if not match:
            return None
        url = match.group(0)
        # Trailing punctuation ends the sentence, not the URL; keep balanced ")".
        while url and url[-1] in ".,;:!?)}]":
            if url[-1] == ")" and url.count("(") >= url.count(")"):
                break
            url = url[:-1]
        if not url or not is_allowed_href(url) or url.endswith("://"):
            return None
        return index + len(url), self._web_link(url, url, marks)

    def _code_span(self, text: str, index: int, marks: tuple[dict, ...]):
        run = len(text[index:]) - len(text[index:].lstrip("`"))
        fence = "`" * run
        search = index + run
        while True:
            end = text.find(fence, search)
            if end == -1:
                return index + run, self._text(fence, marks)
            after = end + run
            if after < len(text) and text[after] == "`":
                search = after + len(text[after:]) - len(text[after:].lstrip("`"))
                continue
            break
        body = text[index + run: end]
        if len(body) > 2 and body.startswith(" ") and body.endswith(" ") and body.strip():
            body = body[1:-1]
        if not body:
            return end + run, self._text(text[index: end + run], marks)
        return end + run, self._text(body, marks + ({"type": "code"},))

    def _emphasis(self, text: str, index: int, marks: tuple[dict, ...], in_link: bool):
        character = text[index]
        length = len(text)

        # Markdown double markers; Org notes use **bold** too and the old reader rendered it.
        for marker, mark in (("**", "bold"), ("__", "bold"), ("~~", "strike")):
            if not text.startswith(marker, index):
                continue
            if marker != "**" and self.org:
                break
            body_start = index + 2
            if body_start < length and not text[body_start].isspace():
                end = body_start
                while True:
                    end = text.find(marker, end + 1)
                    if end == -1:
                        break
                    if not text[end - 1].isspace() and (marker != "__" or end + 2 >= length or not text[end + 2].isalnum()):
                        inner = self._inline(text[body_start:end], marks + ({"type": mark},), in_link)
                        return end + 2, inner
            # An unmatched double marker stays literal rather than opening single emphasis.
            return index + 2, self._text(marker, marks)

        if not self.org:
            if character not in "*_":
                return None
            if character == "_" and index > 0 and text[index - 1].isalnum():
                return None
            if index + 1 >= length or text[index + 1].isspace():
                return None
            end = index + 1
            while True:
                end = text.find(character, end + 1)
                if end == -1:
                    return None
                if text[end - 1].isspace():
                    continue
                if character == "_" and end + 1 < length and text[end + 1].isalnum():
                    continue
                return end + 1, self._inline(text[index + 1:end], marks + ({"type": "italic"},), in_link)

        mark = ORG_MARKERS.get(character)
        if mark is None:
            return None
        if index > 0 and text[index - 1] not in ORG_PRE:
            return None
        if index + 1 >= length or text[index + 1].isspace():
            return None
        end = index + 1
        while True:
            end = text.find(character, end + 1)
            if end == -1:
                return None
            if not text[end - 1].isspace() and (end + 1 == length or text[end + 1] in ORG_POST):
                break
        body = text[index + 1:end]
        if mark == "code":
            return end + 1, self._text(body, marks + ({"type": "code"},))
        return end + 1, self._inline(body, marks + ({"type": mark},), in_link)


def convert_legacy_note(content: str, *, note_path: str, extension: str, title: str,
                        notes_dir: Path | None = None) -> tuple[dict, ConversionReport]:
    converter = LegacyConverter(note_path, extension, title, notes_dir)
    document = converter.convert(content)
    return document, converter.report
