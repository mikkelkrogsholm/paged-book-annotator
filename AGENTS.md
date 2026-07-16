# Agent guide for Paged Book Annotator

This directory is designed to become a standalone repository. Keep the viewer
generic: book-specific text, styles and build steps belong in the configured
book directory, not here.

## Architecture

- `server.mjs` is the localhost-only HTTP and JSON API boundary.
- `src/server/annotation-repository.mjs` owns validation and atomic storage.
- `public/reader/book-reader.js` owns pagination display and navigation.
- `public/annotations/` owns annotation anchoring, API calls and UI behavior.
- `example/minimal-book/` is the canonical minimum bundle fixture.
- `example/book/` is the canonical complete integration fixture.
- `docs/book-bundle.md` and `schemas/book-viewer.bundle.v1.schema.json` are the
  normative bundle contract and machine-readable manifest contract.
- `docs/manifest-and-anchors.md` owns detailed anchoring behavior.

Prefer explicit imports and feature-local tests. Do not add a frontend build
tool or runtime dependency unless the feature cannot reasonably be built with
the platform APIs already in use.

## Documentation and version discipline

Do not assume that model knowledge about Bun, Paged.js, MCP or any other
fast-moving platform, runtime, framework, library, protocol or tool is current.
Before designing or implementing behavior that depends on an API, CLI flag,
configuration format, compatibility guarantee or platform capability:

- inspect the versions pinned by this repository and the versions actually
  used by the relevant runtime and deployment;
- consult current primary sources such as the official documentation,
  specification, changelog and upstream repository;
- verify that a capability documented for the latest release also exists in
  the repository's pinned version before relying on it; and
- cite or record the version-sensitive assumption in the change summary when
  it materially affects the implementation.

For Bun, start with the live official documentation index at
`https://bun.sh/llms.txt` and treat `.bun-version`, `package.json` and the
Docker image pin as the authority for the version this repository must support.
Prefer verified platform APIs over new dependencies, but never introduce or
replace an API solely from memory.

## Verification

Run before finishing a change:

```sh
bun run check
bun run validate:example
bun test scripts/pba-bundle.test.mjs
```

For new or generated bundles, use `bun run bundle init`, `validate --json` and
`pack`; do not hand-roll upload archives. New bundles and uploads are strict
v1. Only migration from an existing configured `book.sourceDir` uses the
documented legacy compatibility mode.

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
