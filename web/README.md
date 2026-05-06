# SeaAir Support Dashboard (web/)

Internal browser-based dashboard for the SeaAir support team. Lives inside the
mobile app API repo and is served by the same Express service on AWS App
Runner at `/dashboard/`. The backend API for it is mounted at
`/dashboard/api/*` (see `src/routes/dashboard.ts`).

Served same-origin with the API, so no CORS configuration is required.

## Stack

- Vite + React 18 + TypeScript
- React Router v6 (basename `/dashboard`)
- TanStack Query for fetching + 2 s polling on live views
- react-oidc-context against Cognito Hosted UI (access token Bearer auth)
- Tailwind CSS
- Recharts for the per-device Analytics tab

## Local development

```bash
# Terminal 1 - API
npm install
npm run build && node dist/server.js   # listens on :3000

# Terminal 2 - SPA
cd web
cp .env.example .env.local             # fill in VITE_COGNITO_CLIENT_ID and
                                        # set VITE_COGNITO_REDIRECT_URI to
                                        # http://localhost:5173/dashboard/
npm install
npm run dev                             # http://localhost:5173/dashboard/
```

The Vite dev server proxies `/dashboard/api/*` to `localhost:3000`. Register
the localhost callback on a separate Cognito app client for dev to keep prod
clean.

## Production build

The top-level `Dockerfile` adds a `web-builder` stage that runs `npm run build`
here and copies `web/dist/` into the runtime image. The API then serves it at
`/dashboard/`. One image, one deploy artifact.

Build-time env vars must be passed as Docker build args:

```bash
docker build \
  --build-arg VITE_COGNITO_AUTHORITY=... \
  --build-arg VITE_COGNITO_CLIENT_ID=... \
  --build-arg VITE_COGNITO_DOMAIN=... \
  --build-arg VITE_COGNITO_REDIRECT_URI=... \
  --build-arg VITE_COGNITO_LOGOUT_URI=... \
  -t seaair-mobile-app-api:dashboard .
```

## Cognito setup checklist (one-time)

1. Create a Hosted UI domain on the Cognito user pool.
2. Create a NEW app client for the dashboard with NO client secret.
3. Allowed OAuth flows: Authorization code grant.
4. Allowed scopes: `openid email profile`.
5. Allowed callback URLs: `https://api.seaair.com/dashboard/` (and the dev
   localhost URL if you'll use this client for dev too).
6. Allowed sign-out URLs: same as callback URLs.
7. Create a Cognito group named `dashboard-admin` (overridable via
   `DASHBOARD_ADMIN_GROUP` on the API).
8. Add the first admin user(s) to the group manually so they can use
   `/dashboard/api/admin/users/:username/grant` to onboard others.

## Authorization model

Every request to `/dashboard/api/*` requires a Cognito access token in the
`Authorization: Bearer <token>` header AND the user must be a member of the
dashboard-admin group. See `src/middleware/requireDashboardAdmin.ts`.
