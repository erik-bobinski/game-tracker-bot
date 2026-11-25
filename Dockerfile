# Railpack doesn't detect Bun, so Railway builds this instead. Keep both tags in
# step with packageManager in package.json.

# The website is built with its dev dependencies, which stay out of the image.
FROM oven/bun:1.4.4-slim AS site
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM oven/bun:1.4.4-slim
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production

COPY . .
COPY --from=site /app/web/dist ./web/dist
CMD ["bun", "start"]
