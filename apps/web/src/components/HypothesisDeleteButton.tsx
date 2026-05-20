"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiErrorMessage, publicApiUrl } from "../lib/api";

export function HypothesisDeleteButton({ hypothesisId }: { hypothesisId: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function deleteHypothesis() {
    if (loading) return;
    const ok = window.confirm("この仮説と関連するエージェントログを削除しますか？");
    if (!ok) return;
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`${publicApiUrl}/api/hypotheses/${hypothesisId}`, {
        method: "DELETE",
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(await apiErrorMessage(response, "Hypothesis delete"));
      }
      router.push("/hypotheses");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "仮説削除に失敗しました");
      setLoading(false);
    }
  }

  return (
    <div className="delete-hypothesis-action">
      <button className="icon-action danger-action" type="button" onClick={deleteHypothesis} disabled={loading} aria-label="仮説を削除">
        {loading ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
        {loading ? "削除中" : "仮説削除"}
      </button>
      {message ? <small>{message}</small> : null}
    </div>
  );
}
