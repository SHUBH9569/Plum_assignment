import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicyTerms } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedPolicy: PolicyTerms | null = null;

export function loadPolicyTerms(): PolicyTerms {
  if (cachedPolicy) {
    return cachedPolicy;
  }

  const configuredPath = process.env.POLICY_FILE;
  const policyPath = configuredPath
    ? path.resolve(process.cwd(), configuredPath)
    : path.resolve(__dirname, "../../../../policy_terms.json");

  const raw = readFileSync(policyPath, "utf-8");
  cachedPolicy = JSON.parse(raw) as PolicyTerms;
  return cachedPolicy;
}
