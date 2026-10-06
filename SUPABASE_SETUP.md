# Astra Gateway — Supabase / Render setup

## Render variables

Set these in Render:

```text
NODE_ENV=production
PORT=3000
UPSTREAM_BASE_URL=...
UPSTREAM_API_KEY=...
ADMIN_PASSWORD=...
SESSION_SECRET=...
ADMIN_BACKDOOR_PATH=/admin/orex/strax
MODEL_MAP=...
ANTHROPIC_DEFAULT_MODEL=kimi-k3
SUPABASE_DB_URL=...
```

`DB_PATH` is only a local-development fallback and is not needed on Render.

## Supabase database

1. Create a new Supabase project.
2. Open **SQL Editor**.
3. Run the complete `supabase.sql` file.
4. Open **Connect** and copy the PostgreSQL connection string.
5. Put that full string into `SUPABASE_DB_URL`.

The gateway uses the server-side Postgres connection; the real Supabase credentials are never exposed to clients.

## Anthropic / Claude Code

The gateway already has an Anthropic-compatible `/v1/messages` endpoint. The server does not need an Anthropic API key. Claude Code supplies its own client-side variables and uses the same gateway API key:

```bash
export ANTHROPIC_BASE_URL=https://YOUR-RENDER-HOST/v1
export ANTHROPIC_AUTH_TOKEN=astra-...
export ANTHROPIC_MODEL=kimi-k3
export ANTHROPIC_SMALL_FAST_MODEL=kimi-k3
```

`ANTHROPIC_DEFAULT_MODEL` is only the server-side fallback used when the client sends an unknown model id.

## Model catalog

`MODEL_MAP` seeds the database only when `models` is empty. After that, models are managed through the admin panel. The original source's model catalog is kept intact in this build.
