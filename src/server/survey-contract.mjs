export const SURVEY_SCHEMA_VERSION = 1;
export const REVIEW_EXPORT_SCHEMA_VERSION = 1;
export const SURVEY_STATUSES = Object.freeze(["draft", "published", "closed"]);
export const SURVEY_QUESTION_TYPES = Object.freeze(["rating", "singleChoice", "shortText", "longText"]);

function text(value, field, { max = 10_000, optional = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized && optional) return "";
  if (!normalized) throw new TypeError(`${field} skal være en ikke-tom tekststreng.`);
  if (normalized.length > max) throw new TypeError(`${field} må højst være ${max} tegn.`);
  return normalized;
}

function identifier(value, field) {
  const normalized = text(value, field, { max: 100 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new TypeError(`${field} må kun indeholde bogstaver, tal, punktum, kolon, bindestreg og underscore.`);
  }
  return normalized;
}

function optionalPositiveInteger(value, field) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${field} skal være et positivt heltal.`);
  return number;
}

function validateTarget(raw = {}) {
  const kind = String(raw.kind ?? "");
  if (!new Set(["page", "section"]).has(kind)) throw new TypeError("target.kind skal være page eller section.");
  return {
    kind,
    anchorId: identifier(raw.anchorId, "target.anchorId"),
    contextStartAnchorId: raw.contextStartAnchorId ? identifier(raw.contextStartAnchorId, "target.contextStartAnchorId") : null,
    pageNumberHint: optionalPositiveInteger(raw.pageNumberHint, "target.pageNumberHint"),
    revisionId: raw.revisionId ? text(raw.revisionId, "target.revisionId", { max: 200 }) : null,
    label: text(raw.label, "target.label", { max: 240, optional: true }),
  };
}

function validateQuestion(raw, index) {
  const prefix = `questions[${index}]`;
  const type = String(raw?.type ?? "");
  if (!SURVEY_QUESTION_TYPES.includes(type)) throw new TypeError(`${prefix}.type er ukendt.`);
  const question = {
    id: identifier(raw.id, `${prefix}.id`),
    type,
    prompt: text(raw.prompt, `${prefix}.prompt`, { max: 500 }),
    helpText: text(raw.helpText, `${prefix}.helpText`, { max: 500, optional: true }),
    required: raw.required !== false,
  };
  if (type === "rating") {
    const scale = raw.scale ?? {};
    if (Number(scale.min ?? 1) !== 1 || Number(scale.max ?? 5) !== 5) {
      throw new TypeError(`${prefix}.scale skal være en 1–5-skala i V1.`);
    }
    question.scale = {
      min: 1,
      max: 5,
      minLabel: text(scale.minLabel, `${prefix}.scale.minLabel`, { max: 100 }),
      maxLabel: text(scale.maxLabel, `${prefix}.scale.maxLabel`, { max: 100 }),
    };
  }
  if (type === "singleChoice") {
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 7) {
      throw new TypeError(`${prefix}.options skal indeholde 2–7 svarmuligheder.`);
    }
    question.options = raw.options.map((option, optionIndex) => ({
      id: identifier(option?.id, `${prefix}.options[${optionIndex}].id`),
      label: text(option?.label, `${prefix}.options[${optionIndex}].label`, { max: 200 }),
    }));
    if (new Set(question.options.map((option) => option.id)).size !== question.options.length) {
      throw new TypeError(`${prefix}.options skal have unikke id'er.`);
    }
  }
  if (type === "shortText" || type === "longText") {
    const ceiling = type === "shortText" ? 500 : 4_000;
    const fallback = type === "shortText" ? 300 : 2_000;
    const maxLength = Number(raw.maxLength ?? fallback);
    if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > ceiling) {
      throw new TypeError(`${prefix}.maxLength skal være mellem 1 og ${ceiling}.`);
    }
    question.maxLength = maxLength;
  }
  return question;
}

