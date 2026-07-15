# Paged Book Annotator

En local-first bogviser til paginerede HTML-bøger. Den viser enkeltsider eller
opslag og gør det muligt at knytte kommentarer til markeret tekst, konkrete
HTML-elementer og hele sider.

Viewermotoren er holdt adskilt fra den enkelte bog og kan flyttes til sit eget
repository. Server, fil-I/O og test kører på Bun. Den anbefalede kørsel er den
medfølgende Docker-container. Valg af open-source-licens er bevidst ikke
foretaget endnu.

Docker-imaget indeholder viewer, API, admin UI, MCP og selvhostede OFL-skrifter.
Kun `/data` mountes skrivbart. Bøger oprettes i admin UI eller MCP og uploades
som validerede `.tar.gz`-bundles; installationen kan have flere bøger og flere
immutable revisioner af hver bog uden at genbygge imaget.

## Funktioner

- tosidet opslag på brede skærme og enkeltsider på smalle skærme;
- bogagnostisk indholdsskuffe fra et EPUB-inspireret `navigation.xhtml`;
- søgning i hierarkiet, direkte fysisk sidevalg og en Paged.js-baseret sideskyder;
- tekstannotationer på al synlig tekst med citat, kontekst og positionsfallback;
- elementannotationer på alle renderede HTML-elementer, også Paged.js-sidehoveder og sidetal;
- side- og opslagsannotationer;
- automatisk genforankring og synlig status for uforankrede kommentarer;
- syv adgangsprofiler fra helt åben læsning til privat prøvelæsning;
- lokale konti, åben, lukket, invitations- eller kodebaseret tilmelding og flere administratorer;
- et flerbogsbibliotek med bogspecifikke medlemskaber, roller og token-grants;
- attribuerede annotationer med kategori, redaktionel triage, ejerskab, synlighed, moderation og JSON/CSV/Markdown-eksport;
- læseprogression, der skelner mellem seneste position, engagerede steder og eksplicit færdigmarkering, med fravalg og sletning;
- admin UI med Share Center, persistente adgangsprofiler, brugere, password-reset, invitationer, triage, tokens og audit;
- MCP over stdio og Streamable HTTP med scoped, udløbende og revokerbare tokens;
- struktureret, hemmelighedssikker driftslogging, request-id'er og healthcheck;
- atomisk lagring gennem en API, der kun lytter på localhost;
- en manifest- og anchor-kontrakt, som er uafhængig af bogens generator.

## Start eksempelbogen i Docker

Fra denne mappe:

```sh
docker compose up --build
```

Eksempelbogen åbnes på `http://127.0.0.1:4174/books/example-book`.
Administration findes på `http://127.0.0.1:4174/admin`.
Containerporten publiceres kun på værtens loopback-adresse. `./data/` er det
eneste bind mount. Ved første start importeres den medfølgende eksempelbog som
første katalogrevision; derefter administreres bøger og revisioner i UI'et.

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

Start et andet bibliotek med dets egen installationskonfiguration:

```sh
bun server.mjs --config /absolut/sti/til/book-viewer.config.json
```

Opret først en sikker standardkonfiguration direkte i en eksisterende bogmappe:

```sh
bun run init --book-dir /absolut/sti/til/bog --title "Min bog"
bun scripts/validate-book-document.mjs /absolut/sti/til/bog/book.html
```

Opret derefter en bog i `/admin`, upload et `.tar.gz`-bundle og publicér den
validerede revision. Det samme flow findes som MCP-tools.

## Integration

Se [book bundle-kontrakten](docs/book-bundle.md),
[navigationskontrakten](docs/navigation.md) og
[manifest- og anchor-kontrakten](docs/manifest-and-anchors.md). En bog er en
selvbærende mappe med et pagineret HTML-dokument, manifest og alle egne assets.
Vieweren ændrer ikke print-CSS eller den underliggende bog.

Serverens endpoints og sikkerhedsgrænse er beskrevet i
[Annotations-API](docs/annotations-api.md). Se også
[adgang, konti og admin](docs/access-and-admin.md), [MCP-laget](docs/mcp.md)
samt [tests og driftslogging](docs/logging-and-testing.md).

## Backup og restore

Den nuværende `bun run data`-kommando er kompatibilitetsværktøjet til det
tidligere enkeltbogsformat. For et administreret flerbogsbibliotek skal hele
`/data` sikkerhedskopieres konsistent, mens serveren er stoppet; her ligger
katalog, samarbejdsdatabase, annotationer og alle bogrevisioner.

Legacy-kommandoerne er:

```sh
bun run data backup --config /sti/til/book-viewer.json --out /sikker/sti/bog.pba-backup.json
bun run data verify --file /sikker/sti/bog.pba-backup.json
bun run data restore --config /sti/til/book-viewer.json --file /sikker/sti/bog.pba-backup.json --force
```

## Udvikling og kontrol

```sh
bun run check
bun run test:server:stability
bun run validate:example
bun run validate:bundle example/book
```

Kontrollen bruger `Bun.Transpiler` til syntaks og Buns indbyggede test-runner.
Serverens coverage-gate er 80 procent for lines og functions.
Docker-buildet kører kontrollerne inde i det fastlåste runtime-image.

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

Der sendes ikke e-mail, og der er ingen social login, realtidssamarbejde,
organisationer eller betaling. Invitationer og adgangskoder deles af
administratoren selv.
Serveren afviser fortsat ikke-lokale Host-headere; offentlig deling kræver en
TLS-reverse proxy, som sender en lokal upstream-Host, samt den offentlige origin
i `security.allowedOrigins`. GitHub-publicering, hosting og licensvalg foretages
separat.
