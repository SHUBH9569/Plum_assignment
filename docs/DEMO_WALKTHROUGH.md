# Demo Walkthrough (8-12 min)

## 1. Early Stop for Document Problem

1. Open UI.
2. Load `TC001` from dropdown.
3. Click `Process Claim`.
4. Show blocked response with explicit document mismatch message and trace stage `document_requirements`.

## 2. Successful End-to-End Approval with Full Trace

1. Load `TC004` or `TC010`.
2. Click `Process Claim`.
3. Show `APPROVED` and amount.
4. Expand/scroll trace timeline and explain each pass stage.
5. For `TC010`, highlight order: network discount first, then copay.

## 3. Technical Pride + Improvement

### Technical decision to highlight
- Trace-first architecture: every stage emits auditable evidence and status; observability is native, not bolted on.

### What to improve with more time
- Swap heuristic extraction with OCR/VLM adapters and confidence-calibrated field-level extraction.
- Add persistent claim store, idempotency keys, and async workflow orchestration.
