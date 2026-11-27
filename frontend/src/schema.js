// The editor extensions below define the Zetesis note body schema. Any change
// to node names, attributes, or content rules must be mirrored in blocks.py
// (the server-side validator) and must bump BODY_FORMAT_VERSION.
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import Highlight from "@tiptap/extension-highlight";
import UniqueID from "@tiptap/extension-unique-id";

export const BODY_FORMAT_VERSION = 1;

export const CALLOUT_KINDS = {
  note: "Note",
  definition: "Definition",
  tip: "Tip",
  warning: "Warning",
};

export const BLOCK_ID_TYPES = [
  "paragraph", "heading", "blockquote", "callout", "codeBlock", "rawSource",
  "horizontalRule", "bulletList", "orderedList", "taskList", "listItem", "taskItem",
  "table", "image", "fileBlock", "embed",
];

const ASSET_ID = /^[0-9a-f]{32}$/;

export function newBlockId() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value || ""));
}

// Links may point to the web, to email, or to Zetesis notes, files, and assets.
export function isAllowedHref(value) {
  const href = String(value || "").trim();
  return isHttpUrl(href)
    || /^mailto:[^\s]+$/i.test(href)
    || /^\/\?note=[^\s]+$/.test(href)
    || /^\/api\/file\?path=[^\s]+$/.test(href)
    || /^\/api\/assets\/[0-9a-f]{32}$/.test(href);
}

export function assetUrl(assetId) {
  return `/api/assets/${assetId}`;
}

