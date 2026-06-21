import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerClaimRoutes } from "./routes/claims.js";
import { registerPolicyRoutes } from "./routes/policy.js";
import { registerTestCaseRoutes } from "./routes/test-cases.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true
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
