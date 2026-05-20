import { Activity, Building2, Database, FileText, Gauge, Layers3 } from "lucide-react";
import Link from "next/link";
import { FoundationFetchPanel } from "../components/FoundationFetchPanel";
import { HypothesisBoard } from "../components/HypothesisBoard";
import { MacroFetchButton } from "../components/MacroFetchButton";
import { NewsList } from "../components/NewsList";
import { ScoreBars } from "../components/ScoreBars";
import { TickerSearch } from "../components/TickerSearch";
import { apiFetch, type Overview } from "../lib/api";
import { formatDate, formatNumber, formatPercent } from "../lib/format";

const emptyOverview: Overview = {
  macro_summary: ["API / DB の初期化中、またはエラーが発生しています。下の実データ取得パネルは利用できます。"],
  macro_indicators: [],
  macro_news: [],
  sectors: [],
  company_count: 0,
  companies: [],
  events: [],
  documents: [],
  hypotheses: []
};

export default async function HomePage() {
  let overview = emptyOverview;
  let overviewError: string | null = null;
  try {
    overview = await apiFetch<Overview>("/api/overview");
  } catch (error) {
    overviewError = error instanceof Error ? error.message : "overview fetch failed";
  }
  const leadHypothesis = overview.hypotheses[0];

  return (
    <main className="page">
      <section className="dashboard-band">
        {overviewError ? <div className="inline-alert">APIエラー: {overviewError}</div> : null}
        <div className="section-heading">
          <div>
            <p className="eyebrow">Market Themes</p>
            <h1>テーマ、イベント、仮説</h1>
          </div>
          <div className="status-strip">
            <span>銘柄 {overview.company_count ?? overview.companies.length}</span>
            <span>イベント {overview.events.length}</span>
            <span>仮説 {overview.hypotheses.length}</span>
          </div>
        </div>
        <div className="overview-grid">
          <section className="panel">
            <div className="panel-title with-action">
              <div className="title-with-icon">
                <Gauge size={18} />
                <h2>マクロ要因</h2>
              </div>
              <MacroFetchButton />
            </div>
            <div className="macro-list">
              {overview.macro_summary.map((item, index) => (
                <p key={`${item}-${index}`}>{item}</p>
              ))}
            </div>
            {overview.macro_indicators?.length ? (
              <div className="macro-indicators">
                {overview.macro_indicators.slice(0, 8).map((indicator) => (
                  <div className="macro-indicator" key={`${indicator.symbol}-${indicator.date}`}>
                    <span>{indicator.label}</span>
                    <strong>{formatNumber(indicator.close, indicator.close > 100 ? 1 : 3)}</strong>
                    <small className={Number(indicator.change_percent ?? 0) >= 0 ? "positive-copy" : "risk-copy"}>
                      {indicator.change_percent === null || indicator.change_percent === undefined ? "-" : `${Number(indicator.change_percent) >= 0 ? "+" : ""}${formatPercent(indicator.change_percent)}`}
                    </small>
                  </div>
                ))}
              </div>
            ) : null}
            {overview.macro_news?.length ? (
              <div className="macro-news">
                {overview.macro_news.slice(0, 3).map((item) => (
                  <Link href={item.url ?? "#"} key={`${item.id}-${item.url}`} target="_blank" rel="noreferrer">
                    <span>{formatDate(item.published_at)}</span>
                    <strong>{item.title}</strong>
                  </Link>
                ))}
              </div>
            ) : null}
          </section>
          <section className="panel">
            <div className="panel-title">
              <Activity size={18} />
              <h2>セクター注目度</h2>
            </div>
            <div className="sector-list">
              {overview.sectors.length === 0 ? <p>イベント取得後にセクター注目度を表示します。</p> : null}
              {overview.sectors.map((sector, index) => (
                <div className="sector-row" key={`${sector.sector ?? "unknown"}-${index}`}>
                  <span>{sector.sector ?? "未分類"}</span>
                  <div className="mini-track">
                    <span style={{ width: `${Math.min(100, sector.attention_score)}%` }} />
                  </div>
                  <strong>{formatNumber(sector.attention_score)}</strong>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-title">
              <Building2 size={18} />
              <h2>注目銘柄</h2>
            </div>
            <div className="company-links">
              {overview.companies.length === 0 ? <p>銘柄データはまだありません。下の取得パネルから取り込んでください。</p> : null}
              {overview.companies.map((company, index) => (
                <Link href={`/companies/${company.ticker}`} key={`${company.ticker}-${index}`}>
                  <strong>{company.ticker}</strong>
                  <span>{company.name}</span>
                  <small>{company.sector}</small>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </section>

      <section className="panel page-panel">
        <div className="panel-title">
          <Database size={18} />
          <h2>実データ取得</h2>
        </div>
        <div className="two-column data-entry-grid">
          <div>
            <h3>銘柄ページを開く</h3>
            <TickerSearch />
          </div>
          <div>
            <h3>J-Quantsから取り込む</h3>
            <FoundationFetchPanel />
          </div>
        </div>
      </section>

      <section className="content-grid">
        <div className="wide-stack">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Hypothesis Board</p>
              <h2>仮説ボード</h2>
            </div>
            <Layers3 size={20} />
          </div>
          <HypothesisBoard hypotheses={overview.hypotheses} />
        </div>
        <aside className="side-stack">
          {leadHypothesis ? (
            <section className="panel">
              <div className="panel-title">
                <Layers3 size={18} />
                <h2>急上昇仮説</h2>
              </div>
              <Link href={`/hypotheses/${leadHypothesis.id}`} className="lead-link">
                <strong>{leadHypothesis.title}</strong>
                <span>{leadHypothesis.summary}</span>
              </Link>
              <ScoreBars hypothesis={leadHypothesis} />
            </section>
          ) : null}
          <section className="panel">
            <div className="panel-title">
              <FileText size={18} />
              <h2>新規イベント</h2>
            </div>
            <div className="event-list">
              {overview.events.length === 0 ? <p>イベントはまだありません。財務情報や開示を取得すると表示されます。</p> : null}
              {overview.events.map((event, index) => (
                <div className="event-row" key={`${event.id}-${index}`}>
                  <span>{formatDate(event.published_at)}</span>
                  <strong>{event.title}</strong>
                  <small>{event.company_name ?? event.sector}</small>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>

      <section>
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Documents</p>
            <h2>最近の重要開示・ニュース</h2>
          </div>
        </div>
        <NewsList documents={overview.documents} />
      </section>
    </main>
  );
}
