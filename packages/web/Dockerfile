# Web image — build context must be the repository root (npm workspaces).
# Stage 1: build the Vite SPA.
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/solver/package.json packages/solver/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

COPY packages/web ./packages/web
RUN npm run build -w @chart/web

# Stage 2: serve static assets and reverse-proxy /api to the API service.
FROM nginx:1.27-alpine

COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
