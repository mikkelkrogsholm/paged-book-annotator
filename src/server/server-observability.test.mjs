import assert from "node:assert/strict";
import { test } from "bun:test";

import { createBookViewerServer, handleBookViewerRequest, stopBookViewer } from "../../server.mjs";
import { createOperationalLogger } from "./operational-logger.mjs";

function testConfig() {
  return {
    book: { id: "observability-book" },
    security: { allowedOrigins: [], secureCookies: false },
    mcp: { enabled: true, endpoint: "/mcp" },
  };
}

test("health and failures return correlated request IDs without logging request secrets", async () => {
  const records = [];
  const logger = createOperationalLogger({
    clock: () => new Date("2026-07-15T12:00:00.000Z"),
    sink: (_line, record) => records.push(record),
  });
  const times = [10, 12.5, 20, 23.75];
  let generated = 0;
  const options = {
    config: testConfig(),
    service: {
      health: () => ({ collaboration: "ok" }),
      resolvePrincipal: async ({ guestId }) => ({ kind: "guest", id: guestId }),
    },
    logger,
    createRequestId: () => `generated-${++generated}`,
    monotonicClock: () => times.shift(),
  };

  const health = await handleBookViewerRequest(new Request("http://localhost/api/health?token=query-secret", {
    headers: { Host: "localhost", "X-Request-Id": "019f66a5-6866-7000-99c7-feecfdc94188" },
  }), options);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-request-id"), "019f66a5-6866-7000-99c7-feecfdc94188");
  assert.equal((await health.json()).storage.collaboration, "ok");

  const invalid = await handleBookViewerRequest(new Request("http://localhost/api/auth/login?password=query-password", {
    method: "POST",
    headers: {
      Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json",
      Authorization: "Bearer header-secret", Cookie: "pba_session=cookie-secret", "X-Request-Id": "contains spaces",
    },
    body: "{\"password\":\"body-secret\"",
  }), options);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("x-request-id"), "generated-1");

  const completions = records.filter((record) => record.event === "request.completed");
  assert.equal(completions.length, 2);
  assert.deepEqual(completions.map(({ requestId, path, bookId, status, durationMs }) => ({ requestId, path, bookId, status, durationMs })), [
    { requestId: "019f66a5-6866-7000-99c7-feecfdc94188", path: "/api/health", bookId: "observability-book", status: 200, durationMs: 2.5 },
    { requestId: "generated-1", path: "/api/auth/login", bookId: "observability-book", status: 400, durationMs: 3.75 },
  ]);
  const failure = records.find((record) => record.event === "request.failed");
  assert.deepEqual({
    requestId: failure.requestId, path: failure.path, bookId: failure.bookId,
    principalKind: failure.principalKind, status: failure.status,
  }, {
    requestId: "generated-1", path: "/api/auth/login", bookId: "observability-book",
    principalKind: "guest", status: 400,
  });
  assert.doesNotMatch(JSON.stringify(records), /query-secret|query-password|header-secret|cookie-secret|body-secret/);
});

test("health reports degraded storage as unavailable", async () => {
  const response = await handleBookViewerRequest(new Request("http://localhost/api/health", {
    headers: { Host: "localhost" },
  }), {
    config: testConfig(),
    service: { bookId: "observability-book", health: async () => ({ collaboration: "ok", annotations: "unavailable" }) },
    logger: createOperationalLogger({ sink: () => {} }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "degraded",
    bookId: "observability-book",
    runtime: { name: "Bun", version: Bun.version },
    schemas: { annotations: 4, collaboration: 4 },
    storage: { collaboration: "ok", annotations: "unavailable" },
  });
});

test("server lifecycle emits explicit startup and graceful shutdown records", async () => {
  const records = [];
  let repositoryClosed = false;
  const logger = createOperationalLogger({ sink: (_line, record) => records.push(record) });
  const server = createBookViewerServer({
    config: {
      ...testConfig(), server: { host: "127.0.0.1", port: 0 }, annotations: { file: "unused" },
      collaboration: { database: ":memory:" }, auth: { sessionHours: 1, invitationHours: 1 },
      access: { preset: "local" }, logging: { level: "silent", format: "json" },
    },
    repository: {},
    collaborationRepository: { close: () => { repositoryClosed = true; } },
    service: {},
    hostname: "127.0.0.1",
    port: 0,
    logger,
  });
  await stopBookViewer(server, { reason: "test" });
  assert.equal(repositoryClosed, true);
  assert.deepEqual(records.map((record) => record.event), ["server.started", "server.stopping", "server.stopped"]);
  assert.deepEqual(records.slice(1).map((record) => record.reason), ["test", "test"]);
});
