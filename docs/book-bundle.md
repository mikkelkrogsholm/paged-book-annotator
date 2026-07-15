# Book bundle-kontrakten

Book Viewer-imaget er generisk og indeholder aldrig en konkret bog. Det
oprindelige single-book setup forventer to mounts:

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

Manifestet bruger containerens stabile mountpunkter:

```json
{
  "server": { "host": "0.0.0.0", "port": 4173 },
  "book": {
    "id": "my-book",
    "title": "Min bog",
    "sourceDir": "/book",
    "document": "book.html",
    "navigation": "navigation.xhtml"
  },
  "annotations": { "file": "/data/my-book.annotations.json" }
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

I et administreret multi-book setup importeres denne mappe eller uploades som
et `.tar.gz`-arkiv. `book.sourceDir`, `annotations`, `collaboration`, `server` og
andre procesfelter bruges ikke som en del af det normaliserede indholdsmanifest;
storage og runtime-konfiguration ejes af installationen. Se
[`managed-book-catalog.md`](managed-book-catalog.md).
