# Component Contracts

Each contract is precise enough that another engineer could reimplement the component without reading its code.

---

## 1. Orchestrator — `processClaim`

**File**: `apps/api/src/engine/decision-engine.ts`

### Signature
```ts
async function processClaim(
  claim: ClaimInput,
  policy: PolicyTerms,
  onEvent?: AgentEventFn
): Promise<DecisionResult>
```

### Input
| Field | Type | Description |
|-------|------|-------------|
| `claim` | `ClaimInput` | Validated claim payload (see type below) |
| `policy` | `PolicyTerms` | Policy configuration loaded from `policy_terms.json` |
| `onEvent` | `AgentEventFn?` | Optional callback fired at each agent phase boundary |

### Output
`DecisionResult` — the complete adjudication result including decision, approved amount, confidence, reasons, and full trace.

### Errors
Never throws. All error paths return a structured `DecisionResult`.

### Behaviour
1. Member identity check (fast path before any agent)
2. Calls Agent 1 (DocumentVerifier) — fails fast if documents are invalid
3. Calls Agent 2 (Extractor) + Agent 3 (RiskAnalyzer) in parallel via `Promise.all`
4. Calls Agent 4 (PolicyAdjudicator) with merged Phase 2 outputs

---

## 2. Agent 1 — DocumentVerifier

**File**: `apps/api/src/agents/document-verifier.ts`

### Signature
```ts
function verifyDocuments(
  claim: ClaimInput,
  requiredTypes: string[]
): DocumentVerificationResult
```

### Input
| Field | Type | Description |
|-------|------|-------------|
| `claim` | `ClaimInput` | Claim with documents array |
| `requiredTypes` | `string[]` | Document types required by policy for this category |

### Output
```ts
interface DocumentVerificationResult {
  ok: boolean;                  // true if all checks pass
  trace: TraceEntry[];          // one entry per check run
  user_message?: string;        // actionable message for the member on failure
  needs_resubmission?: boolean; // true when member must re-upload
}
```

### Checks (in order)
1. All `requiredTypes` are present in `claim.documents[*].actual_type`
2. No document has `quality === "UNREADABLE"`
3. All `patient_name_on_doc` values (when present) resolve to the same name

### Errors
Never throws. Returns `{ ok: false, trace, user_message }` for any failure.

---

## 3. Agent 2 — Extractor

**File**: `apps/api/src/agents/extractor.ts`

### Signature
```ts
function extractStructuredData(claim: ClaimInput): ExtractionResult
```

### Input
`ClaimInput` — reads `documents[*].content` fields and `claim.simulate_component_failure`.

### Output
```ts
interface ExtractionResult {
  extracted: {
    diagnosis?: unknown;
    tests_ordered?: unknown;
    treatment?: unknown;
    line_items?: unknown;
    total?: unknown;
    doctor_registration?: unknown;
    hospital_name?: unknown;
  };
  trace: TraceEntry[];
  confidenceDelta: number;      // 0 (normal) or -0.2 (component failure)
  failedComponent?: string;     // set when simulate_component_failure is true
}
```

### Errors
Never throws. On `simulate_component_failure`, returns partial extraction with `WARN` trace.

---

## 4. Agent 3 — RiskAnalyzer

**File**: `apps/api/src/agents/risk-analyzer.ts`

### Signature
```ts
async function analyzeClaimWithAi(claim: ClaimInput): Promise<AiAnalysis>
```

### Input
`ClaimInput` — serializes member ID, category, amount, documents to JSON for the LLM.

### Output
```ts
interface AiAnalysis {
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  anomalies: string[];
  recommendation: "APPROVE" | "REJECT" | "MANUAL_REVIEW" | "UNCERTAIN";
  reasoning: string;
  confidence_adjustment: number;    // range: -0.3 to +0.1
  normalized_diagnosis?: string;
  normalized_treatment?: string;
  trace: TraceEntry[];
  provider: "openai" | "groq" | "skipped";
}
```

### Errors
Never throws. Degrades gracefully:
- No API key configured → `provider: "skipped"`, `confidence_adjustment: 0`
- Timeout (25 s) or API error → `WARN` trace, `confidence_adjustment: -0.05`

### Provider selection
`GROQ_API_KEY` → Groq (`llama-3.3-70b-versatile`) · `OPENAI_API_KEY` → OpenAI (`gpt-4o-mini`) · neither → skipped

---

## 5. Agent 4 — PolicyAdjudicator

**File**: `apps/api/src/agents/policy-adjudicator.ts`

### Signature
```ts
function adjudicateClaim(input: AdjudicationInput): DecisionResult
```

