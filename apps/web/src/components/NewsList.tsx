import { ExternalLink } from "lucide-react";
import type { DocumentRecord } from "../lib/api";
import { formatDate, formatNumber } from "../lib/format";

export function NewsList({ documents }: { documents: DocumentRecord[] }) {
  return (
    <div className="list">
      {documents.map((document) => (
        <article className="list-item" key={document.id}>
          <div className="list-kicker">
            <span>{formatDate(document.published_at)}</span>
            <span>{document.event_type ?? "event"}</span>
            <span>{document.sentiment ?? "neutral"}</span>
            <span>重要度 {formatNumber(document.importance_score)}</span>
          </div>
          <div className="list-title-row">
            <h3>{document.title}</h3>
            {document.url ? (
              <a href={document.url} target="_blank" rel="noreferrer" aria-label="source">
                <ExternalLink size={16} />
              </a>
            ) : null}
          </div>
          <p>{document.summary_short}</p>
          {document.summary_investment ? <p className="positive-copy">{document.summary_investment}</p> : null}
          {document.summary_risk ? <p className="risk-copy">{document.summary_risk}</p> : null}
        </article>
      ))}
    </div>
  );
}

