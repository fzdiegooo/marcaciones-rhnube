import fs from 'node:fs';

export function loadConfig(path = 'config.env') {
  const cfg = {};
  let text = '';
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Falta ${path}. Copia config.env.example a config.env y complétalo.`);
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  for (const k of ['EMAIL', 'PASSWORD', 'TWOCAPTCHA_KEY']) {
    if (!cfg[k]) throw new Error(`Falta ${k} en ${path}`);
  }
  // Opcionales con default
  cfg.DISPOSITIVOS = (cfg.DISPOSITIVOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  cfg.LOOKBACK = parseInt(cfg.LOOKBACK || '2', 10);
  cfg.DB = cfg.DB || 'marcaciones.db';
  cfg.PORT = parseInt(cfg.PORT || '3000', 10);
  cfg.CRON = cfg.CRON || '*/20 6-10 * * *'; // cada 20 min, 6am-10am
  cfg.BALANCE_MIN = parseFloat(cfg.BALANCE_MIN || '0.5'); // umbral aviso saldo (USD)
  return cfg;
}
