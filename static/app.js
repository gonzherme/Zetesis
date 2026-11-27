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
  documentRequestId: 0,
  view: "home",
  roadmap: null,
  roadmapTopic: "",
  roadmapTopicFromIndex: false,
  draggedNotePath: "",
  draggedFolderPath: "",
  // Folders inside topics, in sidebar order: [{ path, label }].
  folders: [],
  folderLabels: new Map(),
  editorSession: null,
  selectedPayload: null,
  // Path → promise of the save in flight, so reopening a note waits for it.
  pendingSaves: new Map(),
  // Path → edits whose background save failed after their note was closed.
  unsavedDrafts: new Map(),
};

const $ = (selector) => document.querySelector(selector);
const folderTree = $("#folder-tree");
const noteList = $("#note-list");
const noteViewer = $("#note-viewer");
const readerContent = $("#reader-content");
const searchBar = $("#search-bar-container");
const workspaceGrid = $("#workspace-grid");
const roadmapView = $("#roadmap-view");
const pageHeading = $("#page-heading");
const homeHeading = $("#home-heading");
const homeSuggestions = $("#home-suggestions");
const appShell = $(".app-shell");
const roadmapTopics = $("#roadmap-topics");
const contextMenu = $("#context-menu");
const helpOverlay = $("#help");
const searchInput = $("#search-input");
const pageMenuButton = $("#page-menu");
const navRoadmap = $("#nav-roadmap");
const navMap = $("#nav-map");
const mapZoom = $("#map-zoom");
const navFollowing = $("#nav-following");
const navSearch = $("#nav-search");
const AUTOSAVE_DELAY_MS = 800;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.4.299/";
let pdfjsModulePromise = null;
let activePdfViewer = null;

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

const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
// Symbols beside search results on the start page (notes show their file type instead).
const HOME_RESULT_ICONS = {
  folder: folderSvg,
  explore: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m14.8 9.2-1.6 4-4 1.6 1.6-4z"/></svg>',
  following: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5a13 13 0 0 1 13 13M5.5 11a7.5 7.5 0 0 1 7.5 7.5"/><circle cx="6.5" cy="17.5" r="1"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="7" height="5" rx="1.5"/><rect x="13.5" y="14" width="7" height="5" rx="1.5"/><path d="M10.5 7.5h3a2 2 0 0 1 2 2V14"/></svg>',
  area: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7h10M9 12h10M9 17h10M5 7h.01M5 12h.01M5 17h.01"/></svg>',
  item: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="m9 12.3 2.1 2.1 3.9-3.9"/></svg>',
};
const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10.5 11v5.5M13.5 11v5.5"/></svg>';

// ── Menus and in-place editing ───────────────────────────────────────────────

let closeContextMenu = null;

// A menu at the pointer (`at` is a mouse event) or under a button (`at` is the
// element). Items are { label, onPick, detail, title, danger, disabled },
// { heading }, or "-" for a divider.
function openMenu(at, items) {
  closeMenu();
  contextMenu.replaceChildren();
  for (const item of items) {
    if (item === "-") {
      contextMenu.append(document.createElement("hr"));
      continue;
    }
    if (item.heading) {
      const heading = document.createElement("div");
      heading.className = "menu-heading";
      heading.textContent = item.heading;
      contextMenu.append(heading);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `menu-item${item.danger ? " danger" : ""}`;
    button.setAttribute("role", "menuitem");
    button.disabled = Boolean(item.disabled);
    if (item.title) button.title = item.title;
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(label);
    if (item.detail) {
      const detail = document.createElement("small");
      detail.textContent = item.detail;
      button.append(detail);
    }
    button.addEventListener("click", () => {
      closeMenu();
      item.onPick();
    });
    contextMenu.append(button);
  }

  contextMenu.hidden = false;
  const anchor = at instanceof Element ? at.getBoundingClientRect() : null;
  const { offsetWidth: width, offsetHeight: height } = contextMenu;
  let left = anchor ? anchor.right - width : at.clientX;
  let top = anchor ? anchor.bottom + 4 : at.clientY;
  if (top + height > innerHeight - 8) top = (anchor ? anchor.top - 4 : at.clientY) - height;
  contextMenu.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  contextMenu.style.top = `${Math.max(8, top)}px`;

  const buttons = () => [...contextMenu.querySelectorAll(".menu-item:not(:disabled)")];
  const onPointer = (event) => {
    if (!contextMenu.contains(event.target)) closeMenu();
  };
  const onScroll = (event) => {
    if (!contextMenu.contains(event.target)) closeMenu();
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || stepKey(event)) {
      event.preventDefault();
      const list = buttons();
      const index = list.indexOf(document.activeElement);
      const step = stepKey(event) || (event.key === "ArrowDown" ? 1 : -1);
      const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
      list[next]?.focus();
    } else if (event.key === "Tab") {
      closeMenu();
    }
  };
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
  closeContextMenu = () => {
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("blur", closeMenu);
    window.removeEventListener("resize", closeMenu);
    contextMenu.hidden = true;
    closeContextMenu = null;
  };
  // Opened from a button: start on the first item. At the pointer, ↓ or ⌃N picks it.
  if (anchor) buttons()[0]?.focus();
}

function closeMenu() {
  closeContextMenu?.();
}

