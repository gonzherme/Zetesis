const state = {
  documents: [],
  collections: {},
  results: [],
  folder: "",
  selected: null,
  query: "",
  expanded: new Set(),
  searchTimer: null,
  requestId: 0,
};

const $ = (selector) => document.querySelector(selector);
const folderTree = $("#folder-tree");
const noteList = $("#note-list");
const readerContent = $("#reader-content");
const readerEmpty = $("#reader-empty");

const folderSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v10.8a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M3.5 9h17"/></svg>';
const chevronSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatFolderName(value) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function pathParts(path) {
  return String(path || "").split("/").filter(Boolean);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function buildFolderTree(documents) {
  const roots = new Map();

  for (const [key, label] of Object.entries(state.collections)) {
    roots.set(key, {
      name: label || formatFolderName(key),
      path: key,
      count: 0,
      children: new Map(),
    });
  }

  for (const doc of documents) {
    const colKey = doc.collection || "general";
    let root = roots.get(colKey);
    if (!root) {
      root = { name: formatFolderName(colKey), path: colKey, count: 0, children: new Map() };
      roots.set(colKey, root);
    }
    root.count += 1;

    // Build subfolder hierarchy
    const parts = pathParts(doc.folder);
    const subParts = parts.length > 0 && parts[0] === colKey ? parts.slice(1) : (colKey === "general" ? [] : parts);

    let current = root;
    for (const part of subParts) {
      const childPath = `${current.path}/${part}`;
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: formatFolderName(part),
          path: childPath,
          count: 0,
          children: new Map(),
        });
      }
      current = current.children.get(part);
      current.count += 1;
    }
  }

  folderTree.replaceChildren();
  for (const node of roots.values()) {
    if (node.count > 0) {
      folderTree.append(renderFolderNode(node, 0));
    }
  }
}

function renderFolderNode(node, depth) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-item";
  wrapper.dataset.path = node.path;
  if (state.expanded.has(node.path)) wrapper.classList.add("expanded");

  const row = document.createElement("div");
  row.className = "tree-row";
  if (state.folder === node.path) row.classList.add("selected");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tree-toggle";
  toggle.setAttribute("aria-label", `Toggle ${node.name}`);
  toggle.innerHTML = chevronSvg;
  if (!node.children.size) {
    toggle.style.visibility = "hidden";
  } else {
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (state.expanded.has(node.path)) {
        state.expanded.delete(node.path);
        wrapper.classList.remove("expanded");
      } else {
        state.expanded.add(node.path);
        wrapper.classList.add("expanded");
      }
    });
  }

  const nameBtn = document.createElement("button");
  nameBtn.type = "button";
  nameBtn.className = "tree-name";
  nameBtn.title = node.name;
  nameBtn.innerHTML = `<span class="tree-symbol">${folderSvg}</span><span class="tree-title">${escapeHtml(node.name)}</span>`;
  nameBtn.addEventListener("click", () => {
    state.folder = node.path;
    state.expanded.add(node.path);
    wrapper.classList.add("expanded");
    highlightActiveFolder();
    updateHeading();
    if (state.query) runSearch(state.query);
    else updateList();
  });

  const countSpan = document.createElement("span");
  countSpan.className = "tree-count";
  countSpan.textContent = String(node.count);

  row.append(toggle, nameBtn, countSpan);
  wrapper.append(row);

  if (node.children.size) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "tree-children";
    const sortedChildren = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of sortedChildren) {
      childrenContainer.append(renderFolderNode(child, depth + 1));
    }
    wrapper.append(childrenContainer);
  }

  return wrapper;
}

function highlightActiveFolder() {
  for (const row of folderTree.querySelectorAll(".tree-row")) {
    row.classList.remove("selected");
  }
  if (!state.folder) {
    $("#all-notes").classList.add("active");
  } else {
    $("#all-notes").classList.remove("active");
    const activeItem = folderTree.querySelector(`.tree-item[data-path="${CSS.escape(state.folder)}"] > .tree-row`);
    if (activeItem) activeItem.classList.add("selected");
  }
}

function getVisibleDocuments() {
  const base = state.query ? state.results : state.documents;
  if (!state.folder) return base;

  return base.filter((doc) => {
    if (state.folder === "general") {
      return doc.collection === "general";
    }
    if (doc.collection === state.folder) return true;
    if (doc.folder === state.folder) return true;
    if (doc.folder && doc.folder.startsWith(`${state.folder}/`)) return true;
    return false;
  });
}

