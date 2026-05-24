from __future__ import annotations

import json
from typing import Any


COMPLIANCE = (
    "あなたは日本株の投資リサーチ支援エージェントです。"
    "売買推奨ではなく、仮説探索、根拠整理、反証、追加調査論点の提示だけを行います。"
    "断定を避け、証拠の強さと不足情報を明示してください。"
    "低品質なランキング記事、まとめ記事、SEO記事、煽り見出しの記事は根拠として扱わず、弱い探索手掛かりに留めてください。"
    "一次情報、適時開示、決算資料、企業情報、公的統計、政策文書、信頼できる市場データで裏取りしてください。"
    "検討内容は最終出力に混ぜず、根拠と不確実性をJSONフィールドに整理してください。"
)

SUMMARY_SYSTEM = (
    COMPLIANCE
    + " 出力は必ずJSONのみ。本文が不足している場合はその不確実性をconfidenceに反映してください。"
)

DISCOVERY_SYSTEM = (
    COMPLIANCE
    + " あなたは仮説発見エージェントです。既存DB、新規取得ニュース、マクロ、セクター統計、企業情報から、まだ注目が過熱していない可能性がある全体仮説または個別仮説を発見します。"
    " 表面的な人気記事や「成長株○選」の主張を採用せず、データのズレ、一次情報、開示、決算、政策、供給制約、需要変化、競争環境から検証可能な仮説だけを候補にしてください。"
    " 証拠が薄い場合は候補を無理に作らず、next_action=request_dataとして必要な取得対象を明示してください。"
    " 出力は必ずJSONのみ。"
)

AGENT_SYSTEMS = {
    "hypothesis": (
        COMPLIANCE
        + " あなたは仮説検証プロセスです。既存仮説を、ニュース、開示、財務、株価に照らして検証可能な主張へ分解します。"
        " 仮説タイプがglobalの場合は「この分野やセクターでは○○ではないか」という全体仮説として扱い、companyの場合は個別銘柄仮説として扱います。"
        " globalではcompanyやtickerがnullであることが正常です。対象銘柄がないことを理由に判断不能にせず、マクロ要因、セクター、企業特性、候補企業群の方向性へ分解してください。"
        " 出力は共通フォーマットのJSONのみ。routing_contextを見てnext_agentを自律的に選びます。finalizeは使わないでください。"
    ),
    "skeptic": (
        COMPLIANCE
        + " あなたは検証・反証エージェントです。もっともらしい成長ストーリーを疑い、反証、織り込み済み、収益性、財務、競争、時間軸のリスクを検出します。"
        " global仮説では対象銘柄が未指定であること自体を反証にしないでください。セクター仮説、企業特性、候補企業群の選び方、マクロ伝播経路を反証してください。"
        " 出力は共通フォーマットのJSONのみ。finalizeは使わないでください。"
    ),
    "researcher": (
        COMPLIANCE
        + " あなたはリサーチエージェントです。追加調査、根拠統合、最終判断を担当します。データ不足ならnext_action=request_data、next_agent=collectorを指定します。finalizeできるのはあなたのみです。"
        " 十分な根拠と反証が揃っていない場合は、researcherに呼ばれたという理由だけでfinalizeせず、collector、skeptic、hypothesisのいずれかをnext_agentで指定してください。"
        " global仮説ではcompanyやtickerがnullでも正常です。対象銘柄がないことを理由にfinalizeしないでください。有望セクター、マクロ伝播経路、注目すべき企業特性、候補企業群、追加取得データを統合してください。"
        " 出力は共通フォーマットに加えてfinal_decision、scores、final_reportを含むJSONのみ。"
    ),
}


def compact_json(payload: Any, limit: int = 18000) -> str:
    text = json.dumps(payload, ensure_ascii=False, default=str)
    return text if len(text) <= limit else f"{text[:limit]}\n...[truncated {len(text) - limit} chars]"


