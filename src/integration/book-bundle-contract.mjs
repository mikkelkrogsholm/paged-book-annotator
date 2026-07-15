import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { lstat, readdir } from "node:fs/promises";

import { validateBookDocumentHtml } from "./book-document-contract.mjs";
import { validateNavigationDocumentXhtml } from "./navigation-contract.mjs";

export const DEFAULT_BOOK_BUNDLE_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxPathLength: 240,
});

const FORBIDDEN_FILE_EXTENSIONS = new Set([
  ".cjs", ".class", ".dll", ".dylib", ".exe", ".jar", ".js", ".mjs", ".node", ".php", ".py", ".rb", ".sh", ".so", ".wasm",
]);
const ACTIVE_MARKUP = /<\s*(?:script|iframe|object|embed|base)\b|\bon[a-z]+\s*=|\bjavascript\s*:|<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i;
const ACTIVE_SVG = /<\s*(?:script|foreignObject|iframe|object|embed)\b|\bon[a-z]+\s*=|\bjavascript\s*:/i;
const ACTIVE_CSS = /expression\s*\(|(?:behavior|-moz-binding)\s*:/i;

function requireText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${field} skal være en ikke-tom tekststreng.`);
  return text;
}

export function validateBundleRelativePath(value, { field = "sti", maxPathLength = 240 } = {}) {
  const path = requireText(value, field);
  if (path.length > maxPathLength) throw new TypeError(`${field} er for lang.`);
  if (path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[a-z]:/i.test(path)) {
    throw new TypeError(`${field} skal være en relativ POSIX-sti.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`${field} indeholder et ugyldigt stisegment.`);
  }
  return path;
}

