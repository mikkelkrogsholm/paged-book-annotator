import { stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCESS_PRESETS, PERMISSIONS, resolveAccessPolicy } from "./src/server/access-policy.mjs";
import { ANNOTATION_SCHEMA_VERSION, AnnotationRepository } from "./src/server/annotation-repository.mjs";
import { ApplicationError, BookCollaboration } from "./src/server/application-service.mjs";
import { BookContentIndex } from "./src/server/book-content-index.mjs";
import { BOOK_ROLES, COLLABORATION_SCHEMA_VERSION, CollaborationRepository, USER_ROLES } from "./src/server/collaboration-repository.mjs";
import { handleMcpHttpRequest } from "./src/server/mcp-server.mjs";
import { createOperationalLogger, resolveLoggingConfig } from "./src/server/operational-logger.mjs";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(repositoryRoot, "public");
const maximumRequestBytes = 1_000_000;
const sessionCookieName = "pba_session";
const guestCookieName = "pba_guest";
const silentLogger = createOperationalLogger({ level: "silent" });

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".gif", "image/gif"], [".html", "text/html; charset=utf-8"],
  [".xhtml", "application/xhtml+xml; charset=utf-8"], [".ico", "image/x-icon"], [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"], [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"], [".otf", "font/otf"], [".png", "image/png"],
  [".svg", "image/svg+xml"], [".ttf", "font/ttf"], [".webp", "image/webp"],
  [".woff", "font/woff"], [".woff2", "font/woff2"],
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
  const annotationsFile = resolveFromConfig(configDirectory, raw.annotations.file);
  const sessionHours = Number(raw.auth?.sessionHours ?? 24 * 14);
  const invitationHours = Number(raw.auth?.invitationHours ?? 24 * 7);
  if (!Number.isFinite(sessionHours) || sessionHours < 1) throw new TypeError("auth.sessionHours skal være mindst 1.");
  if (!Number.isFinite(invitationHours) || invitationHours < 1) throw new TypeError("auth.invitationHours skal være mindst 1.");

  return {
    configPath: absoluteConfigPath,
    server: { host: raw.server?.host ?? "127.0.0.1", port: Number(raw.server?.port ?? 4173) },
    book: {
      id: String(raw.book.id), title: String(raw.book.title), subtitle: String(raw.book.subtitle ?? ""),
      mark: String(raw.book.mark ?? raw.book.title.slice(0, 1)), language: String(raw.book.language ?? "da"),
      sourceDir: resolveFromConfig(configDirectory, raw.book.sourceDir), document: String(raw.book.document),
      navigation: raw.book.navigation ? String(raw.book.navigation) : "", paginationTimeoutMs,
      buildId: String(raw.book.buildId ?? ""),
    },
    annotations: { file: annotationsFile },
    collaboration: {
      database: resolveFromConfig(configDirectory, raw.collaboration?.database ?? `${raw.annotations.file}.collaboration.sqlite`),
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

function isPathInside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function localHostHeaderIsAllowed(hostHeader) {
  const host = String(hostHeader ?? "").toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "";
}

function originIsAllowed(originHeader, allowedOrigins = []) {
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    const hostname = origin.hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || allowedOrigins.includes(origin.origin);
  } catch {
    return false;
  }
}

function jsonResponse(status, value, headers = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  return new Response(body, { status, headers: {
    "Content-Type": "application/json; charset=utf-8", "Content-Length": String(new TextEncoder().encode(body).byteLength),
    "Cache-Control": "no-store", ...headers,
  } });
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.get("cookie") ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
}

function cookie(name, value, { maxAge, secure = false } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${Number.isFinite(maxAge) ? `; Max-Age=${Math.floor(maxAge)}` : ""}${secure ? "; Secure" : ""}`;
}

function withCookie(response, value) {
  response.headers.append("Set-Cookie", value);
  return response;
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function requestId(request, createId) {
  const supplied = request.headers.get("x-request-id") ?? "";
  return /^(?:request-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supplied) ? supplied : createId();
}

function errorMetadata(error) {
  return { errorName: error instanceof Error ? error.name : typeof error, errorCode: error?.code == null ? undefined : String(error.code) };
}

function normalizedRequestPath(pathname, config) {
  if (pathname.startsWith("/book/")) return "/book/*";
  if (pathname === config.mcp.endpoint) return config.mcp.endpoint;
  return pathname
    .replace(/^\/api\/annotations\/[^/]+$/, "/api/annotations/:id")
    .replace(/^\/api\/admin\/users\/[^/]+\/password$/, "/api/admin/users/:id/password")
    .replace(/^\/api\/admin\/(users|invitations|tokens)\/[^/]+$/, "/api/admin/$1/:id");
}

function principalKind(principal) {
  return principal?.kind ?? "anonymous";
}

async function requestContext(request, service) {
  const cookies = parseCookies(request);
  const guestId = cookies[guestCookieName] || `guest-${Bun.randomUUIDv7()}`;
  return {
    cookies,
    guestId,
    setGuestCookie: !cookies[guestCookieName],
    principal: await service.resolvePrincipal({
      sessionSecret: cookies[sessionCookieName] ?? "",
      bearerToken: bearerToken(request),
      guestId,
    }),
  };
}

function withContextCookie(response, context, config) {
  return context.setGuestCookie
    ? withCookie(response, cookie(guestCookieName, context.guestId, { maxAge: 60 * 60 * 24 * 365, secure: config.security.secureCookies }))
    : response;
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
  try { fileStats = await stat(candidate); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!fileStats.isFile()) return null;
  const file = Bun.file(candidate);
  return new Response(headOnly ? null : file, { status: 200, headers: {
    "Content-Type": mimeTypes.get(extname(candidate).toLowerCase()) ?? file.type ?? "application/octet-stream",
    "Content-Length": String(fileStats.size), "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
  } });
}

function publicConfig(config, service, principal) {
  return {
    schemaVersion: 2,
    annotationSchemaVersion: ANNOTATION_SCHEMA_VERSION,
    runtime: { name: "Bun", version: Bun.version },
    book: {
      id: config.book.id, title: config.book.title, subtitle: config.book.subtitle, mark: config.book.mark,
      language: config.book.language, documentUrl: `/book/${encodeURI(config.book.document)}`,
      navigationUrl: config.book.navigation ? `/book/${encodeURI(config.book.navigation)}` : "",
      paginationTimeoutMs: config.book.paginationTimeoutMs, buildId: config.book.buildId,
    },
    access: { ...service.policy },
    session: service.session(principal),
    features: { textAnnotations: true, elementAnnotations: true, pageAnnotations: true, importExport: true, admin: true, mcp: config.mcp.enabled },
  };
}

async function apiResponse(request, pathname, url, context, service, config) {
  const { principal, cookies } = context;
  if (request.method === "GET" && pathname === "/api/config") return jsonResponse(200, publicConfig(config, service, principal));
  if (request.method === "GET" && pathname === "/api/session") return jsonResponse(200, service.session(principal));
  if (request.method === "POST" && pathname === "/api/auth/login") {
    const result = await service.login(await readJson(request));
    return withCookie(jsonResponse(200, service.session(result.principal)), cookie(sessionCookieName, result.secret, { maxAge: config.auth.sessionHours * 3600, secure: config.security.secureCookies }));
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    await service.logout(cookies[sessionCookieName], principal);
    return withCookie(jsonResponse(200, { loggedOut: true }), cookie(sessionCookieName, "", { maxAge: 0, secure: config.security.secureCookies }));
  }
  if (request.method === "POST" && pathname === "/api/auth/password") {
    await service.changeOwnPassword(principal, await readJson(request));
    return withCookie(jsonResponse(200, { changed: true, loginRequired: true }), cookie(sessionCookieName, "", { maxAge: 0, secure: config.security.secureCookies }));
  }
  if (request.method === "POST" && pathname === "/api/auth/register") {
    const result = await service.register(await readJson(request));
    return withCookie(jsonResponse(201, service.session(result.principal)), cookie(sessionCookieName, result.secret, { maxAge: config.auth.sessionHours * 3600, secure: config.security.secureCookies }));
  }
  if (request.method === "POST" && pathname === "/api/auth/invitations/accept") {
    const result = await service.acceptInvitation(await readJson(request));
    return withCookie(jsonResponse(200, service.session(result.principal)), cookie(sessionCookieName, result.secret, { maxAge: config.auth.sessionHours * 3600, secure: config.security.secureCookies }));
  }

  if (request.method === "GET" && pathname === "/api/annotations") return jsonResponse(200, await service.listAnnotations(principal));
  if (request.method === "GET" && pathname === "/api/annotations/export") {
    const exported = await service.exportAnnotations(principal, url.searchParams.get("format") ?? "json");
    return new Response(exported.body, { status: 200, headers: {
      "Content-Type": exported.contentType, "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${config.book.id}.annotations.${exported.extension}"`,
    } });
  }
  if (request.method === "POST" && pathname === "/api/annotations") return jsonResponse(201, await service.createAnnotation(principal, await readJson(request)));
  if (request.method === "POST" && pathname === "/api/annotations/import") {
    const body = await readJson(request);
    return jsonResponse(200, await service.importAnnotations(principal, body.document, body.mode ?? "merge"));
  }
  const annotationMatch = pathname.match(/^\/api\/annotations\/([^/]+)$/);
  if (annotationMatch && request.method === "PUT") {
    const annotation = await service.updateAnnotation(principal, annotationMatch[1], await readJson(request));
    return jsonResponse(annotation ? 200 : 404, annotation ?? { error: "Annotationen findes ikke." });
  }
  if (annotationMatch && request.method === "DELETE") {
    const deleted = await service.deleteAnnotation(principal, annotationMatch[1]);
    return jsonResponse(deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Annotationen findes ikke." });
  }

  if (pathname === "/api/progress" && request.method === "GET") return jsonResponse(200, { progress: service.getProgress(principal) });
  if (pathname === "/api/progress" && request.method === "PUT") return jsonResponse(200, { progress: service.saveProgress(principal, await readJson(request)) });
  if (pathname === "/api/progress/preferences" && request.method === "GET") return jsonResponse(200, { preference: service.getProgressPreference(principal) });
  if (pathname === "/api/progress/preferences" && request.method === "PUT") {
    const input = await readJson(request);
    return jsonResponse(200, { preference: service.setProgressPreference(principal, input.trackingEnabled) });
  }

  if (pathname === "/api/admin/overview" && request.method === "GET") {
    const users = service.listUsers(principal);
    const annotations = await service.listAnnotations(principal);
    return jsonResponse(200, { users: users.length, annotations: annotations.annotations.length, openAnnotations: annotations.annotations.filter((item) => item.status === "open").length });
  }
  if (pathname === "/api/admin/metadata" && request.method === "GET") {
    service.assertPermission(principal, "access:manage");
    return jsonResponse(200, { permissions: PERMISSIONS, userRoles: USER_ROLES, bookRoles: BOOK_ROLES, accessPresets: Object.keys(ACCESS_PRESETS), accessProfiles: ACCESS_PRESETS, activeAccess: service.accessSettings(principal) });
  }
  if (pathname === "/api/admin/access" && request.method === "PUT") return jsonResponse(200, { access: service.updateAccessSettings(principal, await readJson(request)) });
  if (pathname === "/api/admin/users" && request.method === "GET") return jsonResponse(200, { users: service.listUsers(principal) });
  if (pathname === "/api/admin/users" && request.method === "POST") return jsonResponse(201, { user: await service.createUser(principal, await readJson(request)) });
  const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch && request.method === "PATCH") return jsonResponse(200, { user: service.updateUser(principal, userMatch[1], await readJson(request)) });
  const userPasswordMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
  if (userPasswordMatch && request.method === "PUT") {
    const input = await readJson(request);
    return jsonResponse(200, { user: await service.resetUserPassword(principal, userPasswordMatch[1], input.newPassword) });
  }
  if (pathname === "/api/admin/invitations" && request.method === "GET") return jsonResponse(200, { invitations: service.listInvitations(principal) });
  if (pathname === "/api/admin/invitations" && request.method === "POST") return jsonResponse(201, { invitation: await service.createInvitation(principal, await readJson(request)) });
  const inviteMatch = pathname.match(/^\/api\/admin\/invitations\/([^/]+)$/);
  if (inviteMatch && request.method === "DELETE") return jsonResponse(200, { revoked: service.revokeInvitation(principal, inviteMatch[1]) });
  if (pathname === "/api/admin/tokens" && request.method === "GET") return jsonResponse(200, { tokens: service.listTokens(principal) });
  if (pathname === "/api/admin/tokens" && request.method === "POST") return jsonResponse(201, { token: await service.createToken(principal, await readJson(request)) });
  const tokenMatch = pathname.match(/^\/api\/admin\/tokens\/([^/]+)$/);
  if (tokenMatch && request.method === "DELETE") return jsonResponse(200, { revoked: service.revokeToken(principal, tokenMatch[1]) });
  if (pathname === "/api/admin/progress" && request.method === "GET") return jsonResponse(200, { progress: service.listAllProgress(principal) });
  if (pathname === "/api/admin/audit" && request.method === "GET") return jsonResponse(200, { events: service.listAudit(principal, { limit: url.searchParams.get("limit") }) });
  if (pathname === "/api/admin/annotations" && request.method === "GET") return jsonResponse(200, await service.listAnnotations(principal));
  return null;
}

