import OpenAI from "openai";
import type { ClaimInput, TraceEntry } from "../types.js";

export interface AiAnalysis {
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  anomalies: string[];
  recommendation: "APPROVE" | "REJECT" | "MANUAL_REVIEW" | "UNCERTAIN";
  reasoning: string;
  confidence_adjustment: number;
  normalized_diagnosis?: string;
  normalized_treatment?: string;
  trace: TraceEntry[];
  provider: "openai" | "groq" | "skipped";
}

/**
 * Agent: RiskAnalyzer
 *
 * Input : ClaimInput
 * Output: AiAnalysis
 * Errors: Never throws — falls back to { risk_level: "LOW", recommendation: "UNCERTAIN" } on any failure
 *
 * Responsibilities:
 *   1. Call Groq/OpenAI LLM to assess fraud risk, policy alignment, and anomalies
 *   2. Normalize diagnosis and treatment terminology
 *   3. Return structured risk assessment + confidence adjustment
 *   4. Degrade gracefully: timeout, provider unavailable, or parse failure → WARN trace + UNCERTAIN
 */

const CLAIM_ANALYSIS_SYSTEM_PROMPT = `You are an AI-powered health insurance claims adjudication assistant for an Indian health insurer.
Your job is to analyze claim details and return a structured risk assessment.

Return ONLY a valid JSON object with these keys:
- risk_level: "LOW" | "MEDIUM" | "HIGH" — overall risk of the claim being fraudulent, excessive, or policy-misaligned
- anomalies: array of strings — any suspicious patterns, mismatches, or red flags you detect (empty array if none)
- recommendation: "APPROVE" | "REJECT" | "MANUAL_REVIEW" | "UNCERTAIN" — your recommendation based on available data
- reasoning: string — one concise paragraph explaining your assessment
- confidence_adjustment: number between -0.3 and +0.1 — how much to adjust the system confidence score
- normalized_diagnosis: string — standardized medical diagnosis term (if identifiable from input)
- normalized_treatment: string — standardized treatment description (if identifiable from input)

Guidelines:
- Be conservative: when in doubt, recommend MANUAL_REVIEW rather than REJECT
- Flag if claimed amount seems unusually high for the category and Indian market rates
- Flag if diagnosis does not match the claim category (e.g., surgery billed as CONSULTATION)
- Flag missing doctor registration for specialist consultations
- Do NOT invent data — only analyze what is provided
- For CONSULTATION: typical Indian OPD consult is INR 200–2000; flag if above INR 5000
- For DIAGNOSTIC: reasonable range INR 500–15000; flag MRI/CT above INR 20000 without pre-auth
- For PHARMACY: flag if no matching diagnosis or if amount seems bulk
`;

function createAiClient(): { client: OpenAI; textModel: string; provider: "openai" | "groq" } | null {
  const groqApiKey = process.env.GROQ_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const explicitProvider = (process.env.AI_PROVIDER ?? "").toLowerCase();

  if ((explicitProvider === "groq" || (!explicitProvider && groqApiKey)) && groqApiKey) {
    return {
      client: new OpenAI({ apiKey: groqApiKey, baseURL: "https://api.groq.com/openai/v1" }),
      textModel: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
      provider: "groq"
    };
  }

  if ((explicitProvider === "openai" || (!explicitProvider && openAiApiKey)) && openAiApiKey) {
    return {
      client: new OpenAI({ apiKey: openAiApiKey }),
      textModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      provider: "openai"
    };
  }

  return null;
}

function buildClaimSummary(claim: ClaimInput): string {
  const docContents = claim.documents.map((d) => ({
    type: d.actual_type,
    quality: d.quality,
    content: d.content ?? {}
  }));

  return JSON.stringify(
    {
      member_id: claim.member_id,
      claim_category: claim.claim_category,
      treatment_date: claim.treatment_date,
      claimed_amount: claim.claimed_amount,
      hospital_name: claim.hospital_name,
      ytd_claims_amount: claim.ytd_claims_amount,
      claims_history_count: claim.claims_history?.length ?? 0,
      documents: docContents
    },
    null,
    2
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`AI analysis timed out after ${ms}ms`)), ms)
    )
  ]);
}

