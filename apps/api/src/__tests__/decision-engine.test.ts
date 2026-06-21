import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processClaim } from "../engine/decision-engine.js";
import { loadPolicyTerms } from "../engine/policy-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("decision engine", () => {
  it("passes expected decision for all provided testcases", () => {
    const casesRaw = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../test_cases.json"), "utf-8")) as {
      test_cases: Array<{ input: any; expected: any; case_id: string }>;
    };

    const policy = loadPolicyTerms();

    for (const tc of casesRaw.test_cases) {
      const result = processClaim(tc.input, policy);
      if (tc.expected.decision === null) {
        expect(result.decision, tc.case_id).toBeNull();
      } else {
        expect(result.decision, tc.case_id).toBe(tc.expected.decision);
      }
    }
  });

  it("applies network discount before copay for TC010 style claim", () => {
    const policy = loadPolicyTerms();
    const claim = {
      member_id: "EMP010",
      policy_id: "PLUM_GHI_2024",
      claim_category: "CONSULTATION",
      treatment_date: "2024-11-03",
      claimed_amount: 4500,
      hospital_name: "Apollo Hospitals",
      documents: [
        { file_id: "X1", actual_type: "PRESCRIPTION", content: { diagnosis: "Acute Bronchitis", patient_name: "Deepak Shah" } },
        {
          file_id: "X2",
          actual_type: "HOSPITAL_BILL",
          content: {
            hospital_name: "Apollo Hospitals",
            patient_name: "Deepak Shah",
            total: 4500,
            line_items: [
              { description: "Consultation", amount: 1500 },
              { description: "Medicines", amount: 3000 }
            ]
          }
        }
      ]
    };

    const result = processClaim(claim as any, policy);
    expect(result.decision).toBe("APPROVED");
    expect(result.approved_amount).toBe(3240);
  });
});
