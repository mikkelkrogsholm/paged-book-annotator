# HTTP- og annotations-API

API'et er same-origin og udstilles af Book Viewer-serveren. Svar er JSON,
bortset fra statiske filer, eksport og MCP. Den centrale adgangspolitik
filtrerer både UI-, API- og MCP-resultater.

## Offentlige og sessionsbaserede endpoints

- `GET /api/config` — bogidentitet, adgangsprofil, aktuel principal og
  capabilities uden lokale filstier.
- `GET /api/health` — uautentificeret, ikke-følsom runtime-, schema- og
  storage-readiness til lokal drift og Docker.
- `GET /api/session` — aktuel principal og capabilities.
- `POST /api/auth/login`, `/logout` og `/register` — cookie-sessioner;
  registrering følger adgangsprofilen.
- `POST /api/auth/invitations/accept` — accepterer en engangsinvitation og
  opretter en session.
- `POST /api/auth/password` — skifter eget password, lukker alle sessioner og
  kræver nyt login.
- `GET /api/annotations` — kun annotationer, aktøren må se.
- `POST /api/annotations` — opretter og attribuerer en annotation.
- `PUT|DELETE /api/annotations/:id` — ejeren eller en moderator kan ændre.
- `GET /api/annotations/export?format=json|csv|markdown` — filtreret eksport.
- `POST /api/annotations/import` — kræver moderationspermission.
- `GET|PUT /api/progress` — aktørens stabile læseanker, sidehint og besøgte
  ankre.
- `GET|PUT /api/progress/preferences` — læserens trackingvalg; fravalg sletter
  gemt progress og besøg.
- `GET /api/surveys` og `GET /api/surveys/:id` — aktive surveys for bogens
  publicerede revision.
- `GET|PUT /api/surveys/:id/response` — læserens ene versionerede svar.
- I managed multi-book-mode ligger de samme reader-ruter under
  `/api/books/:bookId/*`.

JSON-requests er begrænset til 1 MB.

En annotation må højst have 16.384 tegn i kommentaren, 65.536 i det eksakte
tekstcitat, 2.048 i hver selector-kontekst, 512 i scope/label, 256 i id'er og
200 i visningsnavne. En bog kan højst have 10.000 annotationer og et samlet
annotationsdokument på 32 MiB. Offentlige mutationer har desuden en
IP-baseret minutgrænse; login- og registreringskald har en strammere grænse.

## Admin-endpoints

`/api/admin/*` kræver de relevante permissions. Endpoints dækker metadata og
overblik, brugere/roller/status, invitationer, service-tokens, alle
annotationer, alle læseres progression og auditlog. Secrets returneres kun fra
det kald, der opretter invitationen eller tokenet.
`PUT /api/admin/access` gemmer en valideret adgangsprofil, og
`PUT /api/admin/users/:id/password` nulstiller et password og lukker sessioner.
Surveyadministration bruger `GET|POST /api/admin/surveys`,
`PUT /api/admin/surveys/:id`, `POST /api/admin/surveys/:id/publish|close`,
`GET /api/admin/survey-responses` og `GET /api/admin/review-export`. I managed
mode indsættes `/books/:bookId` efter `/api/admin`.

## Import og schemaVersion

Annotationsdokumentet bruger schema 4. Schema 1, 2 og 3 migreres eksplicit og
atomisk til schema 4 ved første læsning eller import. Schema 3 tilføjede
`category` og udfaldene `accepted`/`rejected`; schema 4 binder hver annotation
til en `revisionId`. Ukendte fremtidige schemas
afvises.

```json
{
  "mode": "merge",
  "document": {
    "schemaVersion": 4,
    "bookId": "my-book",
    "updatedAt": "2026-07-15T12:00:00.000Z",
    "annotations": []
  }
}
```

`mode` kan være `merge` eller `replace`. En anden bog afvises.

## Sikkerhedsmodel

Serveren:

- binder som standard til `127.0.0.1`;
- binder til `0.0.0.0` i Docker, mens Compose kun publicerer på værtens
  `127.0.0.1`;
- afviser ikke-lokale Host-headere;
- accepterer kun requestens præcise origin eller den eksplicitte
  `security.allowedOrigins`-liste;
- bruger HttpOnly, SameSite=Lax sessionscookies;
- hasher passwords med Argon2id og session/invitation/token-secrets før
  lagring;
- validerer tokenets bog, scopes, udløb og revokering;
- validerer alle annotationsfelter; og
- skriver annotations-JSON via midlertidig fil og atomisk rename.

SQLite-databasen bruger foreign keys, WAL og eksplicit `user_version`.
Service-tokens kan sendes som `Authorization: Bearer ...` til HTTP-API'et og er
påkrævede for Streamable HTTP MCP.
