import fs from 'node:fs';

const BASE = 'https://rhnube.com.pe';
const RECAPTCHA_SITEKEY = '6LdSaCQiAAAAAE_VrR4Oo2mvbnFVUstjtBD6UIeg';
const COOKIE_NAMES = ['rhnube_session', 'XSRF-TOKEN'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36';

export class RHNubeError extends Error {}
export class SessionExpired extends RHNubeError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RHNube {
  constructor({ email, password, twocaptchaKey, cookieFile = 'cookies.json', balanceMin = 0.5 }) {
    this.email = email;
    this.password = password;
    this.twocaptchaKey = twocaptchaKey;
    this.cookieFile = cookieFile;
    this.balanceMin = balanceMin; // umbral (USD) para avisar saldo bajo tras login
    this.cookies = {}; // { name: value }
    this.csrfCache = null;
    this._loadCookies();
  }

  // ---------- persistencia de cookies (sliding session) ----------
  _loadCookies() {
    try {
      this.cookies = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
    } catch {
      this.cookies = {};
    }
  }

  _saveCookies() {
    const out = {};
    for (const n of COOKIE_NAMES) if (this.cookies[n]) out[n] = this.cookies[n];
    if (Object.keys(out).length) fs.writeFileSync(this.cookieFile, JSON.stringify(out, null, 2));
  }

  _cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  _absorbSetCookie(res) {
    // fetch nativo: getSetCookie() devuelve array de Set-Cookie crudos
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }

  async _get(path) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA, Cookie: this._cookieHeader() },
      redirect: 'manual',
    });
    this._absorbSetCookie(res);
    return res;
  }

  async _csrfHeader() {
    // token del <meta csrf-token> de una página autenticada, para X-CSRF-TOKEN.
    // '/' redirige al estar logueado; '/biometricos' devuelve 200 con el meta.
    if (this.csrfCache) return this.csrfCache;
    const res = await this._get('/biometricos');
    const html = await res.text();
    const m = html.match(/csrf-token"\s+content="([^"]+)"/);
    if (!m) throw new RHNubeError('No se encontró meta csrf-token en la home');
    this.csrfCache = m[1];
    return this.csrfCache;
  }

  // ---------- login con 2captcha ----------
  async _solveRecaptcha(pageurl) {
    const inRes = await fetch('https://2captcha.com/in.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        key: this.twocaptchaKey,
        method: 'userrecaptcha',
        googlekey: RECAPTCHA_SITEKEY,
        pageurl,
        json: '1',
      }),
    }).then((r) => r.json());
    if (inRes.status !== 1) throw new RHNubeError(`2captcha in.php falló: ${JSON.stringify(inRes)}`);
    const id = inRes.request;
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const res = await fetch(
        `https://2captcha.com/res.php?key=${this.twocaptchaKey}&action=get&id=${id}&json=1`
      ).then((r) => r.json());
      if (res.status === 1) return res.request;
      if (res.request !== 'CAPCHA_NOT_READY')
        throw new RHNubeError(`2captcha res.php error: ${JSON.stringify(res)}`);
    }
    throw new RHNubeError('2captcha timeout resolviendo el captcha');
  }

  async login() {
    console.warn('[login] Sesión expirada: resolviendo reCAPTCHA con 2captcha (consume 1 crédito)…');
    const t0 = Date.now();
    const home = await this._get('/');
    const html = await home.text();
    const m = html.match(/name="_token"\s+value="([^"]+)"/);
    if (!m) throw new RHNubeError('No se encontró _token en el formulario de login');
    const token = m[1];

    const captcha = await this._solveRecaptcha(`${BASE}/`);

    const res = await fetch(`${BASE}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Cookie: this._cookieHeader(),
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _token: token,
        login_portal: 'empleador',
        email: this.email,
        password: this.password,
        'g-recaptcha-response': captcha,
      }),
    });
    this._absorbSetCookie(res);
    if (res.status === 422) throw new RHNubeError(`Login rechazado (422): ${(await res.text()).slice(0, 300)}`);
    if (![200, 204, 302].includes(res.status))
      throw new RHNubeError(`Login inesperado HTTP ${res.status}`);
    if (!this.cookies['rhnube_session']) throw new RHNubeError('Login no devolvió cookie de sesión');
    this.csrfCache = null;
    this._saveCookies();
    console.warn(`[login] OK: nueva sesión guardada (${((Date.now() - t0) / 1000).toFixed(1)}s).`);
    // Aviso de saldo: solo tras gastar un crédito. No rompe el login si falla.
    try {
      const bal = await this.balance();
      if (bal <= this.balanceMin)
        console.warn(`[balance] SALDO BAJO: $${bal.toFixed(4)} USD (umbral $${this.balanceMin}). Recarga 2captcha.`);
      else console.warn(`[balance] Saldo 2captcha: $${bal.toFixed(4)} USD.`);
    } catch (e) {
      console.warn(`[balance] No se pudo consultar saldo: ${e.message}`);
    }
  }

  // ---------- extracción de marcaciones ----------
  async _postMarcaciones(payload) {
    const csrf = await this._csrfHeader();
    return fetch(`${BASE}/marcaciones-biometricos`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Cookie: this._cookieHeader(),
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-TOKEN': csrf,
        Origin: BASE,
        Referer: `${BASE}/biometricos`,
      },
      body: payload,
    });
  }

  buildPayload({ inicio, fin, start, pageSize, dispositivos }) {
    const p = new URLSearchParams({
      draw: '1',
      limite: String(pageSize),
      start: String(start),
      fechaInicio: inicio,
      fechaFin: fin,
      switchR: 'false',
      switchNoR: 'false',
      'search[0][column]': 'apellidos',
      'search[0][val]': '',
      estado: '',
      dispo_biometrico: 'true',
      dispo_web: 'true',
      app_portal: 'true',
      app_reloj: 'true',
      lumina_os: 'true',
      tipo_proceso: '0',
    });
    for (const d of dispositivos) p.append('dispositivos[]', d);
    return p;
  }

  async fetchMarcaciones({ inicio, fin, dispositivos = [], pageSize = 100, autoLogin = true }) {
    const rows = [];
    let start = 0;
    let total = null;
    let relogged = false;

    while (true) {
      const payload = this.buildPayload({ inicio, fin, start, pageSize, dispositivos });
      const res = await this._postMarcaciones(payload);
      this._absorbSetCookie(res);

      const ct = res.headers.get('content-type') || '';
      if ([302, 401, 419].includes(res.status) || ct.includes('text/html')) {
        if (autoLogin && !relogged) {
          this.csrfCache = null;
          await this.login();
          relogged = true;
          continue;
        }
        throw new SessionExpired(`Sesión inválida (HTTP ${res.status})`);
      }
      if (!res.ok) throw new RHNubeError(`HTTP ${res.status} en marcaciones`);

      this._saveCookies(); // refresca cookies sliding
      const data = await res.json();
      if (total === null) total = data.recordsFiltered ?? data.recordsTotal ?? 0;
      const batch = data.data ?? [];
      rows.push(...batch);
      if (batch.length === 0 || rows.length >= total) break;
      start += pageSize;
      await sleep(300);
    }
    return rows;
  }

  // Salvaguarda: SOLO asistencia real. Descarta huellas no reconocidas
  // (traen dni-fantasma), duplicados y errores. Nunca atribuye presencia falsa.
  static soloValidas(rows) {
    return rows.filter(
      (r) => r.estado === 1 && r.respuesta === 'Marcación registrada' && r.dni && r.emple_id
    );
  }

  // Saldo de 2captcha (en USD). Útil para vigilar créditos.
  async balance() {
    const res = await fetch(
      `https://2captcha.com/res.php?key=${this.twocaptchaKey}&action=getbalance&json=1`
    ).then((r) => r.json());
    if (res.status !== 1) throw new RHNubeError(`2captcha getbalance falló: ${JSON.stringify(res)}`);
    return parseFloat(res.request);
  }

  async keepalive() {
    const res = await this._get('/biometricos');
    if (res.status === 200) {
      this._saveCookies();
      return true;
    }
    return false;
  }
}
