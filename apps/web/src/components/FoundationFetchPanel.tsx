"use client";

import { Database, Download, Loader2, Newspaper, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiErrorMessage, publicApiUrl, type FoundationFetchResult } from "../lib/api";
import { OperationProgress, type OperationPhase } from "./OperationProgress";

type ApiResult = FoundationFetchResult | { imported: number } | { deleted: number } | { fetched: number; saved: number; oldest_published_at?: string | null };
type LoadingMode = "all" | "prices" | "statements" | "news" | "master" | "purge";

const progressByMode: Record<LoadingMode, OperationPhase[]> = {
  all: [
    { at: 0, label: "銘柄確認", detail: "J-Quantsの銘柄マスターから会社情報を確認しています。" },
    { at: 4, label: "株価取得", detail: "OHLCVを取得し、価格DBへ保存しています。" },
    { at: 14, label: "財務取得", detail: "財務サマリーを取得し、文書・イベント・指標へ変換しています。" },
    { at: 24, label: "ニュース取得", detail: "GDELTの公開記事アーカイブから、記事公開日時で過去1年以上の関連ニュースを集めています。" },
    { at: 50, label: "画面更新", detail: "保存結果を反映するため銘柄ページを更新しています。" }
  ],
  prices: [
    { at: 0, label: "期間確認", detail: "取得可能期間を確認し、必要に応じて日付を補正しています。" },
    { at: 4, label: "OHLCV取得", detail: "日足データを取得しています。" },
    { at: 14, label: "価格保存", detail: "既存データと突き合わせてDBへ保存しています。" }
  ],
  statements: [
    { at: 0, label: "銘柄確認", detail: "対象銘柄を確認しています。" },
    { at: 4, label: "財務取得", detail: "J-Quantsから財務サマリーを取得しています。" },
    { at: 14, label: "文書化", detail: "財務データを文書・イベント・指標へ変換しています。" }
  ],
  news: [
    { at: 0, label: "クエリ作成", detail: "会社名、銘柄コード、セクターからニュース検索条件を作っています。" },
    { at: 5, label: "過去ニュース取得", detail: "GDELTを使い、取得時刻ではなく記事公開日時を基準に過去1年以上をさかのぼっています。" },
    { at: 25, label: "重複整理", detail: "URL重複を整理し、ニュース文書として保存しています。" }
  ],
  master: [
    { at: 0, label: "接続確認", detail: "J-Quants v2の銘柄マスターに接続しています。" },
    { at: 5, label: "全件取得", detail: "上場銘柄一覧を取得しています。" },
    { at: 12, label: "DB保存", detail: "銘柄マスターをcompaniesテーブルへ反映しています。" }
  ],
  purge: [
    { at: 0, label: "対象確認", detail: "初期MVPのサンプルデータを探しています。" },
    { at: 4, label: "削除", detail: "関連する仮説、文書、イベント、価格、会社を削除しています。" }
  ]
};

async function postJson<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${publicApiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await apiErrorMessage(response, `API ${path}`));
  }
  return (await response.json()) as T;
}

function normalizeTicker(value: string) {
  return value.trim().replace(/\.T$/i, "").replace(/\D/g, "");
}

export function FoundationFetchPanel({ ticker: initialTicker }: { ticker?: string }) {
  const router = useRouter();
  const [ticker, setTicker] = useState(initialTicker ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState<LoadingMode | null>(null);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runCompanyFetch(mode: "all" | "prices" | "statements" | "news") {
    const normalized = normalizeTicker(ticker);
    if (!/^\d{4,5}$/.test(normalized)) {
      setError("日本株の4桁または5桁コードを入力してください。");
      return;
    }
    setLoading(mode);
    setError(null);
    try {
      const output =
        mode === "news"
          ? await postJson<{ fetched: number; saved: number; oldest_published_at?: string | null }>(`/api/companies/${normalized}/news/fetch`, {
              lookbackDays: 450,
              limit: 260
            })
          : await postJson<FoundationFetchResult>(`/api/data/companies/${normalized}/fetch`, {
              includePrices: mode === "all" || mode === "prices",
              includeStatements: mode === "all" || mode === "statements",
              includeNews: mode === "all",
              newsLookbackDays: 450,
              newsLimit: 260,
              from: from || undefined,
              to: to || undefined
            });
      setResult(output);
      router.push(`/companies/${normalized}`);
      router.refresh();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "取得に失敗しました。");
    } finally {
      setLoading(null);
    }
  }

  async function runMasterFetch() {
    setLoading("master");
    setError(null);
    try {
      setResult(await postJson<{ imported: number }>("/api/data/listed/fetch"));
      router.refresh();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "銘柄マスター取得に失敗しました。");
    } finally {
      setLoading(null);
    }
  }

  async function purgeSamples() {
    setLoading("purge");
    setError(null);
    try {
      setResult(await postJson<{ deleted: number }>("/api/data/purge-sample"));
      router.refresh();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "削除に失敗しました。");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="fetch-panel">
      <div className="fetch-grid">
        <label>
          <span>銘柄コード</span>
          <input value={ticker} onChange={(event) => setTicker(event.target.value)} inputMode="numeric" placeholder="例: 7203" />
        </label>
        <label>
          <span>価格 From</span>
          <input value={from} onChange={(event) => setFrom(event.target.value)} placeholder="YYYY-MM-DD" />
        </label>
        <label>
          <span>価格 To</span>
          <input value={to} onChange={(event) => setTo(event.target.value)} placeholder="YYYY-MM-DD" />
        </label>
      </div>
      <div className="fetch-actions">
        <button type="button" onClick={() => runCompanyFetch("all")} disabled={Boolean(loading)}>
          {loading === "all" ? <Loader2 className="spin" size={17} /> : <Download size={17} />}
          <span>基盤データ取得</span>
        </button>
        <button type="button" onClick={() => runCompanyFetch("prices")} disabled={Boolean(loading)}>
          {loading === "prices" ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
          <span>OHLCV更新</span>
        </button>
        <button type="button" onClick={() => runCompanyFetch("statements")} disabled={Boolean(loading)}>
          {loading === "statements" ? <Loader2 className="spin" size={17} /> : <Database size={17} />}
          <span>財務情報取得</span>
        </button>
        <button type="button" onClick={() => runCompanyFetch("news")} disabled={Boolean(loading)}>
          {loading === "news" ? <Loader2 className="spin" size={17} /> : <Newspaper size={17} />}
          <span>ニュース取得</span>
        </button>
        <button type="button" onClick={runMasterFetch} disabled={Boolean(loading)}>
          {loading === "master" ? <Loader2 className="spin" size={17} /> : <Database size={17} />}
          <span>全上場銘柄を取得</span>
        </button>
        <button type="button" className="danger-action" onClick={purgeSamples} disabled={Boolean(loading)}>
          {loading === "purge" ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
          <span>サンプル削除</span>
        </button>
      </div>
      {loading ? <OperationProgress title="データ取得中" phases={progressByMode[loading]} /> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {result ? <pre className="compact-result">{JSON.stringify(result, null, 2)}</pre> : null}
    </div>
  );
}
