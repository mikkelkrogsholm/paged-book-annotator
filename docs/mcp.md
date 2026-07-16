# MCP-agentkontrakt V1

Dette dokument er startpunktet for en agent. Læs også den maskinlæsbare
`pba://contracts/mcp-tools/v1`: den indeholder kontrakten for **hvert** tool med
formål, krævede permissions, effekt, idempotens, top-level outputfelter,
eksempelargumenter, fejl og workflow. `tools/list` leverer desuden præcise
`inputSchema`- og `outputSchema`-felter samt samme kontrakt i
`_meta["pba/toolContract"]`.

Implementationen bruger den pinnede `@modelcontextprotocol/sdk` 1.29.0, Zod
4.4.3 og MCP's stabile tools-kontrakt. Annotations som `readOnlyHint` og
`destructiveHint` beskriver risiko; de giver aldrig adgang. Autorisation sker
igen i den fælles application service.

## Sikker startsekvens

1. Læs `pba://docs/mcp/v1` og `pba://contracts/mcp-tools/v1`.
2. Kald `list_books`; gæt aldrig et `bookId`. Hvis listen er tom, kan kun et
   instansadministrator-token fortsætte med `create_book`.
3. Efter `create_book`: kald `create_book_upload`, send bundlet til den returnerede
   HTTP `PUT`-URL, kald `validate_book_upload` og derefter
   `publish_book_revision`.
4. Kald `get_book_context` for den valgte bog og kontrollér capabilities.
5. Følg workflowet i toolkontrakten. Brug stabile id'er og ankre fra list/get
   tools; sidetal er kun hints.
6. Ved en domænefejl fra tool-handleren: læs `structuredContent.error.code`,
   `retryable`, `suggestedAction` og `requestId`. Gentag kun automatisk, når
   `retryable` er `true`. En inputfejl, som MCP SDK'et afviser før handleren,
   er derimod en protokol-/tekstfejl og har ikke nødvendigvis
   `structuredContent`.

Et succesfuldt tool returnerer både serialiseret JSON i `content` og det samme
objekt i `structuredContent`. En fejl, der opstår efter vellykket
inputvalidering inde i tool-handleren, returnerer:

```json
{
  "error": {
    "code": "invalid_input | forbidden | not_found | conflict | rate_limited | internal_error",
    "message": "Menneskeligt læsbar forklaring",
    "retryable": false,
    "suggestedAction": "Konkret næste handling",
    "requestId": "mcp-...",
    "causeCode": "valgfri domænekode"
  }
}
```

Fritekst fra annotationer og surveys logges aldrig. Logs indeholder kun
request-id, toolnavn, bog-id, principaltype, varighed og sikker fejlkode.

## Transport og token

Opret et token under `/admin` → **MCP-tokens**. Vælg et preset eller eksplicitte
permissions og boggrants. Hemmeligheden vises én gang; kun dens hash gemmes.
Et instansadministrator-token kan administrere alle bøger og brugere og kan kun
udstedes af en instansadministrator. Det kræver ingen eksisterende bog og er
derfor bootstrap-tokenet til en tom installation: det kan oprette den første bog,
starte bundle-uploaden, validere og publicere revisionen.

Stdio:

```sh
PBA_MCP_TOKEN='pba_...' bun mcp-stdio.mjs \
  --config /absolut/sti/til/book-viewer.config.json
```

Streamable HTTP er stateless på `POST /mcp` og kræver:

```http
Authorization: Bearer pba_...
```

Stdio-transporten eksponerer kun MCP over stdin/stdout; den starter ikke en
HTTP-server. Læse-, annotations-, survey- og administrationsværktøjer virker
over stdio. Tokenet slås op igen før hvert resource- og toolkald, så
tilbagekaldelse og udløb træder i kraft uden at stdio-processen genstartes.
Uploadmetadata gemmes atomisk i den konfigurerede datamappe. Derfor kan
`create_book_upload` og `validate_book_upload` kaldes over stdio, mens den rå
HTTP `PUT` sendes til PBA-serverens `uploadUrl`; processerne skal bruge samme
konfiguration og datamappe. Uploads udløber efter en time og validering
forbruger den persistente stagingpost.

## Ressourcer

| URI | Indhold |
| --- | --- |
| `pba://docs/mcp/v1` | Denne komplette agentguide |
| `pba://contracts/mcp-tools/v1` | Maskinlæsbare kontrakter for alle tools |
| `pba://contracts/admin-ui-mcp-parity/v1` | Komplet maskinlæsbar UI→MCP-paritetskontrakt |
| `pba://contracts/book-bundle/v1` | Normativ bundlekontrakt |
| `pba://schemas/book-viewer.bundle.v1.json` | Bundlemanifestets JSON Schema |
| `pba://schemas/survey.v1.json` | Immutable surveydefinition V1 |
| `pba://schemas/review-export.v1.json` | Samlet review-eksport V1 |
| `book://{bookId}/metadata` | Bogmetadata og effektive capabilities |
| `book://{bookId}/annotations` | Synlige annotationer |
| `book://{bookId}/progress` | Aktørens læseprogression |
| `book://{bookId}/surveys` | Aktive surveys for den publicerede revision |

