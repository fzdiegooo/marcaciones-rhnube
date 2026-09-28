import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS marcaciones (
  idmarcaciones_biometrico INTEGER PRIMARY KEY,
  dni TEXT NOT NULL,
  emple_id INTEGER NOT NULL,
  nombre TEXT,
  fecha TEXT NOT NULL,
  marcacion_ts TEXT NOT NULL,
  area TEXT, cargo TEXT, local TEXT, dispositivo TEXT,
  estado INTEGER,
  sync_ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_marc_fecha_dni ON marcaciones(fecha, dni);
CREATE INDEX IF NOT EXISTS ix_marc_emple ON marcaciones(emple_id, fecha);
`;

const UPSERT = `
INSERT INTO marcaciones
  (idmarcaciones_biometrico, dni, emple_id, nombre, fecha, marcacion_ts,
   area, cargo, local, dispositivo, estado, sync_ts)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(idmarcaciones_biometrico) DO UPDATE SET
  estado=excluded.estado, nombre=excluded.nombre, area=excluded.area,
  cargo=excluded.cargo, local=excluded.local, dispositivo=excluded.dispositivo,
  sync_ts=datetime('now');
`;

function rowParams(r) {
  const de = r.empleado?.last_dato_empresarial ?? {};
  return [
    r.idmarcaciones_biometrico,
    r.dni,
    r.emple_id,
    r.nombre ?? null,
    String(r.marcacion).slice(0, 10),
    String(r.marcacion),
    de.area?.area_descripcion ?? null,
    de.cargo?.cargo_descripcion ?? null,
    de.local?.local_descripcion ?? null,
    r.biometrico ?? null,
    r.estado ?? null,
  ];
}

export class Store {
  constructor(path = 'marcaciones.db') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this._upsert = this.db.prepare(UPSERT);
    this._presentes = this.db.prepare(`
      SELECT dni, emple_id, MAX(nombre) AS nombre, MAX(area) AS area,
             MAX(cargo) AS cargo, MAX(local) AS local,
             MIN(marcacion_ts) AS primera_marca, MAX(marcacion_ts) AS ultima_marca,
             COUNT(*) AS n_marcas
      FROM marcaciones WHERE fecha = ?
      GROUP BY dni, emple_id ORDER BY primera_marca`);
    this._estuvo = this.db.prepare(
      'SELECT 1 FROM marcaciones WHERE dni=? AND fecha=? LIMIT 1'
    );
  }

  upsert(rowsValidas) {
    this.db.exec('BEGIN');
    try {
      for (const r of rowsValidas) this._upsert.run(...rowParams(r));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return rowsValidas.length;
  }

  presentes(fecha) {
    return this._presentes.all(fecha);
  }

  estuvo(dni, fecha) {
    return this._estuvo.get(dni, fecha) !== undefined;
  }

  close() {
    this.db.close();
  }
}
