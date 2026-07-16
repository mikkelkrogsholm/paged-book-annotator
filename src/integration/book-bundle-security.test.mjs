import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { packBookBundleDirectory } from "./book-bundle-archive.mjs";
import { BookBundleContractError, validateBookBundleDirectory } from "./book-bundle-contract.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bundle(id) {
  const root = await mkdtemp(resolve(tmpdir(), "pba-bundle-security-"));
  temporaryRoots.push(root);
  const directory = resolve(root, "bundle");
  await mkdir(directory);
  await Bun.write(resolve(directory, "book-viewer.json"), JSON.stringify({
    schemaVersion: 1,
    book: { id, title: "Security fixture", document: "book.html" },
  }));
  await Bun.write(resolve(directory, "book.html"), [
    "<!doctype html>",
    '<html data-paged-complete="true">',
    "<head><meta charset=\"utf-8\"><title>Security fixture</title></head>",
    '<body data-pre-paginated="true">',
    '<main class="pagedjs_pages"><section class="pagedjs_page">',
    '<p data-book-anchor="p-1" data-annotation-text>Tekst.</p>',
    "</section></main></body></html>",
  ].join(""));
  return { root, directory, documentPath: resolve(directory, "book.html") };
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

test("bundle contract rejects browser-active alias file types", async () => {
  for (const extension of [".htm", ".shtml", ".svgz", ".xml", ".xsl"]) {
    const fixture = await bundle(`active-${extension.slice(1)}`);
    await Bun.write(resolve(fixture.directory, `payload${extension}`), "<script>alert(1)</script>");
    await expectContractCode(validateBookBundleDirectory(fixture.directory), "active_file_forbidden");
  }
});

test("bundle contract rejects entity, data and unquoted URL bypasses", async () => {
  const cases = [
    ["entity-javascript", "</body>", '<a href="jav&#x61;script:alert(1)">Klik</a></body>', "active_markup_forbidden"],
    ["entity-refresh", "</head>", '<meta http-equiv="&#114;efresh" content="0;url=/api/books"></head>', "active_markup_forbidden"],
    ["data-document", "</body>", '<a href="data:text/html,%3Cscript%3Ealert(1)%3C/script%3E">Klik</a></body>', "data_reference_forbidden"],
    ["unquoted-external", "</body>", "<img src=https://example.test/tracker.png></body>", "external_reference_forbidden"],
  ];
  for (const [id, needle, replacement, code] of cases) {
    const fixture = await bundle(id);
    const document = await Bun.file(fixture.documentPath).text();
    await Bun.write(fixture.documentPath, document.replace(needle, replacement));
    await expectContractCode(validateBookBundleDirectory(fixture.directory), code);
  }
});

test("bundle CSS contract resolves escapes and rejects unenumerated image candidates", async () => {
  const cases = [
    ["escaped-import", '@\\69mport url("\\68ttps://example.test/book.css");', "external_reference_forbidden"],
    ["commented-import", '@import/**/url("https://example.test/book.css");', "external_reference_forbidden"],
    ["image-set", 'body { background-image: image-set("https://example.test/cover.png" 1x); }', "css_image_set_forbidden"],
  ];
  for (const [id, stylesheet, code] of cases) {
    const fixture = await bundle(id);
    await Bun.write(resolve(fixture.directory, "book.css"), stylesheet);
    await expectContractCode(validateBookBundleDirectory(fixture.directory), code);
  }
});

test("bundle contract permits raster data images and pack writes mode 0600", async () => {
  const fixture = await bundle("passive-raster");
  const document = await Bun.file(fixture.documentPath).text();
  await Bun.write(fixture.documentPath, document.replace("</body>", '<img alt="" src="data:image/png;base64,AA=="></body>'));
  await expect(validateBookBundleDirectory(fixture.directory)).resolves.toMatchObject({ manifest: { book: { id: "passive-raster" } } });

  const archivePath = resolve(fixture.root, "book.tar.gz");
  await packBookBundleDirectory(fixture.directory, archivePath);
  expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
});
