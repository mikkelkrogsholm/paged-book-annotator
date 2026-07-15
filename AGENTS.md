# Agent guide for Paged Book Annotator

This directory is designed to become a standalone repository. Keep the viewer
generic: book-specific text, styles and build steps belong in the configured
book directory, not here.

## Architecture

- `server.mjs` is the localhost-only HTTP and JSON API boundary.
- `src/server/annotation-repository.mjs` owns validation and atomic storage.
- `public/reader/book-reader.js` owns pagination display and navigation.
- `public/annotations/` owns annotation anchoring, API calls and UI behavior.
- `example/book/` is the canonical integration fixture.
- `docs/manifest-and-anchors.md` is the public book integration contract.

Prefer explicit imports and feature-local tests. Do not add a frontend build
tool or runtime dependency unless the feature cannot reasonably be built with
the platform APIs already in use.

## Verification

Run before finishing a change:

```sh
bun run check
bun run validate:example
```

For an integrated book, also run:

```sh
bun scripts/validate-book-document.mjs /absolute/path/to/book.html
```

## Invariants

- Direct Bun runs bind to localhost. Docker binds inside the container, but
  Compose publishes the port only on host loopback. Non-local Host headers are
  rejected in both modes.
- Annotation writes are atomic.
- Schema changes require an explicit `schemaVersion` migration.
- `data-book-anchor` values are stable identities and must be unique.
- Page numbers are hints, never the only annotation anchor.
- Failed or ambiguous reattachment produces `anchorState: orphaned`; never
  attach a note to a merely plausible target.
- Viewer screen styles must not alter the book's print stylesheet.
