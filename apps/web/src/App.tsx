import { useCallback, useEffect, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────
type TraceStatus = "PASS" | "FAIL" | "WARN" | "INFO";
type ClaimDecision = "APPROVED" | "PARTIAL" | "REJECTED" | "MANUAL_REVIEW";

interface TraceEntry {
  step: string;
  status: TraceStatus;
  message: string;
  data?: Record<string, unknown>;
}

interface LineItemDecision {
  description: string;
  amount: number;
  status: "APPROVED" | "REJECTED";
  reason?: string;
}

interface DocInfo {
  file_name?: string;
  actual_type?: string;
  content?: {
    ocr_provider?: string;
    ocr_confidence?: number;
    patient_name?: string;
    diagnosis?: string;
    doctor_name?: string;
    hospital_name?: string;
    total?: number;
  };
}

interface DecisionResult {
  decision: ClaimDecision | null;
  approved_amount: number;
  reasons: string[];
  confidence_score: number;
  user_message?: string;
  trace: TraceEntry[];
  line_item_decisions?: LineItemDecision[];
  documents?: DocInfo[];
  requires_resubmission?: boolean;
}

interface LiveEvent {
  type: "status" | "final" | "error";
  step?: string;
  status?: TraceStatus;
  message?: string;
  result?: DecisionResult;
  data?: Record<string, unknown>;
}

interface TestCase {
  case_id: string;
  case_name: string;
  expected?: { decision: string | null; system_must?: string[] };
  input: Record<string, unknown>;
}

interface UploadDocRow {
  id: string;
  actual_type: string;
  quality: "GOOD" | "LOW" | "UNREADABLE";
  file: File | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8787";
const API_CANDIDATES = [DEFAULT_API_BASE, "http://localhost:8787", "http://localhost:8791"];

const CATEGORY_OPTIONS = ["CONSULTATION", "DIAGNOSTIC", "PHARMACY", "DENTAL", "VISION", "ALTERNATIVE_MEDICINE"] as const;
const DOC_TYPE_OPTIONS = ["PRESCRIPTION", "HOSPITAL_BILL", "LAB_REPORT", "PHARMACY_BILL", "DENTAL_REPORT", "DISCHARGE_SUMMARY", "DIAGNOSTIC_REPORT"] as const;

const DECISION_META: Record<string, { icon: string; label: string; cls: string }> = {
  APPROVED:      { icon: "✓", label: "Approved",           cls: "approved" },
  PARTIAL:       { icon: "◐", label: "Partially Approved", cls: "partial" },
  REJECTED:      { icon: "✗", label: "Rejected",           cls: "rejected" },
  MANUAL_REVIEW: { icon: "⚑", label: "Manual Review",      cls: "manual" },
  BLOCKED:       { icon: "⊘", label: "Blocked",            cls: "blocked" },
};

const TRACE_META: Record<TraceStatus, { icon: string }> = {
  PASS: { icon: "✓" },
  FAIL: { icon: "✗" },
  WARN: { icon: "▲" },
  INFO: { icon: "●" },
};

const fmt = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// ─── Pipeline stages for progress ribbon ────────────────────────────────────
// Keys match the `step` field emitted by the multi-agent orchestrator.
// Upload-mode adds ai_extraction / ai_extract_document before the agent pipeline.
const PIPELINE_STAGES: Array<{ key: string; label: string; pct: number }> = [
  { key: "request_received",         label: "Received",   pct: 6  },
  { key: "input_validation",         label: "Validated",  pct: 14 },
  { key: "ai_extraction",            label: "OCR Start",  pct: 24 }, // upload-mode OCR phase
  { key: "ai_extract_document",      label: "OCR Doc",    pct: 34 }, // upload-mode per-doc
  { key: "agent_document_verify",    label: "Doc Check",  pct: 44 }, // Agent 1
  { key: "agent_extraction",         label: "Extract",    pct: 60 }, // Agent 2 (parallel)
  { key: "agent_risk_analysis",      label: "AI Risk",    pct: 72 }, // Agent 3 (parallel)
  { key: "agent_policy_adjudication",label: "Adjudicate", pct: 88 }, // Agent 4
  { key: "completed",                label: "Complete",   pct: 100 },
];

// ─── App ─────────────────────────────────────────────────────────────────────
export function App() {
  const [mode, setMode]             = useState<"json" | "upload">("json");
  const [payload, setPayload]       = useState<string>("");
  const [result, setResult]         = useState<DecisionResult | null>(null);
  const [liveTrace, setLiveTrace]   = useState<TraceEntry[]>([]);
  const [error, setError]           = useState<string>("");
  const [loading, setLoading]       = useState(false);
  const [testCases, setTestCases]   = useState<TestCase[]>([]);
  const [policy, setPolicy]         = useState<Record<string, unknown> | null>(null);
  const [apiBase, setApiBase]       = useState(DEFAULT_API_BASE);
  const [apiStatus, setApiStatus]   = useState<"up" | "down" | "checking">("checking");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [selectedCase, setSelectedCase] = useState<string>("");

  const [uploadForm, setUploadForm] = useState({
    member_id: "EMP001",
    policy_id: "PLUM_GHI_2024",
    claim_category: "CONSULTATION",
    treatment_date: "2024-11-01",
    claimed_amount: "1500",
    hospital_name: ""
  });

  const [uploadDocs, setUploadDocs] = useState<UploadDocRow[]>([
    { id: "d1", actual_type: "PRESCRIPTION", quality: "GOOD", file: null },
    { id: "d2", actual_type: "HOSPITAL_BILL", quality: "GOOD", file: null }
  ]);

  // ── API resolution ─────────────────────────────────────────────────────────
  const resolveBase = useCallback(async (): Promise<string> => {
    const seen = new Set<string>();
    for (const b of API_CANDIDATES) {
      if (seen.has(b)) continue;
      seen.add(b);
      try {
        const r = await fetch(`${b}/health`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) return b;
      } catch {}
    }
    throw new Error("No API server reachable on configured ports.");
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const base = await resolveBase();
        setApiBase(base);
        setApiStatus("up");

        const [cRes, pRes] = await Promise.all([
          fetch(`${base}/api/test-cases`),
          fetch(`${base}/api/policy/summary`)
        ]);

        if (cRes.ok) {
          const body = await cRes.json() as { test_cases?: TestCase[] };
          const tc = body.test_cases ?? [];
          setTestCases(tc);
          if (tc[0]) {
            setPayload(JSON.stringify(tc[0].input, null, 2));
            setSelectedCase(tc[0].case_id);
          }
        }
        if (pRes.ok) setPolicy(await pRes.json() as Record<string, unknown>);
      } catch {
        setApiStatus("down");
        setError("API offline. Run: pnpm dev:api");
      }
    })();
  }, [resolveBase]);

  // ── Streaming fetch ────────────────────────────────────────────────────────
  const streamRequest = useCallback(async (path: string, init: RequestInit) => {
    const bases = [...new Set([apiBase, ...API_CANDIDATES])];
    let lastErr: Error | null = null;

    for (const base of bases) {
      let res: Response;
      try {
        res = await fetch(`${base}${path}`, init);
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error("Network error");
        continue;
      }

      if (res.status === 404) continue;
      setApiBase(base);

      if (!res.ok) {
        let msg = "Request failed";
        try { msg = ((await res.json()) as { message?: string }).message ?? msg; } catch {}
        throw new Error(msg);
      }
      if (!res.body) throw new Error("Empty response body.");

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let final: DecisionResult | null = null;

      const handle = (ev: LiveEvent) => {
        if (ev.type === "status" && ev.step) {
          setLiveTrace(p => [...p, {
            step: ev.step!,
            status: ev.status ?? "INFO",
            message: ev.message ?? "",
            data: ev.data
          }]);
        }
        if (ev.type === "error") throw new Error(ev.message ?? "Processing error");
        if (ev.type === "final" && ev.result) {
          final = ev.result;
          setResult(ev.result);
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          buf += dec.decode(value ?? new Uint8Array(), { stream: !done });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const ln of lines) {
            const t = ln.trim();
            if (t) handle(JSON.parse(t) as LiveEvent);
          }
          if (done) break;
        }
        if (buf.trim()) handle(JSON.parse(buf.trim()) as LiveEvent);
      } finally {
        reader.releaseLock();
      }

      if (!final) throw new Error("Stream ended without a final result.");
      return;
    }

    throw lastErr ?? new Error("All API endpoints failed.");
  }, [apiBase]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const runJson = async () => {
    setError(""); setLoading(true); setResult(null); setLiveTrace([]);
    try {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(payload) as Record<string, unknown>; }
      catch { throw new Error("Invalid JSON — check format and try again."); }
      await streamRequest("/api/claims/process-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed)
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally { setLoading(false); }
  };

  const runUpload = async () => {
    setError(""); setLoading(true); setResult(null); setLiveTrace([]);
    try {
      const docs = uploadDocs.filter(d => d.file);
      if (!docs.length) throw new Error("Attach at least one file before processing.");
      const amt = Number(uploadForm.claimed_amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Claimed amount must be positive.");

      const fd = new FormData();
      fd.append("claim_payload", JSON.stringify({
        member_id: uploadForm.member_id,
        policy_id: uploadForm.policy_id,
        claim_category: uploadForm.claim_category,
        treatment_date: uploadForm.treatment_date,
        claimed_amount: amt,
        hospital_name: uploadForm.hospital_name || undefined,
        documents: []
      }));
      fd.append("document_meta", JSON.stringify(docs.map(d => ({
        filename: d.file!.name,
        actual_type: d.actual_type,
        quality: d.quality
      }))));
      for (const d of docs) fd.append("documents", d.file!);

      await streamRequest("/api/claims/process-form-live", { method: "POST", body: fd });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally { setLoading(false); }
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const traceItems = loading ? liveTrace : (result?.trace ?? liveTrace);
  const decKey = result?.decision ?? (result ? "BLOCKED" : null);
  const dm = decKey ? DECISION_META[decKey] : null;

  const curCase = testCases.find(t => t.case_id === selectedCase);

  // Progress ribbon: find highest pipeline stage reached in liveTrace.
  // Only return 100% when the pipeline actually ran to adjudication (decision !== null).
  // A blocked claim (decision === null) stops at the stage that failed.
  const progressPct = (() => {
    if (!loading && !result) return 0;
    if (result && result.decision != null) return 100; // != catches both null and undefined
    // Loading or blocked (decision null/undefined): advance ribbon only up to last agent stage.
    // Skip "completed" — it fires unconditionally from the route and would force 100% on blocked claims.
    const steps = new Set(liveTrace.map(t => t.step));
    let best = 0;
    for (const stage of PIPELINE_STAGES) {
      if (stage.key === "completed") continue;
      if (steps.has(stage.key)) best = stage.pct;
    }
    return best || 5;
  })();

  const isBlocked = result != null && result.decision == null; // covers both null and undefined

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* ── Navbar ── */}
      <nav className="navbar">
        <div className="nav-brand">
          <div className="nav-logo">P</div>
          <div>
            <div className="nav-name">Plum Claims AI</div>
            <div className="nav-tagline">Policy-Driven Adjudication Engine</div>
          </div>
        </div>
        <div className="nav-right" />
      </nav>

      {/* ── Main grid ── */}
      <div className="main-grid">
        {/* LEFT — Input */}
        <aside className="left-panel">
          {/* Mode tabs */}
          <div className="mode-bar">
            <button
              className={`mode-tab ${mode === "json" ? "mode-tab--active" : ""}`}
              onClick={() => setMode("json")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              JSON Mode
            </button>
            <button
              className={`mode-tab ${mode === "upload" ? "mode-tab--active" : ""}`}
              onClick={() => setMode("upload")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16,16 12,12 8,16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
              Upload Mode
            </button>
          </div>

          {/* ── JSON Mode ── */}
          {mode === "json" && (
            <div className="json-mode">
              <div className="section-header">
                <h3>Claim Input</h3>
                <button
                  className="btn-primary"
                  onClick={runJson}
                  disabled={loading || apiStatus !== "up"}
                >
                  {loading
                    ? <><span className="spin" /> Processing…</>
                    : <>Process Claim <span className="btn-arrow">→</span></>}
                </button>
              </div>

              {/* Test case picker */}
              <div className="tc-picker">
                <label className="field-label">Load test case</label>
                <select
                  value={selectedCase}
                  onChange={e => {
                    const tc = testCases.find(t => t.case_id === e.target.value);
                    if (tc) {
                      setSelectedCase(tc.case_id);
                      setPayload(JSON.stringify(tc.input, null, 2));
                    }
                  }}
                >
                  {testCases.map(tc => (
                    <option key={tc.case_id} value={tc.case_id}>
                      {tc.case_id} — {tc.case_name}
                    </option>
                  ))}
                </select>
                {curCase?.expected && (
                  <div className="expected-badge">
                    Expected: <strong>{curCase.expected.decision ?? "null (blocked)"}</strong>
                  </div>
                )}
              </div>

              <textarea
                className="json-editor"
                value={payload}
                onChange={e => setPayload(e.target.value)}
                spellCheck={false}
                placeholder='{"member_id": "EMP001", "policy_id": "PLUM_GHI_2024", ...}'
              />
            </div>
          )}

          {/* ── Upload Mode ── */}
          {mode === "upload" && (
            <div className="upload-mode">
              <div className="section-header">
                <h3>Upload Claim</h3>
                <button
                  className="btn-primary"
                  onClick={runUpload}
                  disabled={loading || apiStatus !== "up"}
                >
                  {loading
                    ? <><span className="spin" /> Extracting…</>
                    : <>Submit Claim <span className="btn-arrow">→</span></>}
                </button>
              </div>

              <div className="form-grid">
                <div className="field-group">
                  <label className="field-label">Member ID</label>
                  <input value={uploadForm.member_id} onChange={e => setUploadForm(p => ({ ...p, member_id: e.target.value }))} />
                </div>
                <div className="field-group">
                  <label className="field-label">Policy ID</label>
                  <input value={uploadForm.policy_id} onChange={e => setUploadForm(p => ({ ...p, policy_id: e.target.value }))} />
                </div>
                <div className="field-group">
                  <label className="field-label">Category</label>
                  <select value={uploadForm.claim_category} onChange={e => setUploadForm(p => ({ ...p, claim_category: e.target.value }))}>
                    {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field-group">
                  <label className="field-label">Treatment Date</label>
                  <input type="date" value={uploadForm.treatment_date} onChange={e => setUploadForm(p => ({ ...p, treatment_date: e.target.value }))} />
                </div>
                <div className="field-group">
                  <label className="field-label">Claimed Amount (INR)</label>
                  <input type="number" value={uploadForm.claimed_amount} onChange={e => setUploadForm(p => ({ ...p, claimed_amount: e.target.value }))} />
                </div>
                <div className="field-group">
                  <label className="field-label">Hospital (optional)</label>
                  <input value={uploadForm.hospital_name} placeholder="Apollo Hospital…" onChange={e => setUploadForm(p => ({ ...p, hospital_name: e.target.value }))} />
                </div>
              </div>

              <div className="docs-section">
                <div className="docs-section-header">
                  <span className="field-label">Documents</span>
                  <button className="btn-ghost" onClick={() =>
                    setUploadDocs(p => [...p, { id: Math.random().toString(36).slice(2), actual_type: "PRESCRIPTION", quality: "GOOD", file: null }])
                  }>+ Add</button>
                </div>
                {uploadDocs.map(doc => (
                  <div className="doc-row" key={doc.id}>
                    <select
                      value={doc.actual_type}
                      onChange={e => setUploadDocs(p => p.map(d => d.id === doc.id ? { ...d, actual_type: e.target.value } : d))}
                    >
                      {DOC_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select
                      value={doc.quality}
                      onChange={e => setUploadDocs(p => p.map(d => d.id === doc.id ? { ...d, quality: e.target.value as UploadDocRow["quality"] } : d))}
                    >
                      <option value="GOOD">GOOD</option>
                      <option value="LOW">LOW</option>
                      <option value="UNREADABLE">UNREADABLE</option>
                    </select>
                    <label className="file-pick">
                      {doc.file ? <span className="file-name-badge">📄 {doc.file.name}</span> : <span className="file-placeholder">Choose file…</span>}
                      <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.json"
                        onChange={e => {
                          const f = e.target.files?.[0] ?? null;
                          setUploadDocs(p => p.map(d => d.id === doc.id ? { ...d, file: f } : d));
                        }}
                      />
                    </label>
                    <button className="btn-remove" onClick={() => setUploadDocs(p => p.filter(d => d.id !== doc.id))} title="Remove">×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="alert-error" role="alert">
              <span className="alert-icon">⚠</span>
              <span>{error}</span>
              <button className="alert-dismiss" onClick={() => setError("")}>×</button>
            </div>
          )}
        </aside>

        {/* RIGHT — Output */}
        <div className="right-panel">
          {/* Decision card */}
          <div className={`decision-card ${dm ? `dc--${dm.cls}` : "dc--empty"}`}>
            {loading ? (
              <div className="dc-loading">
                <div className="pulse-rings">
                  <div className="ring r1" />
                  <div className="ring r2" />
                  <div className="ring r3" />
                </div>
                <div className="dc-loading-text">Adjudicating claim…</div>
                {liveTrace.length > 0 && (
                  <div className="dc-loading-step">{liveTrace[liveTrace.length - 1].step.replace(/_/g, " ")}</div>
                )}
              </div>
            ) : result ? (
              <>
                <div className="dc-icon">{dm?.icon ?? "?"}</div>
                <div className="dc-label">{dm?.label ?? result.decision}</div>
                <div className="dc-metrics">
                  <div className="dc-metric">
                    <div className="dc-metric-label">Approved</div>
                    <div className="dc-metric-value">{fmt(result.approved_amount)}</div>
                  </div>
                  <div className="dc-metric">
                    <div className="dc-metric-label">Confidence</div>
                    <div className="dc-confidence">
                      <div className="dc-conf-bar">
                        <div
                          className="dc-conf-fill"
                          style={{ width: `${(result.confidence_score * 100).toFixed(0)}%` }}
                        />
                      </div>
                      <span className="dc-conf-pct">{(result.confidence_score * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                </div>
                {result.user_message && (
                  <div className="dc-msg">{result.user_message}</div>
                )}
                {result.reasons.length > 0 && (
                  <div className="dc-reasons">
                    {result.reasons.map(r => (
                      <span key={r} className="reason-chip">{r.replace(/_/g, " ")}</span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="dc-empty">
                <div className="dc-empty-icon">⊙</div>
                <div className="dc-empty-text">Submit a claim to see the adjudication result</div>
              </div>
            )}
          </div>

          {/* Line items */}
          {result?.line_item_decisions && result.line_item_decisions.length > 0 && (
            <div className="info-card">
              <div className="info-card-title">Line Item Adjudication</div>
              <table className="li-table">
                <thead>
                  <tr><th>Description</th><th>Amount</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {result.line_item_decisions.map((li, i) => (
                    <tr key={i}>
                      <td>{li.description}</td>
                      <td className="li-amount">{fmt(li.amount)}</td>
                      <td>
                        <span className={`li-badge li-${li.status.toLowerCase()}`}>
                          {li.status === "APPROVED" ? "✓" : "✗"} {li.status}
                        </span>
                        {li.reason && <span className="li-reason"> — {li.reason}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Document extraction */}
          {result?.documents && result.documents.length > 0 && (
            <div className="info-card">
              <div className="info-card-title">AI Document Extraction</div>
              {result.documents.map((doc, i) => (
                <div key={i} className="doc-extract">
                  <div className="doc-extract-head">
                    <span className="doc-extract-name">📄 {doc.file_name ?? `Document ${i + 1}`}</span>
                    <span className={`provider-chip provider-${doc.content?.ocr_provider ?? "heuristic"}`}>
                      {doc.content?.ocr_provider ?? "heuristic"}
                    </span>
                    {typeof doc.content?.ocr_confidence === "number" && (
                      <span className="conf-chip">{(doc.content.ocr_confidence * 100).toFixed(0)}% conf</span>
                    )}
                  </div>
                  {(doc.content?.patient_name || doc.content?.diagnosis || doc.content?.doctor_name) && (
                    <div className="doc-fields">
                      {doc.content?.patient_name && <span>Patient: <strong>{doc.content.patient_name}</strong></span>}
                      {doc.content?.diagnosis && <span>Diagnosis: <strong>{doc.content.diagnosis}</strong></span>}
                      {doc.content?.doctor_name && <span>Doctor: <strong>{doc.content.doctor_name}</strong></span>}
                      {doc.content?.hospital_name && <span>Hospital: <strong>{doc.content.hospital_name}</strong></span>}
                      {doc.content?.total && <span>Total: <strong>{fmt(doc.content.total)}</strong></span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Progress ribbon */}
          {(loading || result) && (
            <div className="progress-ribbon">
              <div className="pr-bar-wrap">
                <div
                  className={`pr-bar-fill ${isBlocked ? "pr-blocked" : result ? "pr-done" : "pr-live"}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="pr-stages">
                {PIPELINE_STAGES.filter(s => s.key !== "ai_extract_document").map(stage => {
                  const reached = progressPct >= stage.pct;
                  const active  = progressPct >= stage.pct && progressPct < (PIPELINE_STAGES.find(s2 => s2.pct > stage.pct)?.pct ?? 101);
                  const failed  = liveTrace.some(t => t.step === stage.key && t.status === "FAIL");
                  return (
                    <div key={stage.key} className={`pr-stage ${reached ? "pr-stage--done" : ""} ${active && loading ? "pr-stage--active" : ""} ${failed ? "pr-stage--failed" : ""}`}>
                      <div className="pr-dot" />
                      <div className="pr-stage-label">{stage.label}</div>
                      {active && loading && <div className="pr-pct">{stage.pct}%</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Trace timeline */}
          <div className="trace-card">
            <div className="trace-card-header">
              <span className="info-card-title">Decision Trace</span>
              {traceItems.length > 0 && (
                <span className="trace-count">{traceItems.length} steps</span>
              )}
            </div>

            {traceItems.length === 0 ? (
              <div className="trace-empty">
                Run a claim to see the full explainability trace
              </div>
            ) : (
              <div className="trace-list">
                {traceItems.map((item, idx) => (
                  <div key={idx} className={`trace-item ti-${item.status.toLowerCase()}`}>
                    <div className={`ti-icon ic-${item.status.toLowerCase()}`}>
                      {TRACE_META[item.status].icon}
                    </div>
                    <div className="ti-body">
                      <div className="ti-head">
                        <span className="ti-step">{item.step.replace(/_/g, " ")}</span>
                        <span className={`ti-badge tb-${item.status.toLowerCase()}`}>{item.status}</span>
                      </div>
                      <div className="ti-msg">{item.message}</div>
                      {item.data && Object.keys(item.data).length > 0 && (
                        <details className="ti-data">
                          <summary>Show data</summary>
                          <pre>{JSON.stringify(item.data, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Policy Footer ── */}
      <div className="policy-strip">
        <button className="policy-toggle" onClick={() => setPolicyOpen(p => !p)}>
          <span className="policy-toggle-label">
            <span className="policy-dot" />
            Policy: PLUM_GHI_2024
          </span>
          <span className="policy-toggle-chevron">{policyOpen ? "▲" : "▼"}</span>
        </button>

        {policyOpen && (
          <div className="policy-body">
            {policy ? (
              <div className="policy-grid">
                {Object.entries(policy).map(([k, v]) => (
                  <div key={k} className="policy-field">
                    <div className="pf-key">{k.replace(/_/g, " ")}</div>
                    <div className="pf-val">
                      {typeof v === "object" && v !== null
                        ? <pre>{JSON.stringify(v, null, 2)}</pre>
                        : String(v)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="policy-loading">Loading policy…</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
