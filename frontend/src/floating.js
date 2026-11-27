import { computePosition, flip, offset, shift } from "@floating-ui/dom";

// ↓/↑, or ⌃N/⌃P as in macOS text and Zetesis' lists: 1, -1, or 0.
export function menuStep(event) {
  if (event.metaKey || event.altKey) return 0;
  if (event.ctrlKey) return { n: 1, p: -1 }[event.key.toLowerCase()] ?? 0;
  return { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? 0;
}

// Notes open in a modal <dialog>, which sits in the browser's top layer.
// Menus must live inside it or they render underneath the dialog.
export function overlayRootFor(element) {
  return element.closest("dialog") || document.body;
}

export function rectReference(getRect) {
  return { getBoundingClientRect: () => getRect() || new DOMRect() };
}

export function placeFloating(reference, floating, placement = "bottom-start") {
  return computePosition(reference, floating, {
    strategy: "fixed",
    placement,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  }).then(({ x, y }) => {
    floating.style.left = `${x}px`;
    floating.style.top = `${y}px`;
  });
}

export function matchesQuery(item, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${item.title} ${item.keywords || ""} ${item.description || ""}`.toLowerCase();
  return needle.split(/\s+/).every((term) => haystack.includes(term));
}

// A keyboard-navigable list of choices, optionally with its own search input.
export class FloatingList {
  constructor({ root, className = "", searchPlaceholder = null, emptyText = "No results", onSelect, onClose }) {
    this.onSelect = onSelect;
    this.onClose = onClose;
    this.emptyText = emptyText;
    this.items = [];
    this.index = 0;
    this.reference = null;
    this.placement = "bottom-start";

    this.element = document.createElement("div");
    this.element.className = `zx-menu ${className}`.trim();
    this.element.hidden = true;
    this.element.addEventListener("mousedown", (event) => {
      if (event.target !== this.input) event.preventDefault();
    });

    if (searchPlaceholder !== null) {
      this.input = document.createElement("input");
      this.input.type = "text";
      this.input.className = "zx-menu-search";
      this.input.placeholder = searchPlaceholder;
      this.input.addEventListener("keydown", (event) => {
        if (this.onKeyDown(event)) event.preventDefault();
        event.stopPropagation();
      });
      this.element.append(this.input);
    }

    this.list = document.createElement("div");
    this.list.className = "zx-menu-items";
    this.list.setAttribute("role", "listbox");
    this.element.append(this.list);
    root.append(this.element);
  }

  get visible() {
    return !this.element.hidden;
  }

  show(reference, items, placement = "bottom-start") {
    this.reference = reference;
    this.placement = placement;
    this.element.hidden = false;
    this.setItems(items);
    if (this.input) {
      this.input.value = "";
      this.input.focus();
    }
  }

  setItems(items) {
    this.items = items;
    this.index = 0;
    this.render();
    this.position();
  }

  position() {
    if (this.reference && this.visible) placeFloating(this.reference, this.element, this.placement);
  }

  render() {
    this.list.replaceChildren();
    if (!this.items.length) {
      const empty = document.createElement("div");
      empty.className = "zx-menu-empty";
      empty.textContent = this.emptyText;
      this.list.append(empty);
      return;
    }
    let section = null;
    this.items.forEach((item, index) => {
      if (item.section && item.section !== section) {
        section = item.section;
        const heading = document.createElement("div");
        heading.className = "zx-menu-section";
        heading.textContent = section;
        this.list.append(heading);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "zx-menu-item";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === this.index));
      if (item.danger) button.classList.add("danger");
      if (item.icon !== undefined) {
        const icon = document.createElement("span");
        icon.className = "zx-menu-icon";
        icon.textContent = item.icon;
        button.append(icon);
      }
      const copy = document.createElement("span");
      copy.className = "zx-menu-copy";
      const title = document.createElement("span");
      title.className = "zx-menu-title";
      title.textContent = item.title;
      copy.append(title);
      if (item.description) {
        const description = document.createElement("span");
        description.className = "zx-menu-description";
        description.textContent = item.description;
        copy.append(description);
      }
      button.append(copy);
      button.addEventListener("mouseenter", () => this.highlight(index));
      button.addEventListener("click", () => this.select(index));
      this.list.append(button);
    });
  }

  highlight(index) {
    this.index = index;
    for (const [position, button] of [...this.list.querySelectorAll(".zx-menu-item")].entries()) {
      button.setAttribute("aria-selected", String(position === index));
      if (position === index) button.scrollIntoView({ block: "nearest" });
    }
  }

  select(index = this.index) {
    const item = this.items[index];
    if (item) this.onSelect(item);
  }

  onKeyDown(event) {
    if (!this.visible) return false;
    const step = menuStep(event);
    if (step === 1 || (event.key === "Tab" && !event.shiftKey)) {
      if (this.items.length) this.highlight((this.index + 1) % this.items.length);
      return true;
    }
    if (step === -1 || (event.key === "Tab" && event.shiftKey)) {
      if (this.items.length) this.highlight((this.index + this.items.length - 1) % this.items.length);
      return true;
    }
    if (event.key === "Enter") {
      this.select();
      return true;
    }
    if (event.key === "Escape") {
      this.hide();
      this.onClose?.();
      return true;
    }
    return false;
  }

  hide() {
    this.element.hidden = true;
    this.reference = null;
  }

  destroy() {
    this.element.remove();
  }
}

// A one-off searchable picker (PDF notes, link targets) that closes on choice.
export function openPicker({ root, reference, searchPlaceholder, emptyText, items, onSelect, onClose }) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("mousedown", outside, true);
    picker.destroy();
    onClose?.();
  };
  const picker = new FloatingList({
    root,
    className: "zx-picker",
    searchPlaceholder,
    emptyText,
    onSelect: (item) => {
      close();
      onSelect(item);
    },
    onClose: close,
  });
  const filtered = (query) => items.filter((item) => matchesQuery(item, query)).slice(0, 50);
  picker.input.addEventListener("input", () => picker.setItems(filtered(picker.input.value)));
  const outside = (event) => {
    if (!picker.element.contains(event.target)) close();
  };
  document.addEventListener("mousedown", outside, true);
  picker.show(reference, filtered(""));
  return close;
}
