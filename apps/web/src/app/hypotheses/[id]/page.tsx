import { Blocks, FileSearch, ListChecks, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentLogClearButton } from "../../../components/AgentLogClearButton";
import { HypothesisDeleteButton } from "../../../components/HypothesisDeleteButton";
import { NewsList } from "../../../components/NewsList";
import { ResearchPanel } from "../../../components/ResearchPanel";
import { ScoreBars } from "../../../components/ScoreBars";
import { apiFetch, type Hypothesis } from "../../../lib/api";
import { formatDate } from "../../../lib/format";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

export default async function HypothesisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id)) notFound();

  let hypothesis: Hypothesis;
  try {
    hypothesis = await apiFetch<Hypothesis>(`/api/hypotheses/${id}`);
  } catch {
    notFound();
  }

  return (
    <main className="page">
      <section className="company-header">
        <div>
          <p className="eyebrow">{hypothesis.status} / {hypothesis.hypothesis_type ?? "company"} / {hypothesis.target_sector ?? hypothesis.ticker}</p>
          <h1>{hypothesis.title}</h1>
          <p>{hypothesis.summary}</p>
          {hypothesis.ticker ? <Link className="inline-link" href={`/companies/${hypothesis.ticker}`}>{hypothesis.company_name ?? hypothesis.ticker}</Link> : null}
        </div>
        <div className="header-actions">
          <ResearchPanel
            target="hypothesis"
            id={id}
            label={hypothesis.hypothesis_type === "global" ? "全体仮説を検証" : "個別仮説を検証"}
            contextSummary={{
              mode: "hypothesis",
              hypothesisType: hypothesis.hypothesis_type,
              ticker: hypothesis.ticker,
              sector: hypothesis.target_sector,
              documents: hypothesis.documents?.length ?? 0,
              agentRuns: hypothesis.agent_runs?.length ?? 0
            }}
          />
          <HypothesisDeleteButton hypothesisId={id} />
        </div>
      </section>

      <section className="content-grid">
        <div className="wide-stack">
          <section className="panel">
            <div className="panel-title">
              <Blocks size={18} />
              <h2>仮説の要約</h2>
            </div>
            <p>{hypothesis.summary}</p>
            <div className="two-column">
              <div>
                <h3>成長ドライバー</h3>
                <p>{hypothesis.growth_driver}</p>
              </div>
              <div>
                <h3>最終判断</h3>
                <p>{hypothesis.final_decision ?? "未判定"}</p>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <ListChecks size={18} />
              <h2>根拠と反証</h2>
            </div>
            <div className="two-column">
              <div>
                <h3>必要な根拠</h3>
                <ul className="plain-list">
                  {(hypothesis.required_evidence ?? []).map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>反証・リスク</h3>
                <ul className="plain-list risk-list">
                  {(hypothesis.risk_factors ?? []).map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <FileSearch size={18} />
              <h2>根拠文書</h2>
            </div>
            <NewsList documents={hypothesis.documents ?? []} />
          </section>

          {hypothesis.final_report ? (
            <section className="panel">
              <div className="panel-title">
                <FileSearch size={18} />
                <h2>最終レポート</h2>
              </div>
              <pre className="report-box">{hypothesis.final_report}</pre>
            </section>
          ) : null}
        </div>
        <aside className="side-stack">
          <section className="panel">
            <div className="panel-title">
              <ShieldAlert size={18} />
              <h2>スコア</h2>
            </div>
            <ScoreBars hypothesis={hypothesis} />
          </section>

          <section className="panel">
            <div className="panel-title">
              <FileSearch size={18} />
              <h2>未確認事項</h2>
            </div>
            <ul className="plain-list">
              {(hypothesis.missing_information ?? []).map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-title with-action">
              <span className="title-with-icon">
                <FileSearch size={18} />
                <h2>エージェントログ</h2>
              </span>
              <AgentLogClearButton hypothesisId={id} />
            </div>
            <div className="agent-log">
              {(hypothesis.agent_runs ?? []).map((run) => {
                const output = asRecord(run.output);
                const raw = asRecord(output.llm_raw);
                const system = rawMessage(raw, "system");
                const user = rawMessage(raw, "user");
                const response = rawResponse(raw);
                return (
                  <details key={run.id}>
                    <summary>
                      <span>{run.agent_name}</span>
                      <small>{formatDate(run.created_at)}</small>
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
                        <pre>{JSON.stringify(run.output, null, 2)}</pre>
                      </details>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
