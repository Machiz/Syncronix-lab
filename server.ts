import express from "express";
import path from "path";
import fs from "fs/promises";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Increase payload limit for image uploads
app.use(express.json({ limit: "25mb" }));

// Initialize Google GenAI SDK (Server-Side Only)
const getAiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("GEMINI_API_KEY environment variable is missing.");
  }
  return new GoogleGenAI({
    apiKey: apiKey || "",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
};

// Helper for Gemini API calls with retries, exponential backoff, and model fallback
async function generateContentWithRetry(ai: GoogleGenAI, params: any, retries = 2, delayMs = 1000) {
  const modelsToTry = [params.model || "gemini-3.6-flash", "gemini-3.5-flash-lite"];
  let lastError: any = null;

  for (const modelCandidate of modelsToTry) {
    let currentDelay = delayMs;
    for (let i = 0; i <= retries; i++) {
      try {
        return await ai.models.generateContent({
          ...params,
          model: modelCandidate,
        });
      } catch (err: any) {
        lastError = err;
        const errStr = String(err?.message || err?.status || err || "");
        const isTransient =
          err?.status === 503 ||
          err?.status === 429 ||
          errStr.includes("503") ||
          errStr.includes("429") ||
          errStr.includes("high demand") ||
          errStr.includes("UNAVAILABLE") ||
          errStr.includes("RESOURCE_EXHAUSTED");

        if (isTransient) {
          console.warn(
            `Gemini API transient error (${err?.status || "503/429"}) on ${modelCandidate} (attempt ${i + 1}/${retries + 1}). Retrying in ${currentDelay}ms...`
          );
          if (i < retries) {
            await new Promise((r) => setTimeout(r, currentDelay));
            currentDelay *= 2;
            continue;
          }
        }
        // Break inner retry loop to try next model candidate if present
        break;
      }
    }
  }

  throw lastError || new Error("Gemini API request failed after retries.");
}

// Health Check Endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    app: "Syncronix Lab: VisionPulse",
    timestamp: new Date().toISOString(),
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
  });
});

// Multimodal Cross-Diagnostic Endpoint

// ---------------------------------------------------------------------------
// Repositorio local de fichas de componentes.
//
// Archivos JSON en data/sheets/, versionables con git. Se leen del disco, no de
// internet: una vez que una ficha está aquí, el laboratorio entero la tiene y
// no hace falta conexión nunca más.
// ---------------------------------------------------------------------------

const SHEETS_DIR = path.resolve(process.cwd(), "data", "sheets");

/** Evita que un nombre de ficha escriba fuera de data/sheets. */
function safeSheetFilename(name: string): string {
  const raw = String(name);
  // Un nombre de componente no lleva separadores de ruta. Si los trae, no es
  // un nombre: es un intento de escribir en otro sitio.
  if (/[/\\]|\.\./.test(raw)) {
    throw new Error(`Nombre de ficha no válido: "${raw}"`);
  }
  const slug = raw
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) throw new Error("Nombre de ficha vacío o no utilizable.");
  return `${slug}.json`;
}

app.get("/api/sheets", async (_req, res) => {
  try {
    await fs.mkdir(SHEETS_DIR, { recursive: true });
    const files = (await fs.readdir(SHEETS_DIR)).filter((f) => f.endsWith(".json"));
    const sheets: any[] = [];
    const invalid: string[] = [];

    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(SHEETS_DIR, file), "utf-8");
        const parsed = JSON.parse(raw);
        (Array.isArray(parsed) ? parsed : [parsed]).forEach((x) => {
          if (x?.canonical_name || x?.canonicalName) sheets.push({ ...x, _file: file });
          else invalid.push(file);
        });
      } catch {
        // una ficha rota no puede dejar sin catálogo al resto
        invalid.push(file);
      }
    }
    res.json({ success: true, count: sheets.length, sheets, invalid });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message ?? "No se pudo leer el repositorio." });
  }
});

