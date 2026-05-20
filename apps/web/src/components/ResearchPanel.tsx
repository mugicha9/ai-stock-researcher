"use client";

import { Brain, Loader2, Play, RefreshCw, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { apiErrorMessage, publicApiUrl } from "../lib/api";
import { OperationProgress, type OperationPhase } from "./OperationProgress";

type ResearchPanelProps =
  | { target: "company"; ticker: string; label?: string; contextSummary?: ResearchContextSummary }
  | { target: "hypothesis"; id: number; label?: string; contextSummary?: ResearchContextSummary };

type ResearchContextSummary = {
  mode?: string;
  hypothesisType?: string | null;
  ticker?: string | null;
  sector?: string | null;
  documents?: number;
  prices?: number;
  agentRuns?: number;
  newsSince?: string;
};

type LoopTraceItem = {
  turn?: number;
  agent_name?: string;
  phase?: string;
  input?: Record<string, unknown>;
  next_action?: string;
  next_agent?: string | null;
  should_continue?: boolean;
  duration_ms?: number;
  timeout_ms?: number;
  summary?: string;
};

type AgentRunLike = {
  id?: number | string;
  agent_name?: string;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  next_action?: string | null;
  next_agent?: string | null;
  loop_turn?: number;
  created_at?: string | null;
  llm_raw?: Record<string, unknown> | null;
};

type ThinkingMode = "auto" | "no_think" | "think";

const thinkingModes: { value: ThinkingMode; label: string; icon: "zap" | "brain" }[] = [
  { value: "auto", label: "Auto", icon: "zap" },
  { value: "no_think", label: "No think", icon: "zap" },
  { value: "think", label: "Think", icon: "brain" }
];

const companyResearchPhases: OperationPhase[] = [
  { at: 0, label: "入力準備", detail: "会社情報、文書、仮説、株価を読み込み、LLMに渡す形式へ圧縮しています。" },
  { at: 8, label: "LLM送信", detail: "ローカルllama.cppへリサーチ依頼を送っています。" },
  { at: 25, label: "根拠整理", detail: "財務、価格、文書を照合し、根拠と反証を整理しています。" },
  { at: 70, label: "出力整形", detail: "LLM出力をJSON/レポートとして整形し、画面に返す準備をしています。" },
  { at: 180, label: "長時間生成", detail: "大きめの入力で生成中です。モデルが応答するまでこのまま待機してください。" }
];

const hypothesisResearchPhases: OperationPhase[] = [
  { at: 0, label: "仮説読込", detail: "仮説、根拠文書、過去のエージェントログを読み込んでいます。" },
  { at: 8, label: "仮説検証", detail: "仮説を検証可能な主張へ分解し、根拠と不足情報を整理しています。" },
  { at: 35, label: "反証", detail: "織り込み済み、競争、財務、バリュエーションの反証を探しています。" },
  { at: 80, label: "深堀り", detail: "次に呼ぶ工程を判断しながら、リサーチャーが結論に近づけています。" },
  { at: 180, label: "ループ継続", detail: "各工程の判断に従って、次の工程を呼び出しています。" }
];

function formatContextValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return new Intl.NumberFormat("ja-JP").format(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function resultOutput(result: Record<string, unknown> | null): Record<string, unknown> {
  return asRecord(result?.output);
}

function resultTrace(result: Record<string, unknown> | null): LoopTraceItem[] {
  const output = resultOutput(result);
  const trace = Array.isArray(result?.loop_trace) ? result.loop_trace : output.loop_trace;
  return Array.isArray(trace) ? (trace as LoopTraceItem[]) : [];
}

function resultAgentRuns(result: Record<string, unknown> | null): AgentRunLike[] {
  const output = resultOutput(result);
  const runs = Array.isArray(result?.agent_runs) ? result.agent_runs : output.agent_runs;
  return Array.isArray(runs) ? (runs as AgentRunLike[]) : [];
}

function runIdNumber(run: AgentRunLike): number {
  const value = Number(run.id);
  return Number.isFinite(value) ? value : 0;
}

async function fetchHypothesisAgentRuns(id: number, afterId?: number | null): Promise<AgentRunLike[]> {
  const url = new URL(`${publicApiUrl}/api/hypotheses/${id}/agent-runs`);
  if (afterId !== undefined && afterId !== null) url.searchParams.set("after_id", String(afterId));
  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(await apiErrorMessage(response, "Agent run polling"));
  const payload = (await response.json()) as { agent_runs?: AgentRunLike[] };
  return Array.isArray(payload.agent_runs) ? payload.agent_runs : [];
}

function rawFromRun(run: AgentRunLike): Record<string, unknown> {
  const output = asRecord(run.output ?? run);
  return asRecord(output.llm_raw);
}

function runOutput(run: AgentRunLike): Record<string, unknown> {
  return asRecord(run.output ?? run);
}

function rawMessage(raw: Record<string, unknown>, role: "system" | "user"): string | null {
  const request = asRecord(raw.request);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const match = messages.map(asRecord).find((message) => message.role === role);
  return typeof match?.content === "string" ? match.content : null;
}

function rawResponse(raw: Record<string, unknown>): string | null {
  const response = asRecord(raw.response);
  return typeof response.message_content === "string"
    ? response.message_content
    : typeof response.body === "string"
      ? response.body
      : null;
}

function agentPhase(agentName: unknown): string {
  if (agentName === "hypothesis") return "仮説検証";
  if (agentName === "skeptic") return "反証";
  if (agentName === "collector") return "データ収集";
  if (agentName === "researcher") return "深堀り・リサーチ";
  return formatContextValue(agentName);
}

function traceFromRuns(runs: AgentRunLike[]): LoopTraceItem[] {
  return runs.map((run, index) => {
    const output = runOutput(run);
    const input = asRecord(run.input ?? output.input);
    const agentName = run.agent_name ?? output.agent_name;
    return {
      turn: typeof output.loop_turn === "number" ? output.loop_turn : index + 1,
      agent_name: formatContextValue(agentName),
      phase: agentPhase(agentName),
      input,
      next_action: String(output.next_action ?? run.next_action ?? ""),
      next_agent: (output.next_agent ?? run.next_agent ?? null) as string | null,
      should_continue: typeof output.should_continue === "boolean" ? output.should_continue : undefined,
      duration_ms: typeof output.duration_ms === "number" ? output.duration_ms : undefined,
      timeout_ms: typeof output.turn_timeout_ms === "number" ? output.turn_timeout_ms : undefined,
      summary:
        typeof output.reason_for_next_action === "string"
          ? output.reason_for_next_action
          : typeof output.reason === "string"
            ? output.reason
            : typeof output.status === "string" && output.status === "running"
              ? "この工程を実行中です。完了するとLLM raw logsとParsed outputが更新されます。"
              : undefined
    };
  });
}

function LoopTrace({ result }: { result: Record<string, unknown> | null }) {
  const trace = resultTrace(result);
  if (!trace.length) return null;
  return (
    <div className="loop-trace">
      <strong>実行ループ</strong>
      {trace.map((item, index) => (
        <div className="loop-trace-row" key={`${item.turn ?? index}-${item.agent_name ?? "agent"}`}>
          <span>{item.turn ?? index + 1}</span>
          <div>
            <b>{item.phase ?? item.agent_name}</b>
            <small>
              入力: {formatContextValue(item.input?.hypothesis_type)} / 文書 {formatContextValue(item.input?.documents)} / 株価 {formatContextValue(item.input?.prices)}
              {item.input?.macro_indicators !== undefined ? ` / マクロ ${formatContextValue(item.input.macro_indicators)}` : ""}
              {item.input?.sector_snapshots !== undefined ? ` / セクター ${formatContextValue(item.input.sector_snapshots)}` : ""}
              {item.input?.recent_events !== undefined ? ` / イベント ${formatContextValue(item.input.recent_events)}` : ""}
            </small>
            {item.summary ? <p>{item.summary}</p> : null}
            <small>
              次: {formatContextValue(item.next_action)} {item.next_agent ? `→ ${item.next_agent}` : ""}
              {typeof item.duration_ms === "number" ? ` / ${(item.duration_ms / 1000).toFixed(1)}秒` : ""}
              {typeof item.timeout_ms === "number" ? ` / timeout ${(item.timeout_ms / 1000).toFixed(0)}秒` : ""}
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}

function LiveLoopTrace({ runs }: { runs: AgentRunLike[] }) {
  const trace = traceFromRuns(runs);
  if (!trace.length) return <p className="muted small-copy">エージェントログを待機中です。</p>;
  return (
    <div className="loop-trace">
      <strong>実行中ログ</strong>
      {trace.map((item, index) => (
        <div className="loop-trace-row" key={`${item.turn ?? index}-${item.agent_name ?? "agent"}-${index}`}>
          <span>{item.turn ?? index + 1}</span>
          <div>
            <b>{item.phase ?? item.agent_name}</b>
            <small>
              入力: {formatContextValue(item.input?.hypothesis_type)} / 文書 {formatContextValue(item.input?.documents)} / 株価 {formatContextValue(item.input?.prices)}
              {item.input?.macro_indicators !== undefined ? ` / マクロ ${formatContextValue(item.input.macro_indicators)}` : ""}
              {item.input?.sector_snapshots !== undefined ? ` / セクター ${formatContextValue(item.input.sector_snapshots)}` : ""}
              {item.input?.recent_events !== undefined ? ` / イベント ${formatContextValue(item.input.recent_events)}` : ""}
            </small>
            {item.summary ? <p>{item.summary}</p> : null}
            <small>
              次: {formatContextValue(item.next_action)} {item.next_agent ? `→ ${item.next_agent}` : ""}
              {typeof item.duration_ms === "number" ? ` / ${(item.duration_ms / 1000).toFixed(1)}秒` : ""}
              {typeof item.timeout_ms === "number" ? ` / timeout ${(item.timeout_ms / 1000).toFixed(0)}秒` : ""}
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}

function LlmRawLogs({ result }: { result: Record<string, unknown> | null }) {
  const runs = resultAgentRuns(result);
  const errorResponse = asRecord(result?.error_response);
  const errorRaw = asRecord(asRecord(asRecord(errorResponse.details).detail).llm_raw ?? asRecord(errorResponse.details).llm_raw);
  if (!runs.length && !Object.keys(errorRaw).length) return null;

  return (
    <div className="agent-log llm-raw-log">
      <strong>LLM raw logs</strong>
      {runs.map((run, index) => {
        const output = runOutput(run);
        const raw = rawFromRun(run);
        const system = rawMessage(raw, "system");
        const user = rawMessage(raw, "user");
        const response = rawResponse(raw);
        return (
          <details key={`${run.id ?? output.loop_turn ?? index}-${run.agent_name ?? output.agent_name ?? "agent"}`}>
            <summary>
              <span>{formatContextValue(run.agent_name ?? output.agent_name)} #{formatContextValue(output.loop_turn ?? run.loop_turn ?? index + 1)}</span>
              <small>
                {formatContextValue(output.next_action ?? run.next_action)}
                {output.next_agent || run.next_agent ? ` → ${formatContextValue(output.next_agent ?? run.next_agent)}` : ""}
              </small>
            </summary>
            <div className="log-detail-stack">
              <details>
                <summary>API input</summary>
                <pre>{JSON.stringify(run.input ?? output.input ?? {}, null, 2)}</pre>
              </details>
              {system ? (
                <details>
                  <summary>LLM system</summary>
                  <pre>{system}</pre>
                </details>
              ) : null}
              {user ? (
                <details>
                  <summary>LLM user</summary>
                  <pre>{user}</pre>
                </details>
              ) : null}
              {response ? (
                <details>
                  <summary>LLM response</summary>
                  <pre>{response}</pre>
                </details>
              ) : null}
              <details>
                <summary>Parsed output</summary>
                <pre>{JSON.stringify(output, null, 2)}</pre>
              </details>
            </div>
          </details>
        );
      })}
      {!runs.length && Object.keys(errorRaw).length ? (
        <details open>
          <summary>
            <span>error response</span>
            <small>raw</small>
          </summary>
          <pre>{JSON.stringify(errorRaw, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function ResearchPanel(props: ResearchPanelProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("auto");
  const [liveRuns, setLiveRuns] = useState<AgentRunLike[]>([]);
  const [liveBaselineId, setLiveBaselineId] = useState<number | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  const hypothesisId = props.target === "hypothesis" ? props.id : null;

  useEffect(() => {
    if (!loading || hypothesisId === null) return undefined;
    const pollingHypothesisId: number = hypothesisId;
    let cancelled = false;
    async function poll() {
      try {
        const runs = await fetchHypothesisAgentRuns(pollingHypothesisId, liveBaselineId);
        if (!cancelled) {
          setLiveRuns(runs);
          setLiveError(null);
        }
      } catch (pollError) {
        if (!cancelled) setLiveError(pollError instanceof Error ? pollError.message : "ログ取得に失敗しました");
      }
    }
    poll();
    const interval = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loading, hypothesisId, liveBaselineId]);

  async function run() {
    setError(null);
    setResult(null);
    setLiveRuns([]);
    setLiveError(null);
    if (props.target === "hypothesis") {
      try {
        const existingRuns = await fetchHypothesisAgentRuns(props.id);
        setLiveBaselineId(Math.max(0, ...existingRuns.map(runIdNumber)));
      } catch {
        setLiveBaselineId(0);
      }
    } else {
      setLiveBaselineId(null);
    }
    setLoading(true);
    try {
      const path =
        props.target === "company" ? `/api/companies/${props.ticker}/research` : `/api/hypotheses/${props.id}/run`;
      const response = await fetch(`${publicApiUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llm_thinking_mode: thinkingMode })
      });
      if (!response.ok) {
        const responseText = await response.text();
        const body = responseText ? parseMaybeJson(responseText) : null;
        setResult({ error_response: body, status: response.status });
        throw new Error(await apiErrorMessage(new Response(responseText, { status: response.status, headers: response.headers }), "LLM API"));
      }
      setResult((await response.json()) as Record<string, unknown>);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "research failed");
    } finally {
      setLoading(false);
    }
  }

  const report =
    typeof result?.final_report === "string"
      ? result.final_report
      : typeof (result?.output as Record<string, unknown> | undefined)?.final_report === "string"
        ? ((result?.output as Record<string, unknown>).final_report as string)
        : null;

  return (
    <div className="research-panel">
      <button className="primary-action" type="button" onClick={run} disabled={loading}>
        {loading ? <Loader2 className="spin" size={17} /> : result ? <RefreshCw size={17} /> : <Play size={17} />}
        <span>{props.label ?? "リサーチ実行"}</span>
      </button>
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
      {props.contextSummary ? (
        <div className="research-context">
          <span>入力</span>
          <small>
            {props.contextSummary.hypothesisType ? `${props.contextSummary.hypothesisType} / ` : ""}
            {props.contextSummary.ticker ? `${props.contextSummary.ticker} / ` : ""}
            {props.contextSummary.sector ? `${props.contextSummary.sector} / ` : ""}
            文書 {formatContextValue(props.contextSummary.documents)} / 株価 {formatContextValue(props.contextSummary.prices)}
            {props.contextSummary.agentRuns !== undefined ? ` / 過去ログ ${formatContextValue(props.contextSummary.agentRuns)}` : ""}
          </small>
        </div>
      ) : null}
      {loading ? (
        <OperationProgress
          title={props.target === "company" ? "銘柄リサーチ実行中" : "仮説検証実行中"}
          phases={props.target === "company" ? companyResearchPhases : hypothesisResearchPhases}
        />
      ) : null}
      {props.target === "hypothesis" && loading ? (
        <div className="live-run-panel">
          <div className="live-run-head">
            <strong>エージェント実行ログ</strong>
            <small>{liveRuns.length ? `${liveRuns.length}件` : "待機中"}</small>
          </div>
          {liveError ? <p className="error-copy">{liveError}</p> : null}
          <LiveLoopTrace runs={liveRuns} />
          <LlmRawLogs result={{ agent_runs: liveRuns }} />
        </div>
      ) : null}
      {error ? <p className="error-copy">LLM実行に失敗しました: {error}</p> : null}
      <LoopTrace result={result} />
      <LlmRawLogs result={result} />
      {report ? <pre className="report-box">{report}</pre> : null}
      {result && !report ? <pre className="report-box">{JSON.stringify(result, null, 2)}</pre> : null}
    </div>
  );
}
