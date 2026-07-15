#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") options.force = true;
    else if (["--book-dir", "--out", "--id", "--title", "--document", "--navigation", "--preset"].includes(argument)) options[argument.slice(2)] = argv[++index];
    else throw new TypeError(`Ukendt argument: ${argument}`);
  }
  return options;
}

function slug(value) {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "book";
}

async function chooseDocument(directory, requested) {
  if (requested) return requested;
  const files = (await readdir(directory)).filter((file) => /\.(?:html|xhtml)$/i.test(file));
  if (files.includes("book.html")) return "book.html";
  if (files.length === 1) return files[0];
  throw new TypeError("Kunne ikke vælge bogdokument entydigt; angiv --document.");
}

async function main() {
  const options = parseArguments(Bun.argv.slice(2));
  if (!options["book-dir"]) throw new TypeError("Angiv --book-dir med bogens mappe.");
  const bookDirectory = resolve(options["book-dir"]);
  const document = await chooseDocument(bookDirectory, options.document);
  if (!await Bun.file(join(bookDirectory, document)).exists()) throw new TypeError(`Bogdokumentet findes ikke: ${document}`);
  const title = options.title ?? basename(bookDirectory).replaceAll(/[-_]+/g, " ");
  const configPath = resolve(options.out ?? join(bookDirectory, "book-viewer.json"));
  if (!options.force && await Bun.file(configPath).exists()) throw new TypeError(`Konfigurationen findes allerede: ${configPath}. Brug --force for at erstatte den.`);
  const config = {
    server: { host: "127.0.0.1", port: 4173 },
    book: { id: options.id ?? slug(title), title, sourceDir: ".", document, ...(options.navigation ? { navigation: options.navigation } : {}), buildId: "draft-1" },
    annotations: { file: ".pba/annotations.json" },
    collaboration: { database: ".pba/collaboration.sqlite" },
    access: { preset: options.preset ?? "privateReview" },
    mcp: { enabled: true, endpoint: "/mcp" },
    security: { allowedOrigins: [], secureCookies: false },
  };
  await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Konfiguration skrevet: ${configPath}`);
  console.log(`Validér: bun scripts/validate-book-document.mjs ${join(bookDirectory, document)}`);
  console.log(`Start: bun server.mjs --config ${configPath}`);
}

if (import.meta.main) await main();

export { chooseDocument, slug };
