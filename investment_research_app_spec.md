# 日本株リサーチ支援Webアプリケーション 仕様書

**Version:** 0.1  
**Status:** Draft  
**対象:** 日本株を中心とした投資リサーチ支援アプリケーション  
**目的:** LLMを用いて情報を集約し、ユーザーが表面的な事実だけでなく、潜在的な成長株・成長要因・市場の見落としを探索できるようにする。

---

## 1. プロダクト概要

本アプリケーションは、日本株に関するニュース、決算、適時開示、会社情報、株価、財務指標、マクロ情報を集約し、LLMエージェントによって投資仮説の生成・検証・反証・深掘りを支援するWebアプリケーションである。

本アプリケーションの主眼は「買い推奨」ではなく、以下に置く。

- 投資仮説の発見
- 仮説の根拠整理
- 仮説の反証
- 追加調査すべき論点の提示
- 銘柄・セクター・テーマごとの情報探索
- 株価変動とニュース・開示の関連把握

最終的な投資判断はユーザーが行う。本アプリケーションは、投資判断のための調査材料と分析フレームを提供する。

---

## 2. 技術構成

### 2.1 フロントエンド

- Webアプリケーション
- Next.js / React を想定
- ローソク足チャート、ニュース一覧、仮説ボード、銘柄詳細画面を提供

### 2.2 バックエンド

バックエンドは Node.js と Python を併用する。

```text
Frontend:
  Next.js / React

Backend API:
  Node.js / TypeScript
  - 認証
  - ユーザー管理
  - Web API
  - WebSocket / SSE
  - ジョブ起動

Research Backend:
  Python
  - ETL
  - LLMエージェント
  - RAG
  - 文書解析
  - スコアリング
  - 外部API連携

Database:
  PostgreSQL
  pgvector

Queue:
  Redis / Celery / BullMQ

Storage:
  S3互換ストレージ
  - PDF
  - HTML
  - XBRL
  - IR資料
  - 必要に応じた本文キャッシュ

Search:
  PostgreSQL full-text search または OpenSearch
```

---

## 3. 全体ワークフロー

本アプリケーションは、初期セットアップとしてステップ0を実行し、その後はユーザー始動で定期的に情報収集とリサーチを行う。

また、エージェントから追加情報の要求があった場合は、必要に応じてDBまたは外部ソースから追加調査を行う。

```text
0. データ基盤構築
1. 情報収集
2. 仮説検証
   a. 仮説生成
   b. 仮説検証・反証
   c. リサーチ・深掘り
3. 最終結論の出力
```

---

## 4. ステップ0：データ基盤構築

### 4.1 銘柄マスター

日本株の基本情報を保持する。

保持項目例：

| 分類 | 項目 |
|---|---|
| 識別子 | 証券コード、ISIN、EDINETコード、上場市場 |
| 基本情報 | 会社名、英文名、業種、上場日、決算期 |
| 事業情報 | 会社概要、事業内容、セグメント、主力製品・サービス |
| 市場情報 | 株価、時価総額、出来高、売買代金 |
| 財務指標 | PER、PBR、PSR、ROE、ROIC、自己資本比率、営業利益率 |
| 成長指標 | 売上成長率、営業利益成長率、EPS成長率、FCF成長率 |
| バリュエーション | 過去PER、過去PBR、過去PSR、同業比較 |

### 4.2 株価データ

ローソク足表示のため、OHLCVデータを保持する。

- 日足
- 週足
- 月足
- 出来高
- 売買代金
- 調整後終値

### 4.3 決算・適時開示・IR資料

必要に応じて蓄積または参照可能な形にする。

対象：

- 決算短信
- 四半期決算資料
- 有価証券報告書
- 適時開示
- 業績修正
- 自社株買い
- M&A
- 中期経営計画
- 会社説明資料
- 大量保有報告書
- コーポレートガバナンス報告書

---

## 5. データ保存方針

### 5.1 基本方針

