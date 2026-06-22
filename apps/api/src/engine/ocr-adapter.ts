import OpenAI from "openai";

export interface OcrFileInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface OcrExtraction {
  text: string;
  fields: Record<string, unknown>;
  confidence: number;
  warnings: string[];
  provider: "openai" | "groq" | "heuristic";
}

export interface OcrAdapter {
  extract(file: OcrFileInput): Promise<OcrExtraction>;
}

export function createOcrAdapter(): OcrAdapter {
  const groqApiKey = process.env.GROQ_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const explicitProvider = (process.env.AI_PROVIDER ?? "").toLowerCase();

  // Auto-detect provider: explicit env > key availability
  const effectiveProvider =
    explicitProvider === "groq" && groqApiKey ? "groq"
    : explicitProvider === "openai" && openAiApiKey ? "openai"
    : groqApiKey ? "groq"
    : openAiApiKey ? "openai"
    : "heuristic";

  if (effectiveProvider === "groq" && groqApiKey) {
    const textModel = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
    // llama-3.2-90b-vision-preview supports image inputs on Groq
    const visionModel = process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";

    return new ModelOcrAdapter({
      client: new OpenAI({
        apiKey: groqApiKey,
        baseURL: "https://api.groq.com/openai/v1"
      }),
      textModel,
      visionModel,
      provider: "groq",
      supportsImage: true
    });
  }

  if (effectiveProvider === "openai" && openAiApiKey) {
    return new ModelOcrAdapter({
      client: new OpenAI({ apiKey: openAiApiKey }),
      textModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      visionModel: process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini",
      provider: "openai",
      supportsImage: true
    });
  }

  return new HeuristicOcrAdapter();
}

const EXTRACTION_SYSTEM_PROMPT =
  "You are an OCR and information extraction engine for Indian medical claim documents. " +
  "Extract all relevant fields and return ONLY valid JSON with these keys: " +
  "patient_name (string), diagnosis (string), doctor_name (string), doctor_registration (string), " +
  "hospital_name (string), total (number), treatment (string), " +
  "tests_ordered (array of strings), line_items (array of {description: string, amount: number}), " +
  "confidence (number 0-1), warnings (array of strings). " +
  "For Indian medical shorthand: HTN=Hypertension, T2DM=Type 2 Diabetes, URI=Upper Respiratory Infection. " +
  "If a field is not present, omit it rather than guessing.";

class ModelOcrAdapter implements OcrAdapter {
  private readonly client: OpenAI;
  private readonly textModel: string;
  private readonly visionModel: string;
  private readonly provider: "openai" | "groq";
  private readonly supportsImage: boolean;

  constructor(config: {
    client: OpenAI;
    textModel: string;
    visionModel: string;
    provider: "openai" | "groq";
    supportsImage: boolean;
  }) {
    this.client = config.client;
    this.textModel = config.textModel;
    this.visionModel = config.visionModel;
    this.provider = config.provider;
    this.supportsImage = config.supportsImage;
  }

  async extract(file: OcrFileInput): Promise<OcrExtraction> {
    const isText = isTextLike(file.mimeType, file.filename.toLowerCase());
    const warnings: string[] = [];

    if (isText) {
      return this.extractText(file, warnings);
    }

    if (isImageLike(file.mimeType)) {
      if (this.supportsImage) {
        return this.extractImage(file, warnings);
      }
      warnings.push(`${this.provider} vision not available for this file; falling back to heuristic.`);
    } else if (file.mimeType.includes("pdf")) {
      warnings.push("PDF binary received; attempting text extraction via heuristic fallback.");
    } else {
      warnings.push("Unsupported file type; using heuristic fallback.");
    }

    const fallback = new HeuristicOcrAdapter();
    const extracted = await fallback.extract(file);
    return { ...extracted, warnings: [...warnings, ...extracted.warnings] };
  }

  private async extractText(file: OcrFileInput, warnings: string[]): Promise<OcrExtraction> {
    const textPayload = file.buffer.toString("utf-8").slice(0, 20000);

    const completion = await this.retryWithBackoff(() =>
      this.withTimeout(
        this.client.chat.completions.create({
          model: this.textModel,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
            {
              role: "user",
              content: `Filename: ${file.filename}\nMIME: ${file.mimeType}\n\nDocument content:\n${textPayload}`
            }
          ]
        }),
        20000
      )
    );

    const structured = parseModelJson(completion.choices[0]?.message?.content ?? "{}");
    warnings.push(...toStringArray(structured.warnings));

