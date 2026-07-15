# MCP

MCP-laget bruger den pinnede officielle TypeScript SDK 1.29.0 og den samme
service- og rettighedsgrænse som HTTP API'et. SDK 1.x er pr. 15. juli 2026
fortsat upstreams anbefalede produktionslinje. Projektet bruger SDK'ets
`ResourceTemplate`, Zod 4-skemaer og `WebStandardStreamableHTTPServerTransport`,
som er transporten upstream anbefaler til Bun.

Tool-annotations følger MCP's fire standardhints: `readOnlyHint`,
`destructiveHint`, `idempotentHint` og `openWorldHint`. De hjælper klienten med
at vise risiko, men er ikke autorisation. Alle grants håndhæves i servicen.

## Opret token

Åbn `/admin`, vælg **MCP-tokens**, markér en eller flere bøger og permissions,
og kopiér hemmeligheden, når den vises. Databasen gemmer kun dens hash. Et
instansadministrator-token oprettes med det særskilte valg og kan administrere
alle bøger, brugere og grants; kun en instansadministrator kan udstede det.

## Stdio og Streamable HTTP

Stdio startes som hidtil:

```sh
PBA_MCP_TOKEN='pba_...' bun mcp-stdio.mjs \
  --config /absolut/sti/til/book-viewer.json
```

HTTP bruger som standard stateless `POST /mcp` med JSON-respons og kræver:

```http
Authorization: Bearer pba_...
```

## Bogkontekst

Kald `list_books` først. Alle tools, der læser eller ændrer en bog, kræver et
eksplicit `bookId`. Ressourcer bruger disse URI'er:

```text
book://{bookId}/metadata
book://{bookId}/annotations
book://{bookId}/progress
```

Bibliotekstools omfatter `list_books`, `get_book`, `create_book`,
`list_book_revisions`, `archive_book` og publiceringsflowet nedenfor. De
eksisterende tekst-, søge-, annotations-, progressions-, invitations- og
adgangstools er tilsvarende bogspecifikke. Administrationen tilføjer
`list_book_members` samt opret/list/tilbagekald af adgangskoder.

## Bundle-upload

Binære bundles eller base64 må ikke placeres i MCP-argumenter. Brug dette flow:

1. `create_book_upload` med `bookId`, `.tar.gz`-filnavn, content type og
   eventuelt antal bytes.
2. Upload filen med HTTP `PUT` til det kortlivede `uploadUrl`, som tool'et
   returnerer.
3. Kald `validate_book_upload` med `uploadId`.
4. Kontrollér valideringsrapporten og kald `publish_book_revision` med den
   validerede `revisionId`.

Publicering skifter den aktive immutable revision atomisk. `archive_book`,
annotation deletion, replace-import, invitation/code/token revocation og
password reset er markeret destruktive. Oprettelse og upload-staging er
markeret additive; alle list/get/search/export-kald er read-only.

## Primære versionskilder

- MCP TypeScript SDK's officielle v1-kode og versionsnoter:
  <https://github.com/modelcontextprotocol/typescript-sdk>
- MCP tools og annotations i specifikationen:
  <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- Aktuel maintainervejledning om annotations:
  <https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/>