すべての本文をローカル保存するとデータ量が膨大になるため、本アプリケーションでは以下のハイブリッド方針を採用する。

```text
1. メタデータを保存
   タイトル、URL、公開日時、媒体、関連銘柄、関連セクター

2. LLM要約を保存
   短い要約、投資観点の要約、リスク観点の要約、イベント分類

3. 埋め込みベクトルを保存
   後から意味検索するためのembedding

4. 本文・PDFは必要時のみ保存
   重要文書、公式開示、決算資料、IR資料を中心に保存
```

### 5.2 タイトルとURLのみ保存する場合の課題

タイトルとURLのみでは、以下の問題が発生する可能性がある。

| 問題 | 内容 |
|---|---|
| リンク切れ | 後から記事が削除・移動される可能性がある |
| 有料記事 | 再取得時に本文を参照できない可能性がある |
| 内容変更 | 記事本文が後から修正される可能性がある |
| 再現性不足 | なぜその仮説が生成されたか追跡しづらい |
| LLMコスト増 | 毎回本文取得・読解が必要になる |
| 検索精度不足 | タイトルだけでは意味検索・仮説生成に弱い |

そのため、最低限以下を保存する。

```json
{
  "title": "〇〇社、半導体向け部材の新工場を建設",
  "url": "https://example.com/news/123",
  "source": "会社IR / TDnet / ニュース媒体 / PR",
  "published_at": "2026-05-14T09:00:00+09:00",
  "related_companies": ["1234"],
  "related_sectors": ["半導体", "電子部品"],
  "summary_short": "〇〇社が半導体向け部材の新工場建設を発表。",
  "summary_investment": "中期的な需要増を見込んだ設備投資であり、売上成長の先行指標となる可能性がある。",
  "summary_risk": "需要回復が遅れた場合、固定費負担が先行する可能性がある。",
  "event_type": "capex",
  "sentiment": "positive",
  "importance_score": 0.78,
  "confidence": 0.72,
  "retrieval_status": "summary_only"
}
```

### 5.3 LLM要約保存の妥当性

LLMによる要約情報を保存することは現実的であり、本アプリケーションでは推奨する。

主な理由：

1. 同じ記事や開示を何度もLLMに読ませる必要がなくなる
2. 後続の仮説生成・検証で短い要約を再利用できる
3. ニュースをイベントとして扱える
4. 銘柄・セクター・テーマ横断の意味検索が可能になる
5. 仮説の根拠として再利用しやすくなる

### 5.4 保存する要約の種類

| 項目 | 内容 |
|---|---|
| summary_short | 1〜2文の通常要約 |
| summary_investment | 投資観点の要約 |
| summary_risk | リスク・反証観点の要約 |
| key_points | 重要ポイントの箇条書き |
| event_type | 設備投資、受注、業績修正、M&A、自社株買いなど |
| impact_horizon | 短期 / 中期 / 長期 |
| affected_metrics | 売上、利益率、ROE、FCF、PER、PBRなど |
| evidence_snippets | 根拠として使える短い断片 |

例：

```json
{
  "summary_short": "〇〇社は半導体検査装置向け部品の増産投資を発表した。",
  "summary_investment": "半導体設備投資の回復局面で、同社の売上成長率が上振れる可能性を示す材料。",
  "summary_risk": "投資回収には時間がかかり、需要回復が遅れた場合は固定費負担が先行する可能性がある。",
  "key_points": [
    "新工場への投資額は約50億円",
    "稼働開始は2027年予定",
    "主力顧客は半導体製造装置メーカー"
  ],
  "event_type": "capex",
  "impact_horizon": "medium",
  "affected_metrics": ["revenue_growth", "operating_margin", "capex"],
  "importance_score": 0.81
}
```

### 5.5 ストレージレベル

各ドキュメントに `storage_level` を持たせる。

