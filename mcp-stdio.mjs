#!/usr/bin/env bun
import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadBookViewerConfig } from "./server.mjs";
import { AnnotationRepository } from "./src/server/annotation-repository.mjs";
import { BookCollaboration } from "./src/server/application-service.mjs";
import { BookContentIndex } from "./src/server/book-content-index.mjs";
import { CollaborationRepository } from "./src/server/collaboration-repository.mjs";
import { createPagedBookMcpServer } from "./src/server/mcp-server.mjs";
import { createOperationalLogger } from "./src/server/operational-logger.mjs";

function configArgument(argv) {
  const index = argv.indexOf("--config");
  return index >= 0 ? argv[index + 1] : "book-viewer.config.example.json";
}

const config = await loadBookViewerConfig(resolve(configArgument(Bun.argv.slice(2))));
const logger = createOperationalLogger({
  ...config.logging,
  baseFields: { component: "mcp-stdio", bookId: config.book.id },
  sink: (line) => process.stderr.write(`${line}\n`),
});
const collaboration = new CollaborationRepository({
  filePath: config.collaboration.database, bookId: config.book.id,
  sessionHours: config.auth.sessionHours, invitationHours: config.auth.invitationHours,
});
const annotations = new AnnotationRepository({ filePath: config.annotations.file, bookId: config.book.id });
const bookContentIndex = new BookContentIndex({ filePath: resolve(config.book.sourceDir, config.book.document), bookId: config.book.id, buildId: config.book.buildId });
const service = new BookCollaboration({ config, annotationRepository: annotations, collaborationRepository: collaboration, bookContentIndex });
const token = process.env.PBA_MCP_TOKEN;
if (!token) throw new Error("Sæt PBA_MCP_TOKEN til et service-token oprettet i admin UI.");
const principal = await service.resolvePrincipal({ bearerToken: token });
const server = createPagedBookMcpServer({ service, principal, config, logger });
await server.connect(new StdioServerTransport());
logger.info("mcp.started", { transport: "stdio", runtime: `Bun ${Bun.version}` });

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    logger.info("mcp.stopping", { reason: signal.toLowerCase() });
    await server.close();
    collaboration.close();
    logger.info("mcp.stopped", { reason: signal.toLowerCase() });
  });
}
