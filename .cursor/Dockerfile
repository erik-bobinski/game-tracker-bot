FROM node:24-bookworm-slim

# Node 24 is required: @effect/sql-sqlite-node imports `backup` from node:sqlite,
# which only exists in Node 24+ (the bot crashes at boot on Node 22).
# git for the repo checkout; build-essential + python3 for pnpm's allowlisted
# native postinstall scripts (esbuild, msgpackr-extract); ca-certificates for
# the @railway/cli binary download during install.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git build-essential python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@11.16.0 --activate

USER node
