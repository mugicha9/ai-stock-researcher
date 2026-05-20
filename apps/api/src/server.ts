import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import { z } from "zod";
import { config } from "./config.js";
import { checkDatabase, ensureDatabaseSchema } from "./db.js";
import {
  applyResearchResult,
  createDocument,
  createHypothesis,
  deleteAgentRunsForHypothesis,
  deleteHypothesis,
  getCompany,
  getDocument,
  getHypothesis,
  getOverview,
  getPrices,
  listAgentRunsForHypothesis,
  listMacroIndicators,
  listMacroNews,
  listCompanies,
  listDocuments,
  listEvents,
  listHypotheses,
  listSectorSnapshots,
  purgeSampleData,
  saveAgentRun,
  updateDocumentSummary,
  updateAgentRun,
  updateHypothesisStatus
} from "./repositories.js";
import { fetchCompanyFoundation, fetchListedMaster, jquants, normalizeTicker } from "./jquants.js";
import { fetchMacroData, getMacroSnapshot } from "./macro.js";
import { fetchAndCacheDocumentBodies, fetchAndSaveCompanyNews, fetchAndSaveMacroNews, newsSourceCatalog } from "./news.js";
import { ResearchError, researchHealth, researchPost } from "./researchClient.js";
import type { Company, DocumentRecord, Hypothesis, JsonRecord } from "./types.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined
});

const app = express();
let schemaReady = false;
let schemaError: string | null = null;

app.use(cors());
app.use((req, res, next) => {
  const requestId = req.header("x-request-id") || randomUUID();
  const startedAt = Date.now();
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  res.on("finish", () => {
    logger.info(
      {
        request_id: requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt
      },
      "api request completed"
    );
  });

  next();
});
app.use(express.json({ limit: "2mb" }));

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("Invalid id"), { status: 400 });
  }
  return id;
}

function currentRequestId(req: Request, res: Response): string {
  const requestId = res.locals.requestId;
  if (typeof requestId === "string" && requestId) return requestId;
  return req.header("x-request-id") ?? "";
}

function requestContext(req: Request, res: Response): { requestId: string; route: string } {
  const routePath = typeof req.route?.path === "string" ? req.route.path : req.path;
  return {
    requestId: currentRequestId(req, res),
    route: `${req.method} ${routePath}`
  };
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeDetails(details: unknown): unknown {
  return typeof details === "string" ? parseJsonString(details) : details;
}

function serializeError(error: unknown, depth = 0): JsonRecord {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown; cause?: unknown };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: withCode.code,
      cause: withCode.cause && depth < 3 ? serializeError(withCode.cause, depth + 1) : withCode.cause
    };
  }
  if (error && typeof error === "object") {
    return Object.fromEntries(Object.entries(error as Record<string, unknown>).slice(0, 20));
  }
  return { value: String(error) };
}

function hasTimeoutSignal(error: unknown, depth = 0): boolean {
  if (!error || depth > 3) return false;
  const record =
    error instanceof Error
      ? (error as Error & { code?: unknown; cause?: unknown })
      : typeof error === "object"
        ? (error as Record<string, unknown>)
        : null;
  if (!record) return /timeout|aborted/i.test(String(error));

  const name = String(record.name ?? "");
  const code = String(record.code ?? "");
  const message = String(record.message ?? "");
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "RESEARCH_RESPONSE_TIMEOUT" ||
    /timeout|aborted/i.test(message)
  ) {
    return true;
  }
  return hasTimeoutSignal(record.cause, depth + 1);
}

function statusFromError(error: unknown): number {
  if (hasTimeoutSignal(error)) return 504;
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : 500;
  return Number.isFinite(status) && status >= 400 ? status : 500;
}

function trimText(value: unknown, maxLength = 900): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function compactBodyExcerpt(document: DocumentRecord): string | null {
  const rawText = String(document.raw_text ?? "").trim();
  if (!rawText || rawText.startsWith("{") || rawText.startsWith("[")) return null;
  if (document.retrieval_status !== "full_text" && document.storage_level !== "full_text") return null;
  return trimText(rawText, 1_600);
}

function compactDocumentForResearch(document: DocumentRecord): JsonRecord {
  return {
    id: document.id,
    source_type: document.source_type,
    source_name: document.source_name,
    title: trimText(document.title, 220),
    url: document.url,
    published_at: document.published_at,
    storage_level: document.storage_level,
    retrieval_status: document.retrieval_status,
    event_type: document.event_type,
    sentiment: document.sentiment,
    importance_score: document.importance_score,
    summary_short: trimText(document.summary_short, 360),
    summary_investment: trimText(document.summary_investment, 600),
    summary_risk: trimText(document.summary_risk, 520),
    body_excerpt: compactBodyExcerpt(document),
    key_points: Array.isArray(document.key_points) ? document.key_points.slice(0, 6) : []
  };
}

function compactEventForResearch(event: JsonRecord): JsonRecord {
  return {
    id: event.id,
    ticker: event.ticker,
    company_name: event.company_name,
    sector: event.sector,
    event_type: event.event_type,
    title: trimText(event.title, 220),
    summary: trimText(event.summary, 520),
    sentiment: event.sentiment,
    impact_score: event.impact_score,
    impact_horizon: event.impact_horizon,
    published_at: event.published_at
  };
}

function dedupeDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  const seen = new Set<string>();
  return documents.filter((document) => {
    const key = document.url || String(document.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function globalSearchTerm(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.length > 24) return undefined;
  if (/[?？]/.test(text) || /全体|有望|どんな|セクター|分野|市場/.test(text)) return undefined;
  return text;
}

function compactHypothesisForResearch(hypothesis: JsonRecord): JsonRecord {
  return {
    id: hypothesis.id,
    hypothesis_type: hypothesis.hypothesis_type,
    title: trimText(hypothesis.title, 180),
    summary: trimText(hypothesis.summary, 360),
    status: hypothesis.status,
    growth_driver: trimText(hypothesis.growth_driver, 240),
    final_decision: hypothesis.final_decision,
    score_overall: hypothesis.score_overall
  };
}

function compactAgentMemoryForDiscovery(hypothesis: JsonRecord): JsonRecord {
  const runs = Array.isArray(hypothesis.agent_runs) ? hypothesis.agent_runs : [];
  return {
    hypothesis_id: hypothesis.id,
    hypothesis_title: trimText(hypothesis.title, 180),
    hypothesis_type: hypothesis.hypothesis_type,
    target_sector: hypothesis.target_sector,
    ticker: hypothesis.ticker,
    recent_runs: runs.slice(0, 3).map((run) => {
      const record = asJsonRecord(run);
      const output = asJsonRecord(record.output);
      return {
        agent_name: record.agent_name ?? output.agent_name,
        next_action: record.next_action ?? output.next_action,
        next_agent: record.next_agent ?? output.next_agent,
        created_at: record.created_at,
        output: loopOutputExcerpt({ ...output, agent_name: output.agent_name ?? record.agent_name })
      };
    })
  };
}

function compactCompanyForDiscovery(company: Company): JsonRecord {
  const metrics = asJsonRecord(company.latest_metrics);
  return {
    ticker: company.ticker,
    name: company.name,
    market: company.market,
    sector: company.sector,
    industry: company.industry,
    business_summary: trimText(company.business_summary ?? company.description, 420),
    market_cap: company.market_cap,
    latest_metrics: {
      revenue_growth: metrics.revenue_growth,
      operating_profit_growth: metrics.operating_profit_growth,
      operating_margin: metrics.operating_margin,
      roe: metrics.roe,
      roic: metrics.roic,
      equity_ratio: metrics.equity_ratio,
      per: metrics.per,
      pbr: metrics.pbr,
      psr: metrics.psr,
      date: metrics.date
    }
  };
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function textArray(value: unknown, limit = 8): string[] {
  if (typeof value === "string") {
    const text = trimText(value, 320);
    return text ? [text] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => trimText(item, 320))
    .filter((item): item is string => Boolean(item));
}

function normalizeOptionalTicker(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ticker = normalizeTicker(value);
  return ticker ? ticker : undefined;
}

function discoveryNewsQuery(input: { focus?: string; sector?: string }): string {
  const seed = [input.sector, input.focus]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .join(" ");
  const cleaned = seed
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s・ー一-龯ぁ-んァ-ン]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned && cleaned.length <= 120 && !/全体からみて|どんなセクター|有望/.test(cleaned)) return cleaned;
  return process.env.DISCOVERY_NEWS_QUERY ?? "日本 産業政策 設備投資 人手不足 半導体 防衛 エネルギー 医療 DX 自動化 上方修正";
}

function companyDiscoveryScore(company: Company, focus?: string, sector?: string): number {
  const metrics = asJsonRecord(company.latest_metrics);
  const text = `${company.sector ?? ""} ${company.industry ?? ""} ${company.name ?? ""} ${company.business_summary ?? ""}`.toLowerCase();
  const focusTerms = [focus, sector].map((item) => item?.trim().toLowerCase()).filter((item): item is string => Boolean(item));
  const focusBoost = focusTerms.some((term) => text.includes(term)) ? 40 : 0;
  return (
    focusBoost +
    (numberValue(metrics.operating_profit_growth) ?? 0) * 1.2 +
    (numberValue(metrics.revenue_growth) ?? 0) +
    (numberValue(metrics.roe) ?? 0) * 0.25 +
    (numberValue(metrics.operating_margin) ?? 0) * 0.15 -
    Math.max(0, Math.log10(Math.max(1, numberValue(company.market_cap) ?? 1)) - 10) * 2
  );
}

function discoveryContextSummary(payload: JsonRecord): JsonRecord {
  const context = asJsonRecord(payload.context);
  return {
    focus: payload.focus,
    sector: payload.sector,
    documents_sent: Array.isArray(payload.documents) ? payload.documents.length : 0,
    companies_sent: Array.isArray(payload.companies) ? payload.companies.length : 0,
    existing_hypotheses_sent: Array.isArray(payload.existing_hypotheses) ? payload.existing_hypotheses.length : 0,
    agent_memory_sent: Array.isArray(payload.agent_memory) ? payload.agent_memory.length : 0,
    macro_indicators_sent: Array.isArray(context.macro_indicators) ? context.macro_indicators.length : 0,
    sector_snapshots_sent: Array.isArray(context.sector_snapshots) ? context.sector_snapshots.length : 0,
    recent_events_sent: Array.isArray(context.recent_events) ? context.recent_events.length : 0
  };
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

type LlmAgentName = "hypothesis" | "skeptic" | "researcher";
type AgentName = LlmAgentName | "collector";

const HYPOTHESIS_LOOP_INSTRUCTION =
  "仮説検証、反証、深堀り・リサーチ、データ収集の工程がnext_agentで互いに呼び出しあいます。各工程はrouting_contextを見て、次に呼ぶべき工程を自律的に指定してください。データ不足ならnext_action=request_dataでcollectorを指定できます。collectorは不足情報に応じて、政策・公的統計・信頼ニュース本文・セクター代表企業の決算/株価/ニュースを追加取得します。finalizeできるのはresearcherだけですが、根拠と反証が不足している場合はfinalizeせず次工程を指定してください。";
const HYPOTHESIS_FINALIZE_INSTRUCTION =
  "ここまでの仮説検証・反証を統合してください。根拠と反証が結論に十分ならresearcherとしてfinal_decisionとfinal_reportを出し、不足が結論を左右する場合はfinalizeせず次工程を指定してください。";

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function safeLoopAgentName(value: unknown, fallback: AgentName = "researcher"): AgentName {
  if (value === "hypothesis" || value === "skeptic" || value === "researcher" || value === "collector") return value;
  return fallback;
}

function parseLoopAgentName(value: unknown): AgentName | null {
  if (value === "hypothesis" || value === "skeptic" || value === "researcher" || value === "collector") return value;
  return null;
}

function defaultLoopNextAgent(agentName: AgentName): AgentName {
  if (agentName === "hypothesis") return "skeptic";
  if (agentName === "skeptic") return "researcher";
  if (agentName === "collector") return "skeptic";
  return "hypothesis";
}

function loopPhase(agentName: AgentName): string {
  if (agentName === "hypothesis") return "仮説検証";
  if (agentName === "skeptic") return "反証";
  if (agentName === "collector") return "データ収集";
  return "深堀り・リサーチ";
}

function hypothesisLoopSafetyMaxTurns(): number {
  const configured = Number.isFinite(config.hypothesisLoopSafetyMaxTurns) ? config.hypothesisLoopSafetyMaxTurns : 12;
  return Math.max(1, Math.min(Math.floor(configured), 30));
}

function summarizeLoopInput(agentName: AgentName, payload: JsonRecord): JsonRecord {
  const hypothesis = asJsonRecord(payload.hypothesis);
  const company = asJsonRecord(payload.company);
  const context = asJsonRecord(payload.context);
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const prices = Array.isArray(payload.prices) ? payload.prices : [];
  const loopHistory = Array.isArray(payload.loop_history) ? payload.loop_history : [];
  const macroIndicators = Array.isArray(context.macro_indicators) ? context.macro_indicators : [];
  const sectorSnapshots = Array.isArray(context.sector_snapshots) ? context.sector_snapshots : [];
  const recentEvents = Array.isArray(context.recent_events) ? context.recent_events : [];
  return {
    agent_name: agentName,
    hypothesis_type: payload.hypothesis_type ?? hypothesis.hypothesis_type,
    hypothesis_title: trimText(hypothesis.title, 180),
    company: trimText(company.name ?? company.ticker, 160),
    sector: trimText(hypothesis.target_sector ?? company.sector, 120),
    documents: documents.length,
    prices: prices.length,
    macro_indicators: macroIndicators.length,
    sector_snapshots: sectorSnapshots.length,
    recent_events: recentEvents.length,
    history_turns: loopHistory.length,
    loop_turn: payload.loop_turn,
    turn_timeout_ms: payload.turn_timeout_ms,
    llm_thinking_mode: payload.llm_thinking_mode
  };
}

function compactTextList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => trimText(item, 260))
    .filter((item): item is string => Boolean(item));
}

