# One-shot verification image — build context must be the repository root.
# Runs solver unit tests, the frontend build, and restore-API smoke checks
# against the healthy api/web services; the container exit code reports the
# overall result.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/solver/package.json packages/solver/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

COPY packages ./packages
COPY scripts ./scripts

ENV API_BASE_URL=http://api:3000
ENV WEB_BASE_URL=http://web

CMD ["node", "scripts/smoke.mjs"]
