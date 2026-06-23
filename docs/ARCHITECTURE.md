# Architecture: Plum Claims AI

## System Purpose

A policy-driven, explainable health insurance claims adjudication platform.
Every claim goes through a deterministic, auditable pipeline and produces a decision with a full step-by-step trace. No black boxes.

---

## High-Level Layers

```
┌─────────────────────────────────────────────────┐
│  Web Console  (React + Vite, TypeScript)         │
│  JSON Mode · Upload Mode · Live trace timeline   │
└──────────────────────┬──────────────────────────┘
                       │  NDJSON streaming / REST
┌──────────────────────▼──────────────────────────┐
│  API Service  (Fastify v5, TypeScript)            │
│  Zod validation · 4 routes · CORS fix             │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│  Multi-Agent Orchestrator  (decision-engine.ts)   │
│  Coordinates 4 specialized agents                 │
└──────────────────────┬──────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  Agent 1        Agent 2+3      Agent 4
  Doc Verify     (parallel)     Policy
                 Extract        Adjudicator
                 Risk Analyzer
```

---

## Multi-Agent Architecture

The core processing pipeline is structured as four **specialized, independently testable agents** orchestrated by `processClaim()`.

### Agent 1 — DocumentVerifier (`agents/document-verifier.ts`)

**Runs**: Phase 1 (synchronous, fail-fast gate)

Checks:
1. Policy-required document types are all present
2. No document is unreadable (quality ≠ UNREADABLE)
3. Patient names match across documents

**Why first**: document problems are the cheapest thing to detect and the most common reason for resubmission. Failing here before any AI call saves latency and compute.

---

### Agent 2 — Extractor (`agents/extractor.ts`)

**Runs**: Phase 2 (parallel with Agent 3)

Merges structured fields from all submitted document content objects:
`diagnosis`, `treatment`, `tests_ordered`, `line_items`, `total`, `doctor_registration`, `hospital_name`.

Handles component failure: if `simulate_component_failure` is set, returns partial extraction with a `-0.2` confidence delta and a `WARN` trace entry instead of crashing.

---

### Agent 3 — RiskAnalyzer (`agents/risk-analyzer.ts`)

**Runs**: Phase 2 (parallel with Agent 2)

Calls the **Groq** API (`llama-3.3-70b-versatile`) — or OpenAI as fallback — to assess:
- Fraud risk level (`LOW` / `MEDIUM` / `HIGH`)
- Anomaly list (e.g., "amount unusually high for Indian OPD rates")
- Overall recommendation (`APPROVE` / `REJECT` / `MANUAL_REVIEW` / `UNCERTAIN`)
- Normalized diagnosis/treatment terminology

Degradation chain: Groq timeout → catch → returns `risk_level: LOW, recommendation: UNCERTAIN` + `WARN` trace. Policy checks still run.

**Why parallel with Extractor**: both agents read the same immutable claim data. Neither depends on the other's output. Running them concurrently reduces end-to-end latency from `T_extract + T_ai` to `max(T_extract, T_ai)`.

---

### Agent 4 — PolicyAdjudicator (`agents/policy-adjudicator.ts`)

**Runs**: Phase 3 (after Phase 2 resolves)

Receives the outputs of both Phase 2 agents and applies all policy rules in order:

| # | Check | Outcome on fail |
|---|-------|----------------|
| 1 | AI risk gate (HIGH + MANUAL_REVIEW) | `MANUAL_REVIEW` |
| 2 | Minimum claim amount | `REJECTED` |
| 3 | Initial 30-day waiting period | `REJECTED` |
| 4 | Condition-specific waiting periods | `REJECTED` |
| 5 | Exclusions (obesity, bariatric) | `REJECTED` |
| 6 | Pre-auth (MRI > INR 10,000) | `REJECTED` |
| 7 | Fraud signals (same-day / monthly count) | `MANUAL_REVIEW` |
| 8 | Per-claim limit (CONSULTATION) | `REJECTED` |
| 9 | Line-item adjudication (dental cosmetics) | `PARTIAL` |
| 10 | Network hospital discount (applied BEFORE copay) | — |
| 11 | Copay deduction | — |
| — | Default | `APPROVED` |