// Edit `element`'s text in place. `commit` gets the new text, "" if it was
// cleared, or null if editing was cancelled with Escape.
function editInline(element, text, commit, { selectAll = true } = {}) {
  element.textContent = text;
  element.contentEditable = "plaintext-only";
  element.spellcheck = false;
  element.focus();
  const selection = getSelection();
  selection.selectAllChildren(element);
  if (!selectAll) selection.collapseToEnd();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    element.removeAttribute("contenteditable");
    commit(save ? element.textContent.replace(/\s+/g, " ").trim() : null);
  };
  element.addEventListener("keydown", (event) => {
    const step = stepKey(event);
    if (event.key === "Enter" || step) {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
      if (step) moveNav(step);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
  element.addEventListener("blur", () => finish(true), { once: true });
}

// The ⋯ button beside the page title, for the folder or area on screen.
let pageMenuItems = null;

function setPageMenu(items) {
  pageMenuItems = items;
  pageMenuButton.hidden = !items;
}

// ── Moving through lists by keyboard ────────────────────────────────────────
// As in Ergon: ⌃N/⌃P (or ↓/↑, j/k) select the next or previous line of the
// list on screen (search results, a folder's notes, Explore),
// Enter acts on it, and going past either end returns to the list's text
// box. From a search box, the keys move through its results while you type.

const nav = { scope: "", key: null, position: -1 };
// What the keyboard can do to a row: { activate, edit, remove, move(step) }.
// Rows without an entry are clicked to activate.
const rowActions = new WeakMap();

function stepKey(event) {
  if (!event.ctrlKey || event.metaKey || event.altKey) return 0;
  return { n: 1, p: -1 }[event.key.toLowerCase()] ?? 0;
}

function navScope() {
  return `${state.view}|${state.folder}|${state.roadmapTopic}`;
}

function navRows() {
  const container = { home: homeSuggestions, notes: noteList, roadmap: roadmapTopics }[state.view];
  if (!container) return [];
  return [...container.querySelectorAll(".home-result, .note-card, .plain-list .row")].filter((row) => row.offsetParent);
}

function rowKey(row) {
  return row.dataset.key ?? row.dataset.path ?? "";
}

// Mark the selected row, finding it again (by key, else by position) after
// its list is redrawn.
function showNav() {
  for (const row of document.querySelectorAll(".nav-selected")) row.classList.remove("nav-selected");
  if (nav.scope !== navScope()) Object.assign(nav, { scope: navScope(), key: null, position: -1 });
  const rows = navRows();
  if (nav.position < 0 || !rows.length) {
    nav.position = -1;
    return null;
  }
  let index = nav.key === null ? -1 : rows.findIndex((row) => rowKey(row) === nav.key);
  if (index < 0) index = Math.min(nav.position, rows.length - 1);
  const row = rows[index];
  Object.assign(nav, { key: rowKey(row), position: index });
  row.classList.add("nav-selected");
  row.scrollIntoView({ block: "nearest" });
  return row;
}

function setNav(position, key = null) {
  Object.assign(nav, { scope: navScope(), key, position });
  return showNav();
}

function clearNav() {
  setNav(-1);
}

const selectedRow = () => document.querySelector(".nav-selected");

function moveNav(step) {
  const rows = navRows();
  const current = rows.findIndex((row) => row.classList.contains("nav-selected"));
  const lastOpen = rows.findLastIndex((row) => !row.classList.contains("is-done"));
  const last = lastOpen === -1 ? rows.length - 1 : lastOpen;
  const next = current === -1 ? (step > 0 ? 0 : last) : current + step;
  // Past either end of the list is its text box, and from there back round.
  if (!rows[next]) {
    clearNav();
    focusListBox();
    return;
  }
  // A link or button keeping the focus would take Enter for itself; a search box keeps it.
  if (document.activeElement !== searchInput) document.activeElement?.blur?.();
  document.body.classList.add("keyboard-nav");
  setNav(next, rowKey(rows[next]));
}

// The text box that goes with the list on screen: the add box in Explore,
// otherwise the search box.
function listBox() {
  if (state.view === "roadmap") return roadmapTopics.querySelector(".add-line .add-box");
  return searchBar.hidden ? null : searchInput;
}

function focusListBox({ scroll = true } = {}) {
  const box = listBox();
  if (box === searchInput) box.focus();
  else focusEnd(box, { scroll });
}

function activateRow(row) {
  const actions = rowActions.get(row);
  if (actions?.activate) actions.activate();
  else row.click();
}

// Move the selected row up or down its list (Explore). A move returns false
// if there's nowhere to go, or the row's new key when that changes.
function moveSelectedRow(step) {
  const row = selectedRow();
  const move = row && rowActions.get(row)?.move;
  if (!move) return;
  const position = nav.position;
  Object.assign(nav, { key: null, position: position + step });
  const moved = move(step);
  if (moved === false) Object.assign(nav, { position });
  else if (typeof moved === "string") nav.key = moved;
  showNav();
}

// Escape in a list view goes up a level, as the breadcrumb reads: an Explore
// area to Explore, a folder to the folder it's in, and Explore or a topic to
// the start page. False where there's nowhere up to go.
function goUp() {
  const toStartPage = () => {
    if (switchToHome({ syncUrl: false, retry: toStartPage })) history.pushState(null, "", "/");
  };
  if (state.view === "roadmap") {
    if (state.roadmapTopic) showAllRoadmapTopics();
    else toStartPage();
  } else if (state.view === "map") {
    toStartPage();
  } else if (state.view === "notes") {
    const parent = parentPath(state.folder);
    if (parent) openHomeFolder(parent);
    else toStartPage();
  } else {
    return false;
  }
  return true;
}

// A mouse resting on a row should not look like a second selection.
addEventListener("pointermove", (event) => {
  if (event.movementX || event.movementY) document.body.classList.remove("keyboard-nav");
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (!helpOverlay.hidden) {
    if (event.key === "Escape" || event.key === "?") {
      event.preventDefault();
      helpOverlay.hidden = true;
    }
    return;
  }
  if (noteViewer.open || document.querySelector("dialog[open]") || !contextMenu.hidden) return;
  const step = stepKey(event);
  if (event.target === searchInput) {
    const arrow = event.metaKey || event.altKey || event.shiftKey ? 0 : { ArrowDown: 1, ArrowUp: -1 }[event.key] || 0;
    if (step || arrow) {
      event.preventDefault();
      moveNav(step || arrow);
    } else if (event.key === "Enter" && !event.isComposing) {
      // Enter opens the selected result; on the home page, the top one if none is.
      const row = selectedRow() || (state.view === "home" ? navRows()[0] : null);
      if (row) {
        event.preventDefault();
        activateRow(row);
      }
    }
    return;
  }
  const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
  if (step && !typing) {
    event.preventDefault();
    moveNav(step);
    return;
  }
  if (typing || event.metaKey || event.ctrlKey) return;
  if ((event.key === " " || event.key === "Enter") && event.target.closest?.("button, a")) return;
  if (event.key === "?") {
    event.preventDefault();
    helpOverlay.hidden = false;
    return;
  }
  // Roadmap's map has keys of its own; Esc puts away its selection first.
  if (state.view === "map") {
    if (event.key === "Escape") {
      if (!clearMapSelection()) goUp();
    } else {
      mapKey(event);
    }
    return;
  }
  if (event.key === "Escape") {
    if (!goUp()) clearNav();
    return;
  }
  if (event.key === "n" && state.view === "roadmap") {
    event.preventDefault();
    // The box of the list the selected line is in (on a section's heading, the section's own).
    const place = selectedRow()?.dataset.place;
    const box = place && roadmapTopics.querySelector(`.add-line[data-place="${place}"] .add-box`);
    if (box) focusEnd(box);
    else focusListBox();
    return;
  }
  const up = event.key === "ArrowUp" || event.key === "k";
  const down = event.key === "ArrowDown" || event.key === "j";
  if (up || down) {
    event.preventDefault();
    if (event.altKey) moveSelectedRow(down ? 1 : -1);
    else moveNav(down ? 1 : -1);
    return;
  }
  // A held key repeats, and these act on a different row each time.
  const row = selectedRow();
  if (!row || event.repeat) return;
  const actions = rowActions.get(row) || {};
  if (event.key === "Enter" || event.key === " " || (event.key === "x" && row.dataset.kind === "item")) {
    event.preventDefault();
    nav.key = null;
    activateRow(row);
  } else if (event.key === "e" && actions.edit) {
    event.preventDefault();
    actions.edit();
  } else if ((event.key === "Backspace" || event.key === "Delete") && actions.remove) {
    event.preventDefault();
    nav.key = null;
    actions.remove();
  }
});

helpOverlay.addEventListener("click", (event) => {
  if (event.target === helpOverlay) helpOverlay.hidden = true;
});

// ── Sidebar folders ──────────────────────────────────────────────────────────
// Top-level folders are topics (state.collections); deeper ones come from
// state.folders. Both can be created, renamed, dragged into a new order or
// into another folder, and deleted once empty.

let treeDrop = null;
let treeExpandTimer = 0;

function parentPath(path) {
  return pathParts(path).slice(0, -1).join("/");
}

function folderLabel(path) {
  const parts = pathParts(path);
  if (parts.length <= 1) return state.collections[path] || formatFolderName(path);
  return state.folderLabels.get(path) || formatFolderName(parts.at(-1));
}

function inFolder(doc, path) {
  return doc.collection === path || doc.folder === path || doc.folder.startsWith(`${path}/`);
}

function applyCatalog(payload) {
  state.documents = payload.documents;
  state.collections = payload.collections || {};
  state.folders = payload.folders || [];
  state.folderLabels = new Map(state.folders.map((folder) => [folder.path, folder.label]));
  if (!state.query) state.results = payload.documents;
}

async function reloadCatalog() {
  const response = await fetch("/api/catalog", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not reload your notes.");
  applyCatalog(await response.json());
  if (state.selected) state.selected = state.documents.find((doc) => doc.path === state.selected.path) || state.selected;
  buildFolderTree(state.documents);
  highlightActiveFolder();
  if (state.view === "notes") {
    updateHeading();
    if (state.query) await runSearch(state.query);
    else updateList();
  }
}

async function folderRequest(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Could not change the folder.");
  return result;
}

// After a folder moves, keep it open and selected under its new path.
function remapFolder(oldPath, newPath) {
  const remap = (path) => (path === oldPath || path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path);
  state.expanded = new Set([...state.expanded].map(remap));
  const folder = remap(state.folder);
  if (folder !== state.folder) {
    state.folder = folder;
    if (new URLSearchParams(location.search).has("folder")) {
      history.replaceState(null, "", `/?folder=${encodeURIComponent(folder)}`);
    }
  }
}

async function createFolder(parent, name) {
  try {
    const result = await folderRequest("POST", "/api/folders", { parent, name });
    if (parent) state.expanded.add(parent);
    await reloadCatalog();
    openHomeFolder(result.path);
  } catch (error) {
    showToast(error.message);
  }
}

async function renameFolder(path, label) {
  if (pathParts(path).length === 1) state.collections[path] = label;
  else state.folderLabels.set(path, label);
  buildFolderTree(state.documents);
  highlightActiveFolder();
  if (state.view === "notes") updateHeading();
  try {
    await folderRequest("PATCH", "/api/folders", { path, label });
  } catch (error) {
    showToast(error.message);
    await reloadCatalog().catch(() => {});
  }
}

async function moveFolder(path, parent, before) {
  try {
    const result = await folderRequest("POST", "/api/folders/move", { path, parent, before });
    remapFolder(path, result.path);
    if (parent) state.expanded.add(parent);
    await reloadCatalog();
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteFolder(path) {
  const label = folderLabel(path);
  try {
    await folderRequest("DELETE", `/api/folders?path=${encodeURIComponent(path)}`);
    const wasOpen = state.folder === path || state.folder.startsWith(`${path}/`);
    if (wasOpen) state.folder = parentPath(path);
    await reloadCatalog();
    if (wasOpen && state.view === "notes") {
      if (state.folder) openHomeFolder(state.folder);
      else selectAllNotes();
    }
    showToast(`Deleted “${label}”`);
  } catch (error) {
    showToast(error.message);
  }
}

// A text box in a tree row for naming a folder. `onDone` gets the name, or ""
// if it was left empty or cancelled.
function nameInTree(row, value, onDone) {
  const input = document.createElement("input");
  input.className = "tree-input";
  input.value = value;
  input.maxLength = 100;
  input.setAttribute("aria-label", "Folder name");
  row.draggable = false;
  row.append(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (name) => {
    if (finished) return;
    finished = true;
    onDone(name.replace(/\s+/g, " ").trim());
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish("");
    }
  });
  input.addEventListener("blur", () => finish(input.value));
}

function startNewFolder(parent) {
  if (parent && !state.expanded.has(parent)) {
    state.expanded.add(parent);
    buildFolderTree(state.documents);
    highlightActiveFolder();
  }
  let container = folderTree;
  const parentItem = parent && folderTree.querySelector(`.tree-item[data-path="${CSS.escape(parent)}"]`);
  if (parentItem) {
    container = parentItem.querySelector(":scope > .tree-children");
    if (!container) {
      container = document.createElement("div");
      container.className = "tree-children";
      parentItem.append(container);
      parentItem.classList.add("expanded");
    }
  }
  const item = document.createElement("div");
  item.className = "tree-item";
  const row = document.createElement("div");
  row.className = "tree-row";
  const spacer = document.createElement("span");
  spacer.className = "tree-toggle";
  spacer.style.visibility = "hidden";
  row.append(spacer);
  item.append(row);
  container.append(item);
  row.scrollIntoView({ block: "nearest" });
  nameInTree(row, "", (name) => {
    item.remove();
    if (name) createFolder(parent, name);
  });
}

function renameFolderInTree(path) {
  const row = folderTree.querySelector(`.tree-item[data-path="${CSS.escape(path)}"] > .tree-row`);
  if (!row) return;
  row.querySelector(".tree-name").hidden = true;
  row.scrollIntoView({ block: "nearest" });
  nameInTree(row, folderLabel(path), (label) => {
    if (label && label !== folderLabel(path)) {
      renameFolder(path, label);
    } else {
      buildFolderTree(state.documents);
      highlightActiveFolder();
    }
  });
}

function folderMenu(path) {
  const notes = state.documents.filter((doc) => inFolder(doc, path)).length;
  const inbox = path === "inbox";
  return [
    { label: "New note", onPick: () => createNote({ title: "Untitled", collection: pathParts(path)[0], folder: path }) },
    { label: "New note from a file…", onPick: () => createNoteFromPickedFile(path) },
    { label: "New folder", onPick: () => startNewFolder(path) },
    "-",
    { label: "Rename", onPick: () => renameFolderInTree(path) },
    {
      label: "Delete",
      danger: true,
      disabled: inbox || notes > 0,
      detail: notes ? `${notes} note${notes === 1 ? "" : "s"}` : "",
      title: inbox ? "The Inbox stays" : notes ? "Move or delete its notes first" : "",
      onPick: () => deleteFolder(path),
    },
  ];
}

function setAllExpanded(expanded) {
  if (expanded) for (const item of folderTree.querySelectorAll(".tree-item[data-path]")) state.expanded.add(item.dataset.path);
  else state.expanded.clear();
  buildFolderTree(state.documents);
  highlightActiveFolder();
}

function sidebarMenu() {
  return [
    { label: "New topic", onPick: () => startNewFolder("") },
    "-",
    { label: "Expand all", onPick: () => setAllExpanded(true) },
    { label: "Collapse all", onPick: () => setAllExpanded(false) },
  ];
}

function clearTreeDrop() {
  for (const row of folderTree.querySelectorAll(".drop-target, .drop-before, .drop-after")) {
    row.classList.remove("drop-target", "drop-before", "drop-after");
  }
  folderTree.classList.remove("drop-end");
  window.clearTimeout(treeExpandTimer);
  treeDrop = null;
}

function canHoldFolder(path, parent) {
  return parent !== path && !parent.startsWith(`${path}/`) && !(path === "inbox" && parent);
}

function nextSiblingPath(path) {
  const item = folderTree.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
  return item?.nextElementSibling?.dataset.path || null;
}

// Where a folder dragged over `row` would go: before or after it (top or
// bottom of the row) or inside it (the middle). Just below an open folder
// means first inside it.
function folderDropAt(row, clientY) {
  const item = row.parentElement;
  const path = item.dataset.path;
  const rect = row.getBoundingClientRect();
  const offset = (clientY - rect.top) / rect.height;
  const zone = offset < 0.28 ? "before" : offset > 0.72 ? "after" : "into";
  const firstChild = item.querySelector(":scope > .tree-children > .tree-item[data-path]");
  if (zone === "into") return { zone, parent: path, before: null };
  if (zone === "after" && item.classList.contains("expanded") && firstChild) {
    return { zone, parent: path, before: firstChild.dataset.path };
  }
  return { zone, parent: parentPath(path), before: zone === "before" ? path : nextSiblingPath(path) };
}

function folderDropAllowed(dragged, drop) {
  if (!canHoldFolder(dragged, drop.parent)) return false;
  // Dropping where it already is changes nothing.
  return !(drop.parent === parentPath(dragged) && (drop.before === dragged || drop.before === nextSiblingPath(dragged)));
}

folderTree.addEventListener("dragstart", (event) => {
  const row = event.target.closest?.(".tree-row");
  const path = row?.parentElement.dataset.path;
  if (!path) return;
  state.draggedFolderPath = path;
  row.parentElement.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", folderLabel(path));
});

folderTree.addEventListener("dragend", () => {
  folderTree.querySelector(".tree-item.dragging")?.classList.remove("dragging");
  state.draggedFolderPath = "";
  clearTreeDrop();
});

folderTree.addEventListener("dragover", (event) => {
  const dragged = state.draggedFolderPath;
  if (!dragged && !state.draggedNotePath) return;
  const row = event.target.closest(".tree-row");
  const path = row?.parentElement.dataset.path;
  let drop = null;
  if (path && !dragged) {
    drop = { zone: "into", parent: path, note: true };
  } else if (path) {
    drop = folderDropAt(row, event.clientY);
  } else if (dragged && !row && event.clientY > (folderTree.querySelector(":scope > .tree-item:last-child")?.getBoundingClientRect().bottom ?? 0)) {
    drop = { zone: "end", parent: "", before: null };
  }
  if (drop && dragged && !folderDropAllowed(dragged, drop)) drop = null;
  const key = drop && `${drop.zone} ${drop.parent} ${drop.before} ${path}`;
  if (key !== treeDrop?.key) {
    clearTreeDrop();
    if (drop) {
      treeDrop = { ...drop, key };
      if (drop.zone === "end") folderTree.classList.add("drop-end");
      else row.classList.add(drop.zone === "into" ? "drop-target" : `drop-${drop.zone}`);
      const item = row?.parentElement;
      if (drop.zone === "into" && item?.querySelector(":scope > .tree-children") && !item.classList.contains("expanded")) {
        treeExpandTimer = window.setTimeout(() => {
          state.expanded.add(path);
          item.classList.add("expanded");
        }, 700);
      }
    }
  }
  if (drop) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }
});

// Leaving a row for its button also fires dragleave, so check the pointer
// really left the tree (Chrome gives no relatedTarget here).
folderTree.addEventListener("dragleave", (event) => {
  const rect = folderTree.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) {
    clearTreeDrop();
  }
});

folderTree.addEventListener("drop", (event) => {
  const drop = treeDrop;
  clearTreeDrop();
  if (!drop) return;
  event.preventDefault();
  if (drop.note) {
    const notePath = state.draggedNotePath || event.dataTransfer?.getData("text/plain");
    state.draggedNotePath = "";
    if (notePath) moveNoteToFolder(notePath, drop.parent);
  } else {
    moveFolder(state.draggedFolderPath, drop.parent, drop.before);
  }
});

$(".sidebar").addEventListener("contextmenu", (event) => {
  if (event.target.closest(".nav-group, .sidebar-footer, input")) return;
  event.preventDefault();
  const path = event.target.closest(".tree-item")?.dataset.path;
  openMenu(event, path ? folderMenu(path) : sidebarMenu());
});

noteList.addEventListener("contextmenu", (event) => {
  const card = event.target.closest(".note-card");
  const doc = card && state.documents.find((candidate) => candidate.path === card.dataset.path);
  if (!doc) return;
  event.preventDefault();
  openMenu(event, [
    { label: "Open", onPick: () => selectDocument(doc) },
    "-",
    { label: "Delete", danger: true, onPick: () => deleteNote(doc.path) },
  ]);
});

pageMenuButton.addEventListener("click", () => {
  if (pageMenuItems) openMenu(pageMenuButton, pageMenuItems());
});

function buildFolderTree(documents) {
  const nodes = new Map();
  const roots = [];
  const add = (path) => {
    if (nodes.has(path)) return;
    const node = { name: folderLabel(path), path, count: 0, children: [] };
    nodes.set(path, node);
    const parent = parentPath(path);
    if (!parent) {
      roots.push(node);
      return;
    }
    add(parent);
    nodes.get(parent).children.push(node);
  };
  for (const key of Object.keys(state.collections)) if (key !== FOLLOWING_TOPIC) add(key);
  // Shallowest first, so a folder's position among its siblings comes from
  // its own order rather than from when one of its subfolders turned up.
  const byDepth = [...state.folders].sort((a, b) => pathParts(a.path).length - pathParts(b.path).length);
  for (const folder of byDepth) add(folder.path);
  for (const doc of documents) {
    const collection = doc.collection || "general";
    if (collection === FOLLOWING_TOPIC) continue;
    const folder = pathParts(doc.folder)[0] === collection ? doc.folder : collection;
    add(folder);
    for (let path = folder; path; path = parentPath(path)) nodes.get(path).count += 1;
  }
  folderTree.replaceChildren(...roots.map((node) => renderFolderNode(node, 0)));
}

function renderFolderNode(node, depth) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-item";
  wrapper.dataset.path = node.path;
  if (state.expanded.has(node.path)) wrapper.classList.add("expanded");

  const row = document.createElement("div");
  row.className = "tree-row";
  row.draggable = true;
  if (state.folder === node.path) row.classList.add("selected");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tree-toggle";
  toggle.setAttribute("aria-label", `Toggle ${node.name}`);
  toggle.innerHTML = chevronSvg;
  if (!node.children.length) {
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
  nameBtn.innerHTML = `<span class="tree-title">${escapeHtml(node.name)}</span>`;
  nameBtn.addEventListener("click", () => {
    openHomeFolder(node.path);
  });
  nameBtn.addEventListener("dblclick", () => renameFolderInTree(node.path));

  const countSpan = document.createElement("span");
  countSpan.className = "tree-count";
  countSpan.textContent = String(node.count);

  row.append(toggle, nameBtn, countSpan);
  wrapper.append(row);

  if (node.children.length) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "tree-children";
    for (const child of node.children) {
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
  navRoadmap.classList.toggle("active", state.view === "roadmap");
  navSearch.classList.toggle("active", state.view === "home");
  if (state.view === "home") navSearch.setAttribute("aria-current", "page");
  else navSearch.removeAttribute("aria-current");
  if (state.folder) {
    const activeItem = folderTree.querySelector(`.tree-item[data-path="${CSS.escape(state.folder)}"] > .tree-row`);
    if (activeItem) activeItem.classList.add("selected");
  }
}

function setHomePresentation(isHome) {
  appShell.classList.toggle("home-mode", isHome);
  document.body.classList.toggle("home-mode", isHome);
  pageHeading.hidden = isHome;
  homeHeading.hidden = !isHome;
  homeSuggestions.hidden = !isHome;
  searchBar.classList.toggle("home-search-bar", isHome);
  $("#search-input").placeholder = isHome ? "Search notes, topics, and Explore" : "Search notes";
  $("#search-input").setAttribute("aria-label", isHome ? "Search notes, topics, and Explore" : "Search notes");
  if (!isHome) homeSuggestions.replaceChildren();
}

function switchToHome({ syncUrl = true, focus = true, retry = null } = {}) {
  if (!confirmDiscardEditor(retry || (() => switchToHome({ syncUrl, focus })))) return false;
  window.clearTimeout(state.searchTimer);
  state.searchTimer = null;
  clearReader();
  state.view = "home";
  state.folder = "";
  state.query = "";
  state.roadmapTopic = "";
  state.roadmapTopicFromIndex = false;
  $("#search-input").value = "";
  $("#clear-search").hidden = true;
  homeSuggestions.replaceChildren();
  searchBar.hidden = false;
  workspaceGrid.hidden = true;
  roadmapView.hidden = true;
  showMapView(false);
  navRoadmap.classList.remove("active");
  highlightActiveFolder();
  setHomePresentation(true);
  if (syncUrl) history.replaceState(null, "", "/");
  // Focus now, so typing right after ⌘L lands in the box, and again next frame
  // in case closing a note hands focus back to what it came from.
  if (focus) {
    searchInput.focus();
    requestAnimationFrame(() => searchInput.focus());
  }
  return true;
}

function getVisibleDocuments() {
  const base = state.query ? state.results : state.documents;
  if (!state.folder) return base.filter((doc) => doc.collection !== FOLLOWING_TOPIC);

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
  let title = "Notes";
  if (state.folder) title = folderLabel(state.folder);

  $("#page-title").textContent = title;
  const scope = state.folder ? `Search in ${title}` : "Search all notes";
  $("#search-input").placeholder = scope;
  $("#search-input").setAttribute("aria-label", scope);
  setPageMenu(state.folder && state.folder !== "general" ? () => folderMenu(state.folder) : null);
  // Build clickable breadcrumbs
  const breadcrumb = $("#breadcrumb");
  breadcrumb.replaceChildren();

  const rootLink = document.createElement("a");
  rootLink.className = "breadcrumb-item";
  rootLink.href = "#";
  rootLink.textContent = "Zetesis";
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

      const label = folderLabel(targetPath);

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
          if (!confirmDiscardEditor(() => link.click())) return;
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
    cur.textContent = "Notes";
    breadcrumb.append(sep, cur);
  }
}

function switchToNotes({ syncUrl = true, retry = null } = {}) {
  if (!confirmDiscardEditor(retry || (() => switchToNotes({ syncUrl })))) return false;
  clearReader({ resetUrl: true });
  const leavingRoadmap = state.view === "roadmap";
  state.view = "notes";
  state.roadmapTopicFromIndex = false;
  setHomePresentation(false);
  roadmapView.hidden = true;
  showMapView(false);
  searchBar.hidden = false;
  workspaceGrid.hidden = false;
  navRoadmap.classList.remove("active");
  highlightActiveFolder();
  updateHeading();

  if (leavingRoadmap && syncUrl) {
    const url = state.selected ? `/?note=${encodeURIComponent(state.selected.path)}` : "/";
    history.replaceState(null, "", url);
  }
  return true;
}

function editorHasUnsavedChanges() {
  const session = state.editorSession;
  return Boolean(session) && (noteSessionIsDirty(session) || Boolean(session.inFlight));
}

// Leaving a note saves its pending edits in the background (see
// closeEditorSession); only ask when leaving would actually lose something.
// True when it's fine to go. Otherwise it asks, in the app (which can't hold
// up the caller), returns false, and runs `retry` if you choose to leave.
function confirmDiscardEditor(retry = null) {
  const session = state.editorSession;
  if (!session || session.leaveApproved) return true;
  const losses = [];
  if (session.controller?.hasPendingUploads()) losses.push("A file is still uploading into this note, and the upload will be lost.");
  if (session.conflict && noteSessionIsDirty(session)) {
    losses.push("This note was changed elsewhere, so your latest edits weren't saved and will be lost.");
  }
  if (!losses.length) return true;
  if (!askAnswer) {
    askConfirm({ title: "Leave this note?", message: losses.join(" "), confirmLabel: "Leave anyway", danger: true })
      .then((leave) => {
        if (!leave || state.editorSession !== session) return;
        session.leaveApproved = true;
        retry?.();
        session.leaveApproved = false;
      });
  }
  return false;
}

function updateRoadmapCounts() {
  $("#roadmap-count").textContent = String(exploreAreas().reduce((count, area) => count + openCount(area), 0));
}

function updateRoadmapHeading() {
  const selectedTopic = state.roadmapTopic;

  $("#page-title").textContent = selectedTopic || "Explore";
  const areaIndex = exploreAreas().findIndex((area) => area.name === selectedTopic);
  setPageMenu(selectedTopic && areaIndex >= 0
    ? () => [{ label: "New section", onPick: () => startNewSection([areaIndex]) }, ...areaMenu(areaIndex).filter((item) => item.label !== "Open")]
    : null);
  const breadcrumb = $("#breadcrumb");
  breadcrumb.replaceChildren();

  const rootLink = document.createElement("a");
  rootLink.className = "breadcrumb-item";
  rootLink.href = "#";
  rootLink.textContent = "Zetesis";
  rootLink.addEventListener("click", (event) => {
    event.preventDefault();
    selectAllNotes();
  });

  const separator = document.createElement("span");
  separator.className = "breadcrumb-separator";
  separator.textContent = "/";

  if (selectedTopic) {
    const exploreLink = document.createElement("a");
    exploreLink.className = "breadcrumb-item";
    exploreLink.href = "#";
    exploreLink.textContent = "Explore";
    exploreLink.addEventListener("click", (e) => {
      e.preventDefault();
      showAllRoadmapTopics();
    });
    const current = document.createElement("span");
    current.className = "breadcrumb-current";
    current.textContent = selectedTopic;
    breadcrumb.append(rootLink, separator, exploreLink, separator.cloneNode(true), current);
  } else {
    const current = document.createElement("span");
    current.className = "breadcrumb-current";
    current.textContent = "Explore";
    breadcrumb.append(rootLink, separator, current);
  }
}

function openRoadmapTopic(topicName) {
  state.roadmapTopic = topicName;
  state.roadmapTopicFromIndex = true;
  const params = new URLSearchParams({ view: "roadmap", topic: topicName });
  history.pushState(null, "", `/?${params.toString()}`);
  updateRoadmapHeading();
  renderRoadmap();
  focusListBox({ scroll: false });
}

function showAllRoadmapTopics() {
  state.roadmapTopic = "";
  state.roadmapTopicFromIndex = false;
  history.pushState(null, "", "/?view=roadmap");
  updateRoadmapHeading();
  renderRoadmap();
  focusListBox({ scroll: false });
}

async function loadRoadmap({ force = false } = {}) {
  if (state.roadmap && !force) return state.roadmap;

  const response = await fetch("/api/roadmap", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load Explore.");
  const payload = await response.json();

  state.roadmap = { areas: Array.isArray(payload.areas) ? payload.areas : [] };
  updateRoadmapCounts();
  return state.roadmap;
}

function roadmapMessage(message) {
  const box = document.createElement("div");
  box.className = "roadmap-empty";
  box.textContent = message;
  return box;
}

function roadmapErrorState(message) {
  const box = roadmapMessage(message);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "roadmap-retry";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => {
    state.roadmap = null;
    switchToRoadmap({ topic: state.roadmapTopic });
  });
  box.append(retry);
  return box;
}

async function switchToRoadmap({ topic = "", syncUrl = true } = {}) {
  if (!confirmDiscardEditor(() => switchToRoadmap({ topic, syncUrl }))) return;
  clearReader();
  state.view = "roadmap";
  navSearch.classList.remove("active");
  navSearch.removeAttribute("aria-current");
  setHomePresentation(false);
  state.roadmapTopic = topic || "";
  searchBar.hidden = true;
  workspaceGrid.hidden = true;
  roadmapView.hidden = false;
  showMapView(false);
  navRoadmap.classList.add("active");
  for (const row of folderTree.querySelectorAll(".tree-row.selected")) {
    row.classList.remove("selected");
  }
  if (syncUrl) {
    const params = new URLSearchParams({ view: "roadmap" });
    if (state.roadmapTopic) params.set("topic", state.roadmapTopic);
    history.replaceState(null, "", `/?${params.toString()}`);
  }
  updateRoadmapHeading();

  // As in Ergon, the cursor starts in the add box, with the page at its top.
  if (state.roadmap) {
    renderRoadmap();
    focusListBox({ scroll: false });
    return;
  }

  roadmapTopics.replaceChildren(roadmapMessage("Loading…"));
  try {
    await loadRoadmap();
    renderRoadmap();
    focusListBox({ scroll: false });
  } catch (error) {
    roadmapTopics.replaceChildren(roadmapErrorState(error.message));
    showToast(error.message);
  }
}


// ── Roadmap ─────────────────────────────────────────────────────────────────
// A map of boxes joined by arrows, like a mind map (map.js). It fills the main
// area under the page's title; ⌘F there finds boxes, dimming the others.

function switchToMap({ syncUrl = true } = {}) {
  if (!confirmDiscardEditor(() => switchToMap({ syncUrl }))) return;
  clearReader();
  state.view = "map";
  state.query = "";
  searchInput.value = "";
  $("#clear-search").hidden = true;
  navSearch.classList.remove("active");
  navSearch.removeAttribute("aria-current");
  navRoadmap.classList.remove("active");
  setHomePresentation(false);
  searchBar.hidden = true;
  workspaceGrid.hidden = true;
  roadmapView.hidden = true;
  for (const row of folderTree.querySelectorAll(".tree-row.selected")) {
    row.classList.remove("selected");
  }
  if (syncUrl) history.replaceState(null, "", "/?view=map");
  updateMapHeading();
  showMapView(true);
  // The map's keys work from the start.
  document.activeElement?.blur?.();
  openMap();
}

function showMapView(shown) {
  if (!shown && !mapEl.hidden) closeMap();
  mapEl.hidden = !shown;
  mapZoom.hidden = !shown;
  navMap.classList.toggle("active", shown);
  document.body.classList.toggle("map-mode", shown);
}

function updateMapHeading() {
  $("#page-title").textContent = "Roadmap";
  setPageMenu(null);
  const rootLink = document.createElement("a");
  rootLink.className = "breadcrumb-item";
  rootLink.href = "#";
  rootLink.textContent = "Zetesis";
  rootLink.addEventListener("click", (event) => {
    event.preventDefault();
    selectAllNotes();
  });
  const separator = document.createElement("span");
  separator.className = "breadcrumb-separator";
  separator.textContent = "/";
  const current = document.createElement("span");
  current.className = "breadcrumb-current";
  current.textContent = "Roadmap";
  $("#breadcrumb").replaceChildren(rootLink, separator, current);
}

function openMapFind() {
  searchBar.hidden = false;
  searchInput.placeholder = "Find boxes";
  searchInput.setAttribute("aria-label", "Find boxes");
  searchInput.focus();
  searchInput.select();
  renderMap();
}

function closeMapFind() {
  searchInput.value = "";
  $("#clear-search").hidden = true;
  searchBar.hidden = true;
  searchInput.blur();
  renderMap();
}

// Following is one note, in a topic of its own that the sidebar shows as this
// entry. It opens over whatever is on screen, and is made again if deleted.
const FOLLOWING_TOPIC = "following";

async function openFollowingNote() {
  if (!confirmDiscardEditor(openFollowingNote)) return;
  let note = state.documents.find((doc) => doc.collection === FOLLOWING_TOPIC);
  if (!note) {
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Following", collection: FOLLOWING_TOPIC, folder: FOLLOWING_TOPIC }),
      });
      note = await response.json();
      if (!response.ok) throw new Error(note.error || "Could not create the Following note.");
      state.documents.unshift(note);
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
  history.pushState(null, "", noteUrl(note.path));
  selectDocument(note);
}

// The address with a note open, keeping what's under it (a folder, or Explore),
// so closing the note goes back there.
function noteUrl(path) {
  const params = new URLSearchParams(location.search);
  params.set("note", path);
  return `/?${params}`;
}

// ── Plain lists (Explore), worked like Ergon's task lists ───────────────────
// Each line is a row; the add box at the bottom wraps like the line it will
// become; Explore items are edited in place with their links kept as links.

// [[address][words]] (address may be a Zetesis note, file:...), or a bare web address.
const TITLE_LINK = /\[\[((?:https?|file):[^\]]+)\](?:\[([^\]]*)\])?\]|https?:\/\/[^\s<>)\]]*[^\s<>)\].,;:!?'"]/g;
const WEB_ADDRESS = /^https?:\/\/[^\s\]]+$/;
// Text typed in add boxes, kept while the list is redrawn: list name → text.
const drafts = new Map();
let rowDrag = null;