| storage_level | 内容 |
|---|---|
| metadata_only | タイトル・URL・日時のみ |
| summary_only | メタデータ + LLM要約 |
| summary_with_snippets | 要約 + 重要な短文断片 |
| full_cached | 全文またはPDFを保存 |
| structured | 財務数値やイベントとして構造化済み |

保存レベルの目安：

| データ種別 | 推奨保存レベル |
|---|---|
| 一般ニュース | summary_only |
| 重要ニュース | summary_with_snippets |
| 決算短信 | full_cached + structured |
| 適時開示 | full_cached + structured |
| 有価証券報告書 | full_cached + structured |
| 会社IR資料 | full_cached または summary_with_snippets |
| 株価OHLCV | structured |
| 財務数値 | structured |

---

## 6. ステップ1：情報収集

### 6.1 情報収集の対象

情報収集は以下の3層に分ける。

| 層 | 内容 | 目的 |
|---|---|---|
| マクロ層 | 金利、為替、物価、地政学、政策 | 市場全体の風向きを把握 |
| セクター層 | 半導体、防衛、AI、電力、建設、医療など | テーマの強弱を把握 |
| 個別銘柄層 | 決算、開示、ニュース、株価変化 | 具体的な仮説材料を抽出 |

### 6.2 イベント分類

ニュースや開示は、単なる記事としてではなくイベントとして分類する。

| イベント | 投資仮説への変換例 |
|---|---|
| 大型受注 | 売上成長の可視性が高まった可能性 |
| 業績上方修正 | 会社計画が保守的、または需要が想定超の可能性 |
| 設備投資増 | 将来需要に対する経営陣の強気シグナル |
| 自社株買い | 資本効率改善、下値支え、PBR改善意識 |
| 価格改定 | 価格決定力、インフレ耐性 |
| 新規顧客獲得 | TAM拡大、横展開可能性 |
| 規制変更 | 構造的な追い風または逆風 |
| M&A | 事業領域拡大、シナジー、財務負担 |
| 増資 | 成長投資、希薄化、財務改善 |
| 大株主変化 | アクティビスト、需給変化、経営圧力 |

### 6.3 収集時メタデータ

```json
{
  "source_type": "news | disclosure | financial_statement | macro_stat | user_note",
  "published_at": "2026-05-14T09:00:00+09:00",
  "entities": ["企業コード", "企業名", "セクター", "国", "商品"],
  "event_type": "earnings_revision | policy_change | new_order | capex | fx_move | m_and_a",
  "sentiment": "positive | neutral | negative | mixed",
  "time_horizon": "short | medium | long",
  "importance_score": 0.0,
  "confidence": 0.0,
  "summary": "...",
  "raw_text_uri": "...",
  "source_url": "..."
}
```

---

## 7. ステップ2：仮説検証

ステップ2では、3つのLLMエージェントが協調して仮説を深める。

- 仮説生成エージェント
- 検証・反証エージェント
- リサーチエージェント

3人のエージェントは、出力時に次に呼び出すエージェント、追加データ要求、または結論出力の要否を判断する。

ただし、最終判断を行えるのはリサーチエージェントのみとする。

---

## 8. エージェント設計

### 8.1 エージェントA：仮説生成エージェント

#### 役割

最近のニュース、開示、財務変化、マクロ環境から、市場に十分織り込まれていない可能性がある投資仮説を生成する。

#### 入力

- 最近のニュース要約
- 適時開示要約
- 決算情報
- 株価変化
- 財務指標
- セクター情報
- マクロ情報

#### 出力例

```json
{
  "hypothesis": "防衛関連の中小型株Aは、政府調達拡大と設備投資増により中期売上成長率が市場予想を上回る可能性がある",
  "target_entities": ["企業A", "防衛セクター"],
  "growth_driver": "政策支出増加、受注残拡大、生産能力増強",
  "required_evidence": [
    "防衛省予算の推移",
    "企業Aの受注残",
    "設備投資計画",
    "同業他社比較"
  ],
  "risk_factors": [
    "単発受注の可能性",
    "利益率悪化",
    "すでに株価に織り込み済み"
  ],
  "next_action": "call_research_agent"
}
```

