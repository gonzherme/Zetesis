import { Extension } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { WidthHandle } from "./image-view.js";
import { embedProvider } from "./schema.js";

// Video links (YouTube, Vimeo, Instagram) can be watched in the note. A ▶ after the link
// shows it as a player; the player's "Show as link" puts the link back. A
// line that is only the link turns into the player (keeping the link's words
// as its label); a link inside a sentence stays put and gets its player
// below the line, where the ▶ takes it away again.

const videoLinksKey = new PluginKey("videoLinks");

// The links in a textblock whose content starts at `start`: [{ from, to, href }].
// Neighbouring text with the same link (say, half of it bold) is one link.
function linksIn(block, start) {
  const links = [];
  block.forEach((child, offset) => {
    const link = child.marks.find((mark) => mark.type.name === "link");
    const from = start + offset;
    const last = links[links.length - 1];
    if (link && last && last.to === from && last.mark.eq(link)) last.to = from + child.nodeSize;
    else if (link) links.push({ from, to: from + child.nodeSize, href: link.attrs.href, mark: link });
  });
  return links;
}

// The embeds right after child `index` of `parent` (starting at `pos`): [{ pos, node }].
function playersAfter(parent, index, pos) {
  const players = [];
  for (let i = index + 1; i < parent.childCount && parent.child(i).type.name === "embed"; i += 1) {
    players.push({ pos, node: parent.child(i) });
    pos += parent.child(i).nodeSize;
  }
  return players;
}

// Links put back from a player remember its width for the next time it's shown.
function keepPlayerWidth(tr, links, width) {
  for (const link of links) {
    if ((link.mark.attrs.playerWidth ?? null) === width) continue;
    tr.addMark(link.from, link.to, link.mark.type.create({ ...link.mark.attrs, playerWidth: width }));
  }
}

// The ▶ after the video link ending at `pos`: shows it as a player, or, when
// its player is already below the line, takes that away.
function toggleLinkPlayer(view, pos) {
  const { state } = view;
  const $pos = state.doc.resolve(pos);
  const block = $pos.parent;
  const link = linksIn(block, $pos.start()).find((range) => range.to === pos && embedProvider(range.href));
  if (!link || $pos.depth === 0) return false;
  const container = $pos.node(-1);
  const index = $pos.index(-1);
  const blockEnd = $pos.after();
  const players = playersAfter(container, index, blockEnd);
  const tr = state.tr;
  const open = players.find((player) => player.node.attrs.url === link.href);
  if (open) {
    tr.delete(open.pos, open.pos + open.node.nodeSize);
    keepPlayerWidth(tr, [link], open.node.attrs.width);
  } else {
    const words = state.doc.textBetween(link.from, link.to).trim();
    const embed = state.schema.nodes.embed.create({
      url: link.href,
      label: words && words !== link.href ? words : null,
      width: link.mark.attrs.playerWidth ?? null,
    });
    if (block.type.name === "paragraph" && block.textContent.trim() === words
      && container.canReplaceWith(index, index + 1, embed.type)) {
      tr.replaceWith($pos.before(), blockEnd, embed);
    } else {
      const after = players.length ? players[players.length - 1].pos + players[players.length - 1].node.nodeSize : blockEnd;
      if (!container.canReplaceWith(index + 1 + players.length, index + 1 + players.length, embed.type)) return false;
      tr.insert(after, embed);
    }
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

// "Show as link" on the embed at `pos`. Below a line with its link, the player
// just goes; otherwise it becomes a line with the link. Either way the link
// keeps the player's width.
function showAsLink(view, pos) {
  const { state } = view;
  const node = state.doc.nodeAt(pos);
  if (node?.type.name !== "embed") return false;
  const { url, label, width } = node.attrs;
  const $pos = state.doc.resolve(pos);
  let index = $pos.index();
  let before = $pos.pos;
  while (index > 0 && $pos.parent.child(index - 1).type.name === "embed") {
    index -= 1;
    before -= $pos.parent.child(index).nodeSize;
  }
  const line = index > 0 ? $pos.parent.child(index - 1) : null;
  const links = line?.isTextblock ? linksIn(line, before - line.nodeSize + 1).filter((link) => link.href === url) : [];
  const tr = state.tr;
  if (links.length) {
    tr.delete(pos, pos + node.nodeSize);
    keepPlayerWidth(tr, links, width);
  } else {
    const { schema } = state;
    const text = schema.text(label || url, [schema.marks.link.create({ href: url, playerWidth: width })]);
    tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.paragraph.create(null, text));
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

function playButton(open) {
  return (view, getPos) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `zx-play-link${open ? " is-open" : ""}`;
    button.title = open ? "Hide the player" : "Play here";
    button.setAttribute("aria-label", open ? "Hide the player" : "Show as player");
    button.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5v7l5.5-3.5z"/></svg>';
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = getPos();
      if (typeof pos === "number" && view.editable) toggleLinkPlayer(view, pos);
    });
    return button;
  };
}

