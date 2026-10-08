<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Base44 dev environment

## Running the app

```bash
docker compose -f docker-compose.base44.yml up -d
```

The compose file runs a single `web` service (node:22-slim) with the source
bind-mounted at `/app`. Dependencies install on container startup via
`npm install`, then `next dev -H 0.0.0.0 -p 3000` starts the Turbopack dev
server with live reload. Port 3000 is mapped to the host.

## Environment variables

All env vars come from two `env_file` entries in order:
1. `.env.base44-defaults` (repo, placeholders) — lets the app boot without real credentials
2. `/run/base44/app.env` (platform-managed, outside repo) — real secrets override placeholders

Required variables (see `.env.example`):
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL (external)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon key (external)
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (external, server-only)
- `STAFF_SESSION_SECRET` — signs staff PIN-login cookies (local, generated)
- `NEXT_PUBLIC_SITE_URL` — base URL for QR code targets (defaults to http://localhost:3000)

Without real Supabase credentials the marketing home page renders, but any
page that queries the database (dashboard, staff, menu) will error.

## Sandbox-specific config

`next.config.ts` conditionally adds the preview origin to `allowedDevOrigins`
when `BASE44_PREVIEW_MODE === "1"`. Without this, Next.js blocks cross-origin
requests to dev assets/HMR from the preview proxy. The flag is unset in normal
local dev, so the change has no effect outside the sandbox.
