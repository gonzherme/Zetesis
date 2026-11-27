import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, Selection, TextSelection, NodeSelection, AllSelection } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Sections fold: an arrow beside a heading hides what follows it, up to the
// next heading of its level or higher. Folding is a way of looking at the
// note, not part of it: the folded headings (by block ID) come in as
// `folded` and go out through `onChange`, and the note itself never changes.
//
// Folded blocks get hidden="until-found", so the browser's find still reaches
// them and unfolds their section. Content never vanishes into a fold behind
// the writer's back: an edit that leaves the cursor, or any block that was
// showing, inside a folded section unfolds it, and arrow keys step over it.

export const foldingKey = new PluginKey("folding");

// Every top-level heading's section: { id, pos, level, start, end }, where the
// heading is at `pos` and its section runs from `start` (just after it) to
// `end` (the next heading of its level or higher, or the end of the note).
function outline(doc) {
  const blocks = [];
  doc.forEach((node, pos) => blocks.push({ node, pos }));
  const sections = [];
  blocks.forEach(({ node, pos }, index) => {
    if (node.type.name !== "heading") return;
    const { level } = node.attrs;
    const closer = blocks.slice(index + 1).find((block) => block.node.type.name === "heading" && block.node.attrs.level <= level);
    sections.push({ id: node.attrs.id, pos, level, start: pos + node.nodeSize, end: closer ? closer.pos : doc.content.size });
  });
  return sections;
}

// The sections hiding something with these headings folded: the outermost
// folded ones (a fold inside a folded section is hidden along with it).
function hiddenSections(sections, folded) {
  const hidden = [];
  let hiddenUntil = -1;
  for (const section of sections) {
    if (section.pos < hiddenUntil) continue;
    if (section.id && folded.has(section.id) && section.end > section.start) {
      hidden.push(section);
      hiddenUntil = section.end;
    }
  }
  return hidden;
}

function hidingSection(hidden, pos) {
  return hidden.find((section) => pos >= section.start && pos < section.end) || null;
}

// The folded headings to open so that none of `positions` is hidden, from the
// outside in.
function foldsHiding(doc, folded, positions) {
  const sections = outline(doc);
  const opened = [];
  let current = folded;
  for (let round = 0; round < 7; round += 1) {
    const hiding = hiddenSections(sections, current).filter((section) => positions.some((pos) => hidingSection([section], pos)));
    if (!hiding.length) break;
    current = new Set(current);
    for (const section of hiding) {
      current.delete(section.id);
      opened.push(section.id);
    }
  }
  return opened;
}

function foldToggle(id, folded) {
  return (view) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zx-fold-toggle";
    button.contentEditable = "false";
    button.title = folded ? "Unfold this section" : "Fold this section";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-expanded", String(!folded));
    button.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      view.dispatch(view.state.tr.setMeta(foldingKey, { toggle: id }));
    });
    return button;
  };
}

function foldState(doc, folded) {
  const sections = outline(doc);
  const hidden = hiddenSections(sections, folded);
  const decorations = [];
  for (const section of sections) {
    if (!section.id || section.end <= section.start || hidingSection(hidden, section.pos)) continue;
    const isFolded = folded.has(section.id);
    decorations.push(
      Decoration.node(section.pos, section.start, { class: isFolded ? "zx-foldable is-folded" : "zx-foldable" }),
      Decoration.widget(section.pos + 1, foldToggle(section.id, isFolded), {
        side: -1,
        marks: [],
        key: `fold:${section.id}:${isFolded}`,
        ignoreSelection: true,
        stopEvent: () => true,
      }),
    );
  }
  for (const section of hidden) {
    doc.nodesBetween(section.start, section.end, (node, pos) => {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "zx-folded", hidden: "until-found" }));
      return false;
    });
  }
  return { folded, sections, hidden, decorations: DecorationSet.create(doc, decorations) };
}

// Whether the block at `pos` is inside a folded section.
export function isFoldedAway(state, pos) {
  return Boolean(hidingSection(foldingKey.getState(state).hidden, pos));
}

// Opens whatever folds hide the block at `pos`.
export function revealPos(view, pos) {
  const { folded } = foldingKey.getState(view.state);
  const unfold = foldsHiding(view.state.doc, folded, [pos]);
  if (unfold.length) view.dispatch(view.state.tr.setMeta(foldingKey, { unfold }));
}

// The folded section starting at the heading at `pos`, as { from, to }, when
// that heading is folded and hides something; moving the heading moves it all.
export function foldedSectionAt(state, pos) {
  const section = foldingKey.getState(state)?.hidden.find((candidate) => candidate.pos === pos);
  return section ? { from: section.pos, to: section.end, id: section.id } : null;
}

