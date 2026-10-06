const INTERVAL_MS = 13 * 60 * 1000;
const START_DELAY_MS = 10 * 1000;

function getPublicBaseUrl() {
  const externalUrl = (process.env.RENDER_EXTERNAL_URL || '').trim();
  if (externalUrl) return externalUrl.replace(/\/+$/, '');

  const hostname = (process.env.RENDER_EXTERNAL_HOSTNAME || '').trim();
  if (hostname) return `https://${hostname}`;

  return '';
}

async function pingSelf(reason) {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    console.log('[keepalive] Render public URL was not detected — keepalive disabled for this run.');
    return;
  }

  const url = `${baseUrl}/healthz`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'astra-gateway-keepalive/1.0' },
      signal: AbortSignal.timeout(15_000),
    });

    console.log(`[keepalive] ${reason}: ${url} -> HTTP ${response.status}`);
  } catch (error) {
    console.warn(`[keepalive] ${reason}: ${url} -> ${error?.message || error}`);
  }
}

export function startKeepalive() {
  console.log('[keepalive] Scheduled self-ping every 13 minutes.');

  const firstTimer = setTimeout(() => {
    void pingSelf('initial');
  }, START_DELAY_MS);

  const interval = setInterval(() => {
    void pingSelf('interval');
  }, INTERVAL_MS);

  firstTimer.unref?.();
  interval.unref?.();
}
