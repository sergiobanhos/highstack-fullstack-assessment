FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json index.html vite.config.ts ./
COPY src ./src
COPY public ./public

ENV OPERATOR_URL=http://operator:3000
EXPOSE 5173

CMD ["bun", "run", "dev"]