export function assertPassiveBundlePath(path) {
  const lowerPath = path.toLowerCase();
  if (FORBIDDEN_FILE_EXTENSIONS.has(extname(lowerPath)) || basename(lowerPath) === ".htaccess") {
    throw new TypeError(`Bundle indeholder aktivt eller eksekverbart indhold: ${path}`);
  }
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function localAssetPath(root, containingFile, reference) {
  const normalized = String(reference).trim().replace(/^['"]|['"]$/g, "");
  if (!normalized || normalized.startsWith("#") || normalized.startsWith("data:")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) || normalized.startsWith("//")) {
    throw new TypeError(`Bundle indeholder en ekstern reference: ${normalized}`);
  }
  let decoded;
  try {
    decoded = decodeURI(normalized.split(/[?#]/, 1)[0]);
  } catch {
    throw new TypeError(`Bundle indeholder en ugyldigt kodet reference: ${normalized}`);
  }
  const candidate = resolve(dirname(containingFile), decoded);
  if (!pathIsInside(root, candidate)) throw new TypeError(`Bundle-reference forlader bundle-mappen: ${normalized}`);
  return candidate;
}

function htmlReferences(html) {
  return [...html.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
}

function cssReferences(css) {
  return [
    ...[...css.matchAll(/url\(\s*([^)]*?)\s*\)/gi)].map((match) => match[1]),
    ...[...css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)].map((match) => match[1]),
  ];
}

async function inspectTree(root, limits) {
  const files = [];
  let expandedBytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const fromRoot = relative(root, absolutePath).split("\\").join("/");
      validateBundleRelativePath(fromRoot, { maxPathLength: limits.maxPathLength });
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new TypeError(`Bundle må ikke indeholde symbolske links: ${fromRoot}`);
      if (info.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!info.isFile()) throw new TypeError(`Bundle indeholder en ikke-regulær fil: ${fromRoot}`);
      assertPassiveBundlePath(fromRoot);
      if (info.size > limits.maxFileBytes) throw new TypeError(`Bundle-filen er for stor: ${fromRoot}`);
      files.push({ path: fromRoot, absolutePath, size: info.size });
      expandedBytes += info.size;
      if (files.length > limits.maxFiles) throw new TypeError(`Bundle indeholder mere end ${limits.maxFiles} filer.`);
      if (expandedBytes > limits.maxExpandedBytes) throw new TypeError("Bundle overskrider den tilladte udpakkede størrelse.");
    }
  }
  await visit(root);
  return { files, expandedBytes };
}

function contentManifest(rawManifest) {
  const book = rawManifest?.book;
  if (!book || typeof book !== "object" || Array.isArray(book)) throw new TypeError("Bundle-manifestet mangler book.");
  const normalized = {
    schemaVersion: Number(rawManifest.schemaVersion ?? 1),
    book: {
      id: requireText(book.id, "book.id"),
      title: requireText(book.title, "book.title"),
      document: validateBundleRelativePath(book.document, { field: "book.document" }),
    },
  };
  for (const key of ["subtitle", "mark", "language", "buildId"]) {
    if (book[key] !== undefined && book[key] !== null && String(book[key]).trim()) normalized.book[key] = String(book[key]).trim();
  }
  if (book.navigation) normalized.book.navigation = validateBundleRelativePath(book.navigation, { field: "book.navigation" });
  if (!Number.isInteger(normalized.schemaVersion) || normalized.schemaVersion < 1) {
    throw new TypeError("Bundle-manifestets schemaVersion skal være et positivt heltal.");
  }
  return normalized;
}

async function assertReferencesExist(root, containingFile, references) {
  let checked = 0;
  for (const reference of references) {
    const assetPath = localAssetPath(root, containingFile, reference);
    if (!assetPath) continue;
    let info;
    try {
      info = await lstat(assetPath);
    } catch {
      throw new TypeError(`Bundle mangler asset: ${relative(root, assetPath)}`);
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new TypeError(`Bundle-asset er ikke en regulær fil: ${relative(root, assetPath)}`);
    checked += 1;
  }
  return checked;
}

export async function validateBookBundleDirectory(bundleRoot, options = {}) {
  const root = resolve(bundleRoot);
  const limits = { ...DEFAULT_BOOK_BUNDLE_LIMITS, ...options.limits };
  const tree = await inspectTree(root, limits);
  const manifestPath = resolve(root, "book-viewer.json");
  const manifestFile = tree.files.find((file) => file.absolutePath === manifestPath);
  if (!manifestFile) throw new TypeError("Bundle mangler book-viewer.json i roden.");
  if (manifestFile.size > limits.maxManifestBytes) throw new TypeError("Bundle-manifestet er for stort.");

  let rawManifest;
  try {
    rawManifest = JSON.parse(await Bun.file(manifestPath).text());
  } catch {
    throw new TypeError("Bundle-manifestet er ikke gyldig JSON.");
  }
  const manifest = contentManifest(rawManifest);
  const documentPath = resolve(root, manifest.book.document);
  if (!pathIsInside(root, documentPath) || !tree.files.some((file) => file.absolutePath === documentPath)) {
    throw new TypeError("Bundle-manifestets bogdokument findes ikke i bundle-mappen.");
  }

  let checkedAssets = 0;
  let documentContract;
  let navigationContract = null;
  let documentHtml;
  for (const file of tree.files) {
    const extension = extname(file.path).toLowerCase();
    if (![".css", ".html", ".svg", ".xhtml"].includes(extension)) continue;
    const content = await Bun.file(file.absolutePath).text();
    if ((extension === ".html" || extension === ".xhtml") && ACTIVE_MARKUP.test(content)) {
      throw new TypeError(`Bundle indeholder aktiv markup: ${file.path}`);
    }
    if (extension === ".svg" && ACTIVE_SVG.test(content)) throw new TypeError(`Bundle indeholder aktiv SVG: ${file.path}`);
    if (extension === ".css" && ACTIVE_CSS.test(content)) throw new TypeError(`Bundle indeholder aktiv CSS: ${file.path}`);
    checkedAssets += await assertReferencesExist(root, file.absolutePath, extension === ".css" ? cssReferences(content) : htmlReferences(content));
    if (file.absolutePath === documentPath) documentHtml = content;
  }
  documentContract = validateBookDocumentHtml(documentHtml);

  if (manifest.book.navigation) {
    const navigationPath = resolve(root, manifest.book.navigation);
    if (!pathIsInside(root, navigationPath) || !tree.files.some((file) => file.absolutePath === navigationPath)) {
      throw new TypeError("Bundle-manifestets navigationsdokument findes ikke i bundle-mappen.");
    }
    navigationContract = validateNavigationDocumentXhtml(await Bun.file(navigationPath).text(), {
      bookHtml: documentHtml,
      documentName: basename(documentPath),
    });
  }

  return {
    manifest,
    validation: {
      fileCount: tree.files.length,
      expandedBytes: tree.expandedBytes,
      checkedAssets,
      ...documentContract,
      ...(navigationContract ? { navigation: navigationContract } : {}),
    },
  };
}
