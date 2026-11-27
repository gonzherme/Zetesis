"use strict";

// Roadmap: a map of boxes of text joined by arrows, on a space that pans and zooms, like a mind map.
// Right-clicking a box opens its note, a large card over the map, for details about it.
// Boxes and arrows are kept by the server; where you are on the map, and how near, is this browser's
// own. Loaded before app.js, whose state, toast and search box it uses once Roadmap is open. (Its code
// says "map": "roadmap" in app.js is what the sidebar calls Explore.)

const SVG_NS = "http://www.w3.org/2000/svg";
const MAP_GRID = 24;
const MAP_ZOOM_MIN = 0.25;
const MAP_ZOOM_MAX = 2.5;
const MAP_ARROW_HEAD = 9;
// A box joined to another starts this far to its right.
const MAP_JOINED_GAP = 64;
// About the size of a new box, before it has any text.
const MAP_NEW_BOX = { w: 140, h: 40 };
const MAP_MARGIN = 60;
const MAP_DRAG_PX = 5;
const MAP_VIEW_KEY = "zetesis.map.view";

const mapEl = document.getElementById("map");
const mapPlane = document.getElementById("map-plane");
const mapBoxesEl = document.getElementById("map-boxes");
const mapArrowsEl = document.getElementById("map-arrows");
const mapPending = document.getElementById("map-pending");
const mapEmpty = document.getElementById("map-empty");
const MAP_HINT = mapEmpty.innerHTML;
const mapNote = document.getElementById("map-note");
const mapNoteTitle = mapNote.querySelector(".map-note-title");
const mapNoteClose = mapNote.querySelector(".map-note-close");
const mapNoteText = mapNote.querySelector(".map-note-text");
const MAP_NOTE_SAVE_MS = 800;

const mapData = { boxes: [], arrows: [], loaded: false };
// The map's place on screen: a point on it shows at (point * zoom + x, point * zoom + y). Null until
// first shown, when it takes in every box.
let mapView = loadMapView();
let saveMapTimer = 0;
// What is selected: { kind: "box" | "arrow", id }.
let mapSelected = null;
// A box being written for the first time, and the arrow joining it to another; both reach the server
// once it has some text.
let mapDraft = null;
// The press under way: panning the map, moving a box, or drawing an arrow from a box.
let mapGesture = null;
// The zoom a trackpad pinch started from, while it lasts.
let mapPinchFrom = null;
// Changes reach the server one at a time, in order; loading waits for them.
let mapWrites = Promise.resolve();
// The box whose note is open, and whose was open when the last press began (a right-click on that box
// closes it).
let mapNoteFor = null;
let mapNoteAtPress = null;
let mapNoteTimer = 0;

const mapBoxes = () => (mapDraft ? [...mapData.boxes, mapDraft.box] : mapData.boxes);
const mapArrowList = () => (mapDraft?.arrow ? [...mapData.arrows, mapDraft.arrow] : mapData.arrows);
const findMapBox = (id) => mapBoxes().find((box) => box.id === id);
const findMapArrow = (id) => mapData.arrows.find((arrow) => arrow.id === id);
const mapBoxElement = (id) => mapBoxesEl.querySelector(`.map-box[data-key="${id}"]`);
// Two boxes are joined once, whichever way the arrow points.
const mapJoined = (a, b) => mapArrowList().some((arrow) => (arrow.from_id === a && arrow.to_id === b) || (arrow.from_id === b && arrow.to_id === a));
const mapClamp = (value, low, high) => Math.min(high, Math.max(low, value));

function loadMapView() {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_VIEW_KEY));
    if ([saved?.x, saved?.y, saved?.zoom].every(Number.isFinite)) return saved;
  } catch {
    // Storage can be off; the map then starts by showing every box.
  }
  return null;
}

function saveMapView() {
  clearTimeout(saveMapTimer);
  saveMapTimer = setTimeout(() => {
    try {
      localStorage.setItem(MAP_VIEW_KEY, JSON.stringify(mapView));
    } catch {
      // Only a convenience.
    }
  }, 300);
}

