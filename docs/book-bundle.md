# Paged Book Bundle Contract v1

Status: normativ og stabil. Denne fil er den selvstændige kontrakt for at bygge
en ny bundle. Ordene **SKAL**, **MÅ IKKE**, **BØR** og **KAN** er normative.
Manifestets maskinlæsbare kontrakt er
[`schemas/book-viewer.bundle.v1.schema.json`](../schemas/book-viewer.bundle.v1.schema.json).

En bundle er en passiv, selvbærende bogrevision. Den kan valideres som en mappe
og uploades som et gzip-komprimeret tar-arkiv. Runtime-, adgangs-, bruger- og
annotationsdata hører aldrig til i bundlen.

## Hurtigste sikre vej for mennesker og agenter

Fra repository-roden:

```sh
bun run bundle init --out ./my-book --id my-book --title "Min bog"
# Erstat det genererede indhold, og behold kontraktmarkørerne.
bun run bundle validate ./my-book --expected-book-id my-book --json
bun run bundle pack ./my-book --out ./my-book.tar.gz --expected-book-id my-book --json
bun run bundle validate ./my-book.tar.gz --expected-book-id my-book --json
```

`init` skaber den minimale gyldige fixture. `pack` validerer først og skaber et
deterministisk arkiv; samme filindhold giver byte-identisk output. Brug denne
kommando frem for en generel tar-kommando.

## Kanoniske layouts

Den minimale bundle findes i [`example/minimal-book`](../example/minimal-book):

```text
my-book/
├── book-viewer.json
└── book.html
```

Den komplette integrationsfixture findes i [`example/book`](../example/book):

```text
book/
├── book-viewer.json
├── book.html
└── navigation.xhtml
```

Den komplette fixture viser alle manifestfelter, hierarkisk navigation, flere
sider og flere ankertyper. `book-viewer.json` SKAL ligge direkte i roden.
Assetmapper til CSS, billeder og fonts er valgfrie.

## Manifestet `book-viewer.json`

Et nyt v1-manifest SKAL være UTF-8 JSON, matche JSON Schemaet og må ikke have
ukendte felter:

```json
{
  "schemaVersion": 1,
  "book": {
    "id": "my-book",
    "title": "Min bog",
    "subtitle": "Første korrektur",
    "mark": "MB",
    "language": "da",
    "document": "book.html",
    "navigation": "navigation.xhtml",
    "buildId": "2026-07-15T10:00:00Z"
  }
}
```

| Felt | Krav |
| --- | --- |
| `schemaVersion` | Påkrævet og præcis tallet `1`. |
| `book.id` | Påkrævet, stabilt og 1–96 tegn. Regex: `^[a-z0-9][a-z0-9_-]{0,95}$`. Ved upload SKAL det matche katalogbogens id. |
| `book.title` | Påkrævet, ikke-tom tekst, højst 200 tegn. |
| `book.document` | Påkrævet relativ POSIX-sti til bogens `.html`- eller `.xhtml`-dokument, højst 240 tegn. |
| `book.subtitle` | Valgfri, ikke-tom tekst, højst 300 tegn. |
| `book.mark` | Valgfri, ikke-tom tekst, højst 16 tegn. |
| `book.language` | Valgfri, ikke-tom tekst, 2–35 tegn; BØR være et BCP 47-sprog-tag. |
| `book.navigation` | Valgfri relativ POSIX-sti til en `.xhtml`-navigation. |
| `book.buildId` | Valgfri stabil build-identitet, højst 200 tegn. |

En bundle-sti SKAL være relativ, bruge `/`, have ikke-tomme segmenter og må
ikke indeholde `.`- eller `..`-segmenter, `?`, `#`, backslash, NUL, drevbogstav eller
absolut rod.

## Bogdokumentet

`book.document` SKAL være et passivt, færdigpagineret HTML-dokument. Det SKAL:

1. indeholde mindst én `.pagedjs_pages`-container og én `.pagedjs_page`;
2. sætte `data-paged-complete="true"` på `<html>` eller
   `data-pre-paginated="true"` på `<body>`;
3. indeholde mindst én unik `data-book-anchor`;
4. give hvert element med `data-annotation-text` sit eget unikke
   `data-book-anchor`.

Minimal struktur:

```html
<!doctype html>
<html lang="da" data-paged-complete="true">
  <head><meta charset="utf-8"><title>Min bog</title></head>
  <body data-pre-paginated="true">
    <main class="pagedjs_pages">
      <section class="pagedjs_page" data-book-page-label="1">
        <article data-book-anchor="chapter-1">
          <h1>Kapitel 1</h1>
          <p data-book-anchor="chapter-1.p-1" data-annotation-text>Tekst.</p>
        </article>
      </section>
    </main>
  </body>
</html>
```

`data-book-anchor` er en permanent indholdsidentitet og BØR ikke indeholde et
sidetal. Sidetal og `data-book-page-label` er kun hints. En ændret udgave BØR
genbruge ankeret, når det semantisk er samme passage. Uklare matches bliver
`anchorState: orphaned`; klienter må ikke gætte. Den fulde
genforankringskontrakt står i
[`manifest-and-anchors.md`](manifest-and-anchors.md).

Hvis `book.navigation` er angivet, SKAL dokumentet opfylde
[`navigation.md`](navigation.md), og hvert lokalt link SKAL pege på et
eksisterende stabilt mål i bogdokumentet.

## Passive filer og referencer

