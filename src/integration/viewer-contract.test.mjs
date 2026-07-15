import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

const publicRoot = new URL("../../public/", import.meta.url);
const exampleBook = new URL("../../example/book/book.html", import.meta.url);

test("viewer shell exposes every control required by the annotation controller", async () => {
  const html = await readFile(new URL("index.html", publicRoot), "utf8");
  const requiredIds = [
    "bookFrame",
    "annotationPanelButton",
    "elementModeButton",
    "pageAnnotationButton",
    "selectionAction",
    "annotationPanel",
    "annotationForm",
    "annotationList",
    "importInput",
    "navigationPanelButton",
    "navigationPanel",
    "navigationSearch",
    "pageJumpInput",
    "pageScrubber",
    "annotationCategory",
    "readingTrackingToggle",
    "markCompleteButton",
    "passwordForm",
  ];
  for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`));
});

test("admin share center exposes complete access, secret-copy and triage states", async () => {
  const html = await readFile(new URL("admin/index.html", publicRoot), "utf8");
  const controller = await readFile(new URL("admin/admin.js", publicRoot), "utf8");
  for (const id of ["accessForm", "accessProfile", "capabilityPreview", "readerUrl", "invitationSecret", "annotationFilters", "passwordForm"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(controller, /copy-invitation-link/);
  assert.match(controller, /save-annotation/);
  assert.match(controller, /state\.metadata\.accessProfiles/);
  assert.match(controller, /Ingen annotationer matcher filtrene/);
});

test("reader progress separates position, engagement, completion and tracking consent", async () => {
  const main = await readFile(new URL("main.js", publicRoot), "utf8");
  assert.match(main, /progressPayload\(detail, "position"\)/);
  assert.match(main, /event: "engaged"/);
  assert.match(main, /event: "complete"/);
  assert.match(main, /setPreference/);
  assert.match(main, /8_000/);
});

test("viewer navigation is generic and resolves destinations against Paged.js pages", async () => {
  const controller = await readFile(new URL("navigation/navigation-controller.js", publicRoot), "utf8");
  const reader = await readFile(new URL("reader/book-reader.js", publicRoot), "utf8");
  assert.match(controller, /navigationUrl/);
  assert.match(controller, /pageNumberForTarget/);
  assert.doesNotMatch(controller, /Hávamál|stanza|vers-/i);
  assert.match(reader, /querySelectorAll\("\.pagedjs_page"\)/);
  assert.match(reader, /goToTarget/);
});

test("example book fulfills the page and stable-anchor contract", async () => {
  const html = await readFile(exampleBook, "utf8");
  assert.match(html, /data-paged-complete="true"/);
  assert.equal((html.match(/<section class="pagedjs_page/g) ?? []).length, 3);
  assert.ok((html.match(/data-book-anchor=/g) ?? []).length >= 6);
  assert.ok((html.match(/data-annotation-text/g) ?? []).length >= 3);
});

test("runtime targeting expands annotations beyond explicitly marked book elements", async () => {
  const targeting = await readFile(new URL("annotations/annotatable-elements.js", publicRoot), "utf8");
  const controller = await readFile(new URL("annotations/annotation-controller.js", publicRoot), "utf8");
  const frameStyles = await readFile(new URL("book-frame.css", publicRoot), "utf8");
  assert.match(targeting, /page-furniture/);
  assert.match(targeting, /prepareAnnotatableElements/);
  assert.match(controller, /viewerAnchorSelector/);
  assert.match(controller, /viewerTextScopeSelector/);
  assert.match(frameStyles, /data-viewer-anchor/);
  assert.match(frameStyles, /user-select: text/);
});

test("viewer UI uses only bundled font assets", async () => {
  const html = await readFile(new URL("index.html", publicRoot), "utf8");
  const viewerStyles = await readFile(new URL("viewer.css", publicRoot), "utf8");
  assert.match(html, /href="\/favicon\.svg"/);
  assert.match(viewerStyles, /\/runtime\/fonts\/source-serif-4/);
  assert.doesNotMatch(viewerStyles, /file:/i);
  assert.doesNotMatch(viewerStyles, /local\(/i);
});
