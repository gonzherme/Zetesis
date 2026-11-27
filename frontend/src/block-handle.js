import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import { blockAtCoords, currentTarget } from "./commands.js";
import { foldedSectionAt } from "./folding.js";

const LIST_ITEM_TYPES = new Set(["listItem", "taskItem"]);
// A folded heading being dragged, by its ID: it moves with all it hides.
const sectionDrags = new WeakMap();

// Drops a dragged folded section where it was let go, whole. A copy (⌥-drag)
// is left to ProseMirror, which inserts the whole slice anyway.
function dropSection(view, event, slice, moved) {
  const id = sectionDrags.get(view);
  sectionDrags.delete(view);
  if (!id || !moved) return false;
  let section = null;
  view.state.doc.forEach((node, pos) => {
    if (node.attrs.id === id) section = foldedSectionAt(view.state, pos);
  });
  const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
  // Without both, ProseMirror would move only the heading and copy the rest.
  if (!section || !point) return true;
  const insertAt = dropPoint(view.state.doc, point.pos, slice) ?? point.pos;
  if (insertAt >= section.from && insertAt <= section.to) return true;
  const tr = view.state.tr.delete(section.from, section.to);
  const pos = tr.mapping.map(insertAt);
  tr.insert(pos, slice.content);
  tr.setSelection(NodeSelection.create(tr.doc, pos));
  view.dispatch(tr);
  view.focus();
  return true;
}
// How far left of the editor box the margin zone reaches; the handle sits there.
const HOVER_GUTTER = 72;

