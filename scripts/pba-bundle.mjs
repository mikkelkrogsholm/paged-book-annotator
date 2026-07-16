#!/usr/bin/env bun

import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  BOOK_BUNDLE_CONTRACT,
  BookBundleContractError,
  validateBookBundleDirectory,
  validateBundleRelativePath,
} from "../src/integration/book-bundle-contract.mjs";
import {
  packBookBundleDirectory,
  validateBookBundleArchive,
} from "../src/integration/book-bundle-archive.mjs";

const HELP = `Paged Book Bundle CLI

Usage:
  bun run bundle init --out <directory> --id <book-id> --title <title> [--document <file>] [--force]
  bun run bundle validate <directory-or-tar.gz> [--expected-book-id <book-id>] [--json]
  bun run bundle pack <directory> --out <book.tar.gz> [--expected-book-id <book-id>] [--json]

Commands:
  init      Create a minimal, strictly valid v1 bundle.
  validate  Validate a bundle directory or gzip-compressed tar archive.
  pack      Validate and deterministically package a directory.
`;

class BundleCliError extends TypeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BundleCliError";
    this.code = code;
    this.file = details.file ?? null;
    this.field = details.field ?? null;
  }
}

function cliError(code, message, details) {
  throw new BundleCliError(code, message, details);
}

