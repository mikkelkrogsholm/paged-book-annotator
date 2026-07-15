# Book bundle-kontrakten

Book Viewer-imaget er generisk. Det administrerede setup bruger ét vedvarende
`/data`-mount. Bøger uploades via admin UI eller MCP og installeres under
`/data/library`. Det tidligere single-book setup med `/book` og `/data` kan
stadig importeres ved første start gennem installationskonfigurationens
`book.sourceDir`.

```text
/book  read-only  færdigt bog-bundle
/data  read-write annotationer og eksportdata
```

## Bundle-indhold

Et bundle er en selvbærende mappe. Roden skal indeholde `book-viewer.json` og
det dokument, manifestets `book.document` peger på. Hvis manifestet angiver
`book.navigation`, skal dette XHTML-dokument også ligge i bundlen. HTML, CSS, billeder,
skrifter og pagineringskode skal kunne indlæses fra bundle-mappen uden
netadgang eller adgang til værtens filsystem.

Bundlemanifestet beskriver kun bogens indhold og må ikke styre server eller
storage:

```json
{
  "schemaVersion": 1,
  "book": {
    "id": "my-book",
    "title": "Min bog",
    "document": "book.html",
    "navigation": "navigation.xhtml"
  }
}
```

Et bundle må ikke referere til `file:`, `node_modules`, eksterne URL'er eller
filer uden for bundle-mappen. Kontrollér det før start:

```sh
bun scripts/validate-book-bundle.mjs /absolut/sti/til/bundle
```

Bundlevalideringen kontrollerer navigationshierarkiet, alle lokale referencer
og at hvert navigationslink peger på et stabilt mål i bogdokumentet. Den afviser
også links, specialfiler og aktivt indhold.

Mappen pakkes som et `.tar.gz`-arkiv med manifestet i arkivets rod.
`book.sourceDir`, `annotations`, `collaboration`, `server` og andre procesfelter
ignoreres ved import af ældre bundles; storage og runtime-konfiguration ejes af
installationen. Se
[`managed-book-catalog.md`](managed-book-catalog.md).
