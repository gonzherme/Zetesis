// Validate stored note bodies against the editor schema.
//
//   npm run check-docs -- ../zetesis.sqlite3            (every converted note)
//   npm run check-docs -- body.json other.json          (JSON files)
//   npm run check-docs -- ../zetesis.sqlite3 --normalized out/
//
// With --normalized, also writes each document as the editor would emit it
// (all attributes filled in), so blocks.py can be checked against that form.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getSchema } from "@tiptap/core";
import { schemaExtensions } from "../src/schema.js";

const args = process.argv.slice(2);
const normalizedIndex = args.indexOf("--normalized");
const normalizedDir = normalizedIndex >= 0 ? args.splice(normalizedIndex, 2)[1] : null;
if (!args.length) {
  console.error("usage: check-docs <zetesis.sqlite3 | body.json ...> [--normalized DIR]");
  process.exit(2);
}

const documents = [];
for (const source of args) {
  if (source.endsWith(".sqlite3")) {
    const database = new DatabaseSync(source, { readOnly: true });
    for (const row of database.prepare("SELECT path, body_json FROM notes WHERE body_json IS NOT NULL").all()) {
      documents.push([row.path, row.body_json]);
    }
    database.close();
  } else {
    documents.push([source, readFileSync(source, "utf8")]);
  }
}

const schema = getSchema(schemaExtensions());
if (normalizedDir) mkdirSync(normalizedDir, { recursive: true });
let failures = 0;
for (const [name, raw] of documents) {
  try {
    const node = schema.nodeFromJSON(JSON.parse(raw));
    node.check();
    if (normalizedDir) {
      writeFileSync(join(normalizedDir, `${name.replaceAll("/", "__")}.json`), JSON.stringify(node.toJSON()));
    }
  } catch (error) {
    failures += 1;
    console.error(`${name}: ${error.message}`);
  }
}
console.log(`${documents.length - failures}/${documents.length} documents match the editor schema.`);
process.exit(failures ? 1 : 0);