// The server

function mapWrite(method, path, body) {
  mapWrites = mapWrites
    .then(async () => {
      const response = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "The change wasn't saved.");
    })
    .catch(async (error) => {
      // What the server has is what's so; the map goes back to it.
      showToast(error instanceof TypeError ? "Not saved: Zetesis isn't running" : `Not saved: ${error.message}`);
      await fetchMap().catch(() => {});
    });
}

async function fetchMap() {
  const response = await fetch("/api/map", { cache: "no-store" });
  // A server started before Roadmap existed doesn't know it.
  if (response.status === 404) throw new Error("Roadmap needs Zetesis's server restarted.");
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Roadmap couldn't be loaded.");
  mapData.boxes = payload.boxes;
  mapData.arrows = payload.arrows;
  mapData.loaded = true;
  mapEmpty.innerHTML = MAP_HINT;
  renderMap();
}

// The map as the server has it, once the changes on their way have reached it.
async function loadMap() {
  await mapWrites;
  await fetchMap();
}

// Roadmap opened (app.js shows it first): what the server has, drawn.
async function openMap() {
  if (!mapData.loaded) mapEmpty.textContent = "Loading…";
  renderMap();
  try {
    await loadMap();
  } catch (error) {
    showToast(error.message);
    if (!mapData.loaded) mapEmpty.textContent = error.message;
  }
}

// Leaving Roadmap keeps what's being written.
function closeMap() {
  const editing = editingMapBox();
  if (editing) finishMapEdit(editing, true);
  closeMapNote();
  mapSelected = null;
}

// Rendering

function syncMapChildren(parent, items, keyOf, create, update) {
  const existing = new Map([...parent.children].map((element) => [element.dataset.key, element]));
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const key = keyOf(item);
    const element = existing.get(key) ?? create(item);
    element.dataset.key = key;
    existing.delete(key);
    update(element, item);
    if (element === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(element, cursor);
  }
  existing.forEach((element) => element.remove());
}

function renderMap() {
  if (mapEl.hidden) return;
  if (mapNoteFor && !mapData.boxes.some((box) => box.id === mapNoteFor)) {
    closeMapNote();
    return;
  }
  if (mapSelected && !(mapSelected.kind === "box" ? findMapBox(mapSelected.id) : findMapArrow(mapSelected.id))) mapSelected = null;
  syncMapChildren(mapBoxesEl, mapBoxes(), (box) => box.id, createMapBoxElement, updateMapBoxElement);
  if (!mapView) showWholeMap();
  placeMap();
  drawMapArrows();
  mapEmpty.hidden = mapBoxes().length > 0;
}

function createMapBoxElement() {
  const element = document.createElement("div");
  element.className = "map-box";
  element.innerHTML = '<div class="map-text"></div>'
    + '<button class="map-handle" type="button" tabindex="-1" title="Drag to another box to join them" aria-label="Join to another box"></button>';
  return element;
}

function updateMapBoxElement(element, box) {
  const at = mapGesture?.kind === "move" && mapGesture.id === box.id ? mapGesture.at : box;
  element.style.left = `${at.x}px`;
  element.style.top = `${at.y}px`;
  element.classList.toggle("selected", mapSelected?.kind === "box" && mapSelected.id === box.id);
  element.classList.toggle("unmatched", !mapBoxMatches(box));
  const text = element.querySelector(".map-text");
  if (!element.classList.contains("editing") && text.textContent !== box.text) text.textContent = box.text;
}

const mapFold = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ⌘F dims the boxes that don't hold every word searched for, in their text or notes.
function mapSearchTerms() {
  return searchBar.hidden ? [] : mapFold(searchInput.value).split(/\s+/).filter(Boolean);
}

function mapBoxMatches(box) {
  const text = mapFold(`${box.text}\n${box.notes ?? ""}`);
  return mapSearchTerms().every((term) => text.includes(term));
}

function placeMap() {
  const { x, y, zoom } = mapView;
  mapPlane.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  mapEl.style.backgroundSize = `${MAP_GRID * zoom}px ${MAP_GRID * zoom}px`;
  mapEl.style.backgroundPosition = `${x}px ${y}px`;
}

