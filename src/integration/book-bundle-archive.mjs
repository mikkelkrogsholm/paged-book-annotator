import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  assertPassiveBundlePath,
  BOOK_BUNDLE_CONTRACT,
  BookBundleContractError,
  DEFAULT_BOOK_BUNDLE_LIMITS,
  inspectBookBundleTree,
  validateBookBundleDirectory,
  validateBundleRelativePath,
} from "./book-bundle-contract.mjs";

export const DEFAULT_BOOK_ARCHIVE_LIMITS = Object.freeze({
  ...DEFAULT_BOOK_BUNDLE_LIMITS,
  maxArchiveBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 200,
  minDecompressedAllowanceBytes: 8 * 1024 * 1024,
});

function archiveError(code, message, details) {
  throw new BookBundleContractError(code, message, details);
}

function tarText(bytes, start, length) {
  const end = bytes.indexOf(0, start);
  return new TextDecoder().decode(bytes.subarray(start, end >= start && end < start + length ? end : start + length));
}

function tarOctal(bytes, start, length, field) {
  const value = tarText(bytes, start, length).trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) archiveError("archive_header_invalid", `Tar-headerens ${field} er ugyldigt.`);
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) archiveError("archive_header_invalid", `Tar-headerens ${field} er for stort.`);
  return number;
}

function assertTarChecksum(bytes, offset) {
  const recorded = tarOctal(bytes, offset + 148, 8, "checksum");
  let calculated = 0;
  for (let index = 0; index < 512; index += 1) calculated += index >= 148 && index < 156 ? 32 : bytes[offset + index];
  if (recorded !== calculated) archiveError("archive_checksum_invalid", "Tar-arkivet har en ugyldig header-checksum.");
}

export function inspectBookBundleTarBytes(bytes, limits = DEFAULT_BOOK_ARCHIVE_LIMITS) {
  const inspector = createTarInspector(limits);
  inspector.push(bytes);
  return inspector.finish();
}

function createTarInspector(limits) {
  const entries = [];
  const paths = new Set();
  let expandedBytes = 0;
  let bodyBytesRemaining = 0;
  let headerBytes = 0;
  let complete = false;
  const header = new Uint8Array(512);

  function inspectHeader() {
    if (header.every((byte) => byte === 0)) {
      complete = true;
      return;
    }
    assertTarChecksum(header, 0);
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(header[156] || 48);
    const size = tarOctal(header, 124, 12, "filstørrelse");
    const path = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    validateBundleRelativePath(path, { field: "tar-sti", maxPathLength: limits.maxPathLength });
    if (!new Set(["0", "5"]).has(type)) {
      archiveError("archive_entry_type_unsupported", `Tar-arkivet indeholder links eller en ikke-understøttet entry-type: ${path}`, { file: path });
    }
    if (paths.has(path)) archiveError("archive_path_duplicate", `Tar-arkivet indeholder samme sti flere gange: ${path}`, { file: path });
    paths.add(path);
    if (type === "0") {
      assertPassiveBundlePath(path);
      if (size > limits.maxFileBytes) archiveError("file_too_large", `Tar-filen er for stor: ${path}`, { file: path });
      expandedBytes += size;
      if (expandedBytes > limits.maxExpandedBytes) archiveError("expanded_size_exceeded", "Tar-arkivet overskrider den tilladte udpakkede størrelse.");
    } else if (size !== 0) {
      archiveError("archive_directory_size_invalid", `Tar-mappen har uventet indholdsstørrelse: ${path}`, { file: path });
    }
    entries.push({ path, type: type === "5" ? "directory" : "file", size });
    if (entries.length > limits.maxFiles) archiveError("file_count_exceeded", `Tar-arkivet indeholder mere end ${limits.maxFiles} entries.`);
    bodyBytesRemaining = Math.ceil(size / 512) * 512;
  }

  function push(chunk) {
    let offset = 0;
    while (offset < chunk.byteLength && !complete) {
      if (bodyBytesRemaining > 0) {
        const consumed = Math.min(bodyBytesRemaining, chunk.byteLength - offset);
        bodyBytesRemaining -= consumed;
        offset += consumed;
        continue;
      }
      const consumed = Math.min(512 - headerBytes, chunk.byteLength - offset);
      header.set(chunk.subarray(offset, offset + consumed), headerBytes);
      headerBytes += consumed;
      offset += consumed;
      if (headerBytes === 512) {
        inspectHeader();
        header.fill(0);
        headerBytes = 0;
      }
    }
  }

  function finish() {
    if (bodyBytesRemaining > 0 || (headerBytes > 0 && header.subarray(0, headerBytes).some((byte) => byte !== 0))) {
      archiveError("archive_truncated", "Tar-arkivet er afkortet.");
    }
    if (entries.length === 0) archiveError("archive_empty", "Tar-arkivet er tomt.");
    return { entries, expandedBytes };
  }

  return { push, finish };
}

function maximumStreamedTarBytes(compressedBytes, limits) {
  const structuralMaximum = limits.maxExpandedBytes + limits.maxFiles * 1024 + 1024;
  const ratioMaximum = Math.max(
    limits.minDecompressedAllowanceBytes,
    compressedBytes * limits.maxCompressionRatio,
  );
  return Math.min(structuralMaximum, ratioMaximum);
}

