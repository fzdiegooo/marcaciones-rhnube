import crypto from 'node:crypto';
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

// Ping para mantener viva la sesión (sliding). Si la encuentra muerta, re-loguea
// para auto-sanar. Comparte el lock 'running' para no solaparse con un sync.
async function keepalivePing() {
  if (running) return;
  running = true;
  try {
    if (await client.keepalive()) {
      console.log('[keepalive] sesión viva, refrescada.');
    } else {
      console.warn('[keepalive] sesión muerta: re-logueando…');
      await client.login();
    }
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

// ---- Keepalive: cada 2 horas mantiene viva la sesión (evita login diario) ----
cron.schedule(cfg.KEEPALIVE_CRON, () => keepalivePing().catch((e) => console.error('[keepalive]', e.message)), {
  timezone: 'America/Lima',
});
console.log(`Keepalive activo: "${cfg.KEEPALIVE_CRON}" (America/Lima)`);

// ---- API ----
const app = express();
app.disable('x-powered-by');

// Healthcheck abierto (Docker / monitoreo), sin datos sensibles.
app.get('/health', (_req, res) => res.json({ ok: true, syncing: running }));

// Saldo restante en 2captcha (USD). También abierto, para vigilarlo sin la clave.
app.get('/balance', async (_req, res) => {
  try {
    res.json({ balance_usd: await client.balance() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// El resto exige la API key en el header X-API-Key. Se comparan los hashes
// con timingSafeEqual para no filtrar la clave por tiempos de respuesta.
const sha256 = (v) => crypto.createHash('sha256').update(v).digest();
const API_KEY_HASH = sha256(cfg.API_KEY);
app.use((req, res, next) => {
  const key = req.get('x-api-key');
  if (key && crypto.timingSafeEqual(sha256(key), API_KEY_HASH)) return next();
  res.status(401).json({ error: 'API key inválida o ausente' });
});

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

// Primera y última marcación de cada persona por día, para contar horas
// trabajadas. ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD (máximo 62 días).
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
app.get('/jornadas', (req, res) => {
  const { desde, hasta } = req.query;
  if (!FECHA.test(String(desde ?? '')) || !FECHA.test(String(hasta ?? '')) || desde > hasta) {
    return res.status(400).json({ error: 'desde y hasta tienen que venir como AAAA-MM-DD' });
  }
  if ((Date.parse(hasta) - Date.parse(desde)) / 86_400_000 > 62) {
    return res.status(400).json({ error: 'El rango no puede pasar de 62 días' });
  }
  const dispositivos = req.query.dispositivo ? [req.query.dispositivo] : cfg.DISPOSITIVOS;
  res.json({ desde, hasta, dispositivos, jornadas: store.jornadas(desde, hasta, dispositivos) });
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

app.listen(cfg.PORT, () => console.log(`API en http://localhost:${cfg.PORT}`));