### 8.2 エージェントB：検証・反証エージェント

#### 役割

仮説を強める根拠と、仮説を壊す反証を両方出す。

特に、もっともらしい成長ストーリーを疑い、誤認・過大評価・織り込み済みリスクを検出する。

#### 主な検証観点

| 観点 | 反証例 |
|---|---|
| 成長性 | 売上成長は一過性ではないか |
| 収益性 | 受注は増えても利益率が落ちていないか |
| バリュエーション | すでにPER・PBRが過熱していないか |
| 市場期待 | 株価上昇で織り込み済みではないか |
| 競争環境 | 競合の方が優位ではないか |
| 財務 | 増資、借入、運転資金負担が重くないか |
| 経営 | ガイダンスが過度に楽観的ではないか |
| 時間軸 | 業績寄与まで長すぎないか |

### 8.3 エージェントC：リサーチエージェント

#### 役割

仮説生成エージェントと検証・反証エージェントからの要求に応じて、ネット、DB、開示、決算資料、統計データを調査する。

また、リサーチエージェントのみが最終判断を行える。

#### 最終判断の例

```json
{
  "final_decision": "promising | watchlist | inconclusive | rejected",
  "reason": "...",
  "evidence_strength": 0.78,
  "contradiction_strength": 0.34,
  "missing_information": ["..."],
  "recommended_next_research": ["..."]
}
```

---

## 9. エージェント間の呼び出し制御

### 9.1 共通出力フォーマット

各エージェントは以下の共通フォーマットで出力する。

```json
{
  "agent_name": "hypothesis | skeptic | researcher",
  "claims": [
    {
      "claim": "...",
      "evidence_ids": ["doc_123", "news_456"],
      "confidence": 0.72
    }
  ],
  "questions": [
    {
      "question": "...",
      "priority": "high | medium | low",
      "target_agent": "researcher | skeptic | hypothesis"
    }
  ],
  "next_action": "call_agent | request_data | finalize | stop",
  "next_agent": "hypothesis | skeptic | researcher | null",
  "reason_for_next_action": "...",
  "should_continue": true
}
```

### 9.2 停止条件

無限ループ防止のため、以下の停止条件を設定する。

| 条件 | 内容 |
|---|---|
| 最大ターン数 | 1仮説あたり最大8ターン程度 |
| 最大リサーチ回数 | 外部検索・DB検索は1仮説あたり最大5回程度 |
| 最小改善幅 | 新情報がスコアを一定以上変えなければ停止 |
| 最終判断権 | researcherのみfinalize可能 |
| 強制終了 | 証拠不足、反証過多、データ取得失敗、タイムアウト |

### 9.3 スコアリング

総合スコアは単純なポジティブ・ネガティブではなく、以下の要素に分解する。

```text
総合スコア =
  成長インパクト
× 実現可能性
× 市場の見落とし度
× 証拠の強さ
× 時間軸の明確さ
- 反証リスク
- バリュエーション過熱度
```

表示例：

| 項目 | スコア |
|---|---:|
| 成長インパクト | 8/10 |
| 証拠の強さ | 6/10 |
| 反証リスク | 5/10 |
| 織り込み済みリスク | 7/10 |
| 継続調査価値 | 8/10 |

---

## 10. ステップ3：最終出力

最終出力は、リサーチエージェントが担当する。

### 10.1 最終レポート構成

```markdown
# 仮説
〇〇社は、△△需要の拡大により中期的に売上成長率が市場予想を上回る可能性がある。

## 結論
Watchlist / Promising / Inconclusive / Rejected

## 主要根拠
1. ...
2. ...
3. ...

## 反証
1. ...
2. ...

## 重要な未確認事項
1. ...
2. ...

## 見るべき次のイベント
- 次回決算
- 月次データ
- 政策発表
- 大型受注開示
- 業績修正

## バリュエーション上の注意
...

## 総合評価
成長インパクト: 8/10
証拠の強さ: 6/10
反証リスク: 5/10
織り込み済みリスク: 7/10
継続調査価値: 8/10
```