// A box's place and size on the map, as laid out.
function mapBoxRect(id) {
  const element = mapBoxElement(id);
  return element && { x: element.offsetLeft, y: element.offsetTop, w: element.offsetWidth, h: element.offsetHeight };
}

const mapMiddleOf = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

// Where a line from the middle of `rect` toward `point` leaves it, and `gap` further on.
function mapEdgePoint(rect, point, gap = 0) {
  const center = mapMiddleOf(rect);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const length = Math.hypot(dx, dy);
  if (!length) return center;
  const reach = Math.min(dx ? rect.w / 2 / Math.abs(dx) : Infinity, dy ? rect.h / 2 / Math.abs(dy) : Infinity);
  return { x: center.x + dx * reach + (dx / length) * gap, y: center.y + dy * reach + (dy / length) * gap };
}

function createMapArrowElement() {
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "map-arrow");
  group.innerHTML = '<line class="hit"/><line class="shaft"/><path class="head"/>';
  return group;
}

// An arrow runs between the edges of its boxes, as if from the middle of one to the middle of the other.
function shapeMapArrow(group, start, end) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const base = { x: end.x - MAP_ARROW_HEAD * cos, y: end.y - MAP_ARROW_HEAD * sin };
  const half = MAP_ARROW_HEAD / 2;
  for (const line of group.querySelectorAll("line")) {
    line.setAttribute("x1", start.x);
    line.setAttribute("y1", start.y);
    line.setAttribute("x2", line.classList.contains("hit") ? end.x : base.x + cos);
    line.setAttribute("y2", line.classList.contains("hit") ? end.y : base.y + sin);
  }
  group.querySelector(".head").setAttribute("d",
    `M${end.x},${end.y} L${base.x + half * sin},${base.y - half * cos} L${base.x - half * sin},${base.y + half * cos} Z`);
}

function updateMapArrowElement(group, arrow) {
  const from = mapBoxRect(arrow.from_id);
  const to = mapBoxRect(arrow.to_id);
  group.style.display = from && to ? "" : "none";
  if (!from || !to) return;
  shapeMapArrow(group, mapEdgePoint(from, mapMiddleOf(to), 2), mapEdgePoint(to, mapMiddleOf(from), 3));
  group.classList.toggle("selected", mapSelected?.kind === "arrow" && mapSelected.id === arrow.id);
  group.classList.toggle("unmatched", ![arrow.from_id, arrow.to_id].every((id) => mapBoxMatches(findMapBox(id))));
}

function drawMapArrows() {
  syncMapChildren(mapArrowsEl, mapArrowList(), (arrow) => arrow.id, createMapArrowElement, updateMapArrowElement);
}

// Moving around the map

function mapPoint(clientX, clientY) {
  const area = mapEl.getBoundingClientRect();
  return { x: (clientX - area.left - mapView.x) / mapView.zoom, y: (clientY - area.top - mapView.y) / mapView.zoom };
}

// How far down the map the page's title (and the find box, when open) reach, so boxes are shown below them.
function mapTop() {
  const area = mapEl.getBoundingClientRect();
  const covers = [pageHeading, searchBar].filter((element) => !element.hidden);
  return Math.max(0, ...covers.map((element) => element.getBoundingClientRect().bottom - area.top)) + 16;
}

// The middle of what's on screen, below the title.
function mapMiddle() {
  const area = mapEl.getBoundingClientRect();
  return mapPoint(area.left + area.width / 2, area.top + (area.height + mapTop()) / 2);
}

function zoomMapAt(clientX, clientY, zoom) {
  const area = mapEl.getBoundingClientRect();
  const to = mapClamp(zoom, MAP_ZOOM_MIN, MAP_ZOOM_MAX);
  const [x, y] = [clientX - area.left, clientY - area.top];
  mapView = { x: x - (x - mapView.x) * (to / mapView.zoom), y: y - (y - mapView.y) * (to / mapView.zoom), zoom: to };
  placeMap();
  saveMapView();
}