// A title as it reads, without its link markup.
function plainTitle(text) {
  return text.replace(TITLE_LINK, (match, target, words) => words || target || match);
}

function showLinks(element, text) {
  const parts = [];
  let end = 0;
  for (const match of text.matchAll(TITLE_LINK)) {
    const target = match[1] ?? match[0];
    const note = target.startsWith("file:") ? resolveRelativeTarget(target, "roadmap.org") : "";
    const link = document.createElement("a");
    link.href = note ? `/?note=${encodeURIComponent(note)}` : target;
    link.dataset.target = target;
    link.textContent = match[2] || match[1] || match[0];
    if (!note) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    link.draggable = false;
    parts.push(text.slice(end, match.index), link);
    end = match.index + match[0].length;
  }
  element.replaceChildren(...parts, text.slice(end));
}

// A title as stored: links written [[address][words]], or the bare address when that is all they show.
function titleMarkup(element) {
  return typedMarkup(element).replace(/\s+/g, " ").trim();
}

// The same, with the spaces left as typed (for a draft still being written).
function typedMarkup(element) {
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeName === "BR") return " ";
    const inner = [...node.childNodes].map(walk).join("");
    const target = node.nodeName === "A" && (node.dataset.target || node.getAttribute("href"));
    const [, before, label, after] = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!target || !label) return inner;
    return before + (label === target ? target : `[[${target}][${label}]]`) + after;
  };
  return [...element.childNodes].map(walk).join("");
}

// Add boxes wrap like the lines they become, but a line is still one line of text.
function submitOnEnter(event) {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  event.target.closest("form").requestSubmit();
}

// Pastes come in as one line. A web address pasted over selected words links
// them (where links are allowed).
function pasteOneLine(event, { links = true } = {}) {
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  if (links && WEB_ADDRESS.test(text.trim()) && getSelection().toString().trim()) {
    document.execCommand("createLink", false, text.trim());
    return;
  }
  document.execCommand("insertText", false, text.replace(/\s+/g, " "));
}

// Set an add box's text, showing its links as links. Like setting a text
// box's value, this leaves nothing to undo.
function setBoxText(box, text) {
  if (box.dataset.links) showLinks(box, text);
  else box.textContent = text;
  box.classList.toggle("is-empty", !box.textContent);
  if (editHistory.host === box) editHistory.host = null;
}

// Where links are allowed, the box is edited like an item (links shown as
// links, not markup); otherwise it takes plain text.
function addLineRow(placeholder, onAdd, { draft, links = false, maxLength = 100 } = {}) {
  const form = document.createElement("form");
  form.className = "add-row add-line";
  form.dataset.draft = draft;
  form.innerHTML = '<span class="add-mark" aria-hidden="true">+</span><div class="add-box" role="textbox"></div>';
  const box = form.querySelector(".add-box");
  box.contentEditable = links ? "true" : "plaintext-only";
  box.spellcheck = false;
  box.dataset.placeholder = placeholder;
  box.setAttribute("aria-label", placeholder);
  box.dataset.links = links ? "1" : "";
  setBoxText(box, drafts.get(draft) ?? "");
  box.addEventListener("input", () => {
    box.classList.toggle("is-empty", !box.textContent);
    if (box.textContent) drafts.set(draft, typedMarkup(box));
    else drafts.delete(draft);
  });
  box.addEventListener("keydown", submitOnEnter);
  box.addEventListener("paste", (event) => pasteOneLine(event, { links }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const typed = typedMarkup(box);
    const value = titleMarkup(box);
    if (!value) return;
    if (value.length > maxLength) {
      showToast(`That's longer than ${maxLength} characters.`);
      return;
    }
    // Cleared first: adding redraws the list, and the new box starts from the draft.
    setBoxText(box, "");
    drafts.delete(draft);
    if (onAdd(value) === false) {
      setBoxText(box, typed);
      drafts.set(draft, typed);
      focusEnd(box);
    }
  });
  return form;
}

// Rows in one list can be dragged up or down; `onMove(from, to, after)` gets
// their data-index values.
function makeReorderable(row, list, onMove) {
  row.draggable = true;
  row.addEventListener("dragstart", (event) => {
    rowDrag = { row, list };
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.querySelector(".title")?.textContent || "");
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    for (const marked of list.querySelectorAll(".drop-before, .drop-after")) marked.classList.remove("drop-before", "drop-after");
    rowDrag = null;
  });
  row.addEventListener("dragover", (event) => {
    if (!rowDrag || rowDrag.list !== list || rowDrag.row === row) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    row.classList.toggle("drop-before", !after);
    row.classList.toggle("drop-after", after);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", (event) => {
    if (!rowDrag || rowDrag.list !== list) return;
    event.preventDefault();
    const after = row.classList.contains("drop-after");
    row.classList.remove("drop-before", "drop-after");
    onMove(Number(rowDrag.row.dataset.index), Number(row.dataset.index), after);
  });
}

function moveInList(list, from, to, after) {
  const [moved] = list.splice(from, 1);
  const target = to > from ? to - 1 : to;
  list.splice(after ? target + 1 : target, 0, moved);
}

// Redraw a list, keeping the focus in the add box it was in (an area's
// sections each have their own).
function redrawList(container, content) {
  const box = container.contains(document.activeElement) && document.activeElement.closest(".add-line .add-box");
  const line = box && box.closest(".add-line");
  container.replaceChildren(content);
  if (box) {
    const place = line.dataset.place;
    const next = (place && container.querySelector(`.add-line[data-place="${place}"] .add-box`)) || container.querySelector(".add-line .add-box");
    // Adding to a list keeps its box in view; a list just opened starts at its top.
    focusEnd(next, { scroll: next?.closest(".add-line").dataset.draft === line.dataset.draft });
  }
  showNav();
}

// The cursor at the end of an add box. With `scroll`, its whole line comes
// into view (the browser would show only the caret); without, the page stays put.
function focusEnd(box, { scroll = true } = {}) {
  if (!box) return;
  box.focus({ preventScroll: true });
  getSelection().selectAllChildren(box);
  getSelection().collapseToEnd();
  if (scroll) box.closest(".add-line").scrollIntoView({ block: "nearest" });
}

// Keys in add boxes: Escape clears the box, or, when it's empty, goes up a
// level; ↑ or ⌃N/⌃P from an empty box moves into the list.
function addBoxKeys(event) {
  const box = event.target.closest(".add-line .add-box");
  if (!box) return;
  const step = stepKey(event);
  if (event.key === "Escape" && !event.isComposing) {
    event.stopPropagation();
    if (box.textContent) {
      setBoxText(box, "");
      box.dispatchEvent(new Event("input"));
    } else {
      box.blur();
      goUp();
    }
  } else if ((event.key === "ArrowUp" || step) && !box.textContent) {
    event.preventDefault();
    moveNav(step || -1);
  }
}

roadmapTopics.addEventListener("keydown", addBoxKeys);
roadmapTopics.addEventListener("focusin", (event) => {
  if (event.target.closest(".add-line .add-box")) clearNav();
});

// ── Explore: areas, each a plain list of items ──────────────────────────────

let exploreWrites = Promise.resolve();

function exploreAreas() {
  return state.roadmap?.areas || [];
}

function currentAreaIndex() {
  return exploreAreas().findIndex((area) => area.name === state.roadmapTopic);
}

// An area, or a section in one (which can hold sections of its own), is a
// list, found by its place: [area index, section index, section index, …].
const EXPLORE_MAX_DEPTH = 5;

function exploreNode(areas, place) {
  let list = areas[place[0]];
  for (const index of place.slice(1)) list = list?.sections[index];
  return list;
}

const placeOf = (element) => element.dataset.place.split(".").map(Number);
const samePlace = (a, b) => a.join(".") === b.join(".");
// Whether `place` is `outer` or inside it.
const within = (place, outer) => outer.every((index, depth) => place[depth] === index);

// The names on the way to a list: ["Machine Learning", "Transformers"].
function exploreTrail(place) {
  return place.map((_, depth) => exploreNode(exploreAreas(), place.slice(0, depth + 1)).name);
}

// A list and every section in it, depth first, with their places.
function exploreLists(list, place) {
  return [{ list, place }, ...list.sections.flatMap((section, index) => exploreLists(section, [...place, index]))];
}

function openCount(list) {
  return list.items.filter((item) => !item.done).length + list.sections.reduce((count, section) => count + openCount(section), 0);
}

// Levels of sections in a section, its own included.
function sectionHeight(section) {
  return 1 + Math.max(0, ...section.sections.map(sectionHeight));
}

// Apply a change locally and save the whole list. Saves run one at a time,
// each with the areas as they were when it was made. `undo` names the change
// in a toast that offers to put things back.
function changeExplore(change, { undo = "" } = {}) {
  const previous = structuredClone(exploreAreas());
  const areas = structuredClone(previous);
  if (change(areas) === false) return;
  state.roadmap = { areas };
  renderRoadmap();
  exploreWrites = exploreWrites
    .then(async () => {
      const response = await fetch("/api/roadmap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areas }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Could not save Explore.");
    })
    .catch(async (error) => {
      showToast(error.message);
      state.roadmap = null;
      await loadRoadmap().catch(() => {});
      if (state.view === "roadmap") renderRoadmap();
    });
  if (undo) {
    showToast(undo, { action: "Undo", onAction: () => changeExplore((current) => current.splice(0, current.length, ...previous)) });
  }
}

function areaNameTaken(name, exceptIndex = -1) {
  return exploreAreas().some((area, index) => index !== exceptIndex && area.name.toLowerCase() === name.toLowerCase());
}

function renameArea(index, name) {
  const area = exploreAreas()[index];
  if (!area || !name || name === area.name) return;
  if (areaNameTaken(name, index)) {
    showToast(`There's already an area called “${name}”.`);
    return;
  }
  if (state.roadmapTopic === area.name) {
    state.roadmapTopic = name;
    history.replaceState(null, "", `/?${new URLSearchParams({ view: "roadmap", topic: name })}`);
  }
  changeExplore((areas) => {
    areas[index].name = name;
  });
}

function deleteArea(index) {
  const area = exploreAreas()[index];
  if (!area) return;
  if (state.roadmapTopic === area.name) {
    state.roadmapTopic = "";
    history.replaceState(null, "", "/?view=roadmap");
  }
  changeExplore((areas) => {
    areas.splice(index, 1);
  }, { undo: `Deleted “${area.name}”` });
}

function moveArea(index, step) {
  if (!exploreAreas()[index + step]) return false;
  changeExplore((areas) => moveInList(areas, index, index + step, step > 0));
}

function deleteExploreItem(place, itemIndex) {
  changeExplore((areas) => {
    exploreNode(areas, place).items.splice(itemIndex, 1);
  }, { undo: "Item deleted" });
}

function toggleExploreItem(place, itemIndex) {
  changeExplore((areas) => {
    const item = exploreNode(areas, place).items[itemIndex];
    item.done = !item.done;
  });
}

// Up or down past the next unfinished item in its list.
function moveExploreItem(place, itemIndex, step) {
  const items = exploreNode(exploreAreas(), place).items;
  const open = items.flatMap((item, index) => (item.done ? [] : [index]));
  const target = open[open.indexOf(itemIndex) + step];
  if (target === undefined) return false;
  changeExplore((areas) => moveInList(exploreNode(areas, place).items, itemIndex, target, step > 0));
  return `item:${place.join(".")}:${target}`;
}

function moveItemTo(place, itemIndex, to) {
  changeExplore((areas) => {
    const [moved] = exploreNode(areas, place).items.splice(itemIndex, 1);
    exploreNode(areas, to).items.push(moved);
  });
}

