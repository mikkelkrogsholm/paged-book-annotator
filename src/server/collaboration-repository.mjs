// agent-lint: disable-file=AR002 -- SQLite row-to-DTO mappings intentionally repeat the stable public progress shape.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { resolveAccessPolicy, ROLE_PERMISSIONS, validateScopes } from "./access-policy.mjs";

export const COLLABORATION_SCHEMA_VERSION = 2;
export const USER_ROLES = Object.freeze(["instance_admin", "user"]);
export const BOOK_ROLES = Object.freeze(["book_admin", "reviewer", "reader"]);

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
  };
}

function membershipFromRow(row) {
  if (!row?.book_role) return null;
  return { bookId: row.book_id, role: row.book_role };
}

function userPrincipal(row) {
  if (!row) return null;
  return {
    kind: "user",
    ...userFromRow(row),
    bookId: row.book_id ?? null,
    role: row.book_role ?? null,
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.bookId = bookId;
    this.clock = clock;
    this.createId = createId;
    this.sessionHours = sessionHours;
    this.invitationHours = invitationHours;
    this.database = new Database(filePath, { create: true, strict: true });
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
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
  }

  close() {
    this.database.close();
  }

  health() {
    return this.database.query("SELECT 1 AS ok").get()?.ok === 1;
  }

  getAccessPolicy(fallbackPolicy) {
    const row = this.database.query("SELECT access_json FROM book_settings WHERE book_id = ?").get(this.bookId);
    return row ? resolveAccessPolicy(parseJson(row.access_json, {})) : resolveAccessPolicy(fallbackPolicy);
  }

  saveAccessPolicy(rawPolicy, updatedBy = null) {
    const policy = resolveAccessPolicy(rawPolicy);
    const timestamp = nowIso(this.clock);
    this.database.query(`
      INSERT INTO book_settings (book_id, access_json, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(book_id) DO UPDATE SET
        access_json = excluded.access_json,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(this.bookId, JSON.stringify(policy), updatedBy, timestamp, timestamp);
    return policy;
  }

  async createUser({ email, displayName, password, globalRole = "user", bookRole = null }) {
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
      if (bookRole) this.setMembership(user.id, bookRole, timestamp);
    });
    insert();
    return this.getUser(user.id);
  }

  async ensureBootstrapAdmin({ email, displayName = "Administrator", password }) {
    const existing = this.getUserByEmail(email);
    if (existing) {
      if (existing.globalRole !== "instance_admin") this.setGlobalRole(existing.id, "instance_admin");
      return this.getUser(existing.id);
    }
    return this.createUser({ email, displayName, password, globalRole: "instance_admin", bookRole: "book_admin" });
  }

  getUser(id) {
    const row = this.database.query(`
      SELECT users.*, memberships.book_id, memberships.role AS book_role
      FROM users LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
      WHERE users.id = ?
    `).get(this.bookId, id);
    if (!row) return null;
    return { ...userFromRow(row), membership: membershipFromRow(row) };
  }

  getUserByEmail(email) {
    const row = this.database.query("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
    return userFromRow(row);
  }

  async authenticate(email, password) {
    const row = this.database.query(`
      SELECT users.*, memberships.book_id, memberships.role AS book_role
      FROM users LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
      WHERE users.email = ? AND users.status = 'active'
    `).get(this.bookId, normalizeEmail(email));
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

  listUsers() {
    return this.database.query(`
      SELECT users.id, users.email, users.display_name, users.global_role, users.status,
             users.created_at, users.updated_at, memberships.book_id, memberships.role AS book_role
      FROM users LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
      ORDER BY users.display_name COLLATE NOCASE, users.email
    `).all(this.bookId).map((row) => ({ ...userFromRow(row), membership: membershipFromRow(row) }));
  }

  activeAdministratorCount() {
    return Number(this.database.query("SELECT COUNT(*) AS count FROM users WHERE global_role = 'instance_admin' AND status = 'active'").get()?.count ?? 0);
  }

  setMembership(userId, role, timestamp = nowIso(this.clock)) {
    if (!BOOK_ROLES.includes(role)) throw new TypeError(`Ukendt bogrolle: ${role}`);
    if (!this.getUser(userId)) throw new TypeError("Brugeren findes ikke.");
    this.database.query(`
      INSERT INTO memberships (user_id, book_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
    `).run(userId, this.bookId, role, timestamp, timestamp);
    return this.getUser(userId);
  }

  removeMembership(userId) {
    this.database.query("DELETE FROM memberships WHERE user_id = ? AND book_id = ?").run(userId, this.bookId);
    return this.getUser(userId);
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

  async resolveSession(secret) {
    if (!secret) return null;
    const timestamp = nowIso(this.clock);
    const row = this.database.query(`
      SELECT users.*, memberships.book_id, memberships.role AS book_role, sessions.id AS session_id
      FROM sessions JOIN users ON users.id = sessions.user_id
      LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
      WHERE sessions.secret_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND users.status = 'active'
    `).get(this.bookId, await hashSecret(secret), timestamp);
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

  async createInvitation({ email, displayName = "Prøvelæser", role = "reviewer", createdBy = null }) {
    if (!BOOK_ROLES.includes(role)) throw new TypeError(`Ukendt bogrolle: ${role}`);
    const id = this.createId("invite");
    const secret = `pbi_${id}_${randomSecret()}`;
    const timestamp = nowIso(this.clock);
    const expiresAt = futureIso(this.clock, this.invitationHours);
    this.database.query(`
      INSERT INTO invitations (id, email, display_name, book_id, role, secret_hash, expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, normalizeEmail(email), requireText(displayName, "displayName"), this.bookId, role, await hashSecret(secret), expiresAt, createdBy, timestamp);
    return { id, secret, email: normalizeEmail(email), displayName, bookId: this.bookId, role, expiresAt, createdAt: timestamp };
  }

  listInvitations() {
    return this.database.query(`
      SELECT id, email, display_name, book_id, role, expires_at, created_by, created_at, accepted_at, revoked_at
      FROM invitations WHERE book_id = ? ORDER BY created_at DESC
    `).all(this.bookId).map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      bookId: row.book_id,
      role: row.role,
      expiresAt: row.expires_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at,
    }));
  }

  revokeInvitation(id) {
    const result = this.database.query("UPDATE invitations SET revoked_at = ? WHERE id = ? AND book_id = ? AND revoked_at IS NULL")
      .run(nowIso(this.clock), id, this.bookId);
    return result.changes > 0;
  }

  async acceptInvitation({ secret, displayName, password }) {
    const timestamp = nowIso(this.clock);
    const invitation = this.database.query(`
      SELECT * FROM invitations
      WHERE secret_hash = ? AND book_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).get(await hashSecret(secret), this.bookId, timestamp);
    if (!invitation) throw new TypeError("Invitationen er ugyldig eller udløbet.");
    let user = this.getUserByEmail(invitation.email);
    if (!user) {
      user = await this.createUser({
        email: invitation.email,
        displayName: displayName || invitation.display_name,
        password,
        bookRole: invitation.role,
      });
    } else {
      if (!await this.authenticate(invitation.email, password)) {
        throw new TypeError("Den eksisterende bruger kræver sit korrekte password.");
      }
      this.setMembership(user.id, invitation.role);
    }
    this.database.query("UPDATE invitations SET accepted_at = ? WHERE id = ?").run(timestamp, invitation.id);
    return this.getUser(user.id);
  }

  async createServiceToken({ name, actorUserId = null, scopes, expiresInHours = 24 * 30, createdBy = null }) {
    const validatedScopes = validateScopes(scopes);
    const hours = Number(expiresInHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 365) throw new TypeError("Tokenets levetid skal være mellem 1 time og 365 dage.");
    const id = this.createId("token");
    const prefix = `pba_${id}`;
    const secret = `${prefix}_${randomSecret()}`;
    const timestamp = nowIso(this.clock);
    const expiresAt = futureIso(this.clock, hours);
    this.database.query(`
      INSERT INTO service_tokens (id, name, prefix, secret_hash, actor_user_id, book_id, scopes_json, expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, requireText(name, "name"), prefix, await hashSecret(secret), actorUserId, this.bookId, JSON.stringify(validatedScopes), expiresAt, createdBy, timestamp);
    return { id, name, prefix, secret, actorUserId, bookId: this.bookId, scopes: validatedScopes, expiresAt, createdAt: timestamp };
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
    return {
      kind: "token",
      id: `token:${row.id}`,
      tokenId: row.id,
      displayName: row.name,
      actorUserId: row.actor_user_id,
      bookId: row.book_id,
      scopes: parseJson(row.scopes_json, []),
      expiresAt: row.expires_at,
    };
  }

  listServiceTokens() {
    return this.database.query(`
      SELECT id, name, prefix, actor_user_id, book_id, scopes_json, expires_at, created_by, created_at, last_used_at, revoked_at
      FROM service_tokens WHERE book_id = ? ORDER BY created_at DESC
    `).all(this.bookId).map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      actorUserId: row.actor_user_id,
      bookId: row.book_id,
      scopes: parseJson(row.scopes_json, []),
      expiresAt: row.expires_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }

  revokeServiceToken(id) {
    const result = this.database.query("UPDATE service_tokens SET revoked_at = ? WHERE id = ? AND book_id = ? AND revoked_at IS NULL")
      .run(nowIso(this.clock), id, this.bookId);
    return result.changes > 0;
  }

  readingPreference(userId) {
    const row = this.database.query("SELECT tracking_enabled, updated_at FROM reading_preferences WHERE user_id = ? AND book_id = ?")
      .get(userId, this.bookId);
    return { trackingEnabled: row ? Boolean(row.tracking_enabled) : true, updatedAt: row?.updated_at ?? null };
  }

  setReadingPreference(userId, trackingEnabled) {
    if (typeof trackingEnabled !== "boolean") throw new TypeError("trackingEnabled skal være boolesk.");
    const timestamp = nowIso(this.clock);
    const save = this.database.transaction(() => {
      this.database.query(`
        INSERT INTO reading_preferences (user_id, book_id, tracking_enabled, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, book_id) DO UPDATE SET tracking_enabled = excluded.tracking_enabled, updated_at = excluded.updated_at
      `).run(userId, this.bookId, trackingEnabled ? 1 : 0, timestamp);
      if (!trackingEnabled) {
        this.database.query("DELETE FROM reading_progress WHERE user_id = ? AND book_id = ?").run(userId, this.bookId);
        this.database.query("DELETE FROM reading_page_visits WHERE user_id = ? AND book_id = ?").run(userId, this.bookId);
      }
    });
    save();
    return this.readingPreference(userId);
  }

  saveProgress(userId, { anchorId, pageNumber, percent = 0, buildId = "", event = "engaged" }) {
    const anchor = requireText(anchorId, "anchorId");
    const page = Number(pageNumber);
    const progressPercent = Number(percent);
    if (!Number.isInteger(page) || page < 1) throw new TypeError("pageNumber skal være et positivt heltal.");
    if (!Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100) {
      throw new TypeError("percent skal være mellem 0 og 100.");
    }
    if (!["position", "engaged", "complete"].includes(event)) throw new TypeError(`Ukendt progress-event: ${event}`);
    if (!this.readingPreference(userId).trackingEnabled) return null;
    const timestamp = nowIso(this.clock);
    const existing = this.getProgress(userId);
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
    `).run(userId, this.bookId, anchor, page, progressPercent, String(buildId ?? ""), timestamp, engagedPercent, completedAt, lastEngagedAt);
      if (event === "position") return;
      this.database.query(`
      INSERT INTO reading_page_visits (user_id, book_id, anchor_id, page_number, first_read_at, last_read_at, visit_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(user_id, book_id, anchor_id) DO UPDATE SET
        page_number = excluded.page_number,
        last_read_at = excluded.last_read_at,
        visit_count = reading_page_visits.visit_count + 1
    `).run(userId, this.bookId, anchor, page, timestamp, timestamp);
    });
    save();
    return this.getProgress(userId);
  }

  getReadPages(userId) {
    return this.database.query(`
      SELECT anchor_id, page_number, first_read_at, last_read_at, visit_count
      FROM reading_page_visits WHERE user_id = ? AND book_id = ? ORDER BY first_read_at
    `).all(userId, this.bookId).map((row) => ({
      anchorId: row.anchor_id,
      pageNumber: row.page_number,
      firstReadAt: row.first_read_at,
      lastReadAt: row.last_read_at,
      visitCount: row.visit_count,
    }));
  }

  getProgress(userId) {
    const row = this.database.query("SELECT * FROM reading_progress WHERE user_id = ? AND book_id = ?")
      .get(userId, this.bookId);
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
      tracking: this.readingPreference(userId),
      readPages: this.getReadPages(userId),
    };
  }

  listProgress() {
    return this.database.query(`
      SELECT reading_progress.*, users.display_name, users.email
      FROM reading_progress LEFT JOIN users ON users.id = reading_progress.user_id
      WHERE reading_progress.book_id = ? ORDER BY reading_progress.updated_at DESC
    `).all(this.bookId).map((row) => ({
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
      tracking: this.readingPreference(row.user_id),
      readPages: this.getReadPages(row.user_id),
    }));
  }

  audit({ principal, action, resourceType, resourceId = null, bookId = this.bookId, details = {} }) {
    const timestamp = nowIso(this.clock);
    const actorType = principal?.kind ?? "system";
    const actorId = principal?.id ?? "system";
    const id = this.createId("audit");
    this.database.query(`
      INSERT INTO audit_events (id, actor_type, actor_id, token_id, action, resource_type, resource_id, book_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, actorType, actorId, principal?.tokenId ?? null, action, resourceType, resourceId, bookId, JSON.stringify(details), timestamp);
    return { id, actorType, actorId, tokenId: principal?.tokenId ?? null, action, resourceType, resourceId, bookId, details, createdAt: timestamp };
  }

  listAudit({ limit = 200 } = {}) {
    const count = Math.max(1, Math.min(1000, Number(limit) || 200));
    return this.database.query(`
      SELECT * FROM audit_events WHERE book_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(this.bookId, count).map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      tokenId: row.token_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      bookId: row.book_id,
      details: parseJson(row.details_json, {}),
      createdAt: row.created_at,
    }));
  }

  principalForUser(userId) {
    const row = this.database.query(`
      SELECT users.*, memberships.book_id, memberships.role AS book_role
      FROM users LEFT JOIN memberships ON memberships.user_id = users.id AND memberships.book_id = ?
      WHERE users.id = ? AND users.status = 'active'
    `).get(this.bookId, userId);
    return userPrincipal(row);
  }

  rolePermissions(role) {
    return [...(ROLE_PERMISSIONS[role] ?? [])];
  }
}
