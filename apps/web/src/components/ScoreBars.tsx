import type { Hypothesis } from "../lib/api";
import { formatNumber, scoreToPercent } from "../lib/format";

const scoreFields: { key: keyof Hypothesis; label: string; tone: string }[] = [
  { key: "score_growth", label: "成長インパクト", tone: "teal" },
  { key: "score_evidence", label: "証拠の強さ", tone: "indigo" },
  { key: "score_contradiction", label: "反証リスク", tone: "rose" },
  { key: "score_valuation_risk", label: "過熱リスク", tone: "amber" },
  { key: "score_overlooked", label: "見落とし度", tone: "green" },
  { key: "score_overall", label: "総合評価", tone: "slate" }
];

export function ScoreBars({ hypothesis }: { hypothesis: Hypothesis }) {
  return (
    <div className="score-bars">
      {scoreFields.map((field) => {
        const value = hypothesis[field.key] as number | string | null | undefined;
        return (
          <div className="score-row" key={field.key}>
            <div className="score-label">
              <span>{field.label}</span>
              <strong>{formatNumber(value)}</strong>
            </div>
            <div className="score-track">
              <span className={`score-fill ${field.tone}`} style={{ width: `${scoreToPercent(value)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

