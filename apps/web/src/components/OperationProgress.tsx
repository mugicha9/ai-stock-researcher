"use client";

import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export type OperationPhase = {
  at: number;
  label: string;
  detail: string;
};

export function OperationProgress({ phases, title = "実行中", compact = false }: { phases: OperationPhase[]; title?: string; compact?: boolean }) {
  const [elapsed, setElapsed] = useState(0);
  const sortedPhases = useMemo(() => [...phases].sort((a, b) => a.at - b.at), [phases]);
  const currentIndex = sortedPhases.reduce((active, phase, index) => (elapsed >= phase.at ? index : active), 0);
  const current = sortedPhases[currentIndex];

  useEffect(() => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [sortedPhases]);

  return (
    <div className={compact ? "operation-progress compact" : "operation-progress"} aria-live="polite">
      <div className="operation-head">
        <div>
          <strong>{title}</strong>
          <span>{elapsed}秒経過</span>
        </div>
        <p>{current?.detail}</p>
      </div>
      <div className="operation-steps">
        {sortedPhases.map((phase, index) => {
          const done = index < currentIndex;
          const active = index === currentIndex;
          return (
            <div className={active ? "operation-step active" : done ? "operation-step done" : "operation-step"} key={`${phase.at}-${phase.label}`}>
              {active ? <Loader2 className="spin" size={15} /> : done ? <CheckCircle2 size={15} /> : <Circle size={15} />}
              <span>{phase.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
