import { stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ANNOTATION_SCHEMA_VERSION, AnnotationRepository } from "./src/server/annotation-repository.mjs";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(repositoryRoot, "public");
const maximumRequestBytes = 1_000_000;

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".xhtml", "application/xhtml+xml; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".otf", "font/otf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function parseArguments(argv) {
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

function resolveFromConfig(configDirectory, path) {
  return isAbsolute(path) ? path : resolve(configDirectory, path);
}

export async function loadBookViewerConfig(configPath) {
  const absoluteConfigPath = resolve(configPath);
  const configDirectory = dirname(absoluteConfigPath);
  const raw = await Bun.file(absoluteConfigPath).json();
  if (!raw.book?.id || !raw.book?.title || !raw.book?.sourceDir || !raw.book?.document) {
    throw new TypeError("Konfigurationen kræver book.id, book.title, book.sourceDir og book.document.");
  }
  if (!raw.annotations?.file) throw new TypeError("Konfigurationen kræver annotations.file.");
  const paginationTimeoutMs = Number(raw.book.paginationTimeoutMs ?? 45_000);
  if (!Number.isSafeInteger(paginationTimeoutMs) || paginationTimeoutMs < 5_000 || paginationTimeoutMs > 300_000) {
    throw new TypeError("book.paginationTimeoutMs skal være et heltal mellem 5000 og 300000.");
  }

  return {
    configPath: absoluteConfigPath,
    server: {
      host: raw.server?.host ?? "127.0.0.1",
      port: Number(raw.server?.port ?? 4173),
    },
    book: {
      id: String(raw.book.id),
      title: String(raw.book.title),
      subtitle: String(raw.book.subtitle ?? ""),
      mark: String(raw.book.mark ?? raw.book.title.slice(0, 1)),
      language: String(raw.book.language ?? "da"),
      sourceDir: resolveFromConfig(configDirectory, raw.book.sourceDir),
      document: String(raw.book.document),
      navigation: raw.book.navigation ? String(raw.book.navigation) : "",
      paginationTimeoutMs,
    },
    annotations: {
      file: resolveFromConfig(configDirectory, raw.annotations.file),
    },
  };
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function localHostHeaderIsAllowed(hostHeader) {
  const host = String(hostHeader ?? "").toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "";
}

function localOriginIsAllowed(originHeader) {
  if (!originHeader) return true;
  try {
    const hostname = new URL(originHeader).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function jsonResponse(status, value, headers = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

async function readJson(request) {
  const declaredBytes = Number(request.headers.get("content-length") ?? 0);
  if (declaredBytes > maximumRequestBytes) throw new RangeError("Forespørgslen er for stor.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maximumRequestBytes) throw new RangeError("Forespørgslen er for stor.");
  if (bytes.byteLength === 0) return {};
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function staticFileResponse(root, requestPath, { headOnly = false } = {}) {
  const candidate = resolve(root, `.${requestPath}`);
  if (!isPathInside(root, candidate)) return null;
  let fileStats;
  try {
    fileStats = await stat(candidate);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!fileStats.isFile()) return null;

  const file = Bun.file(candidate);
  return new Response(headOnly ? null : file, {
    status: 200,
    headers: {
      "Content-Type": mimeTypes.get(extname(candidate).toLowerCase()) ?? file.type ?? "application/octet-stream",
      "Content-Length": String(fileStats.size),
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function publicConfig(config) {
  return {
    schemaVersion: 1,
    annotationSchemaVersion: ANNOTATION_SCHEMA_VERSION,
    runtime: { name: "Bun", version: Bun.version },
    book: {
      id: config.book.id,
      title: config.book.title,
      subtitle: config.book.subtitle,
      mark: config.book.mark,
      language: config.book.language,
      documentUrl: `/book/${encodeURI(config.book.document)}`,
      navigationUrl: config.book.navigation ? `/book/${encodeURI(config.book.navigation)}` : "",
      paginationTimeoutMs: config.book.paginationTimeoutMs,
    },
    features: {
      textAnnotations: true,
      elementAnnotations: true,
      pageAnnotations: true,
      importExport: true,
    },
  };
}

export async function handleBookViewerRequest(request, { config, repository }) {
  try {
    if (!localHostHeaderIsAllowed(request.headers.get("host"))) {
      return jsonResponse(403, { error: "Book Viewer accepterer kun lokale værter." });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !localOriginIsAllowed(request.headers.get("origin"))) {
      return jsonResponse(403, { error: "Skrivekald accepteres kun fra den lokale Book Viewer." });
    }

    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === "GET" && pathname === "/api/config") {
      return jsonResponse(200, publicConfig(config));
    }
    if (request.method === "GET" && pathname === "/api/annotations") {
      return jsonResponse(200, await repository.list());
    }
    if (request.method === "GET" && pathname === "/api/annotations/export") {
      return jsonResponse(200, await repository.list(), {
        "Content-Disposition": `attachment; filename="${config.book.id}.annotations.json"`,
      });
    }
    if (request.method === "POST" && pathname === "/api/annotations") {
      return jsonResponse(201, await repository.create(await readJson(request)));
    }
    if (request.method === "POST" && pathname === "/api/annotations/import") {
      const body = await readJson(request);
      return jsonResponse(200, await repository.importDocument(body.document, body.mode ?? "merge"));
    }

    const annotationMatch = pathname.match(/^\/api\/annotations\/([^/]+)$/);
    if (annotationMatch && request.method === "PUT") {
      const annotation = await repository.update(annotationMatch[1], await readJson(request));
      return jsonResponse(annotation ? 200 : 404, annotation ?? { error: "Annotationen findes ikke." });
    }
    if (annotationMatch && request.method === "DELETE") {
      const deleted = await repository.delete(annotationMatch[1]);
      return jsonResponse(deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Annotationen findes ikke." });
    }

    const readsStaticFile = request.method === "GET" || request.method === "HEAD";
    if (readsStaticFile && pathname.startsWith("/book/")) {
      const response = await staticFileResponse(config.book.sourceDir, pathname.slice("/book".length), {
        headOnly: request.method === "HEAD",
      });
      if (response) return response;
    }
    if (readsStaticFile) {
      const viewerPath = pathname === "/" || pathname === "/preview.html" ? "/index.html" : pathname;
      const response = await staticFileResponse(publicRoot, viewerPath, { headOnly: request.method === "HEAD" });
      if (response) return response;
    }

    return jsonResponse(404, { error: "Ressourcen findes ikke." });
  } catch (error) {
    const status = error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError ? 400 : 500;
    return jsonResponse(status, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function createBookViewerServer({
  config,
  repository = new AnnotationRepository({ filePath: config.annotations.file, bookId: config.book.id }),
  hostname = config.server.host,
  port = config.server.port,
}) {
  return Bun.serve({
    hostname,
    port,
    fetch: (request) => handleBookViewerRequest(request, { config, repository }),
    error(error) {
      console.error(error);
      return jsonResponse(500, { error: "Intern serverfejl." });
    },
  });
}

export async function startBookViewer(options = {}) {
  const configPath = options.configPath ?? resolve(repositoryRoot, "book-viewer.config.example.json");
  const config = await loadBookViewerConfig(configPath);
  const hostname = options.host ?? config.server.host;
  const port = options.port ?? config.server.port;
  const server = createBookViewerServer({ config, hostname, port });
  return { server, config, host: hostname, port: server.port };
}

if (import.meta.main) {
  const options = parseArguments(Bun.argv.slice(2));
  const running = await startBookViewer(options);
  console.log(`Book Viewer: http://${running.host}:${running.port}/preview.html`);
  console.log(`Runtime: Bun ${Bun.version}`);
  console.log(`Bog: ${running.config.book.title}`);
  console.log(`Annotationer: ${running.config.annotations.file}`);
}