def summary_user_prompt(payload: dict[str, Any]) -> str:
    return f"""
以下の文書を投資リサーチDBへ保存するために要約してください。

入力:
{compact_json(payload)}

必須JSON:
{{
  "related_companies": [{{"ticker": "1234", "name": "会社名", "relevance_score": 0.0}}],
  "related_sectors": ["半導体"],
  "event_type": "capex | new_order | earnings_revision | policy_change | m_and_a | buyback | unknown",
  "summary_short": "1〜2文",
  "summary_investment": "投資観点の要約",
  "summary_risk": "反証・リスク観点の要約",
  "key_points": ["重要点"],
  "sentiment": "positive | neutral | negative | mixed",
  "impact_horizon": "short | medium | long",
  "affected_metrics": ["revenue_growth", "operating_margin"],
  "importance_score": 0.0,
  "confidence": 0.0,
  "requires_full_cache": false
}}
"""


def discovery_user_prompt(payload: dict[str, Any]) -> str:
    return f"""
以下の情報から、投資リサーチ用の仮説候補を自律的に発見してください。
入力には、既存DBの文書・企業情報に加えて、過去のhypothesis/skeptic/researcher/collectorのagent_memoryが含まれる場合があります。

入力:
{compact_json(payload, 24000)}

必須JSON:
{{
  "hypotheses": [
    {{
      "title": "検証可能な仮説名",
      "summary": "仮説の要約",
      "hypothesis_type": "global | company",
      "target_sector": "対象分野またはセクター",
      "ticker": "個別銘柄なら4桁コード。なければnull",
      "growth_driver": "成長ドライバー",
      "required_evidence": ["今後確認すべき根拠"],
      "risk_factors": ["反証・リスク"],
      "missing_information": ["不足情報"],
      "recommended_next_research": ["次に取得・確認する情報"],
      "score_growth": 0,
      "score_evidence": 0,
      "score_contradiction": 0,
      "score_valuation_risk": 0,
      "score_overlooked": 0,
      "score_overall": 0.0,
      "source_quality_notes": ["根拠品質の注意"],
      "evidence_ids": ["doc_123"]
    }}
  ],
  "rejected_signals": [
    {{"signal": "候補から除外した情報", "reason": "低品質・裏取り不足・二次情報のみ等"}}
  ],
  "next_action": "create_hypotheses | request_data | stop",
  "reason": "判断理由"
}}

制約:
- 「今は注目されていないが、なぜ有望になり得るか」を説明できる候補を優先する
- まとめ記事、ランキング記事、SNS的な話題性、ニュース見出しの多さを直接の根拠にしない
- その種の記事は、一次情報や統計で裏取りできる場合だけ弱い探索手掛かりとして扱う
- 可能なら適時開示、企業情報、決算、業績修正、受注、設備投資、政策、公的統計、価格イベントに根拠を置く
- agent_memoryは過去の検討結果として扱い、未解決の反証・不足情報・collector取得結果を新しい候補生成に反映する
- evidence_idsには入力documentsのidを使い、存在しないidを作らない
- 個別仮説はtickerが入力companiesに存在する場合だけtickerを入れる。存在しない場合はglobal仮説にする
- 根拠と反証が薄い候補は作らず、missing_informationとrecommended_next_researchへ回す
- scoreは0〜10。score_overallは総合評価
- 最終出力はJSONのみ。前置き、Markdownコードフェンス、JSON以外の文章を出力しない
"""


