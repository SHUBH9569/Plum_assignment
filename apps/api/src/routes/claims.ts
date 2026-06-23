import { PassThrough } from "stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { processClaim } from "../engine/decision-engine.js";
import { createOcrAdapter } from "../engine/ocr-adapter.js";
import { loadPolicyTerms } from "../engine/policy-loader.js";
import type { ClaimInput, DecisionResult } from "../types.js";

type LiveStatus = "PASS" | "FAIL" | "WARN" | "INFO";

interface LiveEvent {
  type: "status" | "final" | "error";
  step?: string;
  status?: LiveStatus;
  message?: string;
  data?: Record<string, unknown>;
  result?: DecisionResult;
}

const docSchema = z.object({
  file_id: z.string(),
  file_name: z.string().optional(),
  actual_type: z.string(),
  quality: z.enum(["GOOD", "UNREADABLE", "LOW"]).optional(),
  patient_name_on_doc: z.string().optional(),
  content: z.record(z.any()).optional()
});

const claimSchema = z.object({
  member_id: z.string(),
  policy_id: z.string(),
  claim_category: z.enum(["CONSULTATION", "DIAGNOSTIC", "PHARMACY", "DENTAL", "VISION", "ALTERNATIVE_MEDICINE"]),
  treatment_date: z.string(),
  claimed_amount: z.number(),
  hospital_name: z.string().optional(),
  ytd_claims_amount: z.number().optional(),
  claims_history: z
    .array(
      z.object({
        claim_id: z.string(),
        date: z.string(),
        amount: z.number(),
        provider: z.string().optional()
      })
    )
    .optional(),
  simulate_component_failure: z.boolean().optional(),
  documents: z.array(docSchema).min(1)
});

const claimWithoutDocumentsSchema = claimSchema.omit({ documents: true });

const documentMetaSchema = z.array(
  z.object({
    filename: z.string(),
    actual_type: z.string(),
    quality: z.enum(["GOOD", "UNREADABLE", "LOW"]).optional(),
    patient_name_on_doc: z.string().optional()
  })
);

function emit(stream: PassThrough, event: LiveEvent): void {
  stream.write(`${JSON.stringify(event)}\n`);
}

function makeNdjsonStream(): PassThrough {
  return new PassThrough({ objectMode: false });
}

