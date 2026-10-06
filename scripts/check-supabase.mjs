if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL is not set');
  process.exit(2);
}
const t = Date.now();
const { createStore } = await import('../src/store/index.js');
try {
  const s = await createStore();
  console.log('driver:', s.driver, '| init took', Date.now() - t, 'ms');
  console.log('models:', (await s.listModels()).length);
  console.log('stats:', JSON.stringify(await s.getStats()));
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