    return {
      text: textPayload,
      fields: sanitizeFields(structured),
      confidence: normalizeConfidence(structured.confidence, 0.84),
      warnings,
      provider: this.provider
    };
  }

  private async extractImage(file: OcrFileInput, warnings: string[]): Promise<OcrExtraction> {
    const dataUrl = toDataUrl(file.mimeType, file.buffer);

    try {
      const completion = await this.retryWithBackoff(() =>
        this.withTimeout(
          this.client.chat.completions.create({
            model: this.visionModel,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
              {
                role: "user",
                content: [
                  { type: "text", text: `Extract all medical claim fields from this document image: ${file.filename}` },
                  { type: "image_url", image_url: { url: dataUrl } }
                ]
              }
            ]
          }),
          30000
        )
      );

      const structured = parseModelJson(completion.choices[0]?.message?.content ?? "{}");
      warnings.push(...toStringArray(structured.warnings));

      return {
        text: "",
        fields: sanitizeFields(structured),
        confidence: normalizeConfidence(structured.confidence, 0.78),
        warnings,
        provider: this.provider
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      warnings.push(`Vision extraction failed (${msg}); falling back to heuristic.`);
      const fallback = new HeuristicOcrAdapter();
      const extracted = await fallback.extract(file);
      return { ...extracted, warnings: [...warnings, ...extracted.warnings] };
    }
  }

  private async retryWithBackoff<T>(operation: () => Promise<T>, retries = 2): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 400 * Math.pow(2, attempt)));
        }
      }
    }
    throw lastError;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Extraction timed out after ${ms}ms`)), ms)
      )
    ]);
  }
}

class HeuristicOcrAdapter implements OcrAdapter {
  async extract(file: OcrFileInput): Promise<OcrExtraction> {
    const lowerName = file.filename.toLowerCase();
    const warnings: string[] = [];

    if (file.mimeType.includes("json") || lowerName.endsWith(".json")) {
      try {
        const parsed = JSON.parse(file.buffer.toString("utf-8")) as Record<string, unknown>;
        return {
          text: JSON.stringify(parsed),
          fields: sanitizeFields(parsed),
          confidence: 0.92,
          warnings,
          provider: "heuristic"
        };
      } catch {
        warnings.push("JSON document could not be parsed.");
      }
    }

    if (isTextLike(file.mimeType, lowerName)) {
      const raw = file.buffer.toString("utf-8");
      const fields = inferFieldsFromText(raw, lowerName);
      const confidence = Object.keys(fields).length >= 3 ? 0.72 : Object.keys(fields).length > 0 ? 0.58 : 0.40;
      if (confidence < 0.6) {
        warnings.push("Low-confidence heuristic extraction; consider enabling Groq or OpenAI for better results.");
      }
      return { text: raw, fields, confidence, warnings, provider: "heuristic" };
    }

    warnings.push(
      "Binary file received without AI provider configured. " +
      "Set GROQ_API_KEY in .env for real document extraction."
    );
    return {
      text: "",
      fields: inferFieldsFromFilename(lowerName),
      confidence: 0.35,
      warnings,
      provider: "heuristic"
    };
  }
}

function isImageLike(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isTextLike(mimeType: string, filename: string): boolean {
  return (
    mimeType.includes("text") ||
    mimeType.includes("xml") ||
    filename.endsWith(".txt") ||
    filename.endsWith(".csv") ||
    filename.endsWith(".md") ||
    filename.endsWith(".json")
  );
}

function toDataUrl(mimeType: string, buffer: Buffer): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function parseModelJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {}
    }
    return {};
  }
}

function normalizeConfidence(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(1, Math.max(0, value));
  }
  return fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function sanitizeFields(source: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "patient_name", "diagnosis", "doctor_name", "doctor_registration",
    "hospital_name", "total", "line_items", "tests_ordered", "treatment"
  ];
  return Object.fromEntries(
    allowed.filter((k) => source[k] !== undefined).map((k) => [k, source[k]])
  );
}

function inferFieldsFromText(text: string, filename: string): Record<string, unknown> {
  const fields: Record<string, unknown> = inferFieldsFromFilename(filename);

  const patientMatch = text.match(/patient\s*(?:name)?\s*[:=-]\s*([^\n\r,;]{2,60})/i);
  if (patientMatch?.[1]) fields.patient_name = patientMatch[1].trim();

  const diagnosisMatch = text.match(/(?:diagnosis|impression|dx)\s*[:=-]\s*([^\n\r]{3,100})/i);
  if (diagnosisMatch?.[1]) fields.diagnosis = diagnosisMatch[1].trim();

  const doctorMatch = text.match(/(?:dr|doctor|physician)\s*\.?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
  if (doctorMatch?.[1]) fields.doctor_name = `Dr. ${doctorMatch[1]}`;

  const totalMatch = text.match(/(?:total|net amount|grand total)\s*(?:amount)?\s*[:=-]?\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
  if (totalMatch?.[1]) fields.total = Number(totalMatch[1].replace(/,/g, ""));

  const hospitalMatch = text.match(/(?:hospital|clinic|centre|center|medical)\s*[:,-]?\s*([^\n\r]{3,60})/i);
  if (hospitalMatch?.[1]) fields.hospital_name = hospitalMatch[1].trim();

  return fields;
}

function inferFieldsFromFilename(filename: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (filename.includes("bill") || filename.includes("invoice")) fields.document_hint = "BILL_LIKE";
  if (filename.includes("prescription") || filename.includes("rx")) fields.document_hint = "PRESCRIPTION_LIKE";
  if (filename.includes("lab") || filename.includes("diagnostic") || filename.includes("report")) fields.document_hint = "LAB_REPORT_LIKE";
  return fields;
}