---

## Orchestrator (`engine/decision-engine.ts`)

```
processClaim(claim, policy, onEvent?)
  │
  ├─ member validation           (fast identity lookup, no agent)
  │
  ├─ Phase 1 ─────────────────── Agent 1: DocumentVerifier
  │    └─ fail-fast if doc check fails (returns decision: null)
  │
  ├─ Phase 2 ─────────────────── Promise.all([
  │    ├─ Agent 2: Extractor            (synchronous, resolves instantly)
  │    └─ Agent 3: RiskAnalyzer         (async Groq call, ~1-3s)
  │         ])                          latency = max(2, 3), not sum
  │
  └─ Phase 3 ─────────────────── Agent 4: PolicyAdjudicator
       └─ returns final DecisionResult
```

The `onEvent?` callback is an optional transport bridge. When present, the orchestrator fires a callback at each agent phase boundary — the streaming HTTP route converts these into NDJSON events for the UI. The engine itself has no HTTP dependency.

---

## Explainability Strategy

Every agent emits `TraceEntry[]`:

```ts
interface TraceEntry {
  step: string;           // deterministic identifier (e.g. "specific_condition_waiting_period")
  status: PASS|FAIL|WARN|INFO;
  message: string;        // human-readable explanation
  data?: Record<string, unknown>; // structured evidence (amounts, thresholds, names)
}
```

The final `DecisionResult.trace` is the complete, ordered log from all agents. Operations can reconstruct the exact reason for any decision from this trace alone.

---

## Streaming Transport

Two modes:
1. **JSON mode** (`POST /api/claims/process-live`): structured document fields provided inline
2. **Upload mode** (`POST /api/claims/process-form-live`): files uploaded, OCR extracted first, then same pipeline

Both use NDJSON streaming over a Node.js `PassThrough` pipe. The CORS fix is applied via `reply.raw.writeHead(200, headers)` before `reply.send(stream)` to commit CORS headers to the HTTP wire before Fastify's `sendStream` path runs.

---

## Resilience Design

| Failure Scenario | Behaviour |
|---|---|
| AI provider down / timeout | `WARN` trace + `UNCERTAIN` recommendation; policy checks still run |
| Extractor component failure (`simulate_component_failure`) | Partial extraction, `-0.2` confidence, `WARN` trace |
| Unreadable document | Stopped at Agent 1 with specific re-upload instruction |
| Missing document type | Stopped at Agent 1 with exact missing type listed |
| Invalid JSON input | 400 before any agent runs |
| Unknown member ID | Stopped before Agent 1 runs |

---

## What Was Considered and Rejected

**Event sourcing per claim**: provides replay and audit; rejected for this scope because it adds infrastructure (message broker, persistent store) without value at prototype scale.

**LLM-driven policy evaluation**: letting the LLM evaluate waiting periods and amounts instead of deterministic code. Rejected — LLMs hallucinate numeric thresholds; deterministic rule evaluation is auditable and testable.

**Single-agent monolith**: simpler to write, harder to test independently, harder to swap providers. Rejected in favour of the 4-agent split so each agent has a clear contract and can be unit tested or replaced.

**Separate microservices per agent**: correct at scale, premature at prototype stage. The agents are cleanly separated modules within one process.

---

## Scale Plan (10× load → 750,000 claims/year)

1. **Policy store**: move `policy_terms.json` to a versioned database + Redis cache; invalidate cache on policy update.
2. **Member roster**: move to a read-replica DB; add index on `member_id`.
3. **AI calls**: rate-limited queue workers with back-pressure; parallel Groq calls per claim batch.
4. **Extraction**: make truly async — enqueue documents, workers extract, publish results. Agent 2 becomes a consumer.
5. **Idempotency**: assign `claim_id` at ingestion; idempotent processing on retry.
6. **Observability**: OpenTelemetry traces + Prometheus metrics (latency per agent, decision distribution, fraud rate).
7. **Rule versioning**: store policy version alongside each decision for exact historical replay.
8. **Horizontal scaling**: stateless API containers behind a load balancer; Redis for ephemeral session state if needed.
