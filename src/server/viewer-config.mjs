import { dirname, isAbsolute, join, resolve } from "node:path";

import { resolveAccessPolicy } from "./access-policy.mjs";
import { resolveLoggingConfig } from "./operational-logger.mjs";

function resolveFromConfig(configDirectory, path) {
  return isAbsolute(path) ? path : resolve(configDirectory, path);
}

export function parseServerArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") options.configPath = argv[++index];
    else if (argument === "--host") options.host = argv[++index];
    else if (argument === "--port") options.port = Number(argv[++index]);
    else throw new TypeError(`Ukendt argument: ${argument}`);
  }
  return options;
}

export async function loadBookViewerConfig(configPath) {
  const absoluteConfigPath = resolve(configPath);
  const configDirectory = dirname(absoluteConfigPath);
  const raw = await Bun.file(absoluteConfigPath).json();
  if (raw.book && (!raw.book.id || !raw.book.title || !raw.book.sourceDir || !raw.book.document)) {
    throw new TypeError("En bootstrap-bog kræver book.id, book.title, book.sourceDir og book.document.");
  }
  const paginationTimeoutMs = Number(raw.book?.paginationTimeoutMs ?? 45_000);
  if (!Number.isSafeInteger(paginationTimeoutMs) || paginationTimeoutMs < 5_000 || paginationTimeoutMs > 300_000) {
    throw new TypeError("book.paginationTimeoutMs skal være et heltal mellem 5000 og 300000.");
  }
  const configuredDataDir = process.env.PBA_DATA_DIR || raw.library?.dataDir || "data";
  const dataDir = resolveFromConfig(configDirectory, configuredDataDir);
  const annotationsFile = raw.annotations?.file ? resolveFromConfig(configDirectory, raw.annotations.file) : "";
  const uploadMaxBytes = Number(raw.library?.uploadMaxBytes ?? 100 * 1024 * 1024);
  if (!Number.isSafeInteger(uploadMaxBytes) || uploadMaxBytes < 1_000_000) {
    throw new TypeError("library.uploadMaxBytes skal være et heltal på mindst 1000000 bytes.");
  }
  const maxRevisionsPerBook = Number(raw.library?.maxRevisionsPerBook ?? 25);
  if (!Number.isSafeInteger(maxRevisionsPerBook) || maxRevisionsPerBook < 2 || maxRevisionsPerBook > 1_000) {
    throw new TypeError("library.maxRevisionsPerBook skal være et heltal mellem 2 og 1000.");
  }
  const sessionHours = Number(raw.auth?.sessionHours ?? 24 * 14);
  const invitationHours = Number(raw.auth?.invitationHours ?? 24 * 7);
  if (!Number.isFinite(sessionHours) || sessionHours < 1) throw new TypeError("auth.sessionHours skal være mindst 1.");
  if (!Number.isFinite(invitationHours) || invitationHours < 1) throw new TypeError("auth.invitationHours skal være mindst 1.");

  return {
    configPath: absoluteConfigPath,
    server: { host: raw.server?.host ?? "127.0.0.1", port: Number(raw.server?.port ?? 4173) },
    library: {
      dataDir,
      catalogDatabase: process.env.PBA_CATALOG_DATABASE
        ? resolve(process.env.PBA_CATALOG_DATABASE)
        : process.env.PBA_DATA_DIR
          ? join(dataDir, "catalog.sqlite")
          : resolveFromConfig(configDirectory, raw.library?.catalogDatabase ?? join(configuredDataDir, "catalog.sqlite")),
      defaultBookId: String(raw.library?.defaultBookId ?? raw.book?.id ?? ""),
      uploadMaxBytes,
      maxRevisionsPerBook,
    },
    book: raw.book ? {
      id: String(raw.book.id), title: String(raw.book.title), subtitle: String(raw.book.subtitle ?? ""),
      mark: String(raw.book.mark ?? raw.book.title.slice(0, 1)), language: String(raw.book.language ?? "da"),
      sourceDir: resolveFromConfig(configDirectory, raw.book.sourceDir), document: String(raw.book.document),
      navigation: raw.book.navigation ? String(raw.book.navigation) : "", paginationTimeoutMs,
      buildId: String(raw.book.buildId ?? ""),
    } : null,
    annotations: { file: annotationsFile },
    collaboration: {
      database: process.env.PBA_COLLABORATION_DATABASE
        ? resolve(process.env.PBA_COLLABORATION_DATABASE)
        : process.env.PBA_DATA_DIR
          ? join(dataDir, "collaboration.sqlite")
          : resolveFromConfig(configDirectory, raw.collaboration?.database ?? join(configuredDataDir, "collaboration.sqlite")),
    },
    auth: { sessionHours, invitationHours },
    access: resolveAccessPolicy(raw.access),
    security: {
      allowedOrigins: (raw.security?.allowedOrigins ?? []).map(String),
      secureCookies: Boolean(raw.security?.secureCookies ?? false),
    },
    logging: resolveLoggingConfig(raw.logging),
    mcp: { enabled: raw.mcp?.enabled ?? true, endpoint: String(raw.mcp?.endpoint ?? "/mcp") },
  };
}
