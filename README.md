# Paged Book Annotator

En local-first bogviser til paginerede HTML-bøger. Den viser enkeltsider eller
opslag og gør det muligt at knytte kommentarer til markeret tekst, konkrete
HTML-elementer og hele sider.

Viewermotoren er holdt adskilt fra den enkelte bog og kan flyttes til sit eget
repository. Server, fil-I/O og test kører på Bun. Den anbefalede kørsel er den
medfølgende Docker-container. Valg af open-source-licens er bevidst ikke
foretaget endnu.

Docker-imaget er generisk og bygges aldrig til en bestemt bog. Det indeholder
viewerens UI, API og selvhostede OFL-skrifter. En færdig, selvbærende bogmappe
mountes read-only som `/book`; annotationer og eksportdata mountes read-write
som `/data`. Derfor kan man skifte bog uden at genbygge viewer-imaget.

## Funktioner

- tosidet opslag på brede skærme og enkeltsider på smalle skærme;
- bogagnostisk indholdsskuffe fra et EPUB-inspireret `navigation.xhtml`;
- søgning i hierarkiet, direkte fysisk sidevalg og en Paged.js-baseret sideskyder;
- tekstannotationer på al synlig tekst med citat, kontekst og positionsfallback;
- elementannotationer på alle renderede HTML-elementer, også Paged.js-sidehoveder og sidetal;
- side- og opslagsannotationer;
- automatisk genforankring og synlig status for uforankrede kommentarer;
- opret, redigér, løs, genåbn, slet og filtrér;
- JSON-import og -eksport;
- atomisk lagring gennem en API, der kun lytter på localhost;
- en manifest- og anchor-kontrakt, som er uafhængig af bogens generator.

## Start eksempelbogen i Docker

Fra denne mappe:

```sh
docker compose up --build
```

Eksempelbogen åbnes på `http://127.0.0.1:4174/preview.html`.
Containerporten publiceres kun på værtens loopback-adresse. Eksempelbundlet
`./example/book/` mountes read-only, mens `./data/` er det eneste skrivbare
bind mount.

Stop igen med:

```sh
docker compose down
```

## Start direkte med Bun

Hvis Bun er installeret lokalt:

```sh
bun run start
```

## Brug

1. Markér tekst i bogen. Vælg **Kommentér markering** og skriv kommentaren.
2. Vælg **Element** i bundlinjen, og klik derefter på det element, som
   kommentaren handler om.
3. Vælg **Side** for en generel kommentar til det aktuelle opslag.
4. Åbn **Kommentarer** øverst til højre for at navigere, redigere, løse eller
   eksportere arbejdet.
5. Åbn **Indhold**, klik på den aktuelle position eller tryk `G` for at søge i
   bogens struktur eller gå direkte til en fysisk Paged.js-side.

Start en anden bog direkte med dens egen konfigurationsfil:

```sh
bun server.mjs --config /absolut/sti/til/book-viewer.config.json
```

Til Docker leveres konfigurationen som `book-viewer.json` i roden af det
mountede bundle. Se `compose.yaml` og `example/book/book-viewer.json`.

## Integration

Se [book bundle-kontrakten](docs/book-bundle.md),
[navigationskontrakten](docs/navigation.md) og
[manifest- og anchor-kontrakten](docs/manifest-and-anchors.md). En bog er en
selvbærende mappe med et pagineret HTML-dokument, manifest og alle egne assets.
Vieweren ændrer ikke print-CSS eller den underliggende bog.

Serverens endpoints og sikkerhedsgrænse er beskrevet i
[Annotations-API](docs/annotations-api.md).

## Udvikling og kontrol

```sh
bun run check
bun run validate:example
bun run validate:bundle example/book
```

Kontrollen bruger `Bun.Transpiler` til syntaks og Buns indbyggede test-runner.
Docker-buildet kører begge kontroller inde i det fastlåste runtime-image.

## Bun-version

Projektet er fastlåst til Bun 1.3.14 i `.bun-version`, `package.json` og
`Dockerfile`. Konsistensen kontrolleres af `bun run check`. Når en ny stabil
version er verificeret på Buns officielle release-side, opdateres alle tre
steder samlet:

```sh
bun run runtime:set 1.3.15
bun run check
docker compose build --pull
```

Den anvendte Bun-runtime fremgår også af `/api/config`.

## Bevidste afgrænsninger

Denne version har ingen brugerkonti, cloud-sync eller samtidig redigering.
Serveren er et lokalt redaktionelt værktøj og afviser ikke-lokale Host-headere.
GitHub-publicering og licensvalg foretages separat.
