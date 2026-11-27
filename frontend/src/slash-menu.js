import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { FloatingList, matchesQuery, rectReference } from "./floating.js";

// Typing "/" opens a filterable menu of blocks to insert at the cursor.
export const SlashCommands = Extension.create({
  name: "slashCommands",

  addOptions() {
    return {
      root: null,
      scrollContainer: null,
      items: () => [],
    };
  },

  addProseMirrorPlugins() {
    const { root, scrollContainer, items } = this.options;
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey("slashCommands"),
        char: "/",
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => items().filter((item) => matchesQuery(item, query)),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let list = null;
          let command = null;
          const reposition = () => list?.position();
          return {
            onStart: (props) => {
              command = props.command;
              list = new FloatingList({
                root,
                className: "zx-slash-menu",
                emptyText: "No matching blocks",
                onSelect: (item) => command(item),
              });
              list.show(rectReference(() => props.clientRect?.()), props.items);
              scrollContainer?.addEventListener("scroll", reposition, { passive: true });
            },
            onUpdate: (props) => {
              command = props.command;
              list.reference = rectReference(() => props.clientRect?.());
              list.setItems(props.items);
            },
            onKeyDown: ({ event }) => {
              if (event.key === "Escape") return true;
              return list?.onKeyDown(event) ?? false;
            },
            onExit: () => {
              scrollContainer?.removeEventListener("scroll", reposition);
              list?.destroy();
              list = null;
            },
          };
        },
      }),
    ];
  },
});
