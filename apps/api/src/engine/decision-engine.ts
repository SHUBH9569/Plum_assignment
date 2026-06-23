import type { ClaimInput, DecisionResult, PolicyTerms, TraceEntry } from "../types.js";
import { verifyDocuments } from "../agents/document-verifier.js";
import { extractStructuredData } from "../agents/extractor.js";
import { analyzeClaimWithAi } from "../agents/risk-analyzer.js";
import { adjudicateClaim } from "../agents/policy-adjudicator.js";

/**
 * Callback invoked after each agent phase completes, used by streaming routes
 * to emit live progress events to the client without coupling the engine to HTTP.
 */
export type AgentEventFn = (
  step: string,
  status: "PASS" | "FAIL" | "WARN" | "INFO",
  message: string,
  data?: Record<string, unknown>
) => void;

/**
 * Orchestrator: processClaim
 *
 * Coordinates four specialized agents in a gated pipeline:
 *
 *   Phase 1 (sequential, fail-fast)
 *     Agent 1 — DocumentVerifier  : type gate + readability + patient consistency
 *
 *   Phase 2 (parallel)
 *     Agent 2 — Extractor         : structured data extraction from document content
 *     Agent 3 — RiskAnalyzer      : LLM-powered fraud/risk assessment via Groq
 *
 *   Phase 3 (sequential, uses Phase 2 outputs)
 *     Agent 4 — PolicyAdjudicator : waiting periods, exclusions, pre-auth, fraud,
 *                                   line-items, network discount, copay → final decision
 *
 * The optional `onEvent` callback lets streaming HTTP routes emit live progress
 * events without any coupling between the engine and the transport layer.
 */
export async function processClaim(
  claim: ClaimInput,
  policy: PolicyTerms,
  onEvent?: AgentEventFn
): Promise<DecisionResult> {
  const trace: TraceEntry[] = [];
  let confidence = 0.95;

  // ── Member validation (not an agent — fast identity check before any agent runs) ──
  const member = policy.members.find((m) => m.member_id === claim.member_id);
  if (!member) {
    return {
      decision: null,
      approved_amount: 0,
      reasons: ["MEMBER_NOT_FOUND"],
      confidence_score: 0.99,
      trace: [
        {
          step: "member_validation",
          status: "FAIL",
          message: `Member ${claim.member_id} is not found in policy roster.`
        }
      ],
      user_message: "Member ID is invalid. Please verify your employee/member ID.",
      requires_resubmission: true
    };
  }
  trace.push({
    step: "member_validation",
    status: "PASS",
    message: `Member ${member.name} is eligible in roster.`
  });

  // ── Phase 1 — Agent 1: Document Verification ──────────────────────────────
  onEvent?.("agent_document_verify", "INFO", "Verifying uploaded documents against policy requirements.");
  const categoryRules = policy.document_requirements[claim.claim_category];
  const docCheck = verifyDocuments(claim, categoryRules.required);
  trace.push(...docCheck.trace);

  if (!docCheck.ok) {
    onEvent?.("agent_document_verify", "FAIL", docCheck.user_message ?? "Document verification failed.");
    return {
      decision: null,
      approved_amount: 0,
      reasons: ["DOCUMENT_VERIFICATION_FAILED"],
      confidence_score: 0.98,
      trace,
      user_message: docCheck.user_message,
      requires_resubmission: docCheck.needs_resubmission
    };
  }
  onEvent?.("agent_document_verify", "PASS", "All required documents verified successfully.");

  // ── Phase 2 — Agents 2 & 3: Parallel Execution ───────────────────────────
  // Extraction is synchronous today (reads in-memory document content fields).
  // It runs concurrently with the async AI risk analysis so the overall latency
  // equals max(extraction_time, ai_time) rather than their sum.
  onEvent?.("agent_extraction", "INFO", `Extracting structured data from ${claim.documents.length} document(s).`);
  onEvent?.("agent_risk_analysis", "INFO", "Running AI risk analysis in parallel (Groq llama-3.3-70b-versatile).");

  const [extraction, aiAnalysis] = await Promise.all([
    Promise.resolve(extractStructuredData(claim)),
    analyzeClaimWithAi(claim)
  ]);

  trace.push(...extraction.trace);
  confidence += extraction.confidenceDelta;
  onEvent?.(
    "agent_extraction",
    extraction.failedComponent ? "WARN" : "PASS",
    extraction.failedComponent
      ? `Extraction degraded — ${extraction.failedComponent} failed. Proceeding with partial data.`
      : `Extracted fields from ${claim.documents.length} document(s) successfully.`
  );

  trace.push(...aiAnalysis.trace);
  confidence += aiAnalysis.confidence_adjustment;
  onEvent?.(
    "agent_risk_analysis",
    aiAnalysis.risk_level === "HIGH" ? "WARN" : "PASS",
    `Risk: ${aiAnalysis.risk_level} · Recommendation: ${aiAnalysis.recommendation} · Provider: ${aiAnalysis.provider}`,
    {
      risk_level: aiAnalysis.risk_level,
      recommendation: aiAnalysis.recommendation,
      anomalies: aiAnalysis.anomalies,
      provider: aiAnalysis.provider
    }
  );

  // ── Phase 3 — Agent 4: Policy Adjudication ────────────────────────────────
  onEvent?.("agent_policy_adjudication", "INFO", "Applying policy rules — waiting periods, exclusions, fraud signals, financials.");
  const result = adjudicateClaim({ claim, policy, extraction, aiAnalysis, priorTrace: trace, confidence });

  onEvent?.(
    "agent_policy_adjudication",
    result.decision === "REJECTED"      ? "FAIL"
    : result.decision === "MANUAL_REVIEW" ? "WARN"
    : "PASS",
    `Decision: ${String(result.decision)} · Approved: ₹${result.approved_amount} · Confidence: ${(result.confidence_score * 100).toFixed(0)}%`,
    { decision: result.decision, approved_amount: result.approved_amount, reasons: result.reasons }
  );

  return result;
}
