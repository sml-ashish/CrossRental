# syntax=docker/dockerfile:1

# --- build -----------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The app calls the API through a relative `/api` (see src/lib/api.ts), so no
# backend origin has to be baked in at build time.
#
# The Maps JavaScript API key is different: Vite inlines VITE_* values into the
# bundle, so the browser key is a build argument. It must be restricted by HTTP
# referrer and limited to the Maps JavaScript API.
ARG VITE_GOOGLE_MAPS_BROWSER_KEY=
ENV VITE_GOOGLE_MAPS_BROWSER_KEY=$VITE_GOOGLE_MAPS_BROWSER_KEY

RUN npm run build

# --- runtime ---------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# SPA fallback plus a same-origin `/api` proxy to the backend service, so the
# browser never needs CORS or a second host.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
