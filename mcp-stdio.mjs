#!/usr/bin/env bun
import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadBookViewerConfig } from "./server.mjs";
import { CollaborationRepository } from "./src/server/collaboration-repository.mjs";
import { LibraryApplication } from "./src/server/library-application.mjs";
import { openManagedBookCatalog } from "./src/server/library-bootstrap.mjs";
import { createPagedBookMcpServer } from "./src/server/mcp-server.mjs";
import { createOperationalLogger } from "./src/server/operational-logger.mjs";

function configArgument(argv) {
  const index = argv.indexOf("--config");
  return index >= 0 ? argv[index + 1] : "book-viewer.config.example.json";
}

const config = await loadBookViewerConfig(resolve(configArgument(Bun.argv.slice(2))));
const logger = createOperationalLogger({
  ...config.logging,
  baseFields: { component: "mcp-stdio", bookId: config.book?.id ?? "library" },
  sink: (line) => process.stderr.write(`${line}\n`),
});
const { catalogRepository, catalog } = await openManagedBookCatalog(config);
const collaboration = new CollaborationRepository({
  filePath: config.collaboration.database,
  sessionHours: config.auth.sessionHours, invitationHours: config.auth.invitationHours,
});
const service = new LibraryApplication({ config, catalog, collaborationRepository: collaboration });
const token = process.env.PBA_MCP_TOKEN;
if (!token) throw new Error("Sæt PBA_MCP_TOKEN til et service-token oprettet i admin UI.");
const principalProvider = () => service.resolvePrincipal({ bearerToken: token });
const principal = await principalProvider();
const server = createPagedBookMcpServer({ service, principal, principalProvider, config, logger, transport: "stdio" });
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
    catalogRepository.close();
    logger.info("mcp.stopped", { reason: signal.toLowerCase() });
  });
}