def agent_user_prompt(agent_name: str, payload: dict[str, Any]) -> str:
    handoff_payload = {
        "loop_instruction": payload.get("loop_instruction"),
        "llm_recovery_instruction": payload.get("llm_recovery_instruction"),
        "agent_handoff": payload.get("agent_handoff"),
        "routing_context": payload.get("routing_context"),
    }
    common_format = """
共通JSONフォーマット:
{
  "agent_name": "hypothesis | skeptic | researcher",
  "claims": [
    {"claim": "...", "evidence_ids": ["doc_123"], "confidence": 0.72}
  ],
  "questions": [
    {"question": "...", "priority": "high | medium | low", "target_agent": "researcher | skeptic | hypothesis"}
  ],
  "data_requests": [
    {
      "query": "...",
      "source": "db | web | official | trusted_news | company_disclosure | market_data | document_body",
      "reason": "...",
      "priority": "high | medium | low"
    }
  ],
  "global_analysis": {
    "promising_sectors": [
      {
        "sector": "...",
        "thesis": "...",
        "macro_drivers": ["..."],
        "transmission_path": "マクロ要因が収益・需給・バリュエーションへ伝わる経路",
        "beneficiary_company_traits": ["価格転嫁力", "在庫優位", "海外売上比率など"],
        "candidate_company_groups": [
          {"trait": "企業条件", "example_tickers": ["1234"], "example_names": ["会社名"], "reason": "..."}
        ],
        "risks": ["..."],
        "required_data": ["..."]
      }
    ]
  },
  "next_action": "call_agent | request_data | finalize | stop",
  "next_agent": "hypothesis | skeptic | researcher | collector | null",
  "reason_for_next_action": "...",
  "should_continue": true
}
"""
    researcher_extra = """
researcherの場合は次も含めてください:
{
  "final_decision": "promising | watchlist | inconclusive | rejected",
  "reason": "...",
  "evidence_strength": 0.0,
  "contradiction_strength": 0.0,
  "missing_information": ["..."],
  "recommended_next_research": ["..."],
  "scores": {
    "growth_impact": 0,
    "evidence_strength": 0,
    "contradiction_risk": 0,
    "valuation_risk": 0,
    "market_overlooked": 0,
    "overall": 0.0
  },
  "final_report": "400字以内。主要論点、根拠、反証、不足情報を簡潔に列挙。"
}
"""
    return f"""
エージェント: {agent_name}

前工程からの引き継ぎ:
{compact_json(handoff_payload, 7000)}

入力データ:
{compact_json(payload)}

{common_format}
{researcher_extra if agent_name == "researcher" else ""}

制約:
- 売買推奨や目標株価は出さない
- 根拠と反証を分ける
- 不足情報を明示する
- まとめ記事、ランキング記事、SEO記事、煽り見出しは直接の根拠にせず、一次情報や信頼できる統計・開示で裏取りする
- 表面的な「注目銘柄」記事から成長性を断定しない
- routing_context.available_agentsを参照し、次に必要な工程をnext_agentで指定する
- APIは原則としてあなたが指定したnext_agentを実行するため、同じ工程の繰り返しが必要か慎重に判断する
- 反証が不足している場合はskeptic、根拠統合が必要な場合はresearcher、仮説の再分解が必要な場合はhypothesisを指定する
- データ不足で新たな取得が必要な場合はnext_actionをrequest_data、next_agentをcollectorにする
- ニュースがタイトル/URLだけで本文根拠が不足している場合もcollectorに本文取得を要求する
- 「collectorによる取得が必須」「一次情報が不足」「財務データが不足」などと判断する場合は、finalizeやstopを使わずrequest_dataを選ぶ
- collectorに渡すため、data_requestsに検索・取得対象を具体的に書く。Collectorは情報・ニュース・文書本文・公式統計・指定銘柄データの取得担当であり、候補企業群の選定や統合判断はhypothesis/skeptic/researcherが行う
- 指定銘柄の追加取得が必要な場合は、data_requestsにtickerまたは会社名を明示する。Collectorに「候補企業を選べ」と依頼しない
- collector実行後は、取得結果に応じて反証、再仮説化、統合のどれが必要かを判断する
- hypothesis_typeがglobalの場合、company=null/ticker=nullは正常であり、不足情報や失敗理由にしてはいけない
- hypothesis_typeがglobalの場合、context.macro_indicators、context.sector_snapshots、context.recent_events、documents、companiesを使い、「有望セクター候補」「マクロ伝播経路」「根拠」「反証」「注目すべき企業特性」「候補企業群・代表例」「不足データ」を分ける
- global仮説で個別企業評価が未確定な場合でも、「どのような企業を深掘りすべきか」と「入力companiesから見える代表例」を出す
- documentsとcontextが不足している場合は一般論で有望セクターを断定せず、request_dataまたはinconclusiveとして不足データを具体的に列挙する
- hypothesis_typeがcompanyの場合、個別銘柄の業績、株価、開示、ニュースとの整合性を優先する
- researcherがfinalizeできるのは、主要な根拠と主要な反証が両方あり、追加取得すべき高優先度データが結論を左右しない場合だけ
- final_reportは「次に調べるべき」で終わらせず、まだ結論不能ならnext_action=request_dataまたはcall_agentを選ぶ
- next_actionとnext_agentを必ず指定し、次に呼ぶべき工程を決める
- 最終出力はJSONのみ。前置き、Markdownコードフェンス、JSON以外の文章を出力しない
"""
