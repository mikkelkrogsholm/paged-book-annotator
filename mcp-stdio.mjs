#!/usr/bin/env bun
import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadBookViewerConfig } from "./server.mjs";
import { BookCatalogRepository } from "./src/server/book-catalog-repository.mjs";
import { LocalBookStorage } from "./src/server/book-storage.mjs";
import { CollaborationRepository } from "./src/server/collaboration-repository.mjs";
import { LibraryApplication } from "./src/server/library-application.mjs";
import { ManagedBookCatalog } from "./src/server/managed-book-catalog.mjs";
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
const catalogRepository = new BookCatalogRepository({ filePath: config.library.catalogDatabase });
const storage = new LocalBookStorage({ rootDir: config.library.dataDir, limits: { maxArchiveBytes: config.library.uploadMaxBytes } });
const catalog = new ManagedBookCatalog({ repository: catalogRepository, storage });
if (catalog.listBooks({ includeArchived: true }).length === 0 && config.book) {
  await catalog.importBookDirectory({
    sourceDir: config.book.sourceDir,
    book: {
      id: config.book.id,
      slug: config.book.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      title: config.book.title,
      subtitle: config.book.subtitle,
      language: config.book.language,
    },
    createdBy: "legacy-bootstrap",
    publish: true,
  });
}
const collaboration = new CollaborationRepository({
  filePath: config.collaboration.database,
  sessionHours: config.auth.sessionHours, invitationHours: config.auth.invitationHours,
});
const service = new LibraryApplication({ config, catalog, collaborationRepository: collaboration });
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
    catalogRepository.close();
    logger.info("mcp.stopped", { reason: signal.toLowerCase() });
  });
}
