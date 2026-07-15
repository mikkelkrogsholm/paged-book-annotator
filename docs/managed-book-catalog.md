# Administreret bogkatalog

Kataloglaget gør bogindhold uafhængigt af HTTP-, admin- og MCP-lagene. Det
bruger én SQLite-fil til metadata og en lokal, append-only mappe til bogens
revisioner. En integration opretter objekterne eksplicit:

```js
import { BookCatalogRepository } from "../src/server/book-catalog-repository.mjs";
import { LocalBookStorage } from "../src/server/book-storage.mjs";
import { ManagedBookCatalog } from "../src/server/managed-book-catalog.mjs";

const dataRoot = "/data";
const repository = new BookCatalogRepository({ filePath: `${dataRoot}/catalog.sqlite` });
const storage = new LocalBookStorage({ rootDir: dataRoot });
const catalog = new ManagedBookCatalog({ repository, storage });
```

Filer installeres først efter validering og en atomisk omdøbning:

```text
/data/catalog.sqlite
/data/uploads/<midlertidig revision>/
/data/library/<book-id>/revisions/<revision-id>/bundle.tar.gz
/data/library/<book-id>/revisions/<revision-id>/content/
```

`uploads` indeholder kun stagingdata. En færdig revisions `storageKey` peger på
dens `content`-mappe relativt til dataområdet. Revisionens indhold og manifest
ændres aldrig efter validering. `publishRevision()` ændrer kun katalogstatus og
bogens `active_revision_id` i én SQLite-transaktion.

## API

- `createBook()`, `getBook()`, `listBooks()` og `archiveBook()` administrerer
  katalogposten.
- `uploadRevision({ bookId, archivePath })` accepterer et gzip-komprimeret
  tar-arkiv og returnerer en `ready` revision.
- `importRevisionFromDirectory()` kopierer en allerede validerbar bogmappe ind
  som en revision.
- `importBookDirectory({ sourceDir, book?, publish? })` er
  migreringshjælperen for det tidligere `/book`-mount. Infrastrukturfelter som
  `server`, `annotations` og `collaboration` kopieres ikke ind i det
  normaliserede indholdsmanifest.
- `publishRevision()` gør en klar revision aktiv. En fejlet eller ufuldstændig
  revision kan ikke publiceres.

Uploadgrænsen er som standard 128 MiB komprimeret, 512 MiB udpakket, 5.000
entries og 128 MiB per fil. Tar-headere valideres før Bun ekstraherer arkivet.
Absolutte stier, traversal, duplikater, links, specialfiler og aktive filer som
JavaScript, WebAssembly og eksekverbare biblioteker afvises. Markup, SVG og CSS
kontrolleres desuden for scripts, event handlers og andre aktive konstruktioner.

Implementationen er designet mod repository-pinnen Bun 1.3.14 og er desuden
afprøvet med udviklingsmaskinens Bun 1.3.8. Den bruger `bun:sqlite`,
`Bun.Archive`, `Bun.gzipSync`/`Bun.gunzipSync` og standardbibliotekets
filesystem-API'er; den tilføjer ingen runtime-afhængigheder.
