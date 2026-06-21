export type ClaimCategory =
  | "CONSULTATION"
  | "DIAGNOSTIC"
  | "PHARMACY"
  | "DENTAL"
  | "VISION"
  | "ALTERNATIVE_MEDICINE";

export type Decision = "APPROVED" | "PARTIAL" | "REJECTED" | "MANUAL_REVIEW";

export interface SubmittedDocument {
  file_id: string;
  file_name?: string;
  actual_type: string;
  quality?: "GOOD" | "UNREADABLE" | "LOW";
  patient_name_on_doc?: string;
  content?: Record<string, unknown>;
}

export interface ClaimInput {
  member_id: string;
  policy_id: string;
  claim_category: ClaimCategory;
  treatment_date: string;
  claimed_amount: number;
  hospital_name?: string;
  ytd_claims_amount?: number;
  claims_history?: Array<{ claim_id: string; date: string; amount: number; provider?: string }>;
  simulate_component_failure?: boolean;
  documents: SubmittedDocument[];
}

export interface TraceEntry {
  step: string;
  status: "PASS" | "FAIL" | "WARN" | "INFO";
  message: string;
  data?: Record<string, unknown>;
}

export interface DecisionResult {
  decision: Decision | null;
  approved_amount: number;
  reasons: string[];
  confidence_score: number;
  trace: TraceEntry[];
  user_message?: string;
  line_item_decisions?: Array<{
    description: string;
    amount: number;
    status: "APPROVED" | "REJECTED";
    reason?: string;
  }>;
  requires_resubmission?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PolicyTerms {
  policy_id: string;
  coverage: {
    annual_opd_limit: number;
    per_claim_limit: number;
  };
  opd_categories: Record<
    string,
    {
      sub_limit: number;
      copay_percent: number;
      network_discount_percent?: number;
      high_value_tests_requiring_pre_auth?: string[];
      pre_auth_threshold?: number;
      covered_procedures?: string[];
      excluded_procedures?: string[];
      covered_items?: string[];
      excluded_items?: string[];
      covered_systems?: string[];
      requires_registered_practitioner?: boolean;
    }
  >;
  waiting_periods: {
    initial_waiting_period_days: number;
    specific_conditions: Record<string, number>;
  };
  exclusions: {
    conditions: string[];
    dental_exclusions: string[];
    vision_exclusions: string[];
  };
  submission_rules: {
    deadline_days_from_treatment: number;
    minimum_claim_amount: number;
  };
  document_requirements: Record<ClaimCategory, { required: string[]; optional: string[] }>;
  fraud_thresholds: {
    same_day_claims_limit: number;
    monthly_claims_limit: number;
    high_value_claim_threshold: number;
    auto_manual_review_above: number;
    fraud_score_manual_review_threshold: number;
  };
  network_hospitals: string[];
  members: Array<{
    member_id: string;
    name: string;
    relationship: string;
    join_date?: string;
    primary_member_id?: string;
  }>;
}

export interface EvaluationCase {
  case_id: string;
  case_name: string;
  input: ClaimInput;
  expected: Record<string, unknown>;
}
