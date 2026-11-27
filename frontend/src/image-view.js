import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";

// A handle on a block's right edge: drag it to resize `sized`, double-click it
// to return to the original size. The width is stored on the block.
// `restore` redraws the block from its stored width after a cancelled drag.
export class WidthHandle {
  constructor({ view, getPos, getNode, frame, sized, minWidth, maxWidth = Infinity, title, restore }) {
    Object.assign(this, { view, getPos, getNode, frame, sized, minWidth, maxWidth, restore });
    this.resizing = null;

    this.element = document.createElement("span");
    this.element.className = "block-resize";
    this.element.title = title;

    this.element.addEventListener("pointerdown", (event) => this.start(event));
    // Keep the frame's own drag (moving the block) from starting on the handle.
    this.element.addEventListener("mousedown", (event) => event.preventDefault());
    frame.addEventListener("dragstart", (event) => {
      if (this.resizing || this.element.contains(event.target)) event.preventDefault();
    });
    this.element.addEventListener("dblclick", (event) => {
      event.preventDefault();
      if (this.view.editable && this.getNode().attrs.width) this.setWidth(null);
    });
  }

  start(event) {
    if (!this.view.editable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const parent = this.frame.parentElement;
    const style = parent ? window.getComputedStyle(parent) : null;
    const available = parent
      ? parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      : Infinity;
    const startX = event.clientX;
    const startWidth = this.sized.getBoundingClientRect().width;
    let width = Math.round(startWidth);

    const move = (moveEvent) => {
      width = Math.round(Math.min(available, this.maxWidth, Math.max(this.minWidth, startWidth + moveEvent.clientX - startX)));
      this.sized.style.width = `${width}px`;
    };
    const finish = (commit) => {
      this.element.removeEventListener("pointermove", move);
      this.element.removeEventListener("pointerup", end);
      this.element.removeEventListener("pointercancel", cancel);
      this.resizing = null;
      this.frame.classList.remove("is-resizing");
      if (commit && width !== Math.round(startWidth)) this.setWidth(width);
      else this.restore();
    };
    const end = () => finish(true);
    const cancel = () => finish(false);

    this.resizing = cancel;
    this.frame.classList.add("is-resizing");
    this.element.setPointerCapture(event.pointerId);
    this.element.addEventListener("pointermove", move);
    this.element.addEventListener("pointerup", end);
    this.element.addEventListener("pointercancel", cancel);
  }

  // Leaves the block selected and the editor focused, so ⌘Z undoes the resize.
  setWidth(width) {
    const pos = this.getPos();
    if (typeof pos !== "number") return;
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.getNode().attrs, width });
    this.view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
    this.view.focus();
  }

  contains(event) {
    return event.target instanceof Node && this.element.contains(event.target);
  }

  destroy() {
    this.resizing?.();
  }
}

// Images get a width handle; double-clicking it returns to the original size.
class ImageView {
  constructor(node, view, getPos) {
    this.node = node;

    this.dom = document.createElement("div");
    this.dom.className = "block-image-frame";
    this.dom.contentEditable = "false";
    this.dom.draggable = true;

    this.img = document.createElement("img");

    this.handle = new WidthHandle({
      view,
      getPos,
      getNode: () => this.node,
      frame: this.dom,
      sized: this.img,
      minWidth: 48,
      title: "Drag to resize · double-click for original size",
      restore: () => this.render(),
    });

    this.dom.append(this.img, this.handle.element);
    this.render();
  }

  // The <img> carries exactly what the schema renders (src, width, id, data-*).
  render() {
    const [, attrs] = this.node.type.spec.toDOM(this.node);
    for (const name of this.img.getAttributeNames()) {
      if (attrs[name] == null) this.img.removeAttribute(name);
    }
    for (const [name, value] of Object.entries(attrs)) {
      if (value != null && this.img.getAttribute(name) !== String(value)) this.img.setAttribute(name, value);
    }
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.handle.resizing) this.render();
    return true;
  }

  stopEvent(event) {
    return this.handle.contains(event);
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.handle.destroy();
  }
}

export const ImageResize = Extension.create({
  name: "imageResize",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("imageResize"),
        props: {
          nodeViews: {
            image: (node, view, getPos) => new ImageView(node, view, getPos),
          },
        },
      }),
    ];
  },
});
