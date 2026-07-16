import { closeSidePanel, openSidePanel, showUiToast } from "../ui-state.js";

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function definitionOf(survey) {
  return survey?.published?.definition ?? null;
}

export function readSkippedSurveys(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "[]");
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

export function writeSkippedSurveys(storage, key, skipped) {
  try { storage.setItem(key, JSON.stringify([...skipped])); } catch { /* Storage is an optional convenience. */ }
}

function availableSessionStorage() {
  try { return window.sessionStorage; } catch { return null; }
}

export function targetIsVisible(definition, anchors) {
  return new Set(anchors ?? []).has(definition?.target?.anchorId);
}

export function targetWasLeft(definition, previousAnchors, currentAnchors) {
  return targetIsVisible(definition, previousAnchors) && !targetIsVisible(definition, currentAnchors);
}

function answerField(question, answer) {
  const name = `survey-${question.id}`;
  const describedBy = question.helpText ? `${name}-help` : "";
  if (question.type === "rating") {
    return `<fieldset class="survey-rating"${describedBy ? ` aria-describedby="${describedBy}"` : ""}>
      <legend>${escapeHtml(question.prompt)}${question.required ? " <span aria-hidden=\"true\">*</span>" : ""}</legend>
      ${question.helpText ? `<small id="${describedBy}">${escapeHtml(question.helpText)}</small>` : ""}
      <div class="survey-scale-labels"><span>${escapeHtml(question.scale.minLabel)}</span><span>${escapeHtml(question.scale.maxLabel)}</span></div>
      <div class="survey-scale">${[1, 2, 3, 4, 5].map((value) => `<label><input type="radio" name="${name}" value="${value}"${Number(answer) === value ? " checked" : ""}${question.required ? " required" : ""}><span>${value}</span></label>`).join("")}</div>
    </fieldset>`;
  }
  if (question.type === "singleChoice") {
    return `<fieldset class="survey-choice"${describedBy ? ` aria-describedby="${describedBy}"` : ""}>
      <legend>${escapeHtml(question.prompt)}${question.required ? " <span aria-hidden=\"true\">*</span>" : ""}</legend>
      ${question.helpText ? `<small id="${describedBy}">${escapeHtml(question.helpText)}</small>` : ""}
      ${question.options.map((option) => `<label><input type="radio" name="${name}" value="${escapeHtml(option.id)}"${answer === option.id ? " checked" : ""}${question.required ? " required" : ""}><span>${escapeHtml(option.label)}</span></label>`).join("")}
    </fieldset>`;
  }
  const rows = question.type === "longText" ? 6 : 3;
  return `<label class="survey-text" for="${name}">${escapeHtml(question.prompt)}${question.required ? " <span aria-hidden=\"true\">*</span>" : ""}</label>
    ${question.helpText ? `<small id="${describedBy}">${escapeHtml(question.helpText)}</small>` : ""}
    <textarea id="${name}" name="${name}" rows="${rows}" maxlength="${question.maxLength}"${describedBy ? ` aria-describedby="${describedBy}"` : ""}${question.required ? " required" : ""}>${escapeHtml(answer ?? "")}</textarea>`;
}

export class SurveyController extends EventTarget {
  constructor({ api, reader, capabilities }) {
    super();
    this.api = api;
    this.reader = reader;
    this.capabilities = capabilities;
    this.button = document.querySelector("#surveyPanelButton");
    this.panel = document.querySelector("#surveyPanel");
    this.form = document.querySelector("#surveyForm");
    this.surveys = [];
    this.responses = new Map();
    this.active = null;
    this.previousAnchors = [];
    this.intentId = 0;
    this.returnFocus = null;
    this.storageKey = `pba.skippedSurveys:${window.location.pathname}`;
    this.storage = availableSessionStorage();
    this.skipped = readSkippedSurveys(this.storage, this.storageKey);
    this.bind();
  }

  bind() {
    this.button.addEventListener("click", () => this.openBestMatch(this.reader.currentAnchors()).catch((error) => this.showError(error)));
    document.querySelector("#surveyPanelClose").addEventListener("click", () => this.close());
    document.querySelector("#surveyLaterButton").addEventListener("click", () => this.close());
    document.querySelector("#surveySkipButton").addEventListener("click", () => {
      if (this.active) this.skipped.add(`${this.active.id}:${this.active.publishedVersion}`);
      writeSkippedSurveys(this.storage, this.storageKey, this.skipped);
      this.close();
    });
    this.form.addEventListener("submit", (event) => this.submit(event));
    this.reader.addEventListener("pagechange", (event) => this.onPageChange(event.detail.anchors ?? [event.detail.anchor].filter(Boolean)).catch((error) => this.showError(error)));
    this.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
  }