// An item, or with "# Name", a section.
function addToExplore(place, text) {
  const heading = text.match(/^#\s+(.+)$/);
  if (heading) return createSection(place, heading[1].trim());
  changeExplore((areas) => {
    exploreNode(areas, place).items.push({ title: text, done: false });
  });
}

// ── Sections ────────────────────────────────────────────────────────────────

// Why `name` can't name a section in `parent` (beside `except`), or "".
// Explore is kept as an Org outline, where a heading named like an item would read back as one.
function sectionNameProblem(parent, name, except = null) {
  const status = name.match(/^(NEXT|TODO|IDEA|DONE|READING|IN_PROGRESS)\s/);
  if (status) return `A section's name can't start with “${status[1]}”.`;
  if (/\s:[A-Za-z0-9_:]+:$/.test(name)) return "A section's name can't end in a :tag:.";
  const taken = parent.sections.some((section) => section !== except && section.name.toLowerCase() === name.toLowerCase());
  return taken ? `There's already a section called “${name}” there.` : "";
}

// Open or closed, remembered by the names on the way to the section.
function sectionOpen(place) {
  try {
    return localStorage.getItem(`zetesis.explore.closed.${exploreTrail(place).join("/")}`) !== "1";
  } catch {
    return true;
  }
}

function setSectionOpen(place, open, trail = exploreTrail(place)) {
  try {
    const key = `zetesis.explore.closed.${trail.join("/")}`;
    if (open) localStorage.removeItem(key);
    else localStorage.setItem(key, "1");
  } catch { /* Remembering it is optional. */ }
}

function toggleSection(place) {
  setSectionOpen(place, !sectionOpen(place));
  renderRoadmap();
}

// A new section at the end of the list at `place`, holding the item `moving`
// ({ place, index }) if given.
function createSection(place, name, moving = null) {
  const problem = place.length > EXPLORE_MAX_DEPTH
    ? `Sections go ${EXPLORE_MAX_DEPTH} deep at most.`
    : sectionNameProblem(exploreNode(exploreAreas(), place), name);
  if (problem) {
    showToast(problem);
    return false;
  }
  setSectionOpen(null, true, [...exploreTrail(place), name]);
  changeExplore((areas) => {
    const section = { name, items: [], sections: [] };
    if (moving) section.items.push(...exploreNode(areas, moving.place).items.splice(moving.index, 1));
    exploreNode(areas, place).sections.push(section);
  });
}

function renameSection(place, name) {
  const section = exploreNode(exploreAreas(), place);
  const problem = name === section.name ? "" : sectionNameProblem(exploreNode(exploreAreas(), place.slice(0, -1)), name, section);
  if (problem) showToast(problem);
  if (problem || name === section.name) {
    renderRoadmap();
    return;
  }
  setSectionOpen(null, sectionOpen(place), [...exploreTrail(place.slice(0, -1)), name]);
  changeExplore((areas) => {
    exploreNode(areas, place).name = name;
  });
}

function deleteSection(place) {
  const { name } = exploreNode(exploreAreas(), place);
  changeExplore((areas) => {
    exploreNode(areas, place.slice(0, -1)).sections.splice(place.at(-1), 1);
  }, { undo: `Deleted “${name}”` });
}

// Up or down past the section beside it.
function moveSection(place, step) {
  const index = place.at(-1);
  if (!exploreNode(exploreAreas(), place.slice(0, -1)).sections[index + step]) return false;
  changeExplore((areas) => moveInList(exploreNode(areas, place.slice(0, -1)).sections, index, index + step, step > 0));
  return `section:${[...place.slice(0, -1), index + step].join(".")}`;
}

// Into the list at `to`: at the end of its sections, or beside its section `beside`.
function moveSectionTo(place, to, { beside = null, after = false } = {}) {
  const section = exploreNode(exploreAreas(), place);
  let problem = samePlace(to, place.slice(0, -1)) ? "" : sectionNameProblem(exploreNode(exploreAreas(), to), section.name);
  if (to.length + sectionHeight(section) > EXPLORE_MAX_DEPTH + 1) problem = `Sections go ${EXPLORE_MAX_DEPTH} deep at most.`;
  if (problem) {
    showToast(problem);
    return;
  }
  changeExplore((areas) => {
    const into = exploreNode(areas, to);
    const anchor = beside && exploreNode(areas, beside);
    const [moved] = exploreNode(areas, place.slice(0, -1)).sections.splice(place.at(-1), 1);
    if (anchor) into.sections.splice(into.sections.indexOf(anchor) + (after ? 1 : 0), 0, moved);
    else into.sections.push(moved);
  });
}

// Name a new section where it will go: after the sections in the list at `place`.
function startNewSection(place, { moving = null } = {}) {
  if (place.length > EXPLORE_MAX_DEPTH) {
    showToast(`Sections go ${EXPLORE_MAX_DEPTH} deep at most.`);
    return;
  }
  if (place.length > 1 && !sectionOpen(place)) {
    setSectionOpen(place, true);
    renderRoadmap();
  }
  const box = roadmapTopics.querySelector(`.add-line[data-place="${place.join(".")}"]`);
  if (!box) return;
  const sections = box.parentElement.querySelectorAll(":scope > .explore-section");
  const draft = document.createElement("div");
  draft.className = "explore-section";
  draft.innerHTML = `<ul class="rows"><li class="row section-row editing"><span class="caret">${chevronSvg}</span><span class="title"></span></li></ul>`;
  (sections[sections.length - 1] || box).after(draft);
  editInline(draft.querySelector(".title"), "", (name) => {
    if (!name || createSection(place, name, moving) === false) renderRoadmap();
  });
}

function startSectionRename(place) {
  const row = roadmapTopics.querySelector(`.section-row[data-place="${place.join(".")}"]`);
  if (!row) return;
  row.draggable = false;
  row.classList.add("editing");
  editInline(row.querySelector(".title"), exploreNode(exploreAreas(), place).name, (name) => {
    if (name) renameSection(place, name);
    else renderRoadmap();
  });
}

function areaMenu(index) {
  const area = exploreAreas()[index];
  return [
    { label: "Open", onPick: () => openRoadmapTopic(area.name) },
    { label: "Rename", onPick: () => startAreaRename(index) },
    "-",
    { label: "Delete", danger: true, onPick: () => deleteArea(index) },
  ];
}

function startAreaRename(index) {
  const name = exploreAreas()[index]?.name;
  const target = state.roadmapTopic
    ? $("#page-title")
    : roadmapTopics.querySelector(`.area-row[data-index="${index}"] .title`);
  if (!target) return;
  const row = target.closest(".row");
  if (row) {
    row.draggable = false;
    row.classList.add("editing");
  }
  editInline(target, name, (value) => (value ? renameArea(index, value) : renderRoadmap()));
}

// Where an item or section can go: its area and the sections in it, then the other areas.
function exploreMoveTargets(place) {
  const areas = exploreAreas();
  return [
    ...exploreLists(areas[place[0]], [place[0]]),
    ...areas.flatMap((area, index) => (index === place[0] ? [] : [{ list: area, place: [index] }])),
  ];
}

function moveTargetEntry({ list, place }, onPick) {
  const parent = place.length > 1 ? exploreNode(exploreAreas(), place.slice(0, -1)).name : "";
  return { label: list.name, detail: parent ? `in ${parent}` : "area", onPick };
}

function itemMenu(place, itemIndex, row) {
  const item = exploreNode(exploreAreas(), place).items[itemIndex];
  const targets = exploreMoveTargets(place).filter((target) => !samePlace(target.place, place));
  return [
    { label: "Edit", onPick: () => beginItemEdit(row) },
    { label: item.done ? "Mark not done" : "Mark done", onPick: () => toggleExploreItem(place, itemIndex) },
    "-",
    { heading: "Move to" },
    ...targets.map((target) => moveTargetEntry(target, () => moveItemTo(place, itemIndex, target.place))),
    {
      label: "New section…",
      disabled: place.length > EXPLORE_MAX_DEPTH,
      onPick: () => startNewSection(place, { moving: { place, index: itemIndex } }),
    },
    "-",
    { label: "Delete", danger: true, onPick: () => deleteExploreItem(place, itemIndex) },
  ];
}

function sectionMenu(place) {
  const targets = exploreMoveTargets(place)
    .filter((target) => !within(target.place, place) && !samePlace(target.place, place.slice(0, -1)));
  return [
    { label: sectionOpen(place) ? "Collapse" : "Expand", onPick: () => toggleSection(place) },
    { label: "Rename", onPick: () => startSectionRename(place) },
    { label: "New section inside", disabled: place.length > EXPLORE_MAX_DEPTH, onPick: () => startNewSection(place) },
    ...(targets.length ? ["-", { heading: "Move to" }] : []),
    ...targets.map((target) => moveTargetEntry(target, () => moveSectionTo(place, target.place))),
    "-",
    { label: "Delete", danger: true, onPick: () => deleteSection(place) },
  ];
}

// ── Editing an item in place (as in Ergon) ──────────────────────────────────

const itemOf = (row) => exploreNode(exploreAreas(), placeOf(row))?.items[Number(row.dataset.index)];

function beginItemEdit(row, point) {
  const title = row.querySelector(".title");
  row.classList.add("editing");
  row.draggable = false;
  setNav(navRows().indexOf(row), rowKey(row));
  // Rich editing keeps links as links; beforeinput below limits it to text and links.
  title.contentEditable = "true";
  editHistory.host = null;
  title.focus();
  const range = point && document.caretRangeFromPoint?.(point.x, point.y);
  const selection = getSelection();
  if (range && title.contains(range.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    selection.selectAllChildren(title);
    selection.collapseToEnd();
  }
}

function endItemEdit(row, save) {
  if (!row.classList.contains("editing")) return;
  const title = row.querySelector(".title");
  const item = itemOf(row);
  row.classList.remove("editing");
  row.draggable = !row.classList.contains("is-done");
  title.removeAttribute("contenteditable");
  getSelection().removeAllRanges();
  if (!item) return;
  const text = titleMarkup(title);
  const place = placeOf(row);
  const itemIndex = Number(row.dataset.index);
  if (!save || text === item.title) showLinks(title, item.title);
  else if (text) changeExplore((areas) => { exploreNode(areas, place).items[itemIndex].title = text; });
  else deleteExploreItem(place, itemIndex);
}

roadmapTopics.addEventListener("keydown", (event) => {
  const row = event.target.closest(".row.editing[data-kind='item']");
  const step = stepKey(event);
  if (!row || event.isComposing || !(event.key === "Enter" || event.key === "Escape" || step)) return;
  event.preventDefault();
  event.stopPropagation();
  const unchanged = titleMarkup(row.querySelector(".title")) === itemOf(row)?.title;
  const place = placeOf(row);
  const itemIndex = Number(row.dataset.index);
  endItemEdit(row, event.key !== "Escape");
  if (step) moveNav(step);
  // Enter saves an edit; with nothing to save, it checks the item off.
  else if (event.key === "Enter" && unchanged) toggleExploreItem(place, itemIndex);
});

roadmapTopics.addEventListener("focusout", (event) => {
  const row = event.target.closest(".row.editing[data-kind='item']");
  // Switching to another app keeps the edit open, so typing carries on when you come back.
  if (row && document.hasFocus()) endItemEdit(row, true);
});

// Clicking around the text of the item being edited keeps the caret in it.
roadmapTopics.addEventListener("mousedown", (event) => {
  if (event.target.closest(".row.editing[data-kind='item']") && !event.target.closest(".title, button")) event.preventDefault();
});

roadmapTopics.addEventListener("paste", (event) => {
  if (event.target.closest(".row.editing[data-kind='item']")) pasteOneLine(event);
});

// The browser types at the end of a link outside it. That suits a caret placed after a link,
// but not retyping a link's words, so text typed over part of a link is put inside it by hand.
let typingIntoLink = null;

function linkAround(node) {
  return (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.(".title a, .add-box a") ?? null;
}

roadmapTopics.addEventListener("beforeinput", (event) => {
  if (!event.target.closest?.(".row.editing[data-kind='item'], .add-line .add-box")) return;
  if (/^(format|insertFromDrop|insertParagraph|insertLineBreak)/.test(event.inputType)) {
    event.preventDefault();
    return;
  }
  const selection = getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;
  const link = range && linkAround(range.startContainer);
  const insideLink = link && link === linkAround(range.endContainer);
  const atLinkEnd = range?.collapsed && link && link === typingIntoLink
    && range.startContainer === link.lastChild && range.startOffset === link.lastChild.length;
  if (event.inputType !== "insertText" || !insideLink || (range.collapsed && !atLinkEnd)) {
    typingIntoLink = null;
    return;
  }
  event.preventDefault();
  range.deleteContents();
  const node = link.lastChild?.nodeType === Node.TEXT_NODE && range.startContainer === link.lastChild
    ? link.lastChild : range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    node.insertData(range.startOffset, event.data);
    selection.collapse(node, range.startOffset + event.data.length);
  } else {
    const typed = document.createTextNode(event.data);
    range.insertNode(typed);
    selection.collapse(typed, typed.length);
  }
  typingIntoLink = link;
});

roadmapTopics.addEventListener("keydown", (event) => {
  // Moving the caret, or anything but plain typing, ends a retyping of a link.
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) typingIntoLink = null;
}, true);

// The browser keeps one undo history for every text box on the page, so ⌘Z
// in a box with nothing left to undo (or with no box focused) would undo
// typing somewhere else, such as the search box while it's out of sight.
// Undo and redo only change the box you're in.
document.addEventListener("beforeinput", (event) => {
  if (event.inputType.startsWith("history") && event.target !== document.activeElement) event.preventDefault();
}, true);

// Undo while editing an item, or in an add box, is its own. The browser keeps
// one history for every text box on the page, so its undo could leave the box
// and undo an earlier edit somewhere else.
const editHistory = { host: null, past: [], future: [], at: 0 };
const hasOwnUndo = (host) => host?.matches?.(".row.editing[data-kind='item'] .title, .add-line .add-box");

function caretOffset(root) {
  const selection = getSelection();
  if (!selection.rangeCount) return 0;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset);
  return range.toString().length;
}

function placeCaret(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (offset <= node.length) {
      getSelection().collapse(node, offset);
      return;
    }
    offset -= node.length;
  }
  getSelection().selectAllChildren(root);
  getSelection().collapseToEnd();
}

const editState = (host) => ({ html: host.innerHTML, caret: caretOffset(host) });

// Typing within a moment of the last change undoes together, as a word or phrase.
function rememberEdit(host) {
  if (host !== editHistory.host) Object.assign(editHistory, { host, past: [], future: [], at: 0 });
  if (Date.now() - editHistory.at > 700) editHistory.past.push(editState(host));
  editHistory.future = [];
  editHistory.at = Date.now();
}

function stepEdit(host, undo) {
  const [from, to] = undo ? [editHistory.past, editHistory.future] : [editHistory.future, editHistory.past];
  if (host !== editHistory.host || !from.length) return;
  to.push(editState(host));
  const previous = from.pop();
  host.innerHTML = previous.html;
  placeCaret(host, previous.caret);
  editHistory.at = 0;
  typingIntoLink = null;
}

document.addEventListener("keydown", (event) => {
  const host = document.activeElement;
  if (!hasOwnUndo(host) || !event.metaKey || event.altKey || event.ctrlKey || event.key.toLowerCase() !== "z") return;
  event.preventDefault();
  stepEdit(host, !event.shiftKey);
}, true);

document.addEventListener("beforeinput", (event) => {
  const host = document.activeElement;
  if (!hasOwnUndo(host)) return;
  // The Edit menu's Undo and Redo would reach the shared history, so they do nothing here.
  if (event.inputType.startsWith("history")) event.preventDefault();
  else if (event.target === host) rememberEdit(host);
}, true);

document.addEventListener("paste", () => {
  const host = document.activeElement;
  if (!hasOwnUndo(host)) return;
  rememberEdit(host);
  editHistory.at = 0;
}, true);

// ── Drawing Explore ─────────────────────────────────────────────────────────

function renderExploreAreas() {
  const section = document.createElement("section");
  section.className = "plain-list";
  const list = document.createElement("ul");
  list.className = "rows";
  exploreAreas().forEach((area, index) => {
    const row = document.createElement("li");
    row.className = "row area-row";
    row.dataset.index = String(index);
    row.dataset.key = area.name;
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = area.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    const open = openCount(area);
    meta.textContent = open ? String(open) : "";
    row.append(title, meta);
    row.addEventListener("click", () => {
      if (!row.querySelector("[contenteditable]")) openRoadmapTopic(area.name);
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(event, areaMenu(index));
    });
    makeReorderable(row, list, (from, to, after) => changeExplore((areas) => moveInList(areas, from, to, after)));
    rowActions.set(row, {
      activate: () => openRoadmapTopic(area.name),
      edit: () => startAreaRename(index),
      remove: () => deleteArea(index),
      move: (step) => moveArea(index, step),
    });
    list.append(row);
  });
  section.append(list, addLineRow("New area", (name) => {
    if (areaNameTaken(name)) {
      showToast(`There's already an area called “${name}”.`);
      return false;
    }
    changeExplore((areas) => {
      areas.push({ name, items: [], sections: [] });
    });
  }, { draft: "areas" }));
  return section;
}

function renderExploreItemRow(place, itemIndex, item) {
  const row = document.createElement("li");
  row.className = `row${item.done ? " is-done" : ""}`;
  row.dataset.index = String(itemIndex);
  row.dataset.place = place.join(".");
  row.dataset.key = `item:${row.dataset.place}:${itemIndex}`;
  row.dataset.kind = "item";
  row.innerHTML = `
    <button class="check" type="button" role="checkbox" tabindex="-1">${CHECK_ICON}</button>
    <span class="title"></span>
    <span class="actions"><button class="action" type="button" tabindex="-1" title="Delete" aria-label="Delete">${TRASH_ICON}</button></span>`;
  const check = row.querySelector(".check");
  check.setAttribute("aria-checked", String(item.done));
  check.setAttribute("aria-label", item.done ? "Mark not done" : "Mark done");
  check.addEventListener("click", () => toggleExploreItem(place, itemIndex));
  showLinks(row.querySelector(".title"), item.title);
  row.querySelector(".action").addEventListener("click", (event) => {
    // The next item slides under the mouse, and a double-click should not take it too.
    if (event.detail <= 1) deleteExploreItem(place, itemIndex);
  });
  // Click anywhere on an item to edit it, with the caret where you clicked;
  // links open instead.
  row.addEventListener("click", (event) => {
    if (row.classList.contains("editing") || event.target.closest("button")) return;
    const link = event.target.closest("a[href]");
    if (link) {
      openExploreLink(event, link);
      return;
    }
    beginItemEdit(row, { x: event.clientX, y: event.clientY });
  });
  row.addEventListener("contextmenu", (event) => {
    if (row.classList.contains("editing")) return;
    event.preventDefault();
    openMenu(event, itemMenu(place, itemIndex, row));
  });
  rowActions.set(row, {
    activate: () => toggleExploreItem(place, itemIndex),
    edit: () => beginItemEdit(row),
    remove: () => deleteExploreItem(place, itemIndex),
    move: (step) => moveExploreItem(place, itemIndex, step),
  });
  if (!item.done) makeExploreDraggable(row, { kind: "item", place, index: itemIndex });
  return row;
}

// Links in item titles: notes open in Zetesis, everything else in a new tab.
function openExploreLink(event, link) {
  const url = new URL(link.href, location.origin);
  if (url.origin !== location.origin || !url.searchParams.has("note")) return;
  event.preventDefault();
  const doc = state.documents.find((candidate) => candidate.path === url.searchParams.get("note"));
  if (doc) revealDocument(doc);
  else showToast("That note isn't in Zetesis.");
}

function exploreDoneOpen(name) {
  try {
    return localStorage.getItem(`zetesis.explore.done.${name}`) === "1";
  } catch {
    return false;
  }
}

function setExploreDoneOpen(name, open) {
  try {
    localStorage.setItem(`zetesis.explore.done.${name}`, open ? "1" : "0");
  } catch { /* Remembering it is optional. */ }
}

function renderExploreArea(areaIndex) {
  const section = document.createElement("section");
  section.className = "plain-list";
  section.append(...renderExploreList([areaIndex]));
  return section;
}

// The inside of an area or section: its open items and add box, the sections
// in it, then what's done.
function renderExploreList(place) {
  const list = exploreNode(exploreAreas(), place);
  const key = exploreTrail(place).join("/");
  const open = document.createElement("ul");
  open.className = "rows";
  const done = document.createElement("ul");
  done.className = "rows is-done-list";
  list.items.forEach((item, itemIndex) => (item.done ? done : open).append(renderExploreItemRow(place, itemIndex, item)));
  const box = addLineRow("Add item", (text) => addToExplore(place, text), { draft: `area:${key}`, links: true, maxLength: 2000 });
  box.dataset.place = place.join(".");
  // "# Name" makes a section, so the box shows it as a heading.
  const field = box.querySelector(".add-box");
  const showHeading = () => box.classList.toggle("is-heading", /^#\s/.test(field.textContent));
  field.addEventListener("input", showHeading);
  showHeading();
  const parts = [open, box, ...list.sections.map((_, index) => renderExploreSection([...place, index]))];
  if (done.children.length) {
    const showDone = exploreDoneOpen(key);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "done-toggle";
    toggle.textContent = `${done.children.length} done`;
    toggle.setAttribute("aria-expanded", String(showDone));
    toggle.addEventListener("click", () => {
      setExploreDoneOpen(key, !showDone);
      renderRoadmap();
    });
    done.hidden = !showDone;
    parts.push(toggle, done);
  }
  return parts;
}

// A section's heading (click to open or close it), then, when open, its list.
function renderExploreSection(place) {
  const section = exploreNode(exploreAreas(), place);
  const open = sectionOpen(place);
  const wrapper = document.createElement("div");
  wrapper.className = "explore-section";
  const head = document.createElement("ul");
  head.className = "rows";
  const row = document.createElement("li");
  row.className = `row section-row${open ? " is-open" : ""}`;
  row.dataset.kind = "section";
  row.dataset.place = place.join(".");
  row.dataset.key = `section:${row.dataset.place}`;
  row.setAttribute("aria-expanded", String(open));
  row.innerHTML = `<button class="caret" type="button" tabindex="-1">${chevronSvg}</button><span class="title"></span><span class="meta"></span>`;
  row.querySelector(".caret").setAttribute("aria-label", open ? "Collapse" : "Expand");
  row.querySelector(".title").textContent = section.name;
  const count = openCount(section);
  row.querySelector(".meta").textContent = count ? String(count) : "";
  row.addEventListener("click", () => {
    if (!row.classList.contains("editing")) toggleSection(place);
  });
  row.addEventListener("contextmenu", (event) => {
    if (row.classList.contains("editing")) return;
    event.preventDefault();
    openMenu(event, sectionMenu(place));
  });
  rowActions.set(row, {
    activate: () => toggleSection(place),
    edit: () => startSectionRename(place),
    remove: () => deleteSection(place),
    move: (step) => moveSection(place, step),
  });
  makeExploreDraggable(row, { kind: "section", place });
  head.append(row);
  wrapper.append(head);
  if (open) {
    const body = document.createElement("div");
    body.className = "section-body";
    body.append(...renderExploreList(place));
    wrapper.append(body);
  }
  return wrapper;
}

// Dragging in an area: an item before or after another, onto a section's
// heading (to the top of it), or onto a list's add box (to the end); a
// section before or after another, or onto one's middle to go inside it.
let exploreDrag = null;

function makeExploreDraggable(row, drag) {
  row.draggable = true;
  row.addEventListener("dragstart", (event) => {
    exploreDrag = { ...drag, row };
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.querySelector(".title")?.textContent || "");
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    exploreDrag = null;
    markExploreDrop(null);
  });
}

