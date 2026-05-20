import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { Hypothesis } from "../lib/api";
import { formatNumber } from "../lib/format";

const statuses = ["Draft", "Researching", "Under Review", "Promising", "Watchlist", "Rejected", "Inconclusive"];

export function HypothesisBoard({ hypotheses }: { hypotheses: Hypothesis[] }) {
  return (
    <div className="board">
      {statuses.map((status) => {
        const items = hypotheses.filter((hypothesis) => hypothesis.status === status);
        return (
          <section className="board-column" key={status}>
            <div className="board-heading">
              <span>{status}</span>
              <strong>{items.length}</strong>
            </div>
            <div className="board-items">
              {items.length === 0 ? <p className="empty">該当なし</p> : null}
              {items.map((hypothesis) => (
                <Link href={`/hypotheses/${hypothesis.id}`} className="hypothesis-card" key={hypothesis.id}>
                  <span className="pill">
                    {hypothesis.hypothesis_type === "global" ? "全体" : "個別"} / {hypothesis.target_sector ?? hypothesis.ticker ?? "未分類"}
                  </span>
                  <strong>{hypothesis.title}</strong>
                  <span className="muted">{hypothesis.company_name ?? hypothesis.ticker}</span>
                  <span className="card-foot">
                    総合 {formatNumber(hypothesis.score_overall)}
                    <ArrowUpRight size={14} />
                  </span>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