export function validateSurveyDefinition(raw = {}) {
  if (raw.schemaVersion != null && Number(raw.schemaVersion) !== SURVEY_SCHEMA_VERSION) {
    throw new TypeError(`Survey schemaVersion skal være ${SURVEY_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 5) {
    throw new TypeError("En survey skal indeholde 1–5 spørgsmål.");
  }
  const questions = raw.questions.map(validateQuestion);
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new TypeError("Spørgsmål skal have unikke id'er.");
  }
  const mode = String(raw.trigger?.mode ?? "afterLeave");
  if (!new Set(["afterLeave", "manual"]).has(mode)) throw new TypeError("trigger.mode skal være afterLeave eller manual.");
  return {
    schemaVersion: SURVEY_SCHEMA_VERSION,
    title: text(raw.title, "title", { max: 160 }),
    description: text(raw.description, "description", { max: 2_000, optional: true }),
    target: validateTarget(raw.target),
    trigger: { mode },
    questions,
  };
}

export function validateSurveyAnswers(definition, rawAnswers) {
  const survey = validateSurveyDefinition(definition);
  if (!Array.isArray(rawAnswers)) throw new TypeError("answers skal være en liste.");
  const byQuestion = new Map();
  for (const [index, answer] of rawAnswers.entries()) {
    const questionId = identifier(answer?.questionId, `answers[${index}].questionId`);
    if (byQuestion.has(questionId)) throw new TypeError(`Spørgsmålet ${questionId} må kun besvares én gang.`);
    byQuestion.set(questionId, answer?.value);
  }
  const unknown = [...byQuestion.keys()].filter((id) => !survey.questions.some((question) => question.id === id));
  if (unknown.length) throw new TypeError(`Ukendte spørgsmål i svar: ${unknown.join(", ")}.`);
  const normalized = [];
  for (const question of survey.questions) {
    const value = byQuestion.get(question.id);
    const missing = value == null || (typeof value === "string" && !value.trim());
    if (missing && question.required) throw new TypeError(`Spørgsmålet ${question.id} kræver et svar.`);
    if (missing) continue;
    if (question.type === "rating") {
      const rating = Number(value);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new TypeError(`${question.id} skal besvares med et heltal fra 1 til 5.`);
      normalized.push({ questionId: question.id, value: rating });
      continue;
    }
    if (question.type === "singleChoice") {
      const optionId = String(value);
      if (!question.options.some((option) => option.id === optionId)) throw new TypeError(`${question.id} har en ukendt svarmulighed.`);
      normalized.push({ questionId: question.id, value: optionId });
      continue;
    }
    const answerText = String(value).trim();
    if (answerText.length > question.maxLength) throw new TypeError(`${question.id} må højst være ${question.maxLength} tegn.`);
    normalized.push({ questionId: question.id, value: answerText });
  }
  return normalized;
}

export function createReviewExport({ book, annotations, surveys, surveyResponses, readingProgress = null, exportedAt = new Date().toISOString() }) {
  return {
    schemaVersion: REVIEW_EXPORT_SCHEMA_VERSION,
    kind: "paged-book-review-export",
    exportedAt,
    book: {
      id: text(book?.id, "book.id", { max: 200 }),
      title: text(book?.title ?? book?.id, "book.title", { max: 500 }),
      revisionId: book?.revisionId ? String(book.revisionId) : null,
      buildId: book?.buildId ? String(book.buildId) : null,
    },
    annotations: {
      schemaVersion: Number(annotations?.schemaVersion ?? 4),
      updatedAt: annotations?.updatedAt ?? exportedAt,
      items: Array.isArray(annotations?.annotations) ? annotations.annotations : [],
    },
    surveys: Array.isArray(surveys) ? surveys : [],
    surveyResponses: Array.isArray(surveyResponses) ? surveyResponses : [],
    readingProgress: {
      included: Array.isArray(readingProgress),
      items: Array.isArray(readingProgress) ? readingProgress : [],
    },
  };
}
