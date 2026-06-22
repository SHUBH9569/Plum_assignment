import type { FC } from "react";

export interface TraceItem {
  step: string;
  status: "PASS" | "FAIL" | "WARN" | "INFO";
  message: string;
  data?: Record<string, unknown>;
}

const ICONS: Record<TraceItem["status"], string> = {
  PASS: "✓",
  FAIL: "✗",
  WARN: "▲",
  INFO: "●",
};

interface Props {
  items: TraceItem[];
  title?: string;
}

export const TraceTimeline: FC<Props> = ({ items, title = "Decision Trace" }) => (
  <div className="trace-card">
    <div className="trace-card-header">
      <span className="info-card-title">{title}</span>
      {items.length > 0 && <span className="trace-count">{items.length} steps</span>}
    </div>

    {items.length === 0 ? (
      <div className="trace-empty">Run a claim to see the explainability trace.</div>
    ) : (
      <div className="trace-list">
        {items.map((item, idx) => (
          <div key={`${item.step}-${idx}`} className={`trace-item ti-${item.status.toLowerCase()}`}>
            <div className={`ti-icon ic-${item.status.toLowerCase()}`}>{ICONS[item.status]}</div>
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
);