export function notesFileUrl(path) {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

export function imageSource(attrs) {
  if (attrs.assetId) return assetUrl(attrs.assetId);
  if (attrs.path) return notesFileUrl(attrs.path);
  return attrs.src || "";
}

// Map URLs rendered by Zetesis back to stable references when HTML is pasted.
function referenceFromUrl(value) {
  const source = String(value || "");
  const asset = source.match(/^(?:https?:\/\/[^/]+)?\/api\/assets\/([0-9a-f]{32})(?:[?#].*)?$/);
  if (asset) return { assetId: asset[1] };
  const file = source.match(/^(?:https?:\/\/[^/]+)?\/api\/file\?path=([^&#]+)/);
  if (file) {
    try {
      return { path: decodeURIComponent(file[1]) };
    } catch {
      return null;
    }
  }
  if (isHttpUrl(source)) return { src: source };
  return null;
}

// A width in pixels set by dragging a block's resize handle (images, players).
const widthAttribute = {
  default: null,
  parseHTML: (element) => {
    const width = parseInt(element.getAttribute("data-width") || "", 10);
    return width > 0 ? width : null;
  },
  renderHTML: (attributes) => (attributes.width ? {
    "data-width": attributes.width,
    style: `width: ${attributes.width}px`,
  } : {}),
};

// A video link shown as a player and back keeps the player's width, so the
// player comes back the size it was.
const LinkPlayerWidth = Extension.create({
  name: "linkPlayerWidth",

  addGlobalAttributes() {
    return [{
      types: ["link"],
      attributes: {
        playerWidth: {
          default: null,
          parseHTML: (element) => {
            const width = parseInt(element.getAttribute("data-player-width") || "", 10);
            return width > 0 ? width : null;
          },
          renderHTML: (attributes) => (attributes.playerWidth ? { "data-player-width": attributes.playerWidth } : {}),
        },
      },
    }];
  },
});

export function embedProvider(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    let id = "";
    if (host === "youtu.be") id = parsed.pathname.slice(1);
    else if (parsed.pathname === "/watch") id = parsed.searchParams.get("v") || "";
    else id = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] || "";
    // A playlist plays from the video the link names, or from its first.
    const list = parsed.searchParams.get("list") || "";
    const playlist = /^[\w-]{10,64}$/.test(list) ? list : "";
    if (!/^[\w-]{6,20}$/.test(id)) {
      if (!playlist) return null;
      id = "videoseries";
    }
    const params = new URLSearchParams();
    if (playlist) params.set("list", playlist);
    const start = parseInt(parsed.searchParams.get("t") || parsed.searchParams.get("start") || "", 10);
    if (start > 0) params.set("start", String(start));
    const query = params.toString();
    return {
      name: "YouTube",
      src: `https://www.youtube-nocookie.com/embed/${id}${query ? `?${query}` : ""}`,
    };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = parsed.pathname.match(/(?:^|\/)(\d{4,})(?:\/|$)/)?.[1];
    if (!id) return null;
    return { name: "Vimeo", src: `https://player.vimeo.com/video/${id}` };
  }
  if (host === "instagram.com" || host === "instagr.am") {
    // Posts, reels and IGTV (/p/CODE, /reel/CODE or /reels/CODE, /tv/CODE),
    // also under the account's name (/name/p/CODE). The captioned embed, as
    // Instagram's own embed code makes it: the one without a caption reports
    // too small a height for videos, cutting off their bottom.
    const match = parsed.pathname.match(/^\/(?:[\w.]+\/)?(p|reels?|tv)\/([\w-]{5,40})(?:\/|$)/);
    if (!match) return null;
    const kind = match[1] === "reels" ? "reel" : match[1];
    return { name: "Instagram", src: `https://www.instagram.com/${kind}/${match[2]}/embed/captioned/` };
  }
  return null;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatBytes(size) {
  if (!Number.isFinite(size) || size <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "(paragraph | bulletList | orderedList | taskList | codeBlock | image)+",
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (element) => {
          const kind = element.getAttribute("data-kind");
          return kind in CALLOUT_KINDS ? kind : "note";
        },
        renderHTML: (attributes) => ({
          "data-kind": attributes.kind,
          "data-label": CALLOUT_KINDS[attributes.kind] || CALLOUT_KINDS.note,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "aside[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["aside", mergeAttributes(HTMLAttributes, { "data-callout": "", class: "block-callout" }), 0];
  },
});

// Org/Markdown source the converter could not map to a block is kept verbatim.
export const RawSource = Node.create({
  name: "rawSource",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,

  addAttributes() {
    return {
      format: {
        default: "org",
        parseHTML: (element) => (element.getAttribute("data-format") === "md" ? "md" : "org"),
        renderHTML: (attributes) => ({
          "data-format": attributes.format,
          "data-label": attributes.format === "md" ? "Markdown source" : "Org source",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "pre[data-raw-source]", preserveWhitespace: "full" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["pre", mergeAttributes(HTMLAttributes, { "data-raw-source": "", class: "block-raw-source" }), ["code", 0]];
  },
});

export const Image = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-asset-id"),
        renderHTML: (attributes) => (attributes.assetId ? { "data-asset-id": attributes.assetId } : {}),
      },
      path: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-path"),
        renderHTML: (attributes) => (attributes.path ? { "data-path": attributes.path } : {}),
      },
      src: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-src"),
        renderHTML: (attributes) => (attributes.src ? { "data-src": attributes.src } : {}),
      },
      alt: {
        default: "",
        parseHTML: (element) => element.getAttribute("alt") || "",
      },
      width: widthAttribute,
    };
  },

  parseHTML() {
    return [{
      tag: "img[src]",
      getAttrs: (element) => {
        const reference = element.hasAttribute("data-asset-id") || element.hasAttribute("data-path") || element.hasAttribute("data-src")
          ? null
          : referenceFromUrl(element.getAttribute("src"));
        if (reference) return reference;
        const assetId = element.getAttribute("data-asset-id");
        if (assetId && ASSET_ID.test(assetId)) return null;
        if (element.getAttribute("data-path") || isHttpUrl(element.getAttribute("data-src"))) return null;
        // Inline data: and blob: images are never stored in a note body.
        return false;
      },
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes, {
      class: "block-image",
      src: imageSource(node.attrs),
      loading: "lazy",
      draggable: "false",
    })];
  },
});

// A file attachment uploaded into the note, or a link to an existing PDF note.
export const FileBlock = Node.create({
  name: "fileBlock",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    const dataAttribute = (name, key) => ({
      default: null,
      parseHTML: (element) => element.getAttribute(name),
      renderHTML: (attributes) => (attributes[key] ? { [name]: attributes[key] } : {}),
    });
    return {
      assetId: dataAttribute("data-asset-id", "assetId"),
      notePath: dataAttribute("data-note-path", "notePath"),
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-name") || "",
        renderHTML: (attributes) => ({ "data-name": attributes.name }),
      },
      mimeType: dataAttribute("data-mime-type", "mimeType"),
      size: {
        default: null,
        parseHTML: (element) => {
          const size = parseInt(element.getAttribute("data-size") || "", 10);
          return size >= 0 ? size : null;
        },
        renderHTML: (attributes) => (attributes.size !== null ? { "data-size": attributes.size } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-file-block]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { assetId, notePath, name, mimeType, size } = node.attrs;
    const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(notePath || name || "");
    const href = assetId ? assetUrl(assetId) : `/?note=${encodeURIComponent(notePath || "")}`;
    const meta = notePath ? "PDF in Zetesis" : [isPdf ? "PDF" : (mimeType || "File"), formatBytes(size)].filter(Boolean).join(" · ");
    return ["div", mergeAttributes(HTMLAttributes, { "data-file-block": "", class: "block-file" }),
      ["span", { class: `block-file-icon${isPdf ? " pdf" : ""}` }, isPdf ? "PDF" : "FILE"],
      ["span", { class: "block-file-copy" },
        ["a", { class: "block-file-name", href }, name || notePath || "Attachment"],
        ["span", { class: "block-file-meta" }, meta]],
    ];
  },
});

export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-embed-url") || "",
        renderHTML: (attributes) => ({ "data-embed-url": attributes.url }),
      },
      // The words of the link it was shown from, kept for showing it as a link again.
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-embed-label"),
        renderHTML: (attributes) => (attributes.label ? { "data-embed-label": attributes.label } : {}),
      },
      width: widthAttribute,
    };
  },

  parseHTML() {
    return [{ tag: "div[data-embed-url]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { url, label } = node.attrs;
    const provider = embedProvider(url);
    if (provider) {
      return ["div", mergeAttributes(HTMLAttributes, { class: "block-embed", "data-provider": provider.name }),
        ["iframe", {
          src: provider.src,
          title: `${provider.name} embed`,
          loading: "lazy",
          allow: "fullscreen; picture-in-picture; encrypted-media",
          allowfullscreen: "true",
          referrerpolicy: "strict-origin-when-cross-origin",
          sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups",
        }],
        ["a", { class: "block-embed-caption", href: url }, label || url],
      ];
    }
    return ["div", mergeAttributes(HTMLAttributes, { class: "block-embed block-embed-link" }),
      ["a", { class: "block-embed-title", href: url }, label || hostnameOf(url)],
      ["span", { class: "block-embed-url" }, url],
    ];
  },
});

export function schemaExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        isAllowedUri: (url) => isAllowedHref(url),
        shouldAutoLink: (url) => isHttpUrl(url) || /^[\w-]+(\.[\w-]+)+/.test(url),
        HTMLAttributes: { target: null, rel: "noopener noreferrer nofollow", class: null },
      },
      dropcursor: { color: "var(--green)", width: 2 },
      trailingNode: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Highlight.configure({ multicolor: false }),
    Callout,
    RawSource,
    Image,
    FileBlock,
    Embed,
    LinkPlayerWidth,
    UniqueID.configure({
      attributeName: "id",
      types: BLOCK_ID_TYPES,
      generateID: () => newBlockId(),
    }),
  ];
}
