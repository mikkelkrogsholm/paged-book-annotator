ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}-alpine AS viewer-builder

LABEL org.opencontainers.image.title="Paged Book Annotator"
LABEL org.opencontainers.image.description="Local-first annotations for paged HTML books"

WORKDIR /app

COPY --chown=bun:bun package.json bun.lock .bun-version ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun . .

RUN bun run assets && bun run check && bun run validate:example && bun run validate:bundle example/book

FROM oven/bun:${BUN_VERSION}-alpine

LABEL org.opencontainers.image.title="Paged Book Annotator"
LABEL org.opencontainers.image.description="Self-contained local multi-book review and annotation platform"

WORKDIR /app

COPY --from=viewer-builder --chown=bun:bun /app /app

# An empty named volume inherits the mount point's ownership. Keep the runtime
# non-root while still allowing a first boot to create the catalog in /data.
RUN mkdir -p /data && chown bun:bun /data

ENV BUN_ENV=production \
    PBA_DATA_DIR=/data

USER bun

EXPOSE 4173

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:4173/api/health'); if (!response.ok) process.exit(1)"]

ENTRYPOINT ["bun", "server.mjs"]
CMD ["--config", "/app/book-viewer.config.example.json", "--host", "0.0.0.0", "--port", "4173"]
