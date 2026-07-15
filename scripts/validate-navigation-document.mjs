import { basename, resolve } from "node:path";

import { validateNavigationDocumentXhtml } from "../src/integration/navigation-contract.mjs";

const navigationPath = resolve(Bun.argv[2] ?? "example/book/navigation.xhtml");
const documentPath = resolve(Bun.argv[3] ?? "example/book/book.html");
const [xhtml, bookHtml] = await Promise.all([
  Bun.file(navigationPath).text(),
  Bun.file(documentPath).text(),
]);
const result = validateNavigationDocumentXhtml(xhtml, {
  bookHtml,
  documentName: basename(documentPath),
});
console.log(`Navigation contract passed: ${result.tocLinks} indholdspunkter og ${result.landmarkLinks} landemærker.`);
