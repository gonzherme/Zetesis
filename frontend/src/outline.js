import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { foldingKey, isFoldedAway, revealPos } from "./folding.js";

// A note's outline, in `element` beside it: its headings as a tree (a heading
// sits under the nearest one before it of a higher level). Clicking one
// scrolls to it, unfolding its section first if it's folded away; the
// section being read is marked as the note scrolls. It shows once the note
// has two headings.

export const Outline = Extension.create({
  name: "outline",

  addOptions() {
    return {
      element: null,
      scrollContainer: null,
    };
  },

  addProseMirrorPlugins() {
    const { element, scrollContainer } = this.options;
    if (!element || !scrollContainer) return [];
    return [
      new Plugin({
        key: new PluginKey("outline"),
        view: (view) => new OutlineView(view, element, scrollContainer),
      }),
    ];
  },
});

// How far below the top of the note a heading counts as the one being read
// (clear of the sticky toolbar).
const READING_LINE = 110;

class OutlineView {
  constructor(view, element, scroller) {
    this.view = view;
    this.element = element;
    this.scroller = scroller;
    this.entries = [];
    this.active = null;
    // A clicked heading stays marked while the note scrolls to it, until the
    // reader scrolls on their own.
    this.pinned = null;

    const label = document.createElement("p");
    label.className = "note-outline-label";
    label.textContent = "Outline";
    this.list = document.createElement("ol");
    element.replaceChildren(label, this.list);

    this.list.addEventListener("click", (event) => {
      const item = event.target instanceof Element ? event.target.closest(".note-outline-item") : null;
      if (item) this.go(item.dataset.id);
    });
    this.onScroll = () => {
      if (this.frame) return;
      this.frame = window.requestAnimationFrame(() => {
        this.frame = 0;
        this.markActive();
      });
    };
    this.unpin = () => {
      this.pinned = null;
    };
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      scroller.addEventListener(type, this.unpin, { passive: true });
    }
    this.render();
  }

  update(view, previousState) {
    // The folding state changes with every edit to the note and every fold.
    if (foldingKey.getState(view.state) === foldingKey.getState(previousState)) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 120);
  }

  render() {
    const { state } = this.view;
    const levels = [];
    this.entries = [];
    for (const section of foldingKey.getState(state).sections) {
      while (levels.length && levels[levels.length - 1] >= section.level) levels.pop();
      const depth = levels.length;
      levels.push(section.level);
      const text = state.doc.nodeAt(section.pos)?.textContent.trim();
      if (!text || !section.id) continue;
      this.entries.push({ id: section.id, pos: section.pos, depth, text, away: isFoldedAway(state, section.pos) });
    }
    this.element.hidden = this.entries.length < 2;
    this.list.replaceChildren(...this.entries.map((entry) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `note-outline-item${entry.away ? " is-folded-away" : ""}`;
      button.dataset.id = entry.id;
      button.style.setProperty("--depth", entry.depth);
      button.textContent = entry.text;
      button.title = entry.away ? `${entry.text} (in a folded section)` : entry.text;
      entry.button = button;
      item.append(button);
      return item;
    }));
    this.active = null;
    this.markActive();
  }

  headingDom(entry) {
    const dom = this.view.nodeDOM(entry.pos);
    return dom instanceof HTMLElement && !dom.closest("[hidden]") ? dom : null;
  }

  go(id) {
    // Positions may have moved since the outline was drawn.
    const section = foldingKey.getState(this.view.state).sections.find((candidate) => candidate.id === id);
    if (!section) return;
    revealPos(this.view, section.pos);
    const dom = this.view.nodeDOM(section.pos);
    if (!(dom instanceof HTMLElement)) return;
    this.pinned = id;
    this.setActive(id);
    dom.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  markActive() {
    if (this.pinned) {
      this.setActive(this.pinned);
      return;
    }
    const line = this.scroller.getBoundingClientRect().top + READING_LINE;
    let current = null;
    for (const entry of this.entries) {
      const dom = this.headingDom(entry);
      if (!dom) continue;
      if (dom.getBoundingClientRect().top > line) break;
      current = entry.id;
    }
    this.setActive(current);
  }

  setActive(id) {
    if (id === this.active) return;
    this.active = id;
    for (const entry of this.entries) entry.button.classList.toggle("is-active", entry.id === id);
    // Keep the marked heading in sight in a long outline.
    const button = this.entries.find((entry) => entry.id === id)?.button;
    if (!button) return;
    const { offsetTop: top, offsetHeight: height } = button;
    if (top < this.element.scrollTop) this.element.scrollTop = top - 8;
    else if (top + height > this.element.scrollTop + this.element.clientHeight) {
      this.element.scrollTop = top + height - this.element.clientHeight + 8;
    }
  }

  destroy() {
    window.clearTimeout(this.timer);
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.scroller.removeEventListener("scroll", this.onScroll);
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      this.scroller.removeEventListener(type, this.unpin);
    }
    this.element.replaceChildren();
    this.element.hidden = true;
  }
}