function updateHeading() {
  const visible = getVisibleDocuments();
  const count = visible.length;

  let title = "All notes";
  if (state.folder) {
    const parts = state.folder.split("/");
    title = parts.length === 1 && state.collections[parts[0]]
      ? state.collections[parts[0]]
      : formatFolderName(parts.at(-1));
  }

  $("#page-title").textContent = title;
  $("#page-subtitle").textContent = state.query
    ? `Search results for “${state.query}”`
    : state.folder
      ? `Notes in ${title} and subfolders.`
      : "A calm place to browse and search your thinking.";

  $("#result-total").textContent = `${count.toLocaleString()} ${count === 1 ? "NOTE" : "NOTES"}`;
  $("#all-count").textContent = String(state.documents.length);

  // Build clickable breadcrumbs
  const breadcrumb = $("#breadcrumb");
  breadcrumb.replaceChildren();

  const rootLink = document.createElement("a");
  rootLink.className = "breadcrumb-item";
  rootLink.href = "#";
  rootLink.textContent = "ZETESIS";
  rootLink.addEventListener("click", (e) => {
    e.preventDefault();
    selectAllNotes();
  });
  breadcrumb.append(rootLink);

  if (state.folder) {
    const parts = state.folder.split("/");
    let accum = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accum = accum ? `${accum}/${part}` : part;
      const targetPath = accum;

      const sep = document.createElement("span");
      sep.className = "breadcrumb-separator";
      sep.textContent = "/";
      breadcrumb.append(sep);

      const label = i === 0 && state.collections[part]
        ? state.collections[part].toUpperCase()
        : formatFolderName(part).toUpperCase();

      if (i === parts.length - 1) {
        const cur = document.createElement("span");
        cur.className = "breadcrumb-current";
        cur.textContent = label;
        breadcrumb.append(cur);
      } else {
        const link = document.createElement("a");
        link.className = "breadcrumb-item";
        link.href = "#";
        link.textContent = label;
        link.addEventListener("click", (e) => {
          e.preventDefault();
          state.folder = targetPath;
          state.expanded.add(targetPath);
          highlightActiveFolder();
          updateHeading();
          updateList();
        });
        breadcrumb.append(link);
      }
    }
  } else {
    const sep = document.createElement("span");
    sep.className = "breadcrumb-separator";
    sep.textContent = "/";
    const cur = document.createElement("span");
    cur.className = "breadcrumb-current";
    cur.textContent = "ALL NOTES";
    breadcrumb.append(sep, cur);
  }
}

function renderCard(doc) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "note-card";
  card.dataset.path = doc.path;
  if (state.selected && state.selected.path === doc.path) {
    card.classList.add("selected");
    card.setAttribute("aria-current", "true");
  }

  const badge = document.createElement("span");
  badge.className = `file-badge${doc.extension === ".pdf" ? " pdf" : ""}`;
  badge.textContent = doc.extension.slice(1).toUpperCase();

  const copy = document.createElement("span");
  copy.className = "card-copy";

  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = doc.title;

  const excerpt = document.createElement("span");
  excerpt.className = "card-excerpt";
  excerpt.textContent = doc.match || doc.excerpt || doc.path;

  const meta = document.createElement("span");
  meta.className = "card-meta";

  const folderName = doc.folder
    ? doc.folder.split("/").map(formatFolderName).join(" / ")
    : "Root";
  const folderSpan = document.createElement("span");
  folderSpan.textContent = folderName;

  const dateSpan = document.createElement("span");
  dateSpan.textContent = formatDate(doc.modified);

  meta.append(folderSpan, dateSpan);
  copy.append(title, excerpt, meta);
  card.append(badge, copy);

  card.addEventListener("click", () => selectDocument(doc));
  return card;
}

function updateList() {
  const visible = getVisibleDocuments();
  noteList.replaceChildren();
  $("#list-count").textContent = String(visible.length);
  $("#list-label").textContent = state.query ? "SEARCH RESULTS" : "NOTES";

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = state.query ? "No notes matching your search." : "No notes in this folder.";
    noteList.append(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (const doc of visible) {
      fragment.append(renderCard(doc));
    }
    noteList.append(fragment);
  }

  updateHeading();
  if (state.selected && !visible.some((d) => d.path === state.selected.path)) {
    // If selected note is no longer in visible list, keep reader open but unhighlight cards
    for (const c of noteList.querySelectorAll(".note-card")) c.classList.remove("selected");
  }
}