## Komplet toolkatalog

Admin UI og MCP er to klienter af samme application service. Enhver vedvarende
handling i admin UI skal have en MCP-ækvivalent med samme autorisation og effekt.
UI-bekvemmeligheder som lokal filtrering, fokus og kopiering ændrer ingen data og
er derfor ikke selvstændige tools. Bundlebytes sendes til den kortlivede `PUT`-URL
fra `create_book_upload`; de placeres aldrig i MCP-argumenter.

Alle 51 tools nedenfor findes i `tools/list`; intet tool må registreres uden en
kontrakt og et outputskema. Permissionkolonnen viser minimumskravet. Nogle
handlinger kræver yderligere ejerskab eller permission, fx moderation af en
andens annotation og `progress:read:all` ved review-eksport med progression.

| Workflow | Tools | Minimumpermission |
| --- | --- | --- |
| Start | `list_books`, `get_book` | `books:read` |
| Bogoprettelse | `create_book` | instansadministrator |
| Upload | `create_book_upload`, `validate_book_upload` | `books:upload` |
| Revisioner | `list_book_revisions`, `publish_book_revision`, `archive_book` | hhv. `books:read`, `books:publish`, `books:settings` |
| Bogtekst | `get_book_context`, `list_book_outline`, `get_book_section`, `search_book` | `books:read` |
| Annotationskontekst | `get_annotation_context`, `list_changes_since` | `books:read` + `annotations:read` |
| Annotationer | `list_annotations`, `create_annotation`, `update_annotation`, `delete_annotation` | læs: `books:read` + `annotations:read`; opret: `books:read` + `annotations:write`; ændr/slet: `annotations:write` |
| Annotationdata | `export_annotations`, `import_annotations` | eksport: `books:read` + `annotations:read` + `annotations:export`; import: `annotations:moderate` |
| Læsning | `get_reading_progress`, `record_reading_progress`, `list_reader_progress` | `books:read` + `progress:read:self` / `progress:read:all` |
| Brugere | `list_users`, `list_book_members`, `create_user`, `update_user_access`, `reset_user_password` | `users:read`, `users:invite` eller `access:manage` |
| Adgang | `get_access_settings`, `update_access_settings` | `access:manage` |
| Invitationer | `create_invitation`, `list_invitations`, `revoke_invitation` | `users:invite` / `users:read` |
| Adgangskoder | `create_access_code`, `list_access_codes`, `revoke_access_code` | `users:invite` / `users:read` |
| Tokens | `create_service_token`, `list_service_tokens`, `revoke_service_token` | `tokens:manage` |
| Audit | `list_audit_events` | `audit:read` |
| Læsersurvey | `list_active_surveys`, `get_survey`, `get_my_survey_response`, `submit_survey_response` | `books:read` + `surveys:respond` |
| Surveyadmin | `list_surveys`, `create_survey`, `update_survey_draft`, `publish_survey`, `close_survey` | `surveys:manage` |
| Surveysvar | `list_survey_responses` | `surveys:responses:read` |
| Samlet eksport | `export_review_bundle` | `annotations:read:all` + `annotations:export` + `surveys:export`; plus `progress:read:all` når `includeProgress=true` |

### Betinget administration

- `create_user` og `reset_user_password` kræver instansadministrator.
  `bookRole` på `create_user` kræver samtidig `bookId`; `phone` kræver
  `phonePurpose`.
- `update_user_access` kræver mindst ét reelt ændringsfelt. Globale roller og
  kontostatus kræver instansadministrator. Bogrolle eller ekstra permissions
  kræver `bookId`, og en administrator kan aldrig delegere mere adgang end
  administratoren selv har.
- Samme delegationsgrænse gælder roller i invitationer og adgangskoder samt
  grants i service-tokens. `create_invitation` og `create_access_code` kan få
  en ekstra `permissions`-liste. `create_service_token.grants` er den
  kanoniske form for forskellige permissions per bog; hvert element er
  `{bookId, permissions}`. `bookIds` + `scopes` er kun en bekvemmelighedsform,
  der giver samme permissions til alle de angivne bøger.
- `list_users` og `list_service_tokens` uden `bookId` kræver
  instansadministrator. Med `bookId` håndhæves den bogspecifikke permission.
- `revoke_service_token` kan kaldes globalt af en instansadministrator. Andre
  administratorer skal sende `bookId`; `tokens:manage` kontrolleres i netop
  den bog.
- Angiv altid `bookId` til `list_audit_events`; uden feltet bruges kun den
  konfigurerede default-bog.

`update_access_settings` bruger de kanoniske policyfelter `preset`, `reading`,
`annotationCreate`, `annotationView`, `surveyResponse`, `registration`,
`progressTracking` og `localBypass`. Tilmeldingsfeltet hedder
`registration`—ikke `enrollment`. Et preset er obligatorisk; de øvrige felter
er eksplicitte overrides og valideres mod adgangspolitikkens enums.

### Resultatmængder

