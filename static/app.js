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
  roadmapFilter: "all",
  roadmapTopic: "",
  roadmapTopicFromIndex: false,
  projects: null,
  projectFilter: "all",
  following: null,
  followingFilter: "all",
  draggedNotePath: "",
  editorSession: null,
};

const $ = (selector) => document.querySelector(selector);
const folderTree = $("#folder-tree");
const noteList = $("#note-list");
const noteViewer = $("#note-viewer");
const readerContent = $("#reader-content");
const searchBar = $("#search-bar-container");
const workspaceGrid = $("#workspace-grid");
const roadmapView = $("#roadmap-view");
const projectsView = $("#projects-view");
const followingView = $("#following-view");
const pageHeading = $("#page-heading");
const homeHeading = $("#home-heading");
const homeSuggestions = $("#home-suggestions");
const appShell = $(".app-shell");
const projectsList = $("#projects-list");
const followingList = $("#following-list");
const roadmapTopics = $("#roadmap-topics");
const roadmapPills = $("#roadmap-pills");
const navRoadmap = $("#nav-roadmap");
const navProjects = $("#nav-projects");
const navFollowing = $("#nav-following");
const navSearch = $("#nav-search");
const TEXT_EXTENSIONS_FOR_UI = new Set([".md", ".org"]);
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
    folderTree.append(renderFolderNode(node, 0));
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
  row.addEventListener("dragover", (event) => {
    if (!state.draggedNotePath) return;
    event.preventDefault();
    row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("drop-target");
    const path = event.dataTransfer?.getData("text/plain") || state.draggedNotePath;
    if (path) moveNoteToFolder(path, node.path);
    state.draggedNotePath = "";
  });

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
    openHomeFolder(node.path);
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
  navRoadmap.classList.toggle("active", state.view === "roadmap");
  navProjects.classList.toggle("active", state.view === "projects");
  navFollowing.classList.toggle("active", state.view === "following");
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
  $("#search-input").placeholder = isHome ? "Search topics and notes" : "Search notes";
  $("#search-input").setAttribute("aria-label", isHome ? "Search topics and notes" : "Search notes");
  if (!isHome) homeSuggestions.replaceChildren();
}

function switchToHome({ syncUrl = true, focus = true } = {}) {
  if (!confirmDiscardEditor()) return false;
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
  projectsView.hidden = true;
  followingView.hidden = true;
  navRoadmap.classList.remove("active");
  navProjects.classList.remove("active");
  navFollowing.classList.remove("active");
  highlightActiveFolder();
  setHomePresentation(true);
  if (syncUrl) history.replaceState(null, "", "/");
  if (focus) requestAnimationFrame(() => $("#search-input").focus());
  return true;
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
  let title = "Notes";
  if (state.folder) {
    const parts = state.folder.split("/");
    title = parts.length === 1 && state.collections[parts[0]]
      ? state.collections[parts[0]]
      : formatFolderName(parts.at(-1));
  }

  $("#page-title").textContent = title;
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
          if (!confirmDiscardEditor()) return;
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
    cur.textContent = "NOTES";
    breadcrumb.append(sep, cur);
  }
}

const ROADMAP_LINK_ACTIONS = {
  video: "Watch video",
  podcast: "Listen to podcast",
  book: "Open resource",
};

function switchToNotes({ syncUrl = true } = {}) {
  if (!confirmDiscardEditor()) return false;
  clearReader({ resetUrl: true });
  const leavingRoadmap = state.view === "roadmap";
  const leavingProjects = state.view === "projects";
  const leavingFollowing = state.view === "following";
  state.view = "notes";
  state.roadmapTopicFromIndex = false;
  setHomePresentation(false);
  roadmapView.hidden = true;
  projectsView.hidden = true;
  followingView.hidden = true;
  searchBar.hidden = false;
  workspaceGrid.hidden = false;
  navRoadmap.classList.remove("active");
  navProjects.classList.remove("active");
  navFollowing.classList.remove("active");
  highlightActiveFolder();
  updateHeading();

  if ((leavingRoadmap || leavingProjects || leavingFollowing) && syncUrl) {
    const url = state.selected ? `/?note=${encodeURIComponent(state.selected.path)}` : "/";
    history.replaceState(null, "", url);
  }
  return true;
}

function editorHasUnsavedChanges() {
  const article = $(".note-inline-editor");
  const title = $(".reader-title-editor");
  const session = state.editorSession;
  if (!article || !title || !session || session.path !== state.selected?.path) return false;
  return article.innerHTML !== session.initialMarkup || title.value !== session.title;
}

function confirmDiscardEditor() {
  return !editorHasUnsavedChanges() || window.confirm("Discard your unsaved edits?");
}

function roadmapItemMatches(item) {
  const filter = state.roadmapFilter;
  if (!filter || filter === "all") return true;
  if (filter === "next") return String(item.status || "").toUpperCase() === "NEXT";
  return String(item.type || "").toLowerCase() === filter;
}

function updateRoadmapCounts() {
  const totals = { all: 0, next: 0, book: 0, podcast: 0, video: 0, idea: 0 };
  for (const topic of state.roadmap?.topics || []) {
    for (const item of topic.items || []) {
      totals.all += 1;
      const type = String(item.type || "").toLowerCase();
      if (type in totals) totals[type] += 1;
      if (String(item.status || "").toUpperCase() === "NEXT") totals.next += 1;
    }
  }

  $("#roadmap-count").textContent = String(totals.all);
  for (const [key, value] of Object.entries(totals)) {
    const badge = $(`#pill-${key}-count`);
    if (badge) badge.textContent = String(value);
  }
}

