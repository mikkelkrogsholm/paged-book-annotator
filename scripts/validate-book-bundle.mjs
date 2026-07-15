import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import { validateNavigationDocumentXhtml } from "../src/integration/navigation-contract.mjs";

const bundleRoot = resolve(Bun.argv[2] ?? "example/book");
const manifestPath = resolve(bundleRoot, "book-viewer.json");
const forbiddenReference = /(?:file:|node_modules)/i;

function pathIsInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function localAssetPath(containingFile, reference) {
  const normalizedReference = reference.trim().replace(/^['"]|['"]$/g, "");
  if (!normalizedReference || normalizedReference.startsWith("#") || normalizedReference.startsWith("data:")) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalizedReference) || normalizedReference.startsWith("//")) {
    throw new Error(`Bundle indeholder en ekstern reference: ${normalizedReference}`);
  }

  const withoutQuery = normalizedReference.split(/[?#]/, 1)[0];
  const candidate = resolve(dirname(containingFile), decodeURI(withoutQuery));
  if (!pathIsInside(bundleRoot, candidate)) {
    throw new Error(`Bundle-reference forlader bundle-mappen: ${normalizedReference}`);
  }
  return candidate;
}

function htmlReferences(html) {
  return [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
}

function cssReferences(css) {
  return [...css.matchAll(/url\(\s*([^)]*?)\s*\)/gi)].map((match) => match[1]);
}

async function assertAssetsExist(containingFile, references) {
  let checked = 0;
  for (const reference of references) {
    const assetPath = localAssetPath(containingFile, reference);
    if (!assetPath) continue;
    if (!(await Bun.file(assetPath).exists())) {
      throw new Error(`Bundle mangler asset: ${relative(bundleRoot, assetPath)}`);
    }
    checked += 1;
  }
  return checked;
}

if (!(await Bun.file(manifestPath).exists())) {
  throw new Error("Bundle mangler book-viewer.json.");
}

const manifest = await Bun.file(manifestPath).json();
if (manifest.book?.sourceDir !== "/book") {
  throw new Error("Bundle-manifestets book.sourceDir skal være /book.");
}
if (!String(manifest.annotations?.file ?? "").startsWith("/data/")) {
  throw new Error("Bundle-manifestets annotations.file skal ligge under /data/.");
}

const documentPath = resolve(bundleRoot, String(manifest.book?.document ?? ""));
if (!pathIsInside(bundleRoot, documentPath) || !(await Bun.file(documentPath).exists())) {
  throw new Error("Bundle-manifestets bogdokument findes ikke i bundle-mappen.");
}

const documentHtml = await Bun.file(documentPath).text();
if (forbiddenReference.test(documentHtml)) {
  throw new Error("Bogdokumentet indeholder file: eller node_modules og er ikke selvbærende.");
}

let checkedAssets = await assertAssetsExist(documentPath, htmlReferences(documentHtml));

if (manifest.book?.navigation) {
  const navigationPath = resolve(bundleRoot, String(manifest.book.navigation));
  if (!pathIsInside(bundleRoot, navigationPath) || !(await Bun.file(navigationPath).exists())) {
    throw new Error("Bundle-manifestets navigationsdokument findes ikke i bundle-mappen.");
  }
  const navigationXhtml = await Bun.file(navigationPath).text();
  if (forbiddenReference.test(navigationXhtml)) {
    throw new Error("Navigationsdokumentet indeholder file: eller node_modules og er ikke selvbærende.");
  }
  checkedAssets += await assertAssetsExist(navigationPath, htmlReferences(navigationXhtml));
  const navigationResult = validateNavigationDocumentXhtml(navigationXhtml, {
    bookHtml: documentHtml,
    documentName: basename(documentPath),
  });
  console.log(
    `Navigation contract passed: ${navigationResult.tocLinks} indholdspunkter og ${navigationResult.landmarkLinks} landemærker.`,
  );
}
const stylesheetPaths = htmlReferences(documentHtml)
  .filter((reference) => reference.toLowerCase().split(/[?#]/, 1)[0].endsWith(".css"))
  .map((reference) => localAssetPath(documentPath, reference));

for (const stylesheetPath of stylesheetPaths) {
  const css = await Bun.file(stylesheetPath).text();
  if (forbiddenReference.test(css)) {
    throw new Error(`${relative(bundleRoot, stylesheetPath)} indeholder file: eller node_modules.`);
  }
  checkedAssets += await assertAssetsExist(stylesheetPath, cssReferences(css));
}

console.log(`Book bundle contract passed: ${checkedAssets} lokale asset-referencer i ${bundleRoot}.`);
