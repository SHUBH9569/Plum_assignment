import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { processClaim } from "../engine/decision-engine.js";
import { loadPolicyTerms } from "../engine/policy-loader.js";
import type { ClaimInput } from "../types.js";

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

export async function registerClaimRoutes(app: FastifyInstance): Promise<void> {
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

    const result = processClaim(claim, policy);
    return reply.send(result);
  });
}
