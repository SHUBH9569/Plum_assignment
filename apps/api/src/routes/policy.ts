import type { FastifyInstance } from "fastify";
import { loadPolicyTerms } from "../engine/policy-loader.js";

export async function registerPolicyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/policy/summary", async () => {
    const policy = loadPolicyTerms();
    return {
      policy_id: policy.policy_id,
      per_claim_limit: policy.coverage.per_claim_limit,
      annual_opd_limit: policy.coverage.annual_opd_limit,
      supported_categories: Object.keys(policy.document_requirements),
      total_members: policy.members.length,
      network_hospitals: policy.network_hospitals
    };
  });
}