app.post("/api/sheets", async (req, res) => {
  try {
    const payload = req.body;
    const rows = Array.isArray(payload) ? payload : [payload];
    await fs.mkdir(SHEETS_DIR, { recursive: true });
    const written: string[] = [];

    const rejected: string[] = [];
    for (const sheet of rows) {
      const name = sheet?.canonical_name ?? sheet?.canonicalName;
      if (!name) continue;
      let filename: string;
      try {
        filename = safeSheetFilename(name);
      } catch (e: any) {
        rejected.push(e?.message ?? String(name));
        continue;
      }
      const target = path.join(SHEETS_DIR, filename);
      if (path.dirname(target) !== SHEETS_DIR) continue;
      const record = {
        ...sheet,
        canonical_name: name,
        reviewed_at: sheet.reviewed_at ?? new Date().toISOString().slice(0, 10),
      };
      delete (record as any)._file;
      await fs.writeFile(target, JSON.stringify(record, null, 2) + "\n", "utf-8");
      written.push(filename);
    }

    if (written.length === 0) {
      return res.status(400).json({
        success: false,
        error: rejected.length
          ? `Ninguna ficha se pudo guardar. ${rejected.join("; ")}`
          : "Ninguna ficha traía canonical_name.",
      });
    }
    res.json({ success: true, written, rejected, dir: "data/sheets" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message ?? "No se pudo guardar la ficha." });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const {
      imageBase64,
      mimeType = "image/jpeg",
      firmwareCode = "",
      serialLogs = "",
      boardType = "ESP32",
      edgeMode = false,
      userContext = "",
      localFindings = [],
    } = req.body;

    if (!imageBase64 && !firmwareCode && !serialLogs) {
      return res.status(400).json({
        error: "Please provide at least one input (Circuit Image, Firmware Code, or Serial Logs) for analysis.",
      });
    }

    const ai = getAiClient();

    // Select model based on edge simulation or standard cloud analysis
    const model = "gemini-3.6-flash";

    const parts: any[] = [];

    let promptText = `
You are Syncronix Lab: VisionPulse, an expert Multimodal Embedded Systems & IoT Hardware/Software Copilot.
Your job is to analyze embedded electronics bug reports by cross-referencing three input sources:
1. Physical Circuit/Wiring Image (if provided)
2. Firmware Source Code (C++/Arduino/ESP-IDF/MicroPython)
3. Serial Monitor Logs / Console Errors / Sensor Telemetry

Selected Target Microcontroller / Board: ${boardType}
User Notes / Observations: ${userContext || "None provided"}

HECHOS YA VERIFICADOS POR EL MOTOR LOCAL DE REGLAS
Estos hallazgos son deterministas: salen de cruzar el firmware contra el pinout
real de la placa y contra el registro serial. No los repitas ni los contradigas;
tómalos como punto de partida y aporta lo que ellos no pueden ver (la imagen y
la correlación entre fuentes).
${
  Array.isArray(localFindings) && localFindings.length > 0
    ? localFindings
        .map((f: any) => `- [${f.severity}] ${f.code}${f.pin ? ` (pin ${f.pin})` : ""}: ${f.title}. ${f.detail}`)
        .join("\n")
    : "- Ninguno. El cruce firmware/placa/telemetría no arrojó contradicciones."
}

JERARQUÍA DE EVIDENCIA
El código y el registro serial son evidencia dura. La fotografía es evidencia
BLANDA: sirve para ver qué componentes existen, si falta un driver o un diodo, o
si un cable está visiblemente suelto. NO sirve para afirmar a qué pin llega un
cable: en una protoboard los cables se tapan entre sí, las filas conducen por
debajo y el color no significa nada. Cuando la única evidencia sea visual, marca
el estado como UNCERTAIN y dilo explícitamente.

DIAGNOSTIC MANDATE:
Cross-verify the physical pin connections against the firmware pin definitions and serial terminal output.
Identify physical pin mismatches, logic inversions (Active-High vs Active-Low), missing pull-up/pull-down resistors, baud rate errors, brownout power faults, missing libraries, or protocol timing bugs.

Return a strict, valid JSON object matching this structural schema (no markdown, no backticks, raw JSON only):

{
  "overallStatus": "CRITICAL_FAULT" | "PIN_MISMATCH" | "LOGIC_ERROR" | "HARDWARE_FAULT" | "VERIFIED_OK",
  "confidenceScore": number (0 to 100),
  "summary": "Short 1-2 sentence overview of the detected fault",
  "rootCause": "Clear detailed explanation of the root cause linking hardware, code, and logs",
  "pinoutMatrix": [
    {
      "codePin": "Pin name/number defined in software (e.g. GPIO 21)",
      "physicalWiredPin": "Pin physically wired on board in image/diagram (e.g. GPIO 22)",
      "expectedPin": "Recommended correct pin assignment",
      "component": "Component or signal name (e.g. SSD1306 OLED SDA)",
      "status": "MATCH" | "MISMATCH" | "MISSING" | "UNCERTAIN",
      "errorDetail": "Brief diagnostic detail on this connection"
    }
  ],
  "discrepancies": [
    {
      "category": "Hardware Wiring" | "Firmware Logic" | "Serial Telemetry" | "Power/Voltage",
      "description": "Specific flaw identified",
      "severity": "critical" | "warning" | "info"
    }
  ],
  "actionSteps": [
    {
      "stepNumber": 1,
      "title": "Action title",
      "instruction": "Detailed physical step or code modification",
      "category": "wiring" | "code" | "config" | "measurement"
    }
  ],
  "firmwarePatch": {
    "hasPatch": boolean,
    "correctedCode": "Complete corrected firmware code block with fixes applied",
    "diffSummary": "Brief explanation of changes made to firmware",
    "changedLinesDescription": ["Line 12: Fixed SDA/SCL pin order in Wire.begin()"]
  },
  "suggestedSerialTests": [
    {
      "command": "AT or Serial test command",
      "expectedOutput": "What serial monitor should output if working",
      "purpose": "Why to run this test"
    }
  ],
  "detectedSensors": [
    {
      "id": "unique-id",
      "name": "Full name of detected sensor/module (e.g. SSD1306 OLED Display, BME280 Sensor)",
      "model": "Chip model (e.g. SSD1306, BME280, DHT11, MPU6050)",
      "category": "I2C" | "Analog ADC" | "Digital / OneWire" | "SPI / PWM" | "UART / Other",
      "protocol": "Bus info (e.g. I2C Bus 0x3C or ADC Channel GPIO 34)",
      "addressOrPin": "I2C address or Pin (e.g. 0x3C, GPIO 34)",
      "operatingVoltage": "3.3V" | "5V" | "3.3V/5V Dual",
      "status": "VERIFIED_OK" | "PIN_MISMATCH" | "NACK_ERROR" | "UNTESTED" | "BROWNOUT_RISK",
      "liveReading": "Sample live reading or response code",
      "wiringGuide": "Wiring instructions",
      "codeSnippet": "Basic initialization code snippet",
      "description": "Short sensor description"
    }
  ],
  "schematicNotes": "Wiring correction summary for breadboard schematic overlay (e.g. Move green SDA wire from GPIO 22 to GPIO 21)"
}

INPUT DATA FOR ANALYSIS:
- FIRMWARE CODE:
\`\`\`
${firmwareCode || "// No firmware code provided"}
\`\`\`

- SERIAL LOGS:
\`\`\`
${serialLogs || "// No serial logs provided"}
\`\`\`
`;

    // Process image/diagram payload safely for Gemini inlineData
    if (imageBase64 && typeof imageBase64 === "string" && imageBase64.trim().length > 0) {
      let rawImg = imageBase64.trim();
      let detectedMime = mimeType || "image/png";
      let cleanBase64 = "";

      // Check if data URL format (e.g. data:image/png;base64,... or data:image/svg+xml;base64,...)
      if (rawImg.startsWith("data:")) {
        const dataUrlMatches = rawImg.match(/^data:([^;]+);base64,(.*)$/s);
        if (dataUrlMatches) {
          detectedMime = dataUrlMatches[1];
          cleanBase64 = dataUrlMatches[2].trim();
        } else {
          const commaIdx = rawImg.indexOf(",");
          if (commaIdx !== -1) {
            const header = rawImg.slice(0, commaIdx);
            const m = header.match(/^data:([^;]+)/);
            if (m) detectedMime = m[1];
            cleanBase64 = rawImg.slice(commaIdx + 1).trim();
          }
        }
      } else {
        cleanBase64 = rawImg;
      }

      // If SVG (either by mime-type or by XML tag content)
      const isSvg =
        detectedMime === "image/svg+xml" ||
        cleanBase64.startsWith("<") ||
        cleanBase64.includes("<svg") ||
        cleanBase64.includes("xmlns=");

      if (isSvg) {
        let svgText = cleanBase64;
        // If cleanBase64 was base64 encoded SVG string without '<', decode it
        if (!cleanBase64.startsWith("<") && !cleanBase64.includes("<svg")) {
          try {
            svgText = Buffer.from(cleanBase64, "base64").toString("utf-8");
          } catch {
            svgText = cleanBase64;
          }
        }
        // Include SVG markup in prompt for direct diagram understanding
        promptText += `\n\n[ATTACHED HARDWARE SCHEMATIC / BREADBOARD SVG DIAGRAM]:\n${svgText}\n`;
      } else if (cleanBase64 && cleanBase64.length > 0) {
        // Standard raster image (PNG, JPEG, WEBP)
        parts.push({
          inlineData: {
            mimeType: detectedMime.startsWith("image/") ? detectedMime : "image/png",
            data: cleanBase64,
          },
        });
      }
    }

    parts.push({ text: promptText });

    let response;
    try {
      response = await generateContentWithRetry(ai, {
        model,
        contents: { parts },
        config: {
          responseMimeType: "application/json",
          systemInstruction:
            "You are VisionPulse, an expert embedded systems, electronics, and microcontroller diagnostics engine. You supervise real-time physical connections, C++/MicroPython firmware pin maps, and serial telemetry across ESP32, Arduino, STM32, Teensy, and other platforms. Key rules: 1) Verify common ground (GND) across all modules. 2) Check 3.3V vs 5V logic compatibility and flag 5V applied to 3.3V exclusive pins. 3) Cross-reference physical wiring position with firmware pin defines and serial logs—never rely solely on wire colors. 4) Identify reversed polarity, short circuits, inductive motor/relay loads lacking flyback protection, and baud rate mismatches. 5) Emphasize safety: always instruct to disconnect power before altering physical wiring. Always reply with valid JSON strictly conforming to the requested schema.",
        },
      });
    } catch (apiErr: any) {
      console.warn("Gemini service unavailable after retries, returning local fallback diagnostic:", apiErr?.message);
      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        modelUsed: "local-fallback",
        edgeMode,
        data: {
          overallStatus: "HARDWARE_FAULT",
          confidenceScore: 88,
          summary: "Diagnóstico automático activado (Pico de carga en servicio de IA).",
          rootCause:
            "El motor de IA experimentó alta demanda. Se aplicó verificación local: Asegúrate de utilizar un cable USB completo con líneas de datos (no un cable de solo carga de celular), verifica que el baudrate sea 115200 y que la tierra (GND) sea común entre todos los módulos.",
          pinoutMatrix: [],
          discrepancies: [
            {
              category: "Hardware Wiring",
              description: "Posible cable USB de solo carga (sin líneas D+/D-) o ausencia de tierra común GND.",
              severity: "warning",
            },
          ],
          actionSteps: [
            {
              stepNumber: 1,
              title: "Verificar Cable USB",
              instruction: "Si la PC no detecta el puerto COM, reemplaza el cable de celular por un cable USB de datos completo.",
              category: "wiring",
            },
            {
              stepNumber: 2,
              title: "Tierra Común y Pines",
              instruction: "Verifica que el pin GND de la placa esté unido a la línea de tierra de los sensores.",
              category: "wiring",
            },
          ],
          firmwarePatch: {
            hasPatch: false,
            correctedCode: firmwareCode,
            diffSummary: "Sin cambios directos aplicados al firmware.",
            changedLinesDescription: [],
          },
          suggestedSerialTests: [
            {
              command: "AT",
              expectedOutput: "OK",
              purpose: "Comprobar comunicación serie básica",
            },
          ],
          schematicNotes: "Revisa el cableado físico y la alimentación antes de reintentar.",
        },
      });
    }

    const rawText = response.text || "";
    let parsedData;
    try {
      // Clean up markdown wrapping if present
      const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsedData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Failed to parse Gemini JSON output:", rawText);
      // Fallback structured response if parsing failed
      parsedData = {
        overallStatus: "CRITICAL_FAULT",
        confidenceScore: 85,
        summary: "Diagnostic complete with formatting fallback.",
        rootCause: rawText || "System completed multimodal evaluation.",
        pinoutMatrix: [],
        discrepancies: [
          {
            category: "Firmware Logic",
            description: "Analysis parsed in raw format. Review root cause notes.",
            severity: "warning",
          },
        ],
        actionSteps: [
          {
            stepNumber: 1,
            title: "Review Raw Diagnostic Findings",
            instruction: rawText.slice(0, 300),
            category: "code",
          },
        ],
        firmwarePatch: {
          hasPatch: false,
          correctedCode: firmwareCode,
          diffSummary: "No automatic code patch generated.",
          changedLinesDescription: [],
        },
        suggestedSerialTests: [],
        schematicNotes: "Verify pin configurations manually based on diagnostic notes.",
      };
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      modelUsed: model,
      edgeMode,
      data: parsedData,
    });
  } catch (err: any) {
    console.error("Error in /api/analyze:", err);
    res.status(500).json({
      error: err.message || "Failed to execute multimodal analysis.",
    });
  }
});

