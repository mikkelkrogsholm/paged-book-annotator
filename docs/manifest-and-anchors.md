# Manifest- og anchor-kontrakt

Book Viewer er uafhængig af bogens generator. Integration kræver en JSON-
konfiguration og stabile attributter i det paginerede HTML-dokument.

## Konfiguration

```json
{
  "server": { "host": "127.0.0.1", "port": 4173 },
  "book": {
    "id": "my-book",
    "title": "Min bog",
    "subtitle": "Første korrektur",
    "mark": "M",
    "language": "da",
    "sourceDir": "../path/to/book",
    "document": "book-preview.html",
    "navigation": "navigation.xhtml",
    "paginationTimeoutMs": 120000
  },
  "access": { "preset": "privateReview" },
  "annotations": { "file": "../working/my-book.annotations.json" },
  "collaboration": { "database": "../working/my-book.collaboration.sqlite" }
}
```

Alle filstier fortolkes relativt til konfigurationsfilen. Serveren udstiller
ikke de lokale filstier til browseren.

`book.paginationTimeoutMs` er valgfri og er som standard 45 sekunder. Store
Paged.js-bøger kan hæve den op til 300 sekunder uden at ændre den generiske
viewer. Værdien er en ventetidsgrænse, ikke en fast forsinkelse; vieweren går
videre, så snart dokumentet melder pagineringen færdig.

`book.navigation` er valgfri. Når den er sat, skal filen opfylde den
EPUB-inspirerede navigationskontrakt i `docs/navigation.md`. Vieweren læser
hierarkiet, men opløser altid destinationerne mod de sider, Paged.js faktisk
har produceret.

## Bogdokumentet

Dokumentet skal være same-origin og enten:

- have Paged.js-sider i `.pagedjs_pages > .pagedjs_page` og sætte
  `data-paged-complete="true"` på `<html>`, når pagineringen er færdig; eller
- være præpagineret med samme klasser og sætte `data-pre-paginated="true"` på
  `<body>`.

## Alle elementer er annoterbare

Når Paged.js er færdig, giver vieweren hvert renderet HTML-element et
`data-viewer-anchor`. Det gælder både bogens indhold, umærkede dekorative
elementer og Paged.js' genererede sidehoveder, sidefødder og sidetal. Al synlig
tekst kan markeres; det mindste fælles HTML-element bliver tekstens scope.

Runtime-ankrene dannes deterministisk ud fra nærmeste stabile boganker,
elementets strukturelle sti og, for sidemargener, den semantiske position som
`top-left` eller `bottom-right`. De skrives kun i browserens paginerede kopi og
ændrer derfor ikke bogens kilde-HTML eller printlayout.

Et rent strukturelt runtime-anker kan flytte sig, hvis bogens DOM-struktur
ændres. Derfor bør betydningsfulde indholdskomponenter stadig have eksplicitte,
stabile bogankre. Tekstannotationer har desuden citat og kontekst som
genforankringsmekanisme.

## Eksplicitte bogankre

Et annoterbart element får et stabilt id:

```html
<p
  data-book-anchor="chapter-01.paragraph-03"
  data-book-label="Kapitel 1, afsnit 3"
  data-annotation-text
>
  Teksten, som læseren kan markere.
</p>
```

- `data-book-anchor` er den permanente identitet. Den må ikke indeholde et
  sidetal, fordi pagineringen kan ændre sig.
- `data-book-label` er en kort menneskelæsbar beskrivelse i kommentarlisten.
- `data-annotation-text` er et valgfrit integrationshint fra ældre versioner.
  Tekstmarkering er ikke længere begrænset til disse elementer.
- `data-book-page-label` kan stå på en overordnet sidekomponent og bruges som
  viewerens opslagstitel.

Elementannotationer kan målrette ethvert renderet HTML-element. Eksplicitte
`data-book-anchor`-værdier bevares som den kanoniske identitet; øvrige elementer
får et afledt runtime-anker. Tekstannotationer gemmer både scope-id, et eksakt
citat, 48 tegn før og efter samt den seneste kendte tekstposition. Hvis id'et
forsvinder, søger vieweren citatet i alle tekstbærende elementer og vælger det
mindste, mest specifikke sikre match. To reelt lige gode forekomster markeres
som uforankrede frem for at blive gættet fast.

## Annotationsdokument

Filen er almindelig JSON:

```json
{
  "schemaVersion": 3,
  "bookId": "my-book",
  "updatedAt": "2026-07-14T12:00:00.000Z",
  "annotations": [
    {
      "id": "annotation-...",
      "bookId": "my-book",
      "type": "text",
      "target": {
        "scopeId": "chapter-01.paragraph-03",
        "pageNumber": 12,
        "label": "Kapitel 1, afsnit 3",
        "selector": {
          "type": "TextQuoteSelector",
          "exact": "den markerede tekst",
          "prefix": "teksten før ",
          "suffix": " teksten efter",
          "position": { "start": 27, "end": 46 }
        }
      },
      "comment": "Gør denne passage mere konkret.",
      "status": "open",
      "category": "language",
      "anchorState": "attached",
      "visibility": "reviewGroup",
      "author": {
        "id": "user-...",
        "displayName": "Prøvelæser",
        "kind": "user"
      },
      "updatedBy": {
        "id": "user-...",
        "displayName": "Prøvelæser",
        "kind": "user"
      },
      "createdAt": "2026-07-14T12:00:00.000Z",
      "updatedAt": "2026-07-14T12:00:00.000Z"
    }
  ]
}
```

`pageNumber` er en nyttig, men afledt genvej. `scopeId` og tekstselector er de
egentlige genforankringsmekanismer. `visibility` kan være `private`,
`reviewGroup` eller `public`; adgangsprofilen sætter stadig den øvre grænse for,
hvilke annotationer en aktør kan hente. `category` er `general`, `language`,
`structure`, `fact` eller `design`; status er `open`, `resolved`, `accepted`
eller `rejected`. Eksisterende schema 1- og 2-filer migreres eksplicit til
schema 3, med den lokale ejer som forfatter for schema 1-data.