  async start() {
    if (!this.capabilities.canRespondToSurveys) return;
    this.surveys = await this.api.list();
    this.previousAnchors = this.reader.currentAnchors();
    this.updateButton(this.previousAnchors);
  }

  async responseFor(survey) {
    const key = `${survey.id}:${survey.publishedVersion}`;
    if (!this.responses.has(key)) this.responses.set(key, await this.api.getResponse(survey.id));
    return this.responses.get(key);
  }

  candidates(anchors) {
    const available = this.surveys.filter((survey) => !this.skipped.has(`${survey.id}:${survey.publishedVersion}`));
    return available.filter((survey) => targetIsVisible(definitionOf(survey), anchors));
  }

  updateButton(anchors) {
    const count = this.candidates(anchors).length;
    this.button.hidden = count === 0;
    document.querySelector("#surveyCount").textContent = String(count);
  }

  async openBestMatch(anchors) {
    const intentId = ++this.intentId;
    for (const survey of this.candidates(anchors)) {
      const response = await this.responseFor(survey);
      if (intentId !== this.intentId) return;
      if (!response) { await this.open(survey, intentId); return; }
    }
    const fallback = this.candidates(anchors)[0];
    if (fallback && intentId === this.intentId) await this.open(fallback, intentId);
  }

  async onPageChange(anchors) {
    const intentId = ++this.intentId;
    const previousAnchors = this.previousAnchors;
    this.previousAnchors = anchors;
    this.updateButton(anchors);
    if (!previousAnchors.length || this.panel.classList.contains("is-open")) return;
    const survey = this.surveys.find((candidate) => {
      const definition = definitionOf(candidate);
      return definition?.trigger?.mode === "afterLeave"
        && targetWasLeft(definition, previousAnchors, anchors)
        && !this.skipped.has(`${candidate.id}:${candidate.publishedVersion}`);
    });
    if (survey && !await this.responseFor(survey) && intentId === this.intentId) await this.open(survey, intentId);
  }

  async open(survey, intentId = ++this.intentId) {
    const definition = definitionOf(survey);
    const response = await this.responseFor(survey);
    if (intentId !== this.intentId) return;
    this.active = survey;
    const answers = new Map((response?.answers ?? []).map((answer) => [answer.questionId, answer.value]));
    document.querySelector("#surveyEyebrow").textContent = definition.target.label || (definition.target.kind === "page" ? "Feedback på siden" : "Feedback på afsnittet");
    document.querySelector("#surveyTitle").textContent = definition.title;
    const description = document.querySelector("#surveyDescription");
    description.textContent = definition.description;
    description.hidden = !definition.description;
    document.querySelector("#surveyQuestions").innerHTML = definition.questions.map((question) => `<div class="survey-question">${answerField(question, answers.get(question.id))}</div>`).join("");
    const submitButton = document.querySelector("#surveySubmitButton");
    submitButton.textContent = response ? "Gem ændret svar" : "Send feedback";
    submitButton.disabled = false;
    document.querySelector("#surveyFormError").hidden = true;
    this.returnFocus = openSidePanel(this.panel, this.button, this.returnFocus);
    this.dispatchEvent(new Event("open"));
    window.setTimeout(() => this.form.querySelector("input, textarea")?.focus(), 80);
  }

  close({ restoreFocus = true } = {}) {
    this.intentId += 1;
    closeSidePanel(this.panel, this.button, this.returnFocus, { restoreFocus });
  }

  showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.panel.classList.contains("is-open")) {
      const node = document.querySelector("#surveyFormError");
      node.textContent = message;
      node.hidden = false;
      return;
    }
    showUiToast(message, { error: true });
  }

  async submit(event) {
    event.preventDefault();
    if (!this.active) return;
    const definition = definitionOf(this.active);
    const data = new FormData(this.form);
    const answers = definition.questions.flatMap((question) => {
      const value = data.get(`survey-${question.id}`);
      return value == null || String(value).trim() === "" ? [] : [{
        questionId: question.id,
        value: question.type === "rating" ? Number(value) : String(value),
      }];
    });
    const button = document.querySelector("#surveySubmitButton");
    const active = this.active;
    const submitIntentId = this.intentId;
    const responseKey = `${active.id}:${active.publishedVersion}`;
    button.disabled = true;
    try {
      const response = await this.api.submit(active.id, answers);
      this.responses.set(responseKey, response);
      if (this.active === active && this.intentId === submitIntentId) this.close();
      showUiToast("Tak — din feedback er gemt.");
    } catch (error) {
      if (this.active === active && this.intentId === submitIntentId) {
        const node = document.querySelector("#surveyFormError");
        node.textContent = error.message;
        node.hidden = false;
      }
    } finally {
      if (this.active === active && this.intentId === submitIntentId) button.disabled = false;
    }
  }
}
