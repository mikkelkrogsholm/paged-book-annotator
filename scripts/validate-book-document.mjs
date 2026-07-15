import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { validateBookDocumentHtml } from "../src/integration/book-document-contract.mjs";

const filePath = process.argv[2];
if (!filePath) throw new TypeError("Brug: bun scripts/validate-book-document.mjs <book.html>");
const absolutePath = resolve(filePath);
const result = validateBookDocumentHtml(await readFile(absolutePath, "utf8"));
console.log(`Book document contract passed: ${result.anchors} anchors, ${result.textAnchors} text anchors, ${result.pageLabels} page labels.`);
