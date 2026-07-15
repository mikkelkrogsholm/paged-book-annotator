import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { BookCatalogRepository } from "./book-catalog-repository.mjs";
import { LocalBookStorage } from "./book-storage.mjs";
import { BookRevisionUploadError, ManagedBookCatalog } from "./managed-book-catalog.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix = "pba-storage-") {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function bundleFiles(overrides = {}) {
  const bookHtml = overrides.bookHtml ?? `<!doctype html><html><body><p data-book-anchor="chapter-1" data-annotation-text>Tekst</p></body></html>`;
  const manifest = overrides.manifest ?? { schemaVersion: 1, book: { id: "test-book", title: "Test Book", document: "book.html" } };
  return { "book-viewer.json": JSON.stringify(manifest), "book.html": bookHtml, ...overrides.files };
}

async function writeArchive(root, files = bundleFiles(), name = "book.tar.gz") {
  const archivePath = resolve(root, name);
  const tar = await new Bun.Archive(files).bytes();
  await Bun.write(archivePath, Bun.gzipSync(tar));
  return archivePath;
}

function writeAscii(target, offset, length, value) {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function maliciousTar({ path, type = "0", content = "x", link = "" }) {
  const data = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, path);
  writeAscii(header, 100, 8, "0000644\0");
  writeAscii(header, 108, 8, "0000000\0");
  writeAscii(header, 116, 8, "0000000\0");
  writeAscii(header, 124, 12, `${(type === "0" ? data.length : 0).toString(8).padStart(11, "0")}\0`);
  writeAscii(header, 136, 12, "00000000000\0");
  header.fill(32, 148, 156);
  header[156] = type.charCodeAt(0);
  writeAscii(header, 157, 100, link);
  writeAscii(header, 257, 6, "ustar\0");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padded = Math.ceil(data.length / 512) * 512;
  const tar = new Uint8Array(512 + padded + 1024);
  tar.set(header);
  if (type === "0") tar.set(data, 512);
  return Bun.gzipSync(tar);
}

describe("LocalBookStorage", () => {
  test("installerer et valideret tar.gz som immutable revision", async () => {
    const root = await temporaryRoot();
    const archivePath = await writeArchive(root);
    const storage = new LocalBookStorage({ rootDir: resolve(root, "data") });
    const stored = await storage.stageTarGz({ bookId: "test-book", revisionId: "revision-1", archivePath });

    expect(stored.storageKey).toBe("library/test-book/revisions/revision-1/content");
    expect(stored.manifest.book).toEqual({ id: "test-book", title: "Test Book", document: "book.html" });
    expect(stored.validation.fileCount).toBe(2);
    expect(stored.contentHash).toHaveLength(64);
    expect(await Bun.file(resolve(stored.contentDir, "book.html")).exists()).toBe(true);
  });

  test("afviser traversal og symbolske links før ekstraktion", async () => {
    const root = await temporaryRoot();
    const storage = new LocalBookStorage({ rootDir: resolve(root, "data") });
    const traversal = resolve(root, "traversal.tar.gz");
    const linked = resolve(root, "link.tar.gz");
    await Bun.write(traversal, maliciousTar({ path: "../escape.txt" }));
    await Bun.write(linked, maliciousTar({ path: "book.html", type: "2", link: "target.html" }));

    await expect(storage.stageTarGz({ bookId: "test-book", revisionId: "revision-1", archivePath: traversal }))
      .rejects.toThrow("ugyldigt stisegment");
    await expect(storage.stageTarGz({ bookId: "test-book", revisionId: "revision-2", archivePath: linked }))
      .rejects.toThrow("links");
  });

  test("afviser aktive filer og aktiv markup", async () => {
    const root = await temporaryRoot();
    const storage = new LocalBookStorage({ rootDir: resolve(root, "data") });
    const scriptArchive = await writeArchive(root, bundleFiles({ files: { "payload.js": "alert(1)" } }), "script.tar.gz");
    const markupArchive = await writeArchive(root, bundleFiles({ bookHtml: `<p data-book-anchor="x"><script>alert(1)</script></p>` }), "markup.tar.gz");

    await expect(storage.stageTarGz({ bookId: "test-book", revisionId: "revision-1", archivePath: scriptArchive }))
      .rejects.toThrow("aktivt eller eksekverbart");
    await expect(storage.stageTarGz({ bookId: "test-book", revisionId: "revision-2", archivePath: markupArchive }))
      .rejects.toThrow("aktiv markup");
  });

  test("afviser symlinks ved import af en eksisterende mappe", async () => {
    const root = await temporaryRoot();
    const source = resolve(root, "source");
    await Bun.write(resolve(source, "book-viewer.json"), JSON.stringify(bundleFiles()["book-viewer.json"]));
    await Bun.write(resolve(source, "book.html"), bundleFiles()["book.html"]);
    await symlink("book.html", resolve(source, "alias.html"));
    expect(await readlink(resolve(source, "alias.html"))).toBe("book.html");
    const storage = new LocalBookStorage({ rootDir: resolve(root, "data") });

    await expect(storage.importDirectory({ bookId: "test-book", revisionId: "revision-1", sourceDir: source }))
      .rejects.toThrow("symbolske links");
  });
});

describe("ManagedBookCatalog", () => {
  test("holder den aktive revision uændret når en upload fejler", async () => {
    const root = await temporaryRoot();
    let number = 0;
    const repository = new BookCatalogRepository({ filePath: resolve(root, "data/catalog.sqlite"), createId: (prefix) => `${prefix}-${++number}` });
    const storage = new LocalBookStorage({ rootDir: resolve(root, "data") });
    const catalog = new ManagedBookCatalog({ repository, storage });
    catalog.createBook({ id: "test-book", slug: "test-book", title: "Test Book" });
    const first = await catalog.uploadRevision({ bookId: "test-book", archivePath: await writeArchive(root) });
    catalog.publishRevision({ bookId: "test-book", revisionId: first.id });
    const badArchive = await writeArchive(root, bundleFiles({ files: { "bad.js": "alert(1)" } }), "bad.tar.gz");

    let failure;
    try {
      await catalog.uploadRevision({ bookId: "test-book", archivePath: badArchive });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BookRevisionUploadError);
    expect(catalog.getBook("test-book").activeRevisionId).toBe(first.id);
    expect(catalog.getRevision("test-book", failure.revisionId).state).toBe("failed");
    repository.close();
  });

  test("importerer det eksisterende bogmount som første publicerede revision", async () => {
    const root = await temporaryRoot();
    const repository = new BookCatalogRepository({ filePath: resolve(root, "data/catalog.sqlite") });
    const storage = new LocalBookStorage({ rootDir: resolve(root, "data") });
    const catalog = new ManagedBookCatalog({ repository, storage });

    const result = await catalog.importBookDirectory({ sourceDir: resolve(import.meta.dir, "../../example/book"), createdBy: "admin-1" });
    expect(result.book).toMatchObject({ id: "annotator-example", activeRevisionId: result.revision.id });
    expect(result.revision.state).toBe("published");
    expect(result.revision.manifest.annotations).toBeUndefined();
    repository.close();
  });
});
