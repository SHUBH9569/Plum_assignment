# Component Contracts

## 1) Claim Processing API

### Endpoint
- `POST /api/claims/process`

### Input
- JSON claim payload with:
  - member and policy identity
  - claim category, amount, treatment date
  - documents array
  - optional claim history, hospital info, simulated failure flag

### Output
- Decision object:
  - `decision`: `APPROVED | PARTIAL | REJECTED | MANUAL_REVIEW | null`
  - `approved_amount`: number
  - `reasons`: string[]
  - `confidence_score`: number
  - `trace`: stage-by-stage explainability log
  - `user_message`: member-facing explanation
  - optional `line_item_decisions`, `metadata`

### Errors
- `400 INVALID_INPUT`
- `400 POLICY_MISMATCH`

## 2) Document Verifier

### Function
- `verifyDocuments(claim, requiredTypes)`

### Input
- claim payload
- required document type list from policy

### Output
- `{ ok, trace, user_message?, needs_resubmission? }`

### Guarantees
- Stops pipeline early on missing/incorrect/unreadable documents
- Error messages are specific, actionable, and document-type aware

### Errors
- Does not throw for business issues; returns structured failure

## 3) Structured Extractor

### Function
- `extractStructuredData(claim)`

### Input
- claim payload documents

### Output
- extracted fields (diagnosis, tests, line items, totals, provider)
- trace entries
- confidence delta
- optional failed component identifier

### Failure Behavior
- On component failure, returns partial extraction and warning trace instead of crash

## 4) Decision Engine

### Function
- `processClaim(claim, policy)`

### Input
- validated claim payload
- policy terms

### Output
- full `DecisionResult` contract

### Rule Domains
- member eligibility
- minimum amount
- waiting periods
- exclusions
- pre-authorization
- fraud/manual-review
- line-item adjudication
- network discount and copay ordering

### Failure Behavior
- deterministic, non-throwing business path
- confidence reduced when degraded

## 5) Policy Loader

### Function
- `loadPolicyTerms()`

### Input
- file path from env `POLICY_FILE` or default root `policy_terms.json`

### Output
- parsed policy object

### Errors
- throws on invalid path/file parse (startup/config errors)

## 6) Eval Runner

### Script
- `pnpm --filter @plum/api eval`

### Input
- `test_cases.json`
- engine output per case

### Output
- `docs/eval_report.json`
- `docs/EVAL_REPORT.md`

### Guarantees
- deterministic replay of all provided assignment cases
- includes decision + full trace per case
