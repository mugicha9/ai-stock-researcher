import { Blocks } from "lucide-react";
import { HypothesisCreatePanel } from "../../components/HypothesisCreatePanel";
import { HypothesisDiscoverPanel } from "../../components/HypothesisDiscoverPanel";
import { HypothesisBoard } from "../../components/HypothesisBoard";
import { apiFetch, type Hypothesis } from "../../lib/api";

export default async function HypothesesPage() {
  const hypotheses = await apiFetch<Hypothesis[]>("/api/hypotheses").catch(() => []);

  return (
    <main className="page">
      <section className="company-header">
        <div>
          <p className="eyebrow">Hypotheses</p>
          <h1>仮説ボード</h1>
          <p>取得済みのニュース、開示、財務情報から生成・検証した仮説を状態別に確認します。</p>
        </div>
      </section>
      <section className="page-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">New</p>
            <h2>エージェントで発見</h2>
          </div>
        </div>
        <HypothesisDiscoverPanel />
      </section>
      <section className="page-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Manual</p>
            <h2>仮説作成</h2>
          </div>
        </div>
        <HypothesisCreatePanel />
      </section>
      <section className="page-panel">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Board</p>
            <h2>状態別</h2>
          </div>
          <Blocks size={20} />
        </div>
        <HypothesisBoard hypotheses={hypotheses} />
      </section>
    </main>
  );
}
