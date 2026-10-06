import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { createStore } from './src/store/index.js';
import { createAnthropicRouter } from './src/routes/anthropic.js';
import { createProxyRouter } from './src/routes/proxy.js';
import { createAdminRouter } from './src/routes/admin.js';
import { grantSession } from './src/adminAuth.js';
import { startKeepalive } from './src/keepalive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

if (process.env.NODE_ENV === 'production' && !config.supabaseDbUrl) {
  console.error('[fatal] SUPABASE_DB_URL is not set. Configure Supabase Postgres in Render.');
  process.exit(1);
}

const store = await createStore();
console.log(`Storage driver: ${store.driver}${store.driver === 'postgres' ? ' (external DB — survives redeploys)' : ' (local file — ephemeral on free hosting)'}`);

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// Public model catalog for the landing page (public ids/labels only, no secrets).
app.get('/api/models', async (req, res) => {
  const models = await store.listModels();
  res.json({ models: models.filter((m) => m.enabled).map((m) => ({ id: m.id, label: m.label })) });
});

// Anthropic-compatible route first (Claude Code), then the OpenAI-compatible one.
app.use('/v1', createAnthropicRouter(store));
app.use('/v1', createProxyRouter(store));
app.use('/admin/api', createAdminRouter(store));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/keys/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'key.html')));

const backdoor = config.adminBackdoorPath.replace(/\/+$/, '');
if (backdoor) {
  app.get(backdoor, (req, res) => {
    if (!config.adminPassword) {
      return res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
    }
    grantSession(res);
    res.redirect('/admin');
  });
}

app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }
  console.error(err);
  res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
});

app.listen(config.port, () => {
  console.log(`Strax Gateway listening on port ${config.port}`);
  startKeepalive();
  if (!config.upstreamBaseUrl || !config.upstreamApiKey) {
    console.warn('[warn] UPSTREAM_BASE_URL / UPSTREAM_API_KEY are not set — proxying will fail.');
  }
  if (!config.adminPassword) {
    console.warn('[warn] ADMIN_PASSWORD is not set — admin login is disabled.');
  }
});
