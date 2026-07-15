# Annotations-API

API'en er same-origin og udstilles kun af den lokale Book Viewer-server.
Alle svar er JSON, bortset fra bogens og viewerens statiske filer.

## Endpoints

### `GET /api/config`

Returnerer den offentlige bogidentitet, dokumentets URL og de aktiverede
funktioner. Lokale filstier returneres aldrig.

### `GET /api/annotations`

Returnerer hele annotationsdokumentet.

### `POST /api/annotations`

Opretter en annotation. Serveren tildeler `id`, `bookId`, `createdAt` og
`updatedAt`.

### `PUT /api/annotations/:id`

Opdaterer kommentar, status, ankertilstand eller mål. Opdateringen valideres
som en fuld annotation efter sammenfletning med den eksisterende post.

### `DELETE /api/annotations/:id`

Sletter én annotation.

### `GET /api/annotations/export`

Returnerer annotationsdokumentet med en download-filheader.

### `POST /api/annotations/import`

Modtager:

```json
{
  "mode": "merge",
  "document": {
    "schemaVersion": 1,
    "bookId": "my-book",
    "updatedAt": "2026-07-14T12:00:00.000Z",
    "annotations": []
  }
}
```

`mode` kan være `merge` eller `replace`. Import af en anden bog eller et andet
schema afvises.

## Sikkerhedsmodel

Serveren er et lokalt redaktionelt værktøj. Den:

- binder som standard til `127.0.0.1`;
- binder til `0.0.0.0` inde i Docker-containeren, mens Compose kun publicerer
  porten på værtens `127.0.0.1`;
- afviser Host-headere, der ikke er localhost;
- har ingen CORS-tilladelse;
- begrænser JSON-requests til 1 MB;
- validerer alle skrevne annotationsfelter;
- skriver gennem en midlertidig fil og atomisk rename.

Den er ikke en flerbrugerserver og bør ikke eksponeres gennem en offentlig
reverse proxy uden en ny autentifikations- og rettighedsmodel.
