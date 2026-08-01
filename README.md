# WireWatch MCU

Aplicación de escritorio para comparar lo que un programa **declara** con la
telemetría que un microcontrolador o banco de prueba **mide** en tiempo real.

## Qué entrega

Por cada señal muestra:

- Pin definido en el código.
- Pin conectado físicamente informado por el agente.
- Coincidencia.
- Configuración detectada.
- Corrección necesaria.
- Causa más probable.
- Clasificación:
  - Conexión incorrecta.
  - Alimentación incorrecta.
  - Tierra común ausente.
  - Configuración de software incorrecta.
  - Error de comunicación.
  - Componente posiblemente dañado.
  - Información insuficiente.

## Límite físico importante

Un puerto USB/serial **no permite observar directamente todos los cables GPIO**.
El ordenador solo conoce:

1. La identidad y datos que transmite el microcontrolador.
2. Las pruebas que el firmware pueda realizar.
3. Las mediciones de un hardware externo, si existe.

Por eso WireWatch usa un agente de diagnóstico. Para confirmar continuidad,
VCC, GND o el destino real de un cable con alta confianza se necesita un
**test-jig**: multiplexores, protección, ADC, medidores de continuidad y una
placa supervisora. Sin ese hardware, el campo “pin conectado físicamente” es el
pin declarado por el agente, no una inspección mágica del cable.

## Instalación en Windows

1. Instale Python 3.11 o superior.
2. Descomprima el proyecto.
3. Ejecute `run_windows.bat`.

Instalación manual:

```powershell
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

## Uso

1. Abra un `.ino`, `.cpp`, `.h` o `.py`.
2. Use anotaciones estándar:

```cpp
// @sensor LDR; signal=AO; pin=34; mode=INPUT; interface=ANALOG; voltage=3.3
const int LDR_AO_PIN = 34; // Sensor: módulo LDR
```

3. Cargue en la placa uno de los agentes de `examples/`.
4. Seleccione el puerto y 115200 baudios.
5. Pulse **Conectar** y **Solicitar diagnóstico**.

## Catálogo online y offline

El catálogo SQLite se crea en `data/sensor_catalog.sqlite3`.

- Incluye fichas iniciales de sensores comunes.
- Cuando hay internet, busca bajo demanda un resumen descriptivo y lo guarda.
- La información descargada se marca como `online-unverified`.
- Los límites eléctricos y pinouts deben venir de hojas de datos revisadas.
- Puede importar fichas JSON con **Importar ficha JSON**.

No existe una base confiable y finita de “todos los sensores posibles”. La
estrategia implementada es incremental: detecta nombres en el código, busca cada
modelo bajo demanda y conserva el resultado para trabajar sin conexión.

## Compatibilidad

El núcleo es independiente de la placa. Funciona con cualquier equipo capaz de
emitir JSON por un transporte implementado:

- Disponible ahora: serial/USB CDC (`COMx`, `/dev/ttyUSBx`, `/dev/ttyACMx`).
- Extensible: TCP, Bluetooth LE, HID, CAN mediante adaptador USB, SWD/JTAG.

Para añadir otro transporte, implemente una clase con `connect`, `disconnect`,
`send` y una devolución de objetos `Telemetry`.

## Seguridad eléctrica

No conecte señales de 5 V directamente a entradas que solo admiten 3.3 V.
Use adaptación de nivel, protección y límites de corriente. Nunca use el
prototipo para verificar equipos conectados a tensión de red.

## Subir el proyecto a GitHub

Desde una terminal ubicada dentro de esta carpeta:

```bash
git init
git add .
git commit -m "Initial commit: WireWatch MCU v0.1.0"
git branch -M main
git remote add origin https://github.com/USUARIO/wirewatch-mcu.git
git push -u origin main
```

Reemplace `USUARIO` por su nombre de usuario y cree primero un repositorio
vacío en GitHub. No active la creación automática de README, licencia o
`.gitignore`, porque esos archivos ya están incluidos.

## Pruebas

```bash
pip install -r requirements-dev.txt
python -m pytest
```

GitHub Actions ejecutará las pruebas automáticamente con Python 3.11, 3.12
y 3.13.
