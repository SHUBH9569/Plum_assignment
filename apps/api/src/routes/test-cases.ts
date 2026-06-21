import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadTestCases(): unknown {
  const testCasePath = path.resolve(__dirname, "../../../../test_cases.json");
  return JSON.parse(readFileSync(testCasePath, "utf-8"));
}

export async function registerTestCaseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/test-cases", async () => {
    return loadTestCases();
  });
}
