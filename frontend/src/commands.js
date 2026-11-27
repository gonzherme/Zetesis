import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { foldedSectionAt, foldedSectionMove } from "./folding.js";

// Block types offered by the slash menu and the block handle's "Turn into".
// `apply` receives a chain whose selection already covers the target text.
export const BLOCK_TYPES = [
  { id: "paragraph", title: "Text", icon: "¶", keywords: "paragraph plain body", apply: (chain) => chain.setParagraph() },
  { id: "heading1", title: "Heading 1", icon: "H1", keywords: "title h1 large", apply: (chain) => chain.setHeading({ level: 1 }) },
  { id: "heading2", title: "Heading 2", icon: "H2", keywords: "subtitle h2 medium", apply: (chain) => chain.setHeading({ level: 2 }) },
  { id: "heading3", title: "Heading 3", icon: "H3", keywords: "h3 small", apply: (chain) => chain.setHeading({ level: 3 }) },
  { id: "bulletList", title: "Bulleted list", icon: "•", keywords: "unordered ul bullets", apply: (chain) => chain.toggleBulletList() },
  { id: "orderedList", title: "Numbered list", icon: "1.", keywords: "ordered ol numbers", apply: (chain) => chain.toggleOrderedList() },
  { id: "taskList", title: "Checklist", icon: "☑", keywords: "todo task checkbox", apply: (chain) => chain.toggleTaskList() },
  { id: "blockquote", title: "Quote", icon: "❝", keywords: "blockquote citation", apply: (chain) => chain.setBlockquote() },
  { id: "definition", title: "Definition", icon: "≡", keywords: "callout term glossary meaning", apply: (chain) => chain.wrapIn("callout", { kind: "definition" }) },
  { id: "callout", title: "Callout", icon: "!", keywords: "note tip warning aside box", apply: (chain) => chain.wrapIn("callout", { kind: "note" }) },
  { id: "codeBlock", title: "Code", icon: "</>", keywords: "pre snippet program", apply: (chain) => chain.setCodeBlock() },
];

const LIST_ITEM_TYPES = new Set(["listItem", "taskItem"]);
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
// Below the last block, the pointer is only "on" it within this distance.
const MAX_BLOCK_DISTANCE = 32;

// The child of `parent` (content starting at `start`) on the pointer's row:
// the one whose box spans `y`, else the nearest. Returns { pos, node, distance }.
function childAtHeight(view, parent, start, y) {
  let nearest = null;
  let passed = false;
  parent.forEach((node, offset) => {
    if (passed) return;
    const pos = start + offset;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    const distance = y < rect.top ? rect.top - y : Math.max(0, y - rect.bottom);
    if (!nearest || distance < nearest.distance) nearest = { pos, node, distance };
    // Siblings are stacked top to bottom, so later ones are further away.
    passed = rect.top > y;
  });
  return nearest;
}

// A list inside `node` (a list item, callout or quote) spanning the pointer's
// row leads to the innermost list item there.
function nestedListItem(view, node, pos, y) {
  let found = null;
  node.forEach((child, offset) => {
    if (found || !LIST_TYPES.has(child.type.name)) return;
    const childPos = pos + 1 + offset;
    const dom = view.nodeDOM(childPos);
    if (!(dom instanceof HTMLElement)) return;
    const rect = dom.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) found = listItemAt(view, child, childPos, y);
  });
  return found;
}

function listItemAt(view, list, pos, y) {
  const item = childAtHeight(view, list, pos + 1, y);
  return item && (nestedListItem(view, item.node, item.pos, y) || item);
}

// Find the block on the pointer's row: the innermost list item, otherwise the
// top-level block. Only the height counts, so the answer is the same over the
// text, a bullet, or the margin where the handle sits. (Asking the browser
// what is under the pointer gives the whole list when over a bullet.)
// Returns { pos, node } where pos is the position before the block.
export function blockAtCoords(view, coords) {
  const y = coords.top;
  const block = childAtHeight(view, view.state.doc, 0, y);
  if (!block || block.distance > MAX_BLOCK_DISTANCE) return null;
  let target = block;
  if (LIST_TYPES.has(block.node.type.name)) target = listItemAt(view, block.node, block.pos, y);
  else if (!block.node.isTextblock && !block.node.isAtom) target = nestedListItem(view, block.node, block.pos, y) || block;
  return target && { pos: target.pos, node: target.node };
}

// Re-resolve a remembered target against the current document.
export function currentTarget(editor, target) {
  if (!target) return null;
  const node = editor.state.doc.nodeAt(target.pos);
  return node && node.type === target.node.type ? { pos: target.pos, node } : null;
}

