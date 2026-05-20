import { BarChart3, Blocks, FileText, Home, Search } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link href="/" className="brand" aria-label="home">
          <BarChart3 size={22} />
          <span>日本株リサーチ</span>
        </Link>
        <nav className="nav">
          <Link href="/" className="nav-link">
            <Home size={17} />
            <span>ホーム</span>
          </Link>
          <Link href="/companies" className="nav-link">
            <Search size={17} />
            <span>銘柄</span>
          </Link>
          <Link href="/hypotheses" className="nav-link">
            <Blocks size={17} />
            <span>仮説</span>
          </Link>
          <a href="http://localhost:4000/health" className="nav-link">
            <FileText size={17} />
            <span>API</span>
          </a>
        </nav>
      </header>
      {children}
      <footer className="footer">本画面は情報整理・調査支援用です。最終的な投資判断はユーザーが行います。</footer>
    </div>
  );
}