---

## 11. UI仕様

### 11.1 ホーム画面

目的：今日・今週の市場テーマを俯瞰する。

表示項目：

- マクロ要因サマリー
- セクター別注目度
- 新規発生イベント
- 急上昇している仮説
- 反証により棄却された仮説
- 要追加調査の仮説
- 最近の重要開示
- 注目銘柄

### 11.2 仮説ボード

仮説を状態別に管理する。

| 状態 | 意味 |
|---|---|
| Draft | 仮説生成直後 |
| Researching | 追加情報収集中 |
| Under Review | 反証中 |
| Promising | 有望 |
| Watchlist | 継続監視 |
| Rejected | 棄却 |
| Inconclusive | 判断保留 |

### 11.3 銘柄詳細画面

銘柄詳細画面は本アプリケーションの中核UIとする。

表示項目：

```text
銘柄名 / 証券コード / 市場 / 業種

[株価チャート]
- ローソク足
- 出来高
- 移動平均線
- 決算発表マーカー
- 適時開示マーカー
- 重要ニュースマーカー

[会社情報]
- 事業概要
- セグメント
- 主力製品・サービス
- 主要顧客
- 成長ドライバー
- リスク要因

[指標]
- PER
- PBR
- PSR
- ROE
- ROIC
- 営業利益率
- 売上成長率
- 営業利益成長率
- 時価総額
- 自己資本比率

[関連ニュース]
- 日付
- タイトル
- 要約
- イベント分類
- ポジ/ネガ/中立
- 重要度
- 関連仮説

[開示・決算]
- 決算短信
- 業績修正
- 自社株買い
- 中期経営計画
- M&A
- 大量保有報告書

[仮説]
- 現在検証中の仮説
- 有望判定された仮説
- 棄却された仮説
- 要追加調査の仮説
```

### 11.4 ローソク足チャート仕様

ローソク足は単なるチャートではなく、ニュース・開示と接続する。

必須機能：

- 日足 / 週足 / 月足切り替え
- 出来高表示
- 移動平均線
- 決算発表日のマーカー
- 適時開示のマーカー
- 重要ニュースのマーカー
- マーカークリックで要約表示
- チャート期間変更
- 株価急変日のイベント表示

チャート上のイベント例：

```text
2026/05/14 に株価が急騰

チャート上のマーカー:
- 09:00 業績上方修正
- 10:30 大型受注報道
- 15:00 決算短信発表

LLMコメント:
この日の上昇は、業績上方修正と大型受注報道が主因の可能性が高い。
ただし、出来高急増を伴っており、短期資金流入の影響もある。
```

### 11.5 仮説詳細画面

仮説詳細画面は、リサーチ結果を深く確認する画面である。

構成：

```text
仮説タイトル

1. 仮説の要約
2. なぜ今注目するのか
3. 成長ドライバー
4. 根拠
5. 反証
6. 未確認事項
7. 関連銘柄
8. 関連セクター
9. バリュエーション面の注意
10. 次に見るべき開示・イベント
11. エージェント思考ログ
```

---

## 12. API設計案

### 12.1 銘柄関連API

```text
GET /api/companies/:ticker
  会社情報を取得

GET /api/companies/:ticker/prices?period=1y&interval=1d
  ローソク足データを取得

GET /api/companies/:ticker/news
  関連ニュースを取得

GET /api/companies/:ticker/disclosures
  適時開示・決算資料を取得

GET /api/companies/:ticker/hypotheses
  関連仮説を取得

POST /api/companies/:ticker/research
  この銘柄について追加調査を実行
```

### 12.2 仮説関連API

