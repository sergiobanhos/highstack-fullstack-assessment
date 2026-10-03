FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
# Keep the original smoke script available as a temporary diagnostic.
COPY stream-smoke.ts ./stream-smoke.ts

ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["bun", "run", "src/server.ts"]
