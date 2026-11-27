import { Extension } from "@tiptap/core";
import BubbleMenu from "@tiptap/extension-bubble-menu";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { menuStep, placeFloating } from "./floating.js";
import { isAllowedHref } from "./schema.js";

const MARK_BUTTONS = [
  { mark: "bold", label: "B", title: "Bold (⌘B)", toggle: (chain) => chain.toggleBold() },
  { mark: "italic", label: "I", title: "Italic (⌘I)", toggle: (chain) => chain.toggleItalic() },
  { mark: "underline", label: "U", title: "Underline (⌘U)", toggle: (chain) => chain.toggleUnderline() },
  { mark: "strike", label: "S", title: "Strikethrough (⌘⇧S)", toggle: (chain) => chain.toggleStrike() },
  { mark: "code", label: "</>", title: "Inline code (⌘E)", toggle: (chain) => chain.toggleCode() },
  { mark: "highlight", label: "H", title: "Highlight (⌘⇧H)", toggle: (chain) => chain.toggleHighlight() },
];

// Accept full URLs, Zetesis links, and bare domains ("example.com/page").
export function normalizeHref(value) {
  const href = String(value || "").trim();
  if (!href) return "";
  if (isAllowedHref(href)) return href;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(href)) return `https://${href}`;
  return null;
}

function button(label, title, className = "") {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.title = title;
  element.setAttribute("aria-label", title);
  element.addEventListener("mousedown", (event) => event.preventDefault());
  return element;
}

// Inline formatting toolbar shown over a text selection, with a link editor
// that accepts URLs or searches notes to link to.
export function createSelectionToolbar({ root, scrollTarget, findNotes, onNotice }) {
  let editor = null;
  let linkResults = [];
  let linkIndex = -1;

  const element = document.createElement("div");
  element.className = "zx-toolbar";
  element.setAttribute("role", "toolbar");
  element.setAttribute("aria-label", "Text formatting");

  const marks = document.createElement("div");
  marks.className = "zx-toolbar-row";
  const markButtons = MARK_BUTTONS.map((spec) => {
    const control = button(spec.label, spec.title, `zx-mark-${spec.mark}`);
    control.addEventListener("click", () => spec.toggle(editor.chain().focus()).run());
    marks.append(control);
    return [spec.mark, control];
  });
  const linkButton = button("Link", "Link (⌘K)", "zx-mark-link");
  linkButton.addEventListener("click", () => openLinkEditor());
  marks.append(linkButton);

  const linkPanel = document.createElement("div");
  linkPanel.className = "zx-link-panel";
  linkPanel.hidden = true;
  const linkInput = document.createElement("input");
  linkInput.type = "text";
  linkInput.placeholder = "Paste a link or search notes";
  linkInput.setAttribute("aria-label", "Link address or note");
  const removeLink = button("Remove", "Remove link", "zx-link-remove");
  const linkList = document.createElement("div");
  linkList.className = "zx-link-results";
  const linkRow = document.createElement("div");
  linkRow.className = "zx-toolbar-row";
  linkRow.append(linkInput, removeLink);
  linkPanel.append(linkRow, linkList);
  element.append(marks, linkPanel);

  const refresh = () => {
    if (!editor) return;
    for (const [mark, control] of markButtons) control.classList.toggle("is-active", editor.isActive(mark));
    linkButton.classList.toggle("is-active", editor.isActive("link"));
  };

  const renderResults = () => {
    linkList.replaceChildren();
    linkResults.forEach((note, index) => {
      const result = button(note.title, `Link to ${note.title}`, "zx-link-result");
      result.classList.toggle("is-active", index === linkIndex);
      const meta = document.createElement("span");
      meta.textContent = note.meta || "";
      result.append(meta);
      result.addEventListener("click", () => applyLink(`/?note=${encodeURIComponent(note.path)}`));
      linkList.append(result);
    });
  };

  const closeLinkEditor = ({ focus = true } = {}) => {
    linkPanel.hidden = true;
    marks.hidden = false;
    linkResults = [];
    linkIndex = -1;
    if (focus) editor?.commands.focus();
  };

  const applyLink = (href) => {
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    closeLinkEditor({ focus: false });
  };

  function openLinkEditor() {
    if (!editor || editor.state.selection.empty) return false;
    marks.hidden = true;
    linkPanel.hidden = false;
    linkInput.value = editor.getAttributes("link").href || "";
    removeLink.hidden = !editor.isActive("link");
    linkResults = [];
    linkIndex = -1;
    renderResults();
    linkInput.focus();
    linkInput.select();
    return true;
  }

  linkInput.addEventListener("input", () => {
    const query = linkInput.value.trim();
    linkResults = query && normalizeHref(query) === null ? (findNotes?.(query) || []).slice(0, 6) : [];
    linkIndex = linkResults.length ? 0 : -1;
    renderResults();
  });
  linkInput.addEventListener("keydown", (event) => {
    const step = menuStep(event);
    if (step) {
      if (linkResults.length) {
        linkIndex = (linkIndex + step + linkResults.length) % linkResults.length;
        renderResults();
      }
      event.preventDefault();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (linkIndex >= 0 && linkResults[linkIndex]) {
        applyLink(`/?note=${encodeURIComponent(linkResults[linkIndex].path)}`);
        return;
      }
      const href = normalizeHref(linkInput.value);
      if (href === null) {
        onNotice?.("Enter a web address, or pick a note from the list.");
        return;
      }
      applyLink(href);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeLinkEditor();
    }
  });
  removeLink.addEventListener("click", () => applyLink(""));

  const extension = BubbleMenu.configure({
    element,
    pluginKey: "selectionToolbar",
    appendTo: () => root,
    updateDelay: 120,
    shouldShow: ({ editor: current, state, from, to }) => {
      if (!linkPanel.hidden) return true;
      if (!current.isEditable || from === to || state.selection instanceof NodeSelection) return false;
      const { $from } = state.selection;
      if ($from.parent.type.spec.code) return false;
      return state.doc.textBetween(from, to, " ").trim().length > 0;
    },
    options: {
      strategy: "fixed",
      placement: "top",
      offset: 8,
      flip: true,
      shift: { padding: 8 },
      scrollTarget: scrollTarget || window,
      onHide: () => {
        if (!linkPanel.hidden) closeLinkEditor({ focus: false });
      },
    },
  });

  return {
    element,
    extension,
    openLinkEditor,
    attach(instance) {
      editor = instance;
      editor.on("transaction", refresh);
      refresh();
    },
    destroy() {
      editor?.off("transaction", refresh);
      element.remove();
    },
  };
}

