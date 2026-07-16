// agent-lint: disable-file=AR001,AR002 -- One explicit SQLite transaction boundary keeps schema migration, privacy erasure and cross-feature foreign keys auditable.
import { chmodSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { resolveAccessPolicy, ROLE_PERMISSIONS, validateScopes } from "./access-policy.mjs";
import { validateSurveyAnswers, validateSurveyDefinition } from "./survey-contract.mjs";

export const COLLABORATION_SCHEMA_VERSION = 4;
export const USER_ROLES = Object.freeze(["instance_admin", "user"]);
export const BOOK_ROLES = Object.freeze(["book_admin", "editor", "publisher", "reviewer", "reader"]);

function nowIso(clock) {
  return clock().toISOString();
}

function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw new TypeError("Der kræves en gyldig e-mailadresse.");
  return email;
}

function requireText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${field} skal være en ikke-tom tekststreng.`);
  return text;
}

function futureIso(clock, hours) {
  return new Date(clock().getTime() + hours * 60 * 60 * 1000).toISOString();
}

function randomSecret(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(values).toString("base64url");
}

export async function hashSecret(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return Buffer.from(digest).toString("hex");
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    globalRole: row.global_role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    erasedAt: row.erased_at ?? null,
  };
}

function membershipFromRow(row) {
  if (!row?.book_role) return null;
  return {
    bookId: row.book_id,
    role: row.book_role,
    permissions: parseJson(row.permissions_json, []),
  };
}

function userPrincipal(row) {
  if (!row) return null;
  const membership = membershipFromRow(row);
  return {
    kind: "user",
    ...userFromRow(row),
    membership,
    memberships: membership ? [membership] : [],
    bookId: membership?.bookId ?? null,
    role: membership?.role ?? null,
    permissions: membership?.permissions ?? [],
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function pseudonymRef(kind, id) {
  return createHash("sha256").update(`${kind}:${id}`).digest("hex");
}

function respondentIdentity(principal) {
  if (principal?.actorUserId) return { kind: "user", id: principal.actorUserId, userId: principal.actorUserId };
  const kind = String(principal?.kind ?? "unknown");
  return { kind, id: principal?.id, userId: kind === "user" ? principal.id : null };
}

const SENSITIVE_DETAIL_KEYS = /email|name|phone|password|secret|token|address/i;

function sanitizeAuditDetails(value) {
  if (Array.isArray(value)) return value.map(sanitizeAuditDetails);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_DETAIL_KEYS.test(key))
    .map(([key, item]) => [key, sanitizeAuditDetails(item)]));
}

function surveyFromRows(row, versions = []) {
  if (!row) return null;
  const mappedVersions = versions.map((version) => ({
    version: version.version,
    state: version.state,
    definition: parseJson(version.definition_json, null),
    createdAt: version.created_at,
    publishedAt: version.published_at ?? null,
  }));
  const version = (number) => mappedVersions.find((candidate) => candidate.version === number) ?? null;
  return {
    id: row.id,
    bookId: row.book_id,
    status: row.status,
    publishedVersion: row.published_version ?? null,
    draftVersion: row.draft_version ?? null,
    published: version(row.published_version),
    draft: version(row.draft_version),
    versions: mappedVersions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at ?? null,
    closedAt: row.closed_at ?? null,
  };
}

function surveyResponseFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    surveyId: row.survey_id,
    surveyVersion: row.survey_version,
    bookId: row.book_id,
    revisionId: row.revision_id,
    respondent: {
      kind: row.respondent_kind,
      ref: row.respondent_ref,
      userId: row.user_id ?? null,
      displayName: row.display_name ?? (row.user_id ? "Slettet bruger" : null),
    },
    target: parseJson(row.target_json, {}),
    answers: parseJson(row.answers_json, []),
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
  };
}

export class CollaborationRepository {
  constructor({
    filePath,
    bookId,
    clock = () => new Date(),
    createId = (prefix) => `${prefix}-${Bun.randomUUIDv7()}`,
    sessionHours = 24 * 14,
    invitationHours = 24 * 7,
  }) {
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      chmodSync(dirname(filePath), 0o700);
    }
    this.filePath = filePath;
    this.bookId = bookId ?? null;
    this.clock = clock;
    this.createId = createId;
    this.sessionHours = sessionHours;
    this.invitationHours = invitationHours;
    this.database = new Database(filePath, { create: true, strict: true });
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.secureStorageFiles();
    this.purgeExpiredCredentials();
    this.lastCredentialPurgeAt = this.clock().getTime();
  }

  maybePurgeExpiredCredentials() {
    const now = this.clock().getTime();
    if (now - this.lastCredentialPurgeAt < 60 * 60_000) return null;
    const purged = this.purgeExpiredCredentials();
    this.lastCredentialPurgeAt = now;
    return purged;
  }

  secureStorageFiles() {
    if (this.filePath === ":memory:") return;
    for (const path of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) {
      try { chmodSync(path, 0o600); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  purgeExpiredCredentials({ graceDays = 30 } = {}) {
    const days = Number(graceDays);
    if (!Number.isFinite(days) || days < 0 || days > 3650) throw new TypeError("graceDays skal være mellem 0 og 3650.");
    const cutoff = new Date(this.clock().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const tableExists = (name) => Boolean(this.database.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
    const purge = this.database.transaction(() => {
      const sessions = tableExists("sessions") ? this.database.query("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(cutoff, cutoff).changes : 0;
      const invitations = tableExists("invitations") ? this.database.query(`
        DELETE FROM invitations WHERE expires_at < ?
          OR (revoked_at IS NOT NULL AND revoked_at < ?)
          OR (accepted_at IS NOT NULL AND accepted_at < ?)
      `).run(cutoff, cutoff, cutoff).changes : 0;
      const accessCodes = tableExists("access_codes") ? this.database.query("DELETE FROM access_codes WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(cutoff, cutoff).changes : 0;
      const tokens = tableExists("service_tokens") ? Number(this.database.query(`
        SELECT COUNT(*) AS count FROM service_tokens
        WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
      `).get(cutoff, cutoff)?.count ?? 0) : 0;
      if (tokens > 0) {
        this.database.query("DELETE FROM service_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
          .run(cutoff, cutoff);
      }
      return { sessions, invitations, accessCodes, tokens };
    });
    return purge();
  }

  migrate() {
    const version = Number(this.database.query("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > COLLABORATION_SCHEMA_VERSION) {
      throw new TypeError(`Samarbejdsdatabasen bruger schema ${version}; denne version understøtter ${COLLABORATION_SCHEMA_VERSION}.`);
    }
    if (version === COLLABORATION_SCHEMA_VERSION) return;
    const migrateVersionOne = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          global_role TEXT NOT NULL DEFAULT 'user',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memberships (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          book_id TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          secret_hash TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          display_name TEXT NOT NULL,
          book_id TEXT NOT NULL,
          role TEXT NOT NULL,
          secret_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          created_by TEXT,
          created_at TEXT NOT NULL,
          accepted_at TEXT,
          revoked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS service_tokens (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prefix TEXT NOT NULL UNIQUE,
          secret_hash TEXT NOT NULL UNIQUE,
          actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          book_id TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_by TEXT,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS reading_progress (
          user_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          anchor_id TEXT NOT NULL,
          page_number INTEGER NOT NULL,
          percent REAL NOT NULL,
          build_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
        CREATE TABLE IF NOT EXISTS reading_page_visits (
          user_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          anchor_id TEXT NOT NULL,
          page_number INTEGER NOT NULL,
          first_read_at TEXT NOT NULL,
          last_read_at TEXT NOT NULL,
          visit_count INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (user_id, book_id, anchor_id)
        );
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          token_id TEXT,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          book_id TEXT,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_events_book_created ON audit_events(book_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS invitations_book_created ON invitations(book_id, created_at DESC);
        PRAGMA user_version = 1;
      `);
    });
    if (version < 1) migrateVersionOne();
    const migrateVersionTwo = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS book_settings (
          book_id TEXT PRIMARY KEY,
          access_json TEXT NOT NULL,
          updated_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        ALTER TABLE reading_progress ADD COLUMN engaged_percent REAL NOT NULL DEFAULT 0;
        ALTER TABLE reading_progress ADD COLUMN completed_at TEXT;
        ALTER TABLE reading_progress ADD COLUMN last_engaged_at TEXT;
        CREATE TABLE IF NOT EXISTS reading_preferences (
          user_id TEXT NOT NULL,
          book_id TEXT NOT NULL,
          tracking_enabled INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
        PRAGMA user_version = 2;
      `);
    });
    if (version < 2) migrateVersionTwo();
    const migrateVersionThree = this.database.transaction(() => {
      const tableExists = (name) => Boolean(this.database.query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(name));
      const columnExists = (table, column) => tableExists(table)
        && this.database.query(`PRAGMA table_info(${table})`).all().some((candidate) => candidate.name === column);

      if (tableExists("users") && !columnExists("users", "erased_at")) {
        this.database.exec("ALTER TABLE users ADD COLUMN erased_at TEXT;");
      }
      if (tableExists("memberships") && !columnExists("memberships", "permissions_json")) {
        this.database.exec("ALTER TABLE memberships ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (tableExists("invitations") && !columnExists("invitations", "permissions_json")) {
        this.database.exec("ALTER TABLE invitations ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';");
      }
      if (tableExists("invitations") && !columnExists("invitations", "accepted_by_user_id")) {
        this.database.exec("ALTER TABLE invitations ADD COLUMN accepted_by_user_id TEXT;");
      }
      if (tableExists("service_tokens") && !columnExists("service_tokens", "instance_admin")) {
        this.database.exec("ALTER TABLE service_tokens ADD COLUMN instance_admin INTEGER NOT NULL DEFAULT 0;");
      }
      if (tableExists("audit_events") && !columnExists("audit_events", "actor_ref")) {
        this.database.exec("ALTER TABLE audit_events ADD COLUMN actor_ref TEXT;");
        const rows = this.database.query("SELECT id, actor_type, actor_id FROM audit_events").all();
        const update = this.database.query("UPDATE audit_events SET actor_id = ?, actor_ref = ? WHERE id = ?");
        for (const row of rows) {
          const ref = pseudonymRef(row.actor_type, row.actor_id);
          update.run(ref, ref, row.id);
        }
      }
      if (tableExists("audit_events")) {
        const auditRows = this.database.query("SELECT id, details_json FROM audit_events").all();
        const updateDetails = this.database.query("UPDATE audit_events SET details_json = ? WHERE id = ?");
        for (const row of auditRows) {
          updateDetails.run(JSON.stringify(sanitizeAuditDetails(parseJson(row.details_json, {}))), row.id);
        }
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS service_token_book_grants (
          token_id TEXT NOT NULL REFERENCES service_tokens(id) ON DELETE CASCADE,
          book_id TEXT NOT NULL,
          permissions_json TEXT NOT NULL,
          PRIMARY KEY (token_id, book_id)
        );
        CREATE TABLE IF NOT EXISTS access_codes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          book_id TEXT NOT NULL,
          role TEXT NOT NULL,
          permissions_json TEXT NOT NULL,
          secret_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          max_uses INTEGER NOT NULL,
          use_count INTEGER NOT NULL DEFAULT 0,
          created_by TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS access_codes_book_created ON access_codes(book_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS book_reviewer_profiles (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          book_id TEXT NOT NULL,
          phone TEXT,
          phone_purpose TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, book_id)
        );
      `);
      if (tableExists("service_tokens")) {
        const legacyTokens = this.database.query(
          "SELECT id, book_id, scopes_json FROM service_tokens WHERE book_id IS NOT NULL",
        ).all();
        const insertGrant = this.database.query(`
          INSERT OR IGNORE INTO service_token_book_grants (token_id, book_id, permissions_json)
          VALUES (?, ?, ?)
        `);
        for (const token of legacyTokens) insertGrant.run(token.id, token.book_id, token.scopes_json);
      }
      this.database.exec("PRAGMA user_version = 3;");
    });
    if (version < 3) migrateVersionThree();
    const migrateVersionFour = this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS surveys (
          id TEXT PRIMARY KEY,
          book_id TEXT NOT NULL,
          status TEXT NOT NULL,
          published_version INTEGER,
          draft_version INTEGER,
          created_by_ref TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          published_at TEXT,
          closed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS survey_versions (
          survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          book_id TEXT NOT NULL,
          state TEXT NOT NULL,
          definition_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          published_at TEXT,
          PRIMARY KEY (survey_id, version)
        );
        CREATE TABLE IF NOT EXISTS survey_responses (
          id TEXT PRIMARY KEY,
          survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
          survey_version INTEGER NOT NULL,
          book_id TEXT NOT NULL,
          revision_id TEXT NOT NULL,
          respondent_kind TEXT NOT NULL,
          respondent_ref TEXT NOT NULL,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          target_json TEXT NOT NULL,
          answers_json TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (survey_id, survey_version, revision_id, respondent_ref)
        );
        CREATE INDEX IF NOT EXISTS surveys_book_status ON surveys(book_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS survey_responses_book_survey ON survey_responses(book_id, survey_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS survey_responses_user ON survey_responses(user_id, updated_at DESC);
        PRAGMA user_version = 4;
      `);
    });
    if (version < 4) migrateVersionFour();
  }

  resolveBookId(bookId = this.bookId) {
    const resolved = typeof bookId === "object" && bookId !== null ? bookId.bookId : bookId;
    return requireText(resolved, "bookId");
  }

  optionalBookId(bookId = this.bookId) {
    const resolved = typeof bookId === "object" && bookId !== null ? bookId.bookId : bookId;
    return resolved == null ? null : requireText(resolved, "bookId");
  }

  close() {
    this.database.close();
  }

  health() {
    return this.database.query("SELECT 1 AS ok").get()?.ok === 1;
  }

  getAccessPolicy(fallbackPolicy, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const row = this.database.query("SELECT access_json FROM book_settings WHERE book_id = ?").get(resolvedBookId);
    return row ? resolveAccessPolicy(parseJson(row.access_json, {})) : resolveAccessPolicy(fallbackPolicy);
  }

  saveAccessPolicy(rawPolicy, updatedBy = null, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const policy = resolveAccessPolicy(rawPolicy);
    const timestamp = nowIso(this.clock);
    this.database.query(`
      INSERT INTO book_settings (book_id, access_json, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET
        access_json = excluded.access_json,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(resolvedBookId, JSON.stringify(policy), updatedBy, timestamp, timestamp);
    return policy;
  }

  async createUser({ email, displayName, password, globalRole = "user", bookRole = null, bookId = this.bookId }) {
    if (!USER_ROLES.includes(globalRole)) throw new TypeError(`Ukendt global rolle: ${globalRole}`);
    if (bookRole != null && !BOOK_ROLES.includes(bookRole)) throw new TypeError(`Ukendt bogrolle: ${bookRole}`);
    const normalizedEmail = normalizeEmail(email);
    const name = requireText(displayName, "displayName");
    const passwordText = requireText(password, "password");
    if (passwordText.length < 10) throw new TypeError("Password skal være mindst 10 tegn.");
    const timestamp = nowIso(this.clock);
    const user = {
      id: this.createId("user"),
      email: normalizedEmail,
      displayName: name,
      passwordHash: await Bun.password.hash(passwordText, { algorithm: "argon2id" }),
      globalRole,
    };
    const insert = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO users (id, email, display_name, password_hash, global_role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(user.id, user.email, user.displayName, user.passwordHash, user.globalRole, timestamp, timestamp);
      if (bookRole) this.setMembership(user.id, bookRole, { bookId, timestamp });
    });
    insert();
    return this.getUser(user.id, bookId);
  }

  async ensureBootstrapAdmin({ email, displayName = "Administrator", password }) {
    const existing = this.getUserByEmail(email);
    if (existing) {
      if (existing.globalRole !== "instance_admin") {
        await this.changePassword(existing.id, { newPassword: password, requireCurrent: false });
        this.setGlobalRole(existing.id, "instance_admin");
      }
      return this.getUser(existing.id);
    }
    return this.createUser({
      email,
      displayName,
      password,
      globalRole: "instance_admin",
      bookRole: this.bookId ? "book_admin" : null,
    });
  }

  getUser(id, bookId = this.bookId) {
    const resolvedBookId = this.optionalBookId(bookId);
    if (!resolvedBookId) return userFromRow(this.database.query("SELECT * FROM users WHERE id = ?").get(id));
    const row = this.database.query(`
      SELECT users.*, memberships.book_id, memberships.role AS book_role, memberships.permissions_json
      FROM users LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
      WHERE users.id = ?
    `).get(resolvedBookId, id);
    if (!row) return null;
    return { ...userFromRow(row), membership: membershipFromRow(row) };
  }

  getUserByEmail(email) {
    const row = this.database.query("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
    return userFromRow(row);
  }

  async authenticate(email, password, bookId = this.bookId) {
    const resolvedBookId = this.optionalBookId(bookId);
    const row = resolvedBookId
      ? this.database.query(`
        SELECT users.*, memberships.book_id, memberships.role AS book_role, memberships.permissions_json
        FROM users LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
        WHERE users.email = ? AND users.status = 'active'
      `).get(resolvedBookId, normalizeEmail(email))
      : this.database.query("SELECT * FROM users WHERE email = ? AND status = 'active'").get(normalizeEmail(email));
    if (!row || !await Bun.password.verify(String(password ?? ""), row.password_hash)) return null;
    return userPrincipal(row);
  }

  async changePassword(userId, { currentPassword, newPassword, requireCurrent = true } = {}) {
    const row = this.database.query("SELECT id, password_hash, status FROM users WHERE id = ?").get(userId);
    if (!row || row.status !== "active") throw new TypeError("Brugeren findes ikke eller er deaktiveret.");
    const password = requireText(newPassword, "newPassword");
    if (password.length < 10) throw new TypeError("Password skal være mindst 10 tegn.");
    if (requireCurrent && !await Bun.password.verify(String(currentPassword ?? ""), row.password_hash)) {
      throw new TypeError("Det nuværende password er forkert.");
    }
    const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const timestamp = nowIso(this.clock);
    const change = this.database.transaction(() => {
      this.database.query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, timestamp, userId);
      this.database.query("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(timestamp, userId);
    });
    change();
    return this.getUser(userId);
  }

  listUsers(bookId = this.bookId) {
    const resolvedBookId = this.optionalBookId(bookId);
    if (!resolvedBookId) return this.database.query(`
      SELECT id, email, display_name, global_role, status, created_at, updated_at, erased_at
      FROM users ORDER BY display_name COLLATE NOCASE, email
    `).all().map((row) => ({ ...userFromRow(row), membership: null }));
    return this.database.query(`
      SELECT users.id, users.email, users.display_name, users.global_role, users.status,
             users.created_at, users.updated_at, users.erased_at,
             memberships.book_id, memberships.role AS book_role, memberships.permissions_json,
             book_reviewer_profiles.phone, book_reviewer_profiles.phone_purpose,
             book_reviewer_profiles.created_at AS profile_created_at,
             book_reviewer_profiles.updated_at AS profile_updated_at
      FROM users JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
      LEFT JOIN book_reviewer_profiles ON book_reviewer_profiles.user_id = users.id
        AND book_reviewer_profiles.book_id = memberships.book_id
      ORDER BY users.display_name COLLATE NOCASE, users.email
    `).all(resolvedBookId).map((row) => ({
      ...userFromRow(row),
      membership: membershipFromRow(row),
      phone: row.phone ?? null,
      phonePurpose: row.phone_purpose ?? null,
      reviewerProfile: row.profile_created_at ? {
        userId: row.id,
        bookId: row.book_id,
        phone: row.phone ?? null,
        phonePurpose: row.phone_purpose ?? null,
        createdAt: row.profile_created_at,
        updatedAt: row.profile_updated_at,
      } : null,
    }));
  }

  activeAdministratorCount() {
    return Number(this.database.query("SELECT COUNT(*) AS count FROM users WHERE global_role = 'instance_admin' AND status = 'active'").get()?.count ?? 0);
  }

  setMembership(userId, role, options = {}) {
    if (!BOOK_ROLES.includes(role)) throw new TypeError(`Ukendt bogrolle: ${role}`);
    const normalizedOptions = typeof options === "string" ? { timestamp: options } : options;
    const bookId = this.resolveBookId(normalizedOptions.bookId);
    const timestamp = normalizedOptions.timestamp ?? nowIso(this.clock);
    const permissions = validateScopes(normalizedOptions.permissions ?? [], { allowEmpty: true });
    if (!this.getUser(userId, null)) throw new TypeError("Brugeren findes ikke.");
    this.database.query(`
      INSERT INTO memberships (user_id, book_id, role, permissions_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        role = excluded.role,
        permissions_json = excluded.permissions_json,
        updated_at = excluded.updated_at
    `).run(userId, bookId, role, JSON.stringify(permissions), timestamp, timestamp);
    return this.getUser(userId, bookId);
  }

  removeMembership(userId, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    this.database.query("DELETE FROM memberships WHERE user_id = ? AND book_id = ?").run(userId, resolvedBookId);
    return this.getUser(userId, resolvedBookId);
  }

  setGlobalRole(userId, globalRole) {
    if (!USER_ROLES.includes(globalRole)) throw new TypeError(`Ukendt global rolle: ${globalRole}`);
    const current = this.getUser(userId);
    if (!current) throw new TypeError("Brugeren findes ikke.");
    if (current.globalRole === "instance_admin" && globalRole !== "instance_admin") {
      const administrators = this.activeAdministratorCount();
      if (administrators <= 1) throw new TypeError("Den sidste aktive administrator kan ikke fjernes.");
    }
    this.database.query("UPDATE users SET global_role = ?, updated_at = ? WHERE id = ?")
      .run(globalRole, nowIso(this.clock), userId);
    return this.getUser(userId);
  }

  setUserStatus(userId, status) {
    if (!["active", "disabled"].includes(status)) throw new TypeError(`Ukendt brugerstatus: ${status}`);
    const current = this.getUser(userId);
    if (!current) throw new TypeError("Brugeren findes ikke.");
    if (status === "disabled" && current.globalRole === "instance_admin") {
      const administrators = this.activeAdministratorCount();
      if (administrators <= 1) throw new TypeError("Den sidste aktive administrator kan ikke deaktiveres.");
    }
    this.database.query("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(this.clock), userId);
    if (status === "disabled") this.database.query("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(nowIso(this.clock), userId);
    return this.getUser(userId);
  }

  async createSession(userId) {
    this.maybePurgeExpiredCredentials();
    const user = this.getUser(userId);
    if (!user || user.status !== "active") throw new TypeError("Brugeren kan ikke logge ind.");
    const id = this.createId("session");
    const secret = `pbs_${id}_${randomSecret()}`;
    const timestamp = nowIso(this.clock);
    this.database.query(`
      INSERT INTO sessions (id, secret_hash, user_id, expires_at, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, await hashSecret(secret), userId, futureIso(this.clock, this.sessionHours), timestamp, timestamp);
    return { secret, expiresAt: futureIso(this.clock, this.sessionHours) };
  }

  async resolveSession(secret, bookId = this.bookId) {
    if (!secret) return null;
    const timestamp = nowIso(this.clock);
    const resolvedBookId = this.optionalBookId(bookId);
    const secretHash = await hashSecret(secret);
    const row = resolvedBookId
      ? this.database.query(`
        SELECT users.*, memberships.book_id, memberships.role AS book_role, memberships.permissions_json,
               sessions.id AS session_id
        FROM sessions JOIN users ON users.id = sessions.user_id
        LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
        WHERE sessions.secret_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND users.status = 'active'
      `).get(resolvedBookId, secretHash, timestamp)
      : this.database.query(`
        SELECT users.*, sessions.id AS session_id
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.secret_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND users.status = 'active'
      `).get(secretHash, timestamp);
    if (!row) return null;
    this.database.query("UPDATE sessions SET last_used_at = ? WHERE id = ?").run(timestamp, row.session_id);
    return { ...userPrincipal(row), sessionId: row.session_id };
  }

  async revokeSession(secret) {
    if (!secret) return false;
    const result = this.database.query("UPDATE sessions SET revoked_at = ? WHERE secret_hash = ? AND revoked_at IS NULL")
      .run(nowIso(this.clock), await hashSecret(secret));
    return result.changes > 0;
  }

  async createInvitation({
    email,
    displayName = "Prøvelæser",
    role = "reviewer",
    permissions = [],
    bookId = this.bookId,
    createdBy = null,
  }) {
    this.maybePurgeExpiredCredentials();
    if (!BOOK_ROLES.includes(role)) throw new TypeError(`Ukendt bogrolle: ${role}`);
    const resolvedBookId = this.resolveBookId(bookId);
    const validatedPermissions = validateScopes(permissions, { allowEmpty: true });
    const id = this.createId("invite");
    const secret = `pbi_${id}_${randomSecret()}`;
    const timestamp = nowIso(this.clock);
    const expiresAt = futureIso(this.clock, this.invitationHours);
    this.database.query(`
      INSERT INTO invitations (
        id, email, display_name, book_id, role, permissions_json, secret_hash,
        expires_at, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normalizeEmail(email),
      requireText(displayName, "displayName"),
      resolvedBookId,
      role,
      JSON.stringify(validatedPermissions),
      await hashSecret(secret),
      expiresAt,
      createdBy,
      timestamp,
    );
    return {
      id,
      secret,
      email: normalizeEmail(email),
      displayName,
      bookId: resolvedBookId,
      role,
      permissions: validatedPermissions,
      expiresAt,
      createdAt: timestamp,
    };
  }

  listInvitations(bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    return this.database.query(`
      SELECT id, email, display_name, book_id, role, permissions_json, expires_at,
             created_by, created_at, accepted_at, accepted_by_user_id, revoked_at
      FROM invitations WHERE book_id = ? ORDER BY created_at DESC
    `).all(resolvedBookId).map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      bookId: row.book_id,
      role: row.role,
      permissions: parseJson(row.permissions_json, []),
      expiresAt: row.expires_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      acceptedByUserId: row.accepted_by_user_id,
      revokedAt: row.revoked_at,
    }));
  }

  revokeInvitation(id, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const result = this.database.query("UPDATE invitations SET revoked_at = ? WHERE id = ? AND book_id = ? AND revoked_at IS NULL")
      .run(nowIso(this.clock), id, resolvedBookId);
    return result.changes > 0;
  }

  async pendingInvitation(secret, bookId = this.bookId) {
    const timestamp = nowIso(this.clock);
    const resolvedBookId = this.resolveBookId(bookId);
    const invitation = this.database.query(`
      SELECT * FROM invitations
      WHERE secret_hash = ? AND book_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).get(await hashSecret(secret), resolvedBookId, timestamp);
    if (!invitation) throw new TypeError("Invitationen er ugyldig eller udløbet.");
    return invitation;
  }

  claimInvitation(invitation, user) {
    const accept = this.database.transaction(() => {
      const claimTime = nowIso(this.clock);
      const claimed = this.database.query(`
        UPDATE invitations SET accepted_at = ?, accepted_by_user_id = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `).run(claimTime, user.id, invitation.id, claimTime);
      if (claimed.changes !== 1) throw new TypeError("Invitationen er allerede anvendt eller udløbet.");
      this.setMembership(user.id, invitation.role, {
        bookId: invitation.book_id,
        permissions: parseJson(invitation.permissions_json, []),
      });
    });
    accept();
    return this.getUser(user.id, invitation.book_id);
  }

  async acceptInvitation({ secret, displayName, password, bookId = this.bookId }) {
    const invitation = await this.pendingInvitation(secret, bookId);
    let user = this.getUserByEmail(invitation.email);
    let createdUser = false;
    if (!user) {
      user = await this.createUser({
        email: invitation.email,
        displayName: displayName || invitation.display_name,
        password,
      });
      createdUser = true;
    } else {
      if (!await this.authenticate(invitation.email, password, null)) {
        throw new TypeError("Den eksisterende bruger kræver sit korrekte password.");
      }
    }
    try {
      return this.claimInvitation(invitation, user);
    } catch (error) {
      if (createdUser) this.discardUnenrolledUser(user.id);
      throw error;
    }
  }

  async acceptInvitationForAuthenticatedUser({ secret, userId, bookId = this.bookId }) {
    const invitation = await this.pendingInvitation(secret, bookId);
    const user = this.getUser(userId, null);
    if (!user || user.status !== "active") throw new TypeError("Kontoen kan ikke tilmeldes.");
    if (user.email !== invitation.email) throw new TypeError("Invitationen tilhører en anden konto.");
    return this.claimInvitation(invitation, user);
  }

  async createAccessCode({
    name = "Adgangskode",
    role = "reviewer",
    permissions = [],
    bookId = this.bookId,
    expiresInHours = 24 * 7,
    maxUses = 1,
    createdBy = null,
  }) {
    this.maybePurgeExpiredCredentials();
    if (!BOOK_ROLES.includes(role)) throw new TypeError(`Ukendt bogrolle: ${role}`);
    const resolvedBookId = this.resolveBookId(bookId);
    const validatedPermissions = validateScopes(permissions, { allowEmpty: true });
    const hours = Number(expiresInHours);
    const uses = Number(maxUses);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 365) {
      throw new TypeError("Adgangskodens levetid skal være mellem 1 time og 365 dage.");
    }
    if (!Number.isInteger(uses) || uses < 1 || uses > 10000) {
      throw new TypeError("maxUses skal være et heltal mellem 1 og 10000.");
    }
    const id = this.createId("code");
    const secret = `pbc_${id}_${randomSecret(18)}`;
    const timestamp = nowIso(this.clock);
    const expiresAt = futureIso(this.clock, hours);
    this.database.query(`
      INSERT INTO access_codes (
        id, name, book_id, role, permissions_json, secret_hash, expires_at,
        max_uses, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      requireText(name, "name"),
      resolvedBookId,
      role,
      JSON.stringify(validatedPermissions),
      await hashSecret(secret),
      expiresAt,
      uses,
      createdBy,
      timestamp,
    );
    return {
      id,
      name,
      secret,
      bookId: resolvedBookId,
      role,
      permissions: validatedPermissions,
      expiresAt,
      maxUses: uses,
      useCount: 0,
      createdAt: timestamp,
    };
  }

  listAccessCodes(bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    return this.database.query(`
      SELECT id, name, book_id, role, permissions_json, expires_at, max_uses,
             use_count, created_by, created_at, revoked_at
      FROM access_codes WHERE book_id = ? ORDER BY created_at DESC
    `).all(resolvedBookId).map((row) => ({
      id: row.id,
      name: row.name,
      bookId: row.book_id,
      role: row.role,
      permissions: parseJson(row.permissions_json, []),
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      useCount: row.use_count,
      createdBy: row.created_by,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  revokeAccessCode(id, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const result = this.database.query(`
      UPDATE access_codes SET revoked_at = ?
      WHERE id = ? AND book_id = ? AND revoked_at IS NULL
    `).run(nowIso(this.clock), id, resolvedBookId);
    return result.changes > 0;
  }

  async enrollUser({ userId, bookId = this.bookId, method = "open", invitationSecret, accessCode }) {
    const resolvedBookId = this.resolveBookId(bookId);
    const user = this.getUser(userId, null);
    if (!user || user.status !== "active") throw new TypeError("Kontoen kan ikke tilmeldes.");
    const policy = this.getAccessPolicy({ preset: "publicRead" }, resolvedBookId);
    if (method === "invite") {
      if (policy.registration !== "inviteOnly") {
        throw new TypeError("Invitationstilmelding er ikke aktiveret for bogen.");
      }
      return this.acceptInvitationForAuthenticatedUser({ secret: invitationSecret, userId, bookId: resolvedBookId });
    }
    if (method === "code") {
      if (policy.registration !== "code") throw new TypeError("Kodetilmelding er ikke aktiveret for bogen.");
      const timestamp = nowIso(this.clock);
      const code = this.database.query(`
        SELECT * FROM access_codes
        WHERE secret_hash = ? AND book_id = ? AND revoked_at IS NULL
          AND expires_at > ? AND use_count < max_uses
      `).get(await hashSecret(accessCode), resolvedBookId, timestamp);
      if (!code) throw new TypeError("Adgangskoden er ugyldig eller udløbet.");
      const enroll = this.database.transaction(() => {
        const claimed = this.database.query(`
          UPDATE access_codes SET use_count = use_count + 1
          WHERE id = ? AND revoked_at IS NULL AND use_count < max_uses
        `).run(code.id);
        if (claimed.changes !== 1) throw new TypeError("Adgangskoden kan ikke anvendes flere gange.");
        this.setMembership(userId, code.role, {
          bookId: resolvedBookId,
          permissions: parseJson(code.permissions_json, []),
        });
      });
      enroll();
      return this.getUser(userId, resolvedBookId);
    }
    if (method !== "open") throw new TypeError("Ukendt tilmeldingsmetode.");
    if (policy.registration !== "open") throw new TypeError("Åben tilmelding er ikke aktiveret for bogen.");
    return this.setMembership(userId, "reader", { bookId: resolvedBookId });
  }

  async validateAccessCode(accessCode, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const policy = this.getAccessPolicy({ preset: "publicRead" }, resolvedBookId);
    if (policy.registration !== "code") throw new TypeError("Kodetilmelding er ikke aktiveret for bogen.");
    const row = this.database.query(`
      SELECT id, role, permissions_json, expires_at, max_uses, use_count
      FROM access_codes
      WHERE secret_hash = ? AND book_id = ? AND revoked_at IS NULL
        AND expires_at > ? AND use_count < max_uses
    `).get(await hashSecret(accessCode), resolvedBookId, nowIso(this.clock));
    if (!row) throw new TypeError("Adgangskoden er ugyldig eller udløbet.");
    return {
      id: row.id,
      bookId: resolvedBookId,
      role: row.role,
      permissions: parseJson(row.permissions_json, []),
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      useCount: row.use_count,
    };
  }

  discardUnenrolledUser(userId) {
    const result = this.database.query(`
      DELETE FROM users
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM memberships WHERE memberships.user_id = users.id)
        AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id = users.id)
    `).run(userId);
    return result.changes > 0;
  }

  async createServiceToken({
    name,
    actorUserId = null,
    scopes,
    grants,
    bookId = this.bookId,
    instanceAdmin = false,
    expiresInHours = 24 * 30,
    createdBy = null,
  }) {
    this.maybePurgeExpiredCredentials();
    if (typeof instanceAdmin !== "boolean") throw new TypeError("instanceAdmin skal være boolesk.");
    const normalizedGrants = grants
      ? grants.map((grant) => ({
        bookId: this.resolveBookId(grant.bookId),
        permissions: validateScopes(grant.permissions),
      }))
      : scopes
        ? [{ bookId: this.resolveBookId(bookId), permissions: validateScopes(scopes) }]
        : [];
    if (!instanceAdmin && normalizedGrants.length === 0) {
      throw new TypeError("Et token kræver mindst én bogtildeling.");
    }
    const uniqueBooks = new Set(normalizedGrants.map((grant) => grant.bookId));
    if (uniqueBooks.size !== normalizedGrants.length) throw new TypeError("Et token må kun have én tildeling per bog.");
    const hours = Number(expiresInHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 365) throw new TypeError("Tokenets levetid skal være mellem 1 time og 365 dage.");
    const id = this.createId("token");
    const prefix = `pba_${id}`;
    const secret = `${prefix}_${randomSecret()}`;
    const timestamp = nowIso(this.clock);
    const expiresAt = futureIso(this.clock, hours);
    const legacyBookId = normalizedGrants[0]?.bookId ?? "*";
    const legacyScopes = normalizedGrants[0]?.permissions ?? [];
    const secretHash = await hashSecret(secret);
    const insert = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO service_tokens (
          id, name, prefix, secret_hash, actor_user_id, book_id, scopes_json,
          instance_admin, expires_at, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        requireText(name, "name"),
        prefix,
        secretHash,
        actorUserId,
        legacyBookId,
        JSON.stringify(legacyScopes),
        instanceAdmin ? 1 : 0,
        expiresAt,
        createdBy,
        timestamp,
      );
      const insertGrant = this.database.query(`
        INSERT INTO service_token_book_grants (token_id, book_id, permissions_json)
        VALUES (?, ?, ?)
      `);
      for (const grant of normalizedGrants) {
        insertGrant.run(id, grant.bookId, JSON.stringify(grant.permissions));
      }
    });
    insert();
    return {
      id,
      name,
      prefix,
      secret,
      actorUserId,
      instanceAdmin,
      bookGrants: normalizedGrants,
      bookId: normalizedGrants.length === 1 ? normalizedGrants[0].bookId : null,
      scopes: normalizedGrants.length === 1 ? normalizedGrants[0].permissions : [],
      expiresAt,
      createdAt: timestamp,
    };
  }

  async resolveServiceToken(secret) {
    if (!secret?.startsWith("pba_")) return null;
    const timestamp = nowIso(this.clock);
    const row = this.database.query(`
      SELECT * FROM service_tokens
      WHERE secret_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(await hashSecret(secret), timestamp);
    if (!row) return null;
    this.database.query("UPDATE service_tokens SET last_used_at = ? WHERE id = ?").run(timestamp, row.id);
    const bookGrants = this.database.query(`
      SELECT book_id, permissions_json FROM service_token_book_grants
      WHERE token_id = ? ORDER BY book_id
    `).all(row.id).map((grant) => ({
      bookId: grant.book_id,
      permissions: parseJson(grant.permissions_json, []),
    }));
    return {
      kind: "token",
      id: `token:${row.id}`,
      tokenId: row.id,
      displayName: row.name,
      actorUserId: row.actor_user_id,
      instanceAdmin: Boolean(row.instance_admin),
      bookGrants,
      bookId: bookGrants.length === 1 ? bookGrants[0].bookId : null,
      scopes: bookGrants.length === 1 ? bookGrants[0].permissions : [],
      expiresAt: row.expires_at,
    };
  }

  listServiceTokens(bookId = this.bookId, { includeInstanceAdmin = false, includeAllBookGrants = false } = {}) {
    const resolvedBookId = this.optionalBookId(bookId);
    const rows = this.database.query(`
      SELECT id, name, prefix, actor_user_id, book_id, scopes_json, instance_admin,
             expires_at, created_by, created_at, last_used_at, revoked_at
      FROM service_tokens ORDER BY created_at DESC
    `).all();
    return rows.map((row) => {
      const bookGrants = this.database.query(`
        SELECT book_id, permissions_json FROM service_token_book_grants
        WHERE token_id = ? ORDER BY book_id
      `).all(row.id).map((grant) => ({
        bookId: grant.book_id,
        permissions: parseJson(grant.permissions_json, []),
      }));
      return {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        actorUserId: row.actor_user_id,
        instanceAdmin: Boolean(row.instance_admin),
        bookGrants,
        bookId: bookGrants.length === 1 ? bookGrants[0].bookId : null,
        scopes: bookGrants.length === 1 ? bookGrants[0].permissions : [],
        expiresAt: row.expires_at,
        createdBy: row.created_by,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
      };
    }).filter((token) => {
      if (token.instanceAdmin) return includeInstanceAdmin;
      if (!resolvedBookId) return includeAllBookGrants;
      return token.bookGrants.some((grant) => grant.bookId === resolvedBookId);
    });
  }

  revokeServiceToken(id, bookId = this.bookId, { allowInstanceAdmin = false, allowGlobal = false } = {}) {
    const resolvedBookId = this.optionalBookId(bookId);
    let allowed = !resolvedBookId && allowGlobal;
    if (resolvedBookId) {
      const row = this.database.query("SELECT instance_admin FROM service_tokens WHERE id = ?").get(id);
      allowed = Boolean(row) && (Boolean(row.instance_admin)
        ? allowInstanceAdmin
        : Boolean(this.database.query(`
          SELECT 1 FROM service_token_book_grants WHERE token_id = ? AND book_id = ?
        `).get(id, resolvedBookId)));
    }
    if (!allowed) return false;
    const result = this.database.query("UPDATE service_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(nowIso(this.clock), id);
    return result.changes > 0;
  }

  readingPreference(userId, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const row = this.database.query("SELECT tracking_enabled, updated_at FROM reading_preferences WHERE user_id = ? AND book_id = ?")
      .get(userId, resolvedBookId);
    return { trackingEnabled: row ? Boolean(row.tracking_enabled) : true, updatedAt: row?.updated_at ?? null };
  }

  setReadingPreference(userId, trackingEnabled, bookId = this.bookId) {
    if (typeof trackingEnabled !== "boolean") throw new TypeError("trackingEnabled skal være boolesk.");
    const resolvedBookId = this.resolveBookId(bookId);
    const timestamp = nowIso(this.clock);
    const save = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO reading_preferences (user_id, book_id, tracking_enabled, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, book_id) DO UPDATE SET tracking_enabled = excluded.tracking_enabled, updated_at = excluded.updated_at
      `).run(userId, resolvedBookId, trackingEnabled ? 1 : 0, timestamp);
      if (!trackingEnabled) {
        this.database.query("DELETE FROM reading_progress WHERE user_id = ? AND book_id = ?").run(userId, resolvedBookId);
        this.database.query("DELETE FROM reading_page_visits WHERE user_id = ? AND book_id = ?").run(userId, resolvedBookId);
      }
    });
    save();
    return this.readingPreference(userId, resolvedBookId);
  }

  saveProgress(userId, { anchorId, pageNumber, percent = 0, buildId = "", event = "engaged" }, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const anchor = requireText(anchorId, "anchorId");
    const page = Number(pageNumber);
    const progressPercent = Number(percent);
    if (!Number.isInteger(page) || page < 1) throw new TypeError("pageNumber skal være et positivt heltal.");
    if (!Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100) {
      throw new TypeError("percent skal være mellem 0 og 100.");
    }
    if (!["position", "engaged", "complete"].includes(event)) throw new TypeError(`Ukendt progress-event: ${event}`);
    if (!this.readingPreference(userId, resolvedBookId).trackingEnabled) return null;
    const timestamp = nowIso(this.clock);
    const existing = this.getProgress(userId, resolvedBookId);
    const engagedPercent = event === "position" ? (existing?.engagedPercent ?? 0) : Math.max(existing?.engagedPercent ?? 0, progressPercent);
    const completedAt = event === "complete" ? (existing?.completedAt ?? timestamp) : (existing?.completedAt ?? null);
    const lastEngagedAt = event === "position" ? (existing?.lastEngagedAt ?? null) : timestamp;
    const save = this.database.transaction(() => {
      this.database.query(`
      INSERT INTO reading_progress (user_id, book_id, anchor_id, page_number, percent, build_id, updated_at, engaged_percent, completed_at, last_engaged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        anchor_id = excluded.anchor_id,
        page_number = excluded.page_number,
        percent = excluded.percent,
        build_id = excluded.build_id,
        updated_at = excluded.updated_at,
        engaged_percent = excluded.engaged_percent,
        completed_at = excluded.completed_at,
        last_engaged_at = excluded.last_engaged_at
    `).run(userId, resolvedBookId, anchor, page, progressPercent, String(buildId ?? ""), timestamp, engagedPercent, completedAt, lastEngagedAt);
      if (event === "position") return;
      this.database.query(`
      INSERT INTO reading_page_visits (user_id, book_id, anchor_id, page_number, first_read_at, last_read_at, visit_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(user_id, book_id, anchor_id) DO UPDATE SET
        page_number = excluded.page_number,
        last_read_at = excluded.last_read_at,
        visit_count = reading_page_visits.visit_count + 1
    `).run(userId, resolvedBookId, anchor, page, timestamp, timestamp);
    });
    save();
    return this.getProgress(userId, resolvedBookId);
  }

  getReadPages(userId, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    return this.database.query(`
      SELECT anchor_id, page_number, first_read_at, last_read_at, visit_count
      FROM reading_page_visits WHERE user_id = ? AND book_id = ? ORDER BY first_read_at
    `).all(userId, resolvedBookId).map((row) => ({
      anchorId: row.anchor_id,
      pageNumber: row.page_number,
      firstReadAt: row.first_read_at,
      lastReadAt: row.last_read_at,
      visitCount: row.visit_count,
    }));
  }

  getProgress(userId, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const row = this.database.query("SELECT * FROM reading_progress WHERE user_id = ? AND book_id = ?")
      .get(userId, resolvedBookId);
    if (!row) return null;
    return {
      userId: row.user_id,
      bookId: row.book_id,
      anchorId: row.anchor_id,
      pageNumber: row.page_number,
      percent: row.percent,
      engagedPercent: row.engaged_percent,
      completedAt: row.completed_at,
      lastEngagedAt: row.last_engaged_at,
      buildId: row.build_id,
      updatedAt: row.updated_at,
      tracking: this.readingPreference(userId, resolvedBookId),
      readPages: this.getReadPages(userId, resolvedBookId),
    };
  }

  listProgress(bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    return this.database.query(`
      SELECT reading_progress.*, users.display_name, users.email
      FROM reading_progress LEFT JOIN users ON users.id = reading_progress.user_id
      WHERE reading_progress.book_id = ? ORDER BY reading_progress.updated_at DESC
    `).all(resolvedBookId).map((row) => ({
      userId: row.user_id,
      displayName: row.display_name ?? "Ukendt",
      email: row.email ?? "",
      bookId: row.book_id,
      anchorId: row.anchor_id,
      pageNumber: row.page_number,
      percent: row.percent,
      engagedPercent: row.engaged_percent,
      completedAt: row.completed_at,
      lastEngagedAt: row.last_engaged_at,
      buildId: row.build_id,
      updatedAt: row.updated_at,
      tracking: this.readingPreference(row.user_id, resolvedBookId),
      readPages: this.getReadPages(row.user_id, resolvedBookId),
    }));
  }

  saveReviewerProfile(userId, { phone = null, phonePurpose = null, bookId = this.bookId } = {}) {
    const resolvedBookId = this.resolveBookId(bookId);
    if (!this.getUser(userId, null)) throw new TypeError("Brugeren findes ikke.");
    const normalizedPhone = String(phone ?? "").trim() || null;
    const normalizedPurpose = String(phonePurpose ?? "").trim() || null;
    if (normalizedPhone && !normalizedPurpose) {
      throw new TypeError("Der kræves et angivet formål for at gemme et telefonnummer.");
    }
    const timestamp = nowIso(this.clock);
    this.database.query(`
      INSERT INTO book_reviewer_profiles (
        user_id, book_id, phone, phone_purpose, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET
        phone = excluded.phone,
        phone_purpose = excluded.phone_purpose,
        updated_at = excluded.updated_at
    `).run(userId, resolvedBookId, normalizedPhone, normalizedPhone ? normalizedPurpose : null, timestamp, timestamp);
    return this.getReviewerProfile(userId, resolvedBookId);
  }

  getReviewerProfile(userId, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const row = this.database.query(`
      SELECT user_id, book_id, phone, phone_purpose, created_at, updated_at
      FROM book_reviewer_profiles WHERE user_id = ? AND book_id = ?
    `).get(userId, resolvedBookId);
    if (!row) return null;
    return {
      userId: row.user_id,
      bookId: row.book_id,
      phone: row.phone,
      phonePurpose: row.phone_purpose,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  survey(id, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const row = this.database.query("SELECT * FROM surveys WHERE id = ? AND book_id = ?").get(id, resolvedBookId);
    if (!row) return null;
    const versions = this.database.query(`
      SELECT * FROM survey_versions WHERE survey_id = ? AND book_id = ? ORDER BY version
    `).all(id, resolvedBookId);
    return surveyFromRows(row, versions);
  }

  listSurveys(bookId = this.bookId, { includeClosed = true } = {}) {
    const resolvedBookId = this.resolveBookId(bookId);
    const rows = includeClosed
      ? this.database.query("SELECT * FROM surveys WHERE book_id = ? ORDER BY updated_at DESC").all(resolvedBookId)
      : this.database.query("SELECT * FROM surveys WHERE book_id = ? AND status != 'closed' ORDER BY updated_at DESC").all(resolvedBookId);
    return rows.map((row) => surveyFromRows(row, this.database.query(`
      SELECT * FROM survey_versions WHERE survey_id = ? AND book_id = ? ORDER BY version
    `).all(row.id, resolvedBookId)));
  }

  listActiveSurveys(bookId = this.bookId, revisionId = null) {
    return this.listSurveys(bookId, { includeClosed: false })
      .filter((survey) => survey.status === "published" && survey.published)
      .filter((survey) => !revisionId || survey.published.definition.target.revisionId === revisionId)
      .map((survey) => ({ ...survey, draft: null, versions: [survey.published] }));
  }

  createSurvey({ bookId = this.bookId, definition, principal = null }) {
    const resolvedBookId = this.resolveBookId(bookId);
    const normalized = validateSurveyDefinition(definition);
    const timestamp = nowIso(this.clock);
    const id = this.createId("survey");
    const createdByRef = pseudonymRef(principal?.kind ?? "system", principal?.id ?? "system");
    const create = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO surveys (
          id, book_id, status, published_version, draft_version, created_by_ref,
          created_at, updated_at, published_at, closed_at
        ) VALUES (?, ?, 'draft', NULL, 1, ?, ?, ?, NULL, NULL)
      `).run(id, resolvedBookId, createdByRef, timestamp, timestamp);
      this.database.query(`
        INSERT INTO survey_versions (
          survey_id, version, book_id, state, definition_json, created_at, published_at
        ) VALUES (?, 1, ?, 'draft', ?, ?, NULL)
      `).run(id, resolvedBookId, JSON.stringify(normalized), timestamp);
    });
    create();
    return this.survey(id, resolvedBookId);
  }

  updateSurveyDraft(id, definition, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const survey = this.survey(id, resolvedBookId);
    if (!survey) return null;
    if (survey.status === "closed") throw new TypeError("En lukket survey kan ikke redigeres.");
    const normalized = validateSurveyDefinition(definition);
    const timestamp = nowIso(this.clock);
    const draftVersion = survey.draftVersion ?? ((survey.publishedVersion ?? 0) + 1);
    const save = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO survey_versions (survey_id, version, book_id, state, definition_json, created_at, published_at)
        VALUES (?, ?, ?, 'draft', ?, ?, NULL)
        ON CONFLICT(survey_id, version) DO UPDATE SET definition_json = excluded.definition_json
      `).run(id, draftVersion, resolvedBookId, JSON.stringify(normalized), timestamp);
      this.database.query(`
        UPDATE surveys SET draft_version = ?, updated_at = ? WHERE id = ? AND book_id = ?
      `).run(draftVersion, timestamp, id, resolvedBookId);
    });
    save();
    return this.survey(id, resolvedBookId);
  }

  publishSurvey(id, { bookId = this.bookId, revisionId }) {
    const resolvedBookId = this.resolveBookId(bookId);
    const survey = this.survey(id, resolvedBookId);
    if (!survey) return null;
    if (survey.status === "closed") throw new TypeError("En lukket survey kan ikke publiceres.");
    if (!survey.draft) throw new TypeError("Surveyen har ingen kladde at publicere.");
    const revision = requireText(revisionId, "revisionId");
    const definition = validateSurveyDefinition({
      ...survey.draft.definition,
      target: { ...survey.draft.definition.target, revisionId: revision },
    });
    const timestamp = nowIso(this.clock);
    const publish = this.database.transaction(() => {
      if (survey.publishedVersion) {
        this.database.query("UPDATE survey_versions SET state = 'superseded' WHERE survey_id = ? AND version = ?")
          .run(id, survey.publishedVersion);
      }
      this.database.query(`
        UPDATE survey_versions SET state = 'published', definition_json = ?, published_at = ?
        WHERE survey_id = ? AND version = ? AND book_id = ?
      `).run(JSON.stringify(definition), timestamp, id, survey.draftVersion, resolvedBookId);
      this.database.query(`
        UPDATE surveys SET status = 'published', published_version = ?, draft_version = NULL,
          published_at = ?, closed_at = NULL, updated_at = ? WHERE id = ? AND book_id = ?
      `).run(survey.draftVersion, timestamp, timestamp, id, resolvedBookId);
    });
    publish();
    return this.survey(id, resolvedBookId);
  }

  closeSurvey(id, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const survey = this.survey(id, resolvedBookId);
    if (!survey) return null;
    const timestamp = nowIso(this.clock);
    this.database.query(`
      UPDATE surveys SET status = 'closed', draft_version = NULL, closed_at = ?, updated_at = ?
      WHERE id = ? AND book_id = ?
    `).run(timestamp, timestamp, id, resolvedBookId);
    this.database.query("DELETE FROM survey_versions WHERE survey_id = ? AND state = 'draft'").run(id);
    return this.survey(id, resolvedBookId);
  }

  getSurveyResponse({ surveyId, surveyVersion, revisionId, principal, bookId = this.bookId }) {
    const resolvedBookId = this.resolveBookId(bookId);
    const identity = respondentIdentity(principal);
    if (!identity.id) return null;
    const respondentRef = pseudonymRef(identity.kind, identity.id);
    const row = this.database.query(`
      SELECT survey_responses.*, users.display_name FROM survey_responses
      LEFT JOIN users ON users.id = survey_responses.user_id
      WHERE survey_id = ? AND survey_version = ? AND revision_id = ?
        AND respondent_ref = ? AND survey_responses.book_id = ?
    `).get(surveyId, surveyVersion, revisionId, respondentRef, resolvedBookId);
    return surveyResponseFromRow(row);
  }

  submitSurveyResponse({ surveyId, answers, revisionId, principal, bookId = this.bookId }) {
    const resolvedBookId = this.resolveBookId(bookId);
    const identity = respondentIdentity(principal);
    if (!identity.id) throw new TypeError("Surveybesvarelsen kræver en stabil identitet.");
    const survey = this.survey(surveyId, resolvedBookId);
    if (!survey || survey.status !== "published" || !survey.published) throw new TypeError("Surveyen er ikke aktiv.");
    const revision = requireText(revisionId, "revisionId");
    if (survey.published.definition.target.revisionId !== revision) {
      throw new TypeError("Surveyen hører til en anden bogrevision.");
    }
    const normalizedAnswers = validateSurveyAnswers(survey.published.definition, answers);
    const timestamp = nowIso(this.clock);
    const respondentKind = identity.kind;
    const respondentRef = pseudonymRef(respondentKind, identity.id);
    const userId = identity.userId;
    const existing = this.getSurveyResponse({
      surveyId, surveyVersion: survey.publishedVersion, revisionId: revision, principal, bookId: resolvedBookId,
    });
    const id = existing?.id ?? this.createId("survey-response");
    this.database.query(`
      INSERT INTO survey_responses (
        id, survey_id, survey_version, book_id, revision_id, respondent_kind,
        respondent_ref, user_id, target_json, answers_json, submitted_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(survey_id, survey_version, revision_id, respondent_ref) DO UPDATE SET
        answers_json = excluded.answers_json, target_json = excluded.target_json,
        user_id = excluded.user_id, updated_at = excluded.updated_at
    `).run(
      id, surveyId, survey.publishedVersion, resolvedBookId, revision, respondentKind,
      respondentRef, userId, JSON.stringify(survey.published.definition.target),
      JSON.stringify(normalizedAnswers), timestamp, timestamp,
    );
    return this.getSurveyResponse({
      surveyId, surveyVersion: survey.publishedVersion, revisionId: revision, principal, bookId: resolvedBookId,
    });
  }

  listSurveyResponses(bookId = this.bookId, { surveyId = null } = {}) {
    const resolvedBookId = this.resolveBookId(bookId);
    const rows = surveyId
      ? this.database.query(`
          SELECT survey_responses.*, users.display_name FROM survey_responses
          LEFT JOIN users ON users.id = survey_responses.user_id
          WHERE survey_responses.book_id = ? AND survey_id = ? ORDER BY updated_at DESC
        `).all(resolvedBookId, surveyId)
      : this.database.query(`
          SELECT survey_responses.*, users.display_name FROM survey_responses
          LEFT JOIN users ON users.id = survey_responses.user_id
          WHERE survey_responses.book_id = ? ORDER BY updated_at DESC
        `).all(resolvedBookId);
    return rows.map(surveyResponseFromRow);
  }

  exportUserData(userId) {
    const user = this.getUser(userId, null);
    if (!user) throw new TypeError("Brugeren findes ikke.");
    const memberships = this.database.query(`
      SELECT book_id, role, permissions_json, created_at, updated_at
      FROM memberships WHERE user_id = ? ORDER BY book_id
    `).all(userId).map((row) => ({
      bookId: row.book_id,
      role: row.role,
      permissions: parseJson(row.permissions_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const reviewerProfiles = this.database.query(`
      SELECT book_id, phone, phone_purpose, created_at, updated_at
      FROM book_reviewer_profiles WHERE user_id = ? ORDER BY book_id
    `).all(userId).map((row) => ({
      bookId: row.book_id,
      phone: row.phone,
      phonePurpose: row.phone_purpose,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const progress = this.database.query(`
      SELECT * FROM reading_progress WHERE user_id = ? ORDER BY book_id
    `).all(userId).map((row) => ({
      bookId: row.book_id,
      anchorId: row.anchor_id,
      pageNumber: row.page_number,
      percent: row.percent,
      engagedPercent: row.engaged_percent,
      completedAt: row.completed_at,
      lastEngagedAt: row.last_engaged_at,
      buildId: row.build_id,
      updatedAt: row.updated_at,
    }));
    const pageVisits = this.database.query(`
      SELECT book_id, anchor_id, page_number, first_read_at, last_read_at, visit_count
      FROM reading_page_visits WHERE user_id = ? ORDER BY book_id, first_read_at
    `).all(userId).map((row) => ({
      bookId: row.book_id,
      anchorId: row.anchor_id,
      pageNumber: row.page_number,
      firstReadAt: row.first_read_at,
      lastReadAt: row.last_read_at,
      visitCount: row.visit_count,
    }));
    const actorRef = pseudonymRef("user", userId);
    const auditEvents = this.database.query(`
      SELECT action, resource_type, resource_id, book_id, details_json, created_at
      FROM audit_events WHERE actor_ref = ? ORDER BY created_at
    `).all(actorRef).map((row) => ({
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      bookId: row.book_id,
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at,
    }));
    const surveyResponses = this.database.query(`
      SELECT survey_responses.*, users.display_name FROM survey_responses
      LEFT JOIN users ON users.id = survey_responses.user_id
      WHERE survey_responses.user_id = ? ORDER BY survey_responses.updated_at
    `).all(userId).map(surveyResponseFromRow);
    return { user, memberships, reviewerProfiles, progress, pageVisits, surveyResponses, auditEvents };
  }

  eraseUserData(userId) {
    const user = this.getUser(userId, null);
    if (!user) throw new TypeError("Brugeren findes ikke.");
    if (user.globalRole === "instance_admin" && user.status === "active" && this.activeAdministratorCount() <= 1) {
      throw new TypeError("Den sidste aktive administrator kan ikke slettes.");
    }
    const timestamp = nowIso(this.clock);
    const erasedEmail = `erased-${pseudonymRef("erased-user", userId).slice(0, 24)}@invalid.local`;
    const erase = this.database.transaction(() => {
      this.database.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.database.query("DELETE FROM memberships WHERE user_id = ?").run(userId);
      this.database.query("DELETE FROM book_reviewer_profiles WHERE user_id = ?").run(userId);
      this.database.query("DELETE FROM reading_preferences WHERE user_id = ?").run(userId);
      this.database.query("DELETE FROM reading_progress WHERE user_id = ?").run(userId);
      this.database.query("DELETE FROM reading_page_visits WHERE user_id = ?").run(userId);
      this.database.query("DELETE FROM survey_responses WHERE user_id = ?").run(userId);
      this.database.query("DELETE FROM invitations WHERE email = ?").run(user.email);
      this.database.query("UPDATE service_tokens SET actor_user_id = NULL WHERE actor_user_id = ?").run(userId);
      this.database.query(`
        UPDATE users SET
          email = ?, display_name = 'Slettet bruger', password_hash = ?,
          global_role = 'user', status = 'erased', updated_at = ?, erased_at = ?
        WHERE id = ?
      `).run(erasedEmail, `erased:${randomSecret()}`, timestamp, timestamp, userId);
    });
    erase();
    return { userId, erasedAt: timestamp };
  }

  audit({ principal, action, resourceType, resourceId = null, bookId = this.bookId, details = {} }) {
    const timestamp = nowIso(this.clock);
    const actorType = principal?.kind ?? "system";
    const rawActorId = principal?.id ?? "system";
    const actorRef = pseudonymRef(actorType, rawActorId);
    const safeDetails = sanitizeAuditDetails(details);
    const resolvedBookId = bookId == null ? null : this.resolveBookId(bookId);
    const id = this.createId("audit");
    this.database.query(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, actor_ref, token_id, action, resource_type,
        resource_id, book_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      actorType,
      actorRef,
      actorRef,
      principal?.tokenId ?? null,
      action,
      resourceType,
      resourceId,
      resolvedBookId,
      JSON.stringify(safeDetails),
      timestamp,
    );
    return {
      id,
      actorType,
      actorId: actorRef,
      actorRef,
      tokenId: principal?.tokenId ?? null,
      action,
      resourceType,
      resourceId,
      bookId: resolvedBookId,
      details: safeDetails,
      createdAt: timestamp,
    };
  }

  listAudit({ limit = 200, bookId = this.bookId } = {}) {
    const resolvedBookId = this.resolveBookId(bookId);
    const count = Math.max(1, Math.min(1000, Number(limit) || 200));
    return this.database.query(`
      SELECT * FROM audit_events WHERE book_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(resolvedBookId, count).map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      actorRef: row.actor_ref ?? row.actor_id,
      tokenId: row.token_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      bookId: row.book_id,
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at,
    }));
  }

  listAnnotationDeletionsSince(since, bookId = this.bookId) {
    const resolvedBookId = this.resolveBookId(bookId);
    const timestamp = new Date(since);
    if (Number.isNaN(timestamp.getTime())) throw new TypeError("since skal være et gyldigt tidspunkt.");
    return this.database.query(`
      SELECT id, resource_id, created_at FROM audit_events
      WHERE book_id = ? AND action = 'annotation.delete' AND resource_type = 'annotation'
        AND created_at > ?
      ORDER BY created_at, id
    `).all(resolvedBookId, timestamp.toISOString()).map((row) => ({
      eventId: row.id,
      annotationId: row.resource_id,
      changedAt: row.created_at,
    }));
  }

  principalForUser(userId, bookId = this.bookId) {
    const resolvedBookId = this.optionalBookId(bookId);
    if (!resolvedBookId) {
      const row = this.database.query("SELECT * FROM users WHERE id = ? AND status = 'active'").get(userId);
      return userPrincipal(row);
    }
    const row = this.database.query(`
      SELECT users.*, memberships.book_id, memberships.role AS book_role, memberships.permissions_json
      FROM users LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
      WHERE users.id = ? AND users.status = 'active'
    `).get(resolvedBookId, userId);
    return userPrincipal(row);
  }

  rolePermissions(role) {
    return [...(ROLE_PERMISSIONS[role] ?? [])];
  }
}
