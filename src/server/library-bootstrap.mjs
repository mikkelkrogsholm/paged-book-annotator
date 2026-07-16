import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { BookCatalogRepository } from "./book-catalog-repository.mjs";
import { LocalBookStorage } from "./book-storage.mjs";
import { ManagedBookCatalog } from "./managed-book-catalog.mjs";

export async function openManagedBookCatalog(config) {
  const catalogRepository = new BookCatalogRepository({ filePath: config.library.catalogDatabase });
  const storage = new LocalBookStorage({
    rootDir: config.library.dataDir,
    limits: { maxArchiveBytes: config.library.uploadMaxBytes },
  });
  const catalog = new ManagedBookCatalog({
    repository: catalogRepository,
    storage,
    maxRevisionsPerBook: config.library.maxRevisionsPerBook,
  });
  if (catalog.listBooks({ includeArchived: true }).length > 0 || !config.book) {
    return { catalogRepository, catalog };
  }

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
  return { catalogRepository, catalog };
}