function exploreDropAt(event) {
  if (!exploreDrag) return null;
  const element = event.target.closest?.(".row[data-kind], .add-line[data-place]");
  if (!element || element === exploreDrag.row || element.matches(".is-done, .editing")) return null;
  const rect = element.getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  if (exploreDrag.kind === "item") {
    return { element, mode: element.dataset.kind !== "item" ? "into" : y < 0.5 ? "before" : "after" };
  }
  if (element.dataset.kind !== "section" || within(placeOf(element), exploreDrag.place)) return null;
  return { element, mode: y < 0.25 ? "before" : y > 0.75 ? "after" : "into" };
}

function markExploreDrop(target) {
  for (const marked of roadmapTopics.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
    marked.classList.remove("drop-before", "drop-after", "drop-into");
  }
  target?.element.classList.add(`drop-${target.mode}`);
}

function dropInExplore(drag, { element, mode }) {
  const to = placeOf(element);
  if (mode === "into" && element.dataset.kind === "section") setSectionOpen(to, true);
  if (drag.kind === "section") {
    if (mode === "into") moveSectionTo(drag.place, to);
    else moveSectionTo(drag.place, to.slice(0, -1), { beside: to, after: mode === "after" });
    return;
  }
  changeExplore((areas) => {
    const list = exploreNode(areas, to);
    const anchor = element.dataset.kind === "item" ? list.items[Number(element.dataset.index)] : null;
    const [moved] = exploreNode(areas, drag.place).items.splice(drag.index, 1);
    if (anchor) list.items.splice(list.items.indexOf(anchor) + (mode === "after" ? 1 : 0), 0, moved);
    else if (element.dataset.kind === "section") list.items.unshift(moved);
    else list.items.push(moved);
  });
}

roadmapTopics.addEventListener("dragover", (event) => {
  if (!exploreDrag) return;
  const target = exploreDropAt(event);
  markExploreDrop(target);
  if (target) event.preventDefault();
});

// Chrome names nothing it leaves for, so only a pointer outside the list clears the marker.
roadmapTopics.addEventListener("dragleave", (event) => {
  const rect = roadmapTopics.getBoundingClientRect();
  if (exploreDrag && (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom)) {
    markExploreDrop(null);
  }
});

roadmapTopics.addEventListener("drop", (event) => {
  const target = exploreDropAt(event);
  if (!target) return;
  event.preventDefault();
  const drag = exploreDrag;
  markExploreDrop(null);
  dropInExplore(drag, target);
});

// Right-click beside an area's lines for a new section.
$(".main-area").addEventListener("contextmenu", (event) => {
  const areaIndex = state.view === "roadmap" ? currentAreaIndex() : -1;
  if (areaIndex < 0 || event.target.closest(".row, .add-line, button, a, [contenteditable], dialog, .context-menu")) return;
  event.preventDefault();
  openMenu(event, [{ label: "New section", onPick: () => startNewSection([areaIndex]) }]);
});

function renderRoadmap() {
  if (!state.roadmap) return;
  const areas = exploreAreas();
  if (state.roadmapTopic && !areas.some((area) => area.name === state.roadmapTopic)) {
    state.roadmapTopic = "";
    history.replaceState(null, "", "/?view=roadmap");
  }
  updateRoadmapCounts();
  updateRoadmapHeading();
  const areaIndex = currentAreaIndex();
  redrawList(roadmapTopics, areaIndex >= 0 ? renderExploreArea(areaIndex) : renderExploreAreas());
}

function renderCard(doc) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "note-card";
  card.draggable = true;
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

  copy.append(title);
  card.append(badge, copy);

  card.addEventListener("click", () => selectDocument(doc));
  card.addEventListener("dragstart", (event) => {
    state.draggedNotePath = doc.path;
    card.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", doc.path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => {
    state.draggedNotePath = "";
    card.classList.remove("dragging");
    clearNoteDropMarker();
  });
  return card;
}

// Dragging a card within the list rearranges the notes (a drop on a sidebar
// folder moves the note instead). Search results keep their ranking.
function noteDropTarget(clientY) {
  const cards = [...noteList.querySelectorAll(".note-card")].filter((card) => card.dataset.path !== state.draggedNotePath);
  const before = cards.find((card) => {
    const rect = card.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });
  return before ? { card: before, after: false } : { card: cards.at(-1) || null, after: true };
}

function clearNoteDropMarker() {
  for (const card of noteList.querySelectorAll(".drop-before, .drop-after")) {
    card.classList.remove("drop-before", "drop-after");
  }
}

noteList.addEventListener("dragover", (event) => {
  if (!state.draggedNotePath || state.query) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const target = noteDropTarget(event.clientY);
  clearNoteDropMarker();
  target.card?.classList.add(target.after ? "drop-after" : "drop-before");
});

noteList.addEventListener("dragleave", (event) => {
  if (!noteList.contains(event.relatedTarget)) clearNoteDropMarker();
});

noteList.addEventListener("drop", (event) => {
  const dragged = state.draggedNotePath;
  if (!dragged || state.query) return;
  event.preventDefault();
  const target = noteDropTarget(event.clientY);
  clearNoteDropMarker();
  state.draggedNotePath = "";
  const current = getVisibleDocuments().map((doc) => doc.path);
  if (!current.includes(dragged)) return;
  const paths = current.filter((path) => path !== dragged);
  const index = target.card ? paths.indexOf(target.card.dataset.path) + (target.after ? 1 : 0) : paths.length;
  paths.splice(index, 0, dragged);
  if (paths.every((path, i) => path === current[i])) return;
  reorderNotes(paths);
});

// The rearranged notes swap among the places they already hold in the full
// list, exactly as the server does, so other folders keep their order.
function orderDocuments(documents, paths) {
  const moving = new Set(paths);
  const byPath = new Map(documents.map((doc) => [doc.path, doc]));
  const next = [...documents];
  let i = 0;
  documents.forEach((doc, slot) => {
    if (moving.has(doc.path)) next[slot] = byPath.get(paths[i++]);
  });
  return next;
}

async function reorderNotes(paths) {
  const previous = state.documents;
  state.documents = orderDocuments(previous, paths);
  updateList();
  try {
    const response = await fetch("/api/notes/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save the note order.");
    // Adopt the server's full order in case this page's list was out of date.
    const rank = new Map(result.order.map((path, index) => [path, index]));
    state.documents = [...state.documents].sort((a, b) => (rank.get(a.path) ?? rank.size) - (rank.get(b.path) ?? rank.size));
  } catch (error) {
    state.documents = previous;
    showToast(error.message);
  }
  if (!state.query) state.results = state.documents;
  updateList();
}