function compactRecordList(value: unknown, limit: number, fields: string[]): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => {
      const record = asJsonRecord(item);
      return fields.reduce<JsonRecord>((acc, field) => {
        if (record[field] !== undefined && record[field] !== null) acc[field] = record[field];
        return acc;
      }, {});
    })
    .filter((item) => Object.keys(item).length > 0);
}

function loopOutputExcerpt(output: JsonRecord): JsonRecord {
  return {
    agent_name: output.agent_name,
    next_action: output.next_action,
    next_agent: output.next_agent,
    should_continue: output.should_continue,
    final_decision: output.final_decision,
    reason: trimText(output.reason ?? output.reason_for_next_action, 400),
    claims: compactRecordList(output.claims, 5, ["claim", "evidence_ids", "confidence"]),
    questions: compactRecordList(output.questions, 5, ["question", "priority", "target_agent"]),
    missing_information: compactTextList(output.missing_information, 6),
    recommended_next_research: compactTextList(output.recommended_next_research, 6),
    scores: Object.keys(asJsonRecord(output.scores)).length ? asJsonRecord(output.scores) : undefined,
    final_report: trimText(output.final_report, 600),
    llm_parse_failed: Boolean(output.llm_parse_failed || output.llm_parse_warning || output.raw_model_output || output.llm_fallback)
  };
}

function buildAgentHandoff(agentName: AgentName, agentRuns: JsonRecord[]): JsonRecord {
  const loopHistory = agentRuns.map(loopOutputExcerpt);
  const previous = loopHistory.at(-1) ?? null;
  return {
    to_agent: agentName,
    from_agent: previous?.agent_name ?? null,
    previous_output: previous,
    loop_history: loopHistory,
    instruction: previous
      ? "前工程のclaims/questions/missing_information/recommended_next_researchを引き継ぎ、重複を避けて次の工程を実行する。"
      : "初回ターンのため前工程出力はありません。"
  };
}

function buildTurnInputLog(agentName: AgentName, payload: JsonRecord): JsonRecord {
  const summary = summarizeLoopInput(agentName, payload);
  const handoff = asJsonRecord(payload.agent_handoff);
  return {
    ...summary,
    handoff_from: handoff.from_agent ?? null,
    previous_output: handoff.previous_output ?? null,
    loop_history: Array.isArray(handoff.loop_history) ? handoff.loop_history : [],
    routing_context: payload.routing_context
  };
}

function appendTextParts(target: string[], value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    target.push(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 8).forEach((item) => appendTextParts(target, item));
    return;
  }
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    appendTextParts(target, record.question ?? record.claim ?? record.title ?? record.summary);
  }
}

function collectorTextCorpus(basePayload: JsonRecord, previousOutput: JsonRecord | null): string {
  const hypothesis = asJsonRecord(basePayload.hypothesis);
  const context = asJsonRecord(basePayload.context);
  const parts: string[] = [];
  appendTextParts(parts, context.effective_search ?? context.requested_sector);
  appendTextParts(parts, hypothesis.target_sector);
  appendTextParts(parts, hypothesis.title);
  appendTextParts(parts, hypothesis.summary);
  appendTextParts(parts, hypothesis.growth_driver);
  appendTextParts(parts, hypothesis.required_evidence);
  appendTextParts(parts, hypothesis.risk_factors);
  appendTextParts(parts, previousOutput?.missing_information);
  appendTextParts(parts, previousOutput?.recommended_next_research);
  appendTextParts(parts, previousOutput?.questions);
  appendTextParts(parts, previousOutput?.claims);
  appendTextParts(parts, previousOutput?.reason);
  appendTextParts(parts, previousOutput?.reason_for_next_action);
  appendTextParts(parts, previousOutput?.final_report);
  return parts.join(" ");
}

