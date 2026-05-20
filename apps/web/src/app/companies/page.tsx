import { Database, Search } from "lucide-react";
import Link from "next/link";
import { FoundationFetchPanel } from "../../components/FoundationFetchPanel";
import { TickerSearch } from "../../components/TickerSearch";
import { apiFetch, type Company, type DataStatus } from "../../lib/api";

export default async function CompaniesPage() {
  const [companies, status] = await Promise.all([
    apiFetch<Company[]>("/api/companies").catch(() => []),
    apiFetch<DataStatus>("/api/data/status").catch(() => null)
  ]);

  return (
    <main className="page">
      <section className="company-header">
        <div>
          <p className="eyebrow">Company Lookup</p>
          <h1>日本株コードで調べる</h1>
          <p>4桁コードを入力して銘柄ページを開きます。未登録の銘柄は基盤データ取得でJ-Quantsから会社情報、OHLCV、財務情報を取り込みます。</p>
        </div>
        <TickerSearch />
      </section>

      <section className="content-grid">
        <div className="wide-stack">
          <section className="panel">
            <div className="panel-title">
              <Database size={18} />
              <h2>基盤データ取得</h2>
            </div>
            <FoundationFetchPanel />
          </section>

          <section className="panel">
            <div className="panel-title">
              <Search size={18} />
              <h2>登録済み銘柄</h2>
            </div>
            {companies.length ? (
              <div className="company-links">
                {companies.map((company) => (
                  <Link href={`/companies/${company.ticker}`} key={company.ticker}>
                    <strong>{company.ticker}</strong>
                    <span>{company.name}</span>
                    <small>{company.market ?? company.sector ?? "未分類"}</small>
                  </Link>
                ))}
              </div>
            ) : (
              <p>登録済み銘柄はまだありません。基盤データ取得から取り込んでください。</p>
            )}
          </section>
        </div>
        <aside className="side-stack">
          <section className="panel">
            <div className="panel-title">
              <Database size={18} />
              <h2>データソース</h2>
            </div>
            {status ? (
              <div className="source-status">
                <span>J-Quants</span>
                <strong>{status.jquants.configured ? "設定済み" : "未設定"}</strong>
                <small>{status.jquants.base_url}</small>
              </div>
            ) : (
              <p>APIに接続できません。</p>
            )}
          </section>
        </aside>
      </section>
    </main>
  );
}

