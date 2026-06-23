# Demo Video Script (8–12 min)

Assignment requirement:
> Cover three things: a claim that gets stopped early due to a document problem (show the error
> message), a successful end-to-end approval with the full trace visible, and one technical decision
> you are genuinely proud of and one you would change given more time.

---

## Before You Record

- Start the app: `pnpm dev` → open `http://localhost:5173`
- Switch to **JSON Mode** (top-right toggle) — faster to load test cases by ID
- Open DevTools Network tab in the background (optional — shows NDJSON stream if needed)
- Font size: bump to 125% so trace text is readable

---

## Section 1 — Claim Blocked at Document Gate (≈ 2 min)

**What the assignment wants:** a claim stopped early because of a document problem, error message visible.

**Use: TC001 — Wrong Document Uploaded**

### What to do

1. Type `EMP001` in Member ID, select `CONSULTATION` category, set amount `₹1500`
2. Under Documents, add two entries:
   - `type: PRESCRIPTION` — any content
   - `type: PRESCRIPTION` — another (duplicate — TC001 submits two prescriptions instead of PRESCRIPTION + HOSPITAL_BILL)
3. Hit **Process Claim**
4. Watch the progress ribbon animate: **Received → Validated → OCR → Doc Check**
5. The ribbon stops red at **Doc Check**
6. Show the error card: `"Missing required document(s): HOSPITAL_BILL"`
7. Expand the trace panel — point to the single `document_verification ❌ FAIL` step

**What to say:**
> "The DocumentVerifier agent is the first gate. It checks whether the policy-required document
> types are all present before any AI call runs. Here the member submitted two prescriptions but
> CONSULTATION requires a PRESCRIPTION **and** a HOSPITAL_BILL. The pipeline halts immediately
> with an actionable message — no Groq call was made, no policy engine ran. This is intentional
> fail-fast design: document problems are the cheapest thing to catch and the most common reason
> for resubmission."

**Bonus — show a second document failure (30 sec, optional):**
Load TC002 (Unreadable document) or TC003 (patient name mismatch). Both hit the same agent,
different checks. Briefly show the different error message to demonstrate the three checks
the agent runs:
1. Required types present
2. No UNREADABLE document
3. Patient names consistent across documents

---

## Section 2 — Full End-to-End Approval with Live Trace (≈ 4 min)

**What the assignment wants:** successful approval, full trace visible, AI analysis included.

**Use: TC010 — Network Hospital — Discount Applied**
(More interesting than TC004 because it shows the network discount + ordered copay sequence)

### What to do

1. Load TC010 via the test-case dropdown or enter manually:
   - Member: `EMP007` (Deepak Shah)
   - Category: `CONSULTATION`
   - Amount: `₹4500`
   - Hospital: `Apollo Hospitals` (network hospital)
2. Hit **Process Claim**
3. Watch the full progress ribbon: **Received → Validated → OCR Start → OCR Doc → Doc Check → Extract → AI Risk → Adjudicate → Complete**
4. Pause on each ribbon segment and narrate:

   | Ribbon step | What's happening |
   |-------------|-----------------|
   | **Doc Check** | Agent 1 (DocumentVerifier) — both documents present, readable, same patient |
   | **Extract** | Agent 2 (Extractor) — merges diagnosis, hospital name, line items from document content |
   | **AI Risk** | Agent 3 (RiskAnalyzer) — live Groq call to `llama-3.3-70b-versatile`; returns `LOW` risk, `APPROVE` |
   | **Adjudicate** | Agent 4 (PolicyAdjudicator) — applies 11 ordered policy rules |
   | **Complete** | `APPROVED` · ₹3,240 |

5. Once result loads, scroll to the **Trace Timeline**. Walk through each step:
   - `member_validation` ✅ — EMP007 found in roster
   - `document_verification` ✅ — PRESCRIPTION + HOSPITAL_BILL present
   - `document_extraction` ✅ — hospital name "Apollo Hospitals" captured
   - `ai_analysis` ✅ — Groq returned: `risk_level: LOW`, `recommendation: APPROVE` ← **point this out as a real AI call**
   - `network_discount` ✅ — Apollo is in `network_hospitals` → 20% applied: ₹4,500 × 0.80 = **₹3,600**
   - `copay` ✅ — CONSULTATION 10% copay: ₹3,600 × 0.90 = **₹3,240 approved**

**What to say on ordering:**
> "The ordering of network discount before copay is not arbitrary. The policy spec says discount
> comes first. If you swapped them you'd get ₹4,050 − a ₹810 difference on a single claim. The
> adjudicator enforces this ordering explicitly: step 10 is always discount, step 11 is always copay."

