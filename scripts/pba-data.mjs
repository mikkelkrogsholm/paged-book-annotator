#!/usr/bin/env bun
import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { loadBookViewerConfig } from "../server.mjs";

function argumentsFrom(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--force") options.force = true;
    else if (value === "--config") options.config = rest[++index];
    else if (value === "--out") options.out = rest[++index];
    else if (value === "--file") options.file = rest[++index];
    else throw new TypeError(`Ukendt argument: ${value}`);
  }
  return options;
}

async function digest(databaseBytes, annotationsText) {
  const annotationBytes = new TextEncoder().encode(annotationsText);
  const input = new Uint8Array(databaseBytes.length + annotationBytes.length);
  input.set(databaseBytes); input.set(annotationBytes, databaseBytes.length);
  return Buffer.from(await crypto.subtle.digest("SHA-256", input)).toString("hex");
}

async function readBackup(filePath) {
  const backup = await Bun.file(filePath).json();
  if (backup.schemaVersion !== 1 || !backup.bookId || !backup.databaseBase64 || typeof backup.annotations !== "object") {
    throw new TypeError("Backupfilen har ikke det forventede schema.");
  }
  const databaseBytes = Buffer.from(backup.databaseBase64, "base64");
  const annotationsText = `${JSON.stringify(backup.annotations, null, 2)}\n`;
  if (await digest(databaseBytes, annotationsText) !== backup.sha256) throw new TypeError("Backupfilens checksum matcher ikke indholdet.");
  const database = Database.deserialize(databaseBytes);
  try {
    if (database.query("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new TypeError("SQLite-snapshottet fejler integrity_check.");
  } finally { database.close(); }
  return { backup, databaseBytes, annotationsText };
}

async function writeAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${Bun.randomUUIDv7()}.tmp`;
  await Bun.write(temporary, value);
  await rename(temporary, filePath);
}

async function createBackup(config, outputPath) {
  const database = new Database(config.collaboration.database, { readonly: true, strict: true });
  let databaseBytes;
  try { databaseBytes = database.serialize(); } finally { database.close(); }
  const annotations = await Bun.file(config.annotations.file).json().catch(() => ({ schemaVersion: 3, bookId: config.book.id, updatedAt: new Date(0).toISOString(), annotations: [] }));
  const annotationsText = `${JSON.stringify(annotations, null, 2)}\n`;
  const backup = {
    schemaVersion: 1,
    bookId: config.book.id,
    buildId: config.book.buildId,
    createdAt: new Date().toISOString(),
    annotations,
    databaseBase64: Buffer.from(databaseBytes).toString("base64"),
    sha256: await digest(databaseBytes, annotationsText),
  };
  await writeAtomically(outputPath, `${JSON.stringify(backup, null, 2)}\n`);
  return backup;
}

async function main() {
  const options = argumentsFrom(Bun.argv.slice(2));
  if (options.command === "verify") {
    if (!options.file) throw new TypeError("verify kræver --file.");
    const { backup } = await readBackup(resolve(options.file));
    console.log(`Backup OK: ${backup.bookId} · ${backup.createdAt}`);
    return;
  }
  if (!["backup", "restore"].includes(options.command)) throw new TypeError("Brug backup, verify eller restore.");
  const config = await loadBookViewerConfig(resolve(options.config ?? "book-viewer.config.example.json"));
  if (options.command === "backup") {
    const outputPath = resolve(options.out ?? `${config.book.id}.${new Date().toISOString().slice(0, 10)}.pba-backup.json`);
    const backup = await createBackup(config, outputPath);
    console.log(`Backup skrevet: ${outputPath} · sha256 ${backup.sha256}`);
    return;
  }
  if (!options.file) throw new TypeError("restore kræver --file.");
  if (!options.force && (await Bun.file(config.collaboration.database).exists() || await Bun.file(config.annotations.file).exists())) {
    throw new TypeError("Restore overskriver eksisterende data; gentag med --force efter at have taget backup og stoppet serveren.");
  }
  const { backup, databaseBytes, annotationsText } = await readBackup(resolve(options.file));
  if (backup.bookId !== config.book.id) throw new TypeError(`Backup tilhører ${backup.bookId}, ikke ${config.book.id}.`);
  await writeAtomically(config.collaboration.database, databaseBytes);
  await writeAtomically(config.annotations.file, annotationsText);
  console.log(`Restore fuldført: ${config.book.id}`);
}

if (import.meta.main) await main();

export { createBackup, readBackup };
