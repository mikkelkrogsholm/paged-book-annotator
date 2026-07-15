# Tests og driftslogging

Serveren skriver strukturerede driftslogs uden runtime-afhængigheder. De er
adskilt fra den persistente auditlog: driftslogs beskriver requests og
processens livscyklus, mens auditloggen fortsat beskriver bruger- og
tokenhandlinger, der ændrer forretningsdata.

## Konfiguration

`logging.level` kan være `debug`, `info`, `warn`, `error` eller `silent`.
`logging.format` kan være `json` eller `pretty`. Miljøvariablerne
`PBA_LOG_LEVEL` og `PBA_LOG_FORMAT` tilsidesætter filkonfigurationen. JSON er
det anbefalede containerformat; `pretty` er bekvemt ved direkte lokal kørsel.

```json
{
  "logging": {
    "level": "info",
    "format": "json"
  }
}
```

HTTP-svar indeholder `X-Request-Id`. En indgående UUID-værdi genbruges;
andre værdier erstattes, så fritekst eller credentials ikke kan injiceres i
loggen. Hvert HTTP-request får præcis én `request.completed`-record med
request-id, method, normaliseret path, resolved bog-id eller `null`, status,
varighed og principaltype. Dynamiske bog-, upload-, revisions-, bruger- og
annotation-id'er indgår derfor ikke i path-feltet. Fejl får desuden
`request.failed` med samme request-id og kontekst. MCP-værktøjer og resources
får tilsvarende præcis én `mcp.completed` og ved fejl en ekstra `mcp.failed`;
`operation` er det stabile tool- eller resource-navn, og bogspecifikke kald
bærer `bookId`.

Loggeren modtager aldrig request-body, cookies, headers eller query-parametre.
Feltredaktionen fjerner rekursivt passwords, bearer/service/session/
invitation-secrets, cookies, API keys og direkte identitetsfelter som navn,
e-mail og telefon før serialisering. E-mailadresser scrubbes også i fritekst.
Strings begrænses som standard til 4.096 tegn og arrays/objekter til 100
payload-felter plus en truncation-markør, så attacker-kontrollerede værdier ikke
kan skabe ubegrænsede records. Stack traces er slået fra som standard.
`tokenId` og token-prefix er metadata og må gerne logges; plaintext-tokenet må
ikke. Fejl i sink, clock eller serialisering må aldrig afbryde requestet.

Livscyklusrecords er `server.started`, `server.stopping`, `server.stopped` og
`server.fetch_error`; stdio-MCP bruger de tilsvarende `mcp.*`-records på
stderr, så protokollens stdout ikke forurenes.

## Health

`GET /api/health` kræver ikke login og returnerer kun ikke-følsom status:
bog-id, Bun-version, schema-versioner og SQLite-readiness. Dockerens healthcheck
bruger dette endpoint.

## Testmål og kommandoer

Serverpakken har en samlet coverage-gate på 85 procent for functions og 90
procent for lines, som er de to mål Bun 1.3.14 viser i sin tekst-rapport. Et
lille Bun-script håndhæver eksplicit `All files`-rækken, fordi den fastlåste
runtime ellers håndhæver `bunfig.toml`-tærskler på enkeltfiler. Testene bruger
injicerbare ure, id-generatorer og log-sinks, så
udløb, varigheder og korrelation er reproducerbare.

```sh
bun run test:server
bun run test:server:stability
bun run check
bun run validate:example
```

`test:server` dækker adgangsmatricen, auth/session/invitation, token-scopes,
udløb og revokering, adminbeskyttelse, annotationmigration og -synlighed,
stabile progress-ankre, MCP-autorisation, health samt logkorrelation og
redaktion. Integrationsprøverne kræver auditspor for bundle-validering og
publicering, adgangsændringer, access codes, annotationer, token create/revoke
og GDPR-sletning. Stabilitetskommandoen randomiserer rækkefølgen med et fast
seed og kører hver test tre gange uden retry.

Målet omfatter lokal, struktureret logging og de persistente auditbeviser. Det
omfatter ikke ekstern telemetry, collector-infrastruktur, alarmering, loadtest
eller hosted CI; de kan lægges ovenpå uden at ændre logkontrakten.
