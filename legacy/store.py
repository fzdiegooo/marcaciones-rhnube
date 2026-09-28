"""
Espejo SQLite de marcaciones RHNube.

No es un snapshot de una consulta única: es un espejo que se sincroniza seguido.
El upsert deduplica por idmarcaciones_biometrico, así que re-jalar el mismo día
es idempotente y los que llegan tarde aparecen en el siguiente sync.

Solo se guardan marcas de asistencia REAL (estado==1). Ver RHNube.solo_validas.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS marcaciones (
    idmarcaciones_biometrico INTEGER PRIMARY KEY,
    dni           TEXT NOT NULL,
    emple_id      INTEGER NOT NULL,
    nombre        TEXT,
    fecha         TEXT NOT NULL,          -- YYYY-MM-DD del escaneo real
    marcacion_ts  TEXT NOT NULL,          -- timestamp completo del escaneo
    area          TEXT,
    cargo         TEXT,
    local         TEXT,
    dispositivo   TEXT,
    estado        INTEGER,
    sync_ts       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_marc_fecha_dni ON marcaciones(fecha, dni);
CREATE INDEX IF NOT EXISTS ix_marc_emple     ON marcaciones(emple_id, fecha);
"""

UPSERT = """
INSERT INTO marcaciones
  (idmarcaciones_biometrico, dni, emple_id, nombre, fecha, marcacion_ts,
   area, cargo, local, dispositivo, estado, sync_ts)
VALUES
  (:id, :dni, :emple_id, :nombre, :fecha, :marcacion_ts,
   :area, :cargo, :local, :dispositivo, :estado, datetime('now'))
ON CONFLICT(idmarcaciones_biometrico) DO UPDATE SET
   estado=excluded.estado, nombre=excluded.nombre, area=excluded.area,
   cargo=excluded.cargo, local=excluded.local, dispositivo=excluded.dispositivo,
   sync_ts=datetime('now');
"""


def _row_to_params(r: dict) -> dict:
    de = (r.get("empleado") or {}).get("last_dato_empresarial") or {}
    return {
        "id": r["idmarcaciones_biometrico"],
        "dni": r["dni"],
        "emple_id": r["emple_id"],
        "nombre": r.get("nombre"),
        "fecha": str(r["marcacion"])[:10],
        "marcacion_ts": str(r["marcacion"]),
        "area": (de.get("area") or {}).get("area_descripcion"),
        "cargo": (de.get("cargo") or {}).get("cargo_descripcion"),
        "local": (de.get("local") or {}).get("local_descripcion"),
        "dispositivo": r.get("biometrico"),
        "estado": r.get("estado"),
    }


class Store:
    def __init__(self, path: str | Path = "marcaciones.db"):
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def upsert(self, rows_validas: list[dict]) -> int:
        """Inserta/actualiza marcas válidas. Devuelve cuántas se procesaron."""
        params = [_row_to_params(r) for r in rows_validas]
        self.conn.executemany(UPSERT, params)
        self.conn.commit()
        return len(params)

    def presentes(self, fecha: str) -> list[dict]:
        """Trabajadores presentes ese día (uno por dni) con primera/última marca."""
        cur = self.conn.execute(
            """
            SELECT dni, emple_id,
                   MAX(nombre) AS nombre, MAX(area) AS area,
                   MAX(cargo) AS cargo, MAX(local) AS local,
                   MIN(marcacion_ts) AS primera_marca,
                   MAX(marcacion_ts) AS ultima_marca,
                   COUNT(*) AS n_marcas
            FROM marcaciones
            WHERE fecha = ?
            GROUP BY dni, emple_id
            ORDER BY primera_marca
            """,
            (fecha,),
        )
        return [dict(r) for r in cur.fetchall()]

    def estuvo(self, dni: str, fecha: str) -> bool:
        """¿Este trabajador marcó ese día? (para el módulo de etapas)."""
        cur = self.conn.execute(
            "SELECT 1 FROM marcaciones WHERE dni=? AND fecha=? LIMIT 1",
            (dni, fecha),
        )
        return cur.fetchone() is not None