```text
GET /api/hypotheses
  仮説一覧を取得

GET /api/hypotheses/:id
  仮説詳細を取得

POST /api/hypotheses
  仮説を作成

POST /api/hypotheses/:id/run
  仮説検証エージェントを実行

POST /api/hypotheses/:id/deepen
  追加深掘りを実行

PATCH /api/hypotheses/:id/status
  仮説ステータスを更新
```

### 12.3 ニュース・文書関連API

```text
GET /api/documents
  文書一覧を取得

GET /api/documents/:id
  文書詳細を取得

POST /api/documents/fetch
  URLから文書を取得・要約

POST /api/documents/:id/summarize
  文書をLLM要約

POST /api/documents/search
  文書を検索
```

### 12.4 エージェント関連API

```text
POST /api/agents/hypothesis
  仮説生成エージェントを実行

POST /api/agents/skeptic
  検証・反証エージェントを実行

POST /api/agents/researcher
  リサーチエージェントを実行

GET /api/agent-runs/:id
  エージェント実行結果を取得
```

---

## 13. DB設計案

### 13.1 companies

```sql
CREATE TABLE companies (
  id BIGSERIAL PRIMARY KEY,
  ticker VARCHAR(10) NOT NULL UNIQUE,
  name TEXT NOT NULL,
  market TEXT,
  sector TEXT,
  industry TEXT,
  description TEXT,
  business_summary TEXT,
  fiscal_year_end TEXT,
  market_cap NUMERIC,
  listed_at DATE,
  edinet_code TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

### 13.2 price_daily

```sql
CREATE TABLE price_daily (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  date DATE NOT NULL,
  open NUMERIC,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC,
  volume BIGINT,
  turnover NUMERIC,
  adjusted_close NUMERIC,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(company_id, date)
);
```

### 13.3 company_metrics

```sql
CREATE TABLE company_metrics (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  date DATE NOT NULL,
  per NUMERIC,
  pbr NUMERIC,
  psr NUMERIC,
  roe NUMERIC,
  roic NUMERIC,
  operating_margin NUMERIC,
  revenue_growth NUMERIC,
  operating_profit_growth NUMERIC,
  equity_ratio NUMERIC,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(company_id, date)
);
```

### 13.4 documents

```sql
CREATE TABLE documents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  source_type TEXT,
  source_name TEXT,
  title TEXT NOT NULL,
  url TEXT,
  published_at TIMESTAMP,
  storage_level TEXT,
  retrieval_status TEXT,
  raw_text_uri TEXT,
  pdf_uri TEXT,
  summary_short TEXT,
  summary_investment TEXT,
  summary_risk TEXT,
  event_type TEXT,
  sentiment TEXT,
  importance_score NUMERIC,
  confidence NUMERIC,
  embedding VECTOR,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

### 13.5 document_entities

```sql
CREATE TABLE document_entities (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT REFERENCES documents(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  relevance_score NUMERIC,
  created_at TIMESTAMP DEFAULT now()
);
```

### 13.6 events

```sql
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id),
  document_id BIGINT REFERENCES documents(id),
  sector TEXT,
  event_type TEXT,
  title TEXT,
  summary TEXT,
  sentiment TEXT,
  impact_score NUMERIC,
  impact_horizon TEXT,
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now()
);
```

### 13.7 hypotheses

