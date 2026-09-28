import { RHNube } from './rhnube.js';

function today() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Sincroniza la ventana móvil [hoy - lookback, hoy] hacia SQLite.
// Idempotente: re-jalar no duplica; recoge a los que llegan tarde.
export async function syncVentana({ client, store, lookback, dispositivos }) {
  const inicio = daysAgo(lookback);
  const fin = today();
  const rows = await client.fetchMarcaciones({ inicio, fin, dispositivos });
  const validas = RHNube.soloValidas(rows);
  const n = store.upsert(validas);
  return { inicio, fin, traidas: rows.length, validas: n, descartadas: rows.length - n };
}