function commitStreamHeaders(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply): void {
  const raw = reply.raw as import("http").ServerResponse;
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  const headers: Record<string, string> = {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  // Commit 200 status + CORS headers before reply.send() so they reach the wire
  raw.writeHead(200, headers);
  // Also keep Fastify's reply in sync so its logging/hooks see the right state
  reply.type("application/x-ndjson; charset=utf-8");
  reply.header("cache-control", "no-cache, no-transform");
}

export async function registerClaimRoutes(app: FastifyInstance): Promise<void> {
  const ocrAdapter = createOcrAdapter();

  const enrichResult = (
    result: DecisionResult,
    extractionWarnings: string[],
    documents?: ClaimInput["documents"]
  ): DecisionResult => {
    if (extractionWarnings.length > 0) {
      const provider = String((documents?.[0] as { content?: { ocr_provider?: string } })?.content?.ocr_provider ?? "unknown");
      const isFallback = provider === "heuristic";
      result.trace.push({
        step: "ocr_adapter",
        status: "WARN",
        message: isFallback
          ? "Fallback heuristic extraction used for one or more uploaded files (some fields may be missing)."
          : `Document extraction completed with warnings using ${provider} provider.`,
        data: { warnings: extractionWarnings, provider }
      });
      result.confidence_score = Math.max(0.3, Number((result.confidence_score - 0.05).toFixed(2)));
    }

    if (documents) {
      (result as DecisionResult & { documents?: typeof documents }).documents = documents;
    }

    return result;
  };

  // ── Non-streaming JSON route ──────────────────────────────────────────────
  app.post("/api/claims/process", async (request, reply) => {
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "INVALID_INPUT",
        message: "Invalid claim payload",
        details: parsed.error.flatten()
      });
    }

    const claim = parsed.data as ClaimInput;
    const policy = loadPolicyTerms();

    if (claim.policy_id !== policy.policy_id) {
      return reply.status(400).send({
        error: "POLICY_MISMATCH",
        message: `Unknown policy_id ${claim.policy_id}`
      });
    }

    const result = await processClaim(claim, policy);
    return reply.send(result);
  });

  // ── Live streaming — JSON payload ─────────────────────────────────────────
  app.post("/api/claims/process-live", async (request, reply) => {
    const out = makeNdjsonStream();
    commitStreamHeaders(request, reply);

    void (async () => {
      try {
        emit(out, { type: "status", step: "request_received", status: "INFO", message: "Claim request received." });
        emit(out, { type: "status", step: "input_validation", status: "INFO", message: "Validating JSON payload." });

        const parsed = claimSchema.safeParse(request.body);
        if (!parsed.success) {
          emit(out, { type: "error", step: "input_validation", status: "FAIL", message: "Invalid claim payload.", data: { details: parsed.error.flatten() } });
          return;
        }

        const claim = parsed.data as ClaimInput;
        const policy = loadPolicyTerms();

        if (claim.policy_id !== policy.policy_id) {
          emit(out, { type: "error", step: "policy_validation", status: "FAIL", message: `Unknown policy_id ${claim.policy_id}` });
          return;
        }

        // Delegate to multi-agent orchestrator; each agent phase fires a live event
        const result = await processClaim(claim, policy, (step, status, message, data) => {
          emit(out, { type: "status", step, status, message, data });
        });

        emit(out, { type: "status", step: "completed", status: "PASS", message: "All agents completed. Claim processed." });
        emit(out, { type: "final", result });
      } catch (error) {
        emit(out, { type: "error", step: "unexpected_error", status: "FAIL", message: error instanceof Error ? error.message : "Unexpected error." });
      } finally {
        out.end();
      }
    })();

    return reply.send(out);
  });

  // ── Non-streaming multipart form route ────────────────────────────────────
  app.post("/api/claims/process-form", async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: "INVALID_CONTENT_TYPE", message: "Expected multipart/form-data request." });
    }

    const fields: Record<string, string> = {};
    const fileParts: Array<{ filename: string; mimeType: string; buffer: Buffer }> = [];

    for await (const part of request.parts()) {
      if (part.type === "file") {
        fileParts.push({ filename: part.filename, mimeType: part.mimetype, buffer: await part.toBuffer() });
      } else {
        fields[part.fieldname] = String(part.value ?? "");
      }
    }

    if (!fields.claim_payload) {
      return reply.status(400).send({ error: "MISSING_CLAIM_PAYLOAD", message: "Field claim_payload is required and must be valid JSON." });
    }

    let baseClaimPayload: unknown;
    let documentMetaRaw: unknown = [];

    try {
      baseClaimPayload = JSON.parse(fields.claim_payload);
      if (fields.document_meta) documentMetaRaw = JSON.parse(fields.document_meta);
    } catch {
      return reply.status(400).send({ error: "INVALID_JSON_FIELD", message: "claim_payload or document_meta is not valid JSON." });
    }

    const parsedBase = claimWithoutDocumentsSchema.safeParse(baseClaimPayload);
    if (!parsedBase.success) {
      return reply.status(400).send({ error: "INVALID_CLAIM_PAYLOAD", message: "Base claim fields are invalid.", details: parsedBase.error.flatten() });
    }

    const parsedMeta = documentMetaSchema.safeParse(documentMetaRaw);
    if (!parsedMeta.success) {
      return reply.status(400).send({ error: "INVALID_DOCUMENT_META", message: "document_meta must be an array with filename and actual_type.", details: parsedMeta.error.flatten() });
    }

    const metaByFile = new Map(parsedMeta.data.map((meta) => [meta.filename.toLowerCase(), meta]));
    const extractionWarnings: string[] = [];

    const documents = await Promise.all(
      fileParts.map(async (file, index) => {
        const meta = metaByFile.get(file.filename.toLowerCase());
        const extraction = await ocrAdapter.extract({ filename: file.filename, mimeType: file.mimeType, buffer: file.buffer });
        extractionWarnings.push(...extraction.warnings.map((w) => `${file.filename}: ${w}`));
        return {
          file_id: `UPL_${index + 1}`,
          file_name: file.filename,
          actual_type: meta?.actual_type ?? "UNKNOWN",
          quality: meta?.quality ?? (extraction.confidence < 0.5 ? "LOW" : "GOOD"),
          patient_name_on_doc: meta?.patient_name_on_doc,
          content: { ...extraction.fields, ocr_confidence: extraction.confidence, ocr_provider: extraction.provider, extracted_text_present: extraction.text.length > 0 }
        };
      })
    );

    const claim: ClaimInput = { ...parsedBase.data, documents };
    const policy = loadPolicyTerms();

    if (claim.policy_id !== policy.policy_id) {
      return reply.status(400).send({ error: "POLICY_MISMATCH", message: `Unknown policy_id ${claim.policy_id}` });
    }

    return reply.send(enrichResult(await processClaim(claim, policy), extractionWarnings, documents));
  });

  // ── Live streaming — multipart form upload ────────────────────────────────
  app.post("/api/claims/process-form-live", async (request, reply) => {
    const out = makeNdjsonStream();
    commitStreamHeaders(request, reply);

    void (async () => {
      try {
        if (!request.isMultipart()) {
          emit(out, { type: "error", step: "input_validation", status: "FAIL", message: "Expected multipart/form-data request." });
          return;
        }

        emit(out, { type: "status", step: "request_received", status: "INFO", message: "Upload claim request received." });

        const fields: Record<string, string> = {};
        const fileParts: Array<{ filename: string; mimeType: string; buffer: Buffer }> = [];

        for await (const part of request.parts()) {
          if (part.type === "file") {
            fileParts.push({ filename: part.filename, mimeType: part.mimetype, buffer: await part.toBuffer() });
          } else {
            fields[part.fieldname] = String(part.value ?? "");
          }
        }

        if (!fields.claim_payload) {
          emit(out, { type: "error", step: "input_validation", status: "FAIL", message: "Field claim_payload is required." });
          return;
        }

        let baseClaimPayload: unknown;
        let documentMetaRaw: unknown = [];

        try {
          baseClaimPayload = JSON.parse(fields.claim_payload);
          if (fields.document_meta) documentMetaRaw = JSON.parse(fields.document_meta);
        } catch {
          emit(out, { type: "error", step: "input_validation", status: "FAIL", message: "claim_payload or document_meta is not valid JSON." });
          return;
        }

        const parsedBase = claimWithoutDocumentsSchema.safeParse(baseClaimPayload);
        if (!parsedBase.success) {
          emit(out, { type: "error", step: "input_validation", status: "FAIL", message: "Base claim fields are invalid.", data: { details: parsedBase.error.flatten() } });
          return;
        }

        const parsedMeta = documentMetaSchema.safeParse(documentMetaRaw);
        if (!parsedMeta.success) {
          emit(out, { type: "error", step: "input_validation", status: "FAIL", message: "document_meta must be an array with filename and actual_type." });
          return;
        }

        const metaByFile = new Map(parsedMeta.data.map((m) => [m.filename.toLowerCase(), m]));

        emit(out, { type: "status", step: "ai_extraction", status: "INFO", message: `Starting AI extraction for ${fileParts.length} document(s).` });

        const extractionWarnings: string[] = [];
        const documents: ClaimInput["documents"] = [];

        for (const [index, file] of fileParts.entries()) {
          emit(out, { type: "status", step: "ai_extract_document", status: "INFO", message: `Extracting ${file.filename} (${index + 1}/${fileParts.length}).` });

          const meta = metaByFile.get(file.filename.toLowerCase());
          const extraction = await ocrAdapter.extract({ filename: file.filename, mimeType: file.mimeType, buffer: file.buffer });

          extractionWarnings.push(...extraction.warnings.map((w) => `${file.filename}: ${w}`));

          documents.push({
            file_id: `UPL_${index + 1}`,
            file_name: file.filename,
            actual_type: meta?.actual_type ?? "UNKNOWN",
            quality: meta?.quality ?? (extraction.confidence < 0.5 ? "LOW" : "GOOD"),
            patient_name_on_doc: meta?.patient_name_on_doc,
            content: { ...extraction.fields, ocr_confidence: extraction.confidence, ocr_provider: extraction.provider, extracted_text_present: extraction.text.length > 0 }
          });

          emit(out, {
            type: "status",
            step: "ai_extract_document",
            status: extraction.provider === "heuristic" ? "WARN" : "PASS",
            message: extraction.provider === "heuristic"
              ? `${file.filename}: heuristic fallback used.`
              : `${file.filename}: extracted via ${extraction.provider}.`,
            data: { provider: extraction.provider, confidence: extraction.confidence }
          });
        }

        const claim: ClaimInput = { ...parsedBase.data, documents };
        const policy = loadPolicyTerms();

        if (claim.policy_id !== policy.policy_id) {
          emit(out, { type: "error", step: "policy_validation", status: "FAIL", message: `Unknown policy_id ${claim.policy_id}` });
          return;
        }

        // Delegate to multi-agent orchestrator with live per-agent events
        const result = enrichResult(
          await processClaim(claim, policy, (step, status, message, data) => {
            emit(out, { type: "status", step, status, message, data });
          }),
          extractionWarnings,
          documents
        );

        emit(out, { type: "status", step: "completed", status: "PASS", message: "All agents completed. Claim processed." });
        emit(out, { type: "final", result });
      } catch (error) {
        emit(out, { type: "error", step: "unexpected_error", status: "FAIL", message: error instanceof Error ? error.message : "Unexpected error." });
      } finally {
        out.end();
      }
    })();

    return reply.send(out);
  });
}
