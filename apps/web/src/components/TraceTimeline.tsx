import type { FC } from "react";

export interface TraceItem {
  step: string;
  status: "PASS" | "FAIL" | "WARN" | "INFO";
  message: string;
}

interface Props {
  items: TraceItem[];
}

export const TraceTimeline: FC<Props> = ({ items }) => {
  return (
    <div className="trace-panel">
      <h3>Decision Trace</h3>
      {items.length === 0 ? (
        <p className="muted">Run a claim to see explainability trace.</p>
      ) : (
        <ul className="trace-list">
          {items.map((item, idx) => (
            <li key={`${item.step}-${idx}`} className={`trace-row trace-${item.status.toLowerCase()}`}>
              <span className="trace-tag">{item.status}</span>
              <div>
                <div className="trace-step">{item.step}</div>
                <div className="trace-message">{item.message}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
