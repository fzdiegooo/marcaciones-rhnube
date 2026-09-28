#!/usr/bin/env python3
"""
CLI de extracción de marcaciones RHNube para tu ERP (producción).

Login automático (2captcha resuelve el reCAPTCHA) + sesión persistente.
Configura config.env con EMAIL, PASSWORD, TWOCAPTCHA_KEY. Ver config.env.example.

Uso:
  python3 get_marcaciones.py --inicio 2026-09-01 --fin 2026-09-28
  python3 get_marcaciones.py --inicio 2026-09-01 --fin 2026-09-28 --dispositivos 5488
  python3 get_marcaciones.py --keepalive        # ping para mantener viva la sesión
"""
import argparse
import csv
import json
import sys
from datetime import date, timedelta
from pathlib import Path

from rhnube import RHNube, RHNubeError
from store import Store


def load_config(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"Falta {path}. Copia config.env.example a config.env y complétalo.")
    cfg = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip().strip('"').strip("'")
    for req in ("EMAIL", "PASSWORD", "TWOCAPTCHA_KEY"):
        if not cfg.get(req):
            sys.exit(f"Falta {req} en {path}")
    return cfg


def flatten(r: dict) -> dict:
    out = dict(r)
    de = (r.get("empleado") or {}).get("last_dato_empresarial") or {}
    out["area"] = (de.get("area") or {}).get("area_descripcion")
    out["cargo"] = (de.get("cargo") or {}).get("cargo_descripcion")
    out["local"] = (de.get("local") or {}).get("local_descripcion")
    return out


def write_outputs(rows: list[dict], out: str) -> None:
    Path(f"{out}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    print(f"Guardado {out}.json ({len(rows)} filas)")
    if rows and isinstance(rows[0], dict):
        cols = ["dni", "nombre", "marcacion", "fechaRegistro", "biometrico",
                "dispositivo_descripcion", "area", "cargo", "local",
                "respuesta", "estado", "emple_id", "idmarcaciones_biometrico"]
        with open(f"{out}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(flatten(r) for r in rows)
        print(f"Guardado {out}.csv (plano, para ERP)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Extrae marcaciones de RHNube")
    ap.add_argument("--inicio", help="Fecha inicio YYYY-MM-DD")
    ap.add_argument("--fin", help="Fecha fin YYYY-MM-DD")
    ap.add_argument("--dispositivos", nargs="*", default=[],
                    help="IDs de dispositivo (ej. 5488). Vacío = todos.")
    ap.add_argument("--config", default="config.env", type=Path)
    ap.add_argument("--out", default="marcaciones")
    ap.add_argument("--keepalive", action="store_true",
                    help="Solo mantener viva la sesión (para cron).")
    ap.add_argument("--sync", action="store_true",
                    help="Sincroniza ventana móvil a SQLite (para cron cada 5-15 min).")
    ap.add_argument("--lookback", type=int, default=2,
                    help="Días hacia atrás a re-sincronizar (por marcas retroactivas).")
    ap.add_argument("--db", default="marcaciones.db")
    ap.add_argument("--presentes", metavar="YYYY-MM-DD",
                    help="Lista presentes de un día desde SQLite (no consulta RHNube).")
    args = ap.parse_args()

    # Consulta local pura: no necesita credenciales ni red.
    if args.presentes:
        store = Store(args.db)
        ws = store.presentes(args.presentes)
        print(f"{args.presentes}: {len(ws)} presentes")
        for w in ws:
            print(f"  {w['dni']}  {w['nombre']}  |  {w['area']}  |  "
                  f"{w['primera_marca'][11:]} → {w['ultima_marca'][11:]}  ({w['n_marcas']})")
        return

    cfg = load_config(args.config)
    client = RHNube(cfg["EMAIL"], cfg["PASSWORD"], cfg["TWOCAPTCHA_KEY"])

    try:
        if args.sync:
            hoy = date.today()
            inicio = (hoy - timedelta(days=args.lookback)).isoformat()
            fin = hoy.isoformat()
            rows = client.fetch_marcaciones(inicio, fin, args.dispositivos)
            validas = RHNube.solo_validas(rows)
            store = Store(args.db)
            n = store.upsert(validas)
            store.close()
            print(f"Sync {inicio}..{fin}: {len(rows)} traídas, {n} válidas "
                  f"upserted (descartadas {len(rows) - n} no-válidas).")
            return

        if args.keepalive:
            if client.keepalive():
                print("Sesión viva.")
            else:
                print("Sesión muerta, re-logueando…")
                client.login()
                print("Re-login OK.")
            return

        if not args.inicio or not args.fin:
            sys.exit("Falta --inicio y --fin (o usa --keepalive).")

        rows = client.fetch_marcaciones(args.inicio, args.fin, args.dispositivos)
        print(f"Total: {len(rows)} marcaciones")
        write_outputs(rows, args.out)
    except RHNubeError as e:
        sys.exit(f"Error RHNube: {e}")


if __name__ == "__main__":
    main()