function resolveRelativeTarget(target, docPath) {
  let clean = target.replace(/^file:/i, "").split(/[?#]/, 1)[0];
  try { clean = decodeURIComponent(clean); } catch { /* keep as is */ }
  if (clean.startsWith("/")) return clean.replace(/^\/+/, "");
  const baseDir = docPath.split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") baseDir.pop();
    else baseDir.push(part);
  }
  return baseDir.join("/");
}

function renderInline(raw, docPath) {
  const tokens = [];
  let text = raw;

  const addToken = (html) => {
    const token = `__FIELDNOTES_TOKEN_${tokens.length}__`;
    tokens.push([token, html]);
    return token;
  };

  // 1. Org-mode links: [[target][label]] or [[target]]
  text = text.replace(/\[\[([^\]]+)\](?:\[([^\]]*)\])?\]/g, (_match, target, label) => {
    const isUrl = /^(https?:|mailto:)/i.test(target);
    if (isUrl) {
      return addToken(`<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || target)}</a>`);
    }
    const resolved = resolveRelativeTarget(target, docPath);
    const isImage = /\.(png|jpe?g|gif|svg|webp)$/i.test(resolved);
    if (isImage) {
      return addToken(`<img src="/api/file?path=${encodeURIComponent(resolved)}" alt="${escapeHtml(label || '')}" class="note-img" loading="lazy">`);
    }
    return addToken(`<a href="/?note=${encodeURIComponent(resolved)}">${escapeHtml(label || target)}</a>`);
  });

  // 2. Markdown images: ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, url) => {
    const isUrl = /^(https?:)/i.test(url);
    const src = isUrl ? url : `/api/file?path=${encodeURIComponent(resolveRelativeTarget(url, docPath))}`;
    return addToken(`<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="note-img" loading="lazy">`);
  });

  // 3. Markdown links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, url) => {
    const isUrl = /^(https?:|mailto:)/i.test(url);
    if (isUrl) {
      return addToken(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    }
    const resolved = resolveRelativeTarget(url, docPath);
    return addToken(`<a href="/?note=${encodeURIComponent(resolved)}">${escapeHtml(label)}</a>`);
  });

  // 4. Raw URLs
  text = text.replace(/(https?:\/\/[^\s<>]+)/g, (match) => {
    const trailing = match.match(/[.,;:!?)}\]]+$/)?.[0] || "";
    const cleanUrl = match.slice(0, match.length - trailing.length);
    return addToken(`<a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanUrl)}</a>`) + trailing;
  });

  // Escape remaining HTML
  let html = escapeHtml(text);

  // Inline formatting
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/~([^~]+)~/g, "<code>$1</code>");
  html = html.replace(/=([^=]+)=/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/(?<!\/)\/([^/\n]+)\/(?!\/)/g, "<em>$1</em>");

  // Restore tokens
  for (const [token, markup] of tokens) {
    html = html.replaceAll(token, markup);
  }

  return html;
}

