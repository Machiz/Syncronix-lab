# Integración · qué se implantó y por qué

Base: **syncronix-lab_-visionpulse** (React 19 + Express + Gemini). La cámara no
se tocó: `MultimodalStudio.tsx` sigue igual, con `getUserMedia` y captura a
canvas. Lo que se añadió viene de lo que ya funcionaba en **syncronix-lab**
(WireWatch) y del motor de reglas de la versión Python.

## Archivos nuevos

| Archivo | Qué aporta | De dónde viene |
|---|---|---|
| `src/lib/boardRules.ts` | Límites eléctricos reales de ESP32, Uno, Pico y Blue Pill | motor Python |
| `src/lib/codeParser.ts` | Anotación `@sensor`, constantes, uso de pines, `codeKeywords` | WireWatch + motor Python |
| `src/lib/localDiagnostics.ts` | Motor determinista → `DiagnosticReport` | motor Python |
| `src/lib/sensorCatalog.ts` | Fichas con respaldo offline, importación revisada, enriquecimiento online | WireWatch |
| `src/lib/localDiagnostics.test.ts` | Prueba sin navegador (`npx tsx`) | nuevo |

## Archivos modificados

- **`src/App.tsx`**
  - `edgeMode` ahora es real: con el interruptor activado el diagnóstico se
    resuelve en el navegador y no sale ninguna petición a la red.
  - En modo nube se envían los hallazgos locales como hechos verificados.
  - Se eliminaron 68 líneas de informe fijo. Cuando el servidor fallaba, la
    aplicación mostraba siempre el mismo diagnóstico sobre SDA/SCL del SSD1306,
    con 92 % de confianza, aunque el montaje fuera otro. Ahora el respaldo es el
    diagnóstico local real.
- **`server.ts`**
  - Acepta `localFindings` y los inserta en el prompt como hechos ya
    verificados, con la instrucción de no repetirlos ni contradecirlos.
  - Se añadió la jerarquía de evidencia: código y serial son evidencia dura, la
    fotografía es evidencia blanda y no puede afirmar a qué pin llega un cable.
  - Modelo de reserva `gemini-3.1-flash-lite` → `gemini-3.5-flash-lite`.

## Lo que detecta sin conexión

Pines inexistentes o reservados por la flash (GPIO 6-11), pines de solo entrada
usados como salida, pines de arranque comprometidos, `analogRead()` sobre ADC2
con WiFi activo, SDA y SCL cruzados, pines sin ADC o sin PWM, dos señales en el
mismo pin, `analogWrite()` en ESP32, entradas analógicas sin pull interno,
componentes fuera de su rango de alimentación, 5 V hacia entradas de 3.3 V,
cargas inductivas sin driver, brownout, watchdog, NACK de I2C, lecturas
constantes, saturadas o binarias.

## Probar

```bash
npm install
npx tsx src/lib/localDiagnostics.test.ts   # motor local, sin red ni navegador
npm run lint                               # tsc --noEmit
npm run build
npm run dev                                # necesita GEMINI_API_KEY para el modo nube
```

## Repositorio de fichas (sin internet)

Las fichas viven en **`data/sheets/*.json`**, se versionan con git y se cargan
del disco al arrancar. Una vez que una ficha está ahí, el laboratorio entero la
tiene y no hace falta conexión nunca más.

```
GET  /api/sheets   lee data/sheets/*.json
POST /api/sheets   escribe una ficha nueva en data/sheets/
```

Orden de carga, de menos a más confiable. Cada capa puede faltar sin romper la
anterior:

1. **Semilla** — 19 fichas compiladas en `src/data/sensors.ts`. Siempre están.
2. **Repositorio** — `data/sheets/*.json`. Lectura de disco vía servidor local.
3. **Navegador** — `localStorage`, para que un build estático sin servidor
   conserve lo importado en esa máquina.
4. **Online** — opcional y apagado por defecto. Solo descriptivo.

Si el servidor no responde, la aplicación lo dice en consola y sigue con la
semilla y el respaldo del navegador. El diagnóstico no se detiene nunca por
falta de red.

Una ficha rota no tumba el catálogo: el endpoint la salta y la devuelve en
`invalid` para que se pueda corregir.

Los nombres con separadores de ruta o `..` se rechazan con 400: un nombre de
componente no lleva barras.

### Por qué importa

La ficha semilla de HC-SR04 dice 3.3–5 V. La revisada dice 4.5–5.5 V, que es lo
que pone la hoja de datos. Con la revisada cargada, el motor detecta que ese
sensor a 5 V sobre un ESP32 mete 5 V en una entrada de 3.3 V:

```
antes:   HC-SR04 3.3-5V (bundled)
después: HC-SR04 4.5-5.5V (imported-reviewed) usable=true
  [critical] NIVEL_5V  «HC-SR04» trabaja a 5 V sobre una placa de 3.3 V
```

## Fichas de componentes

El respaldo se siembra desde `SensorDatabase.catalog` y se guarda en
`localStorage`. Tres procedencias, y solo dos deciden alimentación:

- `bundled` y `imported-reviewed` → `electricallyUsable = true`.
- `online-unverified` → solo descriptiva. Lo descargado de Wikipedia no rellena
  voltajes ni pinout, porque un resumen de enciclopedia no es una hoja de datos.

Para datos eléctricos, importar una ficha JSON revisada:

```json
[{ "canonical_name": "SEN0193", "aliases": ["sensor humedad suelo capacitivo"],
   "interface": "ANALOG", "voltage_min": 3.3, "voltage_max": 5.5,
   "summary": "Sensor capacitivo de humedad de suelo.",
   "source_url": "URL de la hoja de datos" }]
```

## Límite que conviene decir en voz alta

Ninguna cámara puede confirmar a qué pin llega un cable en una protoboard: los
cables se tapan entre sí, las filas conducen por debajo del plástico y el color
no significa nada. Por eso `pinoutMatrix.physicalWiredPin` del motor local dice
"No verificable sin medición" en lugar de inventar un pin. La foto sirve para
ver qué componentes hay, si falta un driver o un diodo, y si un cable está
visiblemente suelto.
