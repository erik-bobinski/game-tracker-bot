# Railpack doesn't detect Bun, so Railway builds this instead. Keep the tag in
# step with packageManager in package.json.
FROM oven/bun:1.4.4-slim
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production

COPY . .
CMD ["bun", "start"]
