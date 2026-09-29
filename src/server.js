import express from 'express';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { RHNube } from './rhnube.js';
import { Store } from './store.js';
import { syncVentana } from './sync.js';

const cfg = loadConfig();
const client = new RHNube({
  email: cfg.EMAIL,
  password: cfg.PASSWORD,
  twocaptchaKey: cfg.TWOCAPTCHA_KEY,
  balanceMin: cfg.BALANCE_MIN,
  cookieFile: cfg.COOKIE_FILE,
});
const store = new Store(cfg.DB);

// Evita syncs solapados (cron + manual a la vez).
let running = false;
async function runSync(origen) {
  if (running) return { skipped: true, origen };
  running = true;
  try {
    const res = await syncVentana({
      client,
      store,
      lookback: cfg.LOOKBACK,
      dispositivos: cfg.DISPOSITIVOS,
    });
    console.log(`[sync:${origen}] ${res.inicio}..${res.fin} traidas=${res.traidas} validas=${res.validas}`);
    return res;
  } finally {
    running = false;
  }
}

// ---- Cron acotado: por defecto cada 20 min, 6am-10am ('*/20 6-10 * * *') ----
if (!cron.validate(cfg.CRON)) {
  console.error(`CRON inválido: ${cfg.CRON}`);
  process.exit(1);
}
cron.schedule(cfg.CRON, () => runSync('cron').catch((e) => console.error('[cron]', e.message)), {
  timezone: 'America/Lima',
});
console.log(`Cron activo: "${cfg.CRON}" (America/Lima)`);

// ---- API ----
const app = express();

// Sync manual, sin esperar el cron.
app.post('/sync', async (_req, res) => {
  try {
    const r = await runSync('manual');
    if (r.skipped) return res.status(202).json({ status: 'ya-en-curso' });
    res.json({ status: 'ok', ...r });
  } catch (e) {
    res.status(502).json({ status: 'error', error: e.message });
  }
});

// Nombres de presentes de un día (lee SQLite, no toca RHNube).
// Filtra por dispositivo: ?dispositivo=5488 o, por defecto, los de config (DISPOSITIVOS).
app.get('/presentes/:fecha', (req, res) => {
  const dispositivos = req.query.dispositivo ? [req.query.dispositivo] : cfg.DISPOSITIVOS;
  res.json({
    fecha: req.params.fecha,
    dispositivos,
    nombres: store.presentes(req.params.fecha, dispositivos),
  });
});

// ¿Un trabajador marcó ese día? (para el módulo de etapas).
app.get('/estuvo/:dni/:fecha', (req, res) => {
  res.json({
    dni: req.params.dni,
    fecha: req.params.fecha,
    estuvo: store.estuvo(req.params.dni, req.params.fecha),
  });
});

// Login explícito (setup inicial o forzar re-login). Consume 1 crédito 2captcha.
// Normalmente no hace falta: el primer POST /sync ya loguea solo si la sesión murió.
app.post('/login', async (_req, res) => {
  try {
    await client.login();
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(502).json({ status: 'error', error: e.message });
  }
});

// Saldo restante en 2captcha (USD).
app.get('/balance', async (_req, res) => {
  try {
    res.json({ balance_usd: await client.balance() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, syncing: running }));

app.listen(cfg.PORT, () => console.log(`API en http://localhost:${cfg.PORT}`));