async function routeBookViewerRequest(request, { config, service, state, logger }) {
  if (!localHostHeaderIsAllowed(request.headers.get("host"))) return jsonResponse(403, { error: "Book Viewer accepterer kun lokale værter." });
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !originIsAllowed(request.headers.get("origin"), config.security.allowedOrigins)) {
    return jsonResponse(403, { error: "Origin er ikke tilladt." });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" } });
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);
  state.path = normalizedRequestPath(pathname, config);
  if (request.method === "GET" && pathname === "/api/health") {
    return jsonResponse(200, {
      status: "ok", bookId: config.book.id, runtime: { name: "Bun", version: Bun.version },
      schemas: { annotations: ANNOTATION_SCHEMA_VERSION, collaboration: COLLABORATION_SCHEMA_VERSION },
      storage: service.health(),
    });
  }
  if (config.mcp.enabled && pathname === config.mcp.endpoint && ["GET", "POST", "DELETE"].includes(request.method)) {
    state.principalKind = bearerToken(request) ? "token" : "anonymous";
    return handleMcpHttpRequest(request, { service, config, bearerToken: bearerToken(request), logger });
  }
  const context = await requestContext(request, service);
  state.principalKind = principalKind(context.principal);
  if (pathname.startsWith("/api/")) {
    const response = await apiResponse(request, pathname, url, context, service, config);
    if (response) return withContextCookie(response, context, config);
  }

  const readsStaticFile = request.method === "GET" || request.method === "HEAD";
  if (readsStaticFile && pathname.startsWith("/book/")) {
    service.assertCanRead(context.principal);
    const response = await staticFileResponse(config.book.sourceDir, pathname.slice("/book".length), { headOnly: request.method === "HEAD" });
    if (response) return withContextCookie(response, context, config);
  }
  if (readsStaticFile) {
    const viewerPath = pathname === "/" || pathname === "/preview.html" ? "/index.html" : pathname === "/admin" || pathname === "/admin/" ? "/admin/index.html" : pathname;
    const response = await staticFileResponse(publicRoot, viewerPath, { headOnly: request.method === "HEAD" });
    if (response) return withContextCookie(response, context, config);
  }
  return withContextCookie(jsonResponse(404, { error: "Ressourcen findes ikke." }), context, config);
}