function updateRoadmapHeading() {
  const selectedTopic = state.roadmapTopic;

  if (selectedTopic) {
    $("#page-title").textContent = selectedTopic;
  } else {
    $("#page-title").textContent = "Up Next";
  }
  const breadcrumb = $("#breadcrumb");
  breadcrumb.replaceChildren();

  const rootLink = document.createElement("a");
  rootLink.className = "breadcrumb-item";
  rootLink.href = "#";
  rootLink.textContent = "ZETESIS";
  rootLink.addEventListener("click", (event) => {
    event.preventDefault();
    selectAllNotes();
  });

  const separator = document.createElement("span");
  separator.className = "breadcrumb-separator";
  separator.textContent = "/";

  if (selectedTopic) {
    const upNextLink = document.createElement("a");
    upNextLink.className = "breadcrumb-item";
    upNextLink.href = "#";
    upNextLink.textContent = "UP NEXT";
    upNextLink.addEventListener("click", (e) => {
      e.preventDefault();
      showAllRoadmapTopics();
    });
    const current = document.createElement("span");
    current.className = "breadcrumb-current";
    current.textContent = selectedTopic.toUpperCase();
    breadcrumb.append(rootLink, separator, upNextLink, separator.cloneNode(true), current);
  } else {
    const current = document.createElement("span");
    current.className = "breadcrumb-current";
    current.textContent = "UP NEXT";
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
}

function showAllRoadmapTopics() {
  state.roadmapTopic = "";
  state.roadmapTopicFromIndex = false;
  history.pushState(null, "", "/?view=roadmap");
  updateRoadmapHeading();
  renderRoadmap();
}

async function loadRoadmap({ force = false } = {}) {
  if (state.roadmap && !force) return state.roadmap;

  const response = await fetch("/api/roadmap", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load the roadmap.");
  const payload = await response.json();

  state.roadmap = {
    topics: Array.isArray(payload.topics) ? payload.topics : [],
    counts: payload.counts || {},
  };
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
  if (!confirmDiscardEditor()) return;
  clearReader();
  state.view = "roadmap";
  navSearch.classList.remove("active");
  navSearch.removeAttribute("aria-current");
  setHomePresentation(false);
  state.roadmapTopic = topic || "";
  searchBar.hidden = true;
  workspaceGrid.hidden = true;
  roadmapView.hidden = false;
  projectsView.hidden = true;
  followingView.hidden = true;
  navRoadmap.classList.add("active");
  navProjects.classList.remove("active");
  navFollowing.classList.remove("active");
  for (const row of folderTree.querySelectorAll(".tree-row.selected")) {
    row.classList.remove("selected");
  }
  if (syncUrl) {
    const params = new URLSearchParams({ view: "roadmap" });
    if (state.roadmapTopic) params.set("topic", state.roadmapTopic);
    history.replaceState(null, "", `/?${params.toString()}`);
  }
  updateRoadmapHeading();

  if (state.roadmap) {
    renderRoadmap();
    return;
  }

  roadmapTopics.replaceChildren(roadmapMessage("Loading…"));
  try {
    await loadRoadmap();
    renderRoadmap();
  } catch (error) {
    roadmapTopics.replaceChildren(roadmapErrorState(error.message));
    showToast(error.message);
  }
}


const PROJECT_STATUS_LABELS = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
};

const TASK_STATUS_LABELS = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

async function loadProjects({ force = false } = {}) {
  if (state.projects && !force) return state.projects;
  const response = await fetch("/api/projects", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load projects.");
  const payload = await response.json();
  state.projects = Array.isArray(payload.projects) ? payload.projects : [];
  $("#projects-count").textContent = String(state.projects.length);
  return state.projects;
}

function updateProjectsHeading() {
  $("#page-title").textContent = "Projects";
  const breadcrumb = $("#breadcrumb");
  breadcrumb.replaceChildren();
  const root = document.createElement("a");
  root.className = "breadcrumb-item";
  root.href = "#";
  root.textContent = "ZETESIS";
  root.addEventListener("click", (event) => {
    event.preventDefault();
    selectAllNotes();
  });
  const separator = document.createElement("span");
  separator.className = "breadcrumb-separator";
  separator.textContent = "/";
  const current = document.createElement("span");
  current.className = "breadcrumb-current";
  current.textContent = "PROJECTS";
  breadcrumb.append(root, separator, current);
}

async function loadFollowing({ force = false } = {}) {
  if (state.following && !force) return state.following;
  const response = await fetch("/api/following", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load Following.");
  const payload = await response.json();
  state.following = Array.isArray(payload.items) ? payload.items : [];
  return state.following;
}

function updateFollowingHeading() {
  $("#page-title").textContent = "Following";
  const breadcrumb = $("#breadcrumb");
  breadcrumb.replaceChildren();
  const root = document.createElement("a");
  root.className = "breadcrumb-item";
  root.href = "#";
  root.textContent = "ZETESIS";
  root.addEventListener("click", (event) => {
    event.preventDefault();
    selectAllNotes();
  });
  const separator = document.createElement("span");
  separator.className = "breadcrumb-separator";
  separator.textContent = "/";
  const current = document.createElement("span");
  current.className = "breadcrumb-current";
  current.textContent = "FOLLOWING";
  breadcrumb.append(root, separator, current);
}

function renderFollowingCard(item) {
  const card = document.createElement("article");
  card.className = "following-card";
  const heading = document.createElement("h2");
  heading.className = "following-title";
  const link = document.createElement("a");
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = item.title;
  link.title = item.title;
  heading.append(link);
  const url = document.createElement("p");
  url.className = "following-url";
  try { url.textContent = new URL(item.url).hostname; } catch { url.textContent = item.url; }
  card.append(heading, url);
  if (item.description) {
    const description = document.createElement("p");
    description.className = "following-description";
    description.textContent = item.description;
    card.append(description);
  }
  const actions = document.createElement("div");
  actions.className = "following-card-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openFollowingDialog(item));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "following-delete";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => deleteFollowingItem(item));
  actions.append(edit, remove);
  card.append(actions);
  return card;
}

function renderFollowing() {
  if (!state.following) return;
  updateFollowingHeading();
  for (const button of $("#following-filters").querySelectorAll(".following-filter")) {
    button.classList.toggle("active", button.dataset.kind === state.followingFilter);
  }
  followingList.replaceChildren();
  const items = state.following.filter((item) => state.followingFilter === "all" || item.kind === state.followingFilter);
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "following-empty";
    empty.textContent = "No links here yet.";
    followingList.append(empty);
    return;
  }
  for (const item of items) followingList.append(renderFollowingCard(item));
}

async function switchToFollowing({ syncUrl = true } = {}) {
  if (!confirmDiscardEditor()) return;
  clearReader();
  state.view = "following";
  navSearch.classList.remove("active");
  navSearch.removeAttribute("aria-current");
  setHomePresentation(false);
  state.folder = "";
  state.query = "";
  $("#search-input").value = "";
  $("#clear-search").hidden = true;
  searchBar.hidden = true;
  roadmapView.hidden = true;
  projectsView.hidden = true;
  followingView.hidden = false;
  workspaceGrid.hidden = true;
  navRoadmap.classList.remove("active");
  navProjects.classList.remove("active");
  navFollowing.classList.add("active");
  for (const row of folderTree.querySelectorAll(".tree-row.selected")) row.classList.remove("selected");
  if (syncUrl) history.replaceState(null, "", "/?view=following");
  updateFollowingHeading();
  followingList.replaceChildren(roadmapMessage("Loading…"));
  try {
    await loadFollowing();
    renderFollowing();
  } catch (error) {
    followingList.replaceChildren(roadmapMessage(error.message));
  }
}

function openFollowingDialog(item = null) {
  $("#following-dialog-title").textContent = item ? "Edit link" : "Add link";
  $("#following-id").value = item?.id || "";
  $("#following-title").value = item?.title || "";
  $("#following-url").value = item?.url || "";
  $("#following-kind").value = item?.kind || "site";
  $("#following-description").value = item?.description || "";
  $("#save-following-item").textContent = item ? "Save link" : "Add link";
  $("#delete-following-item").hidden = !item;
  $("#following-dialog").showModal();
  $("#following-title").focus();
  if (!item) $("#following-title").select();
}

async function saveFollowingItem(event) {
  event.preventDefault();
  const id = $("#following-id").value;
  const fields = {
    title: $("#following-title").value.trim(),
    url: $("#following-url").value.trim(),
    kind: $("#following-kind").value,
    description: $("#following-description").value.trim(),
  };
  try {
    const response = await fetch(id ? "/api/following?id=" + encodeURIComponent(id) : "/api/following", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not save link.");
    if ($("#following-dialog").open) $("#following-dialog").close();
    await loadFollowing({ force: true });
    renderFollowing();
    showToast(id ? "Link updated" : "Link added");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteFollowingItem(item) {
  if (!window.confirm("Delete “" + item.title + "” from Following?")) return;
  try {
    const response = await fetch("/api/following?id=" + encodeURIComponent(item.id), { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not delete link.");
    if ($("#following-dialog").open) $("#following-dialog").close();
    await loadFollowing({ force: true });
    renderFollowing();
    showToast("Link deleted");
  } catch (error) {
    showToast(error.message);
  }
}

function createStatusSelect(className, options, current, ariaLabel) {
  const select = document.createElement("select");
  select.className = className;
  select.setAttribute("aria-label", ariaLabel);
  for (const [value, label] of Object.entries(options)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  select.value = current;
  return select;
}

function renderProjectTask(task, project) {
  const row = document.createElement("li");
  row.className = "project-task" + (task.status === "done" ? " done" : "");

  const title = document.createElement("input");
  title.type = "text";
  title.className = "project-task-title";
  title.value = task.title;
  title.maxLength = 500;
  title.setAttribute("aria-label", "Task title");
  title.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      title.blur();
    } else if (event.key === "Escape") {
      title.value = task.title;
      title.blur();
    }
  });
  title.addEventListener("blur", () => {
    const nextTitle = title.value.trim();
    if (nextTitle && nextTitle !== task.title) updateProjectTask(task.id, { title: nextTitle });
    else title.value = task.title;
  });

  const status = createStatusSelect("task-status-select", TASK_STATUS_LABELS, task.status, "Task status");
  status.addEventListener("change", () => updateProjectTask(task.id, { status: status.value }));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "task-delete-button";
  remove.title = "Delete task";
  remove.setAttribute("aria-label", "Delete task");
  remove.textContent = "×";
  remove.addEventListener("click", () => deleteProjectTask(task, project));

  row.append(title, status, remove);
  return row;
}

function renderProjectCard(project) {
  const card = document.createElement("article");
  card.className = "project-card" + (project.status === "archived" ? " archived" : "");

  const header = document.createElement("div");
  header.className = "project-card-header";
  const heading = document.createElement("div");
  heading.className = "project-copy";
  const title = document.createElement("h2");
  title.className = "project-title";
  title.textContent = project.title;
  heading.append(title);

  if (project.description) {
    const description = document.createElement("p");
    description.className = "project-description";
    description.innerHTML = project.description
      .split(/\r?\n/)
      .map((line) => renderInline(line, ""))
      .join("<br>");
    heading.append(description);
  }

  const actions = document.createElement("div");
  actions.className = "project-actions";
  const status = createStatusSelect("project-status-select", PROJECT_STATUS_LABELS, project.status, "Project status");
  status.addEventListener("change", () => saveProjectFields(project.id, {
    title: project.title,
    description: project.description,
    status: status.value,
  }));
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "project-edit-button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openProjectDialog(project));
  actions.append(status, edit);
  header.append(heading, actions);

  const taskCount = project.task_count || 0;
  const completed = project.completed_count || 0;
  const progress = taskCount ? Math.round(completed / taskCount * 100) : 0;
  const progressRow = document.createElement("div");
  progressRow.className = "project-progress";
  if (taskCount) {
    const progressLabel = document.createElement("span");
    progressLabel.textContent = completed + " of " + taskCount + " tasks complete";
    const track = document.createElement("div");
    track.className = "project-progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(progress));
    track.setAttribute("aria-label", "Project task completion");
    const value = document.createElement("div");
    value.className = "project-progress-value";
    value.style.width = progress + "%";
    track.append(value);
    const percentage = document.createElement("span");
    percentage.textContent = progress + "%";
    progressRow.append(progressLabel, track, percentage);
  }

  const tasks = document.createElement("ul");
  tasks.className = "project-tasks";
  for (const task of project.tasks || []) tasks.append(renderProjectTask(task, project));

  const addTask = document.createElement("form");
  addTask.className = "project-add-task";
  const taskInput = document.createElement("input");
  taskInput.type = "text";
  taskInput.maxLength = 500;
  taskInput.setAttribute("aria-label", "New task");
  const addButton = document.createElement("button");
  addButton.type = "submit";
  addButton.textContent = "Add task";
  addTask.append(taskInput, addButton);
  addTask.addEventListener("submit", (event) => {
    event.preventDefault();
    createProjectTask(project.id, taskInput.value);
  });

  card.append(header);
  if (taskCount) card.append(progressRow);
  card.append(tasks, addTask);
  return card;
}

function renderProjects() {
  if (!state.projects) return;
  const projects = state.projects.filter((project) =>
    state.projectFilter === "all" || project.status === state.projectFilter
  );
  updateProjectsHeading();
  $("#projects-count").textContent = String(state.projects.length);
  for (const button of $("#projects-filters").querySelectorAll(".project-filter")) {
    button.classList.toggle("active", button.dataset.status === state.projectFilter);
  }

  projectsList.replaceChildren();
  if (!projects.length) return;
  for (const project of projects) projectsList.append(renderProjectCard(project));
}

async function switchToProjects({ syncUrl = true } = {}) {
  if (!confirmDiscardEditor()) return;
  clearReader();
  state.view = "projects";
  navSearch.classList.remove("active");
  navSearch.removeAttribute("aria-current");
  setHomePresentation(false);
  state.folder = "";
  state.query = "";
  $("#search-input").value = "";
  $("#clear-search").hidden = true;
  searchBar.hidden = true;
  roadmapView.hidden = true;
  projectsView.hidden = false;
  followingView.hidden = true;
  workspaceGrid.hidden = true;
  navRoadmap.classList.remove("active");
  navProjects.classList.add("active");
  navFollowing.classList.remove("active");
  for (const row of folderTree.querySelectorAll(".tree-row.selected")) row.classList.remove("selected");
  if (syncUrl) history.replaceState(null, "", "/?view=projects");
  projectsList.replaceChildren(roadmapMessage("Loading projects…"));
  updateProjectsHeading();
  try {
    await loadProjects();
    renderProjects();
  } catch (error) {
    projectsList.replaceChildren(roadmapMessage(error.message));
  }
}

async function saveProjectFields(projectId, fields) {
  try {
    const response = await fetch("/api/projects?id=" + encodeURIComponent(projectId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not update project.");
    await loadProjects({ force: true });
    renderProjects();
    showToast("Project updated");
  } catch (error) {
    showToast(error.message);
    await loadProjects({ force: true }).catch(() => {});
    renderProjects();
  }
}

async function updateProjectTask(taskId, fields) {
  try {
    const response = await fetch("/api/project-tasks?id=" + encodeURIComponent(taskId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not update task.");
    await loadProjects({ force: true });
    renderProjects();
  } catch (error) {
    showToast(error.message);
    await loadProjects({ force: true }).catch(() => {});
    renderProjects();
  }
}

async function createProjectTask(projectId, title) {
  const cleanTitle = title.trim();
  if (!cleanTitle) return;
  try {
    const response = await fetch("/api/project-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, title: cleanTitle }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not add task.");
    await loadProjects({ force: true });
    renderProjects();
    showToast("Task added");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteProjectTask(task, project) {
  if (!window.confirm("Delete this task from " + project.title + "?")) return;
  try {
    const response = await fetch("/api/project-tasks?id=" + encodeURIComponent(task.id), { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not delete task.");
    await loadProjects({ force: true });
    renderProjects();
  } catch (error) {
    showToast(error.message);
  }
}

function openProjectDialog(project = null) {
  $("#project-dialog-title").textContent = project ? "Edit project" : "New project";
  $("#project-id").value = project?.id || "";
  $("#project-title").value = project?.title || "";
  $("#project-description").value = project?.description || "";
  $("#project-status").value = project?.status || "planned";
  $("#save-project").textContent = project ? "Save project" : "Create project";
  $("#delete-project").hidden = !project;
  $("#project-dialog").showModal();
  $("#project-title").focus();
  if (!project) $("#project-title").select();
}

async function handleProjectFormSubmit(event) {
  event.preventDefault();
  const projectId = $("#project-id").value;
  const fields = {
    title: $("#project-title").value.trim(),
    description: $("#project-description").value,
    status: $("#project-status").value,
  };
  try {
    const response = await fetch(projectId
      ? "/api/projects?id=" + encodeURIComponent(projectId)
      : "/api/projects", {
      method: projectId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not save project.");
    $("#project-dialog").close();
    if (!projectId) state.projectFilter = "all";
    await loadProjects({ force: true });
    renderProjects();
    showToast(projectId ? "Project saved" : "Project created");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteProjectFromDialog() {
  const projectId = $("#project-id").value;
  const title = $("#project-title").value || "this project";
  if (!projectId || !window.confirm("Delete " + title + " and all its tasks?")) return;
  try {
    const response = await fetch("/api/projects?id=" + encodeURIComponent(projectId), { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not delete project.");
    $("#project-dialog").close();
    state.projectFilter = "all";
    await loadProjects({ force: true });
    renderProjects();
    showToast("Project deleted");
  } catch (error) {
    showToast(error.message);
  }
}

function normalizeRoadmapLink(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^\[\[([^\]]+)\](?:\[([^\]]*)\])?\]$/);
  const target = (match ? match[1] : raw).trim();
  const customLabel = (match?.[2] || "").trim();

  if (/^https?:\/\//i.test(target)) {
    return { kind: "external", href: target, label: customLabel || "Open link" };
  }
  if (/^mailto:/i.test(target)) {
    return { kind: "external", href: target, label: customLabel || "Send email" };
  }

  let candidate = target.replace(/^file:/i, "").replace(/^\.\//, "").replace(/^\/+/, "");
  try { candidate = decodeURIComponent(candidate); } catch { /* keep as is */ }
  if (!candidate) return null;

  const doc = state.documents.find((entry) => entry.path === candidate);
  if (doc) {
    return { kind: "note", doc, href: `/?note=${encodeURIComponent(doc.path)}`, label: customLabel || "Open note in Zetesis" };
  }
  if (/\.(pdf|png|jpe?g|gif|svg|webp)$/i.test(candidate)) {
    return { kind: "file", href: `/api/file?path=${encodeURIComponent(candidate)}`, label: customLabel || "Open file" };
  }
  return null;
}

function roadmapLinks(item) {
  const details = item.details || {};
  const links = [];
  const seen = new Set();

  for (const key of ["link", "url", "resource"]) {
    const link = normalizeRoadmapLink(details[key]);
    if (link && !seen.has(link.href)) {
      if (link.label === "Open link") {
        link.label = ROADMAP_LINK_ACTIONS[String(item.type || "").toLowerCase()] || link.label;
      }
      seen.add(link.href);
      links.push(link);
    }
  }

  const source = String(details.source || "").trim();
  if (/^(https?:\/\/|mailto:|\[\[|file:)/i.test(source)) {
    const link = normalizeRoadmapLink(source);
    if (link && !seen.has(link.href)) {
      if (link.label === "Open link") {
        link.label = ROADMAP_LINK_ACTIONS[String(item.type || "").toLowerCase()] || link.label;
      }
      seen.add(link.href);
      links.push(link);
    }
  }

  return links;
}

function roadmapLinkElement(link) {
  const anchor = document.createElement("a");
  anchor.className = "resource-link";
  anchor.textContent = `${link.label} ↗`;

  if (link.kind === "note") {
    anchor.href = link.href;
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      revealDocument(link.doc);
    });
  } else {
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  return anchor;
}

// ── Up Next: inline editing & drag-and-drop helpers ──────────────────────────

let draggedItemInfo = null;

function serializeRoadmapToOrg(topics) {
  const lines = ["#+title: Up Next", "#+author: zetesis", ""];
  for (const topic of topics) {
    lines.push(`* ${topic.name}`);
    let lastSubtopic = "";
    for (const item of topic.items || []) {
      if (item.subtopic && item.subtopic !== lastSubtopic) {
        lines.push(`** ${item.subtopic}`);
        lastSubtopic = item.subtopic;
      } else if (!item.subtopic) {
        // A level-two resource belongs directly to the topic and ends the
        // previous subtopic section in the Org outline.
        lastSubtopic = "";
      }
      const tag = item.type && item.type !== "idea" ? `:${item.type}:` : (item.type === "idea" ? ":idea:" : "");
      const statusPart = item.status ? `${item.status} ` : "";
      const level = item.subtopic ? "***" : "**";
      lines.push(`${level} ${statusPart}${item.title}${tag ? " " + tag : ""}`);
      if (item.details) {
        for (const [k, v] of Object.entries(item.details)) {
          if (v) {
            const label = k[0].toUpperCase() + k.slice(1);
            lines.push(`   - ${label}: ${v}`);
          }
        }
      }
      for (const note of item.notes || []) {
        if (note) lines.push(`   - ${note}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function saveRoadmapTopics(topics) {
  const content = serializeRoadmapToOrg(topics);
  const response = await fetch("/api/roadmap", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not save.");
  state.roadmap = payload;
  updateRoadmapCounts();
  return payload;
}

function openUpNextItemDialog(existingItem, topicName, itemIndex, topicIndex, defaultSubtopic = "", defaultType = "idea") {
  const form = $("#upnext-item-form");
  const dialog = $("#upnext-item-dialog");
  const defaultTopic = topicName || state.roadmapTopic || "";
  $("#upnext-dialog-title").textContent = existingItem ? "Edit item" : "Add item";
  $("#upnext-item-submit").textContent = existingItem ? "Save changes" : "Add item";
  $("#upnext-item-title").value = existingItem?.title || "";
  $("#upnext-item-topic").value = existingItem ? (topicName || "") : defaultTopic;
  $("#upnext-item-subtopic").value = existingItem?.subtopic || defaultSubtopic;
  $("#upnext-item-type").value = existingItem?.type || defaultType;
  $("#upnext-item-status").value = existingItem?.status || "TODO";
  $("#upnext-item-author").value = existingItem?.details?.author || existingItem?.details?.host || "";
  $("#upnext-item-focus").value = existingItem?.details?.focus || "";
  populateUpNextDatalists($("#upnext-item-topic").value);
  form.dataset.topicIndex = topicIndex ?? "";
  form.dataset.itemIndex = itemIndex ?? "";
  form.dataset.editMode = existingItem ? "1" : "0";
  dialog.showModal();
  $("#upnext-item-title").focus();
}

function populateUpNextDatalists(topicName) {
  const topics = state.roadmap?.topics || [];
  const topicList = $("#upnext-topics-list");
  const subtopicList = $("#upnext-subtopics-list");
  topicList.replaceChildren();
  subtopicList.replaceChildren();

  const topicNames = [...new Set(topics.map((topic) => String(topic.name || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  for (const name of topicNames) {
    const option = document.createElement("option");
    option.value = name;
    topicList.append(option);
  }

  const selectedTopic = topics.find((topic) =>
    String(topic.name || "").trim().toLocaleLowerCase() === String(topicName || "").trim().toLocaleLowerCase()
  );
  const subtopics = [...new Set((selectedTopic?.items || [])
    .map((item) => String(item.subtopic || "").trim())
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const name of subtopics) {
    const option = document.createElement("option");
    option.value = name;
    subtopicList.append(option);
  }
}

function upNextFindOrCreateTopic(topics, topicName) {
  const trimmed = (topicName || "General").trim();
  let topicIdx = topics.findIndex((t) => t.name.toLowerCase() === trimmed.toLowerCase());
  if (topicIdx === -1) {
    topics.push({ name: trimmed, items: [] });
    topicIdx = topics.length - 1;
  }
  return topicIdx;
}

async function handleUpNextItemSubmit(event) {
  event.preventDefault();
  const form = $("#upnext-item-form");
  const title = $("#upnext-item-title").value.trim();
  const topicName = $("#upnext-item-topic").value.trim() || "General";
  const type = $("#upnext-item-type").value;
  const status = $("#upnext-item-status").value;
  const subtopic = $("#upnext-item-subtopic").value.trim();
  const author = $("#upnext-item-author").value.trim();
  const focus = $("#upnext-item-focus").value.trim();
  if (!title) return;

  const topics = JSON.parse(JSON.stringify(state.roadmap?.topics || []));
  const editMode = form.dataset.editMode === "1";
  const existingTopicIdx = parseInt(form.dataset.topicIndex ?? "-1", 10);
  const existingItemIdx = parseInt(form.dataset.itemIndex ?? "-1", 10);

  const existingItem = (existingTopicIdx >= 0 && existingItemIdx >= 0)
    ? topics[existingTopicIdx]?.items?.[existingItemIdx]
    : null;

  const newItem = {
    title,
    type,
    status,
    subtopic,
    details: { ...(existingItem?.details || {}), ...(author ? { author } : {}), ...(focus ? { focus } : {}) },
    notes: existingItem?.notes || [],
  };
  if (!author && newItem.details.author) delete newItem.details.author;
  if (!focus && newItem.details.focus) delete newItem.details.focus;

  if (editMode && existingTopicIdx >= 0 && existingItemIdx >= 0) {
    const oldTopic = topics[existingTopicIdx];
    if (oldTopic) oldTopic.items.splice(existingItemIdx, 1);
  }

  const targetIdx = upNextFindOrCreateTopic(topics, topicName);
  if (editMode && existingTopicIdx >= 0 && existingItemIdx >= 0 && existingTopicIdx === targetIdx) {
    topics[targetIdx].items.splice(existingItemIdx, 0, newItem);
  } else {
    topics[targetIdx].items.push(newItem);
  }

  const submitBtn = $("#upnext-item-submit");
  submitBtn.disabled = true;
  try {
    await saveRoadmapTopics(topics);
    $("#upnext-item-dialog").close();
    renderRoadmap();
    showToast(editMode ? "Item updated" : "Item added");
  } catch (err) {
    showToast(err.message);
  } finally {
    submitBtn.disabled = false;
  }
}

async function deleteUpNextItem(topicIdx, itemIdx) {
  if (!window.confirm("Remove this item from Up Next?")) return;
  const topics = JSON.parse(JSON.stringify(state.roadmap?.topics || []));
  if (topics[topicIdx]) {
    const topicName = topics[topicIdx].name;
    topics[topicIdx].items.splice(itemIdx, 1);
    if (topics[topicIdx].items.length === 0) {
      if (state.roadmapTopic === topicName) {
        state.roadmapTopic = "";
      }
      topics.splice(topicIdx, 1);
    }
  }
  try {
    await saveRoadmapTopics(topics);
    renderRoadmap();
    showToast("Item removed");
  } catch (err) {
    showToast(err.message);
  }
}

// ── Drag & Drop reordering (Smooth & Optimistic) ──────────────────────────────

let draggedElement = null;

function updateListItemIndices() {
  document.querySelectorAll(".topic-item-list, .enlarged-item-list").forEach((listEl) => {
    const rows = listEl.querySelectorAll(".topic-item-row, .enlarged-item-row");
    rows.forEach((row, idx) => {
      row.dataset.itemIdx = String(idx);
    });
  });
}

async function moveRoadmapItem(fromTopicIdx, fromRealIdx, toTopicIdx, targetRealIdx, isAfter, targetSubtopic = undefined, targetSection = undefined) {
  const topics = JSON.parse(JSON.stringify(state.roadmap?.topics || []));
  const fromTopic = topics[fromTopicIdx];
  const toTopic = topics[toTopicIdx];
  if (!fromTopic || !toTopic) return;

  const sourceItem = fromTopic.items[fromRealIdx];
  if (!sourceItem) return;
  const oldSubtopic = String(sourceItem.subtopic || "").trim();
  const oldType = String(sourceItem.type || "idea").toLowerCase();
  const nextSubtopic = targetSubtopic === undefined
    ? (fromTopicIdx === toTopicIdx ? oldSubtopic : "")
    : String(targetSubtopic || "").trim();
  const nextType = targetSection === "books" ? "book"
    : targetSection === "items" && oldType === "book" ? "idea" : oldType;

  let insertIdx = targetRealIdx + (isAfter ? 1 : 0);

  if (fromTopicIdx === toTopicIdx) {
    if (fromRealIdx < insertIdx) {
      insertIdx -= 1;
    }
    if (insertIdx === fromRealIdx && nextSubtopic === oldSubtopic && nextType === oldType) {
      return;
    }
  }

  const [movedItem] = fromTopic.items.splice(fromRealIdx, 1);
  if (!movedItem) return;
  movedItem.subtopic = nextSubtopic;
  movedItem.type = nextType;

  insertIdx = Math.max(0, Math.min(insertIdx, toTopic.items.length));
  toTopic.items.splice(insertIdx, 0, movedItem);

  // Update in-memory state immediately for instant responsiveness
  state.roadmap = { ...state.roadmap, topics };

  try {
    await saveRoadmapTopics(topics);
    if (fromTopicIdx !== toTopicIdx || state.roadmapFilter !== "all" || state.roadmapTopic || nextSubtopic !== oldSubtopic || nextType !== oldType) {
      renderRoadmap();
    } else {
      updateListItemIndices();
      updateRoadmapCounts();
    }
  } catch (err) {
    showToast(err.message);
    renderRoadmap();
  }
}

async function appendRoadmapItem(fromTopicIdx, fromRealIdx, toTopicIdx, targetSubtopic = undefined, targetSection = undefined) {
  const topics = JSON.parse(JSON.stringify(state.roadmap?.topics || []));
  const fromTopic = topics[fromTopicIdx];
  const toTopic = topics[toTopicIdx];
  if (!fromTopic || !toTopic) return;
  const sourceItem = fromTopic.items[fromRealIdx];
  if (!sourceItem) return;
  const oldSubtopic = String(sourceItem.subtopic || "").trim();
  const oldType = String(sourceItem.type || "idea").toLowerCase();
  const nextSubtopic = targetSubtopic === undefined
    ? (fromTopicIdx === toTopicIdx ? oldSubtopic : "")
    : String(targetSubtopic || "").trim();
  const nextType = targetSection === "books" ? "book"
    : targetSection === "items" && oldType === "book" ? "idea" : oldType;
  if (fromTopicIdx === toTopicIdx && fromRealIdx === fromTopic.items.length - 1 && nextSubtopic === oldSubtopic && nextType === oldType) return;

  const [movedItem] = fromTopic.items.splice(fromRealIdx, 1);
  if (!movedItem) return;
  movedItem.subtopic = nextSubtopic;
  movedItem.type = nextType;

  toTopic.items.push(movedItem);
  state.roadmap = { ...state.roadmap, topics };

  try {
    await saveRoadmapTopics(topics);
    if (fromTopicIdx !== toTopicIdx || state.roadmapFilter !== "all" || state.roadmapTopic || nextSubtopic !== oldSubtopic || nextType !== oldType) {
      renderRoadmap();
    } else {
      updateListItemIndices();
      updateRoadmapCounts();
    }
  } catch (err) {
    showToast(err.message);
    renderRoadmap();
  }
}

function attachItemDragEvents(row, topicIdx, realItemIdx, item) {
  row.draggable = true;

  row.addEventListener("dragstart", (e) => {
    if (e.target.closest(".topic-item-action, button, a, input, select")) {
      e.preventDefault();
      return;
    }
    draggedElement = row;
    draggedItemInfo = { topicIdx, realItemIdx: parseInt(row.dataset.itemIdx ?? realItemIdx, 10), item };
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `${row.dataset.topicIdx}:${row.dataset.itemIdx}`);
  });

  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    document.querySelectorAll(".drag-over-top, .drag-over-bottom, .drag-over").forEach((el) => {
      el.classList.remove("drag-over-top", "drag-over-bottom", "drag-over");
    });
    draggedItemInfo = null;
    draggedElement = null;
  });

  row.addEventListener("dragover", (e) => {
    if (!draggedItemInfo) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";

    const rect = row.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const isBottom = relY > rect.height / 2;

    row.classList.toggle("drag-over-top", !isBottom);
    row.classList.toggle("drag-over-bottom", isBottom);
  });

  row.addEventListener("dragleave", (e) => {
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove("drag-over-top", "drag-over-bottom");
    }
  });

  row.addEventListener("drop", async (e) => {
    if (!draggedItemInfo || !draggedElement) return;
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drag-over-top", "drag-over-bottom");

    const fromTopicIdx = parseInt(draggedElement.dataset.topicIdx, 10);
    const fromRealIdx = parseInt(draggedElement.dataset.itemIdx, 10);
    const toTopicIdx = parseInt(row.dataset.topicIdx, 10);
    const targetRealIdx = parseInt(row.dataset.itemIdx, 10);
    const targetList = row.closest(".enlarged-item-list");
    const targetGroup = row.closest(".subtopic-group");
    const targetResourceSection = row.closest(".topic-resource-section");
    const targetSubtopic = targetGroup
      ? targetGroup.dataset.subtopic
      : targetList?.hasAttribute("data-subtopic") ? targetList.dataset.subtopic : undefined;
    const targetSection = targetResourceSection?.dataset.itemSection;

    const rect = row.getBoundingClientRect();
    const isBottom = (e.clientY - rect.top) > rect.height / 2;

    // Smooth optimistic DOM move right on drop (no aggressive snap)
    const targetParent = row.parentElement;
    if (targetParent && draggedElement && draggedElement !== row) {
      const nextSibling = isBottom ? row.nextSibling : row;
      if (draggedElement.nextSibling !== nextSibling) {
        targetParent.insertBefore(draggedElement, nextSibling);
        draggedElement.classList.add("just-dropped");
        setTimeout(() => draggedElement?.classList.remove("just-dropped"), 400);
      }
    }

    await moveRoadmapItem(fromTopicIdx, fromRealIdx, toTopicIdx, targetRealIdx, isBottom, targetSubtopic, targetSection);
  });
}

function attachContainerDropEvents(listEl, topicIdx) {
  listEl.addEventListener("dragover", (e) => {
    if (!draggedItemInfo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    listEl.classList.add("drag-over");
  });

  listEl.addEventListener("dragleave", (e) => {
    if (!listEl.contains(e.relatedTarget)) {
      listEl.classList.remove("drag-over");
    }
  });

  listEl.addEventListener("drop", async (e) => {
    listEl.classList.remove("drag-over");
    if (!draggedItemInfo || !draggedElement) return;
    if (e.target.closest(".topic-item-row, .enlarged-item-row")) return;
    e.preventDefault();

    const fromTopicIdx = parseInt(draggedElement.dataset.topicIdx, 10);
    const fromRealIdx = parseInt(draggedElement.dataset.itemIdx, 10);
    const toTopicIdx = topicIdx;

    if (draggedElement && (draggedElement.parentElement !== listEl || draggedElement !== listEl.lastElementChild)) {
      listEl.appendChild(draggedElement);
      draggedElement.classList.add("just-dropped");
      setTimeout(() => draggedElement?.classList.remove("just-dropped"), 400);
    }

    const targetSubtopic = listEl.hasAttribute("data-subtopic") ? listEl.dataset.subtopic : undefined;
    const targetSection = listEl.closest(".topic-resource-section")?.dataset.itemSection;
    await appendRoadmapItem(fromTopicIdx, fromRealIdx, toTopicIdx, targetSubtopic, targetSection);
  });
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderEnlargedItemRow(item, realItemIdx, topicIdx, topic) {
  const li = document.createElement("li");
  li.className = "enlarged-item-row";
  li.dataset.itemIdx = String(realItemIdx);
  li.dataset.topicIdx = String(topicIdx);

  const contentCol = document.createElement("div");
  contentCol.className = "enlarged-item-content";

  const primaryRow = document.createElement("div");
  primaryRow.className = "enlarged-item-primary-row";

  const title = document.createElement("h3");
  title.className = "enlarged-item-title";
  title.innerHTML = renderInline(item.title || "Untitled", "roadmap.org");
  primaryRow.append(title);

  const details = item.details || {};
  let creator = details.author || details.host || details.creator || "";
  if (!creator) {
    const source = String(details.source || "").trim();
    if (source && !/^(https?:\/\/|mailto:|\[\[|file:)/i.test(source)) creator = source;
  }
  if (creator) {
    const creatorSpan = document.createElement("span");
    creatorSpan.className = "enlarged-item-author";
    creatorSpan.textContent = creator;
    primaryRow.append(creatorSpan);
  }

  contentCol.append(primaryRow);

  const focus = details.focus || details.why || details.topic || details.description || "";
  if (focus) {
    const focusP = document.createElement("p");
    focusP.className = "enlarged-item-focus";
    focusP.textContent = focus;
    contentCol.append(focusP);
  }

  const notes = item.notes || [];
  if (notes.length) {
    const notesList = document.createElement("ul");
    notesList.className = "enlarged-item-notes";
    for (const note of notes) {
      const noteLi = document.createElement("li");
      noteLi.textContent = note;
      notesList.append(noteLi);
    }
    contentCol.append(notesList);
  }

  const links = roadmapLinks(item);
  if (links.length) {
    const linkRow = document.createElement("div");
    linkRow.className = "resource-links";
    for (const link of links) linkRow.append(roadmapLinkElement(link));
    contentCol.append(linkRow);
  }

  const actions = document.createElement("div");
  actions.className = "enlarged-item-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "topic-item-action";
  editBtn.title = "Edit item";
  editBtn.textContent = "✎";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openUpNextItemDialog(item, topic.name, parseInt(li.dataset.itemIdx, 10), topicIdx);
  });

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "topic-item-action topic-item-delete";
  delBtn.title = "Remove item";
  delBtn.textContent = "×";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteUpNextItem(topicIdx, parseInt(li.dataset.itemIdx, 10));
  });

  actions.append(editBtn, delBtn);

  li.append(contentCol, actions);
  attachItemDragEvents(li, topicIdx, realItemIdx, item);
  return li;
}

function renderEnlargedItemList(items, topicIdx, topic, subtopic, itemSection = "") {
  const list = document.createElement("ul");
  list.className = "enlarged-item-list";
  list.dataset.subtopic = subtopic;
  list.dataset.itemSection = itemSection;
  for (const item of items) {
    const realItemIdx = (topic.items || []).indexOf(item);
    list.append(renderEnlargedItemRow(item, realItemIdx, topicIdx, topic));
  }
  attachContainerDropEvents(list, topicIdx);
  return list;
}

function renderEnlargedSubtopicGroup(subtopic, items, topic, topicIdx, itemSection) {
  const group = document.createElement("div");
  group.className = "subtopic-group";
  group.dataset.subtopic = subtopic;

  if (subtopic) {
    const title = document.createElement("h4");
    title.className = "subtopic-group-title";
    title.textContent = subtopic;
    group.append(title);
  }
  group.append(renderEnlargedItemList(items, topicIdx, topic, subtopic, itemSection));
  return group;
}

function renderTopicResourceSection(sectionName, items, topic, topicIdx, defaultType) {
  const section = document.createElement("section");
  section.className = "topic-resource-section";
  section.dataset.itemSection = sectionName.toLowerCase();

  const header = document.createElement("header");
  header.className = "topic-resource-section-header";
  const title = document.createElement("h3");
  title.textContent = sectionName;
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "topic-resource-add";
  addButton.textContent = "+";
  addButton.setAttribute("aria-label", `Add ${sectionName.toLowerCase() === "books" ? "book" : "item"}`);
  addButton.addEventListener("click", () => openUpNextItemDialog(null, topic.name, -1, topicIdx, "", defaultType));
  header.append(title, addButton);

  const body = document.createElement("div");
  body.className = "topic-resource-section-body";
  const hasSubtopics = items.some((item) => String(item.subtopic || "").trim());
  if (!hasSubtopics) {
    body.append(renderEnlargedItemList(items, topicIdx, topic, "", sectionName.toLowerCase()));
  } else {
    const groups = new Map();
    for (const item of items) {
      const subtopic = String(item.subtopic || "").trim();
      if (!groups.has(subtopic)) groups.set(subtopic, []);
      groups.get(subtopic).push(item);
    }
    for (const [subtopic, groupItems] of groups) {
      body.append(renderEnlargedSubtopicGroup(subtopic, groupItems, topic, topicIdx, sectionName.toLowerCase()));
    }
  }

  section.append(header, body);
  return section;
}

function renderRoadmapTopicEnlarged(topic, items, topicIdx) {
  const container = document.createElement("div");
  container.className = "enlarged-topic-view";

  const topbar = document.createElement("div");
  topbar.className = "enlarged-topic-topbar";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "topic-back";
  backBtn.textContent = "← All topics";
  backBtn.addEventListener("click", showAllRoadmapTopics);

  topbar.append(backBtn);

  const card = document.createElement("div");
  card.className = "enlarged-topic-card";

  const header = document.createElement("div");
  header.className = "enlarged-topic-header";

  const title = document.createElement("h2");
  title.className = "enlarged-topic-title";
  title.textContent = topic.name;
  header.append(title);
  card.append(header);

  const books = items.filter((item) => String(item.type || "").toLowerCase() === "book");
  const otherItems = items.filter((item) => String(item.type || "").toLowerCase() !== "book");
  const sections = document.createElement("div");
  sections.className = "topic-resource-sections";
  sections.append(
    renderTopicResourceSection("Items", otherItems, topic, topicIdx, "idea"),
    renderTopicResourceSection("Books", books, topic, topicIdx, "book"),
  );
  card.append(sections);
  container.append(topbar, card);
  return container;
}

function renderRoadmapTopicCard(topic) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "topic-card";
  card.addEventListener("click", () => openRoadmapTopic(topic.name));

  const titleEl = document.createElement("span");
  titleEl.className = "topic-card-title";
  titleEl.textContent = topic.name || "General";
  card.append(titleEl);
  return card;
}

function renderRoadmap() {
  if (!state.roadmap) return;

  updateRoadmapCounts();
  updateRoadmapHeading();
  roadmapTopics.replaceChildren();

  const topics = state.roadmap.topics || [];
  // If a topic is selected, render enlarged view for that topic
  if (state.roadmapTopic) {
    const topicIdx = topics.findIndex((t) => t.name === state.roadmapTopic);
    if (topicIdx >= 0) {
      const topic = topics[topicIdx];
      const items = (topic.items || []).filter(roadmapItemMatches);
      roadmapTopics.append(renderRoadmapTopicEnlarged(topic, items, topicIdx));
      return;
    }
  }

  // All topics view
  const visibleTopics = topics
    .map((topic, idx) => ({ topic, items: (topic.items || []).filter(roadmapItemMatches), topicIdx: idx }))
    .filter(({ items }) => items.length > 0 || topics.length <= 5);

  if (!visibleTopics.length) {
    return;
  }

  const grid = document.createElement("div");
  grid.className = "topic-index-grid";
  for (const { topic, items, topicIdx } of visibleTopics) {
    grid.append(renderRoadmapTopicCard(topic));
  }
  roadmapTopics.append(grid);
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
    event.dataTransfer?.setData("text/plain", doc.path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => { state.draggedNotePath = ""; });
  return card;
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

function renderTextDocument(source, doc, { includeFallbackTitle = true } = {}) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let paragraphSource = [];
  let list = [];
  let listSource = [];
  let listType = "";
  let blockquote = [];
  let blockquoteSource = [];
  let tableRows = [];
  let tableSource = [];
  let code = null;
  let pendingSource = [];
  let pendingGap = [];
  let firstHeadingSeen = false;

  const sourceAttributes = (sourceText, prefix = "", gap = "") => (
    ' data-source="' + encodeURIComponent(sourceText) + '"' +
    (prefix ? ' data-prefix="' + encodeURIComponent(prefix) + '"' : "") +
    (gap ? ' data-gap="' + encodeURIComponent(gap) + '"' : "")
  );
  const pushBlock = (tag, inner, sourceText, selfClosing = false) => {
    const prefix = pendingSource.join("\n");
    pendingSource = [];
    const gap = "\n".repeat(pendingGap.length + (output.length ? 1 : 0));
    pendingGap = [];
    const attributes = sourceAttributes(sourceText, prefix, gap);
    output.push(selfClosing ? "<" + tag + attributes + ">" : "<" + tag + attributes + ">" + inner + "</" + tag + ">");
  };

  const flushParagraph = () => {
    if (paragraph.length) {
      pushBlock("p", paragraph.map((line) => renderInline(line, doc.path)).join("<br>"), paragraphSource.join("\n"));
      paragraph = [];
      paragraphSource = [];
    }
  };

  const flushList = () => {
    if (list.length) {
      pushBlock(listType, list.map((item) => "<li>" + renderInline(item, doc.path) + "</li>").join(""), listSource.join("\n"));
      list = [];
      listSource = [];
      listType = "";
    }
  };

  const flushBlockquote = () => {
    if (blockquote.length) {
      pushBlock("blockquote", "<p>" + blockquote.map((line) => renderInline(line, doc.path)).join("<br>") + "</p>", blockquoteSource.join("\n"));
      blockquote = [];
      blockquoteSource = [];
    }
  };

  const flushTable = () => {
    if (tableRows.length) {
      const rowsHtml = tableRows.map((row, idx) => {
        const isHeader = idx === 0;
        const tag = isHeader ? "th" : "td";
        const cells = row.split("|").slice(1, -1).map((cell) => "<" + tag + ">" + renderInline(cell.trim(), doc.path) + "</" + tag + ">").join("");
        return "<tr>" + cells + "</tr>";
      }).join("");
      pushBlock("table", "<tbody>" + rowsHtml + "</tbody>", tableSource.join("\n"));
      tableRows = [];
      tableSource = [];
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
    const mdCodeStart = line.match(/^\s*(\u0060{3})(.*)$/);

    if (code) {
      const endCode = code.org ? /^\s*#\+end_src\s*$/i.test(line) : /^\s*\u0060{3}\s*$/.test(line);
      if (endCode) {
        code.source.push(line);
        pushBlock("pre", "<code>" + escapeHtml(code.lines.join("\n")) + "</code>", code.source.join("\n"));
        code = null;
      } else {
        code.lines.push(line);
        code.source.push(line);
      }
      continue;
    }

    if (orgCodeStart || mdCodeStart) {
      flushAll();
      code = { org: Boolean(orgCodeStart), lines: [], source: [line] };
      continue;
    }

    if (/^\s*#\+/.test(line) || /^\s*<!--/.test(line)) {
      pendingSource.push(line);
      continue;
    }

    const heading = doc.extension === ".org"
      ? line.match(/^\s*(\*{1,6})\s+(.+?)\s*$/)
      : line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);

    if (heading) {
      flushAll();
      const level = Math.min(6, heading[1].length);
      const text = heading[2].replace(/\s+#+\s*$/, "");
      if (!firstHeadingSeen) {
        pushBlock("h1", renderInline(text, doc.path), line);
        firstHeadingSeen = true;
      } else {
        pushBlock("h" + level, renderInline(text, doc.path), line);
      }
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      pushBlock("hr", "", line, true);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushBlockquote();
      if (!/^\s*\|[-+\s|]+\|\s*$/.test(line)) {
        tableRows.push(line.trim());
        tableSource.push(line);
      } else {
        tableSource.push(line);
      }
      continue;
    } else if (tableRows.length) {
      flushTable();
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      flushTable();
      blockquote.push(line.replace(/^\s*>\s?/, ""));
      blockquoteSource.push(line);
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
      listSource.push(line);
      continue;
    } else if (list.length) {
      flushList();
    }

    if (!line.trim()) {
      flushAll();
      if (pendingSource.length) pendingSource.push(line);
      else pendingGap.push(line);
      continue;
    }

    paragraph.push(line.trim());
    paragraphSource.push(line);
  }

  if (code) pushBlock("pre", "<code>" + escapeHtml(code.lines.join("\n")) + "</code>", code.source.join("\n"));
  flushAll();

  if (pendingSource.length) {
    const gap = "\n".repeat(pendingGap.length + (output.length ? 1 : 0));
    output.push('<span hidden data-source-only="' + encodeURIComponent(pendingSource.join("\n")) + '" data-gap="' + encodeURIComponent(gap) + '"></span>');
  }

  if (includeFallbackTitle && !firstHeadingSeen && doc.title) {
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
  noteViewer.classList.remove("is-fullscreen");
  const fullscreenButton = $("#fullscreen-note-viewer");
  fullscreenButton.textContent = "⛶";
  fullscreenButton.setAttribute("aria-label", "Enter fullscreen");
  fullscreenButton.title = "Enter fullscreen";
  state.selected = null;
  state.selectedPayload = null;
  state.editorSession = null;
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

function closeNoteViewer() {
  if (!confirmDiscardEditor()) return false;
  clearReader({ resetUrl: true });
  return true;
}

function toggleNoteViewerFullscreen() {
  const fullscreen = noteViewer.classList.toggle("is-fullscreen");
  const button = $("#fullscreen-note-viewer");
  button.textContent = fullscreen ? "↙" : "⛶";
  button.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Enter fullscreen");
  button.title = fullscreen ? "Exit fullscreen" : "Enter fullscreen";
}

function readerButton(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className || "";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderSelectedDocument(doc, payload) {
  disposePdfViewer();
  state.selectedPayload = payload;
  state.editorSession = null;
  readerContent.hidden = false;
  readerContent.style.display = "block";
  readerContent.replaceChildren();

  const toolbar = document.createElement("div");
  toolbar.className = "reader-toolbar";
  const location = document.createElement("span");
  location.className = "reader-location";
  location.textContent = `${state.collections[doc.collection] || formatFolderName(doc.collection)} · ${doc.title}`;
  const actions = document.createElement("span");
  actions.className = "reader-actions";
  const type = document.createElement("span");
  type.className = "reader-type";
  type.textContent = doc.extension.slice(1);
  actions.append(type);

  if (doc.extension === ".pdf") {
    const open = document.createElement("a");
    open.className = "reader-link";
    open.href = `/api/file?path=${encodeURIComponent(doc.path)}`;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open PDF ↗";
    actions.append(open);
  }

  if (TEXT_EXTENSIONS_FOR_UI.has(doc.extension)) {
    actions.append(readerButton("Edit", "", () => startEditingNote(doc, payload)));
  }
  actions.append(readerButton("Delete", "danger-button", () => deleteNote(doc.path)));
  toolbar.append(location, actions);
  readerContent.append(toolbar);

  if (doc.extension === ".pdf") {
    readerContent.append(createPdfViewer(doc));
  } else {
    const article = document.createElement("div");
    article.className = "document-article";
    article.innerHTML = renderTextDocument(payload.content || "", doc);
    readerContent.append(article);
  }
}

function decodeEditorSource(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

function relativeLinkTarget(target, documentPath) {
  const from = documentPath.split("/").slice(0, -1).filter(Boolean);
  const to = String(target || "").replace(/^\/+/, "").split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const parts = Array(from.length - common).fill("..").concat(to.slice(common));
  return parts.join("/") || ".";
}

function resourcePathFromUrl(value) {
  try {
    const url = new URL(value, window.location.origin);
    if (url.pathname === "/" && url.searchParams.has("note")) {
      return { kind: "note", path: url.searchParams.get("note") };
    }
    if (url.pathname === "/api/file" && url.searchParams.has("path")) {
      return { kind: "file", path: url.searchParams.get("path") };
    }
  } catch {
    return null;
  }
  return null;
}

function serializeInlineNode(node, extension, documentPath) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\u00a0/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "img") {
    const alt = node.getAttribute("alt") || "";
    const resource = resourcePathFromUrl(node.getAttribute("src") || "");
    const target = resource
      ? relativeLinkTarget(resource.path, documentPath)
      : (node.getAttribute("src") || "");
    return extension === ".org"
      ? "[[file:" + target + "][" + alt + "]]"
      : "![" + alt + "](" + target + ")";
  }

  const inner = Array.from(node.childNodes)
    .map((child) => serializeInlineNode(child, extension, documentPath))
    .join("");
  if (tag === "strong" || tag === "b") {
    return extension === ".org" ? "*" + inner + "*" : "**" + inner + "**";
  }
  if (tag === "em" || tag === "i") return extension === ".org" ? "/" + inner + "/" : "*" + inner + "*";
  if (tag === "code") return extension === ".org" ? "~" + inner + "~" : "\u0060" + inner + "\u0060";
  if (tag !== "a") return inner;

  const href = node.getAttribute("href") || "";
  const resource = resourcePathFromUrl(href);
  const label = inner || href;
  if (resource) {
    const target = relativeLinkTarget(resource.path, documentPath);
    return extension === ".org"
      ? "[[file:" + target + "][" + label + "]]"
      : "[" + label + "](" + target + ")";
  }
  return extension === ".org"
    ? "[[" + href + "][" + label + "]]"
    : "[" + label + "](" + href + ")";
}

function serializeInlineNodes(nodes, extension, documentPath) {
  return Array.from(nodes)
    .map((node) => serializeInlineNode(node, extension, documentPath))
    .join("");
}

function serializeEditableBlock(node, extension, documentPath, originalSource = "") {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.trim();
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  const inline = serializeInlineNodes(node.childNodes, extension, documentPath);
  const heading = tag.match(/^h([1-6])$/);
  if (heading) {
    let level = Number(heading[1]);
    const originalHeading = originalSource.split("\n").find((line) =>
      extension === ".org" ? /^\s*\*{1,6}\s+/.test(line) : /^\s{0,3}#{1,6}\s+/.test(line)
    );
    if (originalHeading) {
      const originalLevel = extension === ".org"
        ? originalHeading.match(/^\s*(\*{1,6})\s+/)?.[1].length
        : originalHeading.match(/^\s{0,3}(#{1,6})\s+/)?.[1].length;
      if (originalLevel) level = originalLevel;
    }
    const marks = extension === ".org" ? "*".repeat(level) : "#".repeat(level);
    return marks + " " + inline.trim();
  }
  if (tag === "p") return inline.trim();
  if (tag === "ul" || tag === "ol") {
    return Array.from(node.children).filter((child) => child.tagName.toLowerCase() === "li")
      .map((item, index) => {
        const content = serializeInlineNodes(item.childNodes, extension, documentPath).trim();
        return tag === "ol" ? (index + 1) + ". " + content : "- " + content;
      }).join("\n");
  }
  if (tag === "li") return "- " + inline.trim();
  if (tag === "blockquote") {
    const content = Array.from(node.children)
      .map((child) => serializeEditableBlock(child, extension, documentPath))
      .filter(Boolean)
      .join("\n");
    return content.split("\n").map((line) => "> " + line).join("\n");
  }
  if (tag === "pre") {
    const text = node.textContent.replace(/\n+$/, "");
    if (extension === ".org") {
      const options = originalSource.match(/^\s*#\+begin_src(.*)$/im)?.[1] || "";
      return "#+begin_src" + options + "\n" + text + "\n#+end_src";
    }
    const fenceInfo = originalSource.match(/^\s*\u0060{3}(.*)$/m)?.[1] || "";
    return "\u0060\u0060\u0060" + fenceInfo + "\n" + text + "\n\u0060\u0060\u0060";
  }
  if (tag === "table") {
    const rows = Array.from(node.querySelectorAll("tr")).map((row) =>
      Array.from(row.children)
        .map((cell) => serializeInlineNodes(cell.childNodes, extension, documentPath).trim())
        .join(" | ")
    );
    if (rows.length > 1) {
      const separator = rows[0].split(" | ").map(() => "---").join(extension === ".org" ? "+" : " | ");
      rows.splice(1, 0, separator);
    }
    return rows.map((row) => "| " + row + " |").join("\n");
  }
  if (tag === "hr") return extension === ".org" ? "-----" : "---";
  return Array.from(node.childNodes)
    .map((child) => serializeEditableBlock(child, extension, documentPath))
    .filter(Boolean)
    .join("\n");
}

function serializeEditedNote(article, payload, doc, session, title) {
  const chunks = [];
  for (const node of article.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && !node.nodeValue.trim()) continue;
    if (node.nodeType === Node.ELEMENT_NODE && node.dataset.sourceOnly !== undefined) {
      chunks.push({
        gap: decodeEditorSource(node.dataset.gap),
        text: decodeEditorSource(node.dataset.sourceOnly),
      });
      continue;
    }

    const original = session.originalBlocks.get(node);
    if (original && node.outerHTML === original.markup) {
      chunks.push({ gap: original.gap, text: original.source });
      continue;
    }

    const prefix = node.nodeType === Node.ELEMENT_NODE ? decodeEditorSource(node.dataset.prefix) : "";
    const gap = node.nodeType === Node.ELEMENT_NODE ? decodeEditorSource(node.dataset.gap) : "";
    const block = serializeEditableBlock(node, doc.extension, doc.path, original?.source || "");
    if (block) chunks.push({ gap, text: prefix ? prefix + "\n" + block : block });
  }

  let content = chunks.filter((chunk) => chunk.text).map((chunk, index) => (
    (chunk.gap || (index ? "\n\n" : "")) + chunk.text
  )).join("");
  if (doc.extension === ".org" && /^\s*#\+title\s*:/im.test(payload.content || "")) {
    const lines = content.split("\n");
    let foundTitle = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (/^\s*#\+title\s*:/i.test(lines[index])) {
        lines[index] = "#+TITLE: " + title;
        foundTitle = true;
        break;
      }
    }
    if (!foundTitle) lines.unshift("#+TITLE: " + title, "");
    content = lines.join("\n");
  }
  return content;
}

function currentTitleHeading(article, doc) {
  if (doc.extension === ".md") return article.querySelector("h1");
  return Array.from(article.querySelectorAll("h1"))
    .find((heading) => heading.textContent.trim() === doc.title);
}

function topLevelEditableBlock(article, node) {
  let element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  if (!element || element === article) return null;
  while (element.parentElement && element.parentElement !== article) {
    element = element.parentElement;
  }
  return element.parentElement === article ? element : null;
}

function applyLiveBlockSyntax(article, extension, session) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const block = topLevelEditableBlock(article, selection.anchorNode);
  if (!block || !["P", "DIV"].includes(block.tagName)) return null;

  const text = block.textContent;
  if (text.includes("\n")) return null;

  let tag = "";
  let content = "";
  let syntaxLength = 0;
  if (extension === ".org") {
    const heading = text.match(/^(\*{1,6})[ \t]+(.*)$/);
    if (heading) {
      tag = "h" + heading[1].length;
      content = heading[2];
      syntaxLength = heading[1].length + heading[0].slice(heading[1].length).match(/^[ \t]+/)[0].length;
    } else {
      const bullet = text.match(/^[-+][ \t]+(.*)$/);
      if (bullet) {
        tag = "ul";
        content = bullet[1];
        syntaxLength = text.length - content.length;
      }
    }
  } else {
    const heading = text.match(/^(#{1,6})[ \t]+(.*)$/);
    if (heading) {
      tag = "h" + heading[1].length;
      content = heading[2];
      syntaxLength = heading[1].length + heading[0].slice(heading[1].length).match(/^[ \t]+/)[0].length;
    } else {
      const ordered = text.match(/^(\d+)[.)][ \t]+(.*)$/);
      const bullet = text.match(/^[-+*][ \t]+(.*)$/);
      if (ordered) {
        tag = "ol";
        content = ordered[2];
        syntaxLength = text.length - content.length;
      } else if (bullet) {
        tag = "ul";
        content = bullet[1];
        syntaxLength = text.length - content.length;
      }
    }
  }
  if (!tag) return null;

  let caretOffset = text.length;
  try {
    const beforeCaret = document.createRange();
    beforeCaret.selectNodeContents(block);
    beforeCaret.setEnd(selection.anchorNode, selection.anchorOffset);
    caretOffset = beforeCaret.toString().length;
  } catch {
    // Keep the caret at the end if the browser uses an unexpected selection shape.
  }

  const replacement = document.createElement(tag);
  for (const attribute of block.attributes) {
    if (attribute.name.startsWith("data-")) replacement.setAttribute(attribute.name, attribute.value);
  }
  const item = tag === "ul" || tag === "ol" ? document.createElement("li") : replacement;
  const textNode = document.createTextNode(content);
  item.append(textNode);
  if (item !== replacement) replacement.append(item);
  block.replaceWith(replacement);

  const original = session.originalBlocks.get(block);
  if (original) session.originalBlocks.set(replacement, original);

  const range = document.createRange();
  range.setStart(textNode, Math.min(Math.max(0, caretOffset - syntaxLength), textNode.length));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return replacement;
}

function startEditingNote(doc, payload) {
  state.selectedPayload = payload;
  state.editorSession = null;
  readerContent.replaceChildren();

  const toolbar = document.createElement("div");
  toolbar.className = "reader-toolbar";
  const location = document.createElement("span");
  location.className = "reader-location";
  location.textContent = (state.collections[doc.collection] || formatFolderName(doc.collection)) + " ·";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "reader-title-editor";
  titleInput.value = doc.title;
  titleInput.maxLength = 300;
  titleInput.setAttribute("aria-label", "Note title");

  const status = document.createElement("span");
  status.className = "save-status";
  status.textContent = "";

  const actions = document.createElement("span");
  actions.className = "reader-actions";
  const save = readerButton("Save", "primary-button", () => saveNote(doc, payload));
  const cancel = readerButton("Cancel", "", () => renderSelectedDocument(doc, payload));
  actions.append(cancel, save);
  toolbar.append(location, titleInput, status, actions);

  const article = document.createElement("div");
  article.className = "document-article note-inline-editor";
  article.contentEditable = "true";
  article.spellcheck = true;
  article.setAttribute("aria-label", "Edit note content");
  article.setAttribute("role", "textbox");
  article.setAttribute("aria-multiline", "true");
  article.innerHTML = renderTextDocument(payload.content || "", doc, { includeFallbackTitle: false });
  if (!Array.from(article.children).some((node) => !node.hidden)) {
    const emptyParagraph = document.createElement("p");
    emptyParagraph.append(document.createElement("br"));
    article.append(emptyParagraph);
  }
  const updateEmptyState = () => {
    const hasVisibleContent = Array.from(article.childNodes).some((node) =>
      node.nodeType === Node.ELEMENT_NODE
        ? !node.hidden && (node.tagName !== "P" || Boolean(node.textContent.trim() || node.querySelector("img")))
        : Boolean(node.nodeValue.trim())
    );
    article.dataset.empty = String(!hasVisibleContent);
  };
  updateEmptyState();
  readerContent.append(toolbar, article);

  const originalBlocks = new WeakMap();
  for (const node of article.children) {
    if (node.dataset.source === undefined) continue;
    const prefix = decodeEditorSource(node.dataset.prefix);
    const raw = decodeEditorSource(node.dataset.source);
    originalBlocks.set(node, {
      markup: node.outerHTML,
      gap: decodeEditorSource(node.dataset.gap),
      source: prefix ? prefix + "\n" + raw : raw,
    });
  }
  state.editorSession = {
    path: doc.path,
    title: doc.title,
    initialMarkup: article.innerHTML,
    originalBlocks,
  };

  let titleHeading = currentTitleHeading(article, doc);
  const updateStatus = () => {
    status.textContent = editorHasUnsavedChanges() ? "Unsaved changes" : "";
  };
  titleInput.addEventListener("input", () => {
    titleHeading = currentTitleHeading(article, doc) || titleHeading;
    if (titleHeading?.isConnected) titleHeading.textContent = titleInput.value;
    updateStatus();
  });
  article.addEventListener("input", () => {
    const converted = applyLiveBlockSyntax(article, doc.extension, state.editorSession);
    if (converted && doc.extension === ".md" && article.querySelector("h1") === converted) {
      titleHeading = converted;
    }
    if (doc.extension === ".md" && (!titleHeading || !titleHeading.isConnected)) {
      titleHeading = article.querySelector("h1");
    }
    if (titleHeading?.isConnected) titleInput.value = titleHeading.textContent.trim();
    updateEmptyState();
    updateStatus();
  });
  article.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (target) event.preventDefault();
  });
  article.focus();
}

async function saveNote(doc, payload) {
  const article = $(".note-inline-editor");
  const titleInput = $(".reader-title-editor");
  if (!article || !titleInput || !state.editorSession) return;

  const title = titleInput.value.trim() || "Untitled";
  const content = serializeEditedNote(article, payload, doc, state.editorSession, title);
  const saveButtons = readerContent.querySelectorAll(".reader-actions button");
  saveButtons.forEach((button) => { button.disabled = true; });
  titleInput.disabled = true;
  article.contentEditable = "false";
  try {
    const response = await fetch("/api/notes?path=" + encodeURIComponent(doc.path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, version: payload.version }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save note.");
    const updated = { ...doc, ...result };
    const index = state.documents.findIndex((item) => item.path === doc.path);
    if (index >= 0) state.documents[index] = updated;
    state.selected = updated;
    const updatedPayload = { ...payload, title: updated.title, content, version: updated.version };
    renderSelectedDocument(updated, updatedPayload);
    updateList();
    if (state.query) runSearch(state.query);
    showToast("Note saved");
  } catch (error) {
    showToast(error.message);
    saveButtons.forEach((button) => { button.disabled = false; });
    titleInput.disabled = false;
    article.contentEditable = "true";
  }
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
    state.documents = state.documents.map((doc) => doc.path === path ? { ...doc, ...result } : doc);
    state.results = state.results.map((doc) => doc.path === path ? { ...doc, ...result } : doc);
    if (state.selected?.path === path) {
      state.selected = { ...state.selected, ...result };
      if (state.selectedPayload) state.selectedPayload.version = result.version;
    }
    state.folder = folder;
    state.expanded.add(folder);
    buildFolderTree(state.documents);
    highlightActiveFolder();
    updateList();
    showToast(`Moved to ${folder.split("/").map(formatFolderName).join(" / ")}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function createTopic() {
  if (!confirmDiscardEditor()) return;
  const name = window.prompt("Topic name");
  if (!name?.trim()) return;
  try {
    const response = await fetch("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not create topic.");
    if (state.view === "roadmap" || state.view === "projects" || state.view === "following") switchToNotes();
    state.collections[result.key] = result.label;
    state.folder = result.key;
    buildFolderTree(state.documents);
    highlightActiveFolder();
    updateList();
    showToast(`Created topic: ${result.label}`);
  } catch (error) {
    showToast(error.message);
  }
}

function openNewNoteDialog() {
  if (!confirmDiscardEditor()) return;
  const select = $("#new-note-topic");
  select.replaceChildren();
  for (const [key, label] of Object.entries(state.collections)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    select.append(option);
  }
  const currentCollection = state.folder ? state.folder.split("/")[0] : "inbox";
  select.value = state.collections[currentCollection] ? currentCollection : "inbox";
  $("#new-note-title").value = "Untitled";
  $("#note-dialog").showModal();
  $("#new-note-title").focus();
  $("#new-note-title").select();
}

async function createNoteFromDialog(event) {
  event.preventDefault();
  const title = $("#new-note-title").value.trim() || "Untitled";
  const collection = $("#new-note-topic").value || "inbox";
  const folder = state.folder.startsWith(`${collection}/`) || state.folder === collection ? state.folder : collection;
  try {
    const response = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content: "", extension: ".md", collection, folder }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not create note.");
    $("#note-dialog").close();
    state.query = "";
    $("#search-input").value = "";
    $("#clear-search").hidden = true;
    state.folder = folder;
    state.documents.unshift(result);
    state.results = state.documents;
    buildFolderTree(state.documents);
    highlightActiveFolder();
    updateList();
    selectDocument(result, { edit: true });
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteNote(path) {
  if (!confirmDiscardEditor()) return;
  if (!window.confirm("Are you sure you want to delete this note?\n\nThis will delete it permanently and cannot be undone.")) return;
  try {
    const response = await fetch(`/api/notes?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not delete note.");
    state.documents = state.documents.filter((doc) => doc.path !== path);
    state.results = state.results.filter((doc) => doc.path !== path);
    state.requestId += 1;
    if (state.selected?.path === path) clearReader({ resetUrl: true });
    buildFolderTree(state.documents);
    highlightActiveFolder();
    updateList();
    showToast(result.warning || "Note deleted permanently");
  } catch (error) {
    showToast(error.message);
  }
}

// openRoadmapEditor / saveRoadmapEditor retained for compatibility but not used in UI
async function openRoadmapEditor() {}
async function saveRoadmapEditor(event) { event.preventDefault(); }

function selectDocument(doc, { edit = false } = {}) {
  if (editorHasUnsavedChanges() && !confirmDiscardEditor()) return;
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
  readerContent.innerHTML = '<div class="document-article">Loading note…</div>';

  const requestId = ++state.documentRequestId;
  if (doc.extension === ".pdf") {
    renderSelectedDocument(doc, { content: "", version: doc.version });
    history.replaceState(null, "", `/?note=${encodeURIComponent(doc.path)}`);
    return;
  }

  fetch(`/api/document?path=${encodeURIComponent(doc.path)}`)
    .then((res) => {
      if (!res.ok) throw new Error("Could not load note content.");
      return res.json();
    })
    .then((payload) => {
      if (requestId !== state.documentRequestId || state.selected?.path !== doc.path) return;
      if (edit) startEditingNote(doc, payload);
      else renderSelectedDocument(doc, payload);
      history.replaceState(null, "", `/?note=${encodeURIComponent(doc.path)}`);
    })
    .catch((err) => {
      const article = readerContent.querySelector(".document-article");
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
  if (!switchToNotes()) return;
  state.folder = "";
  highlightActiveFolder();
  updateHeading();
  if (state.query) runSearch(state.query);
  else updateList();
}

function formatFolderPath(path) {
  return pathParts(path).map((part, index) =>
    index === 0 && state.collections[part] ? state.collections[part] : formatFolderName(part)
  ).join(" / ");
}

function getHomeFolders() {
  const folders = new Map();
  const addFolder = (path, label) => {
    if (path && !folders.has(path)) folders.set(path, { path, label });
  };

  for (const [key, label] of Object.entries(state.collections)) addFolder(key, label || formatFolderName(key));
  for (const doc of state.documents) {
    const collection = doc.collection || "general";
    addFolder(collection, state.collections[collection] || formatFolderName(collection));
    let currentPath = collection;
    let parts = pathParts(doc.folder);
    if (parts[0] === collection) parts = parts.slice(1);
    else if (collection === "general") parts = [];
    for (const part of parts) {
      currentPath = `${currentPath}/${part}`;
      addFolder(currentPath, formatFolderName(part));
    }
  }
  return [...folders.values()];
}

function renderHomeResult({ kind, title, meta = "", doc = null, folderPath = "" }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "home-result";
  const symbol = document.createElement("span");
  symbol.className = "home-result-symbol";
  if (kind === "folder") {
    symbol.innerHTML = folderSvg;
  } else {
    symbol.classList.add("file-badge", ...(doc.extension === ".pdf" ? ["pdf"] : []));
    symbol.textContent = doc.extension.slice(1).toUpperCase();
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
  if (kind === "folder") button.addEventListener("click", () => openHomeFolder(folderPath));
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

function renderHomeSuggestions(query) {
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

  const notes = state.documents
    .filter((doc) => matches(`${doc.title} ${doc.path}`))
    .sort((a, b) => rank(a.title, a.path) - rank(b.title, b.path) || a.title.localeCompare(b.title))
    .slice(0, 12)
    .map((doc) => renderHomeResult({
      kind: "note",
      title: doc.title,
      meta: formatFolderPath(doc.folder || doc.collection),
      doc,
    }));

  appendHomeSuggestionGroup("Topics", folders);
  appendHomeSuggestionGroup("Notes", notes);
  if (!folders.length && !notes.length) {
    const empty = document.createElement("div");
    empty.className = "home-empty";
    empty.textContent = "No matching topics or notes.";
    homeSuggestions.append(empty);
  }
}

function openHomeFolder(folderPath, { syncUrl = true } = {}) {
  if (!switchToNotes()) return;
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
  if (!switchToNotes()) return;
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
  if (!switchToNotes()) return;
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

  revealDocument(doc);
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

    const params = new URLSearchParams(location.search);
    if (params.get("view") === "roadmap") {
      await switchToRoadmap({ topic: params.get("topic") || "", syncUrl: false });
      loadProjects().catch(() => {});
    } else if (params.get("view") === "projects") {
      await switchToProjects({ syncUrl: false });
    } else if (params.get("view") === "following") {
      await switchToFollowing({ syncUrl: false });
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
$("#brand-home").addEventListener("click", (event) => {
  event.preventDefault();
  switchToHome();
});
navSearch.addEventListener("click", () => switchToHome());
$("#close-note-viewer").addEventListener("click", closeNoteViewer);
$("#fullscreen-note-viewer").addEventListener("click", toggleNoteViewerFullscreen);
noteViewer.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (noteViewer.classList.contains("is-fullscreen")) {
    toggleNoteViewerFullscreen();
    return;
  }
  closeNoteViewer();
});
noteViewer.addEventListener("click", (event) => {
  if (event.target === noteViewer) closeNoteViewer();
});
navRoadmap.addEventListener("click", () => switchToRoadmap({ topic: "" }));
navProjects.addEventListener("click", () => switchToProjects());
navFollowing.addEventListener("click", () => switchToFollowing());
$("#following-filters").addEventListener("click", (event) => {
  const button = event.target.closest(".following-filter");
  if (!button) return;
  state.followingFilter = button.dataset.kind || "all";
  renderFollowing();
});
$("#new-following-item").addEventListener("click", () => openFollowingDialog());
$("#following-form").addEventListener("submit", saveFollowingItem);
$("#cancel-following-item").addEventListener("click", () => $("#following-dialog").close());
$("#delete-following-item").addEventListener("click", () => {
  const item = state.following?.find((entry) => entry.id === $("#following-id").value);
  if (item) deleteFollowingItem(item);
});
$("#new-note").addEventListener("click", openNewNoteDialog);
$("#new-topic").addEventListener("click", createTopic);
$("#note-form").addEventListener("submit", createNoteFromDialog);
$("#cancel-new-note").addEventListener("click", () => $("#note-dialog").close());
$("#new-project").addEventListener("click", () => openProjectDialog());
$("#project-form").addEventListener("submit", handleProjectFormSubmit);
$("#cancel-project").addEventListener("click", () => $("#project-dialog").close());
$("#delete-project").addEventListener("click", deleteProjectFromDialog);
$("#projects-filters").addEventListener("click", (event) => {
  const button = event.target.closest(".project-filter");
  if (!button) return;
  state.projectFilter = button.dataset.status || "all";
  renderProjects();
});
// Up Next inline-edit listeners
$("#add-upnext-item").addEventListener("click", () => openUpNextItemDialog(null, state.roadmapTopic || "", -1, -1));
$("#upnext-item-form").addEventListener("submit", handleUpNextItemSubmit);
$("#upnext-item-topic").addEventListener("input", (event) => populateUpNextDatalists(event.currentTarget.value));
$("#cancel-upnext-item").addEventListener("click", () => $("#upnext-item-dialog").close());
$("#backup-button").addEventListener("click", () => {
  window.location.assign("/api/backup");
  showToast("Preparing a database and files backup…");
});

roadmapPills.addEventListener("click", (event) => {
  const pill = event.target.closest(".pill");
  if (!pill) return;
  state.roadmapFilter = pill.dataset.type || "all";
  for (const candidate of roadmapPills.querySelectorAll(".pill")) {
    candidate.classList.toggle("active", candidate === pill);
  }
  renderRoadmap();
});

$("#search-input").addEventListener("input", (e) => {
  window.clearTimeout(state.searchTimer);
  const q = e.target.value;
  if (state.view === "home") {
    runSearch(q);
    return;
  }
  state.searchTimer = window.setTimeout(() => runSearch(q), q.trim() ? 150 : 0);
});

$("#search-input").addEventListener("keydown", (event) => {
  if (state.view !== "home") return;
  if (event.key === "ArrowDown") {
    const firstResult = homeSuggestions.querySelector(".home-result");
    if (firstResult) {
      event.preventDefault();
      firstResult.focus();
    }
  } else if (event.key === "Enter") {
    const firstResult = homeSuggestions.querySelector(".home-result");
    if (firstResult) {
      event.preventDefault();
      firstResult.click();
    }
  }
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

    if (state.query) {
      await runSearch(state.query);
    } else {
      updateList();
    }

    state.roadmap = null;
    if (state.view === "following") {
      await loadFollowing({ force: true });
      renderFollowing();
    } else if (state.view === "roadmap") {
      await switchToRoadmap({ topic: state.roadmapTopic });
    } else if (state.view === "projects") {
      await loadProjects({ force: true });
      renderProjects();
    } else {
      loadRoadmap().catch(() => {});
      loadProjects({ force: true }).catch(() => {});
    }

    showToast("App data refreshed");
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && $(".note-inline-editor")) {
    e.preventDefault();
    const doc = state.selected;
    const payload = state.selectedPayload;
    if (doc && payload) {
      saveNote(doc, payload);
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (noteViewer.open && !closeNoteViewer()) return;
    if (state.view === "roadmap" || state.view === "projects" || state.view === "following") {
      if (!switchToNotes()) return;
    }
    $("#search-input").focus();
  }
  if (e.key === "Escape" && document.activeElement === $("#search-input")) {
    $("#search-input").value = "";
    runSearch("");
    if (state.view !== "home") $("#search-input").blur();
  }
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
  if (params.get("view") === "projects") {
    switchToProjects({ syncUrl: false });
    return;
  }
  if (params.get("view") === "following") {
    switchToFollowing({ syncUrl: false });
    return;
  }
  const targetPath = params.get("note");
  const doc = state.documents.find((d) => d.path === targetPath);
  if (targetPath && doc) {
    revealDocument(doc);
    return;
  }
  if (params.has("folder")) {
    openHomeFolder(params.get("folder"), { syncUrl: false });
    return;
  }
  switchToHome({ syncUrl: false, focus: false });
});

initialize();