```sql
CREATE TABLE hypotheses (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT,
  target_company_id BIGINT REFERENCES companies(id),
  target_sector TEXT,
  score_growth NUMERIC,
  score_evidence NUMERIC,
  score_contradiction NUMERIC,
  score_valuation_risk NUMERIC,
  score_overall NUMERIC,
  created_by_agent TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

### 13.8 hypothesis_documents

```sql
CREATE TABLE hypothesis_documents (
  id BIGSERIAL PRIMARY KEY,
  hypothesis_id BIGINT REFERENCES hypotheses(id),
  document_id BIGINT REFERENCES documents(id),
  relation_type TEXT,
  evidence_strength NUMERIC,
  note TEXT,
  created_at TIMESTAMP DEFAULT now()
);
```

### 13.9 agent_runs

```sql
CREATE TABLE agent_runs (
  id BIGSERIAL PRIMARY KEY,
  hypothesis_id BIGINT REFERENCES hypotheses(id),
  agent_name TEXT NOT NULL,
  input JSONB,
  output JSONB,
  next_action TEXT,
  next_agent TEXT,
  created_at TIMESTAMP DEFAULT now()
);
```

---

## 14. LLM処理パイプライン

ニュースや開示を取得したら、以下のパイプラインで処理する。

```text
1. URL・タイトル・日時を取得
2. 本文またはPDFを一時取得
3. 関連銘柄を抽出
4. 関連セクターを抽出
5. イベント分類
6. LLM要約
7. 投資観点の意味づけ
8. リスク観点の要約
9. importance_scoreを付与
10. embedding生成
11. DB保存
12. 重要文書のみraw/PDF保存
```

### 14.1 LLM要約プロンプトの出力仕様

```json
{
  "related_companies": [
    {
      "ticker": "1234",
      "name": "〇〇株式会社",
      "relevance_score": 0.91
    }
  ],
  "related_sectors": ["半導体", "電子部品"],
  "event_type": "capex",
  "summary_short": "...",
  "summary_investment": "...",
  "summary_risk": "...",
  "key_points": ["...", "..."],
  "sentiment": "positive | neutral | negative | mixed",
  "impact_horizon": "short | medium | long",
  "affected_metrics": ["revenue_growth", "operating_margin"],
  "importance_score": 0.81,
  "confidence": 0.74,
  "requires_full_cache": false
}
```

---

## 15. MVPスコープ

### 15.1 MVP 1：日本株リサーチ基盤

- 銘柄マスター取り込み
- 株価OHLCV取り込み
- 会社概要表示
- ニュースタイトル・URL保存
- LLM要約保存
- 銘柄詳細ページ
- ローソク足チャート

### 15.2 MVP 2：開示・ニュース連携

- 適時開示・決算短信取り込み
- ニュースとチャートのマーカー連携
- 重要ニューススコアリング
- イベント分類
- 関連銘柄抽出

### 15.3 MVP 3：仮説生成

- 直近ニュース・開示から仮説生成
- 仮説ボード
- 根拠リンク表示
- 追加調査リクエスト

### 15.4 MVP 4：反証・リサーチループ

- 反証エージェント
- リサーチエージェント
- 3エージェントの相互呼び出し
- 最大ターン数制御
- 最終レポート生成
- ユーザーによる「もっと深掘り」操作

---

## 16. 初期実装の推奨順序

```text
Phase 1:
  - 銘柄マスター
  - 株価OHLCV
  - 会社情報
  - ニュースタイトル・URL
  - LLM要約
  - 銘柄詳細ページ
  - ローソク足チャート

Phase 2:
  - 適時開示・決算短信
  - ニュースとチャートのマーカー連携
  - 関連ニュースの重要度スコア
  - 仮説生成

Phase 3:
  - 反証エージェント
  - リサーチエージェント
  - 仮説ボード
  - 深掘りボタン
  - 最終レポート
