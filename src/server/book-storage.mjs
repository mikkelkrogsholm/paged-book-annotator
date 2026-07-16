import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  DEFAULT_BOOK_ARCHIVE_LIMITS,
  inspectBookBundleGzipBytes,
  inspectBookBundleTarBytes,
} from "../integration/book-bundle-archive.mjs";
import {
  BookBundleContractError,
  validateBookBundleDirectory,
  validateBundleRelativePath,
} from "../integration/book-bundle-contract.mjs";

export const DEFAULT_BOOK_STORAGE_LIMITS = DEFAULT_BOOK_ARCHIVE_LIMITS;
export const inspectTarBytes = inspectBookBundleTarBytes;

function safeId(value, field) {
  const id = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(id)) throw new TypeError(`${field} har et ugyldigt format.`);
  return id;
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
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
    if (!(await archive.exists())) throw new BookBundleContractError("archive_missing", "Uploadarkivet findes ikke.");
    if (archive.size > this.limits.maxArchiveBytes) throw new BookBundleContractError("archive_size_exceeded", "Uploadarkivet overskrider den tilladte komprimerede størrelse.");
    const compressed = await archive.bytes();
    await inspectBookBundleGzipBytes(compressed, this.limits);
    return this.#install({
      bookId,
      revisionId,
      compatibility: "strict",
      expectedBookId: bookId,
      prepare: async (stagingRoot, contentDir) => {
        await Bun.write(resolve(stagingRoot, "bundle.tar.gz"), compressed);
        const extracted = await new Bun.Archive(compressed).extract(contentDir);
        if (extracted < 1) throw new BookBundleContractError("archive_empty", "Uploadarkivet indeholder ingen filer.");
      },
    });
  }

  async importDirectory({ bookId, revisionId, sourceDir }) {
    const source = resolve(sourceDir);
    await validateBookBundleDirectory(source, { compatibility: "legacy", limits: this.limits });
    return this.#install({
      bookId,
      revisionId,
      compatibility: "legacy",
      prepare: async (_stagingRoot, contentDir) => cp(source, contentDir, { recursive: true, errorOnExist: true, force: false }),
    });
  }

  async #install({ bookId, revisionId, compatibility, expectedBookId = null, prepare }) {
    const normalizedBookId = safeId(bookId, "bookId");
    const normalizedRevisionId = safeId(revisionId, "revisionId");
    const stagingRoot = resolve(this.rootDir, "uploads", `${normalizedBookId}-${normalizedRevisionId}-${Bun.randomUUIDv7()}`);
    const contentDir = resolve(stagingRoot, "content");
    const finalRoot = this.revisionRoot(normalizedBookId, normalizedRevisionId);
    await mkdir(contentDir, { recursive: true });
    let installed = false;
    try {
      await prepare(stagingRoot, contentDir);
      const { manifest, validation } = await validateBookBundleDirectory(contentDir, {
        compatibility,
        expectedBookId,
        limits: this.limits,
      });
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
