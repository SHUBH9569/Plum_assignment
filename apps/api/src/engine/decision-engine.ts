import type { ClaimInput, DecisionResult, PolicyTerms, TraceEntry } from "../types.js";
import { addDays, daysBetween } from "../utils/date.js";
import { rupees } from "../utils/money.js";
import { verifyDocuments } from "./document-verifier.js";
import { extractStructuredData } from "./extractor.js";

const CONDITION_MAP: Array<{ key: string; patterns: string[] }> = [
  { key: "diabetes", patterns: ["diabetes", "t2dm", "type 2 diabetes"] },
  { key: "hypertension", patterns: ["hypertension", "htn"] },
  { key: "thyroid_disorders", patterns: ["thyroid", "hypothyroidism"] },
  { key: "obesity_treatment", patterns: ["obesity", "bariatric", "weight loss"] },
  { key: "maternity", patterns: ["maternity", "pregnancy"] },
  { key: "mental_health", patterns: ["depression", "anxiety", "mental"] },
  { key: "hernia", patterns: ["hernia"] },
  { key: "cataract", patterns: ["cataract"] }
];

export function processClaim(claim: ClaimInput, policy: PolicyTerms): DecisionResult {
  const trace: TraceEntry[] = [];
  let confidence = 0.95;

  const member = policy.members.find((m) => m.member_id === claim.member_id);
  if (!member) {
    return {
      decision: null,
      approved_amount: 0,
      reasons: ["MEMBER_NOT_FOUND"],
      confidence_score: 0.99,
      trace: [
        {
          step: "member_validation",
          status: "FAIL",
          message: `Member ${claim.member_id} is not found in policy roster.`
        }
      ],
      user_message: "Member ID is invalid. Please verify your employee/member ID.",
      requires_resubmission: true
    };
  }

  trace.push({
    step: "member_validation",
    status: "PASS",
    message: `Member ${member.name} is eligible in roster.`
  });

  const categoryRules = policy.document_requirements[claim.claim_category];
  const docCheck = verifyDocuments(claim, categoryRules.required);
  trace.push(...docCheck.trace);

  if (!docCheck.ok) {
    return {
      decision: null,
      approved_amount: 0,
      reasons: ["DOCUMENT_VERIFICATION_FAILED"],
      confidence_score: 0.98,
      trace,
      user_message: docCheck.user_message,
      requires_resubmission: docCheck.needs_resubmission
    };
  }

  const extracted = extractStructuredData(claim);
  trace.push(...extracted.trace);
  confidence += extracted.confidenceDelta;

  const diagnosisText = String(extracted.extracted.diagnosis ?? extracted.extracted.treatment ?? "").toLowerCase();

  const minimum = policy.submission_rules.minimum_claim_amount;
  if (claim.claimed_amount < minimum) {
    trace.push({
      step: "minimum_claim_amount",
      status: "FAIL",
      message: `Claimed amount ${claim.claimed_amount} is below minimum ${minimum}.`
    });
    return withDecision("REJECTED", 0, ["BELOW_MINIMUM_CLAIM_AMOUNT"], trace, confidence, {
      user_message: `Minimum claim amount is INR ${minimum}.`
    });
  }

  const memberJoinDate = member.join_date;
  if (memberJoinDate) {
    const elapsedDays = daysBetween(claim.treatment_date, memberJoinDate);
    if (elapsedDays < policy.waiting_periods.initial_waiting_period_days) {
      trace.push({
        step: "initial_waiting_period",
        status: "FAIL",
        message: `Initial waiting period not completed. Elapsed: ${elapsedDays} days.`
      });

      return withDecision("REJECTED", 0, ["WAITING_PERIOD"], trace, confidence, {
        user_message: `Initial waiting period of ${policy.waiting_periods.initial_waiting_period_days} days is not completed.`
      });
    }

    for (const condition of CONDITION_MAP) {
      if (condition.patterns.some((p) => diagnosisText.includes(p))) {
        const waitDays = policy.waiting_periods.specific_conditions[condition.key] ?? 0;
        if (waitDays > 0 && elapsedDays < waitDays) {
          const eligibleFrom = addDays(memberJoinDate, waitDays);
          trace.push({
            step: "specific_condition_waiting_period",
            status: "FAIL",
            message: `${condition.key} waiting period not completed.`,
            data: { elapsedDays, requiredDays: waitDays, eligibleFrom }
          });

          return withDecision("REJECTED", 0, ["WAITING_PERIOD"], trace, confidence, {
            user_message: `This treatment falls under ${condition.key}. You will be eligible from ${eligibleFrom}.`
          });
        }
      }
    }
  }

  if (
    diagnosisText.includes("obesity") ||
    diagnosisText.includes("bariatric") ||
    diagnosisText.includes("weight loss")
  ) {
    trace.push({
      step: "policy_exclusions",
      status: "FAIL",
      message: "Claim falls under excluded condition category."
    });

    return withDecision("REJECTED", 0, ["EXCLUDED_CONDITION"], trace, confidence, {
      user_message: "Obesity treatment and bariatric programs are excluded under this policy."
    });
  }

  if (claim.claim_category === "DIAGNOSTIC") {
    const extractedLineItems = Array.isArray(extracted.extracted.line_items)
      ? extracted.extracted.line_items.map((i) => String((i as Record<string, unknown>).description ?? ""))
      : [];

    const tests = [...toStringList(extracted.extracted.tests_ordered), ...toStringList(extractedLineItems)]
      .join(" ")
      .toLowerCase();

    const diagnosticConfig = policy.opd_categories.diagnostic;
    const isHighValueMRI =
      tests.includes("mri") &&
      claim.claimed_amount > (diagnosticConfig.pre_auth_threshold ?? Number.MAX_SAFE_INTEGER);

    if (isHighValueMRI) {
      trace.push({
        step: "pre_authorization",
        status: "FAIL",
        message: "Pre-authorization required for high-value MRI claim, but no pre-auth document was found."
      });

      return withDecision("REJECTED", 0, ["PRE_AUTH_MISSING"], trace, confidence, {
        user_message:
          "Pre-authorization is mandatory for MRI claims above INR 10,000. Please resubmit with valid pre-auth approval."
      });
    }
  }

  const fraudSignals = evaluateFraud(claim, policy);
  if (fraudSignals.score >= policy.fraud_thresholds.fraud_score_manual_review_threshold) {
    trace.push({
      step: "fraud_detection",
      status: "WARN",
      message: "Claim routed to manual review due to fraud signals.",
      data: fraudSignals
    });
    confidence -= 0.15;

    return withDecision("MANUAL_REVIEW", 0, ["FRAUD_SIGNAL"], trace, confidence, {
      user_message: `Manual review required due to: ${fraudSignals.reasons.join("; ")}`,
      metadata: { fraudSignals }
    });
  }

  if (claim.claim_category === "CONSULTATION" && claim.claimed_amount > policy.coverage.per_claim_limit) {
    trace.push({
      step: "per_claim_limit",
      status: "FAIL",
      message: `Claim amount ${claim.claimed_amount} exceeds per-claim limit ${policy.coverage.per_claim_limit}.`
    });

    return withDecision("REJECTED", 0, ["PER_CLAIM_EXCEEDED"], trace, confidence, {
      user_message: `Claimed amount INR ${claim.claimed_amount} exceeds per-claim limit INR ${policy.coverage.per_claim_limit}.`
    });
  }

  let approvedAmount = claim.claimed_amount;
  const categoryConfig = policy.opd_categories[claim.claim_category.toLowerCase()];

  const lineItems = toLineItems(extracted.extracted.line_items);
  const lineItemDecisions: DecisionResult["line_item_decisions"] = [];

  if (claim.claim_category === "DENTAL" && lineItems.length > 0) {
    let accepted = 0;
    for (const item of lineItems) {
      const itemText = item.description.toLowerCase();
      const isExcluded = (categoryConfig.excluded_procedures ?? []).some((p) => itemText.includes(p.toLowerCase()));
      if (isExcluded) {
        lineItemDecisions.push({
          description: item.description,
          amount: item.amount,
          status: "REJECTED",
          reason: "Excluded cosmetic dental procedure"
        });
      } else {
        accepted += item.amount;
        lineItemDecisions.push({ description: item.description, amount: item.amount, status: "APPROVED" });
      }
    }
    approvedAmount = accepted;

    if (accepted < claim.claimed_amount) {
      trace.push({
        step: "dental_line_item_policy",
        status: "WARN",
        message: "Some line items were excluded as cosmetic dental procedures.",
        data: { accepted, claimed: claim.claimed_amount }
      });

      return withDecision("PARTIAL", rupees(approvedAmount), ["PARTIAL_EXCLUSION"], trace, confidence, {
        user_message: "Claim partially approved after excluding non-covered cosmetic dental procedures.",
        line_item_decisions: lineItemDecisions
      });
    }
  }

  const detectedHospital = String(extracted.extracted.hospital_name ?? claim.hospital_name ?? "");
  if (detectedHospital && policy.network_hospitals.some((h) => h.toLowerCase() === detectedHospital.toLowerCase())) {
    const discountPct = categoryConfig.network_discount_percent ?? 0;
    const discounted = approvedAmount * (1 - discountPct / 100);
    trace.push({
      step: "network_discount",
      status: "PASS",
      message: `Network discount of ${discountPct}% applied before copay.`,
      data: { original: approvedAmount, discounted: rupees(discounted) }
    });
    approvedAmount = rupees(discounted);
  }

  const copayPct = categoryConfig.copay_percent ?? 0;
  const copayAmount = approvedAmount * (copayPct / 100);
  approvedAmount = rupees(approvedAmount - copayAmount);

  trace.push({
    step: "copay",
    status: "PASS",
    message: `Copay of ${copayPct}% applied.`,
    data: { copayAmount: rupees(copayAmount), approvedAmount }
  });

  if (extracted.failedComponent) {
    trace.push({
      step: "graceful_degradation",
      status: "WARN",
      message: `Component ${extracted.failedComponent} failed; decision generated with degraded confidence.`
    });
  }

  const notes = extracted.failedComponent
    ? "A downstream extraction component failed. Decision is auto-generated with lower confidence; manual review recommended."
    : "Claim approved based on policy checks.";

  return withDecision("APPROVED", approvedAmount, [], trace, confidence, {
    user_message: notes,
    metadata: extracted.failedComponent ? { manual_review_recommended: true } : undefined
  });
}

