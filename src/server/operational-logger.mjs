const LEVEL_PRIORITY = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });
const LOG_FORMATS = Object.freeze(["json", "pretty"]);
const REDACTED = "[REDACTED]";

function normalizedKey(key) {
  return String(key).replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function keyContainsSecret(key) {
  const normalized = normalizedKey(key);
  if (normalized === "tokenid" || normalized === "tokenprefix") return false;
  return normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized === "token"
    || normalized.includes("password")
    || normalized.includes("secret")
    || normalized.includes("apikey")
    || normalized.includes("accesstoken")
    || normalized.includes("refreshtoken")
    || normalized.includes("bearertoken")
    || normalized.includes("sessiontoken")
    || normalized.includes("invitationtoken");
}

function scrubString(value) {
  return value
    .replaceAll(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replaceAll(/\b(pba_(?:session|guest)|password|api[_-]?key|access[_-]?token|refresh[_-]?token)=([^\s,;&]+)/gi, "$1=[REDACTED]");
}

function safeValue(value, options, seen, depth) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") return String(value);
  if (depth > options.maximumDepth) return "[MAX_DEPTH]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const error = { name: value.name, message: scrubString(value.message) };
    if (options.includeStack && value.stack) error.stack = scrubString(value.stack);
    if ("code" in value && value.code != null) error.code = String(value.code);
    return error;
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => safeValue(item, options, seen, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = keyContainsSecret(key) ? REDACTED : safeValue(item, options, seen, depth + 1);
  }
  return output;
}

export function redactOperationalFields(value, { includeStack = false, maximumDepth = 12 } = {}) {
  return safeValue(value, { includeStack, maximumDepth }, new WeakSet(), 0);
}

export function resolveLoggingConfig(raw = {}, environment = process.env) {
  const level = String(environment.PBA_LOG_LEVEL ?? raw.level ?? "info").toLowerCase();
  const format = String(environment.PBA_LOG_FORMAT ?? raw.format ?? "json").toLowerCase();
  if (!(level in LEVEL_PRIORITY)) throw new TypeError(`Ukendt logging.level: ${level}`);
  if (!LOG_FORMATS.includes(format)) throw new TypeError(`Ukendt logging.format: ${format}`);
  return { level, format, includeStack: Boolean(raw.includeStack ?? false) };
}

function defaultSink(line, record) {
  const destination = record.level === "error" ? console.error : console.log;
  destination(line);
}

function renderPretty(record) {
  const { timestamp, level, event, ...fields } = record;
  const details = Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
  return `${timestamp} ${level.toUpperCase().padEnd(5)} ${event}${details}`;
}

export function createOperationalLogger({
  level = "info",
  format = "json",
  includeStack = false,
  clock = () => new Date(),
  sink = defaultSink,
  baseFields = {},
} = {}) {
  if (!(level in LEVEL_PRIORITY)) throw new TypeError(`Ukendt logniveau: ${level}`);
  if (!LOG_FORMATS.includes(format)) throw new TypeError(`Ukendt logformat: ${format}`);
  const safeBaseFields = redactOperationalFields(baseFields, { includeStack });

  function log(recordLevel, event, fields = {}) {
    if (LEVEL_PRIORITY[recordLevel] < LEVEL_PRIORITY[level]) return null;
    const safeFields = redactOperationalFields(fields, { includeStack });
    const record = { ...safeBaseFields, ...safeFields, timestamp: clock().toISOString(), level: recordLevel, event: String(event) };
    const line = format === "pretty" ? renderPretty(record) : JSON.stringify(record);
    try { sink(line, record); } catch { /* Logging must not break the application path. */ }
    return record;
  }

  return Object.freeze({
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  });
}
