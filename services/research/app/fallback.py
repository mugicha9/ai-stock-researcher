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


def agent_response(agent_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    hypothesis = payload.get("hypothesis") or {}
    company = payload.get("company") or {}
    title = hypothesis.get("title") or company.get("name") or "未指定テーマ"
    next_agent = "skeptic" if agent_name == "hypothesis" else "researcher"
    next_action = "call_agent"

    response: dict[str, Any] = {
        "agent_name": agent_name,
        "claims": [
            {
                "claim": f"{title} は追加の一次情報確認に値するが、現時点では暫定評価に留まる。",
                "evidence_ids": [],
                "confidence": 0.42,
            }
        ],
        "questions": [
            {
                "question": "受注・利益率・株価反応・競合比較を確認する",
                "priority": "high",
                "target_agent": "researcher",
            }
        ],
        "next_action": next_action,
        "next_agent": next_agent,
        "reason_for_next_action": "LLM接続が利用できないため、保守的な暫定出力を返しています。",
        "should_continue": True,
    }

    if agent_name == "researcher":
        response.update(
            {
                "final_decision": "inconclusive",
                "reason": "LLMまたはモデルが利用できず、根拠評価を完了できませんでした。",
                "evidence_strength": 0.35,
                "contradiction_strength": 0.55,
                "missing_information": ["一次情報", "財務インパクト", "バリュエーション比較"],
                "recommended_next_research": ["モデル接続後に再実行", "開示資料の本文取得", "株価イベントとの照合"],
                "scores": {
                    "growth_impact": 5,
                    "evidence_strength": 3,
                    "contradiction_risk": 6,
                    "valuation_risk": 5,
                    "market_overlooked": 4,
                    "overall": 4.1,
                },
                "final_report": (
                    "# 仮説\n"
                    f"{title}\n\n"
                    "## 結論\n"
                    "Inconclusive\n\n"
                    "## 主要根拠\n"
                    "1. LLM接続が未完了のため暫定評価です。\n\n"
                    "## 反証\n"
                    "1. 証拠不足により市場の見落としを判定できません。\n\n"
                    "## 重要な未確認事項\n"
                    "1. 一次情報と財務インパクト\n"
                ),
                "next_action": "request_data",
                "next_agent": "collector",
                "should_continue": True,
            }
        )

    return response


def discovery_response(payload: dict[str, Any]) -> dict[str, Any]:
    focus = payload.get("focus") or payload.get("sector") or "未指定テーマ"
    documents = payload.get("documents") if isinstance(payload.get("documents"), list) else []
    companies = payload.get("companies") if isinstance(payload.get("companies"), list) else []
    return {
        "hypotheses": [],
        "rejected_signals": [],
        "next_action": "request_data",
        "reason": (
            f"{focus} の仮説発見にはLLMによる根拠品質の判定が必要です。"
            f"現在の入力は文書{len(documents)}件、企業{len(companies)}件ですが、モデル接続が利用できないため候補作成を保留します。"
        ),
        "missing_information": ["一次情報の確認", "適時開示・決算情報の照合", "反証材料の抽出"],
        "recommended_next_research": ["LLM接続復旧後に仮説発見を再実行", "対象セクターを絞ってニュースと開示を追加取得"],
    }
