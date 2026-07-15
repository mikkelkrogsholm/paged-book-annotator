import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  assertPassiveBundlePath,
  DEFAULT_BOOK_BUNDLE_LIMITS,
  validateBookBundleDirectory,
  validateBundleRelativePath,
} from "../integration/book-bundle-contract.mjs";

export const DEFAULT_BOOK_STORAGE_LIMITS = Object.freeze({
  ...DEFAULT_BOOK_BUNDLE_LIMITS,
  maxArchiveBytes: 128 * 1024 * 1024,
});

function safeId(value, field) {
  const id = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(id)) throw new TypeError(`${field} har et ugyldigt format.`);
  return id;
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function tarText(bytes, start, length) {
  const end = bytes.indexOf(0, start);
  return new TextDecoder().decode(bytes.subarray(start, end >= start && end < start + length ? end : start + length));
}

function tarOctal(bytes, start, length, field) {
  const value = tarText(bytes, start, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new TypeError(`Tar-headerens ${field} er ugyldigt.`);
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`Tar-headerens ${field} er for stort.`);
  return number;
}

function assertTarChecksum(bytes, offset) {
  const recorded = tarOctal(bytes, offset + 148, 8, "checksum");
  let calculated = 0;
  for (let index = 0; index < 512; index += 1) calculated += index >= 148 && index < 156 ? 32 : bytes[offset + index];
  if (recorded !== calculated) throw new TypeError("Tar-arkivet har en ugyldig header-checksum.");
}

export function inspectTarBytes(bytes, limits = DEFAULT_BOOK_STORAGE_LIMITS) {
  const entries = [];
  const paths = new Set();
  let expandedBytes = 0;
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    assertTarChecksum(bytes, offset);
    const name = tarText(bytes, offset, 100);
    const prefix = tarText(bytes, offset + 345, 155);
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(bytes[offset + 156] || 48);
    const size = tarOctal(bytes, offset + 124, 12, "filstørrelse");
    const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    validateBundleRelativePath(path, { field: "tar-sti", maxPathLength: limits.maxPathLength });
    if (!new Set(["0", "5"]).has(type)) {
      throw new TypeError(`Tar-arkivet indeholder links eller en ikke-understøttet entry-type: ${path}`);
    }
    if (paths.has(path)) throw new TypeError(`Tar-arkivet indeholder samme sti flere gange: ${path}`);
    paths.add(path);
    if (type === "0") {
      assertPassiveBundlePath(path);
      if (size > limits.maxFileBytes) throw new TypeError(`Tar-filen er for stor: ${path}`);
      expandedBytes += size;
      if (expandedBytes > limits.maxExpandedBytes) throw new TypeError("Tar-arkivet overskrider den tilladte udpakkede størrelse.");
    } else if (size !== 0) {
      throw new TypeError(`Tar-mappen har uventet indholdsstørrelse: ${path}`);
    }
    entries.push({ path, type: type === "5" ? "directory" : "file", size });
    if (entries.length > limits.maxFiles) throw new TypeError(`Tar-arkivet indeholder mere end ${limits.maxFiles} entries.`);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > bytes.length) throw new TypeError("Tar-arkivet er afkortet.");
  }
  if (entries.length === 0) throw new TypeError("Tar-arkivet er tomt.");
  return { entries, expandedBytes };
}

async function canonicalDirectoryHash(root) {
  const paths = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else paths.push(relative(root, absolute).split("\\").join("/"));
    }
  }
  await collect(root);
  paths.sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    const bytes = await Bun.file(resolve(root, path)).bytes();
    hash.update(`${path.length}:${path}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export class LocalBookStorage {
  constructor({ rootDir, limits = {} }) {
    this.rootDir = resolve(rootDir);
    this.limits = { ...DEFAULT_BOOK_STORAGE_LIMITS, ...limits };
  }

  revisionRoot(bookId, revisionId) {
    return resolve(this.rootDir, "library", safeId(bookId, "bookId"), "revisions", safeId(revisionId, "revisionId"));
  }

  resolveContentPath(storageKey, relativePath = "") {
    const key = validateBundleRelativePath(storageKey, { field: "storageKey", maxPathLength: 400 });
    const base = resolve(this.rootDir, key);
    const candidate = relativePath ? resolve(base, validateBundleRelativePath(relativePath, { field: "relativePath", maxPathLength: 400 })) : base;
    if (!pathIsInside(this.rootDir, candidate)) throw new TypeError("Storage-stien forlader dataområdet.");
    return candidate;
  }

  async stageTarGz({ bookId, revisionId, archivePath }) {
    const archive = Bun.file(resolve(archivePath));
    if (!(await archive.exists())) throw new TypeError("Uploadarkivet findes ikke.");
    if (archive.size > this.limits.maxArchiveBytes) throw new TypeError("Uploadarkivet overskrider den tilladte komprimerede størrelse.");
    const compressed = await archive.bytes();
    if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new TypeError("Uploaden skal være et gzip-komprimeret tar-arkiv.");
    let tarBytes;
    try {
      tarBytes = Bun.gunzipSync(compressed);
    } catch {
      throw new TypeError("Uploadarkivet kan ikke dekomprimeres som gzip.");
    }
    inspectTarBytes(tarBytes, this.limits);
    return this.#install({
      bookId,
      revisionId,
      prepare: async (stagingRoot, contentDir) => {
        await Bun.write(resolve(stagingRoot, "bundle.tar.gz"), compressed);
        const extracted = await new Bun.Archive(compressed).extract(contentDir);
        if (extracted < 1) throw new TypeError("Uploadarkivet indeholder ingen filer.");
      },
    });
  }

  async importDirectory({ bookId, revisionId, sourceDir }) {
    const source = resolve(sourceDir);
    await validateBookBundleDirectory(source, { limits: this.limits });
    return this.#install({
      bookId,
      revisionId,
      prepare: async (_stagingRoot, contentDir) => cp(source, contentDir, { recursive: true, errorOnExist: true, force: false }),
    });
  }

  async #install({ bookId, revisionId, prepare }) {
    const normalizedBookId = safeId(bookId, "bookId");
    const normalizedRevisionId = safeId(revisionId, "revisionId");
    const stagingRoot = resolve(this.rootDir, "uploads", `${normalizedBookId}-${normalizedRevisionId}-${Bun.randomUUIDv7()}`);
    const contentDir = resolve(stagingRoot, "content");
    const finalRoot = this.revisionRoot(normalizedBookId, normalizedRevisionId);
    await mkdir(contentDir, { recursive: true });
    let installed = false;
    try {
      await prepare(stagingRoot, contentDir);
      const { manifest, validation } = await validateBookBundleDirectory(contentDir, { limits: this.limits });
      const contentHash = await canonicalDirectoryHash(contentDir);
      await mkdir(dirname(finalRoot), { recursive: true });
      await rename(stagingRoot, finalRoot);
      installed = true;
      const storageKey = relative(this.rootDir, resolve(finalRoot, "content")).split("\\").join("/");
      return { storageKey, contentDir: resolve(finalRoot, "content"), contentHash, manifest, validation };
    } finally {
      if (!installed) await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async removeRevision({ bookId, revisionId }) {
    await rm(this.revisionRoot(bookId, revisionId), { recursive: true, force: true });
  }
}
