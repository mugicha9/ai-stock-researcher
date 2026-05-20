"use client";

import { PlusCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiErrorMessage, publicApiUrl } from "../lib/api";

export function HypothesisCreatePanel() {
  const router = useRouter();
  const [type, setType] = useState<"global" | "company">("global");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [ticker, setTicker] = useState("");
  const [sector, setSector] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) {
      setError("仮説タイトルを入力してください。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${publicApiUrl}/api/hypotheses`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          title,
          summary,
          hypothesis_type: type,
          ticker: type === "company" ? ticker.trim().replace(/\.T$/i, "").replace(/\D/g, "") : undefined,
          target_sector: sector || undefined
        })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "API /api/hypotheses"));
      const created = (await response.json()) as { id: number };
      router.push(`/hypotheses/${created.id}`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "仮説の作成に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="hypothesis-form">
      <div className="segmented-control" role="tablist" aria-label="仮説タイプ">
        <button type="button" className={type === "global" ? "active" : ""} onClick={() => setType("global")}>
          全体仮説
        </button>
        <button type="button" className={type === "company" ? "active" : ""} onClick={() => setType("company")}>
          個別仮説
        </button>
      </div>
      <label>
        <span>仮説</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={type === "global" ? "この分野では..." : "この銘柄は..."} />
      </label>
      <label>
        <span>補足</span>
        <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} />
      </label>
      <div className="fetch-grid">
        {type === "company" ? (
          <label>
            <span>銘柄コード</span>
            <input value={ticker} onChange={(event) => setTicker(event.target.value)} inputMode="numeric" placeholder="例: 4443" />
          </label>
        ) : null}
        <label>
          <span>分野・セクター</span>
          <input value={sector} onChange={(event) => setSector(event.target.value)} placeholder="例: SaaS / 半導体 / AI" />
        </label>
      </div>
      <button className="primary-action" type="button" onClick={submit} disabled={submitting}>
        <PlusCircle size={17} />
        <span>{submitting ? "作成中" : "仮説を作成"}</span>
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
