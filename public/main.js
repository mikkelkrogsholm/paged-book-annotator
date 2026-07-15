import { AnnotationApi } from "./annotations/annotation-api.js";
import { AnnotationController } from "./annotations/annotation-controller.js";
import { AnnotationPanel } from "./annotations/annotation-panel.js";
import { AuthController } from "./auth/auth-controller.js";
import { NavigationController } from "./navigation/navigation-controller.js";
import { BookReader } from "./reader/book-reader.js";
import { ProgressClient } from "./reader/progress-client.js";

const bookRoute = window.location.pathname.match(/^\/books\/([^/]+)\/?$/);
const routeBookId = bookRoute ? decodeURIComponent(bookRoute[1]) : "";
const apiBase = routeBookId ? `/api/books/${encodeURIComponent(routeBookId)}` : "/api";

async function fetchConfig() {
  const response = await fetch(`${apiBase}/config`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Kunne ikke hente viewer-konfigurationen (${response.status}).`);
  return response.json();
}

function applyBookIdentity(config) {
  document.documentElement.lang = config.book.language;
  document.title = `${config.book.title} · Book Viewer`;
  document.querySelector("#bookTitle").textContent = config.book.title;
  document.querySelector("#bookSubtitle").textContent = config.book.subtitle;
  document.querySelector("#bookMark").textContent = config.book.mark;
  document.querySelector("#loadingMark").textContent = config.book.mark;
  document.querySelector("#bookFrame").title = config.book.title;
}

function showStartupError(error) {
  document.querySelector("#loadingMessage").textContent = error.message;
  const status = document.querySelector("#renderStatus");
  status.classList.add("has-error");
  status.querySelector("span").textContent = "Bogen kunne ikke åbnes";
}

try {
  const config = await fetchConfig();
  applyBookIdentity(config);
  const capabilities = config.session.capabilities;
  new AuthController({ session: config.session, registration: capabilities.registration, bookId: config.book.id });

  if (!capabilities.canRead) {
    document.querySelector("#accessGate").hidden = false;
    document.querySelector("#readerShell").hidden = true;
    document.querySelector(".control-shell").hidden = true;
    document.querySelector("#renderStatus span").textContent = "Login kræves";
    throw new Error("Log ind for at åbne bogen.");
  }

  const showsAnnotations = capabilities.canViewAnnotations || capabilities.canCreateAnnotations;
  document.querySelector("#annotationPanelButton").hidden = !showsAnnotations;
  document.querySelector("#elementModeButton").hidden = !capabilities.canCreateAnnotations;
  document.querySelector("#pageAnnotationButton").hidden = !capabilities.canCreateAnnotations;
  document.querySelector("#selectionAction").hidden = true;

  const reader = new BookReader({
    frame: document.querySelector("#bookFrame"),
    viewport: document.querySelector("#viewport"),
    bookUrl: config.book.documentUrl,
    paginationTimeoutMs: config.book.paginationTimeoutMs,
  });
  const panel = new AnnotationPanel({ capabilities, principal: config.session.principal });
  const navigation = new NavigationController({
    reader,
    navigationUrl: config.book.navigationUrl,
    onOpen: () => panel.close(),
  });
  panel.panelButton.addEventListener("click", () => navigation.close());
  const annotations = new AnnotationController({
    api: new AnnotationApi({ baseUrl: `${apiBase}/annotations` }),
    panel,
    reader,
    bookId: config.book.id,
    capabilities,
    principal: config.session.principal,
  });

  const progressClient = new ProgressClient({ baseUrl: `${apiBase}/progress` });
  const progressEnabled = capabilities.progressTracking !== "off";
  const preference = progressEnabled ? await progressClient.getPreference() : { trackingEnabled: false };
  let trackingEnabled = preference.trackingEnabled;
  const trackingToggle = document.querySelector("#readingTrackingToggle");
  trackingToggle.checked = trackingEnabled;
  trackingToggle.addEventListener("change", async () => {
    trackingToggle.disabled = true;
    try {
      trackingEnabled = (await progressClient.setPreference(trackingToggle.checked)).trackingEnabled;
      if (!trackingEnabled) { window.clearTimeout(positionTimer); window.clearTimeout(engagementTimer); latestProgress = null; }
      else if (reader.ready) observeProgress({ pageNumbers: reader.currentPageNumbers(), anchor: reader.currentPrimaryAnchor() });
    }
    catch (error) { trackingToggle.checked = trackingEnabled; console.warn(error); }
    finally { trackingToggle.disabled = false; }
  });
  const priorProgress = progressEnabled && trackingEnabled ? await progressClient.get() : null;
  if (priorProgress?.pageNumber && !window.location.hash) window.location.hash = `page=${priorProgress.pageNumber}`;
  let trackingReady = false;
  let positionTimer = null;
  let engagementTimer = null;
  let latestProgress = null;
  const progressPayload = (detail, event) => {
    const lastPage = detail.pageNumbers.at(-1) ?? 1;
    return { anchorId: detail.anchor, pageNumber: detail.pageNumbers[0] ?? 1, percent: Math.round(lastPage / Math.max(1, reader.pages.length) * 1000) / 10, buildId: config.book.buildId, event };
  };
  const observeProgress = (detail) => {
    if (!trackingReady || !progressEnabled || !trackingEnabled || !detail.anchor) return;
    latestProgress = progressPayload(detail, "position");
    window.clearTimeout(positionTimer); window.clearTimeout(engagementTimer);
    positionTimer = window.setTimeout(() => progressClient.save(latestProgress).catch((error) => console.warn(error)), 350);
    engagementTimer = window.setTimeout(() => progressClient.save({ ...latestProgress, event: "engaged" }).catch((error) => console.warn(error)), 8_000);
  };
  reader.addEventListener("pagechange", (event) => observeProgress(event.detail));
  document.querySelector("#markCompleteButton").addEventListener("click", async () => {
    if (!latestProgress || !trackingEnabled) return;
    try { await progressClient.save({ ...latestProgress, event: "complete", percent: 100 }); document.querySelector("#markCompleteButton").textContent = "Markeret som læst"; }
    catch (error) { console.warn(error); }
  });

  await reader.start();
  trackingReady = true;
  if (priorProgress?.anchorId) reader.goToTarget(priorProgress.anchorId);
  observeProgress({ pageNumbers: reader.currentPageNumbers(), anchor: reader.currentPrimaryAnchor() });
  await Promise.all([showsAnnotations ? annotations.start() : Promise.resolve(), navigation.start()]);
} catch (error) {
  if (!document.querySelector("#accessGate")?.hidden) console.info(error.message);
  else showStartupError(error);
  console.error(error);
}
