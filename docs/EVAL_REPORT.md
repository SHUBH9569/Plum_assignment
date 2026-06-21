# Eval Report

- Total: 12
- Passed: 12
- Failed: 0

## TC001 - Wrong Document Uploaded
- Verdict: PASS
- Reason: matched core expectations
- Decision: null
- Approved Amount: 0
- Confidence: 0.98
- Trace:
  - [PASS] member_validation: Member Rajesh Kumar is eligible in roster.
  - [FAIL] document_requirements: Document verification failed.

## TC002 - Unreadable Document
- Verdict: PASS
- Reason: matched core expectations
- Decision: null
- Approved Amount: 0
- Confidence: 0.98
- Trace:
  - [PASS] member_validation: Member Sneha Reddy is eligible in roster.
  - [FAIL] document_readability: Document F004 is unreadable and requires re-upload.

## TC003 - Documents Belong to Different Patients
- Verdict: PASS
- Reason: matched core expectations
- Decision: null
- Approved Amount: 0
- Confidence: 0.98
- Trace:
  - [PASS] member_validation: Member Rajesh Kumar is eligible in roster.
  - [FAIL] cross_document_patient_consistency: Documents appear to belong to different patients.

## TC004 - Clean Consultation — Full Approval
- Verdict: PASS
- Reason: matched core expectations
- Decision: APPROVED
- Approved Amount: 1350
- Confidence: 0.95
- Trace:
  - [PASS] member_validation: Member Rajesh Kumar is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [PASS] document_extraction: Structured data extracted from documents.
  - [PASS] copay: Copay of 10% applied.

## TC005 - Waiting Period — Diabetes
- Verdict: PASS
- Reason: matched core expectations
- Decision: REJECTED
- Approved Amount: 0
- Confidence: 0.95
- Trace:
  - [PASS] member_validation: Member Vikram Joshi is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [PASS] document_extraction: Structured data extracted from documents.
  - [FAIL] specific_condition_waiting_period: diabetes waiting period not completed.

## TC006 - Dental Partial Approval — Cosmetic Exclusion
- Verdict: PASS
- Reason: matched core expectations
- Decision: PARTIAL
- Approved Amount: 8000
- Confidence: 0.95
- Trace:
  - [PASS] member_validation: Member Priya Singh is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [PASS] document_extraction: Structured data extracted from documents.
  - [WARN] dental_line_item_policy: Some line items were excluded as cosmetic dental procedures.

## TC007 - MRI Without Pre-Authorization
- Verdict: PASS
- Reason: matched core expectations
- Decision: REJECTED
- Approved Amount: 0
- Confidence: 0.95
- Trace:
  - [PASS] member_validation: Member Suresh Patil is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [PASS] document_extraction: Structured data extracted from documents.
  - [FAIL] specific_condition_waiting_period: hernia waiting period not completed.

## TC008 - Per-Claim Limit Exceeded
- Verdict: PASS
- Reason: matched core expectations
- Decision: REJECTED
- Approved Amount: 0
- Confidence: 0.95
- Trace:
  - [PASS] member_validation: Member Amit Verma is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [PASS] document_extraction: Structured data extracted from documents.
  - [FAIL] per_claim_limit: Claim amount 7500 exceeds per-claim limit 5000.

## TC009 - Fraud Signal — Multiple Same-Day Claims
- Verdict: PASS
- Reason: matched core expectations
- Decision: MANUAL_REVIEW
- Approved Amount: 0
- Confidence: 0.8
- Trace:
  - [PASS] member_validation: Member Ravi Menon is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [PASS] document_extraction: Structured data extracted from documents.
  - [WARN] fraud_detection: Claim routed to manual review due to fraud signals.

## TC010 - Network Hospital — Discount Applied
- Verdict: PASS
- Reason: matched core expectations
- Decision: APPROVED
- Approved Amount: 3240
- Confidence: 0.95
- Trace:
  - [PASS] member_validation: Member Deepak Shah is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [PASS] document_extraction: Structured data extracted from documents.
  - [PASS] network_discount: Network discount of 20% applied before copay.
  - [PASS] copay: Copay of 10% applied.

## TC011 - Component Failure — Graceful Degradation
- Verdict: PASS
- Reason: matched core expectations
- Decision: APPROVED
- Approved Amount: 4000
- Confidence: 0.75
- Trace:
  - [PASS] member_validation: Member Kavita Nair is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [WARN] document_extraction: Extraction component failure simulated. Proceeding with partial data.
  - [PASS] copay: Copay of 0% applied.
  - [WARN] graceful_degradation: Component vision_ocr_parser failed; decision generated with degraded confidence.

## TC012 - Excluded Treatment
- Verdict: PASS
- Reason: matched core expectations
- Decision: REJECTED
- Approved Amount: 0
- Confidence: 0.95
- Trace:
  - [PASS] member_validation: Member Anita Desai is eligible in roster.
  - [PASS] document_verification: Required documents are present and readable.
  - [PASS] document_extraction: Structured data extracted from documents.
  - [FAIL] specific_condition_waiting_period: obesity_treatment waiting period not completed.