export async function handleBookViewerRequest(request, {
  config,
  service,
  logger = silentLogger,
  createRequestId = () => `request-${Bun.randomUUIDv7()}`,
  monotonicClock = () => performance.now(),
} = {}) {
  const startedAt = monotonicClock();
  const id = requestId(request, createRequestId);
  const rawPath = new URL(request.url).pathname;
  const state = { path: normalizedRequestPath(rawPath, config), principalKind: "anonymous" };
  let response;
  try {
    response = await routeBookViewerRequest(request, { config, service, state, logger });
  } catch (error) {
    const status = error instanceof ApplicationError ? error.status : error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError ? 400 : 500;
    logger.error("request.failed", { requestId: id, method: request.method, path: state.path, status, ...errorMetadata(error) });
    const publicMessage = status === 500 ? "Intern serverfejl." : error instanceof Error ? error.message : String(error);
    response = jsonResponse(status, { error: publicMessage, code: error instanceof ApplicationError ? error.code : undefined });
  }
  response.headers.set("X-Request-Id", id);
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  logger.info("request.completed", {
    requestId: id, method: request.method, path: state.path, status: response.status,
    durationMs: Math.max(0, Number((monotonicClock() - startedAt).toFixed(3))), principalKind: state.principalKind,
  });
  return response;
}

