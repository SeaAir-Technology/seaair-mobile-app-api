# Multi-stage build for SeaAir Mobile App API
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
# Use install (not ci) so a stale lockfile during PR review still builds.
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY server.ts ./
COPY src ./src
COPY *.proto ./
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY *.proto ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
USER node
CMD ["node", "dist/server.js"]