**What to say on AI:**
> "Step 4 is a live Groq API call — not a mock. The LLM sees the member ID, category, amount,
> and document content, then returns a structured risk assessment. The pipeline doesn't blindly
> follow the AI's recommendation; if Groq returns HIGH risk with MANUAL_REVIEW, the claim is
> routed to manual review. But the final policy rules always run regardless — the AI is an input,
> not the decision-maker."

---

## Section 3 — Technical Reflection (≈ 2–3 min)

### Technical decision I am genuinely proud of

**The `onEvent` callback / transport-agnostic engine**

> "The processing engine `processClaim()` knows nothing about HTTP. It takes an optional callback
> function — `onEvent` — and fires it at each agent phase boundary. The streaming route converts
> those events into NDJSON lines on the wire. The eval script ignores the callback entirely. The
> unit tests call the function directly.
>
> This means the same 400-line engine works in three different transport contexts without a single
> `if (isStreaming)` branch. Decoupling processing from delivery is a small decision with large
> testability payoff."

**Show it in code (optional — 20 sec):**
Open `apps/api/src/engine/decision-engine.ts` and point to:
```ts
onEvent?.("agent_document_verify", docResult.ok ? "PASS" : "FAIL", …)
```
Then open `apps/api/src/routes/claims.ts` and point to:
```ts
const result = await processClaim(claim, policy, (step, status, message, data) => {
  emit(out, { type: "status", step, status, message, data });
});
```

**Runner-up proud decision: Parallel Phase 2**
> "Agent 2 (extraction) is synchronous and finishes in microseconds. Agent 3 (Groq AI) takes
> 1–3 seconds. They both read the same immutable claim data — no dependency between them. Running
> them with `Promise.all` means the total latency is `max(T_extract, T_ai)` instead of
> `T_extract + T_ai`. On a 2-second Groq call, that's a free 2× speedup on Phase 2."

---

### One thing I would change given more time

**Real document OCR pipeline**

> "Right now, the test cases supply pre-structured document content as JSON — diagnosis, line items,
> hospital name are already parsed. In production, members upload PDFs and images. The OCR adapter
> exists and chains Groq vision → text LLM → heuristic fallback, but the heuristic is regex-based.
>
> With more time I'd replace the heuristic with a proper VLM call for every document type,
> confidence-calibrated field-level extraction — not a single confidence score for the whole
> document — and a human-review queue for anything below 0.80 field confidence. That gap between
> 'works on structured test data' and 'works on real scanned bills' is the largest production risk
> in the current build."

---

## Timing Checklist

| Segment | Target | What to show |
|---------|--------|-------------|
| Intro (15 sec) | 0:00–0:15 | App open, briefly describe what it is |
| Section 1 — Doc block | 0:15–2:15 | TC001 run, error message, trace |
| Section 2 — Approval | 2:15–6:15 | TC010 full run, live trace walkthrough |
| Section 3 — Reflection | 6:15–9:00 | Code snippet for onEvent, parallel Phase 2, OCR gap |
| Close (15 sec) | 9:00–9:15 | "12/12 eval pass, all docs in `/docs`" |

**Total: ~9 min** (within 8–12 min window)

---

## Anticipated Reviewer Follow-Up Questions

**"What happens if Groq is down?"**
> Agent 3 catches the timeout/error, emits a WARN trace entry, returns `risk_level: LOW,
> recommendation: UNCERTAIN, confidence_adjustment: -0.05`. The policy adjudicator still runs
> all 11 checks with the degraded analysis. The claim either approves or rejects on deterministic
> policy rules alone — the AI is advisory.

**"Why do TC007 and TC012 produce WAITING_PERIOD instead of PRE_AUTH_MISSING / EXCLUDED_CONDITION?"**
> Waiting periods are checked at step 4 of the adjudicator, before pre-auth (step 6) and
> exclusions (step 5). Once a waiting period fails, the pipeline returns immediately — it never
> reaches the later checks. The decision is still correctly REJECTED; the reason code reflects
> which rule fired first, not which rule would fire eventually.

**"How would you scale this to 750,000 claims per year?"**
> Eight things: (1) policy terms → versioned DB + Redis cache, (2) member roster → read-replica
> with index on member_id, (3) AI calls → rate-limited queue workers, (4) extraction → async
> worker consumers, (5) idempotency keys at ingestion, (6) OpenTelemetry + Prometheus per agent,
> (7) rule versioning for historical replay, (8) stateless API pods behind a load balancer.
> See ARCHITECTURE.md §Scale Plan for the full breakdown.

**"How is this different from a single-function adjudicator?"**
> Four independently testable agents with explicit contracts vs one monolithic function.
> You can swap the RiskAnalyzer provider (Groq → OpenAI → self-hosted) without touching the
> orchestrator or adjudicator. You can unit-test each agent in isolation without spinning up
> the full pipeline. The trace is richer because each agent has its own trace namespace.