function zoomMapBy(factor) {
  const area = mapEl.getBoundingClientRect();
  zoomMapAt(area.left + area.width / 2, area.top + (area.height + mapTop()) / 2, mapView.zoom * factor);
}

// Every box in view, no nearer than full size.
function showWholeMap() {
  const area = mapEl.getBoundingClientRect();
  const top = mapTop();
  const rects = mapBoxes().map((box) => mapBoxRect(box.id)).filter(Boolean);
  if (!rects.length) {
    mapView = { x: Math.round(area.width / 2), y: Math.round((area.height + top) / 2), zoom: 1 };
  } else {
    const left = Math.min(...rects.map((rect) => rect.x));
    const upper = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
    const room = { w: area.width - 2 * MAP_MARGIN, h: area.height - top - MAP_MARGIN };
    const zoom = mapClamp(Math.min(room.w / (right - left), room.h / (bottom - upper)), MAP_ZOOM_MIN, 1);
    mapView = {
      x: Math.round(area.width / 2 - ((left + right) / 2) * zoom),
      y: Math.round(top + room.h / 2 - ((upper + bottom) / 2) * zoom),
      zoom,
    };
  }
  placeMap();
  saveMapView();
}

// Brings a box on screen, if it's off it.
function revealMapBox(id) {
  const rect = mapBoxRect(id);
  if (!rect) return;
  const area = mapEl.getBoundingClientRect();
  const top = mapTop();
  const { x, y, zoom } = mapView;
  const [left, upper] = [rect.x * zoom + x, rect.y * zoom + y];
  const [right, bottom] = [left + Math.max(rect.w, MAP_NEW_BOX.w) * zoom, upper + Math.max(rect.h, MAP_NEW_BOX.h) * zoom];
  const dx = left < MAP_MARGIN ? MAP_MARGIN - left : right > area.width - MAP_MARGIN ? area.width - MAP_MARGIN - right : 0;
  const dy = upper < top ? top - upper : bottom > area.height - MAP_MARGIN ? area.height - MAP_MARGIN - bottom : 0;
  if (!dx && !dy) return;
  mapView = { x: x + dx, y: y + dy, zoom };
  placeMap();
  saveMapView();
}

// Changing the map

function selectMapItem(kind, id) {
  mapSelected = id ? { kind, id } : null;
  renderMap();
}

const cleanMapText = (text) => text.replace(/ /g, " ").trim().split("\n").map((line) => line.trim()).join("\n");

function editingMapBox() {
  return mapBoxesEl.querySelector(".map-box.editing");
}

function editMapBox(id, point) {
  const current = editingMapBox();
  if (current && current.dataset.key !== id) finishMapEdit(current, true);
  const element = mapBoxElement(id);
  if (!element || element.classList.contains("editing")) return;
  mapSelected = { kind: "box", id };
  renderMap();
  element.classList.add("editing");
  const text = element.querySelector(".map-text");
  text.contentEditable = "plaintext-only";
  text.focus();
  const range = point && document.caretRangeFromPoint?.(point.x, point.y);
  const selection = getSelection();
  if (range && text.contains(range.startContainer)) {
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    selection.selectAllChildren(text);
    selection.collapseToEnd();
  }
}

// Saving keeps what was written; emptying a box deletes it.
function finishMapEdit(element, save) {
  if (!element.classList.contains("editing")) return;
  element.classList.remove("editing");
  const text = element.querySelector(".map-text");
  const written = cleanMapText(text.innerText);
  text.removeAttribute("contenteditable");
  getSelection().removeAllRanges();
  const id = element.dataset.key;
  if (mapDraft?.box.id === id) {
    const { box, arrow } = mapDraft;
    mapDraft = null;
    if (save && written) {
      box.text = written;
      mapData.boxes.push(box);
      mapWrite("POST", "/api/map/boxes", box);
      if (arrow) {
        mapData.arrows.push(arrow);
        mapWrite("POST", "/api/map/arrows", arrow);
      }
    } else if (mapSelected?.id === id) {
      mapSelected = null;
    }
  } else {
    const box = findMapBox(id);
    if (box && save && written && written !== box.text) {
      box.text = written;
      mapWrite("PATCH", `/api/map/boxes/${id}`, { text: written });
    } else if (box && save && !written) {
      deleteMapBox(box);
    }
    text.textContent = findMapBox(id)?.text ?? "";
  }
  renderMap();
}

