import { closeSidePanel, openSidePanel } from "../ui-state.js";

const EPUB_NAMESPACE = "http://www.idpf.org/2007/ops";

function navigationType(element) {
  return element.getAttributeNS(EPUB_NAMESPACE, "type") ?? element.getAttribute("epub:type") ?? "";
}

function directChild(element, localName) {
  return [...element.children].find((child) => child.localName === localName) ?? null;
}

export function targetFromHref(href) {
  const hashIndex = href.indexOf("#");
  return hashIndex >= 0 ? decodeURIComponent(href.slice(hashIndex + 1)) : "";
}

export function normalizedSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("da-DK")
    .replace(/[^a-z0-9æøå]+/g, " ")
    .trim();
}

function parseList(list, parent = null, path = []) {
  return [...list.children]
    .filter((child) => child.localName === "li")
    .map((item, index) => {
      const labelElement = [...item.children].find((child) => child.localName === "a" || child.localName === "span");
      if (!labelElement) throw new TypeError("Et navigationspunkt mangler a- eller span-label.");
      const label = labelElement.textContent.replace(/\s+/g, " ").trim();
      if (!label) throw new TypeError("Et navigationspunkt har en tom label.");
      const entry = {
        id: `${parent?.id ?? "root"}.${index + 1}`,
        label,
        href: labelElement.localName === "a" ? labelElement.getAttribute("href") ?? "" : "",
        target: labelElement.localName === "a" ? targetFromHref(labelElement.getAttribute("href") ?? "") : "",
        parent,
        path: [...path, label],
        children: [],
        pageNumber: null,
        row: null,
        branch: null,
        disclosure: null,
        group: null,
      };
      const nested = directChild(item, "ol");
      if (nested) entry.children = parseList(nested, entry, entry.path);
      return entry;
    });
}

function parseNavigationDocument(source) {
  const xml = new DOMParser().parseFromString(source, "application/xhtml+xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError) throw new TypeError(`Navigationsdokumentet er ikke gyldigt XHTML: ${parserError.textContent.trim()}`);
  const navigations = [...xml.querySelectorAll("nav")];
  const toc = navigations.find((element) => navigationType(element).split(/\s+/).includes("toc"));
  const landmarks = navigations.find((element) => navigationType(element).split(/\s+/).includes("landmarks"));
  if (!toc) throw new TypeError("Navigationsdokumentet mangler en indholdsfortegnelse.");
  const tocList = directChild(toc, "ol");
  if (!tocList) throw new TypeError("Indholdsfortegnelsen mangler et hierarkisk ol-element.");
  const landmarkList = landmarks ? directChild(landmarks, "ol") : null;
  return {
    toc: parseList(tocList),
    landmarks: landmarkList ? parseList(landmarkList) : [],
  };
}

function flatten(entries) {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children)]);
}

export function matchingNavigationEntries(entries, query) {
  const normalizedQuery = normalizedSearchText(query);
  if (!normalizedQuery) return [];
  return entries.filter((entry) => normalizedSearchText(
    `${entry.path.join(" ")} side ${entry.pageNumber}`,
  ).includes(normalizedQuery));
}

export function currentNavigationEntry(entries, pageNumbers) {
  if (entries.length === 0 || pageNumbers.length === 0) return null;
  const lastVisiblePage = pageNumbers.at(-1);
  return entries
    .filter((entry) => entry.pageNumber <= lastVisiblePage)
    .sort((left, right) => left.pageNumber - right.pageNumber || left.path.length - right.path.length)
    .at(-1) ?? null;
}

function iconButton(className, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  return button;
}

export class NavigationController {
  constructor({ reader, navigationUrl, onOpen = null }) {
    this.reader = reader;
    this.navigationUrl = navigationUrl;
    this.onOpen = onOpen;
    this.panel = document.querySelector("#navigationPanel");
    this.panelButton = document.querySelector("#navigationPanelButton");
    this.tree = document.querySelector("#navigationTree");
    this.results = document.querySelector("#navigationResults");
    this.search = document.querySelector("#navigationSearch");
    this.jumpForm = document.querySelector("#pageJumpForm");
    this.jumpInput = document.querySelector("#pageJumpInput");
    this.jumpError = document.querySelector("#pageJumpError");
    this.landmarks = document.querySelector("#navigationLandmarks");
    this.entries = [];
    this.linkEntries = [];
    this.returnFocus = null;
    this.bindShellEvents();
  }