export function createBookViewerServer({
  config,
  repository = new AnnotationRepository({ filePath: config.annotations.file, bookId: config.book.id }),
  collaborationRepository = new CollaborationRepository({
    filePath: config.collaboration.database, bookId: config.book.id,
    sessionHours: config.auth.sessionHours, invitationHours: config.auth.invitationHours,
  }),
  bookContentIndex = config.book.sourceDir && config.book.document
    ? new BookContentIndex({ filePath: resolve(config.book.sourceDir, config.book.document), bookId: config.book.id, buildId: config.book.buildId })
    : null,
  service = new BookCollaboration({ config, annotationRepository: repository, collaborationRepository, bookContentIndex }),
  hostname = config.server.host,
  port = config.server.port,
  logger = createOperationalLogger({ ...config.logging, baseFields: { component: "http", bookId: config.book.id } }),
  createRequestId,
  monotonicClock,
}) {
  const server = Bun.serve({
    hostname, port,
    fetch: (request) => handleBookViewerRequest(request, { config, service, logger, createRequestId, monotonicClock }),
    error(error) { logger.error("server.fetch_error", errorMetadata(error)); return jsonResponse(500, { error: "Intern serverfejl." }); },
  });
  server.bookApplicationService = service;
  server.collaborationRepository = collaborationRepository;
  server.operationalLogger = logger;
  logger.info("server.started", { host: hostname, port: server.port, runtime: `Bun ${Bun.version}`, accessPreset: config.access.preset });
  return server;
}

