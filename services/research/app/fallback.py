from __future__ import annotations

from typing import Any


def document_summary(payload: dict[str, Any]) -> dict[str, Any]:
    title = payload.get("title") or "無題の文書"
    ticker = payload.get("ticker")
    return {
        "related_companies": ([{"ticker": ticker, "name": "", "relevance_score": 0.5}] if ticker else []),
        "related_sectors": [],
        "event_type": "unknown",
        "summary_short": f"{title} に関する文書。本文またはLLM接続が不足しているため暫定要約です。",
        "summary_investment": "投資観点では、業績寄与の時間軸と定量根拠を追加確認する必要があります。",
        "summary_risk": "情報不足により、期待先行・一過性・織り込み済みのリスクを排除できません。",
        "key_points": ["LLM接続または本文取得を確認", "根拠URLと一次情報を確認", "業績インパクトを定量化"],
        "sentiment": "neutral",
        "impact_horizon": "medium",
        "affected_metrics": ["revenue_growth", "operating_margin"],
        "importance_score": 0.45,
        "confidence": 0.35,
        "requires_full_cache": False,
    }


def discovery_response(payload: dict[str, Any]) -> dict[str, Any]:
    focus = payload.get("focus") or payload.get("sector") or "未指定テーマ"
    documents = payload.get("documents") if isinstance(payload.get("documents"), list) else []
    companies = payload.get("companies") if isinstance(payload.get("companies"), list) else []
    return {
        "hypotheses": [],
        "rejected_signals": [],
        "reason": (
            f"{focus} の仮説発見にはLLMによる根拠品質の判定が必要です。"
            f"現在の入力は文書{len(documents)}件、企業{len(companies)}件ですが、モデル接続が利用できないため候補作成を保留します。"
        ),
        "missing_information": ["一次情報の確認", "適時開示・決算情報の照合", "反証材料の抽出"],
        "recommended_next_research": ["LLM接続復旧後に仮説発見を再実行", "対象セクターを絞ってニュースと開示を追加取得"],
    }