`list_book_outline`, `search_book` og `list_changes_since` har cursor og
`limit`; fortsæt til `nextCursor` er `null`. De øvrige list-tools returnerer
hele den autorisationsfiltrerede samling for installationen eller bogen og har
ingen skjult pagination. Filtrér `list_annotations` med status, kategori,
forfatter, side eller søgetekst. Store installationer bør indtil en senere
cursor-kontrakt undgå at hente globale lister uden et konkret `bookId`.

`list_changes_since` er en stabil keyset-feed. Et item er enten
`{type: "annotation.upsert", changedAt, annotation}` eller
`{type: "annotation.deleted", changedAt, annotationId}`. Almindelig
`annotations:read` ser kun upserts, som aktøren aktuelt må se. Slettetombstones
kan afsløre, at en skjult annotation har eksisteret, og returneres derfor kun
med `annotations:read:all` eller `annotations:moderate`. Gem `nextCursor`
uændret; rekonstruér aldrig en cursor ud fra timestamp eller id.

## Bundle-upload

Binære bytes eller base64 må ikke placeres i toolargumenter. MCP-kaldene i trin
4 og 6 kan bruge Streamable HTTP eller stdio. Den rå `PUT` i trin 5 går altid
til PBA HTTP-serveren, og alle involverede processer skal dele den
konfigurerede datamappe.

1. Læs bundlekontrakten og manifestskemaet.
2. Generér lokalt med `bun run bundle init`, validér med `bundle validate
   --json`, og pak med `bundle pack`.
3. Kald `create_book` hvis bogposten ikke findes.
4. Kald `create_book_upload` med `.tar.gz`-filnavn og content type.
5. Opløs det relative `uploadUrl` mod den kørende PBA HTTP-servers origin,
   og HTTP `PUT` filen dertil med samme `Authorization: Bearer pba_...` som
   MCP-kaldet.
6. Kald `validate_book_upload`; stop ved errors.
7. Kald `publish_book_revision` med den validerede `revisionId`.

Publicering skifter aktiv immutable revision atomisk. En survey bundet til en
tidligere revision bliver ikke plausibelt genforankret og vises derfor ikke for
den nye revision.

`validate_book_upload` forbruger den midlertidige upload, også når valideringen
fejler, og er derfor ikke idempotent. Opret en ny upload før et nyt forsøg.

## Annotation-input

`create_annotation` er en diskrimineret union på `type`:

- `page`: kræver både et stabilt `target.scopeId` og et `pageNumber`-hint.
- `element`: kræver stabilt `target.scopeId` og et `pageNumber`-hint.
- `text`: kræver samme stabile `scopeId` samt en
  `selector` af typen `TextQuoteSelector` med ikke-tom `exact`. Valgfri
  `position` skal have `start >= 0` og `end > start`.

`selector` accepteres ikke for page/element. Ved genforankring er sidetal kun
et hint; et mislykket eller tvetydigt match skal blive `anchorState: orphaned`.

`record_reading_progress` med `event: "engaged"` øger en besøgstæller og er
derfor heller ikke idempotent.

## Survey-workflows

### Besvar som læser eller bogagent

1. `list_active_surveys(bookId)`.
2. `get_survey(bookId, surveyId)` og læs den publicerede version, mål og alle
   spørgsmål.
3. `get_my_survey_response` før skrivning. Det gør ændringer eksplicitte.
4. `submit_survey_response` med højst ét typed svar per `questionId`. Kaldet er
   en upsert af aktørens ene svar for surveyversion + bogrevision.

### Administrér survey

1. `list_book_outline` og vælg et stabilt `anchorId`; brug aldrig sidetal alene.
2. Læs `pba://schemas/survey.v1.json`.
3. `create_survey` med 1–5 spørgsmål. V1 understøtter `rating` (altid 1–5 med
   kontekstlabels), `singleChoice`, `shortText` og `longText`.
4. `update_survey_draft` erstatter hele kladden. På en allerede publiceret
   survey oprettes en ny draft-version; den publicerede version muteres ikke.
5. `publish_survey` binder kladden til bogens aktive revision.
6. `list_survey_responses` til analyse; `close_survey` stopper nye ændringer,
   men bevarer svar til eksport.

## Review-eksport

`export_review_bundle` returnerer det kanoniske JSON-dokument
`paged-book-review-export` schemaVersion 1. Det indeholder bog/revision,
annotationer, alle surveyversioner, surveybesvarelser og—kun ved eksplicit
`includeProgress=true`—læseprogression. Definitionens spørgsmål og options
følger med, så svarene er selvforklarende. Navn/e-mail kopieres ikke ind i
behavioral svarrækker; svar henviser til en pseudonymiseret respondent og kan
kun beriges med displaynavn for en autoriseret administrator.

Legacy `export_annotations` bevares til eksisterende integrationer. Nye agenter
skal bruge `export_review_bundle`.

## Versionskilder

- Pinned runtime og libraries: `.bun-version` og `package.json`.
- MCP stable tools specification: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- MCP TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
- Bun live docs index: <https://bun.sh/llms.txt>
