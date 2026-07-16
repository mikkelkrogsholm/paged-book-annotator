import assert from "node:assert/strict";
import { test } from "bun:test";
import * as z from "zod/v4";

import { createReviewExport, validateSurveyAnswers, validateSurveyDefinition } from "./survey-contract.mjs";

const definition = {
  schemaVersion: 1,
  title: "Feedback på kapitel 1",
  description: "Svar kort på din oplevelse.",
  target: { kind: "section", anchorId: "chapter-1", pageNumberHint: 3, label: "Kapitel 1" },
  trigger: { mode: "afterLeave" },
  questions: [
    { id: "clarity", type: "rating", prompt: "Hvor let var afsnittet at forstå?", required: true, scale: { min: 1, max: 5, minLabel: "Svært", maxLabel: "Let" } },
    { id: "improve", type: "singleChoice", prompt: "Hvad bør forbedres?", required: true, options: [{ id: "structure", label: "Struktur" }, { id: "language", label: "Sprog" }] },
    { id: "comment", type: "longText", prompt: "Hvad var uklart?", required: false, maxLength: 1_000 },
  ],
};

test("survey V1 validates clean single-purpose questions and typed answers", () => {
  const normalized = validateSurveyDefinition(definition);
  assert.equal(normalized.target.contextStartAnchorId, null);
  assert.deepEqual(validateSurveyAnswers(normalized, [
    { questionId: "clarity", value: 4 },
    { questionId: "improve", value: "structure" },
  ]), [
    { questionId: "clarity", value: 4 },
    { questionId: "improve", value: "structure" },
  ]);
  assert.throws(() => validateSurveyDefinition({ ...definition, questions: [] }), /1–5/);
  assert.throws(() => validateSurveyAnswers(normalized, [{ questionId: "clarity", value: 9 }]), /1 til 5/);
  assert.throws(() => validateSurveyAnswers(normalized, [{ questionId: "clarity", value: 4 }]), /improve/);
});

test("review export output validates against the published JSON Schema", async () => {
  const document = createReviewExport({
    book: { id: "book-1", title: "Bog", revisionId: "revision-1", buildId: "build-1" },
    annotations: { schemaVersion: 4, updatedAt: "2026-07-15T12:00:00.000Z", annotations: [] },
    surveys: [],
    surveyResponses: [],
    exportedAt: "2026-07-15T12:00:00.000Z",
  });
  const jsonSchema = await Bun.file(new URL("../../schemas/pba-review-export.v1.schema.json", import.meta.url)).json();
  const schema = z.fromJSONSchema(jsonSchema);
  assert.deepEqual(schema.parse(document), document);
  assert.equal(document.readingProgress.included, false);
  assert.equal(schema.safeParse({ ...document, surveys: [{}], surveyResponses: [{}], annotations: { ...document.annotations, items: [{}] } }).success, false);
});
