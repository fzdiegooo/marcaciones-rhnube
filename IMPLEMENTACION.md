# Implementación en el ERP

Guía corta para conectar el módulo de etapas del ERP con la API de marcaciones.

## Idea general

- La API mantiene un espejo local (SQLite) de las marcaciones, refrescado por un cron.
- El ERP **lee** ese espejo para llenar el dropdown de trabajadores presentes.
- Un botón **"Actualizar"** permite forzar una sincronización manual cuando se necesite.

El dropdown nunca sincroniza al abrir: solo lee. Sincronizar es una acción explícita
(el cron o el botón), para no volver lento el select ni recargar RHNube de más.

## Endpoints que usa el ERP

Base URL:

- Desde otro contenedor del mismo stack (misma red `crm_net`): `http://marcaciones_rhnube:3000`
- Desde el host / túnel: `http://127.0.0.1:3200`

| Acción              | Llamada                                  | Devuelve                                  |
| ------------------- | ---------------------------------------- | ----------------------------------------- |
| Llenar el dropdown  | `GET /presentes/:fecha?dispositivo=5488` | `{ fecha, dispositivos, nombres: [...] }` |
| Botón "Actualizar"  | `POST /sync`                             | `{ status: "ok", ... }` o `202` si ya corre |

`fecha` en formato `YYYY-MM-DD`. `nombres` ya viene filtrado: solo asistencia real,
sin nombres vacíos y solo del dispositivo indicado (5488 por defecto).

## Flujo

1. Al abrir el dropdown → `GET /presentes/:fecha` → llenar el `<select>` con `nombres`.
2. El cron mantiene el espejo fresco durante la mañana; el dropdown siempre lee al día.
3. Si el usuario quiere asegurarse de tener lo último → clic en "Actualizar" →
   `POST /sync` → volver a llamar `GET /presentes/:fecha`.

## Ejemplo mínimo

```js
const BASE = 'http://marcaciones_rhnube:3000'; // o http://127.0.0.1:3200 desde el host
const hoy = () => new Date().toISOString().slice(0, 10);

// Llenar el dropdown desde SQLite (instantáneo).
async function cargarDropdown() {
  const { nombres } = await fetch(`${BASE}/presentes/${hoy()}?dispositivo=5488`)
    .then((r) => r.json());
  const select = document.getElementById('trabajadores');
  select.innerHTML = nombres
    .map((n) => `<option value="${n}">${n}</option>`)
    .join('');
}

// Botón "Actualizar": sincroniza y vuelve a listar.
async function actualizar(btn) {
  btn.disabled = true;
  try {
    await fetch(`${BASE}/sync`, { method: 'POST' }); // pega a RHNube y hace upsert
    await cargarDropdown();
  } finally {
    btn.disabled = false;
  }
}
```

```html
<select id="trabajadores" multiple size="10"></select>
<button onclick="actualizar(this)">Actualizar</button>
```

## Notas

- **Multi-select:** es puro frontend del ERP. La API solo entrega la lista de nombres.
- **Botón mientras sincroniza:** deshabilítalo o muestra un spinner; `POST /sync` tarda
  1–2 s. Si otro sync ya está corriendo, la API responde `202 { status: "ya-en-curso" }`;
  trátalo como "ya se está actualizando" y vuelve a leer `/presentes` igual.
- **Horario:** si en el ERP se eligen trabajadores fuera de la franja del cron (por defecto
  6–10 a. m.), usa el botón "Actualizar" o amplía el cron (variable `CRON` en `config.env`).
- **Otra fecha:** para consultar un día distinto, cambia el parámetro `:fecha`.
- **Otro dispositivo:** cambia `?dispositivo=`; sin ese parámetro se usan los de `DISPOSITIVOS`.