export async function inspectBookBundleGzipBytes(compressed, limits = DEFAULT_BOOK_ARCHIVE_LIMITS) {
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) {
    archiveError("archive_not_gzip", "Uploaden skal være et gzip-komprimeret tar-arkiv.");
  }
  const inspector = createTarInspector(limits);
  const maximumBytes = maximumStreamedTarBytes(compressed.byteLength, limits);
  let decompressedBytes = 0;
  let reader;
  let completed = false;
  try {
    reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      decompressedBytes += value.byteLength;
      if (decompressedBytes > maximumBytes) {
        archiveError(
          "archive_decompression_limit_exceeded",
          `Uploadarkivet overskrider den sikre dekomprimeringsgrænse på ${maximumBytes} bytes.`,
        );
      }
      inspector.push(value);
    }
    const inspection = inspector.finish();
    completed = true;
    return inspection;
  } catch (cause) {
    if (cause instanceof BookBundleContractError) throw cause;
    archiveError("archive_gzip_invalid", "Uploadarkivet kan ikke dekomprimeres som gzip.", { cause });
  } finally {
    if (!completed && reader) await reader.cancel().catch(() => {});
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

async function readArchive(archivePath, limits) {
  const absolutePath = resolve(archivePath);
  const archive = Bun.file(absolutePath);
  if (!(await archive.exists())) archiveError("archive_missing", "Uploadarkivet findes ikke.", { file: absolutePath });
  if (archive.size > limits.maxArchiveBytes) archiveError("archive_size_exceeded", "Uploadarkivet overskrider den tilladte komprimerede størrelse.", { file: absolutePath });
  const compressed = await archive.bytes();
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) archiveError("archive_not_gzip", "Uploaden skal være et gzip-komprimeret tar-arkiv.", { file: absolutePath });
  const inspection = await inspectBookBundleGzipBytes(compressed, limits);
  return { absolutePath, compressed, inspection };
}

export async function validateBookBundleArchive(archivePath, options = {}) {
  const limits = { ...DEFAULT_BOOK_ARCHIVE_LIMITS, ...options.limits };
  const archive = await readArchive(archivePath, limits);
  const paths = archive.inspection.entries.map((entry) => entry.path);
  if (!paths.includes(BOOK_BUNDLE_CONTRACT.manifest)) {
    const nestedManifest = paths.find((path) => path.endsWith(`/${BOOK_BUNDLE_CONTRACT.manifest}`));
    if (nestedManifest) archiveError("archive_wrapper_root", `Manifestet skal ligge i arkivets rod, ikke under ${nestedManifest}.`, { file: nestedManifest });
    archiveError("manifest_missing", `Arkivet mangler ${BOOK_BUNDLE_CONTRACT.manifest} i roden.`, { file: BOOK_BUNDLE_CONTRACT.manifest });
  }

  const extractionRoot = await mkdtemp(join(tmpdir(), "pba-bundle-validate-"));
  try {
    const extracted = await new Bun.Archive(archive.compressed).extract(extractionRoot);
    if (extracted < 1) archiveError("archive_empty", "Uploadarkivet indeholder ingen filer.");
    const result = await validateBookBundleDirectory(extractionRoot, {
      compatibility: options.compatibility ?? "strict",
      expectedBookId: options.expectedBookId,
      limits,
    });
    return {
      ...result,
      sourceType: "archive",
      archive: {
        compressedBytes: archive.compressed.byteLength,
        expandedBytes: archive.inspection.expandedBytes,
        entries: archive.inspection.entries.length,
        sha256: sha256(archive.compressed),
      },
    };
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

export async function packBookBundleDirectory(bundleRoot, outputPath, options = {}) {
  const root = resolve(bundleRoot);
  const destination = resolve(outputPath);
  if (pathIsInside(root, destination)) archiveError("archive_output_inside_bundle", "Outputarkivet må ikke ligge inde i bundle-mappen.", { file: destination });
  const limits = { ...DEFAULT_BOOK_ARCHIVE_LIMITS, ...options.limits };
  const directoryResult = await validateBookBundleDirectory(root, {
    compatibility: "strict",
    expectedBookId: options.expectedBookId,
    limits,
  });
  const tree = await inspectBookBundleTree(root, limits);
  const archiveEntries = {};
  for (const file of [...tree.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    archiveEntries[file.path] = await Bun.file(file.absolutePath).bytes();
  }
  const bytes = await new Bun.Archive(archiveEntries, { compress: "gzip", level: 9 }).bytes();
  if (bytes.byteLength > limits.maxArchiveBytes) archiveError("archive_size_exceeded", "Det pakkede arkiv overskrider den tilladte komprimerede størrelse.");
  inspectBookBundleTarBytes(Bun.gunzipSync(bytes), limits);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${Bun.randomUUIDv7()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  const archiveResult = await validateBookBundleArchive(destination, {
    compatibility: "strict",
    expectedBookId: options.expectedBookId ?? directoryResult.manifest.book.id,
    limits,
  });
  return { ...archiveResult, outputPath: destination };
}
