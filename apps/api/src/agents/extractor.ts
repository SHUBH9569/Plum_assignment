import type { ClaimInput, TraceEntry } from "../types.js";

export interface ExtractionResult {
  extracted: Record<string, unknown>;
  trace: TraceEntry[];
  confidenceDelta: number;
  failedComponent?: string;
}

/**
 * Agent: Extractor
 *
 * Input : ClaimInput (reads document content fields)
 * Output: ExtractionResult
 * Errors: Never throws — returns partial extraction + WARN trace on component failure
 *
 * Responsibilities:
 *   1. Merge structured fields across all submitted documents
 *   2. Simulate graceful degradation when a downstream OCR component fails
 *   3. Emit trace entry with the full extracted payload for observability
 */
export function extractStructuredData(claim: ClaimInput): ExtractionResult {
  const trace: TraceEntry[] = [];

  if (claim.simulate_component_failure) {
    trace.push({
      step: "document_extraction",
      status: "WARN",
      message: "Extraction component failure simulated. Proceeding with partial data.",
      data: { component: "vision_ocr_parser" }
    });

    return {
      extracted: {
        diagnosis: firstDefined(claim.documents.map((d) => d.content?.diagnosis)),
        treatment: firstDefined(claim.documents.map((d) => d.content?.treatment)),
        line_items: firstDefined(claim.documents.map((d) => d.content?.line_items)),
        total: firstDefined(claim.documents.map((d) => d.content?.total)) ?? claim.claimed_amount
      },
      trace,
      confidenceDelta: -0.2,
      failedComponent: "vision_ocr_parser"
    };
  }

  const extracted = {
    diagnosis:           firstDefined(claim.documents.map((d) => d.content?.diagnosis)),
    tests_ordered:       firstDefined(claim.documents.map((d) => d.content?.tests_ordered)),
    treatment:           firstDefined(claim.documents.map((d) => d.content?.treatment)),
    line_items:          firstDefined(claim.documents.map((d) => d.content?.line_items)),
    total:               firstDefined(claim.documents.map((d) => d.content?.total)) ?? claim.claimed_amount,
    doctor_registration: firstDefined(claim.documents.map((d) => d.content?.doctor_registration)),
    hospital_name:       claim.hospital_name ?? firstDefined(claim.documents.map((d) => d.content?.hospital_name))
  };

  trace.push({
    step: "document_extraction",
    status: "PASS",
    message: "Structured data extracted from documents.",
    data: { extracted }
  });

  return { extracted, trace, confidenceDelta: 0 };
}

function firstDefined(values: Array<unknown>): unknown {
  return values.find((v) => v !== undefined && v !== null);
}
