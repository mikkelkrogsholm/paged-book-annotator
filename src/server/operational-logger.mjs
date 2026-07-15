const LEVEL_PRIORITY = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });
const LOG_FORMATS = Object.freeze(["json", "pretty"]);
const REDACTED = "[REDACTED]";
const DEFAULT_MAXIMUM_STRING_LENGTH = 4_096;
const DEFAULT_MAXIMUM_COLLECTION_ENTRIES = 100;

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

function keyContainsDirectPii(key) {
  const normalized = normalizedKey(key);
  return normalized === "name"
    || normalized === "fullname"
    || normalized === "displayname"
    || normalized === "firstname"
    || normalized === "lastname"
    || normalized === "username"
    || normalized.includes("email")
    || normalized.includes("phone")
    || normalized.includes("telephone")
    || normalized.includes("mobile");
}

function scrubString(value, maximumStringLength) {
  const scrubbed = String(value)
    .replaceAll(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replaceAll(/\b(pba_(?:session|guest)|password|api[_-]?key|access[_-]?token|refresh[_-]?token)=([^\s,;&]+)/gi, "$1=[REDACTED]")
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  if (scrubbed.length <= maximumStringLength) return scrubbed;
  const suffix = `…[TRUNCATED ${scrubbed.length - maximumStringLength} chars]`;
  if (suffix.length >= maximumStringLength) return suffix.slice(0, maximumStringLength);
  return `${scrubbed.slice(0, Math.max(0, maximumStringLength - suffix.length))}${suffix}`;
}

function safeValue(value, options, seen, depth) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrubString(value, options.maximumStringLength);
  if (typeof value === "bigint") return scrubString(value.toString(), options.maximumStringLength);
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
    return scrubString(String(value), options.maximumStringLength);
  }
  if (depth > options.maximumDepth) return "[MAX_DEPTH]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const error = {
      name: scrubString(value.name, options.maximumStringLength),
      message: scrubString(value.message, options.maximumStringLength),
    };
    if (options.includeStack && value.stack) error.stack = scrubString(value.stack, options.maximumStringLength);
    if ("code" in value && value.code != null) error.code = scrubString(value.code, options.maximumStringLength);
    return error;
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.slice(0, options.maximumCollectionEntries)
      .map((item) => safeValue(item, options, seen, depth + 1));
    if (value.length > options.maximumCollectionEntries) {
      output.push(`[TRUNCATED ${value.length - options.maximumCollectionEntries} entries]`);
    }
    return output;
  }
  const output = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, options.maximumCollectionEntries)) {
    const safeKey = scrubString(key, options.maximumStringLength);
    output[safeKey] = keyContainsSecret(key) || keyContainsDirectPii(key)
      ? REDACTED
      : safeValue(item, options, seen, depth + 1);
  }
  if (entries.length > options.maximumCollectionEntries) {
    output._truncated = `${entries.length - options.maximumCollectionEntries} entries`;
  }
  return output;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} skal være et positivt heltal.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} skal være nul eller et positivt heltal.`);
  return value;
}

export function redactOperationalFields(value, {
  includeStack = false,
  maximumDepth = 12,
  maximumStringLength = DEFAULT_MAXIMUM_STRING_LENGTH,
  maximumCollectionEntries = DEFAULT_MAXIMUM_COLLECTION_ENTRIES,
} = {}) {
  const options = {
    includeStack,
    maximumDepth: nonNegativeInteger(maximumDepth, "maximumDepth"),
    maximumStringLength: positiveInteger(maximumStringLength, "maximumStringLength"),
    maximumCollectionEntries: positiveInteger(maximumCollectionEntries, "maximumCollectionEntries"),
  };
  return safeValue(value, options, new WeakSet(), 0);
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
  maximumStringLength = DEFAULT_MAXIMUM_STRING_LENGTH,
  maximumCollectionEntries = DEFAULT_MAXIMUM_COLLECTION_ENTRIES,
} = {}) {
  if (!(level in LEVEL_PRIORITY)) throw new TypeError(`Ukendt logniveau: ${level}`);
  if (!LOG_FORMATS.includes(format)) throw new TypeError(`Ukendt logformat: ${format}`);
  const redactionOptions = { includeStack, maximumStringLength, maximumCollectionEntries };
  const safeBaseFields = redactOperationalFields(baseFields, redactionOptions);

  function log(recordLevel, event, fields = {}) {
    if (LEVEL_PRIORITY[recordLevel] < LEVEL_PRIORITY[level]) return null;
    try {
      const safeFields = redactOperationalFields(fields, redactionOptions);
      const record = {
        ...safeBaseFields,
        ...safeFields,
        timestamp: clock().toISOString(),
        level: recordLevel,
        event: scrubString(event, maximumStringLength),
      };
      const line = format === "pretty" ? renderPretty(record) : JSON.stringify(record);
      try { sink(line, record); } catch { /* Logging must not break the application path. */ }
      return record;
    } catch {
      return null;
    }
  }

  return Object.freeze({
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  });
}