function normalizeCollectorText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s・ー一-龯ぁ-んァ-ン]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectorQuery(basePayload: JsonRecord, previousOutput: JsonRecord | null): string {
  const parts = collectorTextCorpus(basePayload, previousOutput).split(/\s+/);
  const normalized = parts
    .map((part) =>
      normalizeCollectorText(part)
    )
    .filter((part) => part && !/全体からみて|どんなセクター|有望/.test(part))
    .join(" ")
    .trim();
  if (!normalized) return "Japan";
  return normalized.length > 120 ? normalized.slice(0, 120) : normalized;
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function uniqueLimited(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized.length > 180 ? normalized.slice(0, 180) : normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function collectorMaxThematicQueries(): number {
  const configured = Number(process.env.COLLECTOR_MAX_THEMATIC_QUERIES ?? 4);
  return Math.max(1, Math.min(Number.isFinite(configured) ? Math.floor(configured) : 4, 8));
}

function collectorGlobalCompanyLimit(): number {
  const configured = Number(process.env.COLLECTOR_GLOBAL_COMPANY_LIMIT ?? 4);
  return Math.max(0, Math.min(Number.isFinite(configured) ? Math.floor(configured) : 4, 10));
}

function collectorBodyFetchLimit(): number {
  const configured = Number(process.env.COLLECTOR_BODY_FETCH_LIMIT ?? 12);
  return Math.max(0, Math.min(Number.isFinite(configured) ? Math.floor(configured) : 12, 40));
}

function collectorBodyMaxChars(): number {
  const configured = Number(process.env.COLLECTOR_BODY_MAX_CHARS ?? 40_000);
  return Math.max(4_000, Math.min(Number.isFinite(configured) ? Math.floor(configured) : 40_000, 120_000));
}

function documentPriorityForBodyFetch(document: DocumentRecord): number {
  const keyPoints = Array.isArray(document.key_points) ? document.key_points.map((item) => String(item).toLowerCase()) : [];
  const sourceGroupScore = keyPoints.includes("official") ? 60 : keyPoints.includes("trusted_news") ? 45 : keyPoints.includes("archive") ? 18 : 28;
  const statusScore = document.retrieval_status === "full_text" ? -100 : 0;
  const importance = Number(document.importance_score ?? 0);
  const published = document.published_at ? Date.parse(document.published_at) : 0;
  const recencyScore = Number.isFinite(published) ? Math.max(0, Math.min(20, (published - Date.now() + 540 * 24 * 60 * 60 * 1000) / (27 * 24 * 60 * 60 * 1000))) : 0;
  return sourceGroupScore + statusScore + importance * 20 + recencyScore;
}

function collectorBodySearchTerms(topicText: string): string[] {
  const text = topicText.toLowerCase();
  const terms = new Set<string>();
  if (includesAny(text, ["ナフサ", "naphtha", "石油化学", "エチレン", "原料"])) {
    ["ナフサ", "naphtha", "石油化学", "エチレン", "化学", "原料", "価格転嫁"].forEach((term) => terms.add(term));
  }
  if (includesAny(text, ["イラン", "中東", "原油", "地政学", "ホルムズ"])) {
    ["イラン", "中東", "原油", "ホルムズ", "地政学", "物流", "燃料"].forEach((term) => terms.add(term));
  }
  if (includesAny(text, ["政府答弁", "国会", "答弁", "経済産業省", "meti", "資源エネルギー庁", "政策"])) {
    ["政府答弁", "国会", "答弁", "経済産業省", "METI", "資源エネルギー庁", "政策"].forEach((term) => terms.add(term));
  }
  if (includesAny(text, ["決算", "営業利益", "利益率", "財務", "企業開示", "適時開示"])) {
    ["決算", "営業利益", "利益率", "企業開示", "適時開示", "業績"].forEach((term) => terms.add(term));
  }
  const stopWords = new Set(["global", "company", "metadata", "only", "collector", "finalize", "request", "data", "必要", "不足", "取得", "現在", "詳細", "根拠", "情報", "影響", "企業", "日本"]);
  normalizeCollectorText(topicText)
    .split(/\s+/)
    .filter((term) => term.length >= 2 && term.length <= 24 && !stopWords.has(term.toLowerCase()) && !/^\d+$/.test(term))
    .slice(0, 40)
    .forEach((term) => terms.add(term));
  return [...terms].slice(0, 24);
}

function documentTextForBodyScoring(document: DocumentRecord): string {
  const keyPoints = Array.isArray(document.key_points) ? document.key_points.map((item) => String(item)).join(" ") : "";
  return normalizeCollectorText(
    [
      document.title,
      document.summary_short,
      document.summary_investment,
      document.summary_risk,
      document.source_name,
      document.url,
      keyPoints
    ].join(" ")
  ).toLowerCase();
}

function documentRelevanceForBodyFetch(document: DocumentRecord, terms: string[]): number {
  const haystack = documentTextForBodyScoring(document);
  if (!haystack) return 0;
  return terms.reduce((score, term) => {
    const normalized = normalizeCollectorText(term).toLowerCase();
    if (!normalized) return score;
    const title = normalizeCollectorText(String(document.title ?? "")).toLowerCase();
    const exact = haystack.includes(normalized) ? 1 : 0;
    const titleHit = title.includes(normalized) ? 2 : 0;
    return score + exact + titleHit;
  }, 0);
}

function documentForBodyFetchFromPayload(value: unknown): DocumentRecord | null {
  const record = asJsonRecord(value);
  const id = Number(record.id);
  const title = trimText(record.title, 260);
  const url = typeof record.url === "string" ? record.url : null;
  if (!Number.isInteger(id) || !title || !url) return null;
  return {
    id,
    title,
    url,
    source_type: typeof record.source_type === "string" ? record.source_type : "news",
    source_name: typeof record.source_name === "string" ? record.source_name : null,
    published_at: typeof record.published_at === "string" ? record.published_at : null,
    storage_level: typeof record.storage_level === "string" ? record.storage_level : null,
    retrieval_status: typeof record.retrieval_status === "string" ? record.retrieval_status : null,
    raw_text: typeof record.body_excerpt === "string" ? record.body_excerpt : null,
    summary_short: typeof record.summary_short === "string" ? record.summary_short : null,
    summary_investment: typeof record.summary_investment === "string" ? record.summary_investment : null,
    summary_risk: typeof record.summary_risk === "string" ? record.summary_risk : null,
    key_points: Array.isArray(record.key_points) ? (record.key_points as string[]) : []
  };
}

function payloadDocumentsForBodyFetch(payload: JsonRecord): DocumentRecord[] {
  if (!Array.isArray(payload.documents)) return [];
  return payload.documents.map(documentForBodyFetchFromPayload).filter((document): document is DocumentRecord => Boolean(document));
}

function prioritizeBodyFetchDocuments(documents: DocumentRecord[], topicText = ""): DocumentRecord[] {
  const terms = collectorBodySearchTerms(topicText);
  const scored = dedupeDocuments(documents)
    .map((document) => ({
      document,
      relevance: documentRelevanceForBodyFetch(document, terms),
      priority: documentPriorityForBodyFetch(document)
    }))
    .filter((item) => (terms.length ? item.relevance > 0 : true))
    .sort((a, b) => b.relevance * 1000 + b.priority - (a.relevance * 1000 + a.priority));
  return scored.map((item) => item.document);
}

function bodyFetchPreview(documents: DocumentRecord[], topicText: string): JsonRecord[] {
  const terms = collectorBodySearchTerms(topicText);
  return documents.slice(0, 12).map((document) => ({
    id: document.id,
    title: trimText(document.title, 140),
    source_name: document.source_name,
    retrieval_status: document.retrieval_status,
    relevance: documentRelevanceForBodyFetch(document, terms)
  }));
}

function compactNewsFetchResult(result: JsonRecord): JsonRecord {
  const documents = Array.isArray(result.documents) ? result.documents.map(asJsonRecord) : [];
  return {
    ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "documents")),
    documents_saved: documents.length,
    documents_preview: documents.slice(0, 12).map((document) => ({
      id: document.id,
      title: trimText(document.title, 140),
      source_name: document.source_name,
      published_at: document.published_at,
      retrieval_status: document.retrieval_status
    }))
  };
}

function collectorDataRequirements(topicText: string): string[] {
  const text = topicText.toLowerCase();
  const requirements = new Set<string>();
  if (includesAny(text, ["ナフサ", "naphtha", "石油化学", "エチレン", "原料"])) {
    requirements.add("ナフサ価格、需給、輸入、在庫、エチレン/石油化学関連統計");
    requirements.add("原材料費上昇と価格転嫁が化学企業の営業利益率へ与える影響");
  }
  if (includesAny(text, ["政府答弁", "国会", "答弁", "経済産業省", "meti", "資源エネルギー庁", "政策"])) {
    requirements.add("政府答弁、国会会議録、経済産業省・資源エネルギー庁の一次情報");
  }
  if (includesAny(text, ["財務", "営業利益", "利益率", "収益構造", "決算", "価格転嫁", "業績"])) {
    requirements.add("代表企業の決算、業績予想、営業利益率、原材料費影響の開示");
  }
  if (includesAny(text, ["金利", "為替", "円安", "原油", "中東", "地政学"])) {
    requirements.add("原油、為替、金利、地政学リスクの伝播経路");
  }
  if (!requirements.size) {
    requirements.add("仮説に関連する一次情報、業界統計、代表企業の財務データ、反証材料");
  }
  return [...requirements];
}

function collectorThematicQueries(baseQuery: string, topicText: string): Array<{ query: string; reason: string }> {
  const text = topicText.toLowerCase();
  const queries: Array<{ query: string; reason: string }> = [];
  if (baseQuery && baseQuery !== "Japan") {
    queries.push({ query: baseQuery, reason: "仮説本文と不足情報から作成した基礎検索" });
  }
  if (includesAny(text, ["ナフサ", "naphtha", "石油化学", "エチレン"])) {
    queries.push(
      { query: "ナフサ 供給 制約 価格 石油化学 エチレン 日本", reason: "ナフサ需給と石油化学バリューチェーンの確認" },
      { query: "ナフサ 価格転嫁 化学 セクター 営業利益 原材料費", reason: "化学企業の収益構造と原材料費影響の確認" },
      { query: "naphtha Japan petrochemical supply ethylene margin", reason: "海外ソースを含むナフサ供給制約の確認" }
    );
  }
  if (includesAny(text, ["政府答弁", "国会", "答弁", "経済産業省", "meti", "資源エネルギー庁", "政策"])) {
    queries.push(
      { query: "ナフサ 政府答弁 国会 経済産業省 資源エネルギー庁", reason: "政策・政府答弁の一次情報に近い論点確認" },
      { query: "石油化学 ナフサ 経済産業省 統計 政策", reason: "経済産業省統計・産業政策文脈の確認" }
    );
  }
  if (includesAny(text, ["化学", "素材", "石油", "原料", "収益構造", "価格転嫁"])) {
    queries.push(
      { query: "化学工業 統計 出荷 在庫 生産 経済産業省 ナフサ", reason: "化学工業の生産・在庫・出荷統計の確認" },
      { query: "化学 セクター 決算 原材料費 価格転嫁 営業利益率", reason: "代表企業の決算・価格転嫁論点の確認" }
    );
  }
  if (includesAny(text, ["金利", "為替", "円安", "原油", "中東", "地政学"])) {
    queries.push({ query: "中東 原油 ナフサ 日本 化学 セクター 為替 金利", reason: "マクロ・地政学リスクの伝播経路確認" });
  }
  return uniqueLimited(queries.map((item) => `${item.query}||${item.reason}`), collectorMaxThematicQueries()).map((item) => {
    const [query, reason] = item.split("||");
    return { query, reason };
  });
}

function collectorSectorTerms(topicText: string, sector?: string): string[] {
  const text = topicText.toLowerCase();
  const terms = new Set<string>();
  if (sector) terms.add(sector);
  if (includesAny(text, ["化学", "ナフサ", "naphtha", "石油化学", "エチレン", "原料"])) {
    ["化学", "素材", "石油", "石炭", "石油化学"].forEach((term) => terms.add(term));
  }
  if (includesAny(text, ["半導体", "電子材料"])) {
    ["半導体", "電気機器", "電子材料", "精密"].forEach((term) => terms.add(term));
  }
  if (includesAny(text, ["防衛", "安全保障"])) {
    ["機械", "電気機器", "輸送用機器", "防衛"].forEach((term) => terms.add(term));
  }
  return [...terms].map((term) => term.trim()).filter(Boolean);
}

function companyTopicScore(company: Company, topicText: string, sector?: string): number {
  const terms = collectorSectorTerms(topicText, sector);
  const haystack = `${company.sector ?? ""} ${company.industry ?? ""} ${company.name ?? ""} ${company.english_name ?? ""} ${company.business_summary ?? ""}`.toLowerCase();
  const metrics = asJsonRecord(company.latest_metrics);
  const termScore = terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 25 : 0), 0);
  return (
    termScore +
    (numberValue(metrics.operating_profit_growth) ?? 0) * 0.6 +
    (numberValue(metrics.revenue_growth) ?? 0) * 0.35 +
    (numberValue(metrics.operating_margin) ?? 0) * 0.2 +
    Math.min(10, Math.log10(Math.max(1, numberValue(company.market_cap) ?? 1)))
  );
}

