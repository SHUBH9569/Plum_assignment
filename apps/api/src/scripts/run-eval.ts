import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processClaim } from "../engine/decision-engine.js";
import { loadPolicyTerms } from "../engine/policy-loader.js";
import type { EvaluationCase } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function rootPath(...parts: string[]): string {
  return path.resolve(__dirname, "../../../../", ...parts);
}

function checkExpectation(result: any, expected: Record<string, unknown>): { pass: boolean; reason: string } {
  if (expected.decision !== undefined && expected.decision !== null) {
    if (result.decision !== expected.decision) {
      return { pass: false, reason: `decision mismatch: expected ${expected.decision}, got ${result.decision}` };
    }
  }

  if (expected.decision === null && result.decision !== null) {
    return { pass: false, reason: `expected no decision, got ${result.decision}` };
  }

  if (typeof expected.approved_amount === "number") {
    if (Math.round(result.approved_amount) !== Math.round(expected.approved_amount as number)) {
      return {
        pass: false,
        reason: `approved_amount mismatch: expected ${expected.approved_amount}, got ${result.approved_amount}`
      };
    }
  }

  return { pass: true, reason: "matched core expectations" };
}

function main(): void {
  const casesRaw = JSON.parse(readFileSync(rootPath("test_cases.json"), "utf-8")) as { test_cases: EvaluationCase[] };
  const policy = loadPolicyTerms();

  const reports = casesRaw.test_cases.map((tc) => {
    const result = processClaim(tc.input, policy);
    const verdict = checkExpectation(result, tc.expected);
    return {
      case_id: tc.case_id,
      case_name: tc.case_name,
      expected: tc.expected,
      result,
      verdict
    };
  });

  const passed = reports.filter((r) => r.verdict.pass).length;
  const summary = {
    total: reports.length,
    passed,
    failed: reports.length - passed,
    generated_at: new Date().toISOString()
  };

  const output = { summary, reports };
  writeFileSync(rootPath("docs", "eval_report.json"), JSON.stringify(output, null, 2));

  const markdown = [
    "# Eval Report",
    "",
    `- Total: ${summary.total}`,
    `- Passed: ${summary.passed}`,
    `- Failed: ${summary.failed}`,
    "",
    ...reports.flatMap((r) => [
      `## ${r.case_id} - ${r.case_name}`,
      `- Verdict: ${r.verdict.pass ? "PASS" : "FAIL"}`,
      `- Reason: ${r.verdict.reason}`,
      `- Decision: ${String(r.result.decision)}`,
      `- Approved Amount: ${r.result.approved_amount}`,
      `- Confidence: ${r.result.confidence_score}`,
      "- Trace:",
      ...r.result.trace.map((t: any) => `  - [${t.status}] ${t.step}: ${t.message}`),
      ""
    ])
  ].join("\n");

  writeFileSync(rootPath("docs", "EVAL_REPORT.md"), markdown);
  console.log(`Eval completed. Passed ${summary.passed}/${summary.total}.`);
}

main();
