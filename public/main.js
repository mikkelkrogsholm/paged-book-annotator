import { AnnotationApi } from "./annotations/annotation-api.js";
import { AnnotationController } from "./annotations/annotation-controller.js";
import { AnnotationPanel } from "./annotations/annotation-panel.js";
import { AuthController } from "./auth/auth-controller.js";
import { NavigationController } from "./navigation/navigation-controller.js";
import { BookReader } from "./reader/book-reader.js";
import { ProgressClient } from "./reader/progress-client.js";
import { SurveyApi } from "./surveys/survey-api.js";
import { SurveyController } from "./surveys/survey-controller.js";
import { showUiToast } from "./ui-state.js";

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

function showFeatureError(message) {
  showUiToast(message, { error: true, duration: 4_200 });
}

class AccessGateError extends Error {}

try {
  const config = await fetchConfig();
  applyBookIdentity(config);
  const capabilities = config.session.capabilities;
  new AuthController({ session: config.session, registration: capabilities.registration, bookId: config.book.id });

  if (!capabilities.canRead) {
    document.querySelector("#accessGate").hidden = false;
    document.querySelector("#readerShell").hidden = true;
    document.querySelector(".control-shell").hidden = true;
    document.querySelector("#navigationPanelButton").hidden = true;
    document.querySelector("#annotationPanelButton").hidden = true;
    document.querySelector("#surveyPanelButton").hidden = true;
    document.querySelector("#renderStatus span").textContent = "Login kræves";
    throw new AccessGateError("Log ind for at åbne bogen.");
  }

  const showsAnnotations = capabilities.canViewAnnotations || capabilities.canCreateAnnotations;
  document.querySelector("#annotationPanelButton").hidden = !showsAnnotations;
  document.querySelector("#elementModeButton").hidden = !capabilities.canCreateAnnotations;
  document.querySelector("#pageAnnotationButton").hidden = !capabilities.canCreateAnnotations;
  document.querySelector("#selectionAction").hidden = true;
  document.querySelector("#surveyPanelButton").hidden = true;

  const reader = new BookReader({
    frame: document.querySelector("#bookFrame"),
    viewport: document.querySelector("#viewport"),
    bookUrl: config.book.documentUrl,
    paginationTimeoutMs: config.book.paginationTimeoutMs,
  });
  const panel = new AnnotationPanel({
    capabilities,
    principal: config.session.principal,
    exportUrl: `${apiBase}/annotations/export`,
  });
  const navigation = new NavigationController({
    reader,
    navigationUrl: config.book.navigationUrl,
    onOpen: () => panel.close({ restoreFocus: false }),
  });
  panel.panelButton.addEventListener("click", () => navigation.close({ restoreFocus: false }));
  const annotations = new AnnotationController({
    api: new AnnotationApi({ baseUrl: `${apiBase}/annotations` }),
    panel,
    reader,
    bookId: config.book.id,
    capabilities,
    principal: config.session.principal,
  });
  const surveys = new SurveyController({
    api: new SurveyApi({ baseUrl: `${apiBase}/surveys` }),
    reader,
    capabilities,
  });
  surveys.addEventListener("open", () => { panel.close({ restoreFocus: false }); navigation.close({ restoreFocus: false }); });
  panel.panelButton.addEventListener("click", () => surveys.close({ restoreFocus: false }));
  document.querySelector("#navigationPanelButton").addEventListener("click", () => surveys.close({ restoreFocus: false }));

  await reader.start();

  const progressClient = new ProgressClient({ baseUrl: `${apiBase}/progress` });
  const progressEnabled = capabilities.progressTracking !== "off";
  let trackingEnabled = false;
  let priorProgress = null;
  if (progressEnabled) {
    try {
      const preference = await progressClient.getPreference();
      trackingEnabled = preference.trackingEnabled;
      if (trackingEnabled) priorProgress = await progressClient.get();
    } catch (error) {
      console.warn(error);
      showFeatureError("Læsestatus er midlertidigt utilgængelig. Bogen kan stadig læses.");
    }
  }
  const trackingToggle = document.querySelector("#readingTrackingToggle");
  trackingToggle.checked = trackingEnabled;
  trackingToggle.closest(".tracking-preference").hidden = !progressEnabled;
  document.querySelector(".tracking-preference + small").hidden = !progressEnabled;
  document.querySelector("#markCompleteButton").hidden = !progressEnabled;
  let trackingReady = true;
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
  trackingToggle.addEventListener("change", async () => {
    trackingToggle.disabled = true;
    try {
      trackingEnabled = (await progressClient.setPreference(trackingToggle.checked)).trackingEnabled;
      if (!trackingEnabled) { window.clearTimeout(positionTimer); window.clearTimeout(engagementTimer); latestProgress = null; }
      else if (reader.ready) observeProgress({ pageNumbers: reader.currentPageNumbers(), anchor: reader.currentPrimaryAnchor() });
    }
    catch (error) { trackingToggle.checked = trackingEnabled; showFeatureError(error.message); }
    finally { trackingToggle.disabled = false; }
  });
  reader.addEventListener("pagechange", (event) => observeProgress(event.detail));
  document.querySelector("#markCompleteButton").addEventListener("click", async (event) => {
    if (!latestProgress || !trackingEnabled) return;
    const button = event.currentTarget;
    button.disabled = true;
    try { await progressClient.save({ ...latestProgress, event: "complete", percent: 100 }); button.textContent = "Markeret som læst"; }
    catch (error) { showFeatureError(error.message); button.disabled = false; }
  });

  if (priorProgress?.anchorId) reader.goToTarget(priorProgress.anchorId);
  else if (priorProgress?.pageNumber) reader.goToPageNumber(priorProgress.pageNumber);
  observeProgress({ pageNumbers: reader.currentPageNumbers(), anchor: reader.currentPrimaryAnchor() });
  const featureStarts = [
    { name: "Kommentarer", enabled: showsAnnotations, start: () => annotations.start() },
    { name: "Indholdsfortegnelsen", enabled: true, start: () => navigation.start() },
    { name: "Feedback", enabled: capabilities.canRespondToSurveys, start: () => surveys.start() },
  ].filter((feature) => feature.enabled);
  const results = await Promise.allSettled(featureStarts.map((feature) => feature.start()));
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    console.warn(result.reason);
    if (featureStarts[index].name === "Feedback") document.querySelector("#surveyPanelButton").hidden = true;
    showFeatureError(`${featureStarts[index].name} er midlertidigt utilgængelig. Bogen kan stadig læses.`);
  });
} catch (error) {
  if (error instanceof AccessGateError) console.info(error.message);
  else {
    showStartupError(error);
    console.error(error);
  }
}
