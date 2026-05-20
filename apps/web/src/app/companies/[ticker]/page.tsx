import { Building2, ClipboardList, FileText, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { CandleChart } from "../../../components/CandleChart";
import { FoundationFetchPanel } from "../../../components/FoundationFetchPanel";
import { MetricGrid } from "../../../components/MetricGrid";
import { NewsList } from "../../../components/NewsList";
import { ResearchPanel } from "../../../components/ResearchPanel";
import { ScoreBars } from "../../../components/ScoreBars";
import { TickerSearch } from "../../../components/TickerSearch";
import { apiFetch, type Company, type DocumentRecord, type EventRecord, type Hypothesis, type PricePoint } from "../../../lib/api";

export default async function CompanyPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker: rawTicker } = await params;
  const ticker = decodeURIComponent(rawTicker);
  const company = await apiFetch<Company>(`/api/companies/${ticker}`).catch(() => null);

  if (!company) {
    return (
      <main className="page">
        <section className="company-header">
          <div>
            <p className="eyebrow">Not Imported</p>
            <h1>
              {ticker}
              <span>未登録</span>
            </h1>
            <p>この銘柄はまだDBにありません。J-Quantsの認証情報を設定したうえで、基盤データ取得を実行してください。</p>
          </div>
          <TickerSearch initialTicker={ticker} />
        </section>
        <section className="panel page-panel">
          <div className="panel-title">
            <ClipboardList size={18} />
            <h2>基盤データ取得</h2>
          </div>
          <FoundationFetchPanel ticker={ticker} />
        </section>
      </main>
    );
  }

  const [prices, news, disclosures, hypotheses, events] = await Promise.all([
    apiFetch<PricePoint[]>(`/api/companies/${ticker}/prices`),
    apiFetch<DocumentRecord[]>(`/api/companies/${ticker}/news`),
    apiFetch<DocumentRecord[]>(`/api/companies/${ticker}/disclosures`),
    apiFetch<Hypothesis[]>(`/api/companies/${ticker}/hypotheses`),
    apiFetch<EventRecord[]>(`/api/companies/${ticker}/events`)
  ]);

  return (
    <main className="page">
      <section className="company-header">
        <div>
          <p className="eyebrow">{company.market} / {company.sector}</p>
          <h1>
            {company.name}
            <span>{company.ticker}</span>
          </h1>
          <p>{company.description}</p>
        </div>
        <div className="header-actions">
          <TickerSearch initialTicker={ticker} />
          <ResearchPanel
            target="company"
            ticker={ticker}
            label="銘柄リサーチ"
            contextSummary={{
              mode: "company",
              ticker,
              sector: company.sector,
              documents: news.length + disclosures.length,
              prices: prices.length
            }}
          />
        </div>
      </section>

      <section className="panel page-panel">
        <div className="panel-title">
          <ClipboardList size={18} />
          <h2>基盤データ更新</h2>
        </div>
        <FoundationFetchPanel ticker={ticker} />
      </section>

      <section className="chart-section">
        <CandleChart prices={prices} events={events} />
      </section>

      <section className="content-grid">
        <div className="wide-stack">
          <section className="panel">
            <div className="panel-title">
              <Building2 size={18} />
              <h2>会社情報</h2>
            </div>
            <div className="two-column">
              <div>
                <h3>事業概要</h3>
                <p>{company.business_summary}</p>
              </div>
              <div>
                <h3>成長ドライバー</h3>
                <p>関連イベント、設備投資、政策テーマ、顧客需要の変化を仮説に接続します。</p>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-title">
              <FileText size={18} />
              <h2>関連ニュース</h2>
            </div>
            <NewsList documents={news} />
          </section>
          <section className="panel">
            <div className="panel-title">
              <ClipboardList size={18} />
              <h2>開示・決算</h2>
            </div>
            <NewsList documents={disclosures} />
          </section>
        </div>
        <aside className="side-stack">
          <section className="panel">
            <div className="panel-title">
              <ClipboardList size={18} />
              <h2>指標</h2>
            </div>
            <MetricGrid metrics={company.latest_metrics} marketCap={company.market_cap} />
          </section>
          <section className="panel">
            <div className="panel-title">
              <ShieldAlert size={18} />
              <h2>関連仮説</h2>
            </div>
            <div className="stacked-links">
              {hypotheses.map((hypothesis) => (
                <Link href={`/hypotheses/${hypothesis.id}`} key={hypothesis.id}>
                  <strong>{hypothesis.title}</strong>
                  <span>{hypothesis.status}</span>
                  <ScoreBars hypothesis={hypothesis} />
                </Link>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
