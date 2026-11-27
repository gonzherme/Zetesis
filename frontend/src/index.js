// Entry point of the Zetesis block editor bundle (static/editor/zetesis-editor.js).
// The app uses it through the global `ZetesisEditor.createNoteEditor(...)`.
import { Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BlockHandle } from "./block-handle.js";
import {
  BLOCK_TYPES, canTurnInto, deleteBlock, duplicateBlock, insertBlockAfter, moveBlock, setCalloutKind, turnInto,
} from "./commands.js";
import { FloatingList, openPicker, overlayRootFor, rectReference } from "./floating.js";
import { Folding } from "./folding.js";
import { ImageResize } from "./image-view.js";
import { Outline } from "./outline.js";
import { BODY_FORMAT_VERSION, CALLOUT_KINDS, isHttpUrl, schemaExtensions } from "./schema.js";
import { SlashCommands } from "./slash-menu.js";
import { createSelectionToolbar, TableToolbar } from "./toolbars.js";
import { hasActiveUploads, Uploads } from "./uploads.js";
import { VideoLinks } from "./video-links.js";

export { BODY_FORMAT_VERSION };

function caretRect(editor) {
  const { from } = editor.state.selection;
  const coords = editor.view.coordsAtPos(from);
  return new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top);
}

function openHref(href, onOpenNote) {
  let url;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return;
  }
  if (url.origin === window.location.origin && url.pathname === "/" && url.searchParams.has("note")) {
    onOpenNote?.(url.searchParams.get("note"));
    return;
  }
  window.open(url.href, "_blank", "noopener,noreferrer");
}

// Links open on click (internal note links inside Zetesis, others in a new
// tab) unless the click finishes a text selection.
const LinkClicks = Extension.create({
  name: "linkClicks",

  addOptions() {
    return { onOpenNote: null };
  },

  addProseMirrorPlugins() {
    const { onOpenNote } = this.options;
    return [
      new Plugin({
        key: new PluginKey("linkClicks"),
        props: {
          handleDOMEvents: {
            click(view, event) {
              if (event.button !== 0) return false;
              const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
              if (!anchor || !view.dom.contains(anchor)) return false;
              const selection = window.getSelection();
              if (selection && !selection.isCollapsed && anchor.contains(selection.anchorNode)) return false;
              event.preventDefault();
              openHref(anchor.getAttribute("href"), onOpenNote);
              return true;
            },
          },
        },
      }),
    ];
  },
});

const EMPTY_NOTE_PROMPT = "Write, or type “/” for blocks";

// Empty headings and callouts would otherwise look like blank lines.
function placeholderText(node, parent) {
  if (node.type.name === "heading") return `Heading ${node.attrs.level}`;
  if (node.type.name !== "paragraph" || parent.type.name !== "callout") return "";
  return parent.attrs.kind === "definition" ? "Term — what it means" : "Write a callout…";
}

function hint(pos, node, text) {
  return Decoration.node(pos, pos + node.nodeSize, { class: "is-empty", "data-placeholder": text });
}

// Hint text: a prompt in an empty note, and a label on the empty heading or
// callout holding the cursor. Empty lines in a note get no hint. Rebuilt on
// every state, so a hint never lingers on a block the cursor has left
// (Tiptap's incremental Placeholder leaves them behind with includeChildren).
const Placeholders = Extension.create({
  name: "placeholders",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("placeholders"),
        props: {
          decorations(state) {
            if (!editor.isEditable) return null;
            const only = state.doc.childCount === 1 ? state.doc.firstChild : null;
            if (only?.type.name === "paragraph" && !only.childCount) {
              return DecorationSet.create(state.doc, [hint(0, only, EMPTY_NOTE_PROMPT)]);
            }
            const { empty, $from } = state.selection;
            const node = $from.parent;
            if (!empty || $from.depth === 0 || !node.isTextblock || node.childCount) return null;
            const text = placeholderText(node, $from.node($from.depth - 1));
            return text ? DecorationSet.create(state.doc, [hint($from.before(), node, text)]) : null;
          },
        },
      }),
    ];
  },
});