  bindShellEvents() {
    this.panelButton.addEventListener("click", () => this.toggle());
    document.querySelector("#navigationPanelClose").addEventListener("click", () => this.close());
    document.querySelector("#positionButton").addEventListener("click", () => this.open());
    this.search.addEventListener("input", () => this.renderSearch());
    this.search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const first = this.results.querySelector("button[data-navigation-target]");
      if (first) {
        event.preventDefault();
        first.click();
      }
    });
    this.jumpForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const pageNumber = Number(this.jumpInput.value);
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > this.reader.pages.length) {
        this.showJumpError(`Skriv et sidetal mellem 1 og ${this.reader.pages.length}.`);
        return;
      }
      this.jumpError.hidden = true;
      this.reader.goToPageNumber(pageNumber);
      this.close();
    });
    this.reader.addEventListener("pagechange", (event) => this.updateCurrent(event.detail.pageNumbers));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.isOpen()) this.close();
      if (event.defaultPrevented || event.target?.closest?.("textarea, input, select, button, a, [contenteditable=true]")) return;
      if (event.key.toLocaleLowerCase("da-DK") === "g") {
        event.preventDefault();
        this.open({ focus: "jump" });
      }
    });
  }

  async start() {
    this.jumpInput.max = String(this.reader.pages.length);
    if (!this.navigationUrl) {
      this.showEmpty("Denne bog har ikke leveret en maskinlæsbar indholdsfortegnelse.");
      this.panelButton.disabled = true;
      return;
    }
    try {
      const response = await fetch(this.navigationUrl, { headers: { Accept: "application/xhtml+xml" } });
      if (!response.ok) throw new Error(`Kunne ikke hente indholdsfortegnelsen (${response.status}).`);
      const model = parseNavigationDocument(await response.text());
      this.entries = model.toc;
      this.linkEntries = flatten(this.entries).filter((entry) => entry.target);
      for (const entry of this.linkEntries) {
        entry.pageNumber = this.reader.pageNumberForTarget(entry.target);
      }
      const unresolved = this.linkEntries.filter((entry) => entry.pageNumber == null);
      if (unresolved.length > 0) {
        throw new Error(`${unresolved.length} navigationsmål findes ikke i Paged.js-outputtet.`);
      }
      this.renderTree();
      this.renderLandmarks(model.landmarks);
      document.querySelector("#navigationLoading").hidden = true;
      document.querySelector("#navigationBrowser").hidden = false;
      this.updateCurrent(this.reader.currentPageNumbers());
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  renderTree() {
    this.tree.replaceChildren(...this.entries.map((entry) => this.renderEntry(entry)));
  }

  renderEntry(entry) {
    const item = document.createElement("li");
    item.className = "navigation-item";
    const row = document.createElement("div");
    row.className = "navigation-row";
    entry.row = row;

    if (entry.children.length > 0) {
      const disclosure = iconButton("navigation-disclosure", `Fold ${entry.label} ud`);
      disclosure.setAttribute("aria-expanded", "false");
      disclosure.addEventListener("click", () => this.toggleBranch(entry));
      entry.disclosure = disclosure;
      row.append(disclosure);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "navigation-disclosure-spacer";
      row.append(spacer);
    }

    if (entry.target) {
      const destination = document.createElement("button");
      destination.type = "button";
      destination.className = "navigation-destination";
      destination.dataset.navigationTarget = entry.target;
      destination.textContent = entry.label;
      destination.addEventListener("click", () => this.navigate(entry));
      row.append(destination);
    } else {
      const group = document.createElement("button");
      group.type = "button";
      group.className = "navigation-group-label";
      group.textContent = entry.label;
      group.setAttribute("aria-expanded", "false");
      group.addEventListener("click", () => this.toggleBranch(entry));
      entry.group = group;
      row.append(group);
    }

    const page = document.createElement("span");
    page.className = "navigation-page-number";
    page.textContent = entry.pageNumber == null ? "" : String(entry.pageNumber);
    row.append(page);
    item.append(row);

    if (entry.children.length > 0) {
      const branch = document.createElement("ol");
      branch.className = "navigation-branch";
      branch.id = `navigation-branch-${entry.id.replaceAll(".", "-")}`;
      branch.hidden = true;
      branch.append(...entry.children.map((child) => this.renderEntry(child)));
      entry.branch = branch;
      entry.disclosure?.setAttribute("aria-controls", branch.id);
      entry.group?.setAttribute("aria-controls", branch.id);
      item.append(branch);
    }
    return item;
  }

  renderLandmarks(entries) {
    this.landmarks.replaceChildren();
    for (const entry of flatten(entries).filter((candidate) => candidate.target)) {
      entry.pageNumber = this.reader.pageNumberForTarget(entry.target);
      if (entry.pageNumber == null) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.label;
      button.addEventListener("click", () => this.navigate(entry));
      this.landmarks.append(button);
    }
    this.landmarks.hidden = this.landmarks.childElementCount === 0;
  }

  toggleBranch(entry, forceOpen = null) {
    if (!entry.branch) return;
    const open = forceOpen ?? entry.branch.hidden;
    entry.branch.hidden = !open;
    entry.disclosure?.setAttribute("aria-expanded", String(open));
    entry.disclosure?.setAttribute("aria-label", `Fold ${entry.label} ${open ? "sammen" : "ud"}`);
    entry.group?.setAttribute("aria-expanded", String(open));
  }

  navigate(entry) {
    if (!entry.target || !this.reader.goToTarget(entry.target)) return;
    this.close();
  }

  renderSearch() {
    const query = normalizedSearchText(this.search.value);
    this.results.replaceChildren();
    this.tree.hidden = Boolean(query);
    this.results.hidden = !query;
    document.querySelector("#navigationSearchEmpty").hidden = true;
    if (!query) return;

    const matches = matchingNavigationEntries(this.linkEntries, query);
    for (const entry of matches.slice(0, 60)) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.navigationTarget = entry.target;
      const label = document.createElement("strong");
      label.textContent = entry.label;
      const context = document.createElement("span");
      context.textContent = `${entry.path.slice(0, -1).join(" · ") || "Bog"} · side ${entry.pageNumber}`;
      button.append(label, context);
      button.addEventListener("click", () => this.navigate(entry));
      item.append(button);
      this.results.append(item);
    }
    document.querySelector("#navigationSearchEmpty").hidden = matches.length > 0;
  }

  updateCurrent(pageNumbers) {
    if (this.linkEntries.length === 0 || pageNumbers.length === 0) return;
    const current = currentNavigationEntry(this.linkEntries, pageNumbers);
    this.linkEntries.forEach((entry) => {
      const active = current != null && entry === current;
      entry.row?.classList.toggle("is-current", active);
      const destination = entry.row?.querySelector(".navigation-destination");
      if (active) destination?.setAttribute("aria-current", "location");
      else destination?.removeAttribute("aria-current");
      if (active) {
        for (let parent = entry.parent; parent; parent = parent.parent) this.toggleBranch(parent, true);
      }
    });
    if (this.isOpen()) current?.row?.scrollIntoView({ block: "nearest" });
  }

  showJumpError(message) {
    this.jumpError.textContent = message;
    this.jumpError.hidden = false;
  }

  showEmpty(message) {
    document.querySelector("#navigationLoading").hidden = true;
    const empty = document.querySelector("#navigationEmpty");
    empty.querySelector("p").textContent = message;
    empty.hidden = false;
  }

  showError(message) {
    document.querySelector("#navigationLoading").hidden = true;
    const error = document.querySelector("#navigationError");
    error.querySelector("p").textContent = message;
    error.hidden = false;
  }

  isOpen() {
    return this.panel.classList.contains("is-open");
  }

  open({ focus = "search" } = {}) {
    if (this.panelButton.disabled) return;
    this.onOpen?.();
    this.returnFocus = openSidePanel(this.panel, this.panelButton, this.returnFocus);
    document.querySelector("#positionButton").setAttribute("aria-expanded", "true");
    window.setTimeout(() => (focus === "jump" ? this.jumpInput : this.search).focus(), 80);
  }

  close({ restoreFocus = true } = {}) {
    closeSidePanel(this.panel, this.panelButton, this.returnFocus, { restoreFocus });
    document.querySelector("#positionButton").setAttribute("aria-expanded", "false");
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }
}
