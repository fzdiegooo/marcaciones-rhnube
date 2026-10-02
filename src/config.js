import fs from 'node:fs';

// Carga configuración. Prioridad: variables de entorno (patrón env_file de Docker)
// por encima del archivo config.env (útil en local). El archivo es opcional.
export function loadConfig(path = 'config.env') {
  const raw = {};

  // 1. Archivo config.env (si existe).
  try {
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      raw[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* sin archivo: se usa solo el entorno (caso Docker) */
  }

  // 2. Entorno pisa al archivo.
  const KEYS = ['EMAIL', 'PASSWORD', 'TWOCAPTCHA_KEY', 'DISPOSITIVOS', 'LOOKBACK',
    'DB', 'COOKIE_FILE', 'PORT', 'CRON', 'KEEPALIVE_CRON', 'BALANCE_MIN', 'API_KEY'];
  for (const k of KEYS) if (process.env[k] != null && process.env[k] !== '') raw[k] = process.env[k];

  for (const k of ['EMAIL', 'PASSWORD', 'TWOCAPTCHA_KEY', 'API_KEY']) {
    if (!raw[k]) throw new Error(`Falta ${k} (en ${path} o como variable de entorno).`);
  }
  // Una clave corta se adivina por fuerza bruta: exigir al menos 32 caracteres.
  if (raw.API_KEY.length < 32) throw new Error('API_KEY debe tener al menos 32 caracteres.');

  return {
    EMAIL: raw.EMAIL,
    PASSWORD: raw.PASSWORD,
    TWOCAPTCHA_KEY: raw.TWOCAPTCHA_KEY,
    DISPOSITIVOS: (raw.DISPOSITIVOS || '').split(',').map((s) => s.trim()).filter(Boolean),
    LOOKBACK: parseInt(raw.LOOKBACK || '2', 10),
    DB: raw.DB || 'marcaciones.db',
    COOKIE_FILE: raw.COOKIE_FILE || 'cookies.json',
    PORT: parseInt(raw.PORT || '3000', 10),
    CRON: raw.CRON || '*/20 6-10 * * *', // cada 20 min, 6am-10am
    KEEPALIVE_CRON: raw.KEEPALIVE_CRON || '0 */2 * * *', // cada 2 horas
    BALANCE_MIN: parseFloat(raw.BALANCE_MIN || '0.5'), // umbral aviso saldo (USD)
    API_KEY: raw.API_KEY, // clave que el ERP manda en X-API-Key
  };
}
