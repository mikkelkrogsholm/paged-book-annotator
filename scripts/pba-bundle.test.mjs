// agent-lint: disable-file=AR002 -- Security fixtures intentionally assert the same public error contract from CLI and library seams.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  BOOK_BUNDLE_SCHEMA_V1,
  BookBundleContractError,
} from "../src/integration/book-bundle-contract.mjs";
import {
  packBookBundleDirectory,
  validateBookBundleArchive,
} from "../src/integration/book-bundle-archive.mjs";
import {
  initializeBookBundle,
  runBundleCli,
  validateBundleInput,
} from "./pba-bundle.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "pba-bundle-cli-"));
  temporaryRoots.push(root);
  return root;
}

async function initializedBundle(root, id = "agent-book") {
  const directory = resolve(root, "bundle");
  await initializeBookBundle({ outputDirectory: directory, id, title: "Agent Book" });
  return directory;
}

async function expectContractCode(promise, code) {
  let failure;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BookBundleContractError);
  expect(failure.code).toBe(code);
}

describe("Paged Book Bundle CLI", () => {
  test("schema, init og directory→archive→validate bruger samme v1-kontrakt", async () => {
    const root = await temporaryRoot();
    const directory = await initializedBundle(root);
    const archivePath = resolve(root, "agent-book.tar.gz");

    expect(BOOK_BUNDLE_SCHEMA_V1.properties.schemaVersion.const).toBe(1);
    const directoryResult = await validateBundleInput(directory, { expectedBookId: "agent-book" });
    const packed = await packBookBundleDirectory(directory, archivePath, { expectedBookId: "agent-book" });
    const archiveResult = await validateBookBundleArchive(archivePath, { expectedBookId: "agent-book" });

    expect(directoryResult.sourceType).toBe("directory");
    expect(packed.sourceType).toBe("archive");
    expect(archiveResult.manifest).toEqual(directoryResult.manifest);
    expect(archiveResult.archive.sha256).toBe(packed.archive.sha256);
  });

  test("to pakninger af samme directory er byte-identiske", async () => {
    const root = await temporaryRoot();
    const directory = await initializedBundle(root);
    const first = resolve(root, "first.tar.gz");
    const second = resolve(root, "second.tar.gz");

    await packBookBundleDirectory(directory, first);
    await packBookBundleDirectory(directory, second);

    expect(Buffer.from(await Bun.file(first).bytes())).toEqual(Buffer.from(await Bun.file(second).bytes()));
  });

  test("validate --json leverer maskinlæsbar succes og stabil fejl", async () => {
    const root = await temporaryRoot();
    const directory = await initializedBundle(root);
    const output = [];
    const errors = [];
    const io = { writeOut: (value) => output.push(value), writeError: (value) => errors.push(value) };

    expect(await runBundleCli(["validate", directory, "--json"], io)).toBe(0);
    expect(JSON.parse(output.pop())).toMatchObject({ ok: true, command: "validate", book: { id: "agent-book" } });

    expect(await runBundleCli(["validate", directory, "--expected-book-id", "different-book", "--json"], io)).toBe(1);
    expect(JSON.parse(output.pop())).toMatchObject({ ok: false, error: { code: "manifest_book_id_mismatch", field: "book.id" } });
    expect(errors).toEqual([]);
  });

  test("afviser en ikke-understøttet manifestversion", async () => {
    const root = await temporaryRoot();
    const directory = await initializedBundle(root);
    const manifestPath = resolve(directory, "book-viewer.json");
    const manifest = await Bun.file(manifestPath).json();
    manifest.schemaVersion = 2;
    await Bun.write(manifestPath, JSON.stringify(manifest));

    await expectContractCode(validateBundleInput(directory), "manifest_schema_version_unsupported");
  });

  test("afviser et manifest-id der ikke matcher katalogbogen", async () => {
    const root = await temporaryRoot();
    const directory = await initializedBundle(root);

    await expectContractCode(validateBundleInput(directory, { expectedBookId: "catalog-book" }), "manifest_book_id_mismatch");
  });

  test("afviser en wrapper-mappe i arkivroden", async () => {
    const root = await temporaryRoot();
    const archivePath = resolve(root, "wrapped.tar.gz");
    const html = '<!doctype html><html data-paged-complete="true"><body data-pre-paginated="true"><main class="pagedjs_pages"><section class="pagedjs_page"><p data-book-anchor="x" data-annotation-text>Tekst</p></section></main></body></html>';
    const archive = await new Bun.Archive({
      "wrapper/book-viewer.json": JSON.stringify({ schemaVersion: 1, book: { id: "wrapped", title: "Wrapped", document: "book.html" } }),
      "wrapper/book.html": html,
    }, { compress: "gzip" }).bytes();
    await Bun.write(archivePath, archive);

    await expectContractCode(validateBookBundleArchive(archivePath), "archive_wrapper_root");
  });

  test("afviser aktive filer", async () => {
    const root = await temporaryRoot();
    const directory = await initializedBundle(root);
    await Bun.write(resolve(directory, "payload.js"), "alert(1)");

    await expectContractCode(validateBundleInput(directory), "active_file_forbidden");
  });

  test("afviser URL-delimiters og ikke-renderbare manifestformater", async () => {
    for (const [id, document, navigation, code] of [
      ["url-delimiter", "book#draft.html", "navigation.xhtml", "path_url_delimiter_forbidden"],
      ["text-document", "book.txt", "navigation.xhtml", "document_format_unsupported"],
      ["html-navigation", "book.html", "navigation.html", "navigation_format_unsupported"],
    ]) {
      const root = await temporaryRoot();
      const directory = await initializedBundle(root, id);
      const manifestPath = resolve(directory, "book-viewer.json");
      const manifest = await Bun.file(manifestPath).json();
      manifest.book.document = document;
      manifest.book.navigation = navigation;
      await Bun.write(manifestPath, JSON.stringify(manifest));
      await expectContractCode(validateBundleInput(directory), code);
    }
  });

  test("afviser CSS- og responsive-image-bypasses i strikte HTML-bundles", async () => {
    const cases = [
      ["inline-style-element", "</head>", "<style>body { color: red }</style></head>", "inline_style_element_forbidden"],
      ["style-attribute", "<body ", '<body style="color:red" ', "inline_style_attribute_forbidden"],
      ["srcset", "</body>", '<img srcset="local.png 1x, https://example.test/tracker.png 2x"></body>', "srcset_forbidden"],
      ["data-css", "</head>", '<link rel="stylesheet" href="data:text/css,body%7Bcolor:red%7D"></head>', "data_css_reference_forbidden"],
      ["external-css", "</head>", '<link rel="stylesheet" href="https://example.test/book.css"></head>', "external_reference_forbidden"],
    ];

    for (const [id, needle, replacement, code] of cases) {
      const root = await temporaryRoot();
      const directory = await initializedBundle(root, id);
      const documentPath = resolve(directory, "book.html");
      const document = await Bun.file(documentPath).text();
      await Bun.write(documentPath, document.replace(needle, replacement));
      await expectContractCode(validateBundleInput(directory), code);
    }
  });

  test("afviser data-CSS og eksterne imports i strikte stylesheets", async () => {
    const cases = [
      ["data-css-import", '@import "data:text/css,body%7Bcolor:red%7D";', "data_css_reference_forbidden"],
      ["external-css-import", '@import url("https://example.test/book.css");', "external_reference_forbidden"],
    ];

    for (const [id, stylesheet, code] of cases) {
      const root = await temporaryRoot();
      const directory = await initializedBundle(root, id);
      await Bun.write(resolve(directory, "book.css"), stylesheet);
      await expectContractCode(validateBundleInput(directory), code);
    }
  });

  test("afviser et ikke-præpagineret dokument", async () => {
    const root = await temporaryRoot();
    const directory = await initializedBundle(root);
    await Bun.write(resolve(directory, "book.html"), '<!doctype html><html><body><p data-book-anchor="x" data-annotation-text>Tekst</p></body></html>');

    await expectContractCode(validateBundleInput(directory), "document_contract_invalid");
  });

  test("afviser en fil der ikke er et gzip-komprimeret tar-arkiv", async () => {
    const root = await temporaryRoot();
    const archivePath = resolve(root, "not-an-archive.tar.gz");
    await Bun.write(archivePath, "ikke et arkiv");

    await expectContractCode(validateBookBundleArchive(archivePath), "archive_not_gzip");
  });

  test("stopper et gzip-arkiv ved den streamede kompressionsgrænse", async () => {
    const root = await temporaryRoot();
    const archivePath = resolve(root, "compression-bomb.tar.gz");
    await Bun.write(archivePath, Bun.gzipSync(new Uint8Array(9 * 1024 * 1024)));

    await expectContractCode(validateBookBundleArchive(archivePath), "archive_decompression_limit_exceeded");
  });
});