// A handle beside each block, shown only while the pointer is in the margin
// left of the block's text (never over the text itself): "+" inserts a block
// below, and the grip opens the block menu on click or reorders the block when
// dragged.
export const BlockHandle = Extension.create({
  name: "blockHandle",

  addOptions() {
    return {
      container: null,
      scrollContainer: null,
      onOpenMenu: null,
      onInsert: null,
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    return [
      new Plugin({
        key: new PluginKey("blockHandle"),
        view: (view) => new BlockHandleView(view, editor, options),
        props: { handleDrop: dropSection },
      }),
    ];
  },
});

class BlockHandleView {
  constructor(view, editor, options) {
    this.view = view;
    this.editor = editor;
    this.options = options;
    this.container = options.container;
    this.target = null;
    this.dragging = false;
    this.locked = false;
    // A press on the handle keeps it in place: the pointer may cross onto the
    // text before the browser starts the drag, and hiding would cancel it.
    this.pressed = false;

    this.element = document.createElement("div");
    this.element.className = "zx-block-handle";
    this.element.hidden = true;

    this.insertButton = document.createElement("button");
    this.insertButton.type = "button";
    this.insertButton.className = "zx-handle-insert";
    this.insertButton.textContent = "+";
    this.insertButton.title = "Add a block below";
    this.insertButton.setAttribute("aria-label", "Add a block below");

    this.grip = document.createElement("button");
    this.grip.type = "button";
    this.grip.className = "zx-handle-grip";
    this.grip.draggable = true;
    this.grip.title = "Drag to move · click for options";
    this.grip.setAttribute("aria-label", "Block options");
    this.grip.innerHTML = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>';

    this.element.append(this.insertButton, this.grip);
    this.container.append(this.element);

    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseUp = () => {
      this.pressed = false;
    };
    this.onKeyDown = () => this.hide();
    this.view.dom.ownerDocument.addEventListener("mousemove", this.onMouseMove, { passive: true });
    this.view.dom.ownerDocument.addEventListener("mouseup", this.onMouseUp);
    this.element.addEventListener("mousedown", () => {
      this.pressed = true;
    });
    this.view.dom.addEventListener("keydown", this.onKeyDown);
    options.scrollContainer?.addEventListener("scroll", this.onKeyDown, { passive: true });

    this.insertButton.addEventListener("click", () => {
      const target = currentTarget(this.editor, this.target);
      if (target) this.options.onInsert?.(target);
      this.hide();
    });
    this.grip.addEventListener("click", () => {
      const target = currentTarget(this.editor, this.target);
      if (!target) return;
      this.locked = true;
      this.options.onOpenMenu?.(target, this.grip, () => {
        this.locked = false;
        this.hide();
      });
    });
    this.grip.addEventListener("dragstart", (event) => this.onDragStart(event));
    this.grip.addEventListener("dragend", () => this.onDragEnd());
  }

  onMouseMove(event) {
    if (!this.editor.isEditable || this.dragging || this.locked || this.pressed) return;
    const over = event.target;
    if (!(over instanceof Node)) return;
    if (this.element.contains(over)) return;
    const bounds = this.view.dom.getBoundingClientRect();
    const inZone = event.clientX >= bounds.left - HOVER_GUTTER
      && event.clientY >= bounds.top && event.clientY <= bounds.bottom
      // Not over something covering the note, such as the sticky toolbar or a menu.
      && (this.container.contains(over) || over.contains(this.container));
    const target = inZone ? blockAtCoords(this.view, { left: event.clientX, top: event.clientY }) : null;
    const dom = target && this.view.nodeDOM(target.pos);
    // Left of the block's box is margin: for a list item that includes its bullet.
    if (!(dom instanceof HTMLElement) || event.clientX >= dom.getBoundingClientRect().left) {
      this.hide();
      return;
    }
    this.show(target);
  }

  show(target) {
    const dom = this.view.nodeDOM(target.pos);
    if (!(dom instanceof HTMLElement)) {
      this.hide();
      return;
    }
    this.target = target;
    this.element.hidden = false;
    const rect = dom.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const style = window.getComputedStyle(dom);
    const lineHeight = parseFloat(style.lineHeight) || 24;
    const firstLine = Math.min(rect.height, lineHeight) + (parseFloat(style.paddingTop) || 0);
    const top = rect.top - containerRect.top + Math.max(0, (firstLine - 24) / 2);
    // Clear of a list item's bullet, or a heading's fold arrow.
    const gap = LIST_ITEM_TYPES.has(target.node.type.name) ? 24 : dom.classList.contains("zx-foldable") ? 28 : 6;
    const left = rect.left - containerRect.left - this.element.offsetWidth - gap;
    this.element.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  hide() {
    if (this.locked || this.dragging) return;
    this.element.hidden = true;
    this.target = null;
  }

  onDragStart(event) {
    const target = currentTarget(this.editor, this.target);
    if (!target || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    const { view } = this;
    const selection = NodeSelection.create(view.state.doc, target.pos);
    view.dispatch(view.state.tr.setSelection(selection));
    // A folded heading takes what it hides along (see dropSection).
    const section = foldedSectionAt(view.state, target.pos);
    const slice = section ? view.state.doc.slice(section.from, section.to) : selection.content();
    if (section) sectionDrags.set(view, section.id);
    else sectionDrags.delete(view);
    const { dom, text } = view.serializeForClipboard(slice);
    event.dataTransfer.clearData();
    event.dataTransfer.setData("text/html", dom.innerHTML);
    event.dataTransfer.setData("text/plain", text);
    event.dataTransfer.effectAllowed = "copyMove";
    const blockDom = view.nodeDOM(target.pos);
    if (blockDom instanceof HTMLElement) event.dataTransfer.setDragImage(blockDom, 0, 0);
    // ProseMirror's drop handler moves the dragged slice when view.dragging is set.
    view.dragging = { slice, move: true, node: selection };
    this.dragging = true;
    this.element.classList.add("is-dragging");
  }

  onDragEnd() {
    this.dragging = false;
    this.pressed = false;
    this.element.classList.remove("is-dragging");
    const { view } = this;
    window.setTimeout(() => {
      if (view.dragging?.slice) view.dragging = null;
      sectionDrags.delete(view);
    }, 50);
    this.hide();
  }

  update(view, previousState) {
    if (previousState && !previousState.doc.eq(view.state.doc) && !this.locked) this.hide();
  }

  destroy() {
    this.view.dom.ownerDocument.removeEventListener("mousemove", this.onMouseMove);
    this.view.dom.ownerDocument.removeEventListener("mouseup", this.onMouseUp);
    this.view.dom.removeEventListener("keydown", this.onKeyDown);
    this.options.scrollContainer?.removeEventListener("scroll", this.onKeyDown);
    this.element.remove();
  }
}