function parseAiJson(raw: string): Record<string, unknown> {
  try {
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v) => typeof v === "string");
}

function normalizeRiskLevel(val: unknown): AiAnalysis["risk_level"] {
  if (val === "LOW" || val === "MEDIUM" || val === "HIGH") return val;
  return "MEDIUM";
}

function normalizeRecommendation(val: unknown): AiAnalysis["recommendation"] {
  if (val === "APPROVE" || val === "REJECT" || val === "MANUAL_REVIEW" || val === "UNCERTAIN") return val;
  return "UNCERTAIN";
}

function normalizeConfidenceAdj(val: unknown): number {
  const n = typeof val === "number" ? val : 0;
  return Math.max(-0.3, Math.min(0.1, n));
}

export async function analyzeClaimWithAi(claim: ClaimInput): Promise<AiAnalysis> {
  const trace: TraceEntry[] = [];
  const aiClient = createAiClient();

  if (!aiClient) {
    trace.push({
      step: "ai_analysis",
      status: "WARN",
      message: "No AI provider configured (GROQ_API_KEY / OPENAI_API_KEY missing). Skipping AI analysis — set one in .env to enable."
    });
    return {
      risk_level: "LOW",
      anomalies: [],
      recommendation: "UNCERTAIN",
      reasoning: "AI analysis skipped — no provider configured.",
      confidence_adjustment: 0,
      trace,
      provider: "skipped"
    };
  }

  const claimSummary = buildClaimSummary(claim);

  try {
    const completion = await withTimeout(
      aiClient.client.chat.completions.create({
        model: aiClient.textModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: CLAIM_ANALYSIS_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Analyze this insurance claim and return your structured assessment:\n\n${claimSummary}`
          }
        ]
      }),
      25000
    );

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = parseAiJson(raw);

    const anomalies = toStringArray(parsed.anomalies);
    const riskLevel = normalizeRiskLevel(parsed.risk_level);
    const recommendation = normalizeRecommendation(parsed.recommendation);
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "No reasoning provided.";
    const confidenceAdj = normalizeConfidenceAdj(parsed.confidence_adjustment);

    trace.push({
      step: "ai_analysis",
      status: riskLevel === "HIGH" ? "WARN" : "PASS",
      message: `AI analysis complete via ${aiClient.provider}. Risk: ${riskLevel}. Recommendation: ${recommendation}.`,
      data: {
        provider: aiClient.provider,
        model: aiClient.textModel,
        risk_level: riskLevel,
        recommendation,
        anomalies,
        reasoning,
        confidence_adjustment: confidenceAdj,
        normalized_diagnosis: parsed.normalized_diagnosis,
        normalized_treatment: parsed.normalized_treatment
      }
    });

    return {
      risk_level: riskLevel,
      anomalies,
      recommendation,
      reasoning,
      confidence_adjustment: confidenceAdj,
      normalized_diagnosis: typeof parsed.normalized_diagnosis === "string" ? parsed.normalized_diagnosis : undefined,
      normalized_treatment: typeof parsed.normalized_treatment === "string" ? parsed.normalized_treatment : undefined,
      trace,
      provider: aiClient.provider
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown AI analysis error.";
    trace.push({
      step: "ai_analysis",
      status: "WARN",
      message: `AI analysis failed: ${message}. Proceeding with rule-based checks only.`,
      data: { error: message, provider: aiClient.provider }
    });
    return {
      risk_level: "LOW",
      anomalies: [],
      recommendation: "UNCERTAIN",
      reasoning: `AI analysis failed: ${message}`,
      confidence_adjustment: -0.05,
      trace,
      provider: aiClient.provider
    };
  }
}
