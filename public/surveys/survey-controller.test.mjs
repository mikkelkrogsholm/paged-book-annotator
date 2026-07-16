import assert from "node:assert/strict";
import { test } from "bun:test";

import { readSkippedSurveys, targetIsVisible, targetWasLeft, writeSkippedSurveys } from "./survey-controller.js";

const chapterSurvey = { target: { kind: "section", anchorId: "chapter-1" } };

test("survey targets match every anchor on a spread and trigger only after their target disappears", () => {
  assert.equal(targetIsVisible(chapterSurvey, ["cover", "chapter-1"]), true);
  assert.equal(targetWasLeft(chapterSurvey, ["chapter-1", "chapter-1.paragraph"], ["chapter-1", "chapter-1.example"]), false);
  assert.equal(targetWasLeft(chapterSurvey, ["chapter-1", "chapter-1.example"], ["chapter-2"]), true);
  assert.equal(targetWasLeft(chapterSurvey, ["cover"], ["chapter-2"]), false);
});

test("survey skip storage fails open when browser storage is malformed or unavailable", () => {
  assert.deepEqual([...readSkippedSurveys({ getItem: () => "not-json" }, "key")], []);
  assert.deepEqual([...readSkippedSurveys({ getItem: () => '["survey:1"]' }, "key")], ["survey:1"]);
  assert.doesNotThrow(() => writeSkippedSurveys({ setItem: () => { throw new Error("blocked"); } }, "key", new Set(["survey:1"])));
});
