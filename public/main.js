import { AnnotationApi } from "./annotations/annotation-api.js";
import { AnnotationController } from "./annotations/annotation-controller.js";
import { AnnotationPanel } from "./annotations/annotation-panel.js";
import { NavigationController } from "./navigation/navigation-controller.js";
import { BookReader } from "./reader/book-reader.js";

async function fetchConfig() {
  const response = await fetch("/api/config", { headers: { Accept: "application/json" } });
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

  const reader = new BookReader({
    frame: document.querySelector("#bookFrame"),
    viewport: document.querySelector("#viewport"),
    bookUrl: config.book.documentUrl,
    paginationTimeoutMs: config.book.paginationTimeoutMs,
  });
  const panel = new AnnotationPanel();
  const navigation = new NavigationController({
    reader,
    navigationUrl: config.book.navigationUrl,
    onOpen: () => panel.close(),
  });
  panel.panelButton.addEventListener("click", () => navigation.close());
  const annotations = new AnnotationController({
    api: new AnnotationApi(),
    panel,
    reader,
    bookId: config.book.id,
  });

  await reader.start();
  await Promise.all([annotations.start(), navigation.start()]);
} catch (error) {
  showStartupError(error);
  console.error(error);
}
