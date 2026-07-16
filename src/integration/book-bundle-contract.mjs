import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { lstat, readdir } from "node:fs/promises";

import { validateBookDocumentHtml } from "./book-document-contract.mjs";
import { validateNavigationDocumentXhtml } from "./navigation-contract.mjs";
import BOOK_BUNDLE_SCHEMA_V1 from "../../schemas/book-viewer.bundle.v1.schema.json" with { type: "json" };

export const BOOK_BUNDLE_CONTRACT = Object.freeze({
  name: "paged-book-annotator/book-bundle",
  version: 1,
  manifest: "book-viewer.json",
  archiveMediaType: "application/gzip",
});
export { BOOK_BUNDLE_SCHEMA_V1 };

export class BookBundleContractError extends TypeError {
  constructor(code, message, { file = null, field = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BookBundleContractError";
    this.code = code;
    this.file = file;
    this.field = field;
  }
}

function rejectBundle(code, message, details) {
  throw new BookBundleContractError(code, message, details);
}

export const DEFAULT_BOOK_BUNDLE_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxPathLength: 240,
});

const FORBIDDEN_FILE_EXTENSIONS = new Set([
  ".cjs", ".class", ".dll", ".dylib", ".exe", ".hta", ".htc", ".htm", ".jar", ".js", ".mht", ".mhtml", ".mjs", ".node", ".php", ".py", ".rb", ".sh", ".shtml", ".so", ".svgz", ".swf", ".wasm", ".xht", ".xml", ".xsl", ".xslt",
]);
const ACTIVE_MARKUP = /<\s*(?:[a-z][\w.-]*:)?(?:script|iframe|fencedframe|frame|frameset|object|embed|applet|base|form|portal)\b|\bon[a-z]+\s*=|\bsrcdoc\s*=/i;
const ACTIVE_SVG = /<\s*(?:[a-z][\w.-]*:)?(?:script|foreignObject|iframe|object|embed|animate|animateMotion|animateTransform|discard|set)\b|\bon[a-z]+\s*=|\bjavascript\s*:/i;
const ACTIVE_CSS = /expression\s*\(|(?:behavior|-moz-binding)\s*:/i;
const INLINE_STYLE_ELEMENT = /<\s*style\b/i;
const INLINE_STYLE_ATTRIBUTE = /\sstyle\s*=/i;
const SRCSET_ATTRIBUTE = /\bsrcset\s*=/i;
const DATA_CSS_REFERENCE = /\b(?:src|href)\s*=\s*["']\s*data\s*:\s*text\/css\b/i;
const DATA_CSS_URL = /\bdata\s*:\s*text\/css\b/i;
const URI_ATTRIBUTE = /(?:^|\s)(?:src|href|poster|action|formaction|xlink:href|background|cite|manifest|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi;
const SAFE_DATA_IMAGE = /^data:image\/(?:avif|bmp|gif|jpeg|png|webp)(?:;|,)/i;

const HTML_CHARACTER_REFERENCES = Object.freeze({
  amp: "&",
  apos: "'",
  colon: ":",
  gt: ">",
  lt: "<",
  newline: "\n",
  quot: '"',
  tab: "\t",
});

function decodeHtmlCharacterReferences(value) {
  return String(value).replace(/&(?:#(x[0-9a-f]+|[0-9]+)|([a-z][a-z0-9]+));?/gi, (reference, numeric, named) => {
    if (numeric) {
      const codePoint = Number.parseInt(numeric[0].toLowerCase() === "x" ? numeric.slice(1) : numeric, numeric[0].toLowerCase() === "x" ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return "\uFFFD";
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return "\uFFFD";
      }
    }
    return HTML_CHARACTER_REFERENCES[named.toLowerCase()] ?? reference;
  });
}

function decodeCssEscapes(value) {
  return String(value)
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?/gi, (_, hexadecimal) => {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "\uFFFD";
    })
    .replace(/\\(?:\r\n|[\n\r\f])/g, "")
    .replace(/\\([^0-9a-f\n\r\f])/gi, "$1");
}

function normalizedCss(value) {
  return decodeCssEscapes(value).replace(/\/\*[\s\S]*?\*\//g, " ");
}

function normalizedSchemeCandidate(value) {
  return String(value).replace(/[\u0000-\u0020\u007f]+/g, "");
}

function requireText(value, field, { minimumLength = 1, maximumLength = null } = {}) {
  const text = String(value ?? "").trim();
  if (text.length < minimumLength) rejectBundle("manifest_field_required", `${field} skal være en tekststreng på mindst ${minimumLength} tegn.`, { file: BOOK_BUNDLE_CONTRACT.manifest, field });
  if (maximumLength && text.length > maximumLength) {
    rejectBundle("manifest_field_too_long", `${field} må højst være ${maximumLength} tegn.`, { file: BOOK_BUNDLE_CONTRACT.manifest, field });
  }
  return text;
}

export function validateBundleRelativePath(value, { field = "sti", maxPathLength = 240 } = {}) {
  const path = requireText(value, field);
  if (path.length > maxPathLength) rejectBundle("path_too_long", `${field} er for lang.`, { field });
  if (path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[a-z]:/i.test(path)) {
    rejectBundle("path_not_relative_posix", `${field} skal være en relativ POSIX-sti.`, { field });
  }
  if (/[?#]/.test(path)) rejectBundle("path_url_delimiter_forbidden", `${field} må ikke indeholde ? eller #.`, { field });
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    rejectBundle("path_segment_invalid", `${field} indeholder et ugyldigt stisegment.`, { field });
  }
  return path;
}

export function assertPassiveBundlePath(path) {
  const lowerPath = path.toLowerCase();
  if (FORBIDDEN_FILE_EXTENSIONS.has(extname(lowerPath)) || basename(lowerPath) === ".htaccess") {
    rejectBundle("active_file_forbidden", `Bundle indeholder aktivt eller eksekverbart indhold: ${path}`, { file: path });
  }
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function localAssetPath(root, containingFile, reference, { allowDataImage = false } = {}) {
  const normalized = String(reference).trim().replace(/^['"]|['"]$/g, "");
  if (!normalized || normalized.startsWith("#")) return null;
  const schemeCandidate = normalizedSchemeCandidate(normalized);
  if (/^data:/i.test(schemeCandidate)) {
    if (allowDataImage && SAFE_DATA_IMAGE.test(schemeCandidate)) return null;
    rejectBundle("data_reference_forbidden", `Bundle indeholder en ikke-passiv data-reference: ${normalized}`, { file: relative(root, containingFile) });
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(schemeCandidate) || schemeCandidate.startsWith("//")) {
    rejectBundle("external_reference_forbidden", `Bundle indeholder en ekstern reference: ${normalized}`, { file: relative(root, containingFile) });
  }
  let decoded;
  try {
    decoded = decodeURI(normalized.split(/[?#]/, 1)[0]);
  } catch {
    rejectBundle("reference_encoding_invalid", `Bundle indeholder en ugyldigt kodet reference: ${normalized}`, { file: relative(root, containingFile) });
  }
  const candidate = resolve(dirname(containingFile), decoded);
  if (!pathIsInside(root, candidate)) rejectBundle("reference_outside_bundle", `Bundle-reference forlader bundle-mappen: ${normalized}`, { file: relative(root, containingFile) });
  return candidate;
}

function htmlReferences(html) {
  return [...html.matchAll(URI_ATTRIBUTE)].map((match) => decodeHtmlCharacterReferences(match[1] ?? match[2] ?? match[3] ?? ""));
}

function cssReferences(css) {
  const decoded = normalizedCss(css);
  return [
    ...[...decoded.matchAll(/url\(\s*([^)]*?)\s*\)/gi)].map((match) => match[1]),
    ...[...decoded.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gi)].map((match) => match[1]),
  ];
}

function assertPassiveMarkup(content, file) {
  if (ACTIVE_MARKUP.test(content)) {
    rejectBundle("active_markup_forbidden", `Bundle indeholder aktiv markup: ${file}`, { file });
  }
  for (const reference of htmlReferences(content)) {
    const schemeCandidate = normalizedSchemeCandidate(reference);
    if (/^(?:javascript|vbscript):/i.test(schemeCandidate)) {
      rejectBundle("active_markup_forbidden", `Bundle indeholder en aktiv URL i markup: ${file}`, { file });
    }
  }
  const metaTags = content.match(/<\s*meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const decoded = decodeHtmlCharacterReferences(tag);
    if (/\bhttp-equiv\s*=\s*(?:["']\s*)?refresh\b/i.test(decoded)) {
      rejectBundle("active_markup_forbidden", `Bundle indeholder refresh-meta: ${file}`, { file });
    }
  }
}

function assertStrictPassiveMarkup(content, file) {
  if (INLINE_STYLE_ELEMENT.test(content)) {
    rejectBundle("inline_style_element_forbidden", `Strikte bundles må ikke indeholde inline <style>: ${file}`, { file });
  }
  if (INLINE_STYLE_ATTRIBUTE.test(content)) {
    rejectBundle("inline_style_attribute_forbidden", `Strikte bundles må ikke indeholde style-attributter: ${file}`, { file });
  }
  if (SRCSET_ATTRIBUTE.test(content)) {
    rejectBundle("srcset_forbidden", `Strikte bundles må ikke indeholde srcset-attributter: ${file}`, { file });
  }
  if (DATA_CSS_REFERENCE.test(content)) {
    rejectBundle("data_css_reference_forbidden", `Strikte bundles må ikke indlæse CSS fra en data-URL: ${file}`, { file });
  }
}

function assertStrictPassiveCss(content, file) {
  const decoded = normalizedCss(content);
  if (DATA_CSS_URL.test(decoded)) {
    rejectBundle("data_css_reference_forbidden", `Strikte bundles må ikke indlæse CSS fra en data-URL: ${file}`, { file });
  }
  if (/(?:-webkit-)?image-set\s*\(/i.test(decoded)) {
    rejectBundle("css_image_set_forbidden", `Strikte bundles må ikke bruge CSS image-set(): ${file}`, { file });
  }
}

export async function inspectBookBundleTree(root, limits = DEFAULT_BOOK_BUNDLE_LIMITS) {
  const files = [];
  let expandedBytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const fromRoot = relative(root, absolutePath).split("\\").join("/");
      validateBundleRelativePath(fromRoot, { maxPathLength: limits.maxPathLength });
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) rejectBundle("symbolic_link_forbidden", `Bundle må ikke indeholde symbolske links: ${fromRoot}`, { file: fromRoot });
      if (info.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!info.isFile()) rejectBundle("special_file_forbidden", `Bundle indeholder en ikke-regulær fil: ${fromRoot}`, { file: fromRoot });
      assertPassiveBundlePath(fromRoot);
      if (info.size > limits.maxFileBytes) rejectBundle("file_too_large", `Bundle-filen er for stor: ${fromRoot}`, { file: fromRoot });
      files.push({ path: fromRoot, absolutePath, size: info.size });
      expandedBytes += info.size;
      if (files.length > limits.maxFiles) rejectBundle("file_count_exceeded", `Bundle indeholder mere end ${limits.maxFiles} filer.`);
      if (expandedBytes > limits.maxExpandedBytes) rejectBundle("expanded_size_exceeded", "Bundle overskrider den tilladte udpakkede størrelse.");
    }
  }
  await visit(root);
  return { files, expandedBytes };
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function strictManifestString(book, key, maximumLength, minimumLength = 1) {
  if (book[key] !== undefined && typeof book[key] !== "string") {
    rejectBundle("manifest_field_type_invalid", `book.${key} skal være en tekststreng.`, { file: BOOK_BUNDLE_CONTRACT.manifest, field: `book.${key}` });
  }
  return requireText(book[key], `book.${key}`, { minimumLength, maximumLength });
}

function contentManifest(rawManifest, { compatibility }) {
  const warnings = [];
  if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
    rejectBundle("manifest_root_invalid", "Bundle-manifestet skal være et JSON-objekt.", { file: BOOK_BUNDLE_CONTRACT.manifest });
  }
  const book = rawManifest?.book;
  if (!book || typeof book !== "object" || Array.isArray(book)) {
    rejectBundle("manifest_book_missing", "Bundle-manifestet mangler book.", { file: BOOK_BUNDLE_CONTRACT.manifest, field: "book" });
  }
  const strict = compatibility === "strict";
  const rootUnknown = unknownKeys(rawManifest, new Set(["schemaVersion", "book"]));
  const bookUnknown = unknownKeys(book, new Set(["id", "title", "subtitle", "mark", "language", "document", "navigation", "buildId"]));
  if (strict && (rootUnknown.length || bookUnknown.length)) {
    const field = rootUnknown[0] ?? `book.${bookUnknown[0]}`;
    rejectBundle("manifest_field_unknown", `Bundle-manifestet indeholder et ukendt felt: ${field}`, { file: BOOK_BUNDLE_CONTRACT.manifest, field });
  }
  if (!strict && (rootUnknown.length || bookUnknown.length)) warnings.push("legacy_fields_ignored");
  if (strict && rawManifest.schemaVersion === undefined) {
    rejectBundle("manifest_schema_version_required", "Bundle-manifestet mangler schemaVersion.", { file: BOOK_BUNDLE_CONTRACT.manifest, field: "schemaVersion" });
  }
  if (!strict && rawManifest.schemaVersion === undefined) warnings.push("legacy_implicit_schema_version");
  if (strict && typeof rawManifest.schemaVersion !== "number") {
    rejectBundle("manifest_field_type_invalid", "schemaVersion skal være et tal.", { file: BOOK_BUNDLE_CONTRACT.manifest, field: "schemaVersion" });
  }
  const schemaVersion = Number(rawManifest.schemaVersion ?? 1);
  if (schemaVersion !== BOOK_BUNDLE_CONTRACT.version) {
    rejectBundle("manifest_schema_version_unsupported", `Bundle-manifestets schemaVersion skal være ${BOOK_BUNDLE_CONTRACT.version}.`, { file: BOOK_BUNDLE_CONTRACT.manifest, field: "schemaVersion" });
  }
  if (strict && typeof book.id !== "string") {
    rejectBundle("manifest_field_type_invalid", "book.id skal være en tekststreng.", { file: BOOK_BUNDLE_CONTRACT.manifest, field: "book.id" });
  }
  const id = requireText(book.id, "book.id", { maximumLength: 96 });
  if (strict && (book.id !== id || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(id))) {
    rejectBundle("manifest_book_id_invalid", "book.id skal starte med et lille bogstav eller tal og kun indeholde små bogstaver, tal, _ og -.", { file: BOOK_BUNDLE_CONTRACT.manifest, field: "book.id" });
  }
  const normalized = {
    schemaVersion,
    book: {
      id,
      title: strict ? strictManifestString(book, "title", 200) : requireText(book.title, "book.title", { maximumLength: 200 }),
      document: validateBundleRelativePath(
        strict ? strictManifestString(book, "document", 240) : book.document,
        { field: "book.document" },
      ),
    },
  };
  for (const [key, maximumLength, minimumLength] of [["subtitle", 300, 1], ["mark", 16, 1], ["language", 35, 2], ["buildId", 200, 1]]) {
    if (strict && Object.hasOwn(book, key)) {
      normalized.book[key] = strictManifestString(book, key, maximumLength, minimumLength);
    } else if (!strict && book[key] !== undefined && book[key] !== null && String(book[key]).trim()) {
      normalized.book[key] = requireText(book[key], `book.${key}`, { minimumLength, maximumLength });
    }
  }
  if (strict && Object.hasOwn(book, "navigation")) {
    normalized.book.navigation = validateBundleRelativePath(strictManifestString(book, "navigation", 240), { field: "book.navigation" });
  } else if (!strict && book.navigation) {
    normalized.book.navigation = validateBundleRelativePath(book.navigation, { field: "book.navigation" });
  }
  return { manifest: normalized, warnings };
}

async function assertReferencesExist(root, containingFile, references, { allowDataImage = false } = {}) {
  let checked = 0;
  for (const reference of references) {
    const assetPath = localAssetPath(root, containingFile, reference, { allowDataImage });
    if (!assetPath) continue;
    let info;
    try {
      info = await lstat(assetPath);
    } catch {
      rejectBundle("asset_missing", `Bundle mangler asset: ${relative(root, assetPath)}`, { file: relative(root, containingFile) });
    }
    if (!info.isFile() || info.isSymbolicLink()) rejectBundle("asset_not_regular_file", `Bundle-asset er ikke en regulær fil: ${relative(root, assetPath)}`, { file: relative(root, assetPath) });
    checked += 1;
  }
  return checked;
}

export async function validateBookBundleDirectory(bundleRoot, options = {}) {
  const root = resolve(bundleRoot);
  const limits = { ...DEFAULT_BOOK_BUNDLE_LIMITS, ...options.limits };
  const compatibility = options.compatibility ?? "strict";
  if (!["strict", "legacy"].includes(compatibility)) throw new TypeError("compatibility skal være strict eller legacy.");
  const tree = await inspectBookBundleTree(root, limits);
  const manifestPath = resolve(root, "book-viewer.json");
  const manifestFile = tree.files.find((file) => file.absolutePath === manifestPath);
  if (!manifestFile) rejectBundle("manifest_missing", "Bundle mangler book-viewer.json i roden.", { file: BOOK_BUNDLE_CONTRACT.manifest });
  if (manifestFile.size > limits.maxManifestBytes) rejectBundle("manifest_too_large", "Bundle-manifestet er for stort.", { file: BOOK_BUNDLE_CONTRACT.manifest });

  let rawManifest;
  try {
    rawManifest = JSON.parse(await Bun.file(manifestPath).text());
  } catch {
    rejectBundle("manifest_json_invalid", "Bundle-manifestet er ikke gyldig JSON.", { file: BOOK_BUNDLE_CONTRACT.manifest });
  }
  const { manifest, warnings } = contentManifest(rawManifest, { compatibility });
  if (options.expectedBookId && manifest.book.id !== options.expectedBookId) {
    rejectBundle("manifest_book_id_mismatch", `Bundle tilhører ${manifest.book.id}, ikke ${options.expectedBookId}.`, { file: BOOK_BUNDLE_CONTRACT.manifest, field: "book.id" });
  }
  if (!/\.(?:html|xhtml)$/i.test(manifest.book.document)) {
    rejectBundle("document_format_unsupported", "book.document skal være en .html- eller .xhtml-fil.", { file: manifest.book.document, field: "book.document" });
  }
  if (manifest.book.navigation && !/\.xhtml$/i.test(manifest.book.navigation)) {
    rejectBundle("navigation_format_unsupported", "book.navigation skal være en .xhtml-fil.", { file: manifest.book.navigation, field: "book.navigation" });
  }
  const documentPath = resolve(root, manifest.book.document);
  if (!pathIsInside(root, documentPath) || !tree.files.some((file) => file.absolutePath === documentPath)) {
    rejectBundle("document_missing", "Bundle-manifestets bogdokument findes ikke i bundle-mappen.", { file: manifest.book.document, field: "book.document" });
  }

  let checkedAssets = 0;
  let documentContract;
  let navigationContract = null;
  let documentHtml;
  for (const file of tree.files) {
    const extension = extname(file.path).toLowerCase();
    if (![".css", ".html", ".svg", ".xhtml"].includes(extension)) continue;
    const content = await Bun.file(file.absolutePath).text();
    if (compatibility === "strict" && [".html", ".svg", ".xhtml"].includes(extension)) {
      assertStrictPassiveMarkup(content, file.path);
    }
    if (compatibility === "strict" && extension === ".css") assertStrictPassiveCss(content, file.path);
    if (extension === ".html" || extension === ".xhtml") assertPassiveMarkup(content, file.path);
    if (extension === ".svg" && ACTIVE_SVG.test(content)) rejectBundle("active_svg_forbidden", `Bundle indeholder aktiv SVG: ${file.path}`, { file: file.path });
    if (extension === ".css" && ACTIVE_CSS.test(normalizedCss(content))) rejectBundle("active_css_forbidden", `Bundle indeholder aktiv CSS: ${file.path}`, { file: file.path });
    checkedAssets += await assertReferencesExist(
      root,
      file.absolutePath,
      extension === ".css" ? cssReferences(content) : htmlReferences(content),
      { allowDataImage: true },
    );
    if (file.absolutePath === documentPath) documentHtml = content;
  }
  try {
    documentContract = validateBookDocumentHtml(documentHtml, { requirePagination: compatibility === "strict" });
  } catch (cause) {
    rejectBundle("document_contract_invalid", cause.message, { file: manifest.book.document, cause });
  }

  if (manifest.book.navigation) {
    const navigationPath = resolve(root, manifest.book.navigation);
    if (!pathIsInside(root, navigationPath) || !tree.files.some((file) => file.absolutePath === navigationPath)) {
      rejectBundle("navigation_missing", "Bundle-manifestets navigationsdokument findes ikke i bundle-mappen.", { file: manifest.book.navigation, field: "book.navigation" });
    }
    try {
      navigationContract = validateNavigationDocumentXhtml(await Bun.file(navigationPath).text(), {
        bookHtml: documentHtml,
        documentName: basename(documentPath),
      });
    } catch (cause) {
      rejectBundle("navigation_contract_invalid", cause.message, { file: manifest.book.navigation, cause });
    }
  }

  return {
    contract: BOOK_BUNDLE_CONTRACT,
    manifest,
    validation: {
      fileCount: tree.files.length,
      expandedBytes: tree.expandedBytes,
      checkedAssets,
      warnings,
      ...documentContract,
      ...(navigationContract ? { navigation: navigationContract } : {}),
    },
  };
}
