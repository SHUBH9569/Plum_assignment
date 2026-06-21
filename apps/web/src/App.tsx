import { useEffect, useMemo, useState } from "react";
import { TraceTimeline } from "./components/TraceTimeline";

interface DecisionResult {
  decision: "APPROVED" | "PARTIAL" | "REJECTED" | "MANUAL_REVIEW" | null;
  approved_amount: number;
  reasons: string[];
  confidence_score: number;
  user_message?: string;
  trace: Array<{ step: string; status: "PASS" | "FAIL" | "WARN" | "INFO"; message: string }>;
  line_item_decisions?: Array<{ description: string; amount: number; status: "APPROVED" | "REJECTED"; reason?: string }>;
}

interface TestCase {
  case_id: string;
  case_name: string;
  input: Record<string, unknown>;
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

export function App() {
  const [payload, setPayload] = useState<string>("{");
  const [result, setResult] = useState<DecisionResult | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [policySummary, setPolicySummary] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [casesRes, policyRes] = await Promise.all([
          fetch(`${API_BASE}/api/test-cases`),
          fetch(`${API_BASE}/api/policy/summary`)
        ]);

        if (casesRes.ok) {
          const body = await casesRes.json();
          const tc = (body.test_cases ?? []) as TestCase[];
          setTestCases(tc);
          if (tc[0]?.input) {
            setPayload(JSON.stringify(tc[0].input, null, 2));
          }
        }

        if (policyRes.ok) {
          setPolicySummary(await policyRes.json());
        }
      } catch {
        setError("Unable to connect to API. Start backend at http://localhost:8787");
      }
    };

    void load();
  }, []);

  const summaryText = useMemo(() => {
    if (!result) {
      return "No decision yet";
    }
    return `${result.decision ?? "BLOCKED"} | INR ${result.approved_amount} | Confidence ${(result.confidence_score * 100).toFixed(0)}%`;
  }, [result]);

  const runClaim = async () => {
    setError("");
    setLoading(true);
    setResult(null);

    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const res = await fetch(`${API_BASE}/api/claims/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.message ?? "Claim processing failed");
      }

      setResult(data as DecisionResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid input or API error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Plum AI Claims Command Center</p>
          <h1>Explainable Claim Decision Studio</h1>
          <p className="subtitle">
            Production-grade claim adjudication with policy-native rules, traceability, and resilient fallback handling.
          </p>
        </div>
        <div className="hero-card">
          <div className="hero-stat">{summaryText}</div>
          <p>Use official test cases or customize payload JSON for end-to-end validation.</p>
        </div>
      </header>

      <main className="layout">
        <section className="panel">
          <div className="panel-head">
            <h2>Claim Input</h2>
            <div className="controls">
              <select
                onChange={(e) => {
                  const chosen = testCases.find((t) => t.case_id === e.target.value);
                  if (chosen) {
                    setPayload(JSON.stringify(chosen.input, null, 2));
                  }
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  Load official test case
                </option>
                {testCases.map((tc) => (
                  <option key={tc.case_id} value={tc.case_id}>
                    {tc.case_id} - {tc.case_name}
                  </option>
                ))}
              </select>
              <button onClick={runClaim} disabled={loading}>
                {loading ? "Processing..." : "Process Claim"}
              </button>
            </div>
          </div>

          <textarea value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />

          {error && <div className="alert error">{error}</div>}
          {result?.user_message && <div className="alert info">{result.user_message}</div>}
        </section>

        <section className="panel side">
          <h2>Decision Output</h2>
          {result ? (
            <>
              <div className={`decision-chip chip-${String(result.decision ?? "BLOCKED").toLowerCase()}`}>
                {result.decision ?? "BLOCKED"}
              </div>
              <div className="metrics">
                <div>
                  <span>Approved Amount</span>
                  <strong>INR {result.approved_amount}</strong>
                </div>
                <div>
                  <span>Confidence</span>
                  <strong>{(result.confidence_score * 100).toFixed(1)}%</strong>
                </div>
              </div>
              <div className="reason-block">
                <h4>Reasons</h4>
                {result.reasons.length === 0 ? <p>None</p> : <ul>{result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              </div>
              {result.line_item_decisions && result.line_item_decisions.length > 0 && (
                <div className="reason-block">
                  <h4>Line Item Adjudication</h4>
                  <ul>
                    {result.line_item_decisions.map((item, idx) => (
                      <li key={`${item.description}-${idx}`}>
                        {item.description}: INR {item.amount} {"->"} {item.status}
                        {item.reason ? ` (${item.reason})` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <p className="muted">Submit a claim to view decision details.</p>
          )}

          <TraceTimeline items={result?.trace ?? []} />
        </section>
      </main>

      <footer className="footer">
        <div>
          <h4>Policy Snapshot</h4>
          <pre>{policySummary ? JSON.stringify(policySummary, null, 2) : "Loading policy summary..."}</pre>
        </div>
      </footer>
    </div>
  );
}
