# Multi-stage build for SeaAir Mobile App API + Support Dashboard SPA.
#
# Stage 1: web-builder builds the dashboard SPA (web/) with Vite. The
# Cognito + API base values are inlined at build time via VITE_* build
# args, so the same Dockerfile produces a per-environment image. CI/CD
# must pass these as --build-arg or via Docker Buildx secrets.
#
# Stage 2: builder compiles the API TypeScript.
#
# Stage 3: runtime ships only production deps + the two build outputs.
# The Express server in server.ts serves the SPA at /dashboard/.

FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
ARG VITE_COGNITO_AUTHORITY
ARG VITE_COGNITO_CLIENT_ID
ARG VITE_COGNITO_DOMAIN
ARG VITE_COGNITO_REDIRECT_URI
ARG VITE_COGNITO_LOGOUT_URI
ARG VITE_API_BASE=/dashboard/api
ENV VITE_COGNITO_AUTHORITY=$VITE_COGNITO_AUTHORITY \
    VITE_COGNITO_CLIENT_ID=$VITE_COGNITO_CLIENT_ID \
    VITE_COGNITO_DOMAIN=$VITE_COGNITO_DOMAIN \
    VITE_COGNITO_REDIRECT_URI=$VITE_COGNITO_REDIRECT_URI \
    VITE_COGNITO_LOGOUT_URI=$VITE_COGNITO_LOGOUT_URI \
    VITE_API_BASE=$VITE_API_BASE
RUN npm run build

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
COPY --from=web-builder /app/web/dist ./web/dist
COPY *.proto ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
USER node
CMD ["node", "dist/server.js"]
