import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const uploadsKey = new PluginKey("zetesisUploads");
let nextUploadId = 1;

function placeholderPosition(state, id) {
  const found = uploadsKey.getState(state).find(undefined, undefined, (spec) => spec.uploadId === id);
  return found.length ? found[0].from : null;
}

// Pasted or dropped files upload immediately. A placeholder widget marks the
// insertion point (and offers Retry on failure); the finished asset replaces
// it as an image or file block. Placeholders are decorations, so they are
// never part of the saved document.
export const Uploads = Extension.create({
  name: "uploads",

  addOptions() {
    return {
      upload: null,
      onError: null,
    };
  },

  addStorage() {
    return { active: new Map() };
  },

  addCommands() {
    return {
      uploadFiles: (files, position) => ({ editor }) => {
        startUploads(editor, this.options, this.storage, [...files], position ?? editor.state.selection.from);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    const storage = this.storage;
    return [
      new Plugin({
        key: uploadsKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(uploadsKey);
            if (meta?.add) {
              const { id, pos, dom } = meta.add;
              next = next.add(tr.doc, [Decoration.widget(pos, dom, {
                uploadId: id,
                side: -1,
                ignoreSelection: true,
                stopEvent: () => true,
              })]);
            }
            if (meta?.remove) {
              next = next.remove(next.find(undefined, undefined, (spec) => spec.uploadId === meta.remove));
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            return uploadsKey.getState(state);
          },
          handlePaste(view, event) {
            const files = [...(event.clipboardData?.files || [])];
            if (!files.length || !editor.isEditable) return false;
            const { from, to } = view.state.selection;
            if (from !== to) view.dispatch(view.state.tr.deleteSelection());
            startUploads(editor, options, storage, files, view.state.selection.from);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            const files = [...(event.dataTransfer?.files || [])];
            if (moved || !files.length || !editor.isEditable) return false;
            const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
            event.preventDefault();
            startUploads(editor, options, storage, files, position);
            return true;
          },
        },
      }),
    ];
  },

  onDestroy() {
    this.storage.active.clear();
  },
});

// Uploaded files become blocks, so place them between blocks rather than
// splitting the text under the cursor: before the block when at its start,
// otherwise after it.
function blockBoundary(doc, position) {
  const $pos = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
  if (!$pos.parent.isTextblock) return $pos.pos;
  return $pos.parentOffset === 0 ? $pos.before() : $pos.after();
}

function startUploads(editor, options, storage, files, cursor) {
  const position = blockBoundary(editor.state.doc, cursor);
  for (const file of files) {
    const id = nextUploadId++;
    const placeholder = createPlaceholder(file);
    const entry = { id, file, placeholder, uploading: false };
    storage.active.set(id, entry);
    placeholder.retry.addEventListener("click", () => runUpload(editor, options, storage, entry));
    placeholder.dismiss.addEventListener("click", () => removePlaceholder(editor, storage, id));
    editor.view.dispatch(editor.state.tr.setMeta(uploadsKey, { add: { id, pos: position, dom: placeholder.dom } }));
    runUpload(editor, options, storage, entry);
  }
}

async function runUpload(editor, options, storage, entry) {
  entry.uploading = true;
  entry.placeholder.setState("uploading", `Uploading ${entry.file.name || "file"}…`);
  try {
    const asset = await options.upload(entry.file);
    if (editor.isDestroyed || !storage.active.has(entry.id)) return;
    const position = placeholderPosition(editor.state, entry.id);
    removePlaceholder(editor, storage, entry.id);
    if (position === null) return;
    const node = asset.mimeType?.startsWith("image/")
      ? { type: "image", attrs: { assetId: asset.id, alt: "" } }
      : { type: "fileBlock", attrs: { assetId: asset.id, name: asset.name, mimeType: asset.mimeType, size: asset.size } };
    editor.chain().insertContentAt(position, node, { updateSelection: false }).run();
  } catch (error) {
    entry.uploading = false;
    if (editor.isDestroyed) return;
    const message = error instanceof Error ? error.message : "Upload failed.";
    entry.placeholder.setState("error", `${entry.file.name || "File"}: ${message}`);
    options.onError?.(message);
  }
}

function removePlaceholder(editor, storage, id) {
  storage.active.delete(id);
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(uploadsKey, { remove: id }));
}

function createPlaceholder() {
  const dom = document.createElement("div");
  dom.className = "zx-upload";
  dom.contentEditable = "false";
  const status = document.createElement("span");
  status.className = "zx-upload-status";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dom.append(status, retry, dismiss);
  return {
    dom,
    retry,
    dismiss,
    setState(state, message) {
      dom.dataset.state = state;
      status.textContent = message;
      retry.hidden = state !== "error";
      dismiss.hidden = state !== "error";
    },
  };
}

export function hasActiveUploads(editor) {
  return [...editor.storage.uploads.active.values()].some((entry) => entry.uploading);
}