// A box's note: a large card over most of the map, below the title, opened with a right-click, for
// details about it. It saves as it's written, and closes with Esc, its ×, or a click on the map.
function openMapNote(id) {
  closeMapNote();
  const box = mapData.boxes.find((other) => other.id === id);
  if (!box) return;
  mapNoteFor = id;
  mapNoteTitle.textContent = box.text;
  mapNoteText.value = box.notes ?? "";
  mapNote.style.top = `${mapTop()}px`;
  mapNote.hidden = false;
  mapNoteText.scrollTop = 0;
  selectMapItem("box", id);
  mapNoteText.focus({ preventScroll: true });
  mapNoteText.setSelectionRange(mapNoteText.value.length, mapNoteText.value.length);
}

function saveMapNote() {
  clearTimeout(mapNoteTimer);
  const box = mapNoteFor && findMapBox(mapNoteFor);
  if (!box) return;
  const notes = mapNoteText.value.split("\n").map((line) => line.trimEnd()).join("\n").replace(/^\n+|\n+$/g, "");
  if (notes === (box.notes ?? "")) return;
  box.notes = notes;
  mapWrite("PATCH", `/api/map/boxes/${box.id}`, { notes });
  renderMap();
}

function closeMapNote() {
  if (!mapNoteFor) return;
  saveMapNote();
  mapNoteFor = null;
  mapNote.hidden = true;
  if (document.activeElement === mapNoteText) mapNoteText.blur();
  renderMap();
}

mapNoteText.addEventListener("input", () => {
  clearTimeout(mapNoteTimer);
  mapNoteTimer = setTimeout(saveMapNote, MAP_NOTE_SAVE_MS);
});

// Enter starts a new line; Esc or ⌘ Enter closes the note, keeping what's written.
mapNoteText.addEventListener("keydown", (event) => {
  if (event.isComposing || !(event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey)))) return;
  event.preventDefault();
  event.stopPropagation();
  closeMapNote();
});

// Pressing anywhere else closes it; switching to another app leaves it open.
mapNoteText.addEventListener("blur", () => {
  if (document.hasFocus()) closeMapNote();
});
mapNoteClose.addEventListener("click", () => closeMapNote());

// A new box, written straight away, and joined to the box `from` when given.
function startMapBox(x, y, from = null) {
  const current = editingMapBox();
  if (current) finishMapEdit(current, true);
  const box = { id: crypto.randomUUID(), text: "", x: Math.round(x), y: Math.round(y) };
  mapDraft = { box, arrow: from && findMapBox(from) ? { id: crypto.randomUUID(), from_id: from, to_id: box.id } : null };
  renderMap();
  revealMapBox(box.id);
  editMapBox(box.id);
}

// Joined boxes go to the right of the box they come from, one under another.
function addJoinedMapBox(from) {
  const rect = mapBoxRect(from);
  if (!rect) return;
  const taken = mapBoxes().filter((box) => box.id !== from).map((box) => mapBoxRect(box.id)).filter(Boolean);
  const x = rect.x + rect.w + MAP_JOINED_GAP;
  let y = rect.y;
  const overlaps = (other) => x < other.x + other.w + 12 && x + MAP_NEW_BOX.w + 12 > other.x && y < other.y + other.h + 12 && y + MAP_NEW_BOX.h + 12 > other.y;
  while (taken.some(overlaps)) y += MAP_NEW_BOX.h + 16;
  startMapBox(x, y, from);
}

function joinMapBoxes(from, to) {
  if (from === to || mapJoined(from, to) || mapDraft?.box.id === from || mapDraft?.box.id === to) return;
  const arrow = { id: crypto.randomUUID(), from_id: from, to_id: to };
  mapData.arrows.push(arrow);
  mapWrite("POST", "/api/map/arrows", arrow);
  renderMap();
}