function playButtons(doc) {
  const widgets = [];
  doc.descendants((node, pos, parent, index) => {
    if (!node.isTextblock) return true;
    const players = parent ? playersAfter(parent, index, pos + node.nodeSize) : [];
    for (const link of linksIn(node, pos + 1)) {
      if (!embedProvider(link.href)) continue;
      const open = players.some((player) => player.node.attrs.url === link.href);
      widgets.push(Decoration.widget(link.to, playButton(open), {
        side: -1,
        marks: [],
        key: `play:${open}:${link.href}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, widgets);
}

// YouTube refuses some videos (music, mostly) inside a page at a bare IP
// address such as 127.0.0.1, where Zetesis usually runs, but plays them for
// localhost. There, a YouTube player goes through static/player.html at
// localhost: the same server, under a name YouTube accepts.
function playerSource(provider) {
  const { protocol, hostname, port } = window.location;
  if (provider.name !== "YouTube" || (hostname !== "127.0.0.1" && hostname !== "[::1]")) return provider.src;
  return `${protocol}//localhost${port ? `:${port}` : ""}/static/player.html?src=${encodeURIComponent(provider.src)}`;
}

// Embeds drawn as the schema renders them, plus "Show as link" and, on a
// player, a width handle (double-click it for the full width again).
class EmbedView {
  constructor(node, view, getPos) {
    this.node = node;
    this.dom = DOMSerializer.renderSpec(document, node.type.spec.toDOM(node)).dom;
    const provider = embedProvider(node.attrs.url);
    const frame = this.dom.querySelector("iframe");
    // Not yet in the page, so only the new address loads.
    if (provider) frame.src = playerSource(provider);
    // An Instagram post is as tall as Instagram says, and says again when
    // its width changes. Like Instagram's own embed code, its frame doesn't scroll.
    if (provider?.name === "Instagram") {
      frame.setAttribute("scrolling", "no");
      this.onMessage = (event) => {
        if (event.source !== frame.contentWindow || event.origin !== "https://www.instagram.com") return;
        let message = event.data;
        try {
          if (typeof message === "string") message = JSON.parse(message);
        } catch {
          return;
        }
        const height = message?.type === "MEASURE" ? Number(message.details?.height) : 0;
        if (height > 0) frame.style.height = `${Math.ceil(height)}px`;
      };
      window.addEventListener("message", this.onMessage);
    }
    this.toggle = document.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "block-embed-toggle";
    this.toggle.textContent = "Show as link";
    this.toggle.addEventListener("mousedown", (event) => event.preventDefault());
    this.toggle.addEventListener("click", () => {
      const pos = getPos();
      if (typeof pos === "number" && view.editable) showAsLink(view, pos);
    });
    this.dom.append(this.toggle);
    if (provider) {
      const instagram = provider.name === "Instagram";
      this.handle = new WidthHandle({
        view,
        getPos,
        getNode: () => this.node,
        frame: this.dom,
        sized: this.dom,
        minWidth: 200,
        // Instagram draws its posts at most 540px wide.
        maxWidth: instagram ? 540 : Infinity,
        title: `Drag to resize · double-click for ${instagram ? "the original size" : "full width"}`,
        restore: () => this.showWidth(),
      });
      this.dom.append(this.handle.element);
    }
  }

  // The stored width, drawn as the schema renders it.
  showWidth() {
    const { width } = this.node.attrs;
    this.dom.style.width = width ? `${width}px` : "";
    if (width) this.dom.dataset.width = width;
    else delete this.dom.dataset.width;
  }

  // A new width resizes the player where it is; anything else redraws it
  // (and reloads the player).
  update(node) {
    if (node.type !== this.node.type) return false;
    if (Object.keys(node.attrs).some((name) => name !== "width" && node.attrs[name] !== this.node.attrs[name])) return false;
    this.node = node;
    if (!this.handle?.resizing) this.showWidth();
    return true;
  }

  stopEvent(event) {
    return (event.target instanceof Node && this.toggle.contains(event.target)) || Boolean(this.handle?.contains(event));
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    this.handle?.destroy();
    if (this.onMessage) window.removeEventListener("message", this.onMessage);
  }
}

export const VideoLinks = Extension.create({
  name: "videoLinks",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: videoLinksKey,
        state: {
          init: (_, state) => playButtons(state.doc),
          apply: (tr, buttons) => (tr.docChanged ? playButtons(tr.doc) : buttons),
        },
        props: {
          decorations: (state) => (editor.isEditable ? videoLinksKey.getState(state) : null),
          nodeViews: {
            embed: (node, view, getPos) => new EmbedView(node, view, getPos),
          },
        },
      }),
    ];
  },
});
