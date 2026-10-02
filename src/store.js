import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS marcaciones (
  idmarcaciones_biometrico INTEGER PRIMARY KEY,
  dni TEXT NOT NULL,
  emple_id INTEGER NOT NULL,
  nombre TEXT,
  fecha TEXT NOT NULL,
  marcacion_ts TEXT NOT NULL,
  area TEXT, cargo TEXT, local TEXT,
  dispositivo TEXT,          -- nombre del biométrico (texto)
  id_dispositivo INTEGER,    -- id numérico del dispositivo (ej. 5488)
  estado INTEGER,
  sync_ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_marc_fecha_dni ON marcaciones(fecha, dni);
CREATE INDEX IF NOT EXISTS ix_marc_emple ON marcaciones(emple_id, fecha);
CREATE INDEX IF NOT EXISTS ix_marc_fecha_disp ON marcaciones(fecha, id_dispositivo);
`;

const UPSERT = `
INSERT INTO marcaciones
  (idmarcaciones_biometrico, dni, emple_id, nombre, fecha, marcacion_ts,
   area, cargo, local, dispositivo, id_dispositivo, estado, sync_ts)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT(idmarcaciones_biometrico) DO UPDATE SET
  estado=excluded.estado, nombre=excluded.nombre, area=excluded.area,
  cargo=excluded.cargo, local=excluded.local, dispositivo=excluded.dispositivo,
  id_dispositivo=excluded.id_dispositivo, sync_ts=datetime('now');
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
    r.idDispositivos ?? null,
    r.estado ?? null,
  ];
}

export class Store {
  constructor(path = 'marcaciones.db') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this._upsert = this.db.prepare(UPSERT);
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

  // Solo nombres de presentes ese día: sin vacíos y filtrados por dispositivo(s).
  // dispositivos: array de ids numéricos (ej. [5488]). Vacío = todos.
  presentes(fecha, dispositivos = []) {
    const ids = dispositivos.map(Number).filter((n) => !Number.isNaN(n));
    let sql = `
      SELECT DISTINCT nombre FROM marcaciones
      WHERE fecha = ? AND nombre IS NOT NULL AND TRIM(nombre) != ''`;
    const params = [fecha];
    if (ids.length) {
      sql += ` AND id_dispositivo IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
    sql += ' ORDER BY nombre';
    return this.db.prepare(sql).all(...params).map((r) => r.nombre);
  }

  // Primera y última marcación de cada persona por día, entre dos fechas
  // (inclusive). Las del refrigerio quedan en medio y no cuentan: la jornada va
  // de la primera a la última. dispositivos: igual que en presentes().
  jornadas(desde, hasta, dispositivos = []) {
    const ids = dispositivos.map(Number).filter((n) => !Number.isNaN(n));
    let sql = `
      SELECT fecha, MAX(nombre) AS nombre,
             MIN(marcacion_ts) AS primera, MAX(marcacion_ts) AS ultima,
             COUNT(*) AS marcaciones
      FROM marcaciones
      WHERE fecha BETWEEN ? AND ? AND nombre IS NOT NULL AND TRIM(nombre) != ''`;
    const params = [desde, hasta];
    if (ids.length) {
      sql += ` AND id_dispositivo IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
    sql += ' GROUP BY fecha, dni ORDER BY fecha, nombre';
    return this.db.prepare(sql).all(...params);
  }

  estuvo(dni, fecha) {
    return this._estuvo.get(dni, fecha) !== undefined;
  }

  close() {
    this.db.close();
  }
}