// Where the folded section at `pos` goes when moved one step (`direction` -1
// or 1), as { from, to, insertAt } with `insertAt` counted before the section
// is taken out; null if it can't move. Down, it goes past the next heading's
// whole section; up, above the previous heading of its level or higher (or to
// the top). Either way it lands whole, before a heading that ends it.
export function foldedSectionMove(state, pos, direction) {
  const section = foldedSectionAt(state, pos);
  if (!section) return null;
  const sections = outline(state.doc);
  if (direction > 0) {
    const next = sections.find((candidate) => candidate.pos === section.to);
    return next ? { ...section, insertAt: next.end } : null;
  }
  if (pos === 0) return null;
  const { level } = sections.find((candidate) => candidate.pos === pos);
  const previous = sections.filter((candidate) => candidate.pos < pos && candidate.level <= level).pop();
  return { ...section, insertAt: previous ? previous.pos : 0 };
}

export const Folding = Extension.create({
  name: "folding",

  addOptions() {
    return {
      // Block IDs of the folded headings.
      folded: [],
      onChange: null,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: foldingKey,
        state: {
          init: (_, state) => foldState(state.doc, new Set(options.folded || [])),
          apply: (tr, value, _, newState) => {
            const meta = tr.getMeta(foldingKey);
            let { folded } = value;
            if (meta?.toggle) {
              folded = new Set(folded);
              if (folded.has(meta.toggle)) folded.delete(meta.toggle);
              else folded.add(meta.toggle);
            }
            if (meta?.unfold?.length) {
              folded = new Set(folded);
              for (const id of meta.unfold) folded.delete(id);
            }
            return tr.docChanged || folded !== value.folded ? foldState(newState.doc, folded) : value;
          },
        },
        appendTransaction: (transactions, oldState, newState) => {
          const before = foldingKey.getState(oldState);
          const after = foldingKey.getState(newState);
          const { doc, selection } = newState;
          const at = selection instanceof AllSelection ? null : selection instanceof NodeSelection ? selection.from : selection.head;
          const inFold = at === null ? null : hidingSection(after.hidden, at);

          // After an edit: open any fold now hiding the cursor or a block that
          // was showing. A block is known by its ID, or, new or without one
          // before, by where it was.
          if (transactions.some((tr) => tr.docChanged)) {
            const wasHidden = new Set();
            for (const section of before.hidden) {
              oldState.doc.nodesBetween(section.start, section.end, (node) => {
                if (node.attrs.id) wasHidden.add(node.attrs.id);
                return false;
              });
            }
            const oldIds = new Set();
            oldState.doc.forEach((node) => node.attrs.id && oldIds.add(node.attrs.id));
            const mapping = new Mapping();
            for (const tr of transactions) mapping.appendMapping(tr.mapping);
            const back = mapping.invert();
            const reveal = inFold ? [at] : [];
            for (const section of after.hidden) {
              doc.nodesBetween(section.start, section.end, (node, pos) => {
                const { id } = node.attrs;
                const hiddenBefore = id && oldIds.has(id) ? wasHidden.has(id) : Boolean(hidingSection(before.hidden, back.map(pos, 1)));
                if (!hiddenBefore) reveal.push(pos);
                return false;
              });
            }
            const unfold = reveal.length ? foldsHiding(doc, after.folded, reveal) : [];
            if (unfold.length) return newState.tr.setMeta(foldingKey, { unfold }).setMeta("addToHistory", false);
            return null;
          }

          // The cursor moved (or its section was folded) into folded content:
          // step over it the way it was going, or back to the heading.
          if (!inFold) return null;
          const forward = at > (oldState.selection.head ?? 0) && !transactions.some((tr) => tr.getMeta(foldingKey));
          let target = forward ? Selection.findFrom(doc.resolve(inFold.end), 1) : null;
          if (!target || hidingSection(after.hidden, target.from)) target = TextSelection.create(doc, inFold.start - 1);
          if (selection instanceof TextSelection && !selection.empty && target instanceof TextSelection) {
            target = TextSelection.create(doc, selection.anchor, target.head);
          }
          return newState.tr.setSelection(target).setMeta("addToHistory", false);
        },
        props: {
          decorations: (state) => foldingKey.getState(state).decorations,
        },
        view: (view) => {
          // The browser's find reached folded text: open its section.
          const onBeforeMatch = (event) => {
            try {
              revealPos(view, view.posAtDOM(event.target, 0));
            } catch { /* Not in the note. */ }
          };
          view.dom.addEventListener("beforematch", onBeforeMatch);
          return {
            update: (_, previousState) => {
              const { folded, sections } = foldingKey.getState(view.state);
              if (folded === foldingKey.getState(previousState).folded) return;
              // Only headings still in the note are worth remembering.
              options.onChange?.(sections.filter((section) => folded.has(section.id)).map((section) => section.id));
            },
            destroy: () => view.dom.removeEventListener("beforematch", onBeforeMatch),
          };
        },
      }),
    ];
  },
});