function withDecision(
  decision: DecisionResult["decision"],
  approved_amount: number,
  reasons: string[],
  trace: TraceEntry[],
  confidence: number,
  extras: Partial<DecisionResult> = {}
): DecisionResult {
  return {
    decision,
    approved_amount,
    reasons,
    confidence_score: Math.max(0.3, Math.min(0.99, rupees(confidence))),
    trace,
    ...extras
  };
}

function evaluateFraud(claim: ClaimInput, policy: PolicyTerms): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const sameDayClaims = (claim.claims_history ?? []).filter((h) => h.date === claim.treatment_date).length;
  if (sameDayClaims > policy.fraud_thresholds.same_day_claims_limit) {
    score += 0.9;
    reasons.push(`same-day claims count ${sameDayClaims + 1} exceeds limit ${policy.fraud_thresholds.same_day_claims_limit}`);
  }

  const monthPrefix = claim.treatment_date.slice(0, 7);
  const monthlyClaims = (claim.claims_history ?? []).filter((h) => h.date.startsWith(monthPrefix)).length;
  if (monthlyClaims > policy.fraud_thresholds.monthly_claims_limit) {
    score += 0.3;
    reasons.push(`monthly claims count ${monthlyClaims + 1} exceeds limit ${policy.fraud_thresholds.monthly_claims_limit}`);
  }

  return { score, reasons };
}

function toLineItems(value: unknown): Array<{ description: string; amount: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const description = String((entry as Record<string, unknown>).description ?? "").trim();
      const amount = Number((entry as Record<string, unknown>).amount ?? 0);
      return { description, amount };
    })
    .filter((i) => i.description.length > 0 && Number.isFinite(i.amount));
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((v) => String(v));
}
