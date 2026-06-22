import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerPolicyRoutes } from "./routes/policy.js";
import { registerTestCaseRoutes } from "./routes/test-cases.js";

// Load .env file if it exists
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const envPath = join(__dirname, "../../../.env");
  const envContent = readFileSync(envPath, "utf-8");
  const lines = envContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...rest] = trimmed.split("=");
      if (key && rest.length > 0) {
        const value = rest.join("=").trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
} catch {
  // .env file not found or not readable, using environment variables as-is
}

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true
});

await app.register(multipart, {
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 10
  }
});

app.get("/health", async () => ({ status: "ok", service: "plum-claims-api" }));

await registerClaimRoutes(app);
await registerPolicyRoutes(app);
await registerTestCaseRoutes(app);

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
