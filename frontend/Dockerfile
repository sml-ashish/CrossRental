# syntax=docker/dockerfile:1

# --- build -----------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The app calls the API through a relative `/api` (see src/lib/api.ts), so no
# backend origin has to be baked in at build time.
RUN npm run build

# --- runtime ---------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# SPA fallback plus a same-origin `/api` proxy to the backend service, so the
# browser never needs CORS or a second host.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
