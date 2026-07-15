export class BookReader extends EventTarget {
  constructor({ frame, viewport, bookUrl, paginationTimeoutMs = 45_000 }) {
    super();
    this.frame = frame;
    this.viewport = viewport;
    this.bookUrl = bookUrl;
    this.paginationTimeoutMs = paginationTimeoutMs;
    this.mobileQuery = window.matchMedia("(max-width: 900px)");
    this.document = null;
    this.root = null;
    this.pages = [];
    this.units = [];
    this.current = 0;
    this.pageWidth = 0;
    this.pageHeight = 0;
    this.zoom = 1;
    this.single = this.mobileQuery.matches;
    this.ready = false;
    this.readerCssPromise = fetch("/book-frame.css").then((response) => {
      if (!response.ok) throw new Error(`Kunne ikke hente bogrammens typografi (${response.status}).`);
      return response.text();
    });
  }

  async start() {
    this.bindViewerControls();
    const loaded = new Promise((resolveLoad, rejectLoad) => {
      const timeout = window.setTimeout(
        () => rejectLoad(new Error(`Bogen blev ikke pagineret inden for ${Math.ceil(this.paginationTimeoutMs / 1000)} sekunder.`)),
        this.paginationTimeoutMs + 5_000,
      );
      this.frame.addEventListener("load", () => {
        this.prepareBook().then(() => {
          window.clearTimeout(timeout);
          resolveLoad();
        }, rejectLoad);
      }, { once: true });
    });
    this.frame.src = this.bookUrl;
    return loaded;
  }

  async waitForPagination() {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.paginationTimeoutMs) {
      const document = this.frame.contentDocument;
      const pages = [...document.querySelectorAll(".pagedjs_page")];
      if (pages.length > 0 && (document.documentElement.dataset.pagedComplete === "true" || document.body.dataset.prePaginated === "true")) {
        return pages;
      }
      await new Promise((resolveWait) => window.setTimeout(resolveWait, 80));
    }
    throw new Error("Bogens sider blev ikke færdige.");
  }

  async prepareBook() {
    const pages = await this.waitForPagination();
    const document = this.frame.contentDocument;
    const firstRect = pages[0].getBoundingClientRect();
    this.document = document;
    this.pages = pages;
    this.pageWidth = firstRect.width;
    this.pageHeight = firstRect.height;
    this.root = document.querySelector(".pagedjs_pages");

    const readerStyle = document.createElement("style");
    readerStyle.id = "book-viewer-frame-styles";
    readerStyle.textContent = await this.readerCssPromise;
    document.head.append(readerStyle);
    this.root.classList.add("reader-root");
    this.ready = true;

    this.buildUnits();
    this.bindBookGestures();
    this.frame.classList.add("is-ready");
    document.querySelectorAll(".pagedjs_page").forEach((page, index) => {
      page.dataset.bookPageNumber = String(index + 1);
    });
    const scrubber = window.document.querySelector("#pageScrubber");
    scrubber.max = String(this.pages.length);
    scrubber.disabled = this.pages.length < 2;

    document.querySelector("#loading")?.remove();
    window.document.querySelector("#loading").classList.add("is-hidden");
    const renderStatus = window.document.querySelector("#renderStatus");
    renderStatus.classList.add("is-ready");
    renderStatus.querySelector("span").textContent = this.single ? "Enkeltside" : "Opslag klar";
    this.dispatchEvent(new CustomEvent("ready", { detail: { pages: this.pages.length } }));
  }

  pageNumber(page) {
    return this.pages.indexOf(page) + 1;
  }

  createSlot(side, page) {
    const slot = this.document.createElement("div");
    slot.className = `page-slot page-slot-${side}${page ? "" : " is-empty"}`;
    if (page) slot.append(page);
    return slot;
  }

  buildUnits({ preservePage = null } = {}) {
    this.pages.forEach((page) => page.remove());
    this.root.replaceChildren();
    this.units = [];

    const groups = this.single
      ? this.pages.map((page) => [page])
      : [[null, this.pages[0]], ...Array.from(
        { length: Math.ceil((this.pages.length - 1) / 2) },
        (_, index) => [this.pages[1 + index * 2] ?? null, this.pages[2 + index * 2] ?? null],
      )];

    groups.forEach((group, index) => {
      const unit = this.document.createElement("section");
      unit.className = `reader-unit${this.single ? " is-single" : ""}`;
      unit.dataset.index = String(index);
      if (this.single) unit.append(this.createSlot("single", group[0]));
      else unit.append(this.createSlot("left", group[0]), this.createSlot("right", group[1]));
      this.root.append(unit);
      this.units.push(unit);
    });

    const requestedPage = preservePage ?? this.pageFromHash();
    const matchingIndex = requestedPage == null ? -1 : this.unitIndexForPage(requestedPage);
    const spreadMatch = window.location.hash.match(/spread=(\d+)/);
    this.current = matchingIndex >= 0
      ? matchingIndex
      : spreadMatch
        ? Math.max(0, Math.min(this.units.length - 1, Number(spreadMatch[1]) - 1))
        : 0;
    this.units[this.current]?.classList.add("is-active");
    this.updateScale();
    this.updateControls();
  }

  pageFromHash() {
    const match = window.location.hash.match(/page=(\d+)/);
    return match ? Number(match[1]) : null;
  }

  unitIndexForPage(pageNumber) {
    return this.units.findIndex((unit) => this.unitPageNumbers(unit).includes(pageNumber));
  }

  currentPageNumbers() {
    return this.unitPageNumbers(this.units[this.current]);
  }

  currentPrimaryAnchor() {
    const unit = this.units[this.current];
    const activeContent = unit?.querySelector("[data-book-anchor]");
    return activeContent?.dataset.bookAnchor ?? "";
  }

  getPageByNumber(pageNumber) {
    return this.pages[pageNumber - 1] ?? null;
  }

  pageNumberForElement(element) {
    const page = element?.closest?.(".pagedjs_page");
    return page ? this.pageNumber(page) : null;
  }

  pageNumberForTarget(target) {
    if (!target || !this.document) return null;
    const escaped = this.document.defaultView.CSS.escape(target);
    const element = this.document.getElementById(target)
      ?? this.document.querySelector(`[data-book-anchor="${escaped}"]`);
    return this.pageNumberForElement(element);
  }

  goToTarget(target) {
    const pageNumber = this.pageNumberForTarget(target);
    if (pageNumber == null) return false;
    this.goToPageNumber(pageNumber);
    return true;
  }

  goToPageNumber(pageNumber) {
    const unitIndex = this.unitIndexForPage(pageNumber);
    if (unitIndex >= 0) this.goTo(unitIndex);
  }

  unitPageNumbers(unit) {
    if (!unit) return [];
    return [...unit.querySelectorAll(".pagedjs_page")].map((page) => this.pageNumber(page)).filter(Boolean);
  }

  updateScale() {
    if (!this.ready) return;
    const availableWidth = Math.max(1, this.frame.clientWidth - (this.single ? 24 : 58));
    const availableHeight = Math.max(1, this.frame.clientHeight - 28);
    const unitWidth = this.pageWidth * (this.single ? 1 : 2);
    const fit = Math.min(availableWidth / unitWidth, availableHeight / this.pageHeight);
    const scale = Math.min(1.18, fit * this.zoom);
    this.document.documentElement.style.setProperty("--page-width", `${this.pageWidth}px`);
    this.document.documentElement.style.setProperty("--page-height", `${this.pageHeight}px`);
    this.document.documentElement.style.setProperty("--unit-width", `${unitWidth}px`);
    this.document.documentElement.style.setProperty("--reader-scale", scale.toFixed(4));
    document.querySelector("#zoomLabel").textContent = this.zoom === 1 ? "Tilpas" : `${Math.round(this.zoom * 100)}%`;
  }

  updateControls() {
    const unit = this.units[this.current];
    const numbers = this.unitPageNumbers(unit);
    const content = unit?.querySelector("[data-book-page-label], [data-book-anchor]");
    const label = content?.dataset.bookPageLabel || content?.dataset.bookLabel || "Bog";
    document.querySelector("#spreadLabel").textContent = numbers.length === 1 && numbers[0] === 1 ? "Forside" : label;
    document.querySelector("#pageLabel").textContent = numbers.length > 1 ? `Side ${numbers[0]}–${numbers.at(-1)}` : `Side ${numbers[0]}`;
    const scrubber = document.querySelector("#pageScrubber");
    scrubber.value = String(numbers[0] ?? 1);
    scrubber.title = numbers.length > 1 ? `Side ${numbers[0]}–${numbers.at(-1)}` : `Side ${numbers[0]}`;
    document.querySelector("#prevButton").disabled = this.current === 0;
    document.querySelector("#pageHitPrev").disabled = this.current === 0;
    document.querySelector("#nextButton").disabled = this.current === this.units.length - 1;
    document.querySelector("#pageHitNext").disabled = this.current === this.units.length - 1;
    history.replaceState(null, "", `#${this.single ? "page" : "spread"}=${this.current + 1}`);
    this.dispatchEvent(new CustomEvent("pagechange", { detail: { pageNumbers: numbers, anchor: this.currentPrimaryAnchor() } }));
  }

  goTo(index) {
    const nextIndex = Math.max(0, Math.min(this.units.length - 1, index));
    if (!this.ready || nextIndex === this.current) return;
    const direction = nextIndex > this.current ? 1 : -1;
    const currentUnit = this.units[this.current];
    const nextUnit = this.units[nextIndex];
    currentUnit.classList.remove("is-active");
    currentUnit.classList.add(direction > 0 ? "is-leaving-left" : "is-leaving-right");
    if (direction < 0) nextUnit.classList.add("enter-from-left");
    this.document.defaultView.requestAnimationFrame(() => {
      nextUnit.classList.add("is-active");
      nextUnit.classList.remove("enter-from-left");
    });
    window.setTimeout(() => currentUnit.classList.remove("is-leaving-left", "is-leaving-right"), 760);
    this.current = nextIndex;
    this.updateControls();
  }

  setZoom(nextZoom) {
    this.zoom = Math.max(0.72, Math.min(1.28, nextZoom));
    this.updateScale();
  }

  bindBookGestures() {
    let startX = null;
    let startY = null;
    this.document.body.addEventListener("pointerdown", (event) => {
      startX = event.clientX;
      startY = event.clientY;
    });
    this.document.body.addEventListener("pointerup", (event) => {
      if (startX == null || startY == null) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      startX = null;
      startY = null;
      if (!this.document.getSelection().isCollapsed) return;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      this.goTo(this.current + (dx < 0 ? 1 : -1));
    });
  }

  bindViewerControls() {
    document.querySelector("#prevButton").addEventListener("click", () => this.goTo(this.current - 1));
    document.querySelector("#nextButton").addEventListener("click", () => this.goTo(this.current + 1));
    document.querySelector("#pageHitPrev").addEventListener("click", () => this.goTo(this.current - 1));
    document.querySelector("#pageHitNext").addEventListener("click", () => this.goTo(this.current + 1));
    document.querySelector("#zoomOutButton").addEventListener("click", () => this.setZoom(this.zoom - 0.08));
    document.querySelector("#zoomInButton").addEventListener("click", () => this.setZoom(this.zoom + 0.08));
    document.querySelector("#zoomResetButton").addEventListener("click", () => this.setZoom(1));
    document.querySelector("#fullscreenButton").addEventListener("click", async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    });
    document.querySelector("#pageScrubber").addEventListener("input", (event) => {
      this.goToPageNumber(Number(event.target.value));
    });

    document.addEventListener("keydown", (event) => {
      if (event.target.matches("textarea, input")) return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") this.goTo(this.current - 1);
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") this.goTo(this.current + 1);
      if (event.key === "Home") this.goTo(0);
      if (event.key === "End") this.goTo(this.units.length - 1);
      if (event.key === "+" || event.key === "=") this.setZoom(this.zoom + 0.08);
      if (event.key === "-") this.setZoom(this.zoom - 0.08);
    });

    new ResizeObserver(() => this.updateScale()).observe(this.viewport);
    this.mobileQuery.addEventListener("change", (event) => {
      if (!this.ready) return;
      const anchor = this.currentPageNumbers()[0];
      this.single = event.matches;
      this.zoom = 1;
      this.buildUnits({ preservePage: anchor });
      document.querySelector("#renderStatus span").textContent = this.single ? "Enkeltside" : "Opslag klar";
    });
  }
}
