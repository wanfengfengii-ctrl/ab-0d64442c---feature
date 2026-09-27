# API image — build context must be the repository root (npm workspaces).
FROM node:22-slim

WORKDIR /app

# Install production dependencies from the workspace lockfile first (layer cache).
COPY package.json package-lock.json ./
COPY packages/solver/package.json packages/solver/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci --omit=dev

# Application sources (solver is used by the API directly).
COPY packages/solver ./packages/solver
COPY packages/api ./packages/api

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/api/src/server.js"]
