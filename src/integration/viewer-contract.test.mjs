import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";

const publicRoot = new URL("../../public/", import.meta.url);
const exampleBook = new URL("../../example/book/book.html", import.meta.url);

test("viewer shell exposes every control required by the annotation controller", async () => {
  const html = await readFile(new URL("index.html", publicRoot), "utf8");
  const styles = await readFile(new URL("viewer.css", publicRoot), "utf8");
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
    "surveyPanelButton",
    "surveyPanel",
    "surveyForm",
  ];
  for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`));
  for (const label of ["Indhold", "Kommentarer", "Feedback"]) {
    assert.match(html, new RegExp(`aria-label="${label}"`));
  }
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("book content is isolated in a passive same-origin sandbox", async () => {
  const viewer = await readFile(new URL("index.html", publicRoot), "utf8");
  assert.match(viewer, /<iframe[^>]+id="bookFrame"[^>]+sandbox="allow-same-origin"/);
  assert.doesNotMatch(viewer, /sandbox="[^"]*allow-scripts/);
});

test("admin share center exposes complete access, secret-copy and triage states", async () => {
  const html = await readFile(new URL("admin/index.html", publicRoot), "utf8");
  const controller = await readFile(new URL("admin/admin.js", publicRoot), "utf8");
  const styles = await readFile(new URL("admin/admin.css", publicRoot), "utf8");
  for (const id of ["accessForm", "accessProfile", "capabilityPreview", "readerUrl", "invitationSecret", "annotationFilters", "passwordForm", "surveyBuilderForm", "surveyQuestionBuilder", "surveysTable", "surveyResponsesTable", "reviewExportLink"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(controller, /copy-invitation-link/);
  assert.match(controller, /save-annotation/);
  assert.match(controller, /state\.metadata\.accessProfiles/);
  assert.match(controller, /Ingen annotationer matcher filtrene/);
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test("async UI actions retain their form or button across awaits", async () => {
  const admin = await readFile(new URL("admin/admin.js", publicRoot), "utf8");
  const reader = await readFile(new URL("main.js", publicRoot), "utf8");
  const auth = await readFile(new URL("auth/auth-controller.js", publicRoot), "utf8");
  assert.doesNotMatch(admin, /setFormBusy\(event\.currentTarget/);
  assert.doesNotMatch(admin, /await[^\n]*event\.currentTarget/);
  assert.doesNotMatch(reader, /await[^\n]*event\.currentTarget/);
  assert.doesNotMatch(auth, /await confirmUiAction\([^\n]+\)[\s\S]{0,200}event\.currentTarget/);
  assert.match(admin, /const form = event\.currentTarget/);
  assert.match(reader, /const button = event\.currentTarget/);
  assert.match(auth, /const button = event\.currentTarget/);
});

test("an empty managed library remains an interactive authentication state", async () => {
  const html = await readFile(new URL("index.html", publicRoot), "utf8");
  const reader = await readFile(new URL("main.js", publicRoot), "utf8");
  const auth = await readFile(new URL("auth/auth-controller.js", publicRoot), "utf8");
  const admin = await readFile(new URL("admin/admin.js", publicRoot), "utf8");
  assert.match(html, /id="emptyLibrary"/);
  assert.match(reader, /bookId: config\.book\?\.id \?\? ""/);
  assert.match(reader, /if \(!config\.book\)[\s\S]*showEmptyLibrary\(config\)/);
  assert.match(auth, /emptyLibraryLoginButton/);
  assert.match(auth, /principal\?\.kind === "guest" \? "Log ind"/);
  assert.match(admin, /if \(!hasAdminAccess\(\)\)/);
  assert.match(admin, /selectActiveBookId\(state\.books, requested\)/);
  assert.doesNotMatch(admin, /state\.books\[0\]\?\.id/);
  assert.match(admin, /can\("surveys:manage"\) && Boolean\(state\.book\.activeRevisionId\).*path\("outline"\)/);
});

test("destructive and publishing actions use an accessible application confirmation", async () => {
  const readerHtml = await readFile(new URL("index.html", publicRoot), "utf8");
  const adminHtml = await readFile(new URL("admin/index.html", publicRoot), "utf8");
  const auth = await readFile(new URL("auth/auth-controller.js", publicRoot), "utf8");
  const annotations = await readFile(new URL("annotations/annotation-panel.js", publicRoot), "utf8");
  const admin = await readFile(new URL("admin/admin.js", publicRoot), "utf8");
  assert.match(readerHtml, /id="confirmationDialog"/);
  assert.match(adminHtml, /id="confirmationDialog"/);
  for (const controller of [auth, annotations, admin]) {
    assert.match(controller, /confirmUiAction/);
    assert.doesNotMatch(controller, /(?:window\.)?confirm\(/);
  }
});

test("async UI completions stay bound to their originating book, survey and annotation draft", async () => {
  const admin = await readFile(new URL("admin/admin.js", publicRoot), "utf8");
  const surveys = await readFile(new URL("surveys/survey-controller.js", publicRoot), "utf8");
  const annotations = await readFile(new URL("annotations/annotation-panel.js", publicRoot), "utf8");
  const auth = await readFile(new URL("auth/auth-controller.js", publicRoot), "utf8");
  const styles = await readFile(new URL("viewer.css", publicRoot), "utf8");
  assert.match(admin, /const actionBookId = state\.bookId/);
  assert.match(admin, /workspace\.inert = true/);
  assert.match(admin, /bookPath\("members", actionBookId\)/);
  assert.match(surveys, /const active = this\.active/);
  assert.match(surveys, /const submitIntentId = this\.intentId/);
  assert.match(surveys, /this\.intentId === submitIntentId/);
  assert.match(annotations, /intentId: this\.composerIntentId/);
  assert.match(annotations, /this\.composerIntentId === operation\.intentId/);
  assert.match(annotations, /close\([\s\S]*?this\.composerIntentId \+= 1/);
  assert.match(annotations, /if \(!this\.saving\) this\.composerIntentId \+= 1/);
  assert.match(annotations, /this\.comment\.disabled = saving/);
  assert.match(auth, /this\.show\(principal\?\.kind === "user" \? "password" : "login"\)/);
  assert.match(styles, /auth-tabs button\[aria-selected="true"\]/);
});

test("reader surveys trigger after a stable anchor is left and keep skip state client-side", async () => {
  const controller = await readFile(new URL("surveys/survey-controller.js", publicRoot), "utf8");
  assert.match(controller, /targetWasLeft\(definition, previousAnchors, anchors\)/);
  assert.match(controller, /publishedVersion/);
  assert.match(controller, /sessionStorage/);
  assert.match(controller, /\[1, 2, 3, 4, 5\]/);
  assert.doesNotMatch(controller, /impression|dismissal/i);
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
