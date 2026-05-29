"use client";

import { Brain, Loader2, Search, Square, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { apiErrorMessage, publicApiUrl } from "../lib/api";
import { OperationProgress, type OperationPhase } from "./OperationProgress";

type ThinkingMode = "auto" | "no_think" | "think";

type CreatedHypothesis = {
  id: number;
  title: string;
  hypothesis_type?: string | null;
  target_sector?: string | null;
  ticker?: string | null;
  score_overall?: number | string | null;
};

type DiscoveryResult = {
  output?: Record<string, unknown>;
  created?: CreatedHypothesis[];
  skipped?: Record<string, unknown>[];
  discovery_runs?: Record<string, unknown>[];
  collector_errors?: string[];
  context_summary?: Record<string, unknown>;
};

const discoveryPhases: OperationPhase[] = [
  { at: 0, label: "入力準備", detail: "既存の仮説、企業情報、マクロ、文書を読み込んでいます。" },
  { at: 8, label: "データ取得", detail: "必要に応じてマクロ指数とニュースを追加取得しています。" },
  { at: 35, label: "仮説発見", detail: "根拠品質を確認しながら、未注目の可能性がある候補を探しています。" },
  { at: 95, label: "追加収集", detail: "候補化に足りない場合だけ、Collectorで本文や関連データを補います。" },
  { at: 120, label: "候補保存", detail: "候補を仮説ボードへ保存し、LLMログを紐付けています。" }
];

const thinkingModes: { value: ThinkingMode; label: string; icon: "zap" | "brain" }[] = [
  { value: "auto", label: "Auto", icon: "zap" },
  { value: "no_think", label: "No think", icon: "zap" },
  { value: "think", label: "Think", icon: "brain" }
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function formatScore(value: unknown): string {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number.toFixed(1) : "-";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function HypothesisDiscoverPanel() {
  const router = useRouter();
  const requestController = useRef<AbortController | null>(null);
  const [focus, setFocus] = useState("");
  const [sector, setSector] = useState("");
  const [limit, setLimit] = useState("3");
  const [lookbackDays, setLookbackDays] = useState("450");
  const [refresh, setRefresh] = useState(true);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("auto");
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<DiscoveryResult | null>(null);

  async function runDiscovery() {
    if (loading) return;
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setStopping(false);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${publicApiUrl}/api/hypotheses/discover`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          focus: focus.trim() || undefined,
          sector: sector.trim() || undefined,
          limit: Number(limit) || 3,
          lookback_days: Number(lookbackDays) || 450,
          refresh,
          create: true,
          llm_thinking_mode: thinkingMode
        })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, "API /api/hypotheses/discover"));
      const payload = (await response.json()) as DiscoveryResult;
      setResult(payload);
      router.refresh();
    } catch (discoveryError) {
      if (isAbortError(discoveryError)) {
        setNotice("仮説発見を停止しました。");
      } else {
        setError(discoveryError instanceof Error ? discoveryError.message : "仮説発見に失敗しました。");
      }
    } finally {
      setLoading(false);
      setStopping(false);
      requestController.current = null;
    }
  }

  function stopDiscovery() {
    if (!requestController.current || !loading) return;
    setStopping(true);
    requestController.current.abort();
  }

  const created = Array.isArray(result?.created) ? result.created : [];
  const discoveryRuns = Array.isArray(result?.discovery_runs) ? result.discovery_runs : [];
  const output = asRecord(result?.output);
  const rawLog = asRecord(output.llm_raw);

  return (
    <div className="hypothesis-form">
      <label>
        <span>探索テーマ</span>
        <input
          value={focus}
          onChange={(event) => setFocus(event.target.value)}
          placeholder="例: 今は注目されていないが有望になり得る分野"
        />
      </label>
      <div className="fetch-grid">
        <label>
          <span>対象セクター</span>
          <input value={sector} onChange={(event) => setSector(event.target.value)} placeholder="例: 半導体 / 防衛 / 医療DX" />
        </label>
        <label>
          <span>候補数</span>
          <input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" />
        </label>
        <label>
          <span>ニュース期間(日)</span>
          <input value={lookbackDays} onChange={(event) => setLookbackDays(event.target.value)} inputMode="numeric" />
        </label>
      </div>
      <label className="inline-check">
        <input type="checkbox" checked={refresh} onChange={(event) => setRefresh(event.target.checked)} />
        <span>実行前にマクロ・ニュースを追加取得</span>
      </label>
      <div className="mode-segment" aria-label="LLM thinking mode">
        {thinkingModes.map((mode) => {
          const Icon = mode.icon === "brain" ? Brain : Zap;
          return (
            <button
              key={mode.value}
              type="button"
              className={thinkingMode === mode.value ? "active" : ""}
              onClick={() => setThinkingMode(mode.value)}
              disabled={loading}
            >
              <Icon size={14} />
              <span>{mode.label}</span>
            </button>
          );
        })}
      </div>
      <div className="run-actions">
        <button className="primary-action" type="button" onClick={runDiscovery} disabled={loading}>
          {loading ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
          <span>{loading ? "発見中" : "エージェントで仮説を発見"}</span>
        </button>
        {loading ? (
          <button className="stop-action" type="button" onClick={stopDiscovery} disabled={stopping}>
            {stopping ? <Loader2 className="spin" size={17} /> : <Square size={15} />}
            <span>{stopping ? "停止中" : "停止"}</span>
          </button>
        ) : null}
      </div>
      {loading ? <OperationProgress title="仮説発見実行中" phases={discoveryPhases} /> : null}
      {notice ? <p className="form-notice">{notice}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {result ? (
        <div className="compact-result discovery-result">
          <strong>作成 {created.length}件</strong>
          {created.length ? (
            <div className="discovery-links">
              {created.map((hypothesis) => (
                <Link href={`/hypotheses/${hypothesis.id}`} key={hypothesis.id}>
                  <span>{hypothesis.hypothesis_type === "company" ? "個別" : "全体"}</span>
                  <b>{hypothesis.title}</b>
                  <small>
                    {hypothesis.target_sector ?? hypothesis.ticker ?? "未分類"} / 総合 {formatScore(hypothesis.score_overall)}
                  </small>
                </Link>
              ))}
            </div>
          ) : null}
          <small>
            next: {String(output.next_action ?? "-")} / {String(output.reason ?? "理由なし")}
          </small>
          {discoveryRuns.length ? (
            <div className="agent-log-list compact-agent-log">
              {discoveryRuns.map((run, index) => (
                <div className="agent-log-row" key={`${String(run.agent_name ?? "run")}-${index}`}>
                  <strong>
                    {index + 1}. {String(run.agent_name ?? "-")}
                  </strong>
                  <span>
                    {String(run.next_action ?? "-")}
                    {run.next_agent ? ` → ${String(run.next_agent)}` : ""}
                  </span>
                  <small>{String(run.reason ?? "")}</small>
                </div>
              ))}
            </div>
          ) : null}
          {Array.isArray(result.collector_errors) && result.collector_errors.length ? (
            <pre>{JSON.stringify(result.collector_errors, null, 2)}</pre>
          ) : null}
          {Object.keys(rawLog).length ? (
            <details>
              <summary>LLM raw</summary>
              <pre>{JSON.stringify(rawLog, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
