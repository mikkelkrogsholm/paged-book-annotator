# Adgang, konti og admin

Adgang konfigureres pr. bog med `access.preset`. Profilerne dækker de typiske
lokale, offentlige og prøvelæserbaserede forløb:

| Preset | Læsning | Opret annotation | Se annotationer | Oprettelse |
| --- | --- | --- | --- | --- |
| `local` | alle lokale kald | lokal ejer | alle | slået fra |
| `publicRead` | alle | ingen | ingen | slået fra |
| `publicOpenReview` | alle | alle gæster/brugere | alle | slået fra |
| `publicMemberReview` | alle | login | egne/offentlige | åben |
| `publicInviteReview` | alle | inviterede | egne/offentlige | invitation |
| `privateRead` | inviterede | ingen | ingen | invitation |
| `privateReview` | inviterede | inviterede | egne/offentlige | invitation |

Felterne `reading`, `annotationCreate`, `annotationView`, `registration`,
`progressTracking` og `localBypass` kan overskrives enkeltvis efter preset.
Serveren validerer kombinationen ved opstart. Eksempel:

```json
{
  "access": {
    "preset": "privateReview",
    "annotationView": "reviewGroup",
    "progressTracking": "analytics"
  },
  "collaboration": {
    "database": "../data/my-book.collaboration.sqlite"
  },
  "auth": {
    "sessionHours": 336,
    "invitationHours": 168
  }
}
```

`annotationView` kan være `none`, `own`, `reviewGroup` eller `public`.
`progressTracking` kan være `off`, `resume` eller `analytics`; både `resume`
og `analytics` gemmer seneste stabile anker og besøgte ankre, mens betegnelsen
gør formålet eksplicit i konfigurationen.

`registration` kan være `disabled`, `closed`, `open`, `inviteOnly` eller
`code`. Invitationer er bundet til e-mail og bog; adgangskoder kan have udløb
og maksimalt antal anvendelser. Begge tildeler en bogrolle ved accept.

Konfigurationens profil er standarden ved første opstart. En administrator kan
derefter ændre profilen i **Deling og adgang** i `/admin`; den validerede profil
gemmes i samarbejdsdatabasen og bruges straks af reader, HTTP og MCP. UI'et viser
de effektive felter før gemning og advarer, hvis `local` forsøges brugt som
delingsprofil.

## Administratorer

`/admin` viser brugere, globale roller, bogroller, invitationer, annotationer,
læseprogression, service-tokens og auditlog. En `instance_admin` administrerer
hele instansen; en `book_admin` har samme rettigheder for den konfigurerede bog.
Flere administratorer understøttes, og den sidste aktive instance-admin kan
ikke degraderes eller deaktiveres.

Den første administrator kan oprettes ved opstart uden at skrive password i
konfigurationsfilen:

```sh
PBA_ADMIN_EMAIL=admin@example.org \
PBA_ADMIN_NAME="Bogadministrator" \
PBA_ADMIN_PASSWORD='mindst-ti-tegn' \
bun server.mjs --config /sti/til/book-viewer.json
```

I `local`-profilen fungerer den lokale ejer allerede som administrator og kan
oprette de første konti i UI'et. Passwords hashes med Bun 1.3.14s verificerede
Argon2id-API. Session-, invitations- og service-token-secrets gemmes kun som
hashes. Invitations- og tokenhemmeligheder vises kun ved oprettelsen. En bruger
kan skifte eget password fra kontodialogen. Administratorer kan nulstille et
brugerpassword; begge handlinger lukker brugerens eksisterende sessioner.

## Roller og permissions

Bogrollerne er `reader`, `reviewer`, `editor`, `publisher` og `book_admin`.
`publisher` kan uploade og publicere revisioner uden brugeradministration;
`editor` kan moderere annotationer. Service-tokens bruger
finkornede scopes som `books:read`, `annotations:read`, `annotations:write`,
`progress:read:all`, `users:invite`, `tokens:manage` og `audit:read`. En aktør
kan aldrig delegere permissions, vedkommende ikke selv har.
Admin UI'et kan give et token samme permissions i én eller flere valgte bøger.
Et særskilt instansadministrator-token har alle rettigheder og kan blandt andet
oprette brugere og bøger; kun lokal ejer eller en `instance_admin` kan udstede
det.

Offentlige annotationer uden login tilskrives en vedvarende pseudonym gæste-id.
Brug `publicMemberReview` eller invitationsprofilerne, når en persons navn skal
følge annotationen.

Progress registrerer en seneste position hurtigt, men tæller først et sted som
engageret efter otte sekunder på opslaget. Et hop til sidste side er derfor ikke
det samme som at have læst bogen. Færdigstatus kræver en eksplicit handling.
Læseren kan slå tracking fra i kontodialogen; så slettes position og besøgte
steder for den bog.

Navn og e-mail er kontoens identitet. Telefon er valgfri og kræver et angivet
formål. Kontodialogen kan eksportere brugerens konto-, medlemskabs-, progress-
og annotationsdata. Ved sletning fjernes identitet, sessions, medlemskaber og
progress, mens forfatterfeltet på eksisterende annotationer pseudonymiseres, så
det redaktionelle spor ikke mister indhold.

## Offentlig deling

Direkte Bun-kørsel binder til loopback, Compose publicerer kun på værtens
loopback, og serveren afviser ikke-lokale Host-headere. Ved ekstern deling skal
en TLS-reverse proxy derfor:

1. være den eneste offentlige indgang;
2. proxye til loopback og omskrive upstream `Host` til `127.0.0.1` eller
   `localhost`;
3. sende browserens oprindelige `Origin`; og
4. have den præcise offentlige origin i `security.allowedOrigins`; og
5. sætte `security.secureCookies` til `true`.

```json
{
  "security": {
    "allowedOrigins": ["https://review.example.org"],
    "secureCookies": true
  }
}
```

Det bevarer den direkte lokale sikkerhedsgrænse. Viewerens `bun run data`
leverer checksum-verificeret backup/restore. Rate limiting, TLS, overvågning og
proxy-hardening hører fortsat til deployment-laget, fordi kun reverse proxyen
kender den reelle offentlige klientadresse.
