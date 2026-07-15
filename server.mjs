import { mkdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCESS_PRESETS, PERMISSIONS, resolveAccessPolicy } from "./src/server/access-policy.mjs";
import { ANNOTATION_SCHEMA_VERSION, AnnotationRepository } from "./src/server/annotation-repository.mjs";
import { ApplicationError, BookCollaboration } from "./src/server/application-service.mjs";
import { BookContentIndex } from "./src/server/book-content-index.mjs";
import { BookCatalogRepository } from "./src/server/book-catalog-repository.mjs";
import { LocalBookStorage } from "./src/server/book-storage.mjs";
import { BOOK_ROLES, COLLABORATION_SCHEMA_VERSION, CollaborationRepository, USER_ROLES } from "./src/server/collaboration-repository.mjs";
import { LibraryApplication } from "./src/server/library-application.mjs";
import { ManagedBookCatalog } from "./src/server/managed-book-catalog.mjs";
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

async function requestContext(request, service, { bookId } = {}) {
  const cookies = parseCookies(request);
  const guestId = cookies[guestCookieName] || `guest-${Bun.randomUUIDv7()}`;
  return {
    cookies,
    guestId,
    setGuestCookie: !cookies[guestCookieName],
    principal: await service.resolvePrincipal({
      bookId,
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

function publicConfig(config, service, principal, { managed = false } = {}) {
  const assetRoot = managed ? `/books/${encodeURIComponent(config.book.id)}/assets` : "/book";
  return {
    schemaVersion: 2,
    annotationSchemaVersion: ANNOTATION_SCHEMA_VERSION,
    runtime: { name: "Bun", version: Bun.version },
    book: {
      id: config.book.id, title: config.book.title, subtitle: config.book.subtitle, mark: config.book.mark,
      language: config.book.language, documentUrl: `${assetRoot}/${encodeURI(config.book.document)}`,
      navigationUrl: config.book.navigation ? `${assetRoot}/${encodeURI(config.book.navigation)}` : "",
      paginationTimeoutMs: config.book.paginationTimeoutMs, buildId: config.book.buildId, revisionId: config.book.revisionId ?? "legacy",
    },
    access: { ...service.policy },
    session: service.session(principal),
    features: { textAnnotations: true, elementAnnotations: true, pageAnnotations: true, importExport: true, admin: true, mcp: config.mcp.enabled },
  };
}

async function apiResponse(request, pathname, url, context, service, config, { platform = null, managed = false } = {}) {
  const { principal, cookies } = context;
  if (request.method === "GET" && pathname === "/api/config") return jsonResponse(200, publicConfig(config, service, principal, { managed }));
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
    const input = await readJson(request);
    const target = platform && input.bookId ? platform.serviceForBook(input.bookId) : service;
    const result = await target.register(input);
    return withCookie(jsonResponse(201, target.session(result.principal)), cookie(sessionCookieName, result.secret, { maxAge: config.auth.sessionHours * 3600, secure: config.security.secureCookies }));
  }
  if (request.method === "POST" && pathname === "/api/auth/invitations/accept") {
    const input = await readJson(request);
    const target = platform && input.bookId ? platform.serviceForBook(input.bookId) : service;
    const result = await target.acceptInvitation(input);
    return withCookie(jsonResponse(200, target.session(result.principal)), cookie(sessionCookieName, result.secret, { maxAge: config.auth.sessionHours * 3600, secure: config.security.secureCookies }));
  }
  if (request.method === "POST" && pathname === "/api/auth/access-codes/accept" && platform) {
    const result = await platform.acceptAccessCode(await readJson(request));
    return withCookie(jsonResponse(200, platform.sessionForBook(result.principal, result.principal.bookId)), cookie(sessionCookieName, result.secret, { maxAge: config.auth.sessionHours * 3600, secure: config.security.secureCookies }));
  }
  if (request.method === "GET" && pathname === "/api/account/export") {
    return jsonResponse(200, await (managed && platform ? platform.exportUserData(principal) : service.exportUserData(principal)));
  }
  if (request.method === "DELETE" && pathname === "/api/account") {
    const erased = await (managed && platform ? platform.eraseUserData(principal) : service.eraseUserData(principal));
    return withCookie(jsonResponse(200, { erased }), cookie(sessionCookieName, "", { maxAge: 0, secure: config.security.secureCookies }));
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

async function libraryAdminResponse(request, pathname, url, context, platform, config) {
  const { principal } = context;
  if (pathname === "/api/admin/books" && request.method === "GET") {
    return jsonResponse(200, { books: platform.listBooks(principal) });
  }
  if (pathname === "/api/admin/books" && request.method === "POST") {
    return jsonResponse(201, { book: platform.createBook(principal, await readJson(request)) });
  }
  if (pathname === "/api/admin/users" && request.method === "GET") {
    return jsonResponse(200, { users: platform.listUsers(principal) });
  }
  if (pathname === "/api/admin/users" && request.method === "POST") {
    return jsonResponse(201, { user: await platform.createUser(principal, await readJson(request)) });
  }
  const globalUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (globalUserMatch && request.method === "PATCH") {
    return jsonResponse(200, { user: platform.updateUser(principal, globalUserMatch[1], await readJson(request)) });
  }
  const globalPasswordMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
  if (globalPasswordMatch && request.method === "PUT") {
    const input = await readJson(request);
    return jsonResponse(200, { user: await platform.resetUserPassword(principal, globalPasswordMatch[1], input.newPassword) });
  }
  if (pathname === "/api/admin/tokens" && request.method === "GET") {
    return jsonResponse(200, { tokens: platform.listTokens(principal) });
  }
  if (pathname === "/api/admin/tokens" && request.method === "POST") {
    return jsonResponse(201, { token: await platform.createToken(principal, await readJson(request)) });
  }
  const globalTokenMatch = pathname.match(/^\/api\/admin\/tokens\/([^/]+)$/);
  if (globalTokenMatch && request.method === "DELETE") {
    return jsonResponse(200, { revoked: platform.revokeToken(principal, globalTokenMatch[1]) });
  }

  const match = pathname.match(/^\/api\/admin\/books\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const bookId = platform.resolveBookId(match[1]);
  const tail = match[2] ?? "";
  if (!tail && request.method === "GET") {
    return jsonResponse(200, { book: platform.getBook(principal, bookId), access: platform.accessSettings(principal, bookId) });
  }
  if (!tail && request.method === "DELETE") return jsonResponse(200, { book: platform.archiveBook(principal, bookId) });
  if (tail === "overview" && request.method === "GET") {
    const members = platform.listMembers(principal, bookId);
    const annotations = await platform.listAnnotations(principal, bookId);
    return jsonResponse(200, {
      members: members.length,
      annotations: annotations.annotations.length,
      openAnnotations: annotations.annotations.filter((item) => item.status === "open").length,
    });
  }
  if (tail === "access" && request.method === "GET") return jsonResponse(200, { access: platform.accessSettings(principal, bookId) });
  if (tail === "access" && request.method === "PUT") return jsonResponse(200, { access: platform.updateAccessSettings(principal, bookId, await readJson(request)) });
  if (tail === "members" && request.method === "GET") return jsonResponse(200, { members: platform.listMembers(principal, bookId) });
  const memberMatch = tail.match(/^members\/([^/]+)$/);
  if (memberMatch && request.method === "PUT") {
    return jsonResponse(200, { user: platform.updateUser(principal, memberMatch[1], { ...await readJson(request), bookId }) });
  }
  if (tail === "invitations" && request.method === "GET") return jsonResponse(200, { invitations: platform.listInvitations(principal, bookId) });
  if (tail === "invitations" && request.method === "POST") return jsonResponse(201, { invitation: await platform.createInvitation(principal, bookId, await readJson(request)) });
  const invitationMatch = tail.match(/^invitations\/([^/]+)$/);
  if (invitationMatch && request.method === "DELETE") return jsonResponse(200, { revoked: platform.revokeInvitation(principal, bookId, invitationMatch[1]) });
  if (tail === "access-codes" && request.method === "GET") return jsonResponse(200, { accessCodes: platform.listAccessCodes(principal, bookId) });
  if (tail === "access-codes" && request.method === "POST") return jsonResponse(201, { accessCode: await platform.createAccessCode(principal, bookId, await readJson(request)) });
  const accessCodeMatch = tail.match(/^access-codes\/([^/]+)$/);
  if (accessCodeMatch && request.method === "DELETE") return jsonResponse(200, { revoked: platform.revokeAccessCode(principal, bookId, accessCodeMatch[1]) });
  if (tail === "revisions" && request.method === "GET") return jsonResponse(200, { revisions: platform.listBookRevisions(principal, bookId) });
  const publishMatch = tail.match(/^revisions\/([^/]+)\/publish$/);
  if (publishMatch && request.method === "POST") return jsonResponse(200, platform.publishBookRevision(principal, bookId, publishMatch[1]));
  if (tail === "uploads" && request.method === "POST") return jsonResponse(201, platform.createBookUpload(principal, bookId, await readJson(request)));
  const uploadContentMatch = tail.match(/^uploads\/([^/]+)\/content$/);
  if (uploadContentMatch && request.method === "PUT") return jsonResponse(200, await platform.writeBookUpload(principal, bookId, uploadContentMatch[1], request));
  const validateUploadMatch = tail.match(/^uploads\/([^/]+)\/validate$/);
  if (validateUploadMatch && request.method === "POST") return jsonResponse(200, await platform.validateBookUpload(principal, bookId, validateUploadMatch[1]));
  if (tail === "annotations" && request.method === "GET") return jsonResponse(200, await platform.listAnnotations(principal, bookId));
  if (tail === "annotations/export" && request.method === "GET") {
    const exported = await platform.exportAnnotations(principal, bookId, url.searchParams.get("format") ?? "json");
    return new Response(exported.body, { status: 200, headers: {
      "Content-Type": exported.contentType,
      "Content-Disposition": `attachment; filename="${bookId}.annotations.${exported.extension}"`,
      "Cache-Control": "no-store",
    } });
  }
  const annotationMatch = tail.match(/^annotations\/([^/]+)$/);
  if (annotationMatch && request.method === "PUT") {
    const annotation = await platform.updateAnnotation(principal, bookId, annotationMatch[1], await readJson(request));
    return jsonResponse(annotation ? 200 : 404, annotation ? { annotation } : { error: "Annotationen findes ikke." });
  }
  if (tail === "progress" && request.method === "GET") return jsonResponse(200, { progress: platform.listAllProgress(principal, bookId) });
  if (tail === "tokens" && request.method === "GET") return jsonResponse(200, { tokens: platform.listTokens(principal, { bookId }) });
  if (tail === "audit" && request.method === "GET") return jsonResponse(200, { events: platform.listAudit(principal, { bookId, limit: url.searchParams.get("limit") }) });
  return null;
}

async function routeBookViewerRequest(request, { config, service, platform = null, state, logger }) {
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
      status: "ok", bookId: service?.bookId ?? platform?.defaultBookId ?? null, runtime: { name: "Bun", version: Bun.version },
      schemas: { annotations: ANNOTATION_SCHEMA_VERSION, collaboration: COLLABORATION_SCHEMA_VERSION },
      storage: service?.health() ?? { collaboration: platform?.collaboration.health() ? "ok" : "unavailable" },
    });
  }
  if (config.mcp.enabled && pathname === config.mcp.endpoint && ["GET", "POST", "DELETE"].includes(request.method)) {
    state.principalKind = bearerToken(request) ? "token" : "anonymous";
    return handleMcpHttpRequest(request, { service: platform ?? service, config, bearerToken: bearerToken(request), logger });
  }

  let activeService = service;
  let activeConfig = config;
  let apiPathname = pathname;
  let managed = false;
  let managedBookId = "";
  const managedApiMatch = platform && pathname.match(/^\/api\/books\/([^/]+)(\/.*)?$/);
  const managedReaderMatch = platform && pathname.match(/^\/books\/([^/]+)(?:\/|$)/);
  if (managedApiMatch) {
    managedBookId = platform.resolveBookId(managedApiMatch[1]);
    const book = platform.bookContext(managedBookId);
    activeService = platform.serviceForBook(managedBookId);
    activeConfig = book.config;
    apiPathname = `/api${managedApiMatch[2] ?? ""}`;
    managed = true;
  }
  const requestBookId = managedBookId || (managedReaderMatch ? platform.resolveBookId(managedReaderMatch[1]) : "");
  const context = await requestContext(request, platform ?? activeService, { bookId: requestBookId || platform?.defaultBookId });
  state.principalKind = principalKind(context.principal);

  if (platform && pathname.startsWith("/api/admin/")) {
    const response = await libraryAdminResponse(request, pathname, url, context, platform, config);
    if (response) return withContextCookie(response, context, config);
  }
  if (pathname.startsWith("/api/")) {
    if (platform && pathname === "/api/config" && !activeService) {
      const canAdminister = context.principal?.kind === "local" || context.principal?.globalRole === "instance_admin" || context.principal?.instanceAdmin === true;
      return withContextCookie(jsonResponse(200, {
        schemaVersion: 2,
        runtime: { name: "Bun", version: Bun.version },
        book: null,
        session: { principal: context.principal, capabilities: { canManageUsers: canAdminister } },
        features: { admin: true, mcp: config.mcp.enabled },
      }), context, config);
    }
    if (!activeService) throw new ApplicationError(404, "Biblioteket har endnu ingen bøger.", "empty_library");
    const response = await apiResponse(request, apiPathname, url, context, activeService, activeConfig, { platform, managed });
    if (response) return withContextCookie(response, context, config);
  }

  const readsStaticFile = request.method === "GET" || request.method === "HEAD";
  const managedAssetMatch = platform && pathname.match(/^\/books\/([^/]+)\/assets\/(.+)$/);
  if (readsStaticFile && managedAssetMatch) {
    const bookId = platform.resolveBookId(managedAssetMatch[1]);
    const book = platform.bookContext(bookId);
    platform.serviceForBook(bookId).assertCanRead(platform.principalForBook(context.principal, bookId));
    const response = await staticFileResponse(book.config.book.sourceDir, `/${managedAssetMatch[2]}`, { headOnly: request.method === "HEAD" });
    if (response) return withContextCookie(response, context, config);
  }
  if (readsStaticFile && pathname.startsWith("/book/")) {
    service.assertCanRead(context.principal);
    const response = await staticFileResponse(config.book.sourceDir, pathname.slice("/book".length), { headOnly: request.method === "HEAD" });
    if (response) return withContextCookie(response, context, config);
  }
  if (readsStaticFile) {
    const isManagedReader = platform && /^\/books\/[^/]+\/?$/.test(pathname);
    const viewerPath = pathname === "/" || pathname === "/preview.html" || isManagedReader ? "/index.html" : pathname === "/admin" || pathname === "/admin/" ? "/admin/index.html" : pathname;
    const response = await staticFileResponse(publicRoot, viewerPath, { headOnly: request.method === "HEAD" });
    if (response) return withContextCookie(response, context, config);
  }
  return withContextCookie(jsonResponse(404, { error: "Ressourcen findes ikke." }), context, config);
}

export async function handleBookViewerRequest(request, {
  config,
  service,
  platform = null,
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
    response = await routeBookViewerRequest(request, { config, service, platform, state, logger });
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
  repository,
  collaborationRepository,
  bookContentIndex,
  service,
  platform = null,
  hostname = config.server.host,
  port = config.server.port,
  logger = createOperationalLogger({ ...config.logging, baseFields: { component: "http", bookId: config.book?.id ?? "library" } }),
  createRequestId,
  monotonicClock,
}) {
  if (!service && !platform) {
    repository ??= new AnnotationRepository({ filePath: config.annotations.file, bookId: config.book.id });
    collaborationRepository ??= new CollaborationRepository({
      filePath: config.collaboration.database, bookId: config.book.id,
      sessionHours: config.auth.sessionHours, invitationHours: config.auth.invitationHours,
    });
    bookContentIndex ??= config.book.sourceDir && config.book.document
      ? new BookContentIndex({ filePath: resolve(config.book.sourceDir, config.book.document), bookId: config.book.id, buildId: config.book.buildId })
      : null;
    service = new BookCollaboration({ config, annotationRepository: repository, collaborationRepository, bookContentIndex });
  }
  collaborationRepository ??= platform?.collaboration;
  const server = Bun.serve({
    hostname, port, maxRequestBodySize: config.library?.uploadMaxBytes ?? maximumRequestBytes,
    fetch: (request) => handleBookViewerRequest(request, { config, service, platform, logger, createRequestId, monotonicClock }),
    error(error) { logger.error("server.fetch_error", errorMetadata(error)); return jsonResponse(500, { error: "Intern serverfejl." }); },
  });
  server.bookApplicationService = service;
  server.libraryApplication = platform;
  server.collaborationRepository = collaborationRepository;
  server.operationalLogger = logger;
  logger.info("server.started", { host: hostname, port: server.port, runtime: `Bun ${Bun.version}`, accessPreset: config.access.preset, mode: platform ? "managed-library" : "legacy" });
  return server;
}

export async function startBookViewer(options = {}) {
  const configPath = options.configPath ?? resolve(repositoryRoot, "book-viewer.config.example.json");
  const config = await loadBookViewerConfig(configPath);
  const hostname = options.host ?? config.server.host;
  const port = options.port ?? config.server.port;
  const logger = options.logger ?? createOperationalLogger({ ...config.logging, baseFields: { component: "http", bookId: config.book?.id ?? "library" } });
  const catalogRepository = new BookCatalogRepository({ filePath: config.library.catalogDatabase });
  const storage = new LocalBookStorage({
    rootDir: config.library.dataDir,
    limits: { maxArchiveBytes: config.library.uploadMaxBytes },
  });
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
    const legacyAnnotations = config.annotations.file && Bun.file(config.annotations.file);
    const managedAnnotations = resolve(config.library.dataDir, "library", config.book.id, "annotations.json");
    if (legacyAnnotations && await legacyAnnotations.exists() && !(await Bun.file(managedAnnotations).exists())) {
      await mkdir(dirname(managedAnnotations), { recursive: true });
      await Bun.write(managedAnnotations, legacyAnnotations);
    }
  }
  const collaborationRepository = new CollaborationRepository({
    filePath: config.collaboration.database,
    sessionHours: config.auth.sessionHours,
    invitationHours: config.auth.invitationHours,
  });
  const platform = new LibraryApplication({ config, catalog, collaborationRepository });
  if (process.env.PBA_ADMIN_EMAIL && process.env.PBA_ADMIN_PASSWORD) {
    const administrator = await collaborationRepository.ensureBootstrapAdmin({
      email: process.env.PBA_ADMIN_EMAIL,
      displayName: process.env.PBA_ADMIN_NAME ?? "Administrator",
      password: process.env.PBA_ADMIN_PASSWORD,
    });
    for (const book of catalog.listBooks()) collaborationRepository.setMembership(administrator.id, "book_admin", { bookId: book.id });
  }
  const service = platform.defaultBookId ? platform.serviceForBook(platform.defaultBookId) : null;
  const server = createBookViewerServer({ config, collaborationRepository, platform, service, hostname, port, logger });
  server.catalogRepository = catalogRepository;
  return { server, config, platform, host: hostname, port: server.port };
}

export async function stopBookViewer(server, { reason = "requested", closeRepository = true } = {}) {
  const logger = server.operationalLogger ?? silentLogger;
  logger.info("server.stopping", { reason });
  await server.stop();
  if (closeRepository) {
    server.collaborationRepository?.close();
    server.catalogRepository?.close();
  }
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
