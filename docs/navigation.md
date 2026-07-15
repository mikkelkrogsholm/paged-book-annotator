# Bogagnostisk navigation

Book Viewer kan læse en EPUB-inspireret indholdsfortegnelse direkte fra den
monterede bogbundle. Navigationslaget ændrer aldrig bogens layout. Det hjælper
kun læseren med at finde et stabilt mål i det færdige Paged.js-output.

## Manifest

Bogmanifestet peger på navigationsdokumentet relativt til `book.sourceDir`:

```json
{
  "book": {
    "document": "book.html",
    "navigation": "navigation.xhtml"
  }
}
```

Feltet er valgfrit af hensyn til ældre og helt lineære bøger. Når det mangler,
forbliver almindelig side- og opslagsnavigation tilgængelig.

## XHTML-kontrakt

Dokumentet er gyldigt XHTML og bruger EPUB-namespacet:

```xhtml
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      lang="da">
<body>
  <nav epub:type="toc">
    <h1>Indhold</h1>
    <ol>
      <li>
        <a href="book.html#part-1">Første del</a>
        <ol>
          <li><a href="book.html#chapter-1">Kapitel 1</a></li>
        </ol>
      </li>
    </ol>
  </nav>
  <nav epub:type="landmarks" hidden="hidden">
    <ol>
      <li><a epub:type="cover" href="book.html#cover">Forside</a></li>
    </ol>
  </nav>
</body>
</html>
```

Kontrakten understøtter vilkårlig dybde. Et `li` bruger enten et `a` med en
destination eller et `span` som ren gruppeoverskrift. Labels skal være korte,
læsbare tekster. Hvert link skal pege på manifestets bogdokument og et stabilt
fragment, der findes som `id` eller `data-book-anchor`.

`toc` og `landmarks` er obligatoriske, når en bog leverer navigation. Den
første bliver viewerens hierarkiske indholdsskuffe; den anden bliver hurtige
destinationer. Kontrakten er en bevidst lille delmængde af EPUB 3 og gør ikke
Book Viewer til en fuld EPUB-reading system.

## Paged.js er autoritativ

Vieweren henter først bogdokumentet og venter på:

```text
.pagedjs_pages > .pagedjs_page
```

Derefter finder den hvert navigationsmål i den paginerede DOM og aflæser den
fysiske `.pagedjs_page`, som målet er endt på. Sidetal gemmes ikke som sandhed
i navigationsdokumentet, fordi tilføjet tekst, typografi eller indholdssider
kan flytte dem.

Indholdsskuffens sidetal, direkte sidevalg og sideskyderen bruger alle dette
runtime-genererede sidekort. Den viste bog er fortsat de samme Paged.js-sider,
som anvendes til PDF og tryk.

## Trykt indholdsfortegnelse

Bogbyggeren kan bruge samme logiske navigation til at generere synlige
indholdssider i bogens HTML. Paged.js kan udfylde destinationssidetal med CSS
Generated Content for Paged Media:

```css
.contents-link::after {
  content: target-counter(attr(href), page);
}
```

Dermed kommer den trykte indholdsfortegnelse og viewerens skuffe fra samme
struktur, mens de fysiske sidetal stadig bestemmes af den endelige paginering.

## Kontrol

```sh
bun scripts/validate-navigation-document.mjs navigation.xhtml book.html
bun scripts/validate-book-bundle.mjs /sti/til/bundle
```

Den neutrale fixture i `example/book/` bruger strukturen `Del → Kapitel` og
beviser, at vieweren ikke afhænger af Hávamál, versnumre eller en bestemt
boggenerator.