async function collectSectorCompanyFoundation(params: {
  topicText: string;
  sector?: string;
  since: string;
  lookbackDays: number;
  documentLimit: number;
}): Promise<{ selectedCompanies: Company[]; documents: DocumentRecord[]; operations: JsonRecord[]; errors: string[] }> {
  const limit = collectorGlobalCompanyLimit();
  if (limit <= 0) return { selectedCompanies: [], documents: [], operations: [], errors: [] };

  const companies = await listCompanies(2000);
  const selectedCompanies = companies
    .map((company) => ({ company, score: companyTopicScore(company, params.topicText, params.sector) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.company);
  const operations: JsonRecord[] = [];
  const errors: string[] = [];
  const documents: DocumentRecord[] = [];

  for (const company of selectedCompanies) {
    try {
      const result = await fetchCompanyFoundation(company.ticker, {
        includePrices: true,
        includeStatements: true,
        includeNews: true,
        newsLookbackDays: params.lookbackDays,
        newsLimit: Math.min(120, Math.max(40, params.documentLimit))
      });
      operations.push({ operation: "fetch_sector_company_foundation", ticker: company.ticker, name: company.name, sector: company.sector, result });
    } catch (error) {
      errors.push(`fetch_sector_company_foundation(${company.ticker}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const documentGroups = await Promise.all(
    selectedCompanies.map((company) => listDocuments({ ticker: company.ticker, limit: 40, since: params.since }).catch(() => []))
  );
  documents.push(...documentGroups.flat());
  if (selectedCompanies.length) {
    operations.push({
      operation: "reload_sector_company_documents",
      tickers: selectedCompanies.map((company) => company.ticker),
      documents: documents.length
    });
  }
  return { selectedCompanies, documents, operations, errors };
}

function mergeCompactDocuments(existing: unknown, documents: DocumentRecord[], limit: number): JsonRecord[] {
  const merged: JsonRecord[] = [];
  const seen = new Set<string>();
  const push = (document: unknown) => {
    const record = asJsonRecord(document);
    const key = String(record.url ?? record.id ?? `${record.source_name ?? ""}:${record.title ?? ""}`);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(record);
  };
  if (Array.isArray(existing)) existing.forEach(push);
  documents.forEach((document) => {
    const record = asJsonRecord(document);
    if ("body_excerpt" in record && !("raw_text" in record)) {
      push(record);
      return;
    }
    push(compactDocumentForResearch(document));
  });
  return merged.slice(0, limit);
}

async function reloadGlobalResearchContext(options: {
  search?: string;
  sector?: string;
  since: string;
  documentLimit: number;
}): Promise<{ documents: JsonRecord[]; context: JsonRecord }> {
  const [targetedDocuments, broadDocuments, macroIndicators, macroNews, sectorSnapshots, events] = await Promise.all([
    listDocuments({ sourceType: "news", sector: options.search, search: options.search, limit: 160, since: options.since }),
    listDocuments({ limit: 220, since: options.since }),
    listMacroIndicators(16),
    listMacroNews(100),
    listSectorSnapshots(24),
    listEvents()
  ]);
  const documents = dedupeDocuments([...(targetedDocuments.length ? targetedDocuments : []), ...macroNews, ...broadDocuments]).slice(0, options.documentLimit);
  return {
    documents: documents.map(compactDocumentForResearch),
    context: {
      mode: "global_sector_research",
      requested_sector: options.sector ?? null,
      effective_search: options.search ?? null,
      macro_indicators: macroIndicators,
      sector_snapshots: sectorSnapshots,
      recent_events: events.slice(0, 60).map((event) => compactEventForResearch(event as JsonRecord)),
      data_warnings: [
        documents.length ? null : "documents_empty",
        macroIndicators.length ? null : "macro_indicators_empty",
        sectorSnapshots.length ? null : "sector_snapshots_empty"
      ].filter(Boolean)
    }
  };
}

function normalizedNextAction(output: JsonRecord): string {
  return String(output.next_action ?? "").trim().toLowerCase();
}

function researcherHasFinalized(agentName: AgentName, output: JsonRecord): boolean {
  if (agentName !== "researcher") return false;
  if (hasLlmParseFailure(output)) return false;
  const nextAction = normalizedNextAction(output);
  return nextAction === "finalize" || nextAction === "stop" || output.should_continue === false;
}

function outputTextForRouting(output: JsonRecord): string {
  return normalizeCollectorText(
    [
      output.reason,
      output.reason_for_next_action,
      output.final_report,
      output.missing_information,
      output.recommended_next_research,
      output.questions
    ]
      .map((value) => {
        if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" ");
        if (value && typeof value === "object") return JSON.stringify(value);
        return String(value ?? "");
      })
      .join(" ")
  ).toLowerCase();
}

function shouldRerouteResearcherToCollector(agentName: AgentName, output: JsonRecord, agentRuns: JsonRecord[]): boolean {
  if (!researcherHasFinalized(agentName, output)) return false;
  const collectorRuns = agentRuns.filter((run) => run.agent_name === "collector").length;
  if (collectorRuns >= 3) return false;
  const text = outputTextForRouting(output);
  const missingCount = Array.isArray(output.missing_information) ? output.missing_information.length : 0;
  const researchCount = Array.isArray(output.recommended_next_research) ? output.recommended_next_research.length : 0;
  const explicitCollectorNeed = /collector|データ取得|取得が必須|追加取得|一次情報|財務データ|業界統計|政府答弁|国会|公的統計|開示|不足/.test(text);
  const conclusionBlocks = /結論を左右しない|十分な根拠|主要な根拠と主要な反証が揃/.test(text);
  return explicitCollectorNeed && !conclusionBlocks && (missingCount > 0 || researchCount > 0 || /不足|必須/.test(text));
}

function hasLlmParseFailure(output: JsonRecord): boolean {
  return Boolean(output.llm_parse_failed || output.llm_parse_warning || output.raw_model_output || output.llm_fallback);
}

function selectNextAgent(agentName: AgentName, output: JsonRecord): AgentName {
  const nextAction = normalizedNextAction(output);
  const requested = parseLoopAgentName(output.next_agent);
  if (requested) return requested;
  if (nextAction === "request_data") return "collector";
  if (nextAction === "finalize" || nextAction === "stop") return "researcher";
  return defaultLoopNextAgent(agentName);
}

function loopSummary(output: JsonRecord): string | undefined {
  return trimText(output.reason ?? output.reason_for_next_action ?? output.final_report, 500) ?? undefined;
}

function routingContext(agentName: AgentName, agentRuns: JsonRecord[]): JsonRecord {
  const historyAgents = new Set(agentRuns.map((run) => run.agent_name));
  return {
    current_agent: agentName,
    history_state: {
      has_hypothesis: historyAgents.has("hypothesis"),
      has_skeptic: historyAgents.has("skeptic"),
      has_researcher: historyAgents.has("researcher"),
      has_collector: historyAgents.has("collector"),
      turns: agentRuns.length
    },
    recent_agents: agentRuns.slice(-6).map((run) => ({
      agent_name: run.agent_name,
      next_action: run.next_action,
      next_agent: run.next_agent,
      reason: trimText(run.reason ?? run.reason_for_next_action, 240)
    })),
    available_agents: [
      {
        name: "hypothesis",
        role: "仮説を検証可能な主張へ分解し、次に検証すべき観点を決める"
      },
      {
        name: "skeptic",
        role: "反証、織り込み済み、競争、収益性、時間軸、データの弱さを検証する"
      },
      {
        name: "researcher",
        role: "根拠と反証を統合し、十分なら最終判断。不足なら取得すべきデータを定義する"
      },
      {
        name: "collector",
        role: "外部データ取得・DB再読込を行う非LLM工程。政策・公的統計・信頼ニュース・ニュース本文・セクター代表企業の決算/株価/ニュースを追加取得する"
      }
    ],
    routing_guidance: [
      "next_agentはAPIではなく各エージェントが指定する",
      "同じエージェントを続けて呼ぶのは、新しい入力や明確な追加作業がある場合に限る",
      "データ不足で判断できない場合はcollectorを呼ぶ",
      "collectorで取得したデータは、反証または統合のどちらに渡すべきかを次工程で判断する",
      "ニュースがタイトル/URLだけで本文根拠が不足する場合はcollectorで本文取得を要求する",
      "finalizeはresearcherのみが使う",
      "researcherでも、主要な根拠と主要な反証が不足している場合はfinalizeせず次工程を指定する",
      "final_report内でCollector必須、一次情報不足、財務データ不足と述べる場合はfinalizeせずrequest_dataを指定する",
      "LLMのJSON整形失敗やraw出力回収は最終判断として扱わない"
    ],
    finalization_checklist: [
      "仮説の主張が検証可能な粒度に分解されている",
      "支持根拠と反証の両方が明示されている",
      "追加取得すべき高優先度データが結論を左右しない",
      "最終レポートが不足情報の列挙だけで終わっていない"
    ]
  };
}

async function runCollectorTurn(params: {
  basePayload: JsonRecord;
  previousOutput: JsonRecord | null;
  hypothesisType: string;
  ticker: string | null;
  sector?: string;
  since: string;
  lookbackDays: number;
  documentLimit: number;
  priceLimit: number;
}): Promise<{ output: JsonRecord; payload: JsonRecord }> {
  const startedAt = Date.now();
  const topicText = normalizeCollectorText(collectorTextCorpus(params.basePayload, params.previousOutput));
  const query = collectorQuery(params.basePayload, params.previousOutput);
  const dataRequirements = collectorDataRequirements(topicText);
  const thematicQueries = collectorThematicQueries(query, topicText);
  const errors: string[] = [];
  const operations: JsonRecord[] = [];
  const collectedNewsDocuments: DocumentRecord[] = [];
  const nextPayload: JsonRecord = { ...params.basePayload };

  if (params.hypothesisType === "company" && params.ticker) {
    try {
      const result = await fetchCompanyFoundation(params.ticker, {
        includePrices: true,
        includeStatements: true,
        includeNews: true,
        newsLookbackDays: params.lookbackDays,
        newsLimit: Math.min(300, Math.max(80, params.documentLimit * 2))
      });
      operations.push({ operation: "fetch_company_foundation", result });
    } catch (error) {
      errors.push(`fetch_company_foundation: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const result = await fetchAndSaveCompanyNews(params.ticker, {
        query,
        lookbackDays: params.lookbackDays,
        limit: Math.min(300, Math.max(80, params.documentLimit * 2))
      });
      operations.push({ operation: "fetch_company_news", query, result });
    } catch (error) {
      errors.push(`fetch_company_news: ${error instanceof Error ? error.message : String(error)}`);
    }

    let [documents, prices] = await Promise.all([
      listDocuments({ ticker: params.ticker, limit: Math.min(500, params.documentLimit * 2), since: params.since }),
      getPrices(params.ticker)
    ]);
    try {
      const bodyCandidates = prioritizeBodyFetchDocuments(documents, topicText);
      const result = await fetchAndCacheDocumentBodies(bodyCandidates, {
        limit: collectorBodyFetchLimit(),
        maxChars: collectorBodyMaxChars()
      });
      operations.push({
        operation: "fetch_document_bodies",
        scope: "company",
        terms: collectorBodySearchTerms(topicText).slice(0, 12),
        candidates_preview: bodyFetchPreview(bodyCandidates, topicText),
        result
      });
      if (result.fetched > 0) {
        documents = await listDocuments({ ticker: params.ticker, limit: Math.min(500, params.documentLimit * 2), since: params.since });
      }
    } catch (error) {
      errors.push(`fetch_document_bodies(company): ${error instanceof Error ? error.message : String(error)}`);
    }
    nextPayload.documents = mergeCompactDocuments(nextPayload.documents, documents, params.documentLimit);
    nextPayload.prices = prices.slice(-params.priceLimit);
    nextPayload.company = (await getCompany(params.ticker)) ?? nextPayload.company ?? null;
    operations.push({ operation: "reload_company_context", documents: documents.length, prices: prices.length });
  } else {
    try {
      const existingBodyCandidates = prioritizeBodyFetchDocuments(payloadDocumentsForBodyFetch(params.basePayload), topicText);
      if (existingBodyCandidates.length) {
        const result = await fetchAndCacheDocumentBodies(existingBodyCandidates, {
          limit: collectorBodyFetchLimit(),
          maxChars: collectorBodyMaxChars()
        });
        operations.push({
          operation: "fetch_document_bodies",
          scope: "existing_payload",
          terms: collectorBodySearchTerms(topicText).slice(0, 12),
          candidates_preview: bodyFetchPreview(existingBodyCandidates, topicText),
          result
        });
      }
    } catch (error) {
      errors.push(`fetch_document_bodies(existing_payload): ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const result = await fetchMacroData();
      operations.push({ operation: "fetch_macro_data", result });
    } catch (error) {
      errors.push(`fetch_macro_data: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const thematicQuery of thematicQueries) {
      if (!thematicQuery.query || thematicQuery.query === "Japan") continue;
      try {
        const result = await fetchAndSaveMacroNews({
          query: thematicQuery.query,
          lookbackDays: params.lookbackDays,
          limit: Math.min(220, Math.max(60, params.documentLimit))
        });
        if (Array.isArray(result.documents)) collectedNewsDocuments.push(...result.documents);
        operations.push({ operation: "fetch_thematic_news", query: thematicQuery.query, reason: thematicQuery.reason, result: compactNewsFetchResult(result as JsonRecord) });
      } catch (error) {
        errors.push(`fetch_thematic_news(${thematicQuery.query}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const sectorFoundation = await collectSectorCompanyFoundation({
      topicText,
      sector: params.sector,
      since: params.since,
      lookbackDays: params.lookbackDays,
      documentLimit: params.documentLimit
    });
    operations.push(...sectorFoundation.operations);
    errors.push(...sectorFoundation.errors);

    try {
      const bodySearchTerms = collectorBodySearchTerms(topicText);
      const [targetedBodyCandidates, macroBodyCandidates, ...searchedBodyCandidateGroups] = await Promise.all([
        listDocuments({ sourceType: "news", search: globalSearchTerm(params.sector), limit: 140, since: params.since }),
        listMacroNews(100),
        ...bodySearchTerms.slice(0, 8).map((term) => listDocuments({ sourceType: "news", search: term, limit: 80, since: params.since }))
      ]);
      const bodyCandidates = prioritizeBodyFetchDocuments(
        [
          ...payloadDocumentsForBodyFetch(params.basePayload),
          ...collectedNewsDocuments,
          ...sectorFoundation.documents,
          ...targetedBodyCandidates,
          ...macroBodyCandidates,
          ...searchedBodyCandidateGroups.flat()
        ],
        topicText
      );
      const result = await fetchAndCacheDocumentBodies(
        bodyCandidates,
        {
          limit: collectorBodyFetchLimit(),
          maxChars: collectorBodyMaxChars()
        }
      );
      operations.push({
        operation: "fetch_document_bodies",
        scope: "global",
        terms: bodySearchTerms.slice(0, 12),
        candidates_preview: bodyFetchPreview(bodyCandidates, topicText),
        result
      });
    } catch (error) {
      errors.push(`fetch_document_bodies(global): ${error instanceof Error ? error.message : String(error)}`);
    }

    const refreshed = await reloadGlobalResearchContext({
      search: globalSearchTerm(params.sector) ?? (query === "Japan" ? undefined : query),
      sector: params.sector,
      since: params.since,
      documentLimit: params.documentLimit
    });
    nextPayload.documents = mergeCompactDocuments(
      nextPayload.documents,
      [...(refreshed.documents as unknown as DocumentRecord[]), ...sectorFoundation.documents],
      params.documentLimit
    );
    nextPayload.context = {
      ...refreshed.context,
      collector_focus: {
        query,
        data_requirements: dataRequirements,
        thematic_queries: thematicQueries,
        selected_companies: sectorFoundation.selectedCompanies.map((company) => compactCompanyForDiscovery(company)),
        topic_excerpt: trimText(topicText, 900)
      }
    };
    operations.push({
      operation: "reload_global_context",
      documents: Array.isArray(nextPayload.documents) ? nextPayload.documents.length : 0,
      macro_indicators: Array.isArray(asJsonRecord(nextPayload.context).macro_indicators) ? (asJsonRecord(nextPayload.context).macro_indicators as unknown[]).length : 0,
      sector_snapshots: Array.isArray(asJsonRecord(nextPayload.context).sector_snapshots) ? (asJsonRecord(nextPayload.context).sector_snapshots as unknown[]).length : 0,
      recent_events: Array.isArray(asJsonRecord(nextPayload.context).recent_events) ? (asJsonRecord(nextPayload.context).recent_events as unknown[]).length : 0
    });
  }

  nextPayload.collector_history = [
    ...(Array.isArray(params.basePayload.collector_history) ? params.basePayload.collector_history : []),
    {
      query,
      data_requirements: dataRequirements,
      thematic_queries: thematicQueries,
      operations,
      errors,
      collected_at: new Date().toISOString()
    }
  ];

  const context = asJsonRecord(nextPayload.context);
  return {
    payload: nextPayload,
    output: {
      agent_name: "collector",
      next_action: "call_agent",
      next_agent: "skeptic",
      should_continue: true,
      reason_for_next_action: errors.length
        ? "追加データ取得で一部失敗がありました。取得済みデータを反証工程で検証します。"
        : "追加データを取得・再読込しました。更新後の入力を反証工程に渡します。",
      query,
      data_requirements: dataRequirements,
      thematic_queries: thematicQueries,
      operations,
      errors,
      data_collected: {
        documents: Array.isArray(nextPayload.documents) ? nextPayload.documents.length : 0,
        prices: Array.isArray(nextPayload.prices) ? nextPayload.prices.length : 0,
        macro_indicators: Array.isArray(context.macro_indicators) ? context.macro_indicators.length : 0,
        sector_snapshots: Array.isArray(context.sector_snapshots) ? context.sector_snapshots.length : 0,
        recent_events: Array.isArray(context.recent_events) ? context.recent_events.length : 0
      },
      duration_ms: Date.now() - startedAt
    }
  };
}

async function runHypothesisLoopOneTurnAtATime(params: {
  hypothesisId: number;
  basePayload: JsonRecord;
  startAgent: unknown;
  hypothesisType: string;
  ticker: string | null;
  sector?: string;
  since: string;
  lookbackDays: number;
  documentLimit: number;
  priceLimit: number;
  context: { requestId: string; route: string };
}): Promise<JsonRecord> {
  const safetyMaxTurns = hypothesisLoopSafetyMaxTurns();
  const agentRuns: JsonRecord[] = [];
  const loopTrace: JsonRecord[] = [];
  let workingPayload: JsonRecord = { ...params.basePayload };
  let currentAgent = safeLoopAgentName(params.startAgent, "hypothesis");
  let finalOutput: JsonRecord | null = null;
  let stoppedReason = "researcher_finalized";

  logger.info(
    {
      request_id: params.context.requestId,
      hypothesis_id: params.hypothesisId,
      hypothesis_type: params.hypothesisType,
      start_agent: currentAgent,
      safety_max_turns: safetyMaxTurns,
      turn_timeout_ms: config.researchTimeoutMs
    },
    "hypothesis loop started"
  );

  for (let turn = 1; turn <= safetyMaxTurns; turn += 1) {
    const reachedSafetyTurn = turn === safetyMaxTurns;
    const agentName = currentAgent;
    const agentHandoff = buildAgentHandoff(agentName, agentRuns);
    const loopHistory = Array.isArray(agentHandoff.loop_history) ? agentHandoff.loop_history : [];
    const turnPayload: JsonRecord = {
      ...workingPayload,
      loop_turn: turn,
      loop_history: loopHistory,
      agent_handoff: agentHandoff,
      routing_context: routingContext(agentName, agentRuns),
      loop_instruction: HYPOTHESIS_LOOP_INSTRUCTION,
      turn_timeout_ms: config.researchTimeoutMs
    };
    const inputSummary = buildTurnInputLog(agentName, turnPayload);
    const turnStartedAt = Date.now();
    const startedRun = await saveAgentRun({
      hypothesis_id: params.hypothesisId,
      agent_name: agentName,
      input: inputSummary,
      output: {
        agent_name: agentName,
        input: inputSummary,
        loop_turn: turn,
        status: "running",
        next_action: "running",
        next_agent: null,
        started_at: new Date().toISOString(),
        turn_timeout_ms: config.researchTimeoutMs
      },
      next_action: "running"
    });

    logger.info(
      {
        request_id: params.context.requestId,
        hypothesis_id: params.hypothesisId,
        turn,
        agent_name: agentName,
        phase: loopPhase(agentName),
        timeout_ms: config.researchTimeoutMs,
        input: summarizeLoopInput(agentName, turnPayload),
        handoff_from: agentHandoff.from_agent,
        history_turns: loopHistory.length
      },
      "hypothesis loop turn started"
    );

    let agentOutput: JsonRecord;
    if (agentName === "collector") {
      const collectorResult = await runCollectorTurn({
        basePayload: workingPayload,
        previousOutput: agentRuns.at(-1) ?? null,
        hypothesisType: params.hypothesisType,
        ticker: params.ticker,
        sector: params.sector,
        since: params.since,
        lookbackDays: params.lookbackDays,
        documentLimit: params.documentLimit,
        priceLimit: params.priceLimit
      });
      workingPayload = collectorResult.payload;
      agentOutput = collectorResult.output;
    } else {
      try {
        agentOutput = await researchPost<JsonRecord>(`/agents/${agentName}`, turnPayload, params.context);
      } catch (error) {
        const durationMs = Date.now() - turnStartedAt;
        const details = error instanceof ResearchError ? normalizeDetails(error.details) : serializeError(error);
        const failedOutput: JsonRecord = {
          agent_name: agentName,
          input: inputSummary,
          loop_turn: turn,
          duration_ms: durationMs,
          turn_timeout_ms: config.researchTimeoutMs,
          next_action: "error",
          next_agent: null,
          error: "llm_request_failed",
          details
        };
        await updateAgentRun(startedRun.id, {
          input: { ...inputSummary, request_payload: turnPayload },
          output: failedOutput,
          next_action: "error",
          next_agent: null
        });
        logger.error(
          {
            request_id: params.context.requestId,
            hypothesis_id: params.hypothesisId,
            turn,
            agent_name: agentName,
            duration_ms: durationMs,
            error: details
          },
          "hypothesis loop turn failed"
        );
        throw error;
      }
    }
    const durationMs = Date.now() - turnStartedAt;
    const rerouteToCollector = shouldRerouteResearcherToCollector(agentName, agentOutput, agentRuns);
    const effectiveAgentOutput: JsonRecord = rerouteToCollector
      ? {
          ...agentOutput,
          next_action: "request_data",
          next_agent: "collector",
          should_continue: true,
          api_routing_override: {
            from_next_action: agentOutput.next_action ?? null,
            from_next_agent: agentOutput.next_agent ?? null,
            reason: "Researcher output described missing high-priority data or collector-required evidence, so finalize was deferred."
          },
          reason_for_next_action:
            trimText(agentOutput.reason_for_next_action ?? agentOutput.reason, 420) ??
            "不足情報が結論を左右するため、Collectorで追加データを取得します。"
        }
      : agentOutput;
    const finalized = researcherHasFinalized(agentName, effectiveAgentOutput);
    const selectedNextAgent = finalized ? null : selectNextAgent(agentName, effectiveAgentOutput);
    const nextAgent = finalized || reachedSafetyTurn ? null : selectedNextAgent;
    const runOutput: JsonRecord = {
      ...effectiveAgentOutput,
      id: startedRun.id,
      status: "completed",
      agent_name: agentName,
      input: inputSummary,
      loop_turn: turn,
      duration_ms: durationMs,
      turn_timeout_ms: config.researchTimeoutMs,
      requested_next_agent: agentOutput.next_agent ?? null,
      requested_next_action: agentOutput.next_action ?? null,
      next_agent: nextAgent
    };
    const traceItem: JsonRecord = {
      turn,
      agent_name: agentName,
      phase: loopPhase(agentName),
      input: inputSummary,
      next_action: runOutput.next_action,
      next_agent: runOutput.next_agent,
      should_continue: runOutput.should_continue,
      duration_ms: durationMs,
      timeout_ms: config.researchTimeoutMs,
      summary: loopSummary(runOutput)
    };

    agentRuns.push(runOutput);
    loopTrace.push(traceItem);
    await updateAgentRun(startedRun.id, {
      input: inputSummary,
      output: runOutput,
      next_action: typeof runOutput.next_action === "string" ? runOutput.next_action : undefined,
      next_agent: typeof runOutput.next_agent === "string" ? runOutput.next_agent : undefined
    });

    logger.info(
      {
        request_id: params.context.requestId,
        hypothesis_id: params.hypothesisId,
        turn,
        agent_name: agentName,
        next_action: runOutput.next_action,
        next_agent: runOutput.next_agent,
        should_continue: runOutput.should_continue,
        duration_ms: durationMs,
        finalized
      },
      "hypothesis loop turn completed"
    );

    if (hasLlmParseFailure(runOutput)) {
      workingPayload = {
        ...workingPayload,
        llm_thinking_mode: "no_think",
        llm_recovery_instruction:
          "前回のLLM応答はJSON整形に失敗しました。次ターンではthinkを無効化し、JSONのみを短く返してください。"
      };
    }

    if (finalized || reachedSafetyTurn) {
      finalOutput = runOutput;
      stoppedReason = finalized ? "researcher_finalized" : "safety_cap_reached";
      break;
    }

    currentAgent = nextAgent ?? defaultLoopNextAgent(agentName);
  }

  if (!finalOutput) {
    finalOutput = agentRuns.at(-1) ?? {};
    stoppedReason = "safety_cap_reached";
  }

  logger.info(
    {
      request_id: params.context.requestId,
      hypothesis_id: params.hypothesisId,
      turns: agentRuns.length,
      stopped_reason: stoppedReason
    },
    "hypothesis loop completed"
  );

  return {
    agent_runs: agentRuns,
    loop_trace: loopTrace,
    loop_stopped_reason: stoppedReason,
    turn_timeout_ms: config.researchTimeoutMs,
    final_decision: finalOutput.final_decision ?? "inconclusive",
    reason: finalOutput.reason ?? finalOutput.reason_for_next_action,
    evidence_strength: finalOutput.evidence_strength,
    contradiction_strength: finalOutput.contradiction_strength,
    missing_information: finalOutput.missing_information ?? [],
    recommended_next_research: finalOutput.recommended_next_research ?? [],
    scores: finalOutput.scores ?? {},
    final_report: finalOutput.final_report
  };
}

const documentInputSchema = z
  .object({
    ticker: z.string().optional(),
    source_type: z.string().optional(),
    source_name: z.string().optional(),
    title: z.string().min(1),
    url: z.string().url().optional(),
    published_at: z.string().optional(),
    raw_text: z.string().optional(),
    storage_level: z.string().optional(),
    summarize: z.boolean().optional()
  })
  .passthrough();

const hypothesisInputSchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().optional(),
    status: z.string().optional(),
    hypothesis_type: z.enum(["global", "company"]).optional(),
    ticker: z.string().optional(),
    target_company_id: z.number().optional(),
    target_sector: z.string().optional(),
    growth_driver: z.string().optional(),
    required_evidence: z.array(z.string()).optional(),
    risk_factors: z.array(z.string()).optional()
  })
  .passthrough();

const hypothesisDiscoverySchema = z
  .object({
    focus: z.string().optional(),
    sector: z.string().optional(),
    limit: z.number().int().min(1).max(12).optional(),
    lookback_days: z.number().int().min(30).max(1500).optional(),
    news_limit: z.number().int().min(40).max(800).optional(),
    document_limit: z.number().int().min(30).max(220).optional(),
    company_limit: z.number().int().min(30).max(220).optional(),
    refresh: z.boolean().optional(),
    create: z.boolean().optional(),
    llm_thinking_mode: z.enum(["auto", "no_think", "think"]).optional()
  })
  .passthrough();

const foundationFetchSchema = z
  .object({
    includePrices: z.boolean().optional(),
    includeStatements: z.boolean().optional(),
    includeNews: z.boolean().optional(),
    from: z.string().regex(/^\d{4}-?\d{2}-?\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-?\d{2}-?\d{2}$/).optional(),
    newsLookbackDays: z.number().int().min(30).max(1200).optional(),
    newsLimit: z.number().int().min(20).max(600).optional()
  })
  .passthrough();

const newsFetchSchema = z
  .object({
    query: z.string().optional(),
    lookbackDays: z.number().int().min(30).max(1200).optional(),
    limit: z.number().int().min(20).max(600).optional()
  })
  .passthrough();

app.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const [database, research] = await Promise.allSettled([checkDatabase(), researchHealth()]);
    res.json({
      ok: true,
      database: database.status === "fulfilled" ? database.value : false,
      schema: { ready: schemaReady, error: schemaError },
      research: research.status === "fulfilled" ? research.value : { ok: false }
    });
  })
);

app.get(
  "/api/overview",
  asyncHandler(async (_req, res) => {
    res.json(await getOverview());
  })
);

app.get(
  "/api/data/status",
  asyncHandler(async (_req, res) => {
    res.json({
      jquants: await jquants.status()
    });
  })
);

app.post(
  "/api/data/purge-sample",
  asyncHandler(async (_req, res) => {
    res.json(await purgeSampleData());
  })
);

app.post(
  "/api/data/listed/fetch",
  asyncHandler(async (_req, res) => {
    res.json(await fetchListedMaster());
  })
);

app.get(
  "/api/macro",
  asyncHandler(async (_req, res) => {
    res.json(await getMacroSnapshot());
  })
);

app.post(
  "/api/macro/fetch",
  asyncHandler(async (_req, res) => {
    res.json(await fetchMacroData());
  })
);

app.get(
  "/api/news/sources",
  asyncHandler(async (_req, res) => {
    res.json(newsSourceCatalog());
  })
);

app.post(
  "/api/data/companies/:ticker/fetch",
  asyncHandler(async (req, res) => {
    const body = foundationFetchSchema.parse(req.body ?? {});
    res.json(await fetchCompanyFoundation(req.params.ticker, body));
  })
);

app.post(
  "/api/companies/:ticker/fetch-foundation",
  asyncHandler(async (req, res) => {
    const body = foundationFetchSchema.parse(req.body ?? {});
    res.json(await fetchCompanyFoundation(req.params.ticker, body));
  })
);

app.post(
  "/api/companies/:ticker/news/fetch",
  asyncHandler(async (req, res) => {
    const body = newsFetchSchema.parse(req.body ?? {});
    res.json(
      await fetchAndSaveCompanyNews(req.params.ticker, {
        query: body.query,
        lookbackDays: body.lookbackDays,
        limit: body.limit
      })
    );
  })
);

app.get(
  "/api/companies",
  asyncHandler(async (_req, res) => {
    res.json(await listCompanies());
  })
);

app.get(
  "/api/companies/:ticker",
  asyncHandler(async (req, res) => {
    const company = await getCompany(normalizeTicker(req.params.ticker));
    if (!company) {
      res.status(404).json({ error: "company_not_found" });
      return;
    }
    res.json(company);
  })
);

app.get(
  "/api/companies/:ticker/prices",
  asyncHandler(async (req, res) => {
    res.json(await getPrices(normalizeTicker(req.params.ticker)));
  })
);

app.get(
  "/api/companies/:ticker/news",
  asyncHandler(async (req, res) => {
    res.json(await listDocuments({ ticker: normalizeTicker(req.params.ticker), sourceType: "news", limit: 250 }));
  })
);

app.get(
  "/api/companies/:ticker/disclosures",
  asyncHandler(async (req, res) => {
    const documents = await listDocuments({ ticker: normalizeTicker(req.params.ticker) });
    res.json(documents.filter((document) => ["disclosure", "financial_statement"].includes(document.source_type ?? "")));
  })
);

app.get(
  "/api/companies/:ticker/events",
  asyncHandler(async (req, res) => {
    res.json(await listEvents(normalizeTicker(req.params.ticker)));
  })
);

app.get(
  "/api/companies/:ticker/hypotheses",
  asyncHandler(async (req, res) => {
    res.json(await listHypotheses({ ticker: normalizeTicker(req.params.ticker) }));
  })
);

app.post(
  "/api/companies/:ticker/research",
  asyncHandler(async (req, res) => {
    const ticker = normalizeTicker(req.params.ticker);
    const company = await getCompany(ticker);
    if (!company) {
      res.status(404).json({ error: "company_not_found" });
      return;
    }

    const researchSince = daysAgoIso(Number(req.body?.lookback_days ?? process.env.NEWS_LOOKBACK_DAYS ?? 450));
    const [documents, hypotheses, prices] = await Promise.all([
      listDocuments({ ticker, limit: 80, since: researchSince }),
      listHypotheses({ ticker }),
      getPrices(ticker)
    ]);
    const output = await researchPost(
      "/companies/research",
      {
        company,
        documents: documents.slice(0, 36).map(compactDocumentForResearch),
        hypotheses: hypotheses.slice(0, 10).map((hypothesis) => compactHypothesisForResearch(hypothesis as JsonRecord)),
        prices: prices.slice(-90),
        question: req.body?.question,
        llm_thinking_mode: req.body?.llm_thinking_mode ?? "auto",
        input_summary: {
          mode: "company_research",
          documents_available: documents.length,
          documents_sent: Math.min(36, documents.length),
          prices_available: prices.length,
          prices_sent: Math.min(90, prices.length),
          news_since: researchSince
        }
      },
      requestContext(req, res)
    );
    res.json(output);
  })
);

app.get(
  "/api/hypotheses",
  asyncHandler(async (req, res) => {
    res.json(await listHypotheses({ status: req.query.status as string | undefined, ticker: req.query.ticker as string | undefined }));
  })
);

app.get(
  "/api/hypotheses/:id",
  asyncHandler(async (req, res) => {
    const hypothesis = await getHypothesis(parseId(req.params.id));
    if (!hypothesis) {
      res.status(404).json({ error: "hypothesis_not_found" });
      return;
    }
    res.json(hypothesis);
  })
);

app.delete(
  "/api/hypotheses/:id",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const hypothesis = await getHypothesis(id);
    if (!hypothesis) {
      res.status(404).json({ error: "hypothesis_not_found" });
      return;
    }
    res.json(await deleteHypothesis(id));
  })
);

app.get(
  "/api/hypotheses/:id/agent-runs",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const hypothesis = await getHypothesis(id);
    if (!hypothesis) {
      res.status(404).json({ error: "hypothesis_not_found" });
      return;
    }
    const afterId = req.query.after_id === undefined ? undefined : Number(req.query.after_id);
    if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 0)) {
      res.status(400).json({ error: "invalid_after_id" });
      return;
    }
    res.json({
      hypothesis_id: id,
      agent_runs: await listAgentRunsForHypothesis(id, { afterId })
    });
  })
);

app.delete(
  "/api/hypotheses/:id/agent-runs",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const hypothesis = await getHypothesis(id);
    if (!hypothesis) {
      res.status(404).json({ error: "hypothesis_not_found" });
      return;
    }
    res.json(await deleteAgentRunsForHypothesis(id));
  })
);

app.post(
  "/api/hypotheses",
  asyncHandler(async (req, res) => {
    const input = hypothesisInputSchema.parse(req.body);
    const hypothesis = await createHypothesis(input);
    res.status(201).json(hypothesis);
  })
);

app.post(
  "/api/hypotheses/discover",
  asyncHandler(async (req, res) => {
    const input = hypothesisDiscoverySchema.parse(req.body ?? {});
    const focus = input.focus?.trim() || undefined;
    const sector = input.sector?.trim() || undefined;
    const limit = input.limit ?? 6;
    const documentLimit = input.document_limit ?? 90;
    const companyLimit = input.company_limit ?? 90;
    const lookbackDays = input.lookback_days ?? Number(process.env.NEWS_LOOKBACK_DAYS ?? 450);
    const since = daysAgoIso(lookbackDays);
    const query = discoveryNewsQuery({ focus, sector });
    const operations: JsonRecord[] = [];
    const errors: string[] = [];

    if (input.refresh !== false) {
      try {
        const result = await fetchMacroData();
        operations.push({ operation: "fetch_macro_data", result });
      } catch (error) {
        errors.push(`fetch_macro_data: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const result = await fetchAndSaveMacroNews({
          query,
          lookbackDays,
          limit: input.news_limit ?? 260
        });
        operations.push({ operation: "fetch_macro_news", query, result });
      } catch (error) {
        errors.push(`fetch_macro_news: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const search = globalSearchTerm(sector) ?? globalSearchTerm(focus);
    const [globalResearch, companies, existingHypotheses] = await Promise.all([
      reloadGlobalResearchContext({
        search,
        sector: sector ?? focus,
        since,
        documentLimit
      }),
      listCompanies(1000),
      listHypotheses()
    ]);
    const existingTitles = new Set(
      existingHypotheses.map((hypothesis) => String(hypothesis.title ?? "").normalize("NFKC").trim().toLowerCase()).filter(Boolean)
    );
    const companyByTicker = new Map(companies.map((company) => [company.ticker, company]));
    const hypothesesWithRuns = await Promise.all(existingHypotheses.slice(0, 8).map((hypothesis) => getHypothesis(hypothesis.id).catch(() => undefined)));
    const agentMemory = hypothesesWithRuns
      .filter((hypothesis): hypothesis is Hypothesis => Boolean(hypothesis))
      .map((hypothesis) => compactAgentMemoryForDiscovery(hypothesis as JsonRecord))
      .filter((memory) => Array.isArray(memory.recent_runs) && memory.recent_runs.length > 0);
    const companiesForDiscovery = companies
      .slice()
      .sort((a, b) => companyDiscoveryScore(b, focus, sector) - companyDiscoveryScore(a, focus, sector))
      .slice(0, companyLimit)
      .map(compactCompanyForDiscovery);
    const payload: JsonRecord = {
      task: "discover_underappreciated_growth_hypotheses",
      focus: focus ?? null,
      sector: sector ?? null,
      limit,
      lookback_days: lookbackDays,
      collector_operations: operations,
      collector_errors: errors,
      documents: globalResearch.documents,
      context: globalResearch.context,
      companies: companiesForDiscovery,
      existing_hypotheses: existingHypotheses.slice(0, 80).map((hypothesis) => compactHypothesisForResearch(hypothesis as JsonRecord)),
      agent_memory: agentMemory,
      source_quality_policy: {
        primary_sources_first: ["timely_disclosure", "financial_statement", "company_profile", "official_statistics", "policy_document"],
        weak_leads_only: ["ranking_article", "listicle", "seo_growth_stock_article", "headline_only_news"],
        reject_if: [
          "二次情報だけで裏取りできない",
          "根拠文書のpublished_atが古く現在の事業環境と接続できない",
          "話題性だけで業績インパクトが示せない"
        ]
      },
      llm_thinking_mode: input.llm_thinking_mode ?? "auto",
      input_summary: {
        mode: "hypothesis_discovery",
        focus,
        sector,
        query,
        documents_sent: globalResearch.documents.length,
        companies_sent: companiesForDiscovery.length,
        existing_hypotheses_sent: Math.min(80, existingHypotheses.length),
        agent_memory_sent: agentMemory.length,
        news_since: since
      }
    };

    const output = await researchPost<JsonRecord>("/hypotheses/discover", payload, requestContext(req, res));
    const candidateRecords = Array.isArray(output.hypotheses) ? output.hypotheses.map(asJsonRecord).slice(0, limit) : [];
    const created: Hypothesis[] = [];
    const skipped: JsonRecord[] = [];

    if (input.create !== false) {
      for (const candidate of candidateRecords) {
        const title = trimText(candidate.title, 220);
        if (!title) {
          skipped.push({ candidate, reason: "title_missing" });
          continue;
        }
        const titleKey = title.normalize("NFKC").trim().toLowerCase();
        if (existingTitles.has(titleKey)) {
          skipped.push({ title, reason: "duplicate_title" });
          continue;
        }
        const ticker = normalizeOptionalTicker(candidate.ticker);
        const knownTicker = ticker && companyByTicker.has(ticker) ? ticker : undefined;
        const candidateType = candidate.hypothesis_type === "company" && knownTicker ? "company" : "global";
        const hypothesis = await createHypothesis({
          title,
          summary: trimText(candidate.summary, 900) ?? null,
          status: "Draft",
          hypothesis_type: candidateType,
          ticker: knownTicker,
          target_sector: trimText(candidate.target_sector ?? sector ?? focus, 120) ?? null,
          growth_driver: trimText(candidate.growth_driver, 320) ?? null,
          required_evidence: textArray(candidate.required_evidence),
          risk_factors: textArray(candidate.risk_factors),
          missing_information: textArray(candidate.missing_information),
          recommended_next_research: textArray(candidate.recommended_next_research),
          score_growth: numberValue(candidate.score_growth),
          score_evidence: numberValue(candidate.score_evidence),
          score_contradiction: numberValue(candidate.score_contradiction),
          score_valuation_risk: numberValue(candidate.score_valuation_risk),
          score_overlooked: numberValue(candidate.score_overlooked),
          score_overall: numberValue(candidate.score_overall),
          created_by_agent: "discovery_agent"
        });
        existingTitles.add(titleKey);
        created.push(hypothesis);
        await saveAgentRun({
          hypothesis_id: hypothesis.id,
          agent_name: "discovery",
          input: discoveryContextSummary(payload),
          output: {
            agent_name: "discovery",
            next_action: "create_hypothesis",
            candidate,
            discovery_output: output
          },
          next_action: "create_hypothesis"
        });
      }
    }

    res.json({
      output,
      created,
      skipped,
      collector_operations: operations,
      collector_errors: errors,
      context_summary: discoveryContextSummary(payload)
    });
  })
);

app.patch(
  "/api/hypotheses/:id/status",
  asyncHandler(async (req, res) => {
    const status = z.string().min(1).parse(req.body?.status);
    const hypothesis = await updateHypothesisStatus(parseId(req.params.id), status);
    if (!hypothesis) {
      res.status(404).json({ error: "hypothesis_not_found" });
      return;
    }
    res.json(hypothesis);
  })
);

app.post(
  "/api/hypotheses/:id/run",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const hypothesis = await getHypothesis(id);
    if (!hypothesis) {
      res.status(404).json({ error: "hypothesis_not_found" });
      return;
    }

    const hypothesisRecord = hypothesis as JsonRecord;
    const hypothesisType = String(hypothesisRecord.hypothesis_type ?? (hypothesisRecord.ticker ? "company" : "global"));
    const ticker = typeof hypothesisRecord.ticker === "string" ? normalizeTicker(hypothesisRecord.ticker) : null;
    const sector = typeof hypothesisRecord.target_sector === "string" ? hypothesisRecord.target_sector : undefined;
    const lookbackDays = Number(req.body?.lookback_days ?? process.env.NEWS_LOOKBACK_DAYS ?? 450);
    const researchSince = daysAgoIso(lookbackDays);
    let company: Awaited<ReturnType<typeof getCompany>> = undefined;
    let documents: DocumentRecord[] = [];
    let prices: Awaited<ReturnType<typeof getPrices>> = [];
    let globalContext: JsonRecord = {};

    if (hypothesisType === "company" && ticker) {
      [company, documents, prices] = await Promise.all([getCompany(ticker), listDocuments({ ticker, limit: 80, since: researchSince }), getPrices(ticker)]);
    } else {
      const search = globalSearchTerm(sector);
      const [targetedDocuments, broadDocuments, macroIndicators, macroNews, sectorSnapshots, events] = await Promise.all([
        listDocuments({ sourceType: "news", sector: search, search, limit: 140, since: researchSince }),
        listDocuments({ limit: 180, since: researchSince }),
        listMacroIndicators(16),
        listMacroNews(80),
        listSectorSnapshots(24),
        listEvents()
      ]);
      documents = dedupeDocuments([...(targetedDocuments.length ? targetedDocuments : []), ...macroNews, ...broadDocuments]).slice(0, 120);
      globalContext = {
        mode: "global_sector_research",
        requested_sector: sector ?? null,
        effective_search: search ?? null,
        macro_indicators: macroIndicators,
        sector_snapshots: sectorSnapshots,
        recent_events: events.slice(0, 60).map((event) => compactEventForResearch(event as JsonRecord)),
        data_warnings: [
          documents.length ? null : "documents_empty",
          macroIndicators.length ? null : "macro_indicators_empty",
          sectorSnapshots.length ? null : "sector_snapshots_empty"
        ].filter(Boolean)
      };
    }
    const documentSendLimit = hypothesisType === "company" ? 36 : 96;
    const priceSendLimit = 90;

    const output = await runHypothesisLoopOneTurnAtATime({
      hypothesisId: id,
      startAgent: req.body?.start_agent ?? "hypothesis",
      hypothesisType,
      ticker,
      sector,
      since: researchSince,
      lookbackDays,
      documentLimit: documentSendLimit,
      priceLimit: priceSendLimit,
      context: requestContext(req, res),
      basePayload: {
        hypothesis,
        hypothesis_type: hypothesisType,
        company: company ?? null,
        documents: documents.slice(0, documentSendLimit).map(compactDocumentForResearch),
        prices: prices.slice(-priceSendLimit),
        context: globalContext,
        llm_thinking_mode: req.body?.llm_thinking_mode ?? "auto",
        input_summary: {
          mode: hypothesisType === "company" ? "company_hypothesis" : "global_hypothesis",
          sector,
          ticker,
          documents_available: documents.length,
          documents_sent: Math.min(documentSendLimit, documents.length),
          prices_available: prices.length,
          prices_sent: Math.min(priceSendLimit, prices.length),
          macro_indicators_sent: Array.isArray(globalContext.macro_indicators) ? globalContext.macro_indicators.length : 0,
          sector_snapshots_sent: Array.isArray(globalContext.sector_snapshots) ? globalContext.sector_snapshots.length : 0,
          recent_events_sent: Array.isArray(globalContext.recent_events) ? globalContext.recent_events.length : 0,
          news_since: researchSince
        }
      }
    });

    const updated = await applyResearchResult(id, output);
    res.json({ output, hypothesis: updated ?? hypothesis });
  })
);

app.post(
  "/api/hypotheses/:id/deepen",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const hypothesis = await getHypothesis(id);
    if (!hypothesis) {
      res.status(404).json({ error: "hypothesis_not_found" });
      return;
    }

    const output = await researchPost(
      "/hypotheses/deepen",
      {
        hypothesis,
        question: req.body?.question,
        focus: req.body?.focus
      },
      requestContext(req, res)
    );
    await saveAgentRun({
      hypothesis_id: id,
      agent_name: "researcher",
      input: { question: req.body?.question, focus: req.body?.focus },
      output
    });
    res.json(output);
  })
);

app.get(
  "/api/documents",
  asyncHandler(async (req, res) => {
    res.json(
      await listDocuments({
        ticker: req.query.ticker as string | undefined,
        sourceType: req.query.source_type as string | undefined,
        search: req.query.q as string | undefined,
        sector: req.query.sector as string | undefined,
        since: req.query.since as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined
      })
    );
  })
);

app.get(
  "/api/documents/:id",
  asyncHandler(async (req, res) => {
    const document = await getDocument(parseId(req.params.id));
    if (!document) {
      res.status(404).json({ error: "document_not_found" });
      return;
    }
    res.json(document);
  })
);

app.post(
  "/api/documents/fetch",
  asyncHandler(async (req, res) => {
    const input = documentInputSchema.parse(req.body);
    let summary: JsonRecord = {};
    if (input.summarize) {
      summary = await researchPost(
        "/documents/summarize",
        {
          title: input.title,
          url: input.url,
          raw_text: input.raw_text,
          ticker: input.ticker
        },
        requestContext(req, res)
      );
    }
    const document = await createDocument({ ...input, ...summary } as Partial<DocumentRecord> & { ticker?: string });
    res.status(201).json(document);
  })
);

app.post(
  "/api/documents/:id/summarize",
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const document = await getDocument(id);
    if (!document) {
      res.status(404).json({ error: "document_not_found" });
      return;
    }
    const summary = await researchPost(
      "/documents/summarize",
      {
        ...document,
        raw_text: req.body?.raw_text ?? document.raw_text
      },
      requestContext(req, res)
    );
    const updated = await updateDocumentSummary(id, summary);
    res.json(updated ?? document);
  })
);

app.post(
  "/api/documents/search",
  asyncHandler(async (req, res) => {
    const q = z.string().optional().parse(req.body?.query);
    const ticker = z.string().optional().parse(req.body?.ticker);
    res.json(await listDocuments({ search: q, ticker }));
  })
);

for (const agentName of ["hypothesis", "skeptic", "researcher"] as const) {
  app.post(
    `/api/agents/${agentName}`,
    asyncHandler(async (req, res) => {
      const output = await researchPost(`/agents/${agentName}`, req.body ?? {}, requestContext(req, res));
      if (req.body?.hypothesis_id) {
        await saveAgentRun({
          hypothesis_id: Number(req.body.hypothesis_id),
          agent_name: agentName,
          input: req.body,
          output
        });
      }
      res.json(output);
    })
  );
}

app.use((req, res) => {
  res.status(404).json({ error: "not_found", request_id: currentRequestId(req, res) });
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const requestId = currentRequestId(req, res);

  if (error instanceof z.ZodError) {
    logger.warn({ request_id: requestId, method: req.method, path: req.originalUrl, issues: error.issues }, "validation failed");
    res.status(400).json({ error: "validation_error", issues: error.issues, request_id: requestId });
    return;
  }

  if (error instanceof ResearchError) {
    const status = error.status === 404 ? 502 : error.status;
    const details = normalizeDetails(error.details);
    logger.error(
      {
        request_id: requestId,
        method: req.method,
        path: req.originalUrl,
        status,
        research_status: error.status,
        details,
        error: serializeError(error)
      },
      "research backend error"
    );
    res.status(status).json({
      error: "research_backend_error",
      message: error.message,
      details,
      request_id: requestId
    });
    return;
  }

  const status = statusFromError(error);
  const serializedError = serializeError(error);
  logger.error({ request_id: requestId, method: req.method, path: req.originalUrl, status, error: serializedError }, "request failed");
  res.status(status).json({
    error: status === 504 ? "timeout_error" : "internal_error",
    message: status === 504 ? "Upstream request timed out before the response reached the API" : typeof serializedError.message === "string" ? serializedError.message : "Unknown error",
    details: serializedError,
    request_id: requestId
  });
});

async function bootstrap() {
  app.listen(config.port, "0.0.0.0", () => {
    logger.info({ port: config.port }, "stock research api listening");
  });

  try {
    await ensureDatabaseSchema();
    schemaReady = true;
    schemaError = null;
  } catch (error) {
    schemaReady = false;
    schemaError = error instanceof Error ? error.message : "schema initialization failed";
    logger.error({ error: serializeError(error) }, "schema initialization failed; api will keep serving health and return request errors");
    return;
  }

  if (config.purgeSampleDataOnStart) {
    try {
      const result = await purgeSampleData();
      if (result.deleted > 0) logger.info({ deleted: result.deleted }, "purged early fixture data");
    } catch (error) {
      logger.warn({ error: serializeError(error) }, "could not purge early fixture data");
    }
  }
}

bootstrap().catch((error) => {
  logger.error({ error: serializeError(error) }, "failed to start stock research api");
  process.exit(1);
});