function renderTextDocument(source, doc) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = [];
  let listType = "";
  let blockquote = [];
  let tableRows = [];
  let code = null;
  let firstHeadingSeen = false;

  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${paragraph.map((l) => renderInline(l, doc.path)).join("<br>")}</p>`);
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list.length) {
      output.push(`<${listType}>${list.map((item) => `<li>${renderInline(item, doc.path)}</li>`).join("")}</${listType}>`);
      list = [];
      listType = "";
    }
  };

  const flushBlockquote = () => {
    if (blockquote.length) {
      output.push(`<blockquote><p>${blockquote.map((l) => renderInline(l, doc.path)).join("<br>")}</p></blockquote>`);
      blockquote = [];
    }
  };

  const flushTable = () => {
    if (tableRows.length) {
      const rowsHtml = tableRows.map((row, idx) => {
        const isHeader = idx === 0;
        const tag = isHeader ? "th" : "td";
        const cells = row.split("|").slice(1, -1).map((c) => `<${tag}>${renderInline(c.trim(), doc.path)}</${tag}>`).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      output.push(`<table><tbody>${rowsHtml}</tbody></table>`);
      tableRows = [];
    }
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushBlockquote();
    flushTable();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks (Org & Markdown)
    const orgCodeStart = line.match(/^\s*#\+begin_src(?:\s+(\S+))?/i);
    const mdCodeStart = line.match(/^\s*```(.*)$/);

    if (code) {
      const endCode = code.org ? /^\s*#\+end_src\s*$/i.test(line) : /^\s*```\s*$/.test(line);
      if (endCode) {
        output.push(`<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }

    if (orgCodeStart || mdCodeStart) {
      flushAll();
      code = { org: Boolean(orgCodeStart), lines: [] };
      continue;
    }

    // Skip metadata comments
    if (/^\s*#\+/.test(line) || /^\s*<!--/.test(line)) continue;

    // Headings
    const heading = doc.extension === ".org"
      ? line.match(/^\s*(\*{1,6})\s+(.+?)\s*$/)
      : line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);

    if (heading) {
      flushAll();
      const level = Math.min(6, heading[1].length);
      const text = heading[2].replace(/\s+#+\s*$/, "");
      if (!firstHeadingSeen) {
        output.push(`<h1>${renderInline(text, doc.path)}</h1>`);
        firstHeadingSeen = true;
      } else {
        output.push(`<h${level}>${renderInline(text, doc.path)}</h${level}>`);
      }
      continue;
    }

    // Horizontal rule
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      output.push("<hr>");
      continue;
    }

    // Tables (| col1 | col2 |)
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushBlockquote();
      if (!/^\s*\|[-+\s|]+\|\s*$/.test(line)) {
        tableRows.push(line.trim());
      }
      continue;
    } else if (tableRows.length) {
      flushTable();
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      flushTable();
      blockquote.push(line.replace(/^\s*>\s?/, ""));
      continue;
    } else if (blockquote.length) {
      flushBlockquote();
    }

    // Lists
    const listItem = line.match(/^\s*(?:[-+*]|(\d+)[.)])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      flushBlockquote();
      flushTable();
      const nextType = listItem[1] ? "ol" : "ul";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      list.push(listItem[2]);
      continue;
    } else if (list.length) {
      flushList();
    }

    // Blank line
    if (!line.trim()) {
      flushAll();
      continue;
    }

    paragraph.push(line.trim());
  }

  if (code) output.push(`<pre><code>${escapeHtml(code.lines.join("\n"))}</code></pre>`);
  flushAll();

  if (!firstHeadingSeen && doc.title) {
    output.unshift(`<h1>${escapeHtml(doc.title)}</h1>`);
  }

  return output.join("\n");
}

function clearReader() {
  state.selected = null;
  readerContent.hidden = true;
  readerContent.style.display = "none";
  readerContent.replaceChildren();
  readerEmpty.hidden = false;
  readerEmpty.style.display = "flex";
  for (const card of noteList.querySelectorAll(".note-card")) {
    card.classList.remove("selected");
  }
}

function selectDocument(doc) {
  state.selected = doc;

  for (const card of noteList.querySelectorAll(".note-card")) {
    const isSelected = card.dataset.path === doc.path;
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-current", isSelected ? "true" : "false");
  }

  readerEmpty.hidden = true;
  readerEmpty.style.display = "none";
  readerContent.hidden = false;
  readerContent.style.display = "block";
  readerContent.innerHTML = `
    <div class="reader-toolbar">
      <span class="reader-location">${escapeHtml(doc.path)}</span>
      <span class="reader-actions">
        <span class="reader-type">${escapeHtml(doc.extension.slice(1))}</span>
        <a class="reader-link" href="/api/file?path=${encodeURIComponent(doc.path)}" target="_blank" rel="noopener noreferrer">Open original ↗</a>
      </span>
    </div>
    <div id="document-body"></div>
  `;

  const body = $("#document-body");

  if (doc.extension === ".pdf") {
    const intro = document.createElement("p");
    intro.className = "pdf-intro";
    intro.textContent = "PDF document preview. Use 'Open original ↗' above to open in a dedicated tab.";
    const frame = document.createElement("iframe");
    frame.className = "pdf-preview";
    frame.title = doc.title;
    frame.src = `/api/file?path=${encodeURIComponent(doc.path)}`;
    body.append(intro, frame);
    history.replaceState(null, "", `/?note=${encodeURIComponent(doc.path)}`);
    return;
  }

  body.innerHTML = '<div class="document-article">Loading note…</div>';

  fetch(`/api/document?path=${encodeURIComponent(doc.path)}`)
    .then((res) => {
      if (!res.ok) throw new Error("Could not load note content.");
      return res.json();
    })
    .then((payload) => {
      if (state.selected?.path !== doc.path) return;
      const article = body.querySelector(".document-article");
      article.innerHTML = renderTextDocument(payload.content, doc);
      if (payload.truncated) {
        const note = document.createElement("p");
        note.className = "truncated-note";
        note.textContent = "Document truncated because it exceeds 5 MB.";
        article.append(note);
      }
      history.replaceState(null, "", `/?note=${encodeURIComponent(doc.path)}`);
    })
    .catch((err) => {
      const article = body.querySelector(".document-article");
      if (article) article.textContent = err.message;
    });
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 2200);
}

async function runSearch(query) {
  state.query = query.trim();
  const reqId = ++state.requestId;
  $("#clear-search").hidden = !state.query;
  $("#list-label").textContent = state.query ? "SEARCHING…" : "NOTES";

  const params = new URLSearchParams({ q: state.query, folder: state.folder });
  try {
    const res = await fetch(`/api/search?${params}`);
    if (!res.ok) throw new Error("Search failed.");
    const payload = await res.json();
    if (reqId !== state.requestId) return;
    state.results = state.query ? payload.results : state.documents;
    updateList();
  } catch (err) {
    if (reqId !== state.requestId) return;
    state.results = [];
    updateList();
    showToast(err.message);
  }
}

function selectAllNotes() {
  state.folder = "";
  highlightActiveFolder();
  updateHeading();
  if (state.query) runSearch(state.query);
  else updateList();
}

function applyDeepLink() {
  const targetPath = new URLSearchParams(location.search).get("note");
  if (!targetPath) return;

  const doc = state.documents.find((d) => d.path === targetPath);
  if (!doc) return;

  state.folder = doc.folder || doc.collection;
  state.expanded.add(doc.collection);
  const parts = pathParts(doc.folder);
  let accum = "";
  for (const part of parts) {
    accum = accum ? `${accum}/${part}` : part;
    state.expanded.add(accum);
  }

  buildFolderTree(state.documents);
  highlightActiveFolder();
  updateHeading();
  updateList();
  selectDocument(doc);
}

async function initialize() {
  try {
    const res = await fetch("/api/catalog");
    if (!res.ok) throw new Error("Could not load notes catalog.");
    const payload = await res.json();

    state.documents = payload.documents;
    state.collections = payload.collections || {};
    state.results = payload.documents;

    // Auto-expand top-level collections
    for (const key of Object.keys(state.collections)) {
      state.expanded.add(key);
    }

    buildFolderTree(state.documents);
    updateList();

    if (new URLSearchParams(location.search).has("note")) {
      applyDeepLink();
    } else if (state.documents.length) {
      selectDocument(state.documents[0]);
    }
  } catch (err) {
    noteList.innerHTML = `<div class="empty-list">${escapeHtml(err.message)}</div>`;
  }
}

// Event Listeners
$("#all-notes").addEventListener("click", selectAllNotes);

$("#search-input").addEventListener("input", (e) => {
  window.clearTimeout(state.searchTimer);
  const q = e.target.value;
  state.searchTimer = window.setTimeout(() => runSearch(q), q.trim() ? 150 : 0);
});

$("#clear-search").addEventListener("click", () => {
  $("#search-input").value = "";
  runSearch("");
  $("#search-input").focus();
});

$("#refresh-button").addEventListener("click", async () => {
  const btn = $("#refresh-button");
  btn.disabled = true;
  try {
    const res = await fetch("/api/catalog", { cache: "no-store" });
    if (!res.ok) throw new Error("Refresh failed.");
    const payload = await res.json();
    state.documents = payload.documents;
    state.collections = payload.collections || {};
    state.results = state.query ? state.results : payload.documents;

    buildFolderTree(state.documents);
    highlightActiveFolder();

    if (state.query) await runSearch(state.query);
    else updateList();

    showToast("Notes refreshed from disk");
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#search-input").focus();
  }
  if (e.key === "Escape" && document.activeElement === $("#search-input")) {
    $("#search-input").value = "";
    runSearch("");
    $("#search-input").blur();
  }
});

window.addEventListener("popstate", () => {
  const targetPath = new URLSearchParams(location.search).get("note");
  const doc = state.documents.find((d) => d.path === targetPath);
  if (doc) selectDocument(doc);
  else clearReader();
});

initialize();
