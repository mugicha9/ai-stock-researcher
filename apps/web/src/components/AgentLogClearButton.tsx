"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiErrorMessage, publicApiUrl } from "../lib/api";

export function AgentLogClearButton({ hypothesisId }: { hypothesisId: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function clearLogs() {
    if (loading) return;
    const ok = window.confirm("この仮説のエージェントログを削除しますか？");
    if (!ok) return;
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`${publicApiUrl}/api/hypotheses/${hypothesisId}/agent-runs`, {
        method: "DELETE",
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(await apiErrorMessage(response, "Agent log clear"));
      }
      const result = (await response.json()) as { deleted?: number };
      setMessage(`${result.deleted ?? 0}件削除しました`);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ログ削除に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="clear-log-action">
      <button className="icon-action danger-action" type="button" onClick={clearLogs} disabled={loading} aria-label="仮説ログを削除">
        <Trash2 size={15} />
        {loading ? "削除中" : "ログ削除"}
      </button>
      {message ? <small>{message}</small> : null}
    </div>
  );
}