export function createNoteEditor({
  element,
  content,
  scrollContainer = null,
  editable = true,
  onChange = null,
  onOpenNote = null,
  onEscape = null,
  onNotice = null,
  // Asks for a line of text in the app ({ title, message, value, placeholder,
  // confirmLabel }); resolves with it, or null when cancelled.
  askText = null,
  uploadFile = null,
  findNotes = null,
  listPdfNotes = null,
  // Block IDs of the folded headings, and where changes to them go.
  folded = [],
  onFoldChange = null,
  // Where to draw the note's outline (its headings), beside the note.
  outline = null,
}) {
  const root = overlayRootFor(element);
  element.classList.add("zx-editor");
  let contentError = null;
  let editor = null;

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  element.append(fileInput);
  fileInput.addEventListener("change", () => {
    const files = [...fileInput.files];
    fileInput.value = "";
    if (files.length) editor.chain().focus().uploadFiles(files).run();
  });

  const pickFiles = (accept) => {
    if (!uploadFile) {
      onNotice?.("Uploads are not available.");
      return;
    }
    fileInput.accept = accept || "";
    fileInput.click();
  };

  const pickPdf = () => {
    const items = (listPdfNotes?.() || []).map((note) => ({
      id: note.path,
      title: note.title,
      description: note.meta || "",
      keywords: note.path,
    }));
    openPicker({
      root,
      reference: rectReference(() => caretRect(editor)),
      searchPlaceholder: "Find a PDF in Zetesis",
      emptyText: "No PDFs found",
      items,
      onSelect: (item) => {
        editor.chain().focus().insertContent({
          type: "fileBlock",
          attrs: { notePath: item.id, name: item.title, mimeType: "application/pdf" },
        }).run();
      },
      onClose: () => editor.commands.focus(),
    });
  };

  const promptEmbed = async () => {
    const question = {
      title: "Embed a link",
      message: "Paste a YouTube or Vimeo link, or any web page.",
      value: "https://",
      placeholder: "https://",
      confirmLabel: "Embed",
    };
    const value = askText
      ? await askText(question)
      : window.prompt(`${question.title}: ${question.message}`, question.value);
    if (value === null) return;
    const url = value.trim();
    if (!isHttpUrl(url) || url === "https://") {
      onNotice?.("Embeds need a full http(s) link.");
      return;
    }
    editor.chain().focus().insertContent({ type: "embed", attrs: { url } }).run();
  };

  const slashItems = () => [
    ...BLOCK_TYPES.map((type) => ({
      ...type,
      section: "Blocks",
      run: (instance, range) => type.apply(instance.chain().focus().deleteRange(range)).run(),
    })),
    {
      id: "divider", section: "Blocks", title: "Divider", icon: "—", keywords: "rule line separator hr",
      run: (instance, range) => instance.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      id: "table", section: "Blocks", title: "Table", icon: "▦", keywords: "grid rows columns",
      run: (instance, range) => instance.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      id: "image", section: "Media", title: "Image", icon: "▣", description: "Upload, paste, or drop an image", keywords: "picture photo screenshot",
      run: (instance, range) => {
        instance.chain().focus().deleteRange(range).run();
        pickFiles("image/*");
      },
    },
    {
      id: "file", section: "Media", title: "File", icon: "⎘", description: "Upload a PDF or other file", keywords: "attachment upload document",
      run: (instance, range) => {
        instance.chain().focus().deleteRange(range).run();
        pickFiles("");
      },
    },
    {
      id: "pdf", section: "Media", title: "PDF from library", icon: "PDF", description: "Link a PDF already in Zetesis", keywords: "book paper attachment",
      run: (instance, range) => {
        instance.chain().focus().deleteRange(range).run();
        pickPdf();
      },
    },
    {
      id: "embed", section: "Media", title: "Embed link", icon: "↗", description: "YouTube, Vimeo, or a web page", keywords: "video url bookmark iframe",
      run: (instance, range) => {
        instance.chain().focus().deleteRange(range).run();
        promptEmbed();
      },
    },
  ];

  let blockMenu = null;
  const openBlockMenu = (target, anchor, onClose) => {
    blockMenu?.destroy();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("mousedown", outside, true);
      blockMenu?.destroy();
      blockMenu = null;
      onClose();
    };
    const outside = (event) => {
      if (!blockMenu?.element.contains(event.target)) close();
    };
    const items = [];
    if (canTurnInto(target)) {
      for (const type of BLOCK_TYPES) {
        items.push({ ...type, section: "Turn into", action: () => turnInto(editor, target, type) });
      }
    }
    if (target.node.type.name === "callout") {
      for (const [kind, label] of Object.entries(CALLOUT_KINDS)) {
        if (kind === target.node.attrs.kind) continue;
        items.push({ id: `callout-${kind}`, section: "Callout style", title: label, icon: "◧", action: () => setCalloutKind(editor, target, kind) });
      }
    }
    items.push(
      { id: "insert", section: "Actions", title: "Add block below", icon: "+", action: () => insertBlockAfter(editor, target) },
      { id: "duplicate", section: "Actions", title: "Duplicate", icon: "⧉", action: () => duplicateBlock(editor, target) },
      { id: "up", section: "Actions", title: "Move up", icon: "↑", action: () => moveBlock(editor, target, -1) },
      { id: "down", section: "Actions", title: "Move down", icon: "↓", action: () => moveBlock(editor, target, 1) },
      { id: "delete", section: "Actions", title: "Delete", icon: "×", danger: true, action: () => deleteBlock(editor, target) },
    );
    blockMenu = new FloatingList({
      root,
      className: "zx-block-menu",
      onSelect: (item) => {
        close();
        item.action();
      },
      onClose: close,
    });
    blockMenu.element.tabIndex = -1;
    blockMenu.element.addEventListener("keydown", (event) => {
      if (blockMenu?.onKeyDown(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    blockMenu.show(anchor, items, "left-start");
    blockMenu.element.focus();
    document.addEventListener("mousedown", outside, true);
  };

  const toolbar = createSelectionToolbar({ root, scrollTarget: scrollContainer, findNotes, onNotice });

  const extensions = [
    ...schemaExtensions(),
    Placeholders,
    SlashCommands.configure({ root, scrollContainer, items: slashItems }),
    toolbar.extension,
    TableToolbar.configure({ root, scrollContainer }),
    BlockHandle.configure({
      container: element,
      scrollContainer,
      onOpenMenu: openBlockMenu,
      onInsert: (target) => insertBlockAfter(editor, target),
    }),
    Uploads.configure({ upload: uploadFile, onError: onNotice }),
    ImageResize,
    VideoLinks,
    Folding.configure({ folded, onChange: onFoldChange }),
    Outline.configure({ element: outline, scrollContainer }),
    LinkClicks.configure({ onOpenNote }),
    Extension.create({
      name: "zetesisKeymap",
      // Lowest priority: menus (slash, suggestions) handle their keys first.
      priority: 1,
      addKeyboardShortcuts: () => ({
        "Mod-k": () => toolbar.openLinkEditor(),
        // ProseMirror swallows Escape; hand it back to the app.
        Escape: () => {
          if (!onEscape) return false;
          onEscape();
          return true;
        },
      }),
    }),
  ];

  editor = new Editor({
    element,
    extensions,
    content,
    editable,
    enableContentCheck: true,
    onContentError: ({ error }) => {
      contentError = error;
    },
    editorProps: {
      attributes: {
        class: "zx-editor-content document-article",
        "aria-label": "Note body",
        spellcheck: "true",
      },
    },
    onUpdate: () => onChange?.(),
  });
  // Never let an editor that silently dropped invalid content save over the note.
  if (contentError) editor.setEditable(false);
  toolbar.attach(editor);

  return {
    editor,
    contentError,
    getJSON: () => editor.getJSON(),
    focus: (position = "start") => {
      // Tiptap's focus command waits a frame; take DOM focus now so keys
      // typed immediately afterwards (e.g. right after Enter in the title)
      // land in the body.
      editor.view.focus();
      return editor.commands.focus(position);
    },
    hasPendingUploads: () => hasActiveUploads(editor),
    setEditable: (value) => editor.setEditable(value && !contentError),
    destroy() {
      blockMenu?.destroy();
      toolbar.destroy();
      editor.destroy();
      element.replaceChildren();
      element.classList.remove("zx-editor");
    },
  };
}