### Input
```ts
interface AdjudicationInput {
  claim: ClaimInput;
  policy: PolicyTerms;
  extraction: ExtractionResult;   // output of Agent 2
  aiAnalysis: AiAnalysis;         // output of Agent 3
  priorTrace: TraceEntry[];       // trace entries from member validation + agents 1-3
  confidence: number;             // accumulated confidence (starts 0.95, adjusted by agents)
}
```

### Output
`DecisionResult` — one of: `APPROVED`, `PARTIAL`, `REJECTED`, `MANUAL_REVIEW`

### Checks applied (in order)
1. AI risk gate: HIGH + MANUAL_REVIEW → `MANUAL_REVIEW`
2. Minimum amount (`submission_rules.minimum_claim_amount`)
3. Initial waiting period (`waiting_periods.initial_waiting_period_days`)
4. Condition-specific waiting periods (`waiting_periods.specific_conditions`)
5. Exclusions (obesity/bariatric in diagnosis text)
6. Pre-auth (DIAGNOSTIC + MRI + amount > `pre_auth_threshold`)
7. Fraud signals (same-day and monthly claim counts vs thresholds)
8. Per-claim limit (CONSULTATION category)
9. Line-item dental exclusion → `PARTIAL` if cosmetic procedures present
10. Network hospital discount (applied BEFORE copay)
11. Copay deduction → final approved amount → `APPROVED`

### Errors
Never throws. All rule failures return a structured `DecisionResult`.

---

## 6. OCR Adapter

**File**: `apps/api/src/engine/ocr-adapter.ts`

### Interface
```ts
interface OcrAdapter {
  extract(file: OcrFileInput): Promise<OcrExtraction>;
}
```

### Input
```ts
interface OcrFileInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}
```

### Output
```ts
interface OcrExtraction {
  text: string;
  fields: Record<string, unknown>;  // patient_name, diagnosis, total, line_items, etc.
  confidence: number;               // 0-1
  warnings: string[];
  provider: "openai" | "groq" | "heuristic";
}
```

### Provider chain (factory `createOcrAdapter()`)
1. Groq vision (`meta-llama/llama-4-scout-17b-16e-instruct`) — images
2. Groq text (`llama-3.3-70b-versatile`) — text files
3. OpenAI vision/text — if `OPENAI_API_KEY` set
4. Heuristic fallback — regex extraction from text content + filename hints

### Errors
Never throws. Vision failures fall back to heuristic with a warning in `OcrExtraction.warnings`.

---

## 7. Policy Loader

**File**: `apps/api/src/engine/policy-loader.ts`

### Signature
```ts
function loadPolicyTerms(): PolicyTerms
```

### Input
Reads `POLICY_FILE` env var or defaults to `policy_terms.json` at repo root.

### Output
Parsed `PolicyTerms` object.

### Errors
**Throws** on missing file or invalid JSON (startup error; intentional fail-fast).

---

## 8. HTTP Routes

### `POST /api/claims/process`
Non-streaming. Returns `DecisionResult` JSON.
- `400 INVALID_INPUT` — Zod validation failure
- `400 POLICY_MISMATCH` — unknown `policy_id`

### `POST /api/claims/process-live`
Streaming NDJSON. Each line is a `LiveEvent`:
```ts
type LiveEvent =
  | { type: "status"; step: string; status: "PASS"|"FAIL"|"WARN"|"INFO"; message: string; data?: object }
  | { type: "final"; result: DecisionResult }
  | { type: "error"; step: string; status: "FAIL"; message: string }
```
Stream ends with `final` on success or `error` on failure.

### `POST /api/claims/process-form-live`
Same as above but accepts `multipart/form-data`:
- Field `claim_payload`: JSON string of claim (without documents array)
- Field `document_meta`: JSON array of `{ filename, actual_type, quality? }`
- Files: one file per document (key = `documents`)

### `GET /api/policy/summary`
Returns policy terms subset for UI display.

### `GET /api/test-cases`
Returns all 12 test cases from `test_cases.json`.

### `GET /health`
Health check. Returns `{ status: "ok" }`.

---

## 9. Eval Runner

**Script**: `pnpm --filter @plum/api eval`

### Input
- `test_cases.json` — 12 cases with `input` (ClaimInput) and `expected` (decision + approved_amount)

### Output
- `docs/eval_report.json` — machine-readable per-case results
- `docs/EVAL_REPORT.md` — human-readable markdown with full trace per case

### Contract
- Runs all 12 cases through `processClaim` sequentially
- Checks `decision` equality and `approved_amount` within rounding (±1 INR)
- Exits 0 if all pass; logs failures to stdout