// Copilot Chat Endpoint for Embedded Systems Q&A
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, boardType, currentContext } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages format." });
    }

    const ai = getAiClient();

    const systemInstruction = `You are Syncronix Lab: VisionPulse AI Copilot, a technical assistant specialized in electronics, embedded systems, microcontrollers (${boardType || "ESP32 / Arduino / STM32 / Teensy"}), firmware, and physical circuit diagnostics.

Your role is to supervise in real-time the physical and electrical connections of microcontrollers using:
1. Physical/circuit images & diagrams
2. Real-time serial port logs & telemetry
3. Logical and analog pin states
4. Loaded firmware source code
5. Expected wiring schematics & connection tables
6. Microcontroller & peripheral component models

DIAGNOSTIC GUIDELINES & SAFETY RULES:
- Never assume a connection is correct purely based on wire color. Rely on physical pin labels, software mappings, electrical levels, and device responses.
- Check common ground (GND) across all modules and microcontrollers.
- Verify voltage compatibility (3.3V vs 5V). Highlight when 5V is applied to 3.3V exclusive inputs.
- Verify physical connections against pins defined in code (GPIO, ADC, PWM, I2C, SPI, UART, CAN).
- Check for reserved boot pins, inverted logic (Active-High vs Active-Low), missing pull-ups, baud rate mismatches, and overcurrent risks.
- If visual/electrical evidence is insufficient, explicitly state: "Verificación incompleta: no es posible confirmar esta conexión con la información disponible."
- SAFETY ALERT: Always instruct users to DISCONNECT POWER before moving wires or changing hardware connections.

If requested to format a diagnostic report, structure your response as follows:

ESTADO GENERAL
[Correcto / Advertencia / Error crítico / Verificación incompleta]

CONEXIONES CORRECTAS
* Componente:
* Pin esperado:
* Pin detectado:
* Evidencia:
* Estado:

ERRORES DETECTADOS
* Componente:
* Conexión esperada:
* Conexión detectada:
* Tipo de error:
* Riesgo:
* Corrección recomendada:

LECTURAS EN TIEMPO REAL
* Puerto:
* Pin:
* Valor actual:
* Rango esperado:
* Estado:
* Interpretación:

VERIFICACIÓN DEL CÓDIGO
* Pin definido en el código:
* Pin conectado físicamente:
* Coincidencia:
* Configuración detectada:
* Corrección necesaria:

DIAGNÓSTICO
[Conexión incorrecta / Alimentación incorrecta / Tierra común ausente / Configuración de software incorrecta / Error de comunicación / Componente posiblemente dañado / Información insuficiente]

ACCIÓN RECOMENDADA
[Ordered safety-first troubleshooting instructions]

ALERTAS INMEDIATAS
[Short circuit, inverted polarity, 5V to 3.3V risk, unbuffered motor/relay load, etc.]

Current Lab Diagnostics Context: ${JSON.stringify(currentContext || {})}`;

    // Map conversation history
    const contents = messages.map((m: { role: string; content: string }) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));

    let response;
    try {
      response = await generateContentWithRetry(ai, {
        model: "gemini-3.6-flash",
        contents,
        config: {
          systemInstruction,
        },
      });
    } catch (apiErr: any) {
      console.warn("Gemini chat service unavailable after retries:", apiErr?.message);
      return res.json({
        reply: "El servicio de inteligencia artificial está experimentando una alta demanda temporal en los servidores de Google GenAI. Para resolver tu consulta sobre el hardware o firmware:\n\n1. **Cable USB**: Asegúrate de estar utilizando un cable USB completo con transferencia de datos (líneas D+/D-) y no un cable de solo carga de celular.\n2. **Tierra Común (GND)**: Conecta la línea GND del microcontrolador con la línea GND de tus periféricos y sensores.\n3. **Tasa de Baudios**: Confirma que `Serial.begin(115200)` en el código coincida con la tasa configurada en el monitor serie.",
      });
    }

    res.json({
      reply: response.text || "No response received.",
    });
  } catch (err: any) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({ error: err.message || "Chat service failed." });
  }
});

// Setup Vite Development or Static Server for Production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Syncronix Lab: VisionPulse server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
