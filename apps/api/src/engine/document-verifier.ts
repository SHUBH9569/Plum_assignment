import type { ClaimInput, TraceEntry } from "../types.js";

export interface DocumentVerificationResult {
  ok: boolean;
  trace: TraceEntry[];
  user_message?: string;
  needs_resubmission?: boolean;
}

export function verifyDocuments(claim: ClaimInput, requiredTypes: string[]): DocumentVerificationResult {
  const trace: TraceEntry[] = [];
  const uploadedTypes = claim.documents.map((d) => d.actual_type);

  const missing = requiredTypes.filter((req) => !uploadedTypes.includes(req));
  const unexpected = uploadedTypes.filter((type) => !requiredTypes.includes(type));

  if (missing.length > 0 || unexpected.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`Missing required document(s): ${missing.join(", ")}`);
    }
    if (unexpected.length > 0) {
      parts.push(`Uploaded document type(s) not sufficient for this claim: ${unexpected.join(", ")}`);
    }

    trace.push({
      step: "document_requirements",
      status: "FAIL",
      message: "Document verification failed.",
      data: { requiredTypes, uploadedTypes, missing, unexpected }
    });

    return {
      ok: false,
      trace,
      user_message: `${parts.join(". ")}. Please upload the exact missing document type(s).`,
      needs_resubmission: true
    };
  }

  const unreadableDoc = claim.documents.find((d) => d.quality === "UNREADABLE");
  if (unreadableDoc) {
    trace.push({
      step: "document_readability",
      status: "FAIL",
      message: `Document ${unreadableDoc.file_id} is unreadable and requires re-upload.`
    });

    return {
      ok: false,
      trace,
      user_message: `The document ${unreadableDoc.file_name ?? unreadableDoc.file_id} (${unreadableDoc.actual_type}) is unreadable. Please re-upload a clear copy of this specific document.`,
      needs_resubmission: true
    };
  }

  const nameValues = claim.documents
    .map((d) => d.patient_name_on_doc ?? (d.content?.patient_name as string | undefined))
    .filter((name): name is string => Boolean(name));

  const distinctNames = Array.from(new Set(nameValues.map((name) => name.trim().toLowerCase())));
  if (distinctNames.length > 1) {
    const pairs = claim.documents
      .map((d) => ({
        file: d.file_name ?? d.file_id,
        patient: d.patient_name_on_doc ?? (d.content?.patient_name as string | undefined) ?? "Unknown"
      }))
      .filter((p) => p.patient !== "Unknown");

    trace.push({
      step: "cross_document_patient_consistency",
      status: "FAIL",
      message: "Documents appear to belong to different patients.",
      data: { pairs }
    });

    const pairText = pairs.map((p) => `${p.file}: ${p.patient}`).join("; ");
    return {
      ok: false,
      trace,
      user_message: `Patient mismatch detected across documents. Found names: ${pairText}. Please upload documents for the same patient only.`,
      needs_resubmission: true
    };
  }

  trace.push({
    step: "document_verification",
    status: "PASS",
    message: "Required documents are present and readable."
  });

  return { ok: true, trace };
}
