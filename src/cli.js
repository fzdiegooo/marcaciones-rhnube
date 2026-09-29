import { loadConfig } from './config.js';
import { RHNube } from './rhnube.js';
import { Store } from './store.js';
import { syncVentana } from './sync.js';

const [, , cmd, arg] = process.argv;
const cfg = loadConfig();

if (cmd === 'presentes') {
  const store = new Store(cfg.DB);
  const ws = store.presentes(arg);
  console.log(`${arg}: ${ws.length} presentes`);
  for (const w of ws)
    console.log(`  ${w.dni}  ${w.nombre}  |  ${w.area}  |  ${w.primera_marca.slice(11)} → ${w.ultima_marca.slice(11)}  (${w.n_marcas})`);
  process.exit(0);
}

const client = new RHNube({
  email: cfg.EMAIL,
  password: cfg.PASSWORD,
  twocaptchaKey: cfg.TWOCAPTCHA_KEY,
  balanceMin: cfg.BALANCE_MIN,
});

if (cmd === 'balance') {
  console.log(`Saldo 2captcha: $${(await client.balance()).toFixed(4)} USD`);
} else if (cmd === 'login') {
  await client.login();
  console.log('Login OK, cookies guardadas.');
} else if (cmd === 'sync') {
  const store = new Store(cfg.DB);
  const r = await syncVentana({ client, store, lookback: cfg.LOOKBACK, dispositivos: cfg.DISPOSITIVOS });
  console.log(`Sync ${r.inicio}..${r.fin}: ${r.traidas} traídas, ${r.validas} válidas (descartadas ${r.descartadas}).`);
  store.close();
} else {
  console.log('Uso: node src/cli.js sync|login|balance|presentes <YYYY-MM-DD>');
  process.exit(1);
}