Bundlen SKAL fungere uden netværk og uden værtens filsystem. `src`, `href`,
`poster`, CSS `url()` og CSS `@import` SKAL pege på eksisterende regulære filer
inde i bundlen. Fragmenter og passive, indlejrede rasterbilleder som
`data:image/avif`, `bmp`, `gif`, `jpeg`, `png` eller `webp` er tilladt; øvrige
`data:`-URL'er er forbudt. Eksterne schemes, protocol-relative URL'er
og stier ud af roden er forbudt. Strikte bundles må ikke bruge `srcset`, fordi
hver kandidat ellers udgør sin egen referencekanal.

Følgende er forbudt:

- symbolske links, hardlinks, devices, sockets og andre specialfiler;
- aktiv markup: blandt andet `script`, forms, frames, portals, `object`, `embed`,
  `base`, event-attributter, namespacede aktive elementer, `javascript:` og
  refresh-meta;
- aktiv SVG: blandt andet `script`, `foreignObject`, animation og
  event-attributter;
- aktiv CSS: `expression()`, `behavior`, `-moz-binding` og `image-set()`;
- inline `<style>`, `style`-attributter og CSS indlæst fra `data:`-URL'er;
- `.htaccess` og filendelserne `.cjs`, `.class`, `.dll`, `.dylib`, `.exe`,
  `.hta`, `.htc`, `.htm`, `.jar`, `.js`, `.mht`, `.mhtml`, `.mjs`, `.node`,
  `.php`, `.py`, `.rb`, `.sh`, `.shtml`, `.so`, `.svgz`, `.swf`, `.wasm`,
  `.xht`, `.xml`, `.xsl` og `.xslt`.

Viewerens skærm-CSS må ikke ændre bogens print-stylesheet. Bogens egne fonts,
billeder og printregler skal derfor ligge i bundlen.

## Arkivformat og grænser

Uploadformatet SKAL være et gzip-komprimeret POSIX tar-arkiv (`.tar.gz`, media
type `application/gzip` eller `application/x-gzip`). Arkivet SKAL have
`book-viewer.json` direkte i roden; en fælles wrapper-mappe er ugyldig. Kun
regulære filer og mapper accepteres. Duplikerede stier, links, PAX/GNU
specialentries, traversal og ugyldige checksums afvises.

| Grænse | Maksimum |
| --- | ---: |
| Komprimeret arkiv | 128 MiB |
| Udpakket indhold | 512 MiB |
| En enkelt fil | 128 MiB |
| `book-viewer.json` | 1 MiB |
| Entries/filer | 5.000 |
| En relativ sti | 240 tegn |
| Kompressionsforhold efter 8 MiB basisgrænse | 200:1 |

På den pinned Bun 1.3.14-runtime bliver gzip-data inspiceret med
`DecompressionStream("gzip")`. Tar-headerne læses chunkvist, og valideringen
afbrydes, før ekstraktion, når den laveste af den strukturelle maksimumgrænse
og ratio-grænsen nås. Bun dokumenterer ikke en outputgrænse på
`Bun.Archive.extract`; derfor foretager extraction en deterministisk anden
dekomprimering af de allerede preflightede bytes i stedet for at være den
første sikkerhedsgrænse.

`pack` skriver til en midlertidig fil, flytter atomisk på plads og validerer
det færdige arkiv. Outputfilen må ikke ligge inde i inputmappen.

## Maskinlæsbare resultater og stabile fejl

Med `--json` skriver CLI'en præcis ét JSON-dokument til stdout. Succes:

```json
{
  "ok": true,
  "command": "validate",
  "contract": { "name": "paged-book-annotator/book-bundle", "version": 1 },
  "sourceType": "archive",
  "book": { "id": "my-book", "title": "Min bog", "document": "book.html" },
  "validation": { "fileCount": 2, "warnings": [] }
}
```

Kontraktfejl giver exitkode `1` og en stabil `error.code`:

```json
{
  "ok": false,
  "error": {
    "code": "manifest_book_id_mismatch",
    "message": "Bundle tilhører other-book, ikke my-book.",
    "file": "book-viewer.json",
    "field": "book.id"
  }
}
```

Koder er programmets kontrakt; den danske `message` er diagnostik. Centrale
koder omfatter `manifest_schema_version_required`,
`manifest_schema_version_unsupported`, `manifest_book_id_mismatch`,
`manifest_field_unknown`, `document_contract_invalid`,
`active_file_forbidden`, `asset_missing`, `archive_not_gzip`,
`archive_wrapper_root`, `archive_entry_type_unsupported` og
`archive_checksum_invalid`.

## MCP

En MCP-klient kan læse de samme kilder før generering:

- `pba://contracts/book-bundle/v1` — dette normative dokument;
- `pba://schemas/book-viewer.bundle.v1.json` — JSON Schema 2020-12.

Uploadflowet er: læs kontrakt og schema, generér og kør lokal `validate`, kør
`pack`, opret upload med `create_book_upload`, HTTP `PUT` arkivet til den
returnerede URL, kald `validate_book_upload`, og publicér først derefter med
`publish_book_revision`. Binære bytes og base64 må ikke sendes som MCP-
argumenter.

## Legacy-import

Kun installationens migration af en eksisterende lokal `book.sourceDir`
bruger legacy-mode. Den accepterer et manglende `schemaVersion` som implicit
v1, ignorerer gamle procesfelter som `server`, `annotations`, `collaboration`
og `book.sourceDir`, og accepterer det historiske ikke-præpaginerede input.
Den rapporterer warnings og normaliserer til indholdsmanifestet.

Nye mapper valideret med CLI'en og alle `.tar.gz`-uploads er altid strikte.
Fremtidige schemaVersioner accepteres aldrig stiltiende. Runtime-, storage-,
adgangs- og annotationskonfiguration ejes af installationen og må ikke flyttes
ind i bundlen.