function updateList() {
  const visible = getVisibleDocuments();
  noteList.replaceChildren();
  $("#list-count").textContent = String(visible.length);

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
  // Searching a folder selects the top note, so Enter opens it.
  if (state.query && document.activeElement === searchInput) setNav(0);
  else showNav();
  if (state.selected && !visible.some((d) => d.path === state.selected.path)) {
    // Keep the open note visible while removing its row highlight from the filtered list.
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
    // Private-use characters, so no inline markup rule can match a token
    // (underscores did: two links on a line turned bold).
    const token = `\uE000${tokens.length}\uE001`;
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

// Read-only rendering for notes that still have only their legacy Org or
// Markdown body (not yet converted to blocks, or conversion failed).
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
      output.push("<p>" + paragraph.map((line) => renderInline(line, doc.path)).join("<br>") + "</p>");
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list.length) {
      output.push("<" + listType + ">" + list.map((item) => "<li>" + renderInline(item, doc.path) + "</li>").join("") + "</" + listType + ">");
      list = [];
      listType = "";
    }
  };

  const flushBlockquote = () => {
    if (blockquote.length) {
      output.push("<blockquote><p>" + blockquote.map((line) => renderInline(line, doc.path)).join("<br>") + "</p></blockquote>");
      blockquote = [];
    }
  };

  const flushTable = () => {
    if (tableRows.length) {
      const rowsHtml = tableRows.map((row, idx) => {
        const tag = idx === 0 ? "th" : "td";
        const cells = row.split("|").slice(1, -1).map((cell) => "<" + tag + ">" + renderInline(cell.trim(), doc.path) + "</" + tag + ">").join("");
        return "<tr>" + cells + "</tr>";
      }).join("");
      output.push("<table><tbody>" + rowsHtml + "</tbody></table>");
      tableRows = [];
    }
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushBlockquote();
    flushTable();
  };

  for (const line of lines) {
    const orgCodeStart = line.match(/^\s*#\+begin_src(?:\s+(\S+))?/i);
    const mdCodeStart = line.match(/^\s*(`{3})(.*)$/);

    if (code) {
      const endCode = code.org ? /^\s*#\+end_src\s*$/i.test(line) : /^\s*`{3}\s*$/.test(line);
      if (endCode) {
        output.push("<pre><code>" + escapeHtml(code.lines.join("\n")) + "</code></pre>");
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

    // Org directives and HTML comments are not shown.
    if (/^\s*#\+/.test(line) || /^\s*<!--/.test(line)) continue;

    const heading = doc.extension === ".org"
      ? line.match(/^\s*(\*{1,6})\s+(.+?)\s*$/)
      : line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);

    if (heading) {
      flushAll();
      const level = firstHeadingSeen ? Math.min(6, heading[1].length) : 1;
      firstHeadingSeen = true;
      output.push("<h" + level + ">" + renderInline(heading[2].replace(/\s+#+\s*$/, ""), doc.path) + "</h" + level + ">");
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      output.push("<hr>");
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushBlockquote();
      if (!/^\s*\|[-+\s|]+\|\s*$/.test(line)) tableRows.push(line.trim());
      continue;
    } else if (tableRows.length) {
      flushTable();
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      flushTable();
      blockquote.push(line.replace(/^\s*>\s?/, ""));
      continue;
    } else if (blockquote.length) {
      flushBlockquote();
    }

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

    if (!line.trim()) {
      flushAll();
      continue;
    }

    paragraph.push(line.trim());
  }

  if (code) output.push("<pre><code>" + escapeHtml(code.lines.join("\n")) + "</code></pre>");
  flushAll();

  if (!firstHeadingSeen && doc.title) {
    output.unshift("<h1>" + escapeHtml(doc.title) + "</h1>");
  }

  return output.join("\n");
}

function loadPdfJs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import(PDFJS_CDN + "pdf.min.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_CDN + "pdf.worker.min.mjs";
      return pdfjs;
    }).catch((error) => {
      pdfjsModulePromise = null;
      throw error;
    });
  }
  return pdfjsModulePromise;
}

function pdfViewerIsCurrent(session) {
  return activePdfViewer === session && !session.disposed;
}

function disposePdfViewer() {
  const session = activePdfViewer;
  if (!session) return;
  activePdfViewer = null;
  session.disposed = true;
  session.pageObserver?.disconnect();
  session.resizeObserver?.disconnect();
  if (session.selectionHandler) {
    session.pageList.removeEventListener("mouseup", session.selectionHandler);
    session.pageList.removeEventListener("keyup", session.selectionHandler);
    session.pageList.removeEventListener("touchend", session.selectionHandler);
  }
  for (const task of session.renderTasks.values()) {
    try { task.cancel(); } catch { /* A completed render cannot be canceled. */ }
  }
  session.renderTasks.clear();
  if (session.loadingTask) Promise.resolve(session.loadingTask.destroy()).catch(() => {});
}

function createPdfViewer(doc) {
  const root = document.createElement("section");
  root.className = "pdf-reader";

  const controls = document.createElement("div");
  controls.className = "pdf-controls";
  const highlightButton = readerButton("Highlight", "primary-button pdf-highlight-button", () => {});
  highlightButton.hidden = true;
  const highlightsButton = readerButton("Highlights", "secondary-button", () => {});
  highlightsButton.setAttribute("aria-expanded", "false");
  const status = document.createElement("span");
  status.className = "pdf-status";
  status.setAttribute("role", "status");
  controls.append(highlightButton, highlightsButton, status);

  const highlightList = document.createElement("div");
  highlightList.className = "pdf-highlight-list";
  highlightList.hidden = true;
  const pageList = document.createElement("div");
  pageList.className = "pdf-page-list";
  root.append(controls, highlightList, pageList);

  const session = {
    doc, root, pageList, status, highlightButton, highlightsButton, highlightList,
    highlights: [], pageElements: new Map(), pageViews: new Map(), pageGenerations: new Map(), renderTasks: new Map(),
    rendering: new Map(), disposed: false, pending: null, pageRatio: 0.72, renderWidth: 0,
    pdf: null, pdfjs: null, loadingTask: null, pageObserver: null, resizeObserver: null,
  };
  activePdfViewer = session;

  highlightButton.addEventListener("mousedown", (event) => event.preventDefault());
  highlightButton.addEventListener("click", () => savePdfHighlight(session));
  highlightsButton.addEventListener("click", () => {
    const open = highlightList.hidden;
    highlightList.hidden = !open;
    highlightsButton.setAttribute("aria-expanded", String(open));
    if (open) highlightList.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  session.selectionHandler = () => window.setTimeout(() => updatePdfSelection(session), 0);
  pageList.addEventListener("mouseup", session.selectionHandler);
  pageList.addEventListener("keyup", session.selectionHandler);
  pageList.addEventListener("touchend", session.selectionHandler);
  initializePdfViewer(session);
  return root;
}

async function initializePdfViewer(session) {
  session.status.textContent = "Loading PDF…";
  try {
    const [pdfjs, highlightsResponse] = await Promise.all([
      loadPdfJs(),
      fetch("/api/pdf-highlights?path=" + encodeURIComponent(session.doc.path), { cache: "no-store" }),
    ]);
    if (!pdfViewerIsCurrent(session)) return;
    if (!highlightsResponse.ok) throw new Error("Could not load saved highlights.");
    const highlightData = await highlightsResponse.json();
    session.highlights = Array.isArray(highlightData.highlights) ? highlightData.highlights : [];
    session.pdfjs = pdfjs;
    session.loadingTask = pdfjs.getDocument({
      url: "/api/file?path=" + encodeURIComponent(session.doc.path),
    });
    session.pdf = await session.loadingTask.promise;
    if (!pdfViewerIsCurrent(session)) return;

    const firstPage = await session.pdf.getPage(1);
    if (!pdfViewerIsCurrent(session)) return;
    session.pageViews.set(1, firstPage);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    session.pageRatio = firstViewport.width / firstViewport.height;
    session.renderWidth = Math.min(session.pageList.clientWidth || 800, 900);

    for (let pageNumber = 1; pageNumber <= session.pdf.numPages; pageNumber += 1) {
      const pageElement = document.createElement("section");
      pageElement.className = "pdf-page";
      pageElement.dataset.pageNumber = String(pageNumber);
      pageElement.setAttribute("aria-label", "Page " + pageNumber);
      pageElement.style.setProperty("--pdf-page-ratio", String(session.pageRatio));
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page-canvas";
      canvas.setAttribute("aria-hidden", "true");
      const highlightLayer = document.createElement("div");
      highlightLayer.className = "pdf-highlight-layer";
      highlightLayer.setAttribute("aria-hidden", "true");
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      pageElement.append(canvas, highlightLayer, textLayer);
      session.pageList.append(pageElement);
      session.pageElements.set(pageNumber, pageElement);
    }

    renderPdfHighlights(session);
    session.status.textContent = "";
    if ("IntersectionObserver" in window) {
      session.pageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const pageNumber = Number(entry.target.dataset.pageNumber);
          if (entry.isIntersecting) renderPdfPage(session, pageNumber);
          else if (isFarFromReader(entry.target, readerContent)) clearPdfPage(session, pageNumber);
        }
      }, { root: readerContent, rootMargin: "900px 0px" });
      for (const pageElement of session.pageElements.values()) session.pageObserver.observe(pageElement);
    } else {
      for (let pageNumber = 1; pageNumber <= Math.min(session.pdf.numPages, 4); pageNumber += 1) {
        renderPdfPage(session, pageNumber);
      }
    }

    if ("ResizeObserver" in window) {
      session.resizeObserver = new ResizeObserver(() => {
        if (!pdfViewerIsCurrent(session)) return;
        const width = Math.min(session.pageList.clientWidth || 800, 900);
        if (Math.abs(width - session.renderWidth) < 2) return;
        session.renderWidth = width;
        for (const pageNumber of session.pageViews.keys()) {
          clearPdfPage(session, pageNumber);
          const pageElement = session.pageElements.get(pageNumber);
          if (pageElement && session.pageObserver) {
            session.pageObserver.unobserve(pageElement);
            session.pageObserver.observe(pageElement);
          } else renderPdfPage(session, pageNumber);
        }
      });
      session.resizeObserver.observe(session.pageList);
    }
  } catch (error) {
    if (!pdfViewerIsCurrent(session)) return;
    session.status.textContent = /fetch|network|module/i.test(String(error.message || ""))
      ? "PDF reader unavailable. Check your internet connection."
      : error.message || "Could not open this PDF.";
    session.status.classList.add("pdf-status-error");
  }
}

function isFarFromReader(pageElement, scrollRoot) {
  const pageRect = pageElement.getBoundingClientRect();
  const rootRect = scrollRoot.getBoundingClientRect();
  return pageRect.bottom < rootRect.top - 1500 || pageRect.top > rootRect.bottom + 1500;
}

async function renderPdfPage(session, pageNumber) {
  if (!pdfViewerIsCurrent(session) || !session.pdf || session.rendering.has(pageNumber)) return;
  const pageElement = session.pageElements.get(pageNumber);
  if (!pageElement || pageElement.dataset.rendered === "true") return;
  const generation = (session.pageGenerations.get(pageNumber) || 0) + 1;
  session.pageGenerations.set(pageNumber, generation);
  const isCurrentRender = () => pdfViewerIsCurrent(session)
    && session.pageGenerations.get(pageNumber) === generation
    && pageElement.dataset.rendered === "loading";
  pageElement.dataset.rendered = "loading";
  const promise = (async () => {
    const page = session.pageViews.get(pageNumber) || await session.pdf.getPage(pageNumber);
    if (!isCurrentRender()) return;
    session.pageViews.set(pageNumber, page);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(session.renderWidth || 800, 900) / baseViewport.width;
    const viewport = page.getViewport({ scale });
    pageElement.style.setProperty("--pdf-page-ratio", String(viewport.width / viewport.height));

    const canvas = pageElement.querySelector("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(viewport.width * outputScale);
    canvas.height = Math.ceil(viewport.height * outputScale);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    const renderTask = page.render({
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
    });
    session.renderTasks.set(pageNumber, renderTask);

    const textLayerElement = pageElement.querySelector(".textLayer");
    textLayerElement.style.width = viewport.width + "px";
    textLayerElement.style.height = viewport.height + "px";
    const textContent = await page.getTextContent();
    if (!isCurrentRender()) {
      renderTask.cancel();
      return;
    }
    const textLayer = new session.pdfjs.TextLayer({ textContentSource: textContent, viewport, container: textLayerElement });
    await Promise.all([renderTask.promise, textLayer.render()]);
    if (!isCurrentRender()) return;
    session.renderTasks.delete(pageNumber);
    pageElement.dataset.rendered = "true";
  })();
  session.rendering.set(pageNumber, promise);
  try {
    await promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException" && pdfViewerIsCurrent(session)) {
      session.status.textContent = "Could not render page " + pageNumber + ".";
      session.status.classList.add("pdf-status-error");
    }
    if (pageElement.dataset.rendered === "loading") clearPdfPage(session, pageNumber);
  } finally {
    if (session.rendering.get(pageNumber) === promise) session.rendering.delete(pageNumber);
    if (pdfViewerIsCurrent(session)
        && session.pageGenerations.get(pageNumber) !== generation
        && pageElement.dataset.rendered !== "true"
        && !isFarFromReader(pageElement, readerContent)) {
      window.requestAnimationFrame(() => renderPdfPage(session, pageNumber));
    }
  }
}

function clearPdfPage(session, pageNumber) {
  const pageElement = session.pageElements.get(pageNumber);
  if (!pageElement || !["true", "loading"].includes(pageElement.dataset.rendered)) return;
  session.pageGenerations.set(pageNumber, (session.pageGenerations.get(pageNumber) || 0) + 1);
  const task = session.renderTasks.get(pageNumber);
  if (task) {
    try { task.cancel(); } catch { /* A completed render cannot be canceled. */ }
    session.renderTasks.delete(pageNumber);
  }
  const canvas = pageElement.querySelector("canvas");
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.width = "";
  canvas.style.height = "";
  const oldTextLayer = pageElement.querySelector(".textLayer");
  const newTextLayer = document.createElement("div");
  newTextLayer.className = "textLayer";
  oldTextLayer.replaceWith(newTextLayer);
  pageElement.dataset.rendered = "false";
  pageElement.style.setProperty("--pdf-page-ratio", String(session.pageRatio));
  session.pageViews.delete(pageNumber);
}

function updatePdfSelection(session) {
  if (!pdfViewerIsCurrent(session)) return;
  const selection = window.getSelection();
  const quote = selection?.toString().trim();
  if (!selection || !quote || !selection.rangeCount) {
    session.pending = null;
    session.highlightButton.hidden = true;
    return;
  }
  const range = selection.getRangeAt(0);
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const end = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
  const pageElement = start?.closest(".pdf-page");
  if (!pageElement || !session.pageList.contains(pageElement)
      || !end?.closest(".pdf-page") || end.closest(".pdf-page") !== pageElement) {
    session.pending = null;
    session.highlightButton.hidden = true;
    return;
  }
  const pageRect = pageElement.getBoundingClientRect();
  if (!pageRect.width || !pageRect.height) return;
  const rects = Array.from(range.getClientRects()).map((rect) => {
    const left = Math.max(rect.left, pageRect.left);
    const top = Math.max(rect.top, pageRect.top);
    const right = Math.min(rect.right, pageRect.right);
    const bottom = Math.min(rect.bottom, pageRect.bottom);
    return {
      x: (left - pageRect.left) / pageRect.width,
      y: (top - pageRect.top) / pageRect.height,
      width: (right - left) / pageRect.width,
      height: (bottom - top) / pageRect.height,
    };
  }).filter((rect) => rect.width > 0 && rect.height > 0).slice(0, 500);
  if (!rects.length) {
    session.pending = null;
    session.highlightButton.hidden = true;
    return;
  }
  session.pending = { page_number: Number(pageElement.dataset.pageNumber), quote: quote.slice(0, 10000), rects };
  session.highlightButton.hidden = false;
}

async function savePdfHighlight(session) {
  if (!pdfViewerIsCurrent(session) || !session.pending) return;
  session.highlightButton.disabled = true;
  try {
    const response = await fetch("/api/pdf-highlights?path=" + encodeURIComponent(session.doc.path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session.pending),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save highlight.");
    if (!pdfViewerIsCurrent(session)) return;
    session.highlights.push(result);
    session.pending = null;
    session.highlightButton.hidden = true;
    renderPdfHighlights(session);
    window.getSelection()?.removeAllRanges();
    showToast("Highlight saved");
  } catch (error) {
    if (pdfViewerIsCurrent(session)) showToast(error.message);
  } finally {
    if (pdfViewerIsCurrent(session)) session.highlightButton.disabled = false;
  }
}

function renderPdfHighlights(session) {
  if (!pdfViewerIsCurrent(session)) return;
  session.highlightsButton.textContent = "Highlights";
  const byPage = new Map();
  for (const highlight of session.highlights) {
    if (!byPage.has(highlight.page_number)) byPage.set(highlight.page_number, []);
    byPage.get(highlight.page_number).push(highlight);
  }
  for (const [pageNumber, pageElement] of session.pageElements) {
    const layer = pageElement.querySelector(".pdf-highlight-layer");
    layer.replaceChildren();
    for (const highlight of byPage.get(pageNumber) || []) {
      for (const rect of highlight.rects || []) {
        const mark = document.createElement("span");
        mark.className = "pdf-highlight-mark";
        mark.style.left = (rect.x * 100) + "%";
        mark.style.top = (rect.y * 100) + "%";
        mark.style.width = (rect.width * 100) + "%";
        mark.style.height = (rect.height * 100) + "%";
        layer.append(mark);
      }
    }
  }
  session.highlightList.replaceChildren();
  if (!session.highlights.length) {
    const empty = document.createElement("div");
    empty.className = "pdf-highlight-empty";
    empty.textContent = "No highlights yet";
    session.highlightList.append(empty);
    return;
  }
  const sorted = [...session.highlights].sort((a, b) => a.page_number - b.page_number || a.created.localeCompare(b.created));
  for (const highlight of sorted) {
    const row = document.createElement("div");
    row.className = "pdf-highlight-row";
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "pdf-highlight-quote";
    jump.textContent = "p. " + highlight.page_number + " · " + (highlight.quote || "Saved highlight");
    jump.title = jump.textContent;
    jump.addEventListener("click", () => {
      session.pageElements.get(highlight.page_number)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pdf-highlight-delete";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Delete highlight");
    remove.addEventListener("click", () => deletePdfHighlight(session, highlight.id));
    row.append(jump, remove);
    session.highlightList.append(row);
  }
}

async function deletePdfHighlight(session, highlightId) {
  try {
    const response = await fetch(
      "/api/pdf-highlights?path=" + encodeURIComponent(session.doc.path) + "&id=" + encodeURIComponent(highlightId),
      { method: "DELETE" },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not delete highlight.");
    if (!pdfViewerIsCurrent(session)) return;
    session.highlights = session.highlights.filter((item) => item.id !== highlightId);
    renderPdfHighlights(session);
    showToast("Highlight deleted");
  } catch (error) {
    if (pdfViewerIsCurrent(session)) showToast(error.message);
  }
}

function clearReader({ resetUrl = false } = {}) {
  disposePdfViewer();
  if (noteViewer.open) noteViewer.close();
  closeEditorSession();
  state.selected = null;
  state.selectedPayload = null;
  state.documentRequestId += 1;
  readerContent.hidden = true;
  readerContent.style.display = "none";
  readerContent.replaceChildren();
  for (const card of noteList.querySelectorAll(".note-card")) {
    card.classList.remove("selected");
    card.setAttribute("aria-current", "false");
  }
  if (resetUrl) {
    const params = new URLSearchParams(location.search);
    if (params.has("note")) {
      params.delete("note");
      const query = params.toString();
      history.replaceState(null, "", query ? `/?${query}` : "/");
    }
  }
}

function closeNoteViewer({ retry = null } = {}) {
  if (!confirmDiscardEditor(retry || (() => closeNoteViewer()))) return false;
  clearReader({ resetUrl: true });
  return true;
}

function readerButton(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className || "";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderSelectedDocument(doc, payload, { focus = "" } = {}) {
  disposePdfViewer();
  closeEditorSession();
  state.selectedPayload = payload;
  readerContent.hidden = false;
  readerContent.style.display = "block";
  readerContent.replaceChildren();

  const isPdf = doc.extension === ".pdf";
  const isBlockNote = !isPdf && Boolean(payload.body);
  const toolbar = document.createElement("div");
  toolbar.className = "reader-toolbar";
  const location = document.createElement("span");
  location.className = "reader-location";
  location.textContent = isBlockNote
    ? formatFolderPath(doc.folder || doc.collection)
    : `${state.collections[doc.collection] || formatFolderName(doc.collection)} · ${doc.title}`;
  const actions = document.createElement("span");
  actions.className = "reader-actions";
  const status = document.createElement("span");
  status.className = "save-status";
  status.setAttribute("role", "status");
  const type = document.createElement("span");
  type.className = "reader-type";
  type.textContent = doc.extension.slice(1);
  actions.append(status, type);

  if (isPdf) {
    const open = document.createElement("a");
    open.className = "reader-link";
    open.href = `/api/file?path=${encodeURIComponent(doc.path)}`;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open PDF ↗";
    actions.append(open);
  }
  actions.append(readerButton("Delete", "danger-button", () => deleteNote(doc.path)));
  toolbar.append(location, actions);
  readerContent.append(toolbar);

  if (isPdf) {
    readerContent.append(createPdfViewer(doc));
  } else if (isBlockNote) {
    openBlockEditor(doc, payload, status, { focus });
  } else {
    renderLegacyNote(doc, payload);
  }
}

// Notes not yet converted to blocks (or whose conversion failed) stay
// readable in their original Org/Markdown rendering.
function renderLegacyNote(doc, payload) {
  const notice = document.createElement("div");
  notice.className = "legacy-notice";
  const message = document.createElement("span");
  message.textContent = `This note is shown in its original ${doc.extension === ".org" ? "Org" : "Markdown"} format.`;
  notice.append(message, readerButton("Convert to editable blocks", "secondary-button", () => convertLegacyNote(doc)));
  const article = document.createElement("div");
  article.className = "document-article";
  article.innerHTML = renderTextDocument(payload.content || "", doc);
  readerContent.append(notice, article);
}

async function convertLegacyNote(doc) {
  try {
    const response = await fetch(`/api/notes/convert?path=${encodeURIComponent(doc.path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not convert the note.");
    if (state.selected?.path !== doc.path) return;
    renderSelectedDocument(doc, result, { focus: "body" });
  } catch (error) {
    showToast(error.message);
  }
}

function autoSizeTitle(input) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

// A note's folded sections (the block IDs of their headings), remembered in
// this browser like Explore's closed sections; folding never changes the note.
function foldedSections(path) {
  try {
    const ids = JSON.parse(localStorage.getItem(`zetesis.note.folded.${path}`) || "[]");
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberFoldedSections(path, ids) {
  try {
    const key = `zetesis.note.folded.${path}`;
    if (ids.length) localStorage.setItem(key, JSON.stringify(ids));
    else localStorage.removeItem(key);
  } catch { /* Remembering it is optional. */ }
}

function openBlockEditor(doc, payload, statusElement, { focus = "" } = {}) {
  const page = document.createElement("div");
  page.className = "note-page";
  const titleInput = document.createElement("textarea");
  titleInput.className = "note-title-input";
  titleInput.rows = 1;
  titleInput.maxLength = 300;
  titleInput.placeholder = "Untitled";
  titleInput.spellcheck = true;
  titleInput.setAttribute("aria-label", "Note title");
  const editorElement = document.createElement("div");
  editorElement.className = "note-editor";
  page.append(titleInput, editorElement);
  // The note's headings, beside it (the editor fills it in and shows it).
  const outline = document.createElement("nav");
  outline.className = "note-outline";
  outline.hidden = true;
  outline.setAttribute("aria-label", "Outline");
  readerContent.append(outline, page);

  if (!window.ZetesisEditor) {
    titleInput.value = doc.title;
    titleInput.readOnly = true;
    editorElement.textContent = "The editor could not be loaded. Reload the page to try again.";
    statusElement.textContent = "Read-only";
    return;
  }

  // Edits whose background save failed after the note was closed come back here.
  const draft = state.unsavedDrafts.get(doc.path);
  const session = {
    path: doc.path,
    version: draft ? draft.version : payload.version,
    titleInput,
    statusElement,
    savedTitle: doc.title,
    savedBody: "",
    controller: null,
    timer: null,
    inFlight: null,
    queued: false,
    conflict: false,
    paused: false,
    disposed: false,
    finalSnapshot: null,
    ready: false,
  };
  state.editorSession = session;
  titleInput.value = draft ? draft.title : doc.title;

  const supported = payload.body_format_version === window.ZetesisEditor.BODY_FORMAT_VERSION;
  session.controller = window.ZetesisEditor.createNoteEditor({
    element: editorElement,
    content: draft ? draft.body : payload.body,
    scrollContainer: readerContent,
    editable: supported,
    onChange: () => {
      if (session.ready) scheduleNoteSave(session);
    },
    onOpenNote: openLinkedNote,
    onEscape: () => closeNoteViewer(),
    onNotice: showToast,
    askText,
    uploadFile: (file) => uploadAsset(file, doc.path),
    findNotes: findNotesForLink,
    listPdfNotes,
    folded: foldedSections(doc.path),
    onFoldChange: (ids) => rememberFoldedSections(doc.path, ids),
    outline,
  });
  session.savedBody = draft ? "" : JSON.stringify(session.controller.getJSON());
  session.ready = true;

  if (!supported || session.controller.contentError) {
    // Never autosave a document this editor cannot represent faithfully.
    session.conflict = true;
    titleInput.readOnly = true;
    setSaveStatus(session, "readonly", supported
      ? "This note's content does not match the editor schema, so it was opened read-only to protect it."
      : "This note was saved by a newer version of Zetesis and is read-only here.");
  } else if (draft) {
    scheduleNoteSave(session, 0);
    showToast("Restored edits that had not been saved yet");
  } else {
    setSaveStatus(session, "saved");
  }

  autoSizeTitle(titleInput);
  titleInput.addEventListener("input", () => {
    autoSizeTitle(titleInput);
    scheduleNoteSave(session);
  });
  titleInput.addEventListener("keydown", (event) => {
    const atEnd = titleInput.selectionStart === titleInput.value.length;
    if (event.key === "Enter" || (event.key === "ArrowDown" && atEnd)) {
      event.preventDefault();
      session.controller.focus("start");
    }
  });

  if (focus === "title") {
    titleInput.focus();
    titleInput.select();
  } else if (focus === "body") {
    session.controller.focus("start");
  }
}

function noteSnapshot(session) {
  if (session.disposed) return session.finalSnapshot;
  const body = session.controller.getJSON();
  return {
    title: session.titleInput.value.trim() || "Untitled",
    body,
    bodyText: JSON.stringify(body),
  };
}

function noteSessionIsDirty(session) {
  if (!session?.controller || session.controller.contentError) return false;
  const snapshot = noteSnapshot(session);
  return Boolean(snapshot) && (snapshot.bodyText !== session.savedBody || snapshot.title !== session.savedTitle);
}

const SAVE_STATUS_LABELS = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  error: "Not saved",
  conflict: "Changed elsewhere",
  readonly: "Read-only",
};

function setSaveStatus(session, status, detail = "") {
  if (session.disposed) return;
  const element = session.statusElement;
  element.dataset.state = status;
  element.title = detail;
  element.replaceChildren(SAVE_STATUS_LABELS[status] || "");
  if (status === "error") {
    element.append(" · ", readerButton("Retry", "save-status-action", () => saveNoteSession(session)));
  } else if (status === "conflict") {
    element.append(" · ", readerButton("Reload", "save-status-action", () => reloadConflictedNote(session)));
  }
}

function scheduleNoteSave(session, delay = AUTOSAVE_DELAY_MS) {
  if (session.disposed || session.conflict || session.paused) return;
  window.clearTimeout(session.timer);
  if (!session.inFlight) setSaveStatus(session, "unsaved");
  session.timer = window.setTimeout(() => saveNoteSession(session), delay);
}

// Saves run one at a time per note, always against the last version this
// window saw; the server refuses a stale version (409) instead of overwriting.
async function saveNoteSession(session, { keepalive = false } = {}) {
  window.clearTimeout(session.timer);
  session.timer = null;
  if (session.conflict || session.paused || !session.controller || session.controller.contentError) return false;
  if (session.inFlight) {
    session.queued = true;
    return session.inFlight;
  }
  const snapshot = noteSnapshot(session);
  if (!snapshot || (snapshot.bodyText === session.savedBody && snapshot.title === session.savedTitle)) {
    setSaveStatus(session, "saved");
    return true;
  }

  setSaveStatus(session, "saving");
  const request = (async () => {
    const response = await fetch(`/api/notes?path=${encodeURIComponent(session.path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      keepalive,
      body: JSON.stringify({
        title: snapshot.title,
        version: session.version,
        body: snapshot.body,
        body_format_version: window.ZetesisEditor.BODY_FORMAT_VERSION,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Could not save the note (${response.status}).`);
      error.conflict = response.status === 409;
      throw error;
    }
    return result;
  })();
  session.inFlight = request.then(() => true, () => false);
  state.pendingSaves.set(session.path, session.inFlight);

  let saved = false;
  try {
    const result = await request;
    saved = true;
    session.version = result.version;
    session.savedBody = snapshot.bodyText;
    session.savedTitle = snapshot.title;
    state.unsavedDrafts.delete(session.path);
    applySavedNoteMetadata(result);
    if (!session.disposed) setSaveStatus(session, noteSessionIsDirty(session) ? "unsaved" : "saved");
  } catch (error) {
    session.conflict = Boolean(error.conflict);
    if (session.disposed) {
      // The note was closed before this save failed: keep the latest edits
      // so reopening the note restores them.
      const latest = session.finalSnapshot || snapshot;
      state.unsavedDrafts.set(session.path, { title: latest.title, body: latest.body, version: session.version });
      showToast(`Couldn't save “${latest.title}”: ${error.message} Reopen the note to restore your edits.`);
    } else {
      setSaveStatus(session, session.conflict ? "conflict" : "error", error.message);
    }
  } finally {
    const pending = session.inFlight;
    const queued = session.queued;
    session.inFlight = null;
    session.queued = false;
    if (queued && saved && !session.conflict) {
      saveNoteSession(session, { keepalive });
    } else if (state.pendingSaves.get(session.path) === pending) {
      state.pendingSaves.delete(session.path);
    }
  }
  return saved;
}

function applySavedNoteMetadata(result) {
  const previous = state.documents.find((item) => item.path === result.path);
  const merge = (item) => (item.path === result.path ? { ...item, ...result } : item);
  state.documents = state.documents.map(merge);
  state.results = state.results.map(merge);
  if (state.selected?.path === result.path) state.selected = { ...state.selected, ...result };
  if (state.selectedPayload && state.selected?.path === result.path) state.selectedPayload.version = result.version;
  if (previous && previous.title !== result.title) updateList();
}

async function reloadConflictedNote(session) {
  const reload = await askConfirm({
    title: "Load the latest saved version?",
    message: "Edits in this window that weren't saved will be lost.",
    confirmLabel: "Load latest",
    danger: true,
  });
  if (!reload || session.disposed) return;
  const doc = state.documents.find((item) => item.path === session.path);
  closeEditorSession({ save: false });
  state.unsavedDrafts.delete(session.path);
  if (doc) selectDocument(doc);
}

// Close the open editor. Pending edits are saved in the background unless
// `save` is false (for example when the note is being deleted).
function closeEditorSession({ save = true } = {}) {
  const session = state.editorSession;
  if (!session) return;
  state.editorSession = null;
  window.clearTimeout(session.timer);
  if (save && noteSessionIsDirty(session) && !session.conflict) {
    session.finalSnapshot = noteSnapshot(session);
    session.disposed = true;
    if (!session.inFlight) saveNoteSession(session);
    else session.queued = true;
  } else {
    session.disposed = true;
  }
  session.controller?.destroy();
}

const UPLOAD_TYPES_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  org: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
const UPLOAD_TYPES = new Set(Object.values(UPLOAD_TYPES_BY_EXTENSION));

// The type a file is uploaded as, or null when a note can't hold it.
function uploadType(file) {
  const extension = (file.name || "").split(".").pop().toLowerCase();
  return UPLOAD_TYPES.has(file.type) ? file.type : UPLOAD_TYPES_BY_EXTENSION[extension] || null;
}

async function uploadAsset(file, notePath) {
  const type = uploadType(file);
  if (!type) throw new Error("This type of file can't be added to a note.");
  if (!file.size) throw new Error("The file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`Files can be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
  const params = new URLSearchParams({ filename: file.name || "file", note: notePath });
  const response = await fetch(`/api/assets?${params}`, {
    method: "POST",
    headers: { "Content-Type": type },
    body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "The upload failed.");
  return result;
}

function findNotesForLink(query) {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return state.documents
    .filter((doc) => doc.path !== state.selected?.path)
    .filter((doc) => terms.every((term) => `${doc.title} ${doc.path}`.toLocaleLowerCase().includes(term)))
    .slice(0, 6)
    .map((doc) => ({ path: doc.path, title: doc.title, meta: formatFolderPath(doc.folder || doc.collection) }));
}

function listPdfNotes() {
  return state.documents
    .filter((doc) => doc.extension === ".pdf")
    .map((doc) => ({ path: doc.path, title: doc.title, meta: formatFolderPath(doc.folder || doc.collection) }));
}

function openLinkedNote(path) {
  const doc = state.documents.find((item) => item.path === path);
  if (!doc) {
    showToast("The linked note no longer exists.");
    return;
  }
  if (doc.path === state.selected?.path) return;
  history.pushState(null, "", `/?note=${encodeURIComponent(doc.path)}`);
  revealDocument(doc);
}

async function moveNoteToFolder(path, folder) {
  const collection = folder.split("/")[0];
  try {
    const response = await fetch("/api/notes/location", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, collection, folder }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not move note.");
    const moved = state.documents.find((doc) => doc.path === path);
    // The server puts a moved note at the top of the list.
    if (moved) state.documents = [{ ...moved, ...result }, ...state.documents.filter((doc) => doc !== moved)];
    state.results = state.query ? state.results.map((doc) => doc.path === path ? { ...doc, ...result } : doc) : state.documents;
    if (state.selected?.path === path) {
      state.selected = { ...state.selected, ...result };
      if (state.selectedPayload) state.selectedPayload.version = result.version;
      // Moving bumps the note version; keep the open editor's saves current.
      if (state.editorSession?.path === path) state.editorSession.version = result.version;
    }
    state.folder = folder;
    state.expanded.add(folder);
    buildFolderTree(state.documents);
    highlightActiveFolder();
    updateList();
    showToast(`Moved to ${formatFolderPath(folder)}`);
  } catch (error) {
    showToast(error.message);
  }
}

function openNewNoteDialog() {
  if (!confirmDiscardEditor()) return;
  const select = $("#new-note-topic");
  select.replaceChildren();
  for (const [key, label] of Object.entries(state.collections)) {
    if (key === FOLLOWING_TOPIC) continue;
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    select.append(option);
  }
  const currentCollection = state.folder ? state.folder.split("/")[0] : "inbox";
  select.value = state.collections[currentCollection] ? currentCollection : "inbox";
  $("#new-note-title").value = "Untitled";
  chooseNoteFile(null);
  showNewNoteError("");
  $("#note-dialog").showModal();
  $("#new-note-title").focus();
  $("#new-note-title").select();
}

// ── New notes from a file ───────────────────────────────────────────────────
// A PDF becomes a PDF note; a Markdown, Org or text file, a note with its
// text; any other file, a note holding it.

const MAX_PDF_NOTE_BYTES = 200 * 1024 * 1024;
const MAX_TEXT_NOTE_BYTES = 5 * 1024 * 1024;
const FILE_NOTE_HINTS = {
  pdf: "Becomes a PDF note you can read and highlight.",
  text: "Its text becomes the note, ready to edit.",
  file: "The note will hold the file, to open or download.",
};
// The chosen file, and the title it suggested (kept only while untouched).
const newNoteFile = { file: null, title: "" };

// What a new note makes of `file`: "pdf", "text" or "file". The name usually
// says; a PDF is also known by its first bytes, as when its name lost ".pdf".
async function fileNoteKind(file) {
  const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
  if (extension === "pdf") return "pdf";
  if (["md", "markdown", "org", "txt"].includes(extension)) return "text";
  const start = await file.slice(0, 5).text().catch(() => "");
  return start === "%PDF-" ? "pdf" : "file";
}

// The name a PDF is stored under: "notes" and "notespdf" become "notes.pdf".
function pdfFileName(name) {
  if (/\.pdf$/i.test(name)) return name;
  return `${name.replace(/[\s._-]*pdf$/i, "") || "document"}.pdf`;
}

// "lecture_notes-week-3.pdf" → "Lecture notes week 3", as the server names imported files.
function fileTitle(name) {
  const stem = name.replace(/\.[^.]*$/, "").replace(/[_-]+/g, " ").trim();
  return stem ? stem[0].toUpperCase() + stem.slice(1) : name;
}

function fileNoteTitle(file, kind) {
  return fileTitle(kind === "pdf" ? pdfFileName(file.name) : file.name);
}

// Why a note can't be made from `file`, or "" when it can.
function fileNoteProblem(file, kind) {
  if (!file.size) return "The file is empty.";
  if (kind === "pdf" && file.size > MAX_PDF_NOTE_BYTES) return `PDFs can be at most ${MAX_PDF_NOTE_BYTES / (1024 * 1024)} MB.`;
  if (kind === "text" && file.size > MAX_TEXT_NOTE_BYTES) return `Text files can be at most ${MAX_TEXT_NOTE_BYTES / (1024 * 1024)} MB.`;
  if (kind === "file" && !uploadType(file)) {
    return "This type of file can't be added to a note. Notes can start from PDFs, Markdown, Org and text files, images, Office documents, audio, and video.";
  }
  if (kind === "file" && file.size > MAX_UPLOAD_BYTES) return `Files like this can be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`;
  return "";
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Shows the chosen file (or none) in the New note dialog, with what it will
// become, or why it can't, before anything is uploaded.
async function chooseNoteFile(file) {
  newNoteFile.file = file;
  const kind = file ? await fileNoteKind(file) : null;
  if (newNoteFile.file !== file) return;
  const problem = file ? fileNoteProblem(file, kind) : "";
  const titleInput = $("#new-note-title");
  const untouched = !titleInput.value.trim() || titleInput.value === "Untitled" || titleInput.value === newNoteFile.title;
  if (file) {
    newNoteFile.title = fileNoteTitle(file, kind);
    if (untouched) titleInput.value = newNoteFile.title;
    $("#new-note-file-name").textContent = `${file.name} · ${formatFileSize(file.size)}`;
    $("#new-note-file-hint").textContent = problem ? "" : FILE_NOTE_HINTS[kind];
  } else {
    if (newNoteFile.title && titleInput.value === newNoteFile.title) titleInput.value = "Untitled";
    newNoteFile.title = "";
  }
  const zone = $("#new-note-file-zone");
  zone.classList.toggle("has-file", Boolean(file));
  zone.querySelector(".note-file-empty").hidden = Boolean(file);
  zone.querySelector(".note-file-chosen").hidden = !file;
  $("#create-note").textContent = file ? "Create from file" : "Create note";
  showNewNoteError(problem);
}

function showNewNoteError(message) {
  $("#new-note-error").textContent = message;
  $("#new-note-error").hidden = !message;
}

async function postNote(note) {
  const response = await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Could not create note.");
  return result;
}

// PDFs and text files go to the server whole; any other file is uploaded,
// then put in a new note of its own.
async function uploadNote(file, { title, collection, folder }) {
  const kind = await fileNoteKind(file);
  const problem = fileNoteProblem(file, kind);
  if (problem) throw new Error(problem);
  if (kind === "file") {
    const asset = await uploadAsset(file, "");
    const block = asset.mimeType.startsWith("image/")
      ? { type: "image", attrs: { assetId: asset.id, alt: asset.name } }
      : { type: "fileBlock", attrs: { assetId: asset.id, name: asset.name, mimeType: asset.mimeType, size: asset.size } };
    return postNote({
      title, collection, folder,
      body: { type: "doc", content: [block, { type: "paragraph" }] },
      body_format_version: window.ZetesisEditor.BODY_FORMAT_VERSION,
    });
  }
  const filename = kind === "pdf" ? pdfFileName(file.name) : file.name;
  const params = new URLSearchParams({ filename, title, collection, folder });
  const response = await fetch(`/api/notes/file?${params}`, {
    method: "POST",
    headers: { "Content-Type": kind === "pdf" ? "application/pdf" : "text/plain" },
    body: file,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Could not create the note.");
  return result;
}

async function createNoteFromDialog(event) {
  event.preventDefault();
  const title = $("#new-note-title").value.trim() || "Untitled";
  const collection = $("#new-note-topic").value || "inbox";
  const folder = state.folder.startsWith(`${collection}/`) || state.folder === collection ? state.folder : collection;
  const button = $("#create-note");
  const label = button.textContent;
  button.disabled = true;
  if (newNoteFile.file) button.textContent = "Uploading…";
  try {
    await createNote({ title, collection, folder, file: newNoteFile.file });
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// Pick a file, then make a note from it in `folder` (the folder menu's
// "New note from a file…").
function createNoteFromPickedFile(folder) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.addEventListener("change", async () => {
    const [file] = picker.files;
    if (file) createNote({ title: fileNoteTitle(file, await fileNoteKind(file)), collection: pathParts(folder)[0], folder, file });
  });
  picker.click();
}

// Create a note in `folder` (from `file`, if there is one) and open it.
async function createNote({ title, collection, folder, file = null }) {
  if (state.view !== "notes" && !switchToNotes({ retry: () => createNote({ title, collection, folder, file }) })) return;
  try {
    const result = file ? await uploadNote(file, { title, collection, folder }) : await postNote({ title, collection, folder });
    if ($("#note-dialog").open) $("#note-dialog").close();
    state.query = "";
    $("#search-input").value = "";
    $("#clear-search").hidden = true;
    state.folder = folder;
    state.expanded.add(folder);
    state.documents.unshift(result);
    state.results = state.documents;
    buildFolderTree(state.documents);
    highlightActiveFolder();
    updateHeading();
    updateList();
    selectDocument(result, { edit: true });
  } catch (error) {
    if ($("#note-dialog").open) showNewNoteError(error.message);
    else showToast(error.message);
  }
}

async function deleteNote(path) {
  const title = state.documents.find((doc) => doc.path === path)?.title;
  const remove = await askConfirm({
    title: title ? `Delete “${title}”?` : "Delete this note?",
    message: "It will be deleted permanently. This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!remove) return;
  // Hold autosave while deleting; the edits are discarded only if the delete succeeds.
  const session = state.editorSession?.path === path ? state.editorSession : null;
  if (session) {
    window.clearTimeout(session.timer);
    session.paused = true;
  }
  try {
    await waitForPendingSave(path);
    const response = await fetch(`/api/notes?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not delete note.");
    rememberFoldedSections(path, []);
    if (session) closeEditorSession({ save: false });
    state.documents = state.documents.filter((doc) => doc.path !== path);
    state.results = state.results.filter((doc) => doc.path !== path);
    state.requestId += 1;
    if (state.selected?.path === path) clearReader({ resetUrl: true });
    buildFolderTree(state.documents);
    highlightActiveFolder();
    updateList();
    showToast(result.warning || "Note deleted permanently");
  } catch (error) {
    if (session && !session.disposed) {
      session.paused = false;
      if (noteSessionIsDirty(session)) scheduleNoteSave(session);
    }
    showToast(error.message);
  }
}

// openRoadmapEditor / saveRoadmapEditor retained for compatibility but not used in UI
async function openRoadmapEditor() {}
async function saveRoadmapEditor(event) { event.preventDefault(); }

function selectDocument(doc, { edit = false } = {}) {
  if (!confirmDiscardEditor(() => selectDocument(doc, { edit }))) return;
  closeEditorSession();
  disposePdfViewer();
  state.selected = doc;
  if (!noteViewer.open) noteViewer.showModal();

  for (const card of noteList.querySelectorAll(".note-card")) {
    const isSelected = card.dataset.path === doc.path;
    card.classList.toggle("selected", isSelected);
    card.setAttribute("aria-current", isSelected ? "true" : "false");
  }

  readerContent.hidden = false;
  readerContent.style.display = "block";
  // The note has the focus, not the dialog's first button (←), so keys scroll it.
  readerContent.focus({ preventScroll: true });
  readerContent.innerHTML = '<div class="document-article">Loading note…</div>';

  const requestId = ++state.documentRequestId;
  if (doc.extension === ".pdf") {
    renderSelectedDocument(doc, { content: "", version: doc.version });
    history.replaceState(null, "", noteUrl(doc.path));
    return;
  }

  waitForPendingSave(doc.path)
    .then(() => fetch(`/api/document?path=${encodeURIComponent(doc.path)}`))
    .then((res) => {
      if (!res.ok) throw new Error("Could not load note content.");
      return res.json();
    })
    .then((payload) => {
      if (requestId !== state.documentRequestId || state.selected?.path !== doc.path) return;
      renderSelectedDocument(doc, payload, { focus: edit ? "title" : "" });
      history.replaceState(null, "", noteUrl(doc.path));
    })
    .catch((err) => {
      const article = readerContent.querySelector(".document-article");
      if (article) article.textContent = err.message;
    });
}

// A note's background save must finish before it is loaded again.
async function waitForPendingSave(path) {
  while (state.pendingSaves.has(path)) await state.pendingSaves.get(path);
}

// ── Questions, asked in the app ─────────────────────────────────────────────
// In place of the browser's confirm() and prompt(), which can't be styled.
// ask() resolves with true, or with the text typed when there's an `input`;
// null when cancelled (Escape, Cancel, or a click outside).

const askDialog = $("#ask-dialog");
const askInput = $("#ask-input");
let askAnswer = null;

function finishAsking(confirmed) {
  const answer = askAnswer;
  askAnswer = null;
  if (askDialog.open) askDialog.close();
  answer?.(confirmed);
}

function ask({ title, message = "", confirmLabel = "OK", danger = false, input = null }) {
  if (askAnswer) finishAsking(false);
  $("#ask-title").textContent = title;
  $("#ask-message").textContent = message;
  $("#ask-message").hidden = !message;
  askInput.hidden = !input;
  if (input) {
    askInput.value = input.value ?? "";
    askInput.placeholder = input.placeholder ?? "";
    askInput.setAttribute("aria-label", title);
  }
  const confirm = $("#ask-confirm");
  confirm.textContent = confirmLabel;
  confirm.classList.toggle("is-danger", danger);
  askDialog.showModal();
  if (input) askInput.select();
  // Enter shouldn't do something that can't be undone.
  else (danger ? $("#ask-cancel") : confirm).focus();
  return new Promise((resolve) => {
    askAnswer = (confirmed) => resolve(confirmed ? (input ? askInput.value : true) : null);
  });
}

const askConfirm = (question) => ask(question).then((answer) => answer === true);
const askText = ({ value, placeholder, ...question }) => ask({ ...question, input: { value, placeholder } });

$("#ask-form").addEventListener("submit", (event) => {
  event.preventDefault();
  finishAsking(true);
});
$("#ask-cancel").addEventListener("click", () => finishAsking(false));
askDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  finishAsking(false);
});
askDialog.addEventListener("click", (event) => {
  if (event.target === askDialog) finishAsking(false);
});
// The browser may close the dialog on Escape without asking twice.
askDialog.addEventListener("close", () => {
  if (askAnswer && !askDialog.open) finishAsking(false);
});

function showToast(message, { action = "", onAction = null } = {}) {
  const toast = $("#toast");
  const text = document.createElement("span");
  text.textContent = message;
  toast.replaceChildren(text);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action;
    button.addEventListener("click", () => {
      toast.classList.remove("visible");
      onAction();
    });
    toast.append(button);
  }
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), action ? 6000 : 2200);
}

async function runSearch(query) {
  if (state.view === "map") {
    $("#clear-search").hidden = !query;
    renderMap();
    return;
  }
  if (state.view === "home") {
    renderHomeSuggestions(query);
    $("#clear-search").hidden = !state.query;
    return;
  }
  state.query = query.trim();
  const reqId = ++state.requestId;
  $("#clear-search").hidden = !state.query;
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
  if (!switchToNotes({ retry: selectAllNotes })) return;
  state.folder = "";
  highlightActiveFolder();
  updateHeading();
  if (state.query) runSearch(state.query);
  else updateList();
}

function formatFolderPath(path) {
  const parts = pathParts(path);
  return parts.map((_, index) => folderLabel(parts.slice(0, index + 1).join("/"))).join(" / ");
}

function getHomeFolders() {
  const folders = new Map();
  const addFolder = (path, label) => {
    if (path && !folders.has(path)) folders.set(path, { path, label });
  };

  for (const key of Object.keys(state.collections)) if (key !== FOLLOWING_TOPIC) addFolder(key, folderLabel(key));
  for (const folder of state.folders) addFolder(folder.path, folder.label);
  for (const doc of state.documents) {
    const collection = doc.collection || "general";
    if (collection === FOLLOWING_TOPIC) continue;
    addFolder(collection, folderLabel(collection));
    let currentPath = collection;
    let parts = pathParts(doc.folder);
    if (parts[0] === collection) parts = parts.slice(1);
    else if (collection === "general") parts = [];
    for (const part of parts) {
      currentPath = `${currentPath}/${part}`;
      addFolder(currentPath, folderLabel(currentPath));
    }
  }
  return [...folders.values()];
}

// A folder or note result, or with `key` and `open`, another kind of place
// (Explore and its areas and items, Following).
function renderHomeResult({ kind, title, meta = "", doc = null, folderPath = "", key = "", open = null }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "home-result";
  button.dataset.key = key || (kind === "folder" ? `folder:${folderPath}` : `note:${doc.path}`);
  const symbol = document.createElement("span");
  symbol.className = "home-result-symbol";
  if (kind === "note") {
    symbol.classList.add("file-badge", ...(doc.extension === ".pdf" ? ["pdf"] : []));
    symbol.textContent = doc.extension.slice(1).toUpperCase();
  } else {
    symbol.innerHTML = HOME_RESULT_ICONS[kind];
  }

  const copy = document.createElement("span");
  copy.className = "home-result-copy";
  const titleEl = document.createElement("span");
  titleEl.className = "home-result-title";
  titleEl.textContent = title;
  copy.append(titleEl);
  if (meta) {
    const metaEl = document.createElement("span");
    metaEl.className = "home-result-meta";
    metaEl.textContent = meta;
    copy.append(metaEl);
  }
  button.append(symbol, copy);
  if (open) button.addEventListener("click", () => open());
  else if (kind === "folder") button.addEventListener("click", () => openHomeFolder(folderPath));
  else button.addEventListener("click", () => openHomeNote(doc));
  return button;
}

function appendHomeSuggestionGroup(label, results) {
  if (!results.length) return;
  const group = document.createElement("section");
  group.className = "home-suggestion-group";
  const heading = document.createElement("h2");
  heading.className = "home-suggestion-heading";
  heading.textContent = label;
  group.append(heading);
  for (const result of results) group.append(result);
  homeSuggestions.append(group);
}

let homeExploreLoad = null;

// `keepSelection` keeps the selected result when the results are redrawn
// for the same query (once Explore has loaded).
function renderHomeSuggestions(query, { keepSelection = false } = {}) {
  state.query = query.trim();
  homeSuggestions.replaceChildren();
  const normalized = state.query.toLocaleLowerCase();
  if (!normalized) return;
  const terms = normalized.split(/\s+/).filter(Boolean);
  const matches = (value) => {
    const haystack = value.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const rank = (title, path) => {
    const normalizedTitle = title.toLocaleLowerCase();
    if (normalizedTitle.startsWith(normalized)) return 0;
    if (normalizedTitle.includes(normalized)) return 1;
    if (path.toLocaleLowerCase().includes(normalized)) return 2;
    return 3;
  };

  const folders = getHomeFolders()
    .filter((folder) => matches(`${folder.label} ${formatFolderPath(folder.path)}`))
    .sort((a, b) => rank(a.label, a.path) - rank(b.label, b.path) || a.label.localeCompare(b.label))
    .slice(0, 8)
    .map((folder) => renderHomeResult({
      kind: "folder",
      title: folder.label,
      meta: pathParts(folder.path).length > 1 ? formatFolderPath(folder.path).split(" / ").slice(0, -1).join(" / ") : "",
      folderPath: folder.path,
    }));

  // Explore, Roadmap and Following by their names (or the Following note's
  // title), from the start of the name, so that "in" finds the Inbox before
  // Following.
  const named = (name) => name.toLocaleLowerCase().startsWith(normalized);
  const followingNote = state.documents.find((doc) => doc.collection === FOLLOWING_TOPIC);
  const pages = [];
  if (named("Explore")) {
    pages.push(renderHomeResult({ kind: "explore", title: "Explore", key: "section:explore", open: () => openExploreResult() }));
  }
  if (named("Roadmap")) {
    pages.push(renderHomeResult({ kind: "map", title: "Roadmap", key: "section:map", open: () => switchToMap() }));
  }
  if (named("Following") || (followingNote && named(followingNote.title))) {
    pages.push(renderHomeResult({
      kind: "following",
      title: "Following",
      meta: followingNote && followingNote.title !== "Following" ? followingNote.title : "",
      key: "section:following",
      open: openFollowingNote,
    }));
  }

  const notes = state.documents
    .filter((doc) => doc.collection !== FOLLOWING_TOPIC && matches(`${doc.title} ${doc.path}`))
    .sort((a, b) => rank(a.title, a.path) - rank(b.title, b.path) || a.title.localeCompare(b.title))
    .slice(0, 12)
    .map((doc) => renderHomeResult({
      kind: "note",
      title: doc.title,
      meta: formatFolderPath(doc.folder || doc.collection),
      doc,
    }));

  // Explore's areas and sections, then its items (open ones first), by what they read.
  if (!state.roadmap && !homeExploreLoad) {
    homeExploreLoad = loadRoadmap()
      .then(() => {
        if (state.view === "home" && state.query) renderHomeSuggestions(searchInput.value, { keepSelection: true });
      })
      .catch(() => {})
      .finally(() => {
        homeExploreLoad = null;
      });
  }
  const lists = exploreAreas().flatMap((area, index) => exploreLists(area, [index]));
  const exploreResults = lists
    .filter(({ list, place }) => matches(place.length === 1 ? `${list.name} Explore` : list.name))
    .sort((a, b) => a.place.length - b.place.length || rank(a.list.name, "") - rank(b.list.name, ""))
    .slice(0, 6)
    .map(({ list, place }) => renderHomeResult({
      kind: "area",
      title: list.name,
      meta: ["Explore", ...exploreTrail(place.slice(0, -1))].join(" / "),
      key: place.length === 1 ? `area:${list.name}` : `section:${place.join(".")}`,
      open: () => openExploreResult(place),
    }));
  const items = lists
    .flatMap(({ list, place }) => list.items.map((item, index) => ({ place, item, index, text: plainTitle(item.title) })))
    .filter(({ text }) => matches(text))
    .sort((a, b) => a.item.done - b.item.done || rank(a.text, "") - rank(b.text, ""))
    .slice(0, 8)
    .map(({ place, item, index, text }) => renderHomeResult({
      kind: item.done ? "done" : "item",
      title: text,
      meta: `Explore / ${exploreTrail(place).join(" / ")}${item.done ? " · done" : ""}`,
      key: `item:${place.join(".")}:${index}`,
      open: () => openExploreResult(place, index),
    }));

  appendHomeSuggestionGroup("Pages", pages);
  appendHomeSuggestionGroup("Topics", folders);
  appendHomeSuggestionGroup("Notes", notes);
  appendHomeSuggestionGroup("Explore", [...exploreResults, ...items]);
  const found = pages.length + folders.length + notes.length + exploreResults.length + items.length;
  if (keepSelection && nav.position >= 0) showNav();
  else setNav(found ? 0 : -1);
  if (!found) {
    const empty = document.createElement("div");
    empty.className = "home-empty";
    empty.textContent = "No matches.";
    homeSuggestions.append(empty);
  }
}

// Open Explore from a search result at `place`: the list of areas, an area, a
// section in one (open, with its heading selected), or an item, selected.
async function openExploreResult(place = [], itemIndex = -1) {
  const areaName = place.length ? exploreAreas()[place[0]]?.name ?? "" : "";
  for (let depth = 2; depth <= place.length; depth += 1) setSectionOpen(place.slice(0, depth), true);
  await switchToRoadmap({ topic: areaName, syncUrl: false });
  if (state.view !== "roadmap" || state.roadmapTopic !== areaName) return;
  const params = new URLSearchParams({ view: "roadmap" });
  if (areaName) params.set("topic", areaName);
  history.pushState(null, "", `/?${params}`);
  let key = place.length > 1 ? `section:${place.join(".")}` : "";
  if (itemIndex >= 0) {
    key = `item:${place.join(".")}:${itemIndex}`;
    const doneKey = exploreTrail(place).join("/");
    if (exploreNode(exploreAreas(), place)?.items[itemIndex]?.done && !exploreDoneOpen(doneKey)) {
      setExploreDoneOpen(doneKey, true);
      renderRoadmap();
    }
  }
  const position = key ? navRows().findIndex((row) => rowKey(row) === key) : -1;
  if (position < 0) return;
  document.activeElement?.blur?.();
  document.body.classList.add("keyboard-nav");
  setNav(position, key);
}

function openHomeFolder(folderPath, { syncUrl = true } = {}) {
  if (!switchToNotes({ retry: () => openHomeFolder(folderPath, { syncUrl }) })) return;
  state.folder = folderPath;
  state.query = "";
  $("#search-input").value = "";
  $("#clear-search").hidden = true;
  let currentPath = "";
  for (const part of pathParts(folderPath)) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    state.expanded.add(currentPath);
  }
  buildFolderTree(state.documents);
  highlightActiveFolder();
  updateList();
  if (syncUrl) history.pushState(null, "", `/?folder=${encodeURIComponent(folderPath)}`);
}

function openHomeNote(doc) {
  if (!switchToNotes({ retry: () => openHomeNote(doc) })) return;
  state.query = "";
  $("#search-input").value = "";
  $("#clear-search").hidden = true;
  state.folder = doc.folder || doc.collection;
  let currentPath = "";
  for (const part of pathParts(state.folder)) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    state.expanded.add(currentPath);
  }
  buildFolderTree(state.documents);
  highlightActiveFolder();
  updateList();
  history.pushState(null, "", `/?note=${encodeURIComponent(doc.path)}`);
  selectDocument(doc);
}

function revealDocument(doc) {
  if (!switchToNotes({ retry: () => revealDocument(doc) })) return;
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

function applyDeepLink() {
  const targetPath = new URLSearchParams(location.search).get("note");
  if (!targetPath) return;

  const doc = state.documents.find((d) => d.path === targetPath);
  if (!doc) return;

  if (doc.collection === FOLLOWING_TOPIC) {
    switchToHome({ syncUrl: false, focus: false });
    selectDocument(doc);
  } else {
    revealDocument(doc);
  }
}

async function initialize() {
  try {
    const res = await fetch("/api/catalog");
    if (!res.ok) throw new Error("Could not load notes catalog.");
    applyCatalog(await res.json());

    // Auto-expand top-level collections
    for (const key of Object.keys(state.collections)) {
      state.expanded.add(key);
    }

    buildFolderTree(state.documents);

    const params = new URLSearchParams(location.search);
    // For Explore's count in the sidebar, and its areas and items in search.
    if (params.get("view") !== "roadmap") loadRoadmap().catch(() => {});
    if (params.get("view") === "roadmap") {
      await switchToRoadmap({ topic: params.get("topic") || "", syncUrl: false });
    } else if (params.get("view") === "map") {
      switchToMap({ syncUrl: false });
    } else if (params.get("view") === "following") {
      // Following used to be its own page; its note opens instead.
      switchToHome({ syncUrl: true, focus: false });
      openFollowingNote();
    } else {
      if (params.get("view") === "trash") history.replaceState(null, "", "/");
      if (params.has("note")) {
        const target = params.get("note");
        if (state.documents.some((doc) => doc.path === target)) applyDeepLink();
        else switchToHome({ syncUrl: true, focus: true });
      } else if (params.has("folder")) {
        openHomeFolder(params.get("folder"), { syncUrl: false });
      } else {
        switchToHome({ syncUrl: false, focus: true });
      }
    }
  } catch (err) {
    const message = document.createElement("div");
    message.className = state.view === "home" ? "home-empty" : "empty-list";
    message.textContent = err.message;
    if (state.view === "home") homeSuggestions.replaceChildren(message);
    else noteList.replaceChildren(message);
  }
}

// Event Listeners
navSearch.addEventListener("click", () => switchToHome());
$("#close-note-viewer").addEventListener("click", () => closeNoteViewer());

// The outline beside a note can be put away, for every note; that's remembered.
function showOutline(shown) {
  noteViewer.classList.toggle("outline-off", !shown);
  const button = $("#outline-toggle");
  button.title = shown ? "Hide the outline" : "Show the outline";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(shown));
}
try {
  showOutline(localStorage.getItem("zetesis.outline.hidden") !== "1");
} catch {
  showOutline(true);
}
$("#outline-toggle").addEventListener("click", () => {
  const shown = noteViewer.classList.contains("outline-off");
  showOutline(shown);
  try {
    if (shown) localStorage.removeItem("zetesis.outline.hidden");
    else localStorage.setItem("zetesis.outline.hidden", "1");
  } catch { /* Remembering it is optional. */ }
});
// Escape closes the note (asking first if that would lose anything).
noteViewer.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeNoteViewer();
});
navRoadmap.addEventListener("click", () => switchToRoadmap({ topic: "" }));
navMap.addEventListener("click", () => switchToMap());
navFollowing.addEventListener("click", openFollowingNote);
$("#new-note").addEventListener("click", openNewNoteDialog);
$("#new-topic").addEventListener("click", () => startNewFolder(""));
$("#note-form").addEventListener("submit", createNoteFromDialog);
$("#choose-note-file").addEventListener("click", () => $("#new-note-file").click());
$("#new-note-file").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) chooseNoteFile(file);
});
$("#remove-note-file").addEventListener("click", () => chooseNoteFile(null));
// A file dropped anywhere on the new-note dialog is the one to start from.
$("#note-dialog").addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  $("#new-note-file-zone").classList.add("is-dropping");
});
$("#note-dialog").addEventListener("dragleave", (event) => {
  if (!$("#note-dialog").contains(event.relatedTarget)) $("#new-note-file-zone").classList.remove("is-dropping");
});
$("#note-dialog").addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (!file) return;
  event.preventDefault();
  $("#new-note-file-zone").classList.remove("is-dropping");
  chooseNoteFile(file);
});
$("#cancel-new-note").addEventListener("click", () => $("#note-dialog").close());
$("#help-button").addEventListener("click", () => {
  helpOverlay.hidden = false;
});
$("#backup-button").addEventListener("click", () => {
  window.location.assign("/api/backup");
  showToast("Preparing a database and files backup…");
});

$("#search-input").addEventListener("input", (e) => {
  window.clearTimeout(state.searchTimer);
  // Out of sight (in Explore), the box isn't searching anything.
  if (searchBar.hidden) return;
  const q = e.target.value;
  if (state.view === "map") {
    runSearch(q);
    return;
  }
  if (state.view === "home") {
    runSearch(q);
    return;
  }
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
    applyCatalog(await res.json());

    buildFolderTree(state.documents);
    highlightActiveFolder();

    if (state.query) {
      await runSearch(state.query);
    } else {
      updateList();
    }

    state.roadmap = null;
    if (state.view === "roadmap") {
      await switchToRoadmap({ topic: state.roadmapTopic });
    } else {
      loadRoadmap().catch(() => {});
    }
    if (state.view === "map") await loadMap();

    showToast("App data refreshed");
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ⌘L and ⌘K: close the note in the way, then search.
function startSearch(searchFolder) {
  if (noteViewer.open && !closeNoteViewer({ retry: () => startSearch(searchFolder) })) return;
  if (searchFolder && state.view === "map") {
    openMapFind();
  } else if (state.view === "home" || (searchFolder && state.view === "notes")) {
    $("#search-input").focus();
    $("#search-input").select();
  } else {
    switchToHome();
  }
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && state.editorSession) {
    e.preventDefault();
    saveNoteSession(state.editorSession);
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && mapNoteFor) {
    // A box's note in Roadmap (map.js).
    e.preventDefault();
    saveMapNote();
  }
  // ⌘F searches the folder on screen; in an open note it's left to the
  // browser's find, which searches only the note (the page behind it is
  // inert). ⌘L and ⌘K search everything. Inside a note, ⌘K with selected
  // text edits a link (the editor handles it). ⌃F stays forward-a-character
  // in text.
  const key = e.key.toLowerCase();
  const command = e.metaKey && !e.shiftKey && !e.altKey;
  const searchFolder = key === "f" && command && !noteViewer.open;
  const searchEverything = (key === "l" && command) || (key === "k" && (e.metaKey || e.ctrlKey));
  if ((searchFolder || searchEverything) && !e.defaultPrevented) {
    e.preventDefault();
    startSearch(searchFolder);
  }
  // Escape clears the search; with nothing to clear, it goes up a level. In
  // Roadmap, it puts the find box away.
  if (e.key === "Escape" && !e.isComposing && document.activeElement === searchInput) {
    if (state.view === "map") {
      closeMapFind();
    } else if (searchInput.value) {
      searchInput.value = "";
      runSearch("");
      if (state.view !== "home") searchInput.blur();
    } else if (state.view !== "home") {
      searchInput.blur();
      goUp();
    }
  }
});

window.addEventListener("beforeunload", (event) => {
  const session = state.editorSession;
  if (!session || !(noteSessionIsDirty(session) || session.inFlight)) return;
  // Try to save on the way out (keepalive requests are limited to 64 KB),
  // and ask the browser to confirm leaving.
  if (!session.inFlight && noteSnapshot(session).bodyText.length < 60000) saveNoteSession(session, { keepalive: true });
  event.preventDefault();
  event.returnValue = "";
});

// When launchd starts the server on demand (server.py --install-launch-agent),
// it stops shortly after the last open window stops checking in.
const PRESENCE_ID = crypto.randomUUID();
const PRESENCE_INTERVAL_MS = 60_000;

function reportPresence(closed = false) {
  const url = `/api/presence?client=${PRESENCE_ID}${closed ? "&closed=1" : ""}`;
  if (closed) navigator.sendBeacon(url);
  else fetch(url, { method: "POST", keepalive: true }).catch(() => {});
}

reportPresence();
window.setInterval(() => reportPresence(), PRESENCE_INTERVAL_MS);
window.addEventListener("pagehide", () => reportPresence(true));
window.addEventListener("pageshow", (event) => {
  if (event.persisted) reportPresence();
});

window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  if (params.get("view") === "trash") history.replaceState(null, "", "/");
  if (params.get("view") === "roadmap") {
    const topic = params.get("topic") || "";
    if (!topic) state.roadmapTopicFromIndex = false;
    switchToRoadmap({ topic, syncUrl: false });
    return;
  }
  if (params.get("view") === "map") {
    switchToMap({ syncUrl: false });
    return;
  }
  const targetPath = params.get("note");
  const doc = state.documents.find((d) => d.path === targetPath);
  if (targetPath && doc) {
    if (doc.collection === FOLLOWING_TOPIC) selectDocument(doc);
    else revealDocument(doc);
    return;
  }
  if (params.has("folder")) {
    openHomeFolder(params.get("folder"), { syncUrl: false });
    return;
  }
  switchToHome({ syncUrl: false, focus: false });
});

// The back and forward buttons on a mouse go back and forward through notes and folders. A browser
// would do that on letting go of the button, and Zetesis's Mac app would not, so the page does it itself.
window.addEventListener("mouseup", (event) => {
  const step = { 3: -1, 4: 1 }[event.button];
  if (!step) return;
  event.preventDefault();
  history.go(step);
});

// Zetesis's Mac app runs these from its menu bar; each does what its key or button does here. In an
// open note, "find" is left to the app's find bar, as ⌘F there is left to a browser's.
const MENU_COMMANDS = {
  search: () => startSearch(false),
  find: () => (noteViewer.open ? "page" : startSearch(true)),
  explore: () => switchToRoadmap({ topic: "" }),
  roadmap: () => switchToMap(),
  following: () => openFollowingNote(),
  newNote: () => openNewNoteDialog(),
  save: () => (state.editorSession ? saveNoteSession(state.editorSession) : saveMapNote()),
  backup: () => $("#backup-button").click(),
  shortcuts: () => { helpOverlay.hidden = false; },
};

function menuCommand(name) {
  return MENU_COMMANDS[name]?.();
}

// Before quitting or reloading, Zetesis's Mac app has the open note saved now, and shows what would
// still be lost, if anything; a browser asks before leaving instead. A save that hangs counts as lost.
async function prepareToLeave() {
  // A box's note open in Roadmap saves first.
  if (mapNoteUnsaved()) {
    saveMapNote();
    await mapWrites;
  }
  const session = state.editorSession;
  if (!session) return "";
  const title = noteSnapshot(session)?.title || "the open note";
  const saved = (async () => {
    if (session.inFlight) await session.inFlight;
    if (noteSessionIsDirty(session)) await saveNoteSession(session);
    if (session.inFlight) await session.inFlight;
    if (session.controller?.hasPendingUploads()) return "A file is still uploading into the open note, and the upload will be lost.";
    return noteSessionIsDirty(session) ? `Your latest changes to “${title}” couldn't be saved.` : "";
  })();
  const late = new Promise((resolve) => {
    window.setTimeout(() => resolve(`Your latest changes to “${title}” are still saving.`), 5000);
  });
  return Promise.race([saved, late]);
}

initialize();
