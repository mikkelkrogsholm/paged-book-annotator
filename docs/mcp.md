# MCP

MCP-laget bruger den officielle TypeScript SDK 1.29.0 og samme
`BookCollaboration` som web-API og admin UI. Derfor gælder tokenets scopes,
bogbinding, udløb, revokering, attribution og audit ens på alle grænser.

## Opret token

Åbn `/admin`, vælg **MCP-tokens**, markér de nødvendige permissions og kopiér
hemmeligheden, når den vises. Databasen gemmer kun dens SHA-256-hash. Et
admin-token kan blandt andet få `users:read`, `users:invite`, `access:manage`,
`tokens:manage`, `progress:read:all` og `audit:read`.

## Stdio

```sh
PBA_MCP_TOKEN='pba_...' bun mcp-stdio.mjs \
  --config /absolut/sti/til/book-viewer.json
```

En MCP-klient kan bruge `bun` som command og ovenstående fil, `--config` og
konfigurationsstien som args. Tokenet sættes som miljøvariabel og bør ikke
skrives i repository-filer.

## Streamable HTTP

Endpointet er som standard `POST /mcp` og bruger stateless Streamable HTTP med
JSON-respons. Alle kald kræver:

```http
Authorization: Bearer pba_...
```

Endpointet kan ændres eller slås fra med:

```json
{ "mcp": { "enabled": true, "endpoint": "/mcp" } }
```

Transporten har ingen separat rettighedsmodel. Bearer-tokenet valideres før
MCP-initialisering, og hvert tool kalder derefter den centrale service.

## Ressourcer og tools

Ressourcerne udstiller bogmetadata, synlige annotationer og aktørens egen
læseprogression. Bogtekst læses fra de stabile `data-book-anchor`-elementer;
sidehints bruges ikke som tekstidentitet. Tools omfatter:

- bogkontekst, cursor-pagineret outline, sektionstekst og bogsøgning;
- filtreret annotationslæsning, annotationens aktuelle tekstkontekst og et
  cursor-pagineret ændringsfeed siden et ISO-tidspunkt;
- opret, opdatér, slet og eksportér annotationer;
- læs og gem progression samt administrativt læseroverblik;
- list/opret brugere, opdatér adgang og nulstil passwords;
- læs og skift den persistente adgangsprofil med lockout-beskyttelse;
- opret/list invitationer;
- opret/list/revokér service-tokens; og
- læs auditlog.

Tools uden de nødvendige scopes returnerer en autorisationsfejl. Annotationer
oprettet af en agent tilskrives tokenet eller tokenets valgfrie `actorUserId`.