// A small bar above the table under the cursor for row/column commands.
export const TableToolbar = Extension.create({
  name: "tableToolbar",

  addOptions() {
    return { root: null, scrollContainer: null };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const { root, scrollContainer } = this.options;
    return [
      new Plugin({
        key: new PluginKey("tableToolbar"),
        view: () => {
          const element = document.createElement("div");
          element.className = "zx-table-toolbar";
          element.hidden = true;
          const actions = [
            ["+ Row", "Add row below", (chain) => chain.addRowAfter()],
            ["+ Column", "Add column right", (chain) => chain.addColumnAfter()],
            ["− Row", "Delete row", (chain) => chain.deleteRow()],
            ["− Column", "Delete column", (chain) => chain.deleteColumn()],
            ["Header", "Toggle header row", (chain) => chain.toggleHeaderRow()],
            ["Delete table", "Delete table", (chain) => chain.deleteTable()],
          ];
          for (const [label, title, run] of actions) {
            const control = button(label, title);
            control.addEventListener("click", () => run(editor.chain().focus()).run());
            element.append(control);
          }
          root.append(element);

          const update = () => {
            const { selection } = editor.state;
            let tablePos = null;
            for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
              if (selection.$from.node(depth).type.name === "table") {
                tablePos = selection.$from.before(depth);
                break;
              }
            }
            const tableDom = tablePos === null ? null : editor.view.nodeDOM(tablePos);
            if (!editor.isEditable || !editor.isFocused || !(tableDom instanceof HTMLElement)) {
              element.hidden = true;
              return;
            }
            element.hidden = false;
            placeFloating(tableDom, element, "top-end");
          };
          const hideOnBlur = ({ event }) => {
            if (!event?.relatedTarget || !element.contains(event.relatedTarget)) element.hidden = true;
          };
          editor.on("focus", update);
          editor.on("blur", hideOnBlur);
          scrollContainer?.addEventListener("scroll", update, { passive: true });
          return {
            update,
            destroy: () => {
              editor.off("focus", update);
              editor.off("blur", hideOnBlur);
              scrollContainer?.removeEventListener("scroll", update);
              element.remove();
            },
          };
        },
      }),
    ];
  },
});