export async function startBookViewer(options = {}) {
  const configPath = options.configPath ?? resolve(repositoryRoot, "book-viewer.config.example.json");
  const config = await loadBookViewerConfig(configPath);
  const hostname = options.host ?? config.server.host;
  const port = options.port ?? config.server.port;
  const logger = options.logger ?? createOperationalLogger({ ...config.logging, baseFields: { component: "http", bookId: config.book.id } });
  const collaborationRepository = new CollaborationRepository({
    filePath: config.collaboration.database,
    bookId: config.book.id,
    sessionHours: config.auth.sessionHours,
    invitationHours: config.auth.invitationHours,
  });
  if (process.env.PBA_ADMIN_EMAIL && process.env.PBA_ADMIN_PASSWORD) {
    await collaborationRepository.ensureBootstrapAdmin({
      email: process.env.PBA_ADMIN_EMAIL,
      displayName: process.env.PBA_ADMIN_NAME ?? "Administrator",
      password: process.env.PBA_ADMIN_PASSWORD,
    });
  }
  const server = createBookViewerServer({ config, collaborationRepository, hostname, port, logger });
  return { server, config, host: hostname, port: server.port };
}

export async function stopBookViewer(server, { reason = "requested", closeRepository = true } = {}) {
  const logger = server.operationalLogger ?? silentLogger;
  logger.info("server.stopping", { reason });
  await server.stop();
  if (closeRepository) server.collaborationRepository?.close();
  logger.info("server.stopped", { reason });
}

if (import.meta.main) {
  const options = parseArguments(Bun.argv.slice(2));
  const running = await startBookViewer(options);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await stopBookViewer(running.server, { reason: signal.toLowerCase() });
    });
  }
}