function deleteMapBox(box) {
  const arrows = mapData.arrows.filter((arrow) => arrow.from_id === box.id || arrow.to_id === box.id);
  mapData.boxes = mapData.boxes.filter((other) => other !== box);
  mapData.arrows = mapData.arrows.filter((arrow) => !arrows.includes(arrow));
  mapWrite("PATCH", `/api/map/boxes/${box.id}`, { deleted: true });
  renderMap();
  showToast("Deleted", {
    action: "Undo",
    onAction: () => {
      mapData.boxes.push(box);
      mapData.arrows.push(...arrows);
      mapWrite("PATCH", `/api/map/boxes/${box.id}`, { deleted: false });
      renderMap();
    },
  });
}

function deleteMapArrow(arrow) {
  mapData.arrows = mapData.arrows.filter((other) => other !== arrow);
  mapWrite("PATCH", `/api/map/arrows/${arrow.id}`, { deleted: true });
  renderMap();
  showToast("Deleted arrow", {
    action: "Undo",
    onAction: () => {
      mapData.arrows.push(arrow);
      mapWrite("PATCH", `/api/map/arrows/${arrow.id}`, { deleted: false });
      renderMap();
    },
  });
}

// Keys, while nothing is being written; app.js sends them here in Roadmap.
function mapKey(event) {
  const box = mapSelected?.kind === "box" ? findMapBox(mapSelected.id) : null;
  const arrow = mapSelected?.kind === "arrow" ? findMapArrow(mapSelected.id) : null;
  if (event.key === "n") {
    event.preventDefault();
    const at = mapMiddle();
    startMapBox(at.x - MAP_NEW_BOX.w / 2, at.y - MAP_NEW_BOX.h / 2);
  } else if (box && (event.key === "Enter" || event.key === "e")) {
    event.preventDefault();
    editMapBox(box.id);
  } else if (box && event.key === "Tab") {
    event.preventDefault();
    addJoinedMapBox(box.id);
  } else if ((box || arrow) && (event.key === "Backspace" || event.key === "Delete")) {
    event.preventDefault();
    if (box) deleteMapBox(box);
    else deleteMapArrow(arrow);
  }
}

// Esc puts away the selection first.
function clearMapSelection() {
  if (!mapSelected) return false;
  selectMapItem(null);
  return true;
}

// Writing in a box: Enter saves, Shift-Enter starts a new line, Tab saves and adds a box joined to
// it, and Esc puts the text back as it was.
mapBoxesEl.addEventListener("keydown", (event) => {
  const element = event.target.closest(".map-box.editing");
  if (!element || event.isComposing) return;
  if (!((event.key === "Enter" && !event.shiftKey) || event.key === "Escape" || event.key === "Tab")) return;
  event.preventDefault();
  event.stopPropagation();
  const id = element.dataset.key;
  finishMapEdit(element, event.key !== "Escape");
  if (!findMapBox(id)) return;
  if (event.key === "Tab") addJoinedMapBox(id);
  else selectMapItem("box", id);
});

mapBoxesEl.addEventListener("focusout", (event) => {
  // Switching to another app keeps the box open, so writing carries on when you come back.
  if (!document.hasFocus()) return;
  const element = event.target.closest(".map-box.editing");
  if (element) finishMapEdit(element, true);
});

// A box grows as it's written in, and its arrows keep to its edges.
mapBoxesEl.addEventListener("input", () => drawMapArrows());

// Pressing on the map

