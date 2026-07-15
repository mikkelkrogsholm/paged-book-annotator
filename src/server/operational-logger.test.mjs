import assert from "node:assert/strict";
import { test } from "bun:test";

import { createOperationalLogger, redactOperationalFields, resolveLoggingConfig } from "./operational-logger.mjs";

test("operational logger emits deterministic structured records and filters levels", () => {
  const lines = [];
  const records = [];
  const logger = createOperationalLogger({
    level: "info",
    clock: () => new Date("2026-07-15T12:00:00.000Z"),
    sink: (line, record) => { lines.push(line); records.push(record); },
    baseFields: { component: "test" },
  });

  assert.equal(logger.debug("not.visible"), null);
  logger.info("request.completed", { requestId: "request-1", status: 200 });
  assert.deepEqual(JSON.parse(lines[0]), records[0]);
  assert.deepEqual(records[0], {
    component: "test", requestId: "request-1", status: 200,
    timestamp: "2026-07-15T12:00:00.000Z", level: "info", event: "request.completed",
  });
});

test("operational logger recursively redacts credentials without hiding safe token metadata", () => {
  const circular = { password: "open-sesame" };
  circular.self = circular;
  const safe = redactOperationalFields({
    authorization: "Bearer service-secret",
    nested: [{ sessionSecret: "session-secret", tokenId: "token-7", tokenPrefix: "pba_token-7" }],
    message: "Authorization: Bearer another-secret password=visible-no-more",
    circular,
    error: Object.assign(new Error("Bearer error-secret"), { code: "E_TEST" }),
  });

  assert.equal(safe.authorization, "[REDACTED]");
  assert.equal(safe.nested[0].sessionSecret, "[REDACTED]");
  assert.equal(safe.nested[0].tokenId, "token-7");
  assert.equal(safe.nested[0].tokenPrefix, "pba_token-7");
  assert.doesNotMatch(JSON.stringify(safe), /service-secret|session-secret|another-secret|visible-no-more|error-secret|open-sesame/);
  assert.equal(safe.circular.self, "[CIRCULAR]");
  assert.equal(safe.error.code, "E_TEST");
  assert.equal("stack" in safe.error, false);
});

test("operational logger removes direct PII and bounds attacker-controlled values", () => {
  const safe = redactOperationalFields({
    name: "Ada Lovelace",
    contact: { emailAddress: "ada@example.com", phone: "+45 12 34 56 78" },
    message: `Contact ada@example.com ${"x".repeat(200)}`,
  }, { maximumStringLength: 80 });
  const bounded = redactOperationalFields({
    values: [1, 2, 3, 4],
    object: { one: 1, two: 2, three: 3 },
  }, { maximumCollectionEntries: 2 });

  assert.equal(safe.name, "[REDACTED]");
  assert.equal(safe.contact.emailAddress, "[REDACTED]");
  assert.equal(safe.contact.phone, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(safe), /Ada|ada@example|12 34 56 78/);
  assert.match(safe.message, /\[REDACTED_EMAIL\]/);
  assert.match(safe.message, /\[TRUNCATED \d+ chars\]$/);
  assert.equal(redactOperationalFields("attacker-controlled", { maximumStringLength: 8 }).length, 8);
  assert.deepEqual(bounded.values, [1, 2, "[TRUNCATED 2 entries]"]);
  assert.deepEqual(bounded.object, { one: 1, two: 2, _truncated: "1 entries" });
});

test("operational logger is fail-safe when its clock, fields or sink fail", () => {
  const sinkFailure = createOperationalLogger({ sink: () => { throw new Error("sink unavailable"); } });
  assert.equal(sinkFailure.info("request.completed", { status: 200 })?.event, "request.completed");

  const clockFailure = createOperationalLogger({ clock: () => { throw new Error("clock unavailable"); } });
  assert.doesNotThrow(() => clockFailure.info("request.completed", { status: 200 }));
  assert.equal(clockFailure.info("request.completed", { status: 200 }), null);

  const fieldsFailure = createOperationalLogger();
  const fields = {};
  Object.defineProperty(fields, "explodes", { enumerable: true, get: () => { throw new Error("getter unavailable"); } });
  assert.doesNotThrow(() => fieldsFailure.info("request.completed", fields));
  assert.equal(fieldsFailure.info("request.completed", fields), null);
});

test("logging configuration validates environment overrides and pretty output", () => {
  assert.deepEqual(resolveLoggingConfig({ level: "debug", format: "pretty" }, {}), { level: "debug", format: "pretty", includeStack: false });
  assert.deepEqual(resolveLoggingConfig({}, { PBA_LOG_LEVEL: "warn", PBA_LOG_FORMAT: "json" }), { level: "warn", format: "json", includeStack: false });
  assert.throws(() => resolveLoggingConfig({ level: "verbose" }, {}), /logging.level/);
  const lines = [];
  createOperationalLogger({ format: "pretty", clock: () => new Date(0), sink: (line) => lines.push(line) }).warn("server.stopping", { reason: "test" });
  assert.equal(lines[0], "1970-01-01T00:00:00.000Z WARN  server.stopping {\"reason\":\"test\"}");
});
