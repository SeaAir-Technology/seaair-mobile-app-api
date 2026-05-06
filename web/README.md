# SeaAir Support Dashboard (web/)

Internal browser-based dashboard for the SeaAir support team. Lives inside the
mobile app API repo and is served by the same Express service on AWS App
Runner. The SPA is reached at the root of `dashboard.seaair.com` (a custom
domain alias on the same App Runner service as `api.seaair.com`); the backend
API for it is mounted at `/dashboard/api/*` (see `src/routes/dashboard.ts`).

Served same-origin with the API, so no CORS configuration is required.

## Stack

- Vite + React 18 + TypeScript
- React Router v6 at the host root
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
cp .env.example .env.local             # fill in VITE_COGNITO_CLIENT_ID;
                                        # set VITE_COGNITO_REDIRECT_URI to
                                        # http://localhost:5173/
npm install
npm run dev                             # http://localhost:5173/
```

The Vite dev server proxies `/dashboard/api/*` to `localhost:3000`. Register
the localhost callback on a separate Cognito app client for dev to keep prod
clean.

## Production build

The top-level `Dockerfile` adds a `web-builder` stage that runs `npm run build`
here and copies `web/dist/` into the runtime image. The API then serves it at
the host root. One image, one deploy artifact.

Build-time env vars must be passed as Docker build args:

```bash
docker build \
  --build-arg VITE_COGNITO_AUTHORITY=https://cognito-idp.us-east-2.amazonaws.com/us-east-2_Z6wNcT7sN \
  --build-arg VITE_COGNITO_CLIENT_ID=<spa client id> \
  --build-arg VITE_COGNITO_DOMAIN=us-east-2z6wnct7sn.auth.us-east-2.amazoncognito.com \
  --build-arg VITE_COGNITO_REDIRECT_URI=https://dashboard.seaair.com/ \
  --build-arg VITE_COGNITO_LOGOUT_URI=https://dashboard.seaair.com/ \
  -t seaair-mobile-app-api:dashboard .
```

## Cognito setup

Handled by the AWS CLI command in PR #15's body — creates a public app client
in user pool `us-east-2_Z6wNcT7sN` with the dashboard.seaair.com callback,
authorization code grant, scopes `openid email profile`. Output the
`ClientId` from that command into `VITE_COGNITO_CLIENT_ID`.

The `dashboard-admin` Cognito group must exist (overridable via
`DASHBOARD_ADMIN_GROUP` on the API). At least one bootstrap member must be
added via the AWS console so they can grant access to others through the
Admin tab.

## Authorization model

Every request to `/dashboard/api/*` requires a Cognito access token in the
`Authorization: Bearer <token>` header AND the user must be a member of the
dashboard-admin group. See `src/middleware/requireDashboardAdmin.ts`.
