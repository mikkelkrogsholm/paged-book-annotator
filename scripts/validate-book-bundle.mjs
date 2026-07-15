import { resolve } from "node:path";

import { validateBookBundleDirectory } from "../src/integration/book-bundle-contract.mjs";

const bundleRoot = resolve(Bun.argv[2] ?? "example/book");
const result = await validateBookBundleDirectory(bundleRoot);
if (result.validation.navigation) {
  console.log(
    `Navigation contract passed: ${result.validation.navigation.tocLinks} indholdspunkter og ${result.validation.navigation.landmarkLinks} landemærker.`,
  );
}
console.log(
  `Book bundle contract passed: ${result.validation.fileCount} filer, ${result.validation.checkedAssets} lokale asset-referencer i ${bundleRoot}.`,
);