mapEl.addEventListener("pointerdown", (event) => {
  mapNoteAtPress = mapNoteFor;
  // Presses in the note stay there; only its text takes the keyboard, so the note stays open.
  if (event.target.closest(".map-note")) {
    if (event.target !== mapNoteText) event.preventDefault();
    return;
  }
  // ⌃-click is a right-click on a Mac.
  if (event.button !== 0 || event.ctrlKey || mapGesture) return;
  const handle = event.target.closest(".map-handle");
  const boxEl = event.target.closest(".map-box");
  // The box being written takes its own presses, to place the caret or select text.
  if (boxEl?.classList.contains("editing")) return;
  // Anything else ends writing, and keeps the keyboard off the box's dot. An open note keeps it, so
  // dragging the map or a box leaves the note open; a click closes it, when let go.
  event.preventDefault();
  if (document.activeElement !== mapNoteText) document.activeElement?.blur();
  const start = { x: event.clientX, y: event.clientY };
  const arrowEl = event.target.closest(".map-arrow");
  if (handle && findMapBox(boxEl.dataset.key)) {
    mapGesture = { kind: "join", from: boxEl.dataset.key, start, moved: false };
  } else if (boxEl && findMapBox(boxEl.dataset.key)) {
    const box = findMapBox(boxEl.dataset.key);
    mapGesture = { kind: "move", id: box.id, start, at: { x: box.x, y: box.y }, origin: { x: box.x, y: box.y }, moved: false,
      wasSelected: mapSelected?.kind === "box" && mapSelected.id === box.id };
    selectMapItem("box", box.id);
  } else if (arrowEl) {
    closeMapNote();
    selectMapItem("arrow", arrowEl.dataset.key);
    return;
  } else {
    mapGesture = { kind: "pan", start, origin: { x: mapView.x, y: mapView.y }, moved: false };
    mapEl.classList.add("panning");
  }
  mapEl.setPointerCapture(event.pointerId);
});

function mapBoxUnder(event, except) {
  const element = document.elementFromPoint(event.clientX, event.clientY)?.closest(".map-box");
  return element && element.dataset.key !== except && !element.classList.contains("editing") ? element : null;
}

mapEl.addEventListener("pointermove", (event) => {
  if (!mapGesture) return;
  const dx = event.clientX - mapGesture.start.x;
  const dy = event.clientY - mapGesture.start.y;
  if (!mapGesture.moved && Math.hypot(dx, dy) < MAP_DRAG_PX) return;
  mapGesture.moved = true;
  if (mapGesture.kind === "pan") {
    mapView = { ...mapView, x: mapGesture.origin.x + dx, y: mapGesture.origin.y + dy };
    placeMap();
  } else if (mapGesture.kind === "move") {
    mapGesture.at = { x: Math.round(mapGesture.origin.x + dx / mapView.zoom), y: Math.round(mapGesture.origin.y + dy / mapView.zoom) };
    const element = mapBoxElement(mapGesture.id);
    element.style.left = `${mapGesture.at.x}px`;
    element.style.top = `${mapGesture.at.y}px`;
    drawMapArrows();
  } else {
    const target = mapBoxUnder(event, mapGesture.from);
    mapBoxesEl.querySelectorAll(".drop-target").forEach((element) => element !== target && element.classList.remove("drop-target"));
    target?.classList.add("drop-target");
    const from = mapBoxRect(mapGesture.from);
    const end = target ? mapEdgePoint(mapBoxRect(target.dataset.key), mapMiddleOf(from), 3) : mapPoint(event.clientX, event.clientY);
    mapPending.style.display = "";
    shapeMapArrow(mapPending, mapEdgePoint(from, end, 2), end);
  }
});

mapEl.addEventListener("pointerup", (event) => {
  const done = mapGesture;
  mapGesture = null;
  mapEl.classList.remove("panning");
  if (!done) return;
  if (!done.moved) closeMapNote();
  if (done.kind === "pan") {
    if (done.moved) saveMapView();
    else selectMapItem(null);
  } else if (done.kind === "move") {
    const box = findMapBox(done.id);
    if (done.moved && box) {
      Object.assign(box, done.at);
      mapWrite("PATCH", `/api/map/boxes/${box.id}`, done.at);
      renderMap();
    } else if (done.wasSelected) {
      // A click on the selected box starts writing in it, where it was clicked.
      editMapBox(done.id, { x: event.clientX, y: event.clientY });
    }
  } else {
    const target = mapBoxUnder(event, done.from);
    mapPending.style.display = "none";
    mapBoxesEl.querySelectorAll(".drop-target").forEach((element) => element.classList.remove("drop-target"));
    if (!done.moved) {
      addJoinedMapBox(done.from);
    } else if (target) {
      joinMapBoxes(done.from, target.dataset.key);
    } else {
      // Let go on empty space: a new box there, joined to the first.
      const at = mapPoint(event.clientX, event.clientY);
      startMapBox(at.x - MAP_NEW_BOX.w / 2, at.y - MAP_NEW_BOX.h / 2, done.from);
    }
  }
});