function selectTargetText(tr, target) {
  const { pos, node } = target;
  if (node.isTextblock) {
    return tr.setSelection(TextSelection.create(tr.doc, pos + 1, pos + 1 + node.content.size));
  }
  const $from = tr.doc.resolve(pos + 1);
  const $to = tr.doc.resolve(pos + node.nodeSize - 1);
  return tr.setSelection(TextSelection.between($from, $to));
}

export function canTurnInto(target) {
  return Boolean(target) && !target.node.isAtom && target.node.type.name !== "table";
}

export function turnInto(editor, target, type) {
  const current = currentTarget(editor, target);
  if (!current || !canTurnInto(current)) return false;
  if (current.node.type.name === "callout" && (type.id === "definition" || type.id === "callout")) {
    const kind = type.id === "definition" ? "definition" : "note";
    return editor.chain().focus().command(({ tr }) => {
      tr.setNodeMarkup(current.pos, undefined, { ...current.node.attrs, kind });
      return true;
    }).run();
  }
  return type.apply(
    editor.chain().focus().command(({ tr }) => {
      selectTargetText(tr, current);
      return true;
    }).clearNodes(),
  ).run();
}

export function setCalloutKind(editor, target, kind) {
  const current = currentTarget(editor, target);
  if (!current || current.node.type.name !== "callout") return false;
  return editor.chain().focus().command(({ tr }) => {
    tr.setNodeMarkup(current.pos, undefined, { ...current.node.attrs, kind });
    return true;
  }).run();
}

export function deleteBlock(editor, target) {
  const current = currentTarget(editor, target);
  if (!current) return false;
  const $pos = editor.state.doc.resolve(current.pos);
  let from = current.pos;
  let to = current.pos + current.node.nodeSize;
  // Removing the only item of a list removes the list itself.
  if (LIST_ITEM_TYPES.has(current.node.type.name) && $pos.parent.childCount === 1) {
    from = $pos.before();
    to = $pos.after();
  }
  return editor.chain().focus().command(({ tr }) => {
    tr.delete(from, to);
    const $near = tr.doc.resolve(Math.min(from, tr.doc.content.size));
    tr.setSelection(TextSelection.near($near));
    return true;
  }).run();
}

export function duplicateBlock(editor, target) {
  const current = currentTarget(editor, target);
  if (!current) return false;
  const after = current.pos + current.node.nodeSize;
  return editor.chain().focus().command(({ tr }) => {
    // UniqueID gives the copy (and its children) fresh block IDs.
    tr.insert(after, current.node);
    tr.setSelection(NodeSelection.create(tr.doc, after));
    return true;
  }).run();
}

export function moveBlock(editor, target, direction) {
  const current = currentTarget(editor, target);
  if (!current) return false;
  const { pos, node } = current;
  // A folded heading moves with all it hides, past whole sections.
  const section = foldedSectionMove(editor.state, pos, direction);
  if (section) {
    return editor.chain().focus().command(({ tr }) => {
      const content = tr.doc.slice(section.from, section.to).content;
      // Moving down, the place to land shifts up by what was taken out.
      const destination = section.insertAt > section.from ? section.insertAt - (section.to - section.from) : section.insertAt;
      tr.delete(section.from, section.to).insert(destination, content);
      tr.setSelection(NodeSelection.create(tr.doc, destination));
      tr.scrollIntoView();
      return true;
    }).run();
  }
  if (foldedSectionAt(editor.state, pos)) return false;
  const $pos = editor.state.doc.resolve(pos);
  const index = $pos.index();
  const parent = $pos.parent;
  if (direction < 0 && index === 0) return false;
  if (direction > 0 && index >= parent.childCount - 1) return false;
  return editor.chain().focus().command(({ tr }) => {
    let destination;
    if (direction < 0) {
      destination = pos - parent.child(index - 1).nodeSize;
      tr.delete(pos, pos + node.nodeSize).insert(destination, node);
    } else {
      destination = pos + parent.child(index + 1).nodeSize;
      tr.delete(pos, pos + node.nodeSize).insert(destination, node);
    }
    tr.setSelection(NodeSelection.create(tr.doc, destination));
    tr.scrollIntoView();
    return true;
  }).run();
}

// Insert an empty block after the target and open the slash menu in it.
export function insertBlockAfter(editor, target) {
  const current = currentTarget(editor, target);
  if (!current) return false;
  const { schema } = editor.state;
  const after = current.pos + current.node.nodeSize;
  const isItem = LIST_ITEM_TYPES.has(current.node.type.name);
  const node = isItem
    ? current.node.type.create(null, schema.nodes.paragraph.create())
    : schema.nodes.paragraph.create();
  return editor.chain().focus().command(({ tr }) => {
    tr.insert(after, node);
    tr.setSelection(TextSelection.create(tr.doc, after + (isItem ? 2 : 1)));
    tr.scrollIntoView();
    return true;
  }).insertContent("/").run();
}