function parseArguments(arguments_) {
  const positionals = [];
  const options = {};
  const booleanOptions = new Set(["force", "help", "json"]);
  const valueOptions = new Set(["document", "expected-book-id", "id", "out", "title"]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (booleanOptions.has(name)) {
      options[name] = true;
      continue;
    }
    if (!valueOptions.has(name)) cliError("cli_option_unknown", `Ukendt option: --${name}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) cliError("cli_option_value_missing", `--${name} kræver en værdi.`, { field: name });
    options[name] = value;
    index += 1;
  }
  return { positionals, options };
}

function requireOption(options, name) {
  const value = String(options[name] ?? "").trim();
  if (!value) cliError("cli_option_required", `--${name} er påkrævet.`, { field: name });
  return value;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function minimalBookHtml({ id, title, language }) {
  const safeId = escapeHtml(id);
  const safeTitle = escapeHtml(title);
  const safeLanguage = escapeHtml(language);
  return `<!doctype html>
<html lang="${safeLanguage}" data-paged-complete="true">
  <head>
    <meta charset="utf-8">
    <title>${safeTitle}</title>
  </head>
  <body data-pre-paginated="true">
    <main class="pagedjs_pages">
      <section class="pagedjs_page" data-book-page-label="1">
        <article data-book-anchor="${safeId}.start">
          <h1>${safeTitle}</h1>
          <p data-book-anchor="${safeId}.start.text" data-annotation-text>Erstat denne tekst med bogens indhold.</p>
        </article>
      </section>
    </main>
  </body>
</html>
`;
}

async function assertWritableBundleDirectory(outputDirectory, force) {
  try {
    const info = await stat(outputDirectory);
    if (!info.isDirectory()) cliError("init_output_not_directory", "--out skal pege på en mappe.", { file: outputDirectory });
    if (!force && (await readdir(outputDirectory)).length > 0) {
      cliError("init_output_not_empty", "Outputmappen er ikke tom; brug --force for at skrive kontraktfilerne.", { file: outputDirectory });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(outputDirectory, { recursive: true });
}

export async function initializeBookBundle({ outputDirectory, id, title, document = "book.html", language = "da", force = false }) {
  const root = resolve(outputDirectory);
  const documentPath = validateBundleRelativePath(document, { field: "book.document" });
  if (!documentPath.toLowerCase().endsWith(".html")) cliError("init_document_extension_invalid", "Det initiale bogdokument skal være en .html-fil.", { field: "document" });
  await assertWritableBundleDirectory(root, force);
  const manifest = {
    schemaVersion: BOOK_BUNDLE_CONTRACT.version,
    book: { id, title, language, document: documentPath },
  };
  await mkdir(dirname(resolve(root, documentPath)), { recursive: true });
  await Bun.write(resolve(root, BOOK_BUNDLE_CONTRACT.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  await Bun.write(resolve(root, documentPath), minimalBookHtml({ id, title, language }));
  const result = await validateBookBundleDirectory(root, { compatibility: "strict", expectedBookId: id });
  return { ...result, sourceType: "directory", inputPath: root };
}

export async function validateBundleInput(inputPath, options = {}) {
  const absolutePath = resolve(inputPath);
  let info;
  try {
    info = await stat(absolutePath);
  } catch (cause) {
    if (cause?.code === "ENOENT") cliError("input_missing", "Bundle-inputtet findes ikke.", { file: absolutePath });
    throw cause;
  }
  if (info.isDirectory()) {
    const result = await validateBookBundleDirectory(absolutePath, {
      compatibility: "strict",
      expectedBookId: options.expectedBookId,
    });
    return { ...result, sourceType: "directory", inputPath: absolutePath };
  }
  if (!info.isFile()) cliError("input_type_unsupported", "Bundle-inputtet skal være en mappe eller regulær .tar.gz-fil.", { file: absolutePath });
  return validateBookBundleArchive(absolutePath, {
    compatibility: "strict",
    expectedBookId: options.expectedBookId,
  });
}

function successDocument(command, result) {
  return {
    ok: true,
    command,
    contract: result.contract,
    sourceType: result.sourceType,
    book: result.manifest.book,
    validation: result.validation,
    ...(result.archive ? { archive: result.archive } : {}),
    ...(result.outputPath ? { outputPath: result.outputPath } : {}),
    ...(result.inputPath ? { inputPath: result.inputPath } : {}),
  };
}

export function bundleErrorDocument(error) {
  const known = error instanceof BookBundleContractError || error instanceof BundleCliError;
  return {
    ok: false,
    error: {
      code: known ? error.code : "bundle_command_failed",
      message: error instanceof Error ? error.message : String(error),
      ...(error?.file ? { file: error.file } : {}),
      ...(error?.field ? { field: error.field } : {}),
    },
  };
}

function humanSummary(command, result) {
  if (command === "init") return `Oprettede gyldig bundle v1 for ${result.manifest.book.id} i ${result.inputPath}.`;
  if (command === "pack") return `Pakkede gyldig bundle v1 for ${result.manifest.book.id} til ${result.outputPath}.`;
  return `Bundle v1 for ${result.manifest.book.id} er gyldig (${result.validation.fileCount} filer, ${result.sourceType}).`;
}

export async function runBundleCli(argv, io = {}) {
  const writeOut = io.writeOut ?? ((value) => process.stdout.write(value));
  const writeError = io.writeError ?? ((value) => process.stderr.write(value));
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    writeOut(HELP);
    return 0;
  }
  let json = rest.includes("--json");
  try {
    const { positionals, options } = parseArguments(rest);
    json = Boolean(options.json);
    let result;
    if (command === "init") {
      if (positionals.length) cliError("cli_positional_unexpected", "init modtager ingen positionelle argumenter.");
      result = await initializeBookBundle({
        outputDirectory: requireOption(options, "out"),
        id: requireOption(options, "id"),
        title: requireOption(options, "title"),
        document: options.document,
        force: Boolean(options.force),
      });
    } else if (command === "validate") {
      if (positionals.length !== 1) cliError("cli_input_required", "validate kræver præcis én mappe eller .tar.gz-fil.");
      result = await validateBundleInput(positionals[0], { expectedBookId: options["expected-book-id"] });
    } else if (command === "pack") {
      if (positionals.length !== 1) cliError("cli_input_required", "pack kræver præcis én bundle-mappe.");
      result = await packBookBundleDirectory(positionals[0], requireOption(options, "out"), {
        expectedBookId: options["expected-book-id"],
      });
    } else {
      cliError("cli_command_unknown", `Ukendt kommando: ${command}`);
    }
    writeOut(json ? `${JSON.stringify(successDocument(command, result))}\n` : `${humanSummary(command, result)}\n`);
    return 0;
  } catch (error) {
    const document = bundleErrorDocument(error);
    if (json) writeOut(`${JSON.stringify(document)}\n`);
    else writeError(`${document.error.code}: ${document.error.message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runBundleCli(Bun.argv.slice(2));
