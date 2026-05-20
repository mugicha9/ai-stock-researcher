import { hasDatabase, query } from "./db.js";
import type { AgentRun, Company, DocumentRecord, EventRecord, Hypothesis, JsonRecord, MacroIndicator, PricePoint } from "./types.js";

function requireDatabase() {
  if (!hasDatabase) {
    throw Object.assign(new Error("DATABASE_URL is required for real data mode"), { status: 503 });
  }
}

function normalizeSearch(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function parseMacroIndicator(rawText: string | null | undefined): MacroIndicator | null {
  if (!rawText) return null;
  try {
    const parsed = JSON.parse(rawText) as MacroIndicator;
    return parsed && typeof parsed.symbol === "string" && typeof parsed.close === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function formatMacroNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(value);
}

function buildMacroSummary(indicators: MacroIndicator[], news: DocumentRecord[]): string[] {
  if (!indicators.length && !news.length) {
    return [
      "マクロ指数・ニュースはまだ取得されていません。ホームのマクロ欄から取得してください。",
      "データソースは設定で差し替え可能です。ニュース本文はCollectorが必要に応じて取得し、調査入力に反映します。"
    ];
  }

  const marketLine = indicators.length
    ? indicators
        .slice(0, 6)
        .map((item) => {
          const change = item.change_percent === null || item.change_percent === undefined ? "" : ` ${item.change_percent >= 0 ? "+" : ""}${formatMacroNumber(item.change_percent)}%`;
          return `${item.label} ${formatMacroNumber(item.close)}${change}`;
        })
        .join(" / ")
    : "マクロ指数は未取得です。";
  const newsLine = news[0] ? `直近マクロニュース: ${news[0].title}` : "マクロニュースは未取得です。";
  return [marketLine, newsLine];
}

export async function getOverview() {
  requireDatabase();
  const [companies, companyCount, events, hypotheses, documents, sectors, macroIndicators, macroNews] = await Promise.all([
    listCompanies(24),
    query<{ count: number }>("SELECT COUNT(*)::int AS count FROM companies"),
    query<EventRecord>(`
      SELECT e.*, c.ticker, c.name AS company_name
      FROM events e
      LEFT JOIN companies c ON c.id = e.company_id
      ORDER BY e.published_at DESC NULLS LAST
      LIMIT 10
    `),
    query<Hypothesis>(`
      SELECT h.*, c.ticker, c.name AS company_name
      FROM hypotheses h
      LEFT JOIN companies c ON c.id = h.target_company_id
      ORDER BY h.updated_at DESC
      LIMIT 20
    `),
    query<DocumentRecord>(`
      SELECT d.*, c.ticker, c.name AS company_name
      FROM documents d
      LEFT JOIN companies c ON c.id = d.company_id
      ORDER BY d.published_at DESC NULLS LAST, d.id DESC
      LIMIT 10
    `),
    query<{ sector: string; attention_score: number; event_count: number }>(`
      SELECT COALESCE(sector, '未分類') AS sector,
        ROUND((AVG(COALESCE(impact_score, 0)) * 100)::numeric, 1)::float AS attention_score,
        COUNT(*)::int AS event_count
      FROM events
      GROUP BY COALESCE(sector, '未分類')
      ORDER BY attention_score DESC, event_count DESC
      LIMIT 8
    `),
    listMacroIndicators(12),
    listMacroNews(8)
  ]);

  return {
    macro_summary: buildMacroSummary(macroIndicators, macroNews),
    macro_indicators: macroIndicators,
    macro_news: macroNews,
    sectors,
    company_count: companyCount[0]?.count ?? companies.length,
    companies,
    events,
    hypotheses,
    documents
  };
}

export async function listMacroIndicators(limit = 12): Promise<MacroIndicator[]> {
  requireDatabase();
  const rows = await query<{ raw_text?: string | null }>(
    `
    SELECT raw_text
    FROM documents
    WHERE source_type = 'macro_stat'
    ORDER BY published_at DESC NULLS LAST, id DESC
    LIMIT $1
  `,
    [limit]
  );
  return rows.map((row) => parseMacroIndicator(row.raw_text)).filter((row): row is MacroIndicator => Boolean(row));
}

export async function listMacroNews(limit = 8): Promise<DocumentRecord[]> {
  requireDatabase();
  return query<DocumentRecord>(
    `
    SELECT d.*
    FROM documents d
    WHERE d.source_type = 'news'
      AND d.event_type = 'macro'
    ORDER BY d.published_at DESC NULLS LAST, d.id DESC
    LIMIT $1
  `,
    [limit]
  );
}

export async function listSectorSnapshots(limit = 20): Promise<JsonRecord[]> {
  requireDatabase();
  return query<JsonRecord>(
    `
    WITH latest_metrics AS (
      SELECT DISTINCT ON (company_id)
        company_id,
        revenue_growth::float AS revenue_growth,
        operating_profit_growth::float AS operating_profit_growth,
        operating_margin::float AS operating_margin,
        roe::float AS roe,
        equity_ratio::float AS equity_ratio,
        date
      FROM company_metrics
      ORDER BY company_id, date DESC
    ),
    sector_companies AS (
      SELECT
        COALESCE(c.sector, '未分類') AS sector,
        COUNT(*)::int AS company_count,
        AVG(lm.revenue_growth)::float AS avg_revenue_growth,
        AVG(lm.operating_profit_growth)::float AS avg_operating_profit_growth,
        AVG(lm.operating_margin)::float AS avg_operating_margin,
        AVG(lm.roe)::float AS avg_roe,
        AVG(lm.equity_ratio)::float AS avg_equity_ratio
      FROM companies c
      LEFT JOIN latest_metrics lm ON lm.company_id = c.id
      GROUP BY COALESCE(c.sector, '未分類')
    ),
    sector_events AS (
      SELECT
        COALESCE(sector, '未分類') AS sector,
        COUNT(*)::int AS event_count,
        AVG(impact_score)::float AS avg_impact_score,
        MAX(published_at) AS latest_event_at
      FROM events
      GROUP BY COALESCE(sector, '未分類')
    )
    SELECT
      sc.sector,
      sc.company_count,
      sc.avg_revenue_growth,
      sc.avg_operating_profit_growth,
      sc.avg_operating_margin,
      sc.avg_roe,
      sc.avg_equity_ratio,
      COALESCE(se.event_count, 0)::int AS event_count,
      se.avg_impact_score,
      se.latest_event_at
    FROM sector_companies sc
    LEFT JOIN sector_events se ON se.sector = sc.sector
    ORDER BY COALESCE(se.avg_impact_score, 0) DESC, COALESCE(se.event_count, 0) DESC, sc.company_count DESC
    LIMIT $1
  `,
    [Math.max(1, Math.min(50, limit))]
  );
}

export async function listCompanies(limit?: number): Promise<Company[]> {
  requireDatabase();
  return query<Company>(
    `
    SELECT c.*,
      row_to_json(m.*) AS latest_metrics
    FROM companies c
    LEFT JOIN LATERAL (
      SELECT per::float, pbr::float, psr::float, roe::float, roic::float,
        operating_margin::float, revenue_growth::float,
        operating_profit_growth::float, equity_ratio::float, date
      FROM company_metrics
      WHERE company_id = c.id
      ORDER BY date DESC
      LIMIT 1
    ) m ON true
    ORDER BY c.ticker
    LIMIT COALESCE($1::int, 2147483647)
  `,
    [limit ?? null]
  );
}

export async function getCompany(ticker: string): Promise<Company | undefined> {
  requireDatabase();
  const rows = await query<Company>(
    `
    SELECT c.*,
      row_to_json(m.*) AS latest_metrics
    FROM companies c
    LEFT JOIN LATERAL (
      SELECT per::float, pbr::float, psr::float, roe::float, roic::float,
        operating_margin::float, revenue_growth::float,
        operating_profit_growth::float, equity_ratio::float, date
      FROM company_metrics
      WHERE company_id = c.id
      ORDER BY date DESC
      LIMIT 1
    ) m ON true
    WHERE c.ticker = $1
    LIMIT 1
  `,
    [ticker]
  );
  return rows[0];
}

export async function upsertCompany(input: Partial<Company> & { ticker: string; name: string }): Promise<Company> {
  requireDatabase();
  const rows = await query<Company>(
    `
    INSERT INTO companies (
      ticker, name, english_name, market, sector, industry, description,
      business_summary, fiscal_year_end, market_cap, listed_at, edinet_code
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (ticker) DO UPDATE
    SET name = EXCLUDED.name,
      english_name = EXCLUDED.english_name,
      market = EXCLUDED.market,
      sector = EXCLUDED.sector,
      industry = EXCLUDED.industry,
      description = COALESCE(EXCLUDED.description, companies.description),
      business_summary = COALESCE(EXCLUDED.business_summary, companies.business_summary),
      fiscal_year_end = COALESCE(EXCLUDED.fiscal_year_end, companies.fiscal_year_end),
      market_cap = COALESCE(EXCLUDED.market_cap, companies.market_cap),
      listed_at = COALESCE(EXCLUDED.listed_at, companies.listed_at),
      edinet_code = COALESCE(EXCLUDED.edinet_code, companies.edinet_code),
      updated_at = now()
    RETURNING *
  `,
    [
      input.ticker,
      input.name,
      input.english_name ?? null,
      input.market ?? null,
      input.sector ?? null,
      input.industry ?? null,
      input.description ?? null,
      input.business_summary ?? null,
      input.fiscal_year_end ?? null,
      input.market_cap ?? null,
      input.listed_at ?? null,
      input.edinet_code ?? null
    ]
  );
  return rows[0];
}

export async function getPrices(ticker: string): Promise<PricePoint[]> {
  requireDatabase();
  return query<PricePoint>(
    `
    SELECT to_char(p.date, 'YYYY-MM-DD') AS date,
      p.open::float AS open,
      p.high::float AS high,
      p.low::float AS low,
      p.close::float AS close,
      p.volume::bigint AS volume,
      p.turnover::float AS turnover,
      p.adjusted_close::float AS adjusted_close
    FROM price_daily p
    JOIN companies c ON c.id = p.company_id
    WHERE c.ticker = $1
    ORDER BY p.date
  `,
    [ticker]
  );
}

export async function upsertPrices(ticker: string, prices: PricePoint[]): Promise<number> {
  requireDatabase();
  if (!prices.length) return 0;
  let count = 0;
  for (const price of prices) {
    const rows = await query<{ id: number }>(
      `
      INSERT INTO price_daily (company_id, date, open, high, low, close, volume, turnover, adjusted_close)
      VALUES ((SELECT id FROM companies WHERE ticker = $1), $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (company_id, date) DO UPDATE
      SET open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        turnover = EXCLUDED.turnover,
        adjusted_close = EXCLUDED.adjusted_close
      RETURNING id
    `,
      [
        ticker,
        price.date,
        price.open ?? null,
        price.high ?? null,
        price.low ?? null,
        price.close ?? null,
        price.volume ?? null,
        price.turnover ?? null,
        price.adjusted_close ?? null
      ]
    );
    if (rows[0]) count += 1;
  }
  return count;
}

export async function upsertMetrics(
  ticker: string,
  input: {
    date: string;
    roe?: number | null;
    operating_margin?: number | null;
    revenue_growth?: number | null;
    operating_profit_growth?: number | null;
    equity_ratio?: number | null;
  }
): Promise<void> {
  requireDatabase();
  await query(
    `
    INSERT INTO company_metrics (
      company_id, date, roe, operating_margin, revenue_growth,
      operating_profit_growth, equity_ratio
    )
    VALUES ((SELECT id FROM companies WHERE ticker = $1), $2, $3, $4, $5, $6, $7)
    ON CONFLICT (company_id, date) DO UPDATE
    SET roe = COALESCE(EXCLUDED.roe, company_metrics.roe),
      operating_margin = COALESCE(EXCLUDED.operating_margin, company_metrics.operating_margin),
      revenue_growth = COALESCE(EXCLUDED.revenue_growth, company_metrics.revenue_growth),
      operating_profit_growth = COALESCE(EXCLUDED.operating_profit_growth, company_metrics.operating_profit_growth),
      equity_ratio = COALESCE(EXCLUDED.equity_ratio, company_metrics.equity_ratio)
  `,
    [
      ticker,
      input.date,
      input.roe ?? null,
      input.operating_margin ?? null,
      input.revenue_growth ?? null,
      input.operating_profit_growth ?? null,
      input.equity_ratio ?? null
    ]
  );
}

export async function listDocuments(
  options: { ticker?: string; sourceType?: string; search?: string; sector?: string; since?: string; limit?: number } = {}
): Promise<DocumentRecord[]> {
  requireDatabase();
  const search = normalizeSearch(options.search);
  const sector = normalizeSearch(options.sector);
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  return query<DocumentRecord>(
    `
    SELECT d.*, c.ticker, c.name AS company_name
    FROM documents d
    LEFT JOIN companies c ON c.id = d.company_id
    WHERE ($1::text IS NULL OR c.ticker = $1)
      AND ($2::text IS NULL OR d.source_type = $2)
      AND (
        $3::text IS NULL
        OR d.title ILIKE '%' || $3 || '%'
        OR d.summary_short ILIKE '%' || $3 || '%'
        OR d.summary_investment ILIKE '%' || $3 || '%'
      )
      AND (
        $4::text IS NULL
        OR c.sector ILIKE '%' || $4 || '%'
        OR d.title ILIKE '%' || $4 || '%'
        OR d.summary_short ILIKE '%' || $4 || '%'
        OR d.summary_investment ILIKE '%' || $4 || '%'
      )
      AND ($5::timestamp IS NULL OR d.published_at >= $5::timestamp)
    ORDER BY d.published_at DESC NULLS LAST, d.id DESC
    LIMIT $6
  `,
    [options.ticker ?? null, options.sourceType ?? null, search, sector, options.since ?? null, limit]
  );
}

export async function getDocument(id: number): Promise<DocumentRecord | undefined> {
  requireDatabase();
  const rows = await query<DocumentRecord>(
    `
    SELECT d.*, c.ticker, c.name AS company_name
    FROM documents d
    LEFT JOIN companies c ON c.id = d.company_id
    WHERE d.id = $1
  `,
    [id]
  );
  return rows[0];
}

export async function createDocument(input: Partial<DocumentRecord> & { ticker?: string }): Promise<DocumentRecord> {
  requireDatabase();
  const rows = await query<DocumentRecord>(
    `
    INSERT INTO documents (
      company_id, source_type, source_name, title, url, published_at,
      storage_level, retrieval_status, raw_text, summary_short,
      summary_investment, summary_risk, key_points, event_type, sentiment,
      impact_horizon, affected_metrics, importance_score, confidence
    )
    VALUES (
      (SELECT id FROM companies WHERE ticker = $1),
      $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13::jsonb, $14, $15, $16, $17::jsonb, $18, $19
    )
    RETURNING *
  `,
    [
      input.ticker ?? null,
      input.source_type ?? "user_note",
      input.source_name ?? "manual",
      input.title,
      input.url ?? null,
      input.published_at ?? new Date().toISOString(),
      input.storage_level ?? "summary_only",
      input.retrieval_status ?? "summary_only",
      input.raw_text ?? null,
      input.summary_short ?? null,
      input.summary_investment ?? null,
      input.summary_risk ?? null,
      JSON.stringify(input.key_points ?? []),
      input.event_type ?? null,
      input.sentiment ?? "neutral",
      input.impact_horizon ?? null,
      JSON.stringify(input.affected_metrics ?? []),
      input.importance_score ?? null,
      input.confidence ?? null
    ]
  );
  return rows[0];
}

export async function deleteDocumentByUrl(url: string): Promise<void> {
  requireDatabase();
  await query("DELETE FROM documents WHERE url = $1", [url]);
}

export async function updateDocumentSummary(id: number, summary: JsonRecord): Promise<DocumentRecord | undefined> {
  requireDatabase();
  const rows = await query<DocumentRecord>(
    `
    UPDATE documents
    SET summary_short = COALESCE($2, summary_short),
      summary_investment = COALESCE($3, summary_investment),
      summary_risk = COALESCE($4, summary_risk),
      key_points = COALESCE($5::jsonb, key_points),
      event_type = COALESCE($6, event_type),
      sentiment = COALESCE($7, sentiment),
      impact_horizon = COALESCE($8, impact_horizon),
      affected_metrics = COALESCE($9::jsonb, affected_metrics),
      importance_score = COALESCE($10, importance_score),
      confidence = COALESCE($11, confidence),
      retrieval_status = 'summary_only',
      updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [
      id,
      summary.summary_short ?? null,
      summary.summary_investment ?? null,
      summary.summary_risk ?? null,
      summary.key_points ? JSON.stringify(summary.key_points) : null,
      summary.event_type ?? null,
      summary.sentiment ?? null,
      summary.impact_horizon ?? null,
      summary.affected_metrics ? JSON.stringify(summary.affected_metrics) : null,
      summary.importance_score ?? null,
      summary.confidence ?? null
    ]
  );
  return rows[0];
}

export async function updateDocumentBody(
  id: number,
  input: {
    raw_text: string;
    summary_short?: string | null;
    summary_investment?: string | null;
    summary_risk?: string | null;
    key_points?: unknown[] | null;
  }
): Promise<DocumentRecord | undefined> {
  requireDatabase();
  const rows = await query<DocumentRecord>(
    `
    UPDATE documents
    SET raw_text = $2,
      storage_level = 'full_text',
      retrieval_status = 'full_text',
      summary_short = COALESCE($3, summary_short),
      summary_investment = COALESCE($4, summary_investment),
      summary_risk = COALESCE($5, summary_risk),
      key_points = COALESCE($6::jsonb, key_points),
      updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [
      id,
      input.raw_text,
      input.summary_short ?? null,
      input.summary_investment ?? null,
      input.summary_risk ?? null,
      input.key_points ? JSON.stringify(input.key_points) : null
    ]
  );
  return rows[0];
}

export async function listHypotheses(options: { status?: string; ticker?: string; hypothesisType?: string } = {}): Promise<Hypothesis[]> {
  requireDatabase();
  return query<Hypothesis>(
    `
    SELECT h.*, c.ticker, c.name AS company_name
    FROM hypotheses h
    LEFT JOIN companies c ON c.id = h.target_company_id
    WHERE ($1::text IS NULL OR h.status = $1)
      AND ($2::text IS NULL OR c.ticker = $2)
      AND ($3::text IS NULL OR h.hypothesis_type = $3)
    ORDER BY h.updated_at DESC, h.id DESC
  `,
    [options.status ?? null, options.ticker ?? null, options.hypothesisType ?? null]
  );
}

export async function getHypothesis(id: number): Promise<Hypothesis | undefined> {
  requireDatabase();
  const rows = await query<Hypothesis>(
    `
    SELECT h.*, c.ticker, c.name AS company_name
    FROM hypotheses h
    LEFT JOIN companies c ON c.id = h.target_company_id
    WHERE h.id = $1
  `,
    [id]
  );
  const hypothesis = rows[0];
  if (!hypothesis) return undefined;
  const [documents, agentRuns] = await Promise.all([
    query<DocumentRecord>(
      `
      SELECT d.*, c.ticker, c.name AS company_name
      FROM hypothesis_documents hd
      JOIN documents d ON d.id = hd.document_id
      LEFT JOIN companies c ON c.id = d.company_id
      WHERE hd.hypothesis_id = $1
      ORDER BY hd.evidence_strength DESC NULLS LAST, d.published_at DESC NULLS LAST
    `,
      [id]
    ),
    query<AgentRun>(
      `
      SELECT *
      FROM agent_runs
      WHERE hypothesis_id = $1
      ORDER BY created_at DESC
    `,
      [id]
    )
  ]);
  return { ...hypothesis, documents, agent_runs: agentRuns };
}

export async function createHypothesis(input: Partial<Hypothesis> & { ticker?: string }): Promise<Hypothesis> {
  requireDatabase();
  const rows = await query<Hypothesis>(
    `
    INSERT INTO hypotheses (
      title, summary, status, hypothesis_type, target_company_id, target_sector, growth_driver,
      required_evidence, risk_factors, missing_information, recommended_next_research,
      score_growth, score_evidence, score_contradiction, score_valuation_risk,
      score_overlooked, score_overall, final_decision, final_report, created_by_agent
    )
    VALUES (
      $1, $2, $3, $4, COALESCE($5, (SELECT id FROM companies WHERE ticker = $6)),
      $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
      $13, $14, $15, $16, $17, $18, $19, $20, $21
    )
    RETURNING *
  `,
    [
      input.title,
      input.summary ?? null,
      input.status ?? "Draft",
      input.hypothesis_type ?? (input.target_company_id || input.ticker ? "company" : "global"),
      input.target_company_id ?? null,
      input.ticker ?? null,
      input.target_sector ?? null,
      input.growth_driver ?? null,
      JSON.stringify(input.required_evidence ?? []),
      JSON.stringify(input.risk_factors ?? []),
      JSON.stringify(input.missing_information ?? []),
      JSON.stringify(input.recommended_next_research ?? []),
      input.score_growth ?? null,
      input.score_evidence ?? null,
      input.score_contradiction ?? null,
      input.score_valuation_risk ?? null,
      input.score_overlooked ?? null,
      input.score_overall ?? null,
      input.final_decision ?? null,
      input.final_report ?? null,
      input.created_by_agent ?? "user"
    ]
  );
  return rows[0];
}

export async function updateHypothesisStatus(id: number, status: string): Promise<Hypothesis | undefined> {
  requireDatabase();
  const rows = await query<Hypothesis>(
    `
    UPDATE hypotheses
    SET status = $2, updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [id, status]
  );
  return rows[0];
}

export async function applyResearchResult(id: number, result: JsonRecord): Promise<Hypothesis | undefined> {
  requireDatabase();
  const scores = (result.scores ?? result.score ?? {}) as JsonRecord;
  const final = (result.final ?? result.final_judgement ?? result) as JsonRecord;
  const decision = (final.final_decision ?? final.decision ?? result.final_decision) as string | undefined;
  const report = (final.final_report ?? result.final_report ?? result.report_markdown) as string | undefined;

  const rows = await query<Hypothesis>(
    `
    UPDATE hypotheses
    SET final_decision = COALESCE($2, final_decision),
      final_report = COALESCE($3, final_report),
      score_growth = COALESCE($4, score_growth),
      score_evidence = COALESCE($5, score_evidence),
      score_contradiction = COALESCE($6, score_contradiction),
      score_valuation_risk = COALESCE($7, score_valuation_risk),
      score_overlooked = COALESCE($8, score_overlooked),
      score_overall = COALESCE($9, score_overall),
      status = CASE
        WHEN $2 = 'promising' THEN 'Promising'
        WHEN $2 = 'watchlist' THEN 'Watchlist'
        WHEN $2 = 'rejected' THEN 'Rejected'
        WHEN $2 = 'inconclusive' THEN 'Inconclusive'
        ELSE status
      END,
      updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [
      id,
      decision ?? null,
      report ?? null,
      scores.growth_impact ?? scores.score_growth ?? null,
      scores.evidence_strength ?? scores.score_evidence ?? null,
      scores.contradiction_risk ?? scores.score_contradiction ?? null,
      scores.valuation_risk ?? scores.score_valuation_risk ?? null,
      scores.overlooked_risk ?? scores.market_overlooked ?? null,
      scores.overall ?? scores.score_overall ?? null
    ]
  );
  return rows[0];
}

export async function saveAgentRun(input: Partial<AgentRun> & { output?: JsonRecord }): Promise<AgentRun> {
  requireDatabase();
  const rows = await query<AgentRun>(
    `
    INSERT INTO agent_runs (hypothesis_id, agent_name, input, output, next_action, next_agent)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
    RETURNING *
  `,
    [
      input.hypothesis_id ?? null,
      input.agent_name ?? "researcher",
      JSON.stringify(input.input ?? {}),
      JSON.stringify(input.output ?? {}),
      input.next_action ?? (input.output?.next_action as string | undefined) ?? null,
      input.next_agent ?? (input.output?.next_agent as string | undefined) ?? null
    ]
  );
  return rows[0];
}

export async function updateAgentRun(
  id: number | string,
  input: {
    input?: JsonRecord;
    output?: JsonRecord;
    next_action?: string | null;
    next_agent?: string | null;
  }
): Promise<AgentRun | undefined> {
  requireDatabase();
  const rows = await query<AgentRun>(
    `
    UPDATE agent_runs
    SET input = COALESCE($2::jsonb, input),
      output = COALESCE($3::jsonb, output),
      next_action = COALESCE($4, next_action),
      next_agent = $5
    WHERE id = $1
    RETURNING *
  `,
    [
      id,
      input.input ? JSON.stringify(input.input) : null,
      input.output ? JSON.stringify(input.output) : null,
      input.next_action ?? null,
      input.next_agent ?? null
    ]
  );
  return rows[0];
}

export async function listAgentRunsForHypothesis(hypothesisId: number, options: { afterId?: number } = {}): Promise<AgentRun[]> {
  requireDatabase();
  return query<AgentRun>(
    `
    SELECT *
    FROM agent_runs
    WHERE hypothesis_id = $1
      AND ($2::bigint IS NULL OR id > $2::bigint)
    ORDER BY created_at ASC, id ASC
  `,
    [hypothesisId, options.afterId ?? null]
  );
}

export async function deleteAgentRunsForHypothesis(hypothesisId: number): Promise<{ deleted: number }> {
  requireDatabase();
  const rows = await query<{ deleted: number }>(
    `
    WITH deleted AS (
      DELETE FROM agent_runs
      WHERE hypothesis_id = $1
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted
    FROM deleted
  `,
    [hypothesisId]
  );
  return rows[0] ?? { deleted: 0 };
}

export async function deleteHypothesis(id: number): Promise<{ deleted: number; agent_runs_deleted: number; document_links_deleted: number }> {
  requireDatabase();
  const rows = await query<{ deleted: number; agent_runs_deleted: number; document_links_deleted: number }>(
    `
    WITH deleted_agent_runs AS (
      DELETE FROM agent_runs
      WHERE hypothesis_id = $1
      RETURNING 1
    ),
    deleted_document_links AS (
      DELETE FROM hypothesis_documents
      WHERE hypothesis_id = $1
      RETURNING 1
    ),
    deleted_hypothesis AS (
      DELETE FROM hypotheses
      WHERE id = $1
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*) FROM deleted_hypothesis)::int AS deleted,
      (SELECT COUNT(*) FROM deleted_agent_runs)::int AS agent_runs_deleted,
      (SELECT COUNT(*) FROM deleted_document_links)::int AS document_links_deleted
  `,
    [id]
  );
  return rows[0] ?? { deleted: 0, agent_runs_deleted: 0, document_links_deleted: 0 };
}

export async function listEvents(ticker?: string): Promise<EventRecord[]> {
  requireDatabase();
  return query<EventRecord>(
    `
    SELECT e.*, c.ticker, c.name AS company_name
    FROM events e
    LEFT JOIN companies c ON c.id = e.company_id
    WHERE ($1::text IS NULL OR c.ticker = $1)
    ORDER BY e.published_at DESC NULLS LAST
    LIMIT 100
  `,
    [ticker ?? null]
  );
}

export async function upsertEvent(input: {
  ticker?: string;
  document_id?: number;
  sector?: string | null;
  event_type?: string | null;
  title?: string | null;
  summary?: string | null;
  sentiment?: string | null;
  impact_score?: number | null;
  impact_horizon?: string | null;
  published_at?: string | null;
}): Promise<EventRecord> {
  requireDatabase();
  const rows = await query<EventRecord>(
    `
    INSERT INTO events (
      company_id, document_id, sector, event_type, title, summary,
      sentiment, impact_score, impact_horizon, published_at
    )
    VALUES (
      (SELECT id FROM companies WHERE ticker = $1), $2, $3, $4, $5,
      $6, $7, $8, $9, $10
    )
    RETURNING *
  `,
    [
      input.ticker ?? null,
      input.document_id ?? null,
      input.sector ?? null,
      input.event_type ?? null,
      input.title ?? null,
      input.summary ?? null,
      input.sentiment ?? null,
      input.impact_score ?? null,
      input.impact_horizon ?? null,
      input.published_at ?? null
    ]
  );
  return rows[0];
}

export async function purgeSampleData(): Promise<{ deleted: number }> {
  requireDatabase();
  const rows = await query<{ deleted: number }>(`
    WITH deleted_agent_runs AS (
      DELETE FROM agent_runs
      WHERE input::text ILIKE '%seed%' OR input::text ILIKE '%fixture%'
      RETURNING 1
    ),
    deleted_hypothesis_documents AS (
      DELETE FROM hypothesis_documents
      WHERE hypothesis_id IN (
        SELECT id FROM hypotheses
        WHERE target_company_id IN (SELECT id FROM companies WHERE ticker IN ('1234', '2345', '3456'))
      )
      RETURNING 1
    ),
    deleted_hypotheses AS (
      DELETE FROM hypotheses
      WHERE target_company_id IN (SELECT id FROM companies WHERE ticker IN ('1234', '2345', '3456'))
        OR title ILIKE '%サンプル%'
      RETURNING 1
    ),
    deleted_events AS (
      DELETE FROM events
      WHERE company_id IN (SELECT id FROM companies WHERE ticker IN ('1234', '2345', '3456'))
        OR title ILIKE '%サンプル%'
        OR summary ILIKE '%サンプル%'
      RETURNING 1
    ),
    deleted_documents AS (
      DELETE FROM documents
      WHERE company_id IN (SELECT id FROM companies WHERE ticker IN ('1234', '2345', '3456'))
        OR url ILIKE '%example.com%'
        OR source_name ILIKE '%sample%'
      RETURNING 1
    ),
    deleted_prices AS (
      DELETE FROM price_daily
      WHERE company_id IN (SELECT id FROM companies WHERE ticker IN ('1234', '2345', '3456'))
      RETURNING 1
    ),
    deleted_metrics AS (
      DELETE FROM company_metrics
      WHERE company_id IN (SELECT id FROM companies WHERE ticker IN ('1234', '2345', '3456'))
      RETURNING 1
    ),
    deleted_companies AS (
      DELETE FROM companies
      WHERE ticker IN ('1234', '2345', '3456') OR description ILIKE '%サンプル企業%'
      RETURNING 1
    )
    SELECT (
      (SELECT count(*) FROM deleted_agent_runs)
      + (SELECT count(*) FROM deleted_hypothesis_documents)
      + (SELECT count(*) FROM deleted_hypotheses)
      + (SELECT count(*) FROM deleted_events)
      + (SELECT count(*) FROM deleted_documents)
      + (SELECT count(*) FROM deleted_prices)
      + (SELECT count(*) FROM deleted_metrics)
      + (SELECT count(*) FROM deleted_companies)
    )::int AS deleted
  `);
  return rows[0] ?? { deleted: 0 };
}
