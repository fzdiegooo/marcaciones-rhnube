"""
Cliente RHNube para producción: login automático (resolviendo reCAPTCHA v2 con
2captcha) + extracción de marcaciones. Sin navegador — todo por HTTP con requests.

RHNube no expone API oficial. Se reusa el endpoint interno que usa el frontend
(DataTables server-side) con una sesión Laravel autenticada.

Diseño de sesión:
  - La sesión Laravel es "sliding": cada request devuelve cookies frescas.
  - Se persisten en cookies.json y se refrescan tras cada request.
  - Mientras se haga al menos un request antes de SESSION_LIFETIME (~120 min),
    la sesión no expira => el captcha solo se resuelve en el primer login o
    cuando el servidor invalida la sesión (deploy, cambio de IP, inactividad larga).
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import requests

BASE = "https://rhnube.com.pe"
RECAPTCHA_SITEKEY = "6LdSaCQiAAAAAE_VrR4Oo2mvbnFVUstjtBD6UIeg"
COOKIE_NAMES = ("rhnube_session", "XSRF-TOKEN")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36"
)


class RHNubeError(RuntimeError):
    pass


class SessionExpired(RHNubeError):
    pass


class RHNube:
    def __init__(self, email: str, password: str, twocaptcha_key: str,
                 cookie_file: Path = Path("cookies.json")):
        self.email = email
        self.password = password
        self.twocaptcha_key = twocaptcha_key
        self.cookie_file = Path(cookie_file)
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA})
        self._load_cookies()

    # ---------- persistencia de cookies (sliding session) ----------
    def _load_cookies(self) -> None:
        if self.cookie_file.exists():
            data = json.loads(self.cookie_file.read_text())
            for name, val in data.items():
                self.s.cookies.set(name, val, domain="rhnube.com.pe")

    def _save_cookies(self) -> None:
        data = {c.name: c.value for c in self.s.cookies if c.name in COOKIE_NAMES}
        if data:
            self.cookie_file.write_text(json.dumps(data, indent=2))

    def _csrf_header(self) -> str:
        """Token de <meta csrf-token> para el header X-CSRF-TOKEN."""
        r = self.s.get(f"{BASE}/", timeout=30)
        m = re.search(r'csrf-token"\s+content="([^"]+)"', r.text)
        if not m:
            raise RHNubeError("No se encontró meta csrf-token en la home")
        return m.group(1)

    # ---------- login con 2captcha ----------
    def _solve_recaptcha(self, pageurl: str) -> str:
        """Resuelve reCAPTCHA v2 vía 2captcha, devuelve g-recaptcha-response token."""
        r = requests.post(
            "https://2captcha.com/in.php",
            data={
                "key": self.twocaptcha_key,
                "method": "userrecaptcha",
                "googlekey": RECAPTCHA_SITEKEY,
                "pageurl": pageurl,
                "json": 1,
            },
            timeout=30,
        ).json()
        if r.get("status") != 1:
            raise RHNubeError(f"2captcha in.php falló: {r}")
        cap_id = r["request"]
        # poll hasta ~120s
        for _ in range(24):
            time.sleep(5)
            res = requests.get(
                "https://2captcha.com/res.php",
                params={"key": self.twocaptcha_key, "action": "get",
                        "id": cap_id, "json": 1},
                timeout=30,
            ).json()
            if res.get("status") == 1:
                return res["request"]
            if res.get("request") != "CAPCHA_NOT_READY":
                raise RHNubeError(f"2captcha res.php error: {res}")
        raise RHNubeError("2captcha timeout resolviendo el captcha")

    def login(self) -> None:
        """Login completo: obtiene _token, resuelve captcha, POST /login."""
        home = self.s.get(f"{BASE}/", timeout=30)
        m = re.search(r'name="_token"\s+value="([^"]+)"', home.text)
        if not m:
            raise RHNubeError("No se encontró _token en el formulario de login")
        token = m.group(1)

        captcha = self._solve_recaptcha(f"{BASE}/")

        r = self.s.post(
            f"{BASE}/login",
            headers={"X-Requested-With": "XMLHttpRequest",
                     "Accept": "application/json"},
            data={
                "_token": token,
                "login_portal": "empleador",
                "email": self.email,
                "password": self.password,
                "g-recaptcha-response": captcha,
            },
            allow_redirects=False,
            timeout=30,
        )
        if r.status_code == 422:
            raise RHNubeError(f"Login rechazado (422): {r.text[:300]}")
        if r.status_code not in (200, 204, 302):
            raise RHNubeError(f"Login inesperado HTTP {r.status_code}: {r.text[:200]}")
        if not self.s.cookies.get("rhnube_session"):
            raise RHNubeError("Login no devolvió cookie de sesión")
        self._save_cookies()

    # ---------- extracción de marcaciones ----------
    def _post_marcaciones(self, payload: dict) -> requests.Response:
        return self.s.post(
            f"{BASE}/marcaciones-biometricos",
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": self._csrf_from_cookie(),
                "Origin": BASE,
                "Referer": f"{BASE}/biometricos",
            },
            data=payload,
            allow_redirects=False,
            timeout=60,
        )

    def _csrf_from_cookie(self) -> str:
        """Header X-CSRF-TOKEN debe corresponder a la sesión activa.

        RHNube acepta el token del <meta> de una página autenticada. Lo pedimos
        una vez por instancia y lo cacheamos.
        """
        if not getattr(self, "_csrf_cache", None):
            self._csrf_cache = self._csrf_header()
        return self._csrf_cache

    def fetch_marcaciones(self, inicio: str, fin: str,
                          dispositivos: list[str] | None = None,
                          page_size: int = 100,
                          auto_login: bool = True) -> list[dict]:
        """Devuelve todas las marcaciones del rango [inicio, fin] (YYYY-MM-DD)."""
        dispositivos = dispositivos or []
        rows: list[dict] = []
        start = 0
        total = None
        relogged = False

        while True:
            payload = {
                "draw": "1", "limite": str(page_size), "start": str(start),
                "fechaInicio": inicio, "fechaFin": fin,
                "switchR": "false", "switchNoR": "false",
                "search[0][column]": "apellidos", "search[0][val]": "",
                "estado": "",
                "dispo_biometrico": "true", "dispo_web": "true",
                "app_portal": "true", "app_reloj": "true", "lumina_os": "true",
                "tipo_proceso": "0",
            }
            if dispositivos:
                payload["dispositivos[]"] = dispositivos

            r = self._post_marcaciones(payload)

            # sesión muerta => re-login una vez
            if r.status_code in (302, 401, 419) or "text/html" in r.headers.get("Content-Type", ""):
                if auto_login and not relogged:
                    self._csrf_cache = None
                    self.login()
                    relogged = True
                    continue
                raise SessionExpired(f"Sesión inválida (HTTP {r.status_code})")

            r.raise_for_status()
            self._save_cookies()  # refresca cookies sliding
            data = r.json()
            if total is None:
                total = data.get("recordsFiltered", data.get("recordsTotal", 0))
            batch = data.get("data", [])
            rows.extend(batch)
            if not batch or len(rows) >= (total or 0):
                break
            start += page_size
            time.sleep(0.3)

        return rows

    @staticmethod
    def solo_validas(rows: list[dict]) -> list[dict]:
        """Filtra SOLO marcaciones de asistencia real.

        Descarta huellas no reconocidas ('Identificador biometrico no encontrado',
        que traen un dni-fantasma), errores y estados != 1. Es la salvaguarda
        para no atribuir presencia a quien no marcó de verdad.
        """
        return [
            r for r in rows
            if r.get("estado") == 1 and r.get("respuesta") == "Marcación registrada"
            and r.get("dni") and r.get("emple_id")
        ]

    def asistencia_por_dia(self, inicio: str, fin: str,
                           dispositivos: list[str] | None = None) -> dict[str, list[dict]]:
        """Devuelve {fecha: [trabajadores presentes]} usando SOLO marcas válidas.

        La fecha es la del escaneo real ('marcacion'), no la de registro.
        Cada trabajador aparece una vez por día con su primera/última marca.
        """
        rows = self.solo_validas(
            self.fetch_marcaciones(inicio, fin, dispositivos)
        )
        por_dia: dict[str, dict[str, dict]] = {}
        for r in rows:
            fecha = str(r["marcacion"])[:10]  # fecha del escaneo real
            hora = str(r["marcacion"])
            dni = r["dni"]
            dia = por_dia.setdefault(fecha, {})
            if dni not in dia:
                de = (r.get("empleado") or {}).get("last_dato_empresarial") or {}
                dia[dni] = {
                    "dni": dni,
                    "emple_id": r.get("emple_id"),
                    "nombre": r.get("nombre"),
                    "area": (de.get("area") or {}).get("area_descripcion"),
                    "cargo": (de.get("cargo") or {}).get("cargo_descripcion"),
                    "local": (de.get("local") or {}).get("local_descripcion"),
                    "primera_marca": hora,
                    "ultima_marca": hora,
                    "n_marcas": 1,
                }
            else:
                w = dia[dni]
                w["n_marcas"] += 1
                if hora < w["primera_marca"]:
                    w["primera_marca"] = hora
                if hora > w["ultima_marca"]:
                    w["ultima_marca"] = hora
        return {f: list(w.values()) for f, w in sorted(por_dia.items())}

    def keepalive(self) -> bool:
        """Ping ligero para mantener viva la sesión (cron < 120 min). True si OK."""
        r = self.s.get(f"{BASE}/biometricos", allow_redirects=False, timeout=30)
        if r.status_code == 200:
            self._save_cookies()
            return True
        return False
