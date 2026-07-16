# Surveys og review-eksport V1

Surveys er et selvstændigt domæne, ikke en annotationstype. Det giver immutable
publicerede versioner, krævede spørgsmål, typed svar og præcis aggregering uden
at ændre den eksisterende annotationskontrakt.

## Livscyklus og mål

- En ny survey starter som `draft` version 1.
- `published` fryser definitionen og binder den til bogens aktive `revisionId`.
- Redigering efter publicering skaber en ny kladde; den publicerede version og
  dens svar ændres ikke.
- `closed` afviser nye og ændrede svar, men bevarer historik og eksport.
- Målet er `page` eller `section` med et stabilt `data-book-anchor`.
  `pageNumberHint` er kun et visningshint. Manglende ankre på en ny revision
  genvedhæftes aldrig til et blot plausibelt mål.

V1 har 1–5 spørgsmål af typen contextual 1–5 `rating`, `singleChoice`,
`shortText` eller `longText`. NPS, matrixer, branching, randomisering,
obligatoriske blokader og cross-book surveys er bevidst ude af scope.

## Svar og privatliv

Der findes højst ét redigerbart svar per respondent, surveyversion og
bogrevision. Svar gemmer en pseudonymiseret respondentreference og valgfri
intern user-id; navn, e-mail og telefon kopieres ikke til behavioral tabeller.
Ved account erasure slettes brugerens surveybesvarelser, inklusive fritekst, så
de ikke kan genhenføres via en deterministisk reference eller selve svaret.
Logs indeholder survey-id, version og antal—aldrig spørgsmålssvar eller
fritekst. “Senere” og “spring over” gemmes kun i browserens session og skaber
ingen skjult impression/dismissal-analytics.

## Eksport

Admin UI og MCP kan oprette `review-export.v1.json`, som validerer mod
`schemas/pba-review-export.v1.schema.json`. Dokumentet holder domænerne adskilt:

```text
book
annotations.items
surveys
surveyResponses
readingProgress { included, items }
```

Progression medtages kun efter eksplicit valg og kræver
`progress:read:all`. Eksisterende JSON/CSV/Markdown-annotationseksport bevares.