mapEl.addEventListener("pointercancel", () => {
  mapGesture = null;
  mapEl.classList.remove("panning");
  mapPending.style.display = "none";
  renderMap();
});

mapEl.addEventListener("dblclick", (event) => {
  // The map holds on to the pointer while pressed, so the event comes from it rather than what's under it.
  const under = document.elementFromPoint(event.clientX, event.clientY);
  const boxEl = under?.closest(".map-box");
  // In text being written, or the note, a double-click selects a word.
  if (event.target.closest(".map-note") || under?.closest("[contenteditable], .map-note")) return;
  if (boxEl) {
    if (findMapBox(boxEl.dataset.key)) editMapBox(boxEl.dataset.key, { x: event.clientX, y: event.clientY });
    return;
  }
  if (under?.closest(".map-arrow, .page-heading, .search-bar")) return;
  const at = mapPoint(event.clientX, event.clientY);
  startMapBox(at.x - MAP_NEW_BOX.w / 2, at.y - MAP_NEW_BOX.h / 2);
});

// Right-clicking a box opens its note, or closes it if it's open. Text being written, and the note,
// keep the usual menu, for spelling and the like.
mapEl.addEventListener("contextmenu", (event) => {
  const boxEl = event.target.closest(".map-box");
  const wasOpen = mapNoteAtPress;
  mapNoteAtPress = null;
  if (!boxEl || event.target.closest("[contenteditable]") || !mapData.boxes.some((box) => box.id === boxEl.dataset.key)) return;
  event.preventDefault();
  if (wasOpen === boxEl.dataset.key) closeMapNote();
  else openMapNote(boxEl.dataset.key);
});

// Two fingers on a trackpad move the map, and pinching zooms; so do a mouse's wheel, and the wheel with ⌃.
mapEl.addEventListener("wheel", (event) => {
  // A long note scrolls; pinching over it still zooms the map.
  if (event.target.closest(".map-note") && !event.ctrlKey) return;
  event.preventDefault();
  const scale = event.deltaMode === 1 ? 16 : 1;
  if (event.ctrlKey) {
    if (!mapPinchFrom) zoomMapAt(event.clientX, event.clientY, mapView.zoom * Math.exp(-event.deltaY * scale * 0.01));
    return;
  }
  mapView = { ...mapView, x: mapView.x - event.deltaX * scale, y: mapView.y - event.deltaY * scale };
  placeMap();
  saveMapView();
}, { passive: false });

// Safari and Zetesis's Mac app tell of a pinch as a gesture of its own.
mapEl.addEventListener("gesturestart", (event) => {
  event.preventDefault();
  mapPinchFrom = mapView.zoom;
});
mapEl.addEventListener("gesturechange", (event) => {
  event.preventDefault();
  if (mapPinchFrom) zoomMapAt(event.clientX, event.clientY, mapPinchFrom * event.scale);
});
mapEl.addEventListener("gestureend", (event) => {
  event.preventDefault();
  mapPinchFrom = null;
});

document.getElementById("map-out").addEventListener("click", () => zoomMapBy(1 / 1.25));
document.getElementById("map-in").addEventListener("click", () => zoomMapBy(1.25));
document.getElementById("map-all").addEventListener("click", showWholeMap);
// Zooming with the buttons leaves an open note open, as pinching does.
for (const id of ["map-out", "map-in", "map-all"]) document.getElementById(id).addEventListener("mousedown", (event) => event.preventDefault());
