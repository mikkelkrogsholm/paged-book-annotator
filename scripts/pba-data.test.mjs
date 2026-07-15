import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { Database } from "bun:sqlite";

const scriptPath = new URL("./pba-data.mjs", import.meta.url).pathname;

async function run(arguments_) {
  const child = Bun.spawn([process.execPath, scriptPath, ...arguments_], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("data CLI creates, verifies and restores a consistent book backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pba-data-"));
  const bookDirectory = join(directory, "book");
  const databasePath = join(directory, "collaboration.sqlite");
  const annotationsPath = join(directory, "annotations.json");
  const configPath = join(directory, "config.json");
  const backupPath = join(directory, "snapshot.pba-backup.json");
  await mkdir(bookDirectory);
  await writeFile(join(bookDirectory, "book.html"), "<!doctype html><main data-book-anchor=book>Backupbog</main>");
  await writeFile(annotationsPath, JSON.stringify({ schemaVersion: 3, bookId: "backup-book", updatedAt: "2026-07-15T10:00:00.000Z", annotations: [] }));
  await writeFile(configPath, JSON.stringify({
    book: { id: "backup-book", title: "Backupbog", sourceDir: "book", document: "book.html" },
    annotations: { file: "annotations.json" }, collaboration: { database: "collaboration.sqlite" }, access: { preset: "local" },
  }));
  const database = new Database(databasePath, { create: true });
  database.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('bevaret');");
  database.close();
  try {
    const backup = await run(["backup", "--config", configPath, "--out", backupPath]);
    assert.equal(backup.exitCode, 0, backup.stderr);
    assert.match(backup.stdout, /Backup skrevet/);
    const verified = await run(["verify", "--file", backupPath]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    await unlink(databasePath); await unlink(annotationsPath);
    const restored = await run(["restore", "--config", configPath, "--file", backupPath]);
    assert.equal(restored.exitCode, 0, restored.stderr);
    const restoredDatabase = new Database(databasePath, { readonly: true });
    try { assert.equal(restoredDatabase.query("SELECT value FROM proof").get().value, "bevaret"); } finally { restoredDatabase.close(); }
    assert.equal((await Bun.file(annotationsPath).json()).bookId, "backup-book");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
