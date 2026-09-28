# get-marcaciones-rhnube

Espejo de marcaciones biométricas de [RHNube](https://rhnube.com.pe) para integrarlas
en un ERP propio. RHNube no expone una API oficial, así que este servicio reutiliza el
mismo endpoint interno que usa el frontend del sistema, con una sesión autenticada, y
mantiene un espejo local en SQLite que el ERP puede consultar.

El caso de uso concreto: saber **qué trabajadores estuvieron presentes cada día** para
cruzarlo con el módulo de etapas de procesado de producto. El servicio garantiza que solo
se cuenten marcaciones de asistencia **real**, nunca huellas no reconocidas ni duplicados.

## Cómo funciona

- **Login automático.** El login de RHNube exige reCAPTCHA v2, que se resuelve vía
  [2captcha](https://2captcha.com). Todo por HTTP, sin navegador.
- **Sesión persistente (sliding).** La sesión Laravel dura ~8 h de inactividad y se renueva
  en cada request. Las cookies se guardan en `cookies.json` y se refrescan solas. Mientras
  el cron corra dentro de ese margen, el captcha (y por tanto 2captcha) casi nunca se usa.
- **Sincronización incremental.** Un cron re-consulta una ventana móvil de días y hace
  *upsert* en SQLite. El *upsert* es idempotente (clave `idmarcaciones_biometrico`), así que
  re-sincronizar no duplica y los que marcan tarde aparecen en la siguiente corrida.
- **Ventana móvil.** Se sincroniza desde `hoy - LOOKBACK` hasta hoy, para recoger también
  marcaciones cargadas o editadas de forma retroactiva.

## Regla de asistencia real

Una marcación cuenta como presencia solo si cumple **todas** estas condiciones
(`RHNube.soloValidas`):

- `estado === 1`
- `respuesta === "Marcación registrada"`
- tiene `dni` y `emple_id`

Esto descarta a propósito:

- **Huellas no reconocidas** (`"Identificador biometrico no encontrado …"`): traen un número
  en el campo `dni` pero no corresponden a ningún trabajador registrado.
- **Duplicados** (`"Marcación duplicada …"`): re-escaneos de alguien que ya está contado por
  su primera marca del día.
- Cualquier `estado` distinto de 1.

Un trabajador se considera presente un día si tiene al menos una marcación válida ese día,
usando la fecha del escaneo real (`marcacion`), no la de registro (`fechaRegistro`).

## Requisitos

- Node.js 22 o superior (usa `node:sqlite` y `fetch` nativos).
- Una cuenta de RHNube (perfil empleador/administrador).
- Una API key de 2captcha con saldo.

## Instalación

```bash
npm install
cp config.env.example config.env   # completar con credenciales reales
npm run login                       # primer login: resuelve el captcha y crea cookies.json
npm start                           # levanta la API + el cron
```

## Configuración (`config.env`)

| Variable         | Descripción                                                            | Default            |
| ---------------- | ---------------------------------------------------------------------- | ------------------ |
| `EMAIL`          | Correo de la cuenta RHNube                                             | —                  |
| `PASSWORD`       | Contraseña                                                             | —                  |
| `TWOCAPTCHA_KEY` | API key de 2captcha                                                    | —                  |
| `DISPOSITIVOS`   | IDs de dispositivo biométrico separados por coma; vacío = todos        | `5488`             |
| `LOOKBACK`       | Días hacia atrás que re-sincroniza cada corrida                        | `2`                |
| `DB`             | Ruta del archivo SQLite                                                | `marcaciones.db`   |
| `PORT`           | Puerto de la API                                                       | `3000`             |
| `CRON`           | Expresión cron del sync automático (zona `America/Lima`)               | `*/20 6-10 * * *`  |

El cron por defecto (`*/20 6-10 * * *`) dispara cada 20 minutos entre las 6:00 y las 10:40.
Para cortar antes de las 10:00 usar `*/20 6-9 * * *`.

## API

| Método y ruta            | Descripción                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `POST /sync`             | Sincroniza en el acto, sin esperar al cron. Devuelve el resumen.     |
| `GET /presentes/:fecha`  | Trabajadores presentes ese día (`YYYY-MM-DD`), leído de SQLite.      |
| `GET /estuvo/:dni/:fecha`| `{ estuvo: true|false }` — pensado para el módulo de etapas.         |
| `GET /health`            | Estado del servicio e indicador de sync en curso.                    |

`POST /sync` tiene un lock: si ya hay una sincronización corriendo, responde `202` con
`{ status: "ya-en-curso" }` en lugar de lanzar otra en paralelo.

Ejemplos:

```bash
curl -X POST localhost:3000/sync
curl localhost:3000/presentes/2026-09-28
curl localhost:3000/estuvo/43716319/2026-09-28
```

## CLI

Para operar sin el servidor (por ejemplo, desde un cron del sistema):

```bash
npm run login                       # login manual / regenerar cookies.json
npm run sync                        # sincroniza la ventana móvil una vez
node src/cli.js presentes 2026-09-28
```

## Estructura

```
src/
  rhnube.js   Cliente RHNube: login con 2captcha, cookies sliding, soloValidas, fetch paginado
  store.js    Espejo SQLite: upsert idempotente y consultas (presentes, estuvo)
  sync.js     Sincronización de la ventana móvil, compartida por el cron y el endpoint
  server.js   Express + cron acotado por horario
  cli.js      Comandos de línea: login | sync | presentes
  config.js   Carga de config.env
legacy/       Prototipo original en Python (superado por la versión Node)
```

## Seguridad

- `config.env` y `cookies.json` contienen credenciales y una sesión viva. Están en
  `.gitignore` y no deben commitearse ni compartirse.
- `cookies.json` equivale a una sesión iniciada: cualquiera que lo tenga actúa como esa
  cuenta hasta que la sesión expire (~8 h de inactividad).

## Notas y limitaciones

- No hay push ni webhooks: la frescura de los datos es, como máximo, el intervalo del cron.
- El *upsert* es acumulativo y no borra. Si una marcación se elimina en RHNube, permanece en
  el espejo local. Para asistencia esto rara vez importa.
- El servicio depende del contrato del endpoint interno de RHNube y del sitekey de reCAPTCHA;
  si RHNube cambia su login o su respuesta, habrá que ajustar `src/rhnube.js`.