```

---

## 17. データソース候補

初期検討対象：

| 種別 | 候補 |
|---|---|
| 銘柄マスター | JPX上場銘柄一覧など |
| 株価・財務 | J-Quants API、その他マーケットデータAPI |
| 適時開示 | TDnet、TDnet API、上場会社IRページ |
| 有価証券報告書 | EDINET API |
| 企業IR | 各社IRページ |
| マクロ統計 | 日本銀行、e-Stat、財務省、内閣府など |
| ニュース | ニュースAPI、RSS、企業発表、業界メディアなど |

注：商用利用時は各データソースの利用規約、再配布可否、保存可否、要約利用可否を確認する必要がある。

---

## 18. 法務・コンプライアンス上の注意

本アプリケーションは投資助言ではなく、情報整理・リサーチ支援ツールとして位置づける。

留意事項：

- 個別銘柄の売買推奨と誤認されないUI・文言にする
- 「買い」「売り」ではなく「Promising」「Watchlist」「Rejected」「Inconclusive」等の表現を使う
- ニュース本文の全文保存・再配布には注意する
- 有料記事・著作物の扱いに注意する
- LLM出力は誤りを含み得るため、根拠URL・根拠文書への導線を必ず持たせる
- 最終的な投資判断はユーザーが行う旨を明示する
- データソースごとの利用規約を確認する

---

## 19. 仕様上の重要な設計判断

| 論点 | 方針 |
|---|---|
| 最終目的 | 銘柄推奨ではなく、仮説探索・検証支援 |
| 初期対象 | 日本株の中小型・グロース・テーマ株を中心に検討 |
| 情報単位 | ニュース単位ではなくイベント単位 |
| 本文保存 | 全文保存ではなく、メタデータ + 要約 + 必要時キャッシュ |
| LLMの役割 | 要約だけでなく、仮説・反証・追加調査を担う |
| 最終判断 | リサーチエージェントのみ可能 |
| 主要UI | 銘柄詳細、ローソク足、関連ニュース、会社情報、仮説ボード |

---

## 20. 未決定事項

今後詰めるべき論点：

1. MVPで扱う銘柄範囲
   - 全上場銘柄か
   - グロース市場中心か
   - 中小型株中心か
   - 特定テーマ・セクターから始めるか

2. 初期データソース
   - J-Quantsを使うか
   - TDnet APIを使うか
   - EDINET APIを使うか
   - ニュースAPIをどこまで使うか

3. ニュース本文の扱い
   - 本文を保存しない方針でよいか
   - 重要ニュースのみ断片保存するか
   - 有料記事を対象外にするか

4. 仮説スコア定義
   - 成長性
   - 証拠強度
   - 反証リスク
   - 織り込み済み度
   - バリュエーションリスク

5. UIの主導線
   - 銘柄起点
   - テーマ起点
   - 仮説起点

6. エージェント制御
   - 最大ターン数
   - 最大検索回数
   - 終了条件
   - コスト上限

7. 認証・ユーザー管理
   - 個人利用か
   - チーム利用か
   - ウォッチリスト共有を行うか

---

## 21. 推奨する初期プロダクト体験

初期MVPでは、以下の体験を中心にする。

```text
テーマ起点
  ↓
関連ニュース・開示の確認
  ↓
関連銘柄の抽出
  ↓
銘柄詳細ページで会社情報・株価・ニュース確認
  ↓
LLMが投資仮説を生成
  ↓
反証エージェントがリスクを提示
  ↓
リサーチエージェントが追加調査
  ↓
Watchlist / Promising / Inconclusive / Rejected に分類
```

理由：

- 潜在的な成長株探索では、ユーザーが最初から銘柄名を知っているとは限らない
- テーマから入ることで、関連銘柄・周辺銘柄・出遅れ銘柄を発見しやすい
- LLMの強みである横断的な関連付けを活かしやすい

---

## 22. 結論

本アプリケーションは、全文保存型のニュースDBではなく、以下を結びつける投資リサーチDBとして設計する。

```text
URL
+ メタデータ
+ LLM要約
+ イベント分類
+ 銘柄情報
+ 株価情報
+ 財務情報
+ 仮説
+ 根拠
+ 反証
```

最初の実装では、銘柄詳細画面を中核とし、各銘柄ごとに以下を見られるようにする。

- ローソク足
- 関連ニュース
- 会社情報
- 財務指標
- 決算・適時開示
- 関連仮説

その上で、LLMエージェントにより、ニュースや開示から成長仮説を作成し、反証し、必要に応じて追加リサーチを行う。

これにより、ユーザーは表面的なニュース要約ではなく、潜在的な成長要因や市場の見落としを探索できる。
