# syntax=docker/dockerfile:1

# --- build -----------------------------------------------------------------
# Compiles the TypeScript and generates the Prisma client (which lives under
# src/generated/prisma, so it is compiled into dist as well).
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Prisma's schema engine needs OpenSSL on the slim base image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `prisma generate` does not connect, but prisma.config.ts reads DATABASE_URL.
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV DATABASE_URL=${DATABASE_URL}

RUN npx prisma generate && npm run build

# --- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3004

# node_modules is copied whole from the build stage so the Prisma CLI is
# available to `prisma migrate deploy` at boot. The app itself only needs the
# dependencies, so a slimmer image is possible later without changing behaviour.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN mkdir -p /app/uploads && chmod +x /app/docker-entrypoint.sh && chown -R node:node /app

USER node

EXPOSE 3004

ENTRYPOINT ["./docker-entrypoint.sh"]
