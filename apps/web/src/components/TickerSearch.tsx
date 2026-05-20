"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";

function normalizeTicker(value: string) {
  return value.trim().replace(/\.T$/i, "").replace(/\D/g, "");
}

export function TickerSearch({ initialTicker = "" }: { initialTicker?: string }) {
  const router = useRouter();
  const [ticker, setTicker] = useState(initialTicker);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeTicker(ticker);
    if (!/^\d{4,5}$/.test(normalized)) {
      setError("日本株の4桁または5桁コードを入力してください。");
      return;
    }
    setError(null);
    router.push(`/companies/${normalized}`);
  }

  return (
    <form className="ticker-search" onSubmit={submit}>
      <label>
        <span>銘柄コード</span>
        <input value={ticker} onChange={(event) => setTicker(event.target.value)} inputMode="numeric" placeholder="例: 7203" />
      </label>
      <button type="submit" aria-label="銘柄を開く">
        <Search size={17} />
        <span>表示</span>
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
