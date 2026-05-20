"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiErrorMessage, publicApiUrl } from "../lib/api";
import { OperationProgress, type OperationPhase } from "./OperationProgress";

const macroPhases: OperationPhase[] = [
  { at: 0, label: "指数取得", detail: "主要指数、為替、商品価格をCSVから取得しています。" },
  { at: 4, label: "一次情報", detail: "日銀、財務省、経産省、内閣府ESRI、Fed、BIS、ECBの公的フィードを確認しています。" },
  { at: 12, label: "報道", detail: "NHK、BBCなどから経済・地政学ニュースを取得しています。" },
  { at: 20, label: "過去アーカイブ", detail: "GDELTで記事公開日時を基準に、過去1年以上までさかのぼっています。" },
  { at: 35, label: "DB保存", detail: "マクロ統計とニュースをリサーチDBへ保存しています。" }
];

export function MacroFetchButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${publicApiUrl}/api/macro/fetch`, { method: "POST", headers: { accept: "application/json" } });
      if (!response.ok) {
        throw new Error(await apiErrorMessage(response, "API /api/macro/fetch"));
      }
      router.refresh();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "macro fetch failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inline-action-stack">
      <button className="icon-action" type="button" onClick={run} disabled={loading} aria-label="マクロデータを取得">
        {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
        <span>取得</span>
      </button>
      {loading ? <OperationProgress title="マクロ取得中" phases={macroPhases} compact /> : null}
      {error ? <small className="error-copy">{error}</small> : null}
    </div>
  );
}
