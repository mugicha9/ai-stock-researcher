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

type ApiRequestContext = { requestId: string; route: string; signal: AbortSignal };

function clientAbortError(message = "Client request aborted"): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function requestAbortSignal(req: Request, res: Response): AbortSignal {
  const locals = res.locals as typeof res.locals & {
    abortController?: AbortController;
    abortListenersAttached?: boolean;
  };
  if (!locals.abortController) locals.abortController = new AbortController();
  if (!locals.abortListenersAttached) {
    const abort = () => {
      if (!res.writableEnded && !locals.abortController?.signal.aborted) {
        locals.abortController?.abort(clientAbortError());
      }
    };
    req.on("aborted", abort);
    res.on("close", abort);
    locals.abortListenersAttached = true;
  }
  return locals.abortController.signal;
}

function requestContext(req: Request, res: Response): ApiRequestContext {
  const routePath = typeof req.route?.path === "string" ? req.route.path : req.path;
  return {
    requestId: currentRequestId(req, res),
    route: `${req.method} ${routePath}`,
    signal: requestAbortSignal(req, res)
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : clientAbortError();
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
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "RESEARCH_RESPONSE_TIMEOUT" ||
    /timeout/i.test(message)
  ) {
    return true;
  }
  return hasTimeoutSignal(record.cause, depth + 1);
}

function hasAbortSignal(error: unknown, depth = 0): boolean {
  if (!error || depth > 3) return false;
  const record =
    error instanceof Error
      ? (error as Error & { code?: unknown; cause?: unknown })
      : typeof error === "object"
        ? (error as Record<string, unknown>)
        : null;
  if (!record) return /abort|aborted|cancelled|canceled/i.test(String(error));

  const name = String(record.name ?? "");
  const code = String(record.code ?? "");
  const message = String(record.message ?? "");
  if (name === "AbortError" || code === "ABORT_ERR" || /abort|aborted|cancelled|canceled/i.test(message)) {
    return true;
  }
  return hasAbortSignal(record.cause, depth + 1);
}

function statusFromError(error: unknown): number {
  if (hasAbortSignal(error)) return 499;
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

type EvidenceSelectionMode = "discovery" | "verification";

type EvidenceSelection = {
  documents: JsonRecord[];
  evidence_pack: JsonRecord;
};

type ScoredEvidenceDocument = {
  record: JsonRecord;
  key: string;
  cluster: string;
  score: number;
  sourceScore: number;
  relevance: number;
  recencyScore: number;
  importance: number;
  lowQuality: boolean;
  hasBody: boolean;
  isPrimary: boolean;
  isContradicting: boolean;
  reason: string;
};

function evidenceTopicTerms(topicText: string): string[] {
  const stopWords = new Set([
    "global",
    "company",
    "hypothesis",
    "metadata",
    "only",
    "collector",
    "finalize",
    "request",
    "data",
    "全体",
    "有望",
    "どんな",
    "セクター",
    "分野",
    "市場",
    "仮説",
    "検証",
    "反証",
    "情報",
    "取得",
    "必要",
    "不足",
    "影響",
    "企業",
    "日本"
  ]);
  return uniqueLimited(
    normalizeCollectorText(topicText)
      .split(/\s+/)
      .filter((term) => term.length >= 2 && term.length <= 24 && !stopWords.has(term.toLowerCase()) && !/^\d+$/.test(term)),
    24
  );
}

function evidenceDocumentRecord(value: unknown): JsonRecord | null {
  const record = asJsonRecord(value);
  const id = record.id;
  const title = trimText(record.title, 260);
  if (!title) return null;
  const bodyExcerpt = trimText(record.body_excerpt ?? compactBodyExcerpt(record as DocumentRecord), 600);
  return {
    id,
    ticker: record.ticker,
    company_name: record.company_name,
    source_type: record.source_type,
    source_name: record.source_name,
    title,
    url: record.url,
    published_at: record.published_at,
    storage_level: record.storage_level,
    retrieval_status: record.retrieval_status,
    event_type: record.event_type,
    sentiment: record.sentiment,
    importance_score: record.importance_score,
    summary_short: trimText(record.summary_short, 220),
    summary_investment: trimText(record.summary_investment, 260),
    summary_risk: trimText(record.summary_risk, 220),
    key_points: Array.isArray(record.key_points) ? record.key_points.slice(0, 4).map((item) => trimText(item, 140)).filter(Boolean) : [],
    body_excerpt: bodyExcerpt
  };
}

function evidenceDocumentKey(record: JsonRecord): string {
  return String(record.url ?? record.id ?? `${record.source_name ?? ""}:${record.title ?? ""}`).normalize("NFKC").toLowerCase();
}

function evidenceClusterKey(record: JsonRecord): string {
  const title = normalizeCollectorText(String(record.title ?? ""))
    .replace(/[0-9０-９年月日\s]+/g, "")
    .slice(0, 42);
  const source = String(record.source_name ?? record.source_type ?? "").slice(0, 24);
  return `${source}:${title || evidenceDocumentKey(record).slice(0, 42)}`.toLowerCase();
}

function evidenceText(record: JsonRecord): string {
  const keyPoints = Array.isArray(record.key_points) ? record.key_points.join(" ") : "";
  return normalizeCollectorText(
    [
      record.title,
      record.summary_short,
      record.summary_investment,
      record.summary_risk,
      record.source_name,
      record.source_type,
      record.url,
      keyPoints
    ].join(" ")
  ).toLowerCase();
}

function evidenceSourceScore(record: JsonRecord): number {
  const text = evidenceText(record);
  const sourceType = String(record.source_type ?? "").toLowerCase();
  if (/disclosure|financial_statement|timely|tdnet|edinet/.test(sourceType)) return 100;
  if (/jpx|tdnet|edinet|meti|boj|mof|cao|stat\.go|go\.jp|jquants|日銀|財務省|経済産業省|資源エネルギー庁|内閣府/.test(text)) return 90;
  if (/official|policy|statistics|公的|統計|政策|国会|会議録/.test(text)) return 80;
  if (/reuters|bloomberg|nikkei|日経|ロイター|ブルームバーグ|trusted_news/.test(text)) return 64;
  if (/news|macro/.test(sourceType)) return 38;
  return 28;
}

function evidenceLowQuality(record: JsonRecord): boolean {
  const text = evidenceText(record);
  return /ランキング|おすすめ|注目銘柄|成長株.{0,8}選|テンバガー|株価.{0,12}急騰|買い時|まとめ|一覧|知らないと損|seo/.test(text);
}

function evidenceContradicting(record: JsonRecord): boolean {
  const text = evidenceText(record);
  const sentiment = String(record.sentiment ?? "").toLowerCase();
  return (
    sentiment === "negative" ||
    sentiment === "mixed" ||
    /懸念|リスク|減益|下方|悪化|鈍化|低迷|競争激化|価格下落|コスト増|供給過剰|需要減|織り込み|割高|逆風/.test(text)
  );
}

function evidenceRecencyScore(record: JsonRecord): number {
  const timestamp = typeof record.published_at === "string" ? Date.parse(record.published_at) : NaN;
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  if (ageDays <= 30) return 16;
  if (ageDays <= 120) return 11;
  if (ageDays <= 365) return 7;
  if (ageDays <= 540) return 3;
  return 0;
}

function evidenceRelevance(record: JsonRecord, terms: string[]): number {
  if (!terms.length) return 0;
  const text = evidenceText(record);
  const title = normalizeCollectorText(String(record.title ?? "")).toLowerCase();
  return terms.reduce((score, term) => {
    const normalized = normalizeCollectorText(term).toLowerCase();
    if (!normalized) return score;
    return score + (title.includes(normalized) ? 3 : 0) + (text.includes(normalized) ? 1 : 0);
  }, 0);
}

function evidenceReference(item: ScoredEvidenceDocument): JsonRecord {
  return {
    id: item.record.id,
    title: trimText(item.record.title, 140),
    source_name: item.record.source_name,
    source_type: item.record.source_type,
    published_at: item.record.published_at,
    score: Math.round(item.score),
    reason: item.reason
  };
}

function evidenceRelevanceGate(item: ScoredEvidenceDocument, hasTopicTerms: boolean): boolean {
  if (!hasTopicTerms) return true;
  return item.relevance > 0 || item.importance >= 0.6 || item.hasBody;
}

function selectDiverseEvidence(items: ScoredEvidenceDocument[], limit: number, used = new Set<string>()): ScoredEvidenceDocument[] {
  const selected: ScoredEvidenceDocument[] = [];
  const clusterCounts = new Map<string, number>();
  for (const item of items.sort((a, b) => b.score - a.score)) {
    if (selected.length >= limit) break;
    if (used.has(item.key)) continue;
    const clusterCount = clusterCounts.get(item.cluster) ?? 0;
    if (clusterCount >= 2) continue;
    used.add(item.key);
    clusterCounts.set(item.cluster, clusterCount + 1);
    selected.push(item);
  }
  return selected;
}

function compactEvidenceDocument(item: ScoredEvidenceDocument, includeBody: boolean): JsonRecord {
  const output: JsonRecord = {
    ...item.record,
    evidence_score: Math.round(item.score),
    evidence_reason: item.reason
  };
  if (!includeBody) delete output["body_excerpt"];
  return output;
}

function buildEvidenceSelection(
  documents: unknown[],
  options: {
    mode: EvidenceSelectionMode;
    topicText: string;
    selectedLimit: number;
    bodyLimit: number;
  }
): EvidenceSelection {
  const terms = evidenceTopicTerms(options.topicText);
  const seen = new Set<string>();
  const records = documents
    .map(evidenceDocumentRecord)
    .filter((record): record is JsonRecord => Boolean(record))
    .filter((record) => {
      const key = evidenceDocumentKey(record);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const scored = records.map<ScoredEvidenceDocument>((record) => {
    const sourceScore = evidenceSourceScore(record);
    const relevance = evidenceRelevance(record, terms);
    const recencyScore = evidenceRecencyScore(record);
    const importance = numberValue(record.importance_score) ?? 0;
    const lowQuality = evidenceLowQuality(record);
    const isPrimary = sourceScore >= 80;
    const isContradicting = evidenceContradicting(record);
    const hasBody = Boolean(trimText(record.body_excerpt, 20));
    const sourceContribution = terms.length && relevance === 0 ? Math.min(sourceScore, 16) : Math.min(sourceScore, 82);
    const score =
      sourceContribution +
      relevance * (options.mode === "verification" ? 24 : 18) +
      recencyScore +
      importance * 18 +
      (hasBody && options.mode === "verification" ? 8 : 0) -
      (lowQuality ? 80 : 0);
    const reason = isPrimary && relevance > 0
      ? "primary_or_official_topic_match"
      : isPrimary
        ? "primary_or_official_context"
      : isContradicting
        ? "contradiction_or_risk_signal"
        : relevance > 0
          ? "topic_relevant_news"
          : "diversity_or_recent_context";
    return {
      record,
      key: evidenceDocumentKey(record),
      cluster: evidenceClusterKey(record),
      score,
      sourceScore,
      relevance,
      recencyScore,
      importance,
      lowQuality,
      hasBody,
      isPrimary,
      isContradicting,
      reason
    };
  });

  const eligible = scored.filter((item) => !item.lowQuality);
  const used = new Set<string>();
  const hasTopicTerms = terms.length > 0;
  const primary = selectDiverseEvidence(
    eligible.filter((item) => item.isPrimary && evidenceRelevanceGate(item, hasTopicTerms)),
    options.mode === "discovery" ? 6 : 8,
    used
  );
  const contradicting = selectDiverseEvidence(
    eligible.filter((item) => item.isContradicting && evidenceRelevanceGate(item, hasTopicTerms)),
    options.mode === "discovery" ? 4 : 8,
    used
  );
  const supporting = selectDiverseEvidence(
    eligible.filter((item) => !item.isPrimary && !item.isContradicting && evidenceRelevanceGate(item, hasTopicTerms)),
    Math.max(0, options.selectedLimit - primary.length - contradicting.length),
    used
  );
  const contextualPrimary = selectDiverseEvidence(
    eligible.filter((item) => item.isPrimary && !used.has(item.key)),
    Math.max(0, Math.min(options.mode === "discovery" ? 1 : 2, options.selectedLimit - primary.length - contradicting.length - supporting.length)),
    used
  );
  const selected = [...primary, ...contradicting, ...supporting, ...contextualPrimary]
    .sort((a, b) => b.score - a.score)
    .slice(0, options.selectedLimit);
  const selectedKeys = new Set(selected.map((item) => item.key));
  const bodyKeys = new Set(
    selected
      .filter((item) => item.hasBody)
      .sort((a, b) => b.relevance * 100 + b.sourceScore - (a.relevance * 100 + a.sourceScore))
      .slice(0, options.bodyLimit)
      .map((item) => item.key)
  );
  const missingBodyCandidates = selected
    .filter((item) => !item.hasBody && typeof item.record.url === "string")
    .slice(0, 10);

  return {
    documents: selected.map((item) => compactEvidenceDocument(item, bodyKeys.has(item.key))),
    evidence_pack: {
      mode: options.mode,
      topic_terms: terms,
      selection_summary: {
        input_documents: records.length,
        selected_documents: selected.length,
        body_excerpt_included: bodyKeys.size,
        low_quality_excluded: scored.filter((item) => item.lowQuality).length,
        duplicate_or_invalid_excluded: documents.length - records.length,
        selected_limit: options.selectedLimit,
        body_limit: options.bodyLimit
      },
      selected_document_ids: selected.map((item) => item.record.id).filter(Boolean),
      primary_sources: primary.filter((item) => selectedKeys.has(item.key)).map(evidenceReference),
      supporting_news: supporting.filter((item) => selectedKeys.has(item.key)).slice(0, 12).map(evidenceReference),
      contradicting_news: contradicting.filter((item) => selectedKeys.has(item.key)).map(evidenceReference),
      missing_body_candidates: missingBodyCandidates.map(evidenceReference),
      excluded_policy: {
        low_quality_examples: scored.filter((item) => item.lowQuality).slice(0, 5).map(evidenceReference),
        note: "Low-quality listicles/ranking-style articles are kept out of evidence and should only be used as weak leads."
      }
    }
  };
}

function evidenceTopicFromPayload(payload: JsonRecord): string {
  const hypothesis = asJsonRecord(payload.hypothesis);
  const company = asJsonRecord(payload.company);
  const context = asJsonRecord(payload.context);
  const parts: string[] = [];
  appendTextParts(parts, payload.focus);
  appendTextParts(parts, payload.sector);
  appendTextParts(parts, hypothesis.title);
  appendTextParts(parts, hypothesis.summary);
  appendTextParts(parts, hypothesis.target_sector);
  appendTextParts(parts, hypothesis.growth_driver);
  appendTextParts(parts, hypothesis.required_evidence);
  appendTextParts(parts, hypothesis.risk_factors);
  appendTextParts(parts, company.name ?? company.ticker);
  appendTextParts(parts, company.sector ?? company.industry);
  appendTextParts(parts, context.effective_search ?? context.requested_sector);
  return parts.join(" ");
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

type LlmPromptPayloadMode = "discovery" | "agent";

type LlmPromptBudget = {
  mode: LlmPromptPayloadMode;
  documentLimit: number;
  bodyLimit: number;
  evidenceReferenceLimit: number;
  recentEventLimit: number;
  companyLimit: number;
  macroIndicatorLimit: number;
  sectorSnapshotLimit: number;
  priceLimit: number;
  loopHistoryLimit: number;
  collectorHistoryLimit: number;
  existingHypothesisLimit: number;
  agentMemoryLimit: number;
  promptChars: number;
  maxBytes: number;
};

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  const value = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(min, Math.min(value, max));
}

function llmPromptBudget(mode: LlmPromptPayloadMode, hypothesisType?: string): LlmPromptBudget {
  const isDiscovery = mode === "discovery";
  const isCompany = hypothesisType === "company";
  return {
    mode,
    documentLimit: intEnv(isDiscovery ? "LLM_DISCOVERY_DOCUMENT_LIMIT" : "LLM_AGENT_DOCUMENT_LIMIT", isDiscovery ? 14 : isCompany ? 16 : 14, 6, 40),
    bodyLimit: intEnv(isDiscovery ? "LLM_DISCOVERY_BODY_LIMIT" : "LLM_AGENT_BODY_LIMIT", isDiscovery ? 1 : isCompany ? 3 : 2, 0, 8),
    evidenceReferenceLimit: intEnv("LLM_EVIDENCE_REFERENCE_LIMIT", isDiscovery ? 8 : 10, 4, 24),
    recentEventLimit: intEnv("LLM_RECENT_EVENT_LIMIT", isDiscovery ? 8 : 10, 0, 30),
    companyLimit: intEnv(isDiscovery ? "LLM_DISCOVERY_COMPANY_LIMIT" : "LLM_AGENT_COMPANY_LIMIT", isDiscovery ? 24 : isCompany ? 0 : 16, 0, 60),
    macroIndicatorLimit: intEnv("LLM_MACRO_INDICATOR_LIMIT", isDiscovery ? 8 : 8, 0, 20),
    sectorSnapshotLimit: intEnv("LLM_SECTOR_SNAPSHOT_LIMIT", isDiscovery ? 8 : 10, 0, 24),
    priceLimit: intEnv("LLM_PRICE_LIMIT", isCompany ? 60 : 0, 0, 120),
    loopHistoryLimit: intEnv("LLM_LOOP_HISTORY_LIMIT", 6, 1, 12),
    collectorHistoryLimit: intEnv("LLM_COLLECTOR_HISTORY_LIMIT", 2, 0, 5),
    existingHypothesisLimit: intEnv("LLM_EXISTING_HYPOTHESIS_LIMIT", isDiscovery ? 16 : 6, 0, 40),
    agentMemoryLimit: intEnv("LLM_AGENT_MEMORY_LIMIT", isDiscovery ? 4 : 0, 0, 12),
    promptChars: intEnv(isDiscovery ? "LLM_DISCOVERY_PROMPT_CHARS" : "LLM_AGENT_PROMPT_CHARS", isDiscovery ? 12_000 : 11_000, 6_000, 18_000),
    maxBytes: intEnv(isDiscovery ? "LLM_DISCOVERY_PAYLOAD_MAX_BYTES" : "LLM_AGENT_PAYLOAD_MAX_BYTES", isDiscovery ? 55_000 : 50_000, 20_000, 120_000)
  };
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asJsonRecord).filter((item) => Object.keys(item).length > 0) : [];
}

function promptRecordText(record: JsonRecord, fields: string[]): string {
  return normalizeCollectorText(fields.map((field) => record[field]).join(" ")).toLowerCase();
}

function promptTopicScore(record: JsonRecord, topicTerms: string[], fields: string[]): number {
  if (!topicTerms.length) return 0;
  const text = promptRecordText(record, fields);
  return topicTerms.reduce((score, term) => {
    const normalized = normalizeCollectorText(term).toLowerCase();
    if (!normalized) return score;
    return score + (text.includes(normalized) ? 1 : 0);
  }, 0);
}

function publishedRecencyScore(value: unknown): number {
  if (typeof value !== "string") return 0;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  if (ageDays <= 30) return 8;
  if (ageDays <= 120) return 5;
  if (ageDays <= 365) return 3;
  return 0;
}

function selectPromptRecords(
  value: unknown,
  options: {
    limit: number;
    topicText: string;
    scoreFields: string[];
    compact: (record: JsonRecord) => JsonRecord;
    extraScore?: (record: JsonRecord) => number;
    key?: (record: JsonRecord) => string;
  }
): JsonRecord[] {
  if (options.limit <= 0) return [];
  const topicTerms = evidenceTopicTerms(options.topicText);
  const seen = new Set<string>();
  return asRecordArray(value)
    .map((record, index) => {
      const key = options.key?.(record) ?? String(record.id ?? record.url ?? record.title ?? index);
      const score =
        promptTopicScore(record, topicTerms, options.scoreFields) * 100 +
        (options.extraScore?.(record) ?? 0) +
        publishedRecencyScore(record.published_at);
      return { record, index, key: key.normalize("NFKC").toLowerCase(), score };
    })
    .filter((item) => {
      if (!item.key || seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, options.limit)
    .map((item) => options.compact(item.record));
}

function compactEventForPrompt(record: JsonRecord): JsonRecord {
  return {
    id: record.id,
    ticker: record.ticker,
    company_name: record.company_name,
    sector: record.sector,
    event_type: record.event_type,
    title: trimText(record.title, 160),
    summary: trimText(record.summary, 240),
    sentiment: record.sentiment,
    impact_score: record.impact_score,
    published_at: record.published_at
  };
}

function eventPromptKey(record: JsonRecord): string {
  const date = typeof record.published_at === "string" ? record.published_at.slice(0, 10) : "";
  const title = normalizeCollectorText(String(record.title ?? "")).replace(/[0-9０-９年月日\s]+/g, "").slice(0, 80);
  return [record.ticker, record.company_name, title, date].filter(Boolean).join(":");
}

function selectPromptEvents(events: unknown, topicText: string, limit: number): JsonRecord[] {
  return selectPromptRecords(events, {
    limit,
    topicText,
    scoreFields: ["ticker", "company_name", "sector", "event_type", "title", "summary"],
    key: eventPromptKey,
    extraScore: (record) => (numberValue(record.impact_score) ?? 0) * 12,
    compact: compactEventForPrompt
  });
}

function compactMacroIndicatorForPrompt(record: JsonRecord): JsonRecord {
  return {
    symbol: record.symbol,
    label: record.label,
    date: record.date,
    close: record.close,
    change_percent: record.change_percent,
    source_name: record.source_name
  };
}

function compactSectorSnapshotForPrompt(record: JsonRecord): JsonRecord {
  return {
    sector: record.sector,
    company_count: record.company_count,
    avg_revenue_growth: record.avg_revenue_growth,
    avg_operating_profit_growth: record.avg_operating_profit_growth,
    avg_operating_margin: record.avg_operating_margin,
    avg_roe: record.avg_roe,
    event_count: record.event_count,
    avg_impact_score: record.avg_impact_score,
    latest_event_at: record.latest_event_at
  };
}

function compactCompanyForPrompt(record: JsonRecord): JsonRecord {
  const metrics = asJsonRecord(record.latest_metrics);
  return {
    ticker: record.ticker,
    name: record.name,
    sector: record.sector,
    industry: record.industry,
    business_summary: trimText(record.business_summary ?? record.description, 180),
    market_cap: record.market_cap,
    latest_metrics: {
      revenue_growth: metrics.revenue_growth,
      operating_profit_growth: metrics.operating_profit_growth,
      operating_margin: metrics.operating_margin,
      roe: metrics.roe,
      per: metrics.per,
      pbr: metrics.pbr,
      date: metrics.date
    }
  };
}

function companyPromptScore(record: JsonRecord): number {
  const metrics = asJsonRecord(record.latest_metrics);
  return (
    (numberValue(metrics.operating_profit_growth) ?? 0) * 1.2 +
    (numberValue(metrics.revenue_growth) ?? 0) +
    (numberValue(metrics.operating_margin) ?? 0) * 0.2 +
    (numberValue(metrics.roe) ?? 0) * 0.2
  );
}

function compactEvidencePackForPrompt(pack: JsonRecord, budget: LlmPromptBudget): JsonRecord {
  return {
    mode: pack.mode,
    topic_terms: Array.isArray(pack.topic_terms) ? pack.topic_terms.slice(0, 14) : [],
    selection_summary: pack.selection_summary,
    selected_document_ids: Array.isArray(pack.selected_document_ids) ? pack.selected_document_ids.slice(0, budget.documentLimit) : [],
    primary_sources: asRecordArray(pack.primary_sources).slice(0, budget.evidenceReferenceLimit),
    supporting_news: asRecordArray(pack.supporting_news).slice(0, budget.evidenceReferenceLimit),
    contradicting_news: asRecordArray(pack.contradicting_news).slice(0, budget.evidenceReferenceLimit),
    missing_body_candidates: asRecordArray(pack.missing_body_candidates).slice(0, Math.min(6, budget.evidenceReferenceLimit)),
    excluded_policy: {
      note: trimText(asJsonRecord(pack.excluded_policy).note, 220)
    }
  };
}

function compactCollectorHistoryForPrompt(value: unknown, limit: number): JsonRecord[] {
  return asRecordArray(value)
    .slice(-limit)
    .map((history) => ({
      query: trimText(history.query, 180),
      data_requirements: compactTextList(history.data_requirements, 5),
      thematic_queries: compactRecordList(history.thematic_queries, 5, ["query", "reason"]),
      operations: compactRecordList(history.operations, 10, ["operation", "source", "input", "reason", "ok", "duration_ms", "error"]),
      errors: compactTextList(history.errors, 6),
      collected_at: history.collected_at
    }));
}

function compactPromptContext(context: JsonRecord, topicText: string, budget: LlmPromptBudget): JsonRecord {
  return {
    mode: context.mode,
    requested_sector: context.requested_sector,
    effective_search: context.effective_search,
    evidence_selection: context.evidence_selection,
    company_universe_summary: context.company_universe_summary,
    collector_focus: context.collector_focus
      ? {
          query: trimText(asJsonRecord(context.collector_focus).query, 180),
          data_requirements: compactTextList(asJsonRecord(context.collector_focus).data_requirements, 6),
          data_requests: compactRecordList(asJsonRecord(context.collector_focus).data_requests, 6, ["query", "source", "reason", "priority", "ticker"]),
          thematic_queries: compactRecordList(asJsonRecord(context.collector_focus).thematic_queries, 5, ["query", "reason"])
        }
      : undefined,
    macro_indicators: selectPromptRecords(context.macro_indicators, {
      limit: budget.macroIndicatorLimit,
      topicText,
      scoreFields: ["symbol", "label", "source_name"],
      compact: compactMacroIndicatorForPrompt
    }),
    sector_snapshots: selectPromptRecords(context.sector_snapshots, {
      limit: budget.sectorSnapshotLimit,
      topicText,
      scoreFields: ["sector"],
      extraScore: (record) => (numberValue(record.avg_impact_score) ?? 0) * 10 + (numberValue(record.event_count) ?? 0) * 0.2,
      compact: compactSectorSnapshotForPrompt
    }),
    recent_events: selectPromptEvents(context.recent_events, topicText, budget.recentEventLimit),
    data_warnings: Array.isArray(context.data_warnings) ? context.data_warnings.slice(0, 8) : [],
    compaction_counts: {
      macro_indicators_available: Array.isArray(context.macro_indicators) ? context.macro_indicators.length : 0,
      sector_snapshots_available: Array.isArray(context.sector_snapshots) ? context.sector_snapshots.length : 0,
      recent_events_available: Array.isArray(context.recent_events) ? context.recent_events.length : 0
    }
  };
}

function compactAgentHandoffForPrompt(value: unknown, limit: number): JsonRecord {
  const handoff = asJsonRecord(value);
  const history = asRecordArray(handoff.loop_history).slice(-limit).map(loopOutputExcerpt);
  const previous = history.at(-1) ?? null;
  return {
    to_agent: handoff.to_agent,
    from_agent: handoff.from_agent ?? previous?.agent_name ?? null,
    previous_output: previous,
    loop_history: history,
    instruction: handoff.instruction
  };
}

function enforcePromptByteBudget(payload: JsonRecord, budget: LlmPromptBudget): JsonRecord {
  const output: JsonRecord = { ...payload };
  for (let pass = 0; pass < 8 && jsonByteLength(output) > budget.maxBytes; pass += 1) {
    const context = asJsonRecord(output.context);
    const documents = Array.isArray(output.documents) ? output.documents : [];
    const events = Array.isArray(context.recent_events) ? context.recent_events : [];
    const companies = Array.isArray(output.companies) ? output.companies : [];
    const sectorSnapshots = Array.isArray(context.sector_snapshots) ? context.sector_snapshots : [];
    const macroIndicators = Array.isArray(context.macro_indicators) ? context.macro_indicators : [];
    if (documents.length > 6) {
      output.documents = documents.slice(0, Math.max(6, Math.ceil(documents.length * 0.7)));
    } else if (events.length > 4) {
      output.context = { ...context, recent_events: events.slice(0, Math.max(4, Math.ceil(events.length * 0.7))) };
    } else if (companies.length > 6) {
      output.companies = companies.slice(0, Math.max(6, Math.ceil(companies.length * 0.7)));
    } else if (sectorSnapshots.length > 4) {
      output.context = { ...context, sector_snapshots: sectorSnapshots.slice(0, Math.max(4, Math.ceil(sectorSnapshots.length * 0.7))) };
    } else if (macroIndicators.length > 4) {
      output.context = { ...context, macro_indicators: macroIndicators.slice(0, Math.max(4, Math.ceil(macroIndicators.length * 0.7))) };
    } else {
      break;
    }
  }
  return output;
}

function preparePayloadForLlmPrompt(
  payload: JsonRecord,
  options: { mode: LlmPromptPayloadMode; agentName?: AgentName; hypothesisType?: string; topicText?: string }
): JsonRecord {
  const budget = llmPromptBudget(options.mode, options.hypothesisType);
  const topicText = options.topicText ?? evidenceTopicFromPayload(payload);
  const evidence = buildEvidenceSelection(Array.isArray(payload.documents) ? payload.documents : [], {
    mode: options.mode === "discovery" ? "discovery" : "verification",
    topicText,
    selectedLimit: budget.documentLimit,
    bodyLimit: budget.bodyLimit
  });
  const compacted: JsonRecord = {
    ...payload,
    documents: evidence.documents,
    evidence_pack: compactEvidencePackForPrompt(asJsonRecord(evidence.evidence_pack), budget),
    context: {
      ...compactPromptContext(asJsonRecord(payload.context), topicText, budget),
      evidence_selection: asJsonRecord(evidence.evidence_pack).selection_summary
    },
    companies: selectPromptRecords(payload.companies, {
      limit: budget.companyLimit,
      topicText,
      scoreFields: ["ticker", "name", "sector", "industry", "business_summary", "description"],
      extraScore: companyPromptScore,
      compact: compactCompanyForPrompt,
      key: (record) => String(record.ticker ?? record.name ?? "")
    }),
    prices: Array.isArray(payload.prices) ? payload.prices.slice(-budget.priceLimit) : [],
    existing_hypotheses: compactRecordList(payload.existing_hypotheses, budget.existingHypothesisLimit, [
      "id",
      "hypothesis_type",
      "title",
      "summary",
      "status",
      "growth_driver",
      "final_decision",
      "score_overall"
    ]),
    agent_memory: asRecordArray(payload.agent_memory).slice(0, budget.agentMemoryLimit),
    collector_history: compactCollectorHistoryForPrompt(payload.collector_history, budget.collectorHistoryLimit),
    loop_history: asRecordArray(payload.loop_history).slice(-budget.loopHistoryLimit).map(loopOutputExcerpt),
    agent_handoff: compactAgentHandoffForPrompt(payload.agent_handoff, budget.loopHistoryLimit),
    llm_prompt_budget_chars: budget.promptChars,
    llm_output_max_tokens:
      payload.llm_output_max_tokens ??
      (options.mode === "discovery"
        ? Math.max(3000, Math.min(4096, 1600 + (numberValue(payload.limit) ?? 3) * 900))
        : options.agentName === "researcher"
          ? 4096
          : 3072),
    llm_input_budget: {
      mode: budget.mode,
      max_bytes: budget.maxBytes,
      documents_limit: budget.documentLimit,
      body_limit: budget.bodyLimit,
      recent_event_limit: budget.recentEventLimit,
      company_limit: budget.companyLimit,
      macro_indicator_limit: budget.macroIndicatorLimit,
      sector_snapshot_limit: budget.sectorSnapshotLimit,
      original_counts: {
        documents: Array.isArray(payload.documents) ? payload.documents.length : 0,
        companies: Array.isArray(payload.companies) ? payload.companies.length : 0,
        prices: Array.isArray(payload.prices) ? payload.prices.length : 0,
        macro_indicators: Array.isArray(asJsonRecord(payload.context).macro_indicators) ? (asJsonRecord(payload.context).macro_indicators as unknown[]).length : 0,
        sector_snapshots: Array.isArray(asJsonRecord(payload.context).sector_snapshots) ? (asJsonRecord(payload.context).sector_snapshots as unknown[]).length : 0,
        recent_events: Array.isArray(asJsonRecord(payload.context).recent_events) ? (asJsonRecord(payload.context).recent_events as unknown[]).length : 0
      }
    }
  };
  const fitted = enforcePromptByteBudget(compacted, budget);
  fitted.llm_input_budget = {
    ...asJsonRecord(fitted.llm_input_budget),
    final_bytes: jsonByteLength(fitted),
    final_counts: {
      documents: Array.isArray(fitted.documents) ? fitted.documents.length : 0,
      companies: Array.isArray(fitted.companies) ? fitted.companies.length : 0,
      prices: Array.isArray(fitted.prices) ? fitted.prices.length : 0,
      macro_indicators: Array.isArray(asJsonRecord(fitted.context).macro_indicators) ? (asJsonRecord(fitted.context).macro_indicators as unknown[]).length : 0,
      sector_snapshots: Array.isArray(asJsonRecord(fitted.context).sector_snapshots) ? (asJsonRecord(fitted.context).sector_snapshots as unknown[]).length : 0,
      recent_events: Array.isArray(asJsonRecord(fitted.context).recent_events) ? (asJsonRecord(fitted.context).recent_events as unknown[]).length : 0
    }
  };
  fitted.input_summary = {
    ...asJsonRecord(payload.input_summary),
    llm_input_budget: fitted.llm_input_budget
  };
  return fitted;
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

function companyUniverseForGlobalHypothesis(companies: Company[], focus?: string, sector?: string, limit = 90): Company[] {
  const normalizedLimit = Math.max(20, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 90, 180));
  return companies
    .map((company) => ({ company, score: companyDiscoveryScore(company, focus, sector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, normalizedLimit)
    .map((item) => item.company);
}

function discoveryContextSummary(payload: JsonRecord): JsonRecord {
  const context = asJsonRecord(payload.context);
  const evidencePack = asJsonRecord(payload.evidence_pack);
  return {
    focus: payload.focus,
    sector: payload.sector,
    documents_sent: Array.isArray(payload.documents) ? payload.documents.length : 0,
    evidence_selection: asJsonRecord(evidencePack.selection_summary),
    companies_sent: Array.isArray(payload.companies) ? payload.companies.length : 0,
    existing_hypotheses_sent: Array.isArray(payload.existing_hypotheses) ? payload.existing_hypotheses.length : 0,
    agent_memory_sent: Array.isArray(payload.agent_memory) ? payload.agent_memory.length : 0,
    macro_indicators_sent: Array.isArray(context.macro_indicators) ? context.macro_indicators.length : 0,
    sector_snapshots_sent: Array.isArray(context.sector_snapshots) ? context.sector_snapshots.length : 0,
    recent_events_sent: Array.isArray(context.recent_events) ? context.recent_events.length : 0
  };
}

function discoveryMaxCollectorRounds(): number {
  const configured = Number(process.env.DISCOVERY_MAX_COLLECTOR_ROUNDS ?? 1);
  return Math.max(0, Math.min(Number.isFinite(configured) ? Math.floor(configured) : 1, 3));
}

function discoveryNextAction(output: JsonRecord): string {
  return String(output.next_action ?? "").trim();
}

function discoveryHasCandidates(output: JsonRecord): boolean {
  return Array.isArray(output.hypotheses) && output.hypotheses.some((item) => trimText(asJsonRecord(item).title, 220));
}

function discoveryOutputNeedsCollector(output: JsonRecord): boolean {
  return discoveryNextAction(output) === "request_data";
}

async function runDiscoveryAgentLoop(params: {
  basePayload: JsonRecord;
  focus?: string;
  sector?: string;
  query: string;
  since: string;
  lookbackDays: number;
  documentLimit: number;
  promoteLimit: number;
  context: ApiRequestContext;
}): Promise<{ output: JsonRecord; payload: JsonRecord; llmPayload: JsonRecord; discoveryRuns: JsonRecord[]; collectorOperations: JsonRecord[]; collectorErrors: string[] }> {
  const maxCollectorRounds = discoveryMaxCollectorRounds();
  const discoveryRuns: JsonRecord[] = [];
  const collectorOperations: JsonRecord[] = [];
  const collectorErrors: string[] = [];
  let workingPayload: JsonRecord = {
    ...params.basePayload,
    discovery_depth_policy: {
      purpose: "candidate_generation_not_full_verification",
      max_collector_rounds: maxCollectorRounds,
      save_draft_when_testable_candidate_exists: true,
      request_data_only_when_no_candidate_should_be_saved: true,
      verification_belongs_to_hypothesis_loop: true
    }
  };
  let llmPayload: JsonRecord = preparePayloadForLlmPrompt(workingPayload, {
    mode: "discovery",
    hypothesisType: "global",
    topicText: [params.focus, params.sector, params.query].filter(Boolean).join(" ")
  });
  let output: JsonRecord = {};

  for (let turn = 1; turn <= maxCollectorRounds + 1; turn += 1) {
    throwIfAborted(params.context.signal);
    output = await researchPost<JsonRecord>("/hypotheses/discover", llmPayload, params.context);
    discoveryRuns.push({
      turn,
      agent_name: "discovery",
      next_action: output.next_action ?? null,
      reason: trimText(output.reason, 500),
      hypotheses: Array.isArray(output.hypotheses) ? output.hypotheses.length : 0,
      signals: Array.isArray(output.signals) ? output.signals.length : 0,
      llm_json_repaired: output.llm_json_repaired === true,
      context_summary: discoveryContextSummary(llmPayload)
    });
    throwIfAborted(params.context.signal);

    if (!discoveryOutputNeedsCollector(output) || turn > maxCollectorRounds) break;

    const collectorResult = await runCollectorTurn({
      basePayload: workingPayload,
      previousOutput: {
        ...output,
        agent_name: "discovery"
      },
      hypothesisType: "global",
      ticker: null,
      sector: params.sector ?? params.focus,
      since: params.since,
      lookbackDays: params.lookbackDays,
      documentLimit: params.documentLimit,
      priceLimit: 0
    });
    workingPayload = {
      ...collectorResult.payload,
      discovery_history: [
        ...(Array.isArray(workingPayload.discovery_history) ? workingPayload.discovery_history : []),
        loopOutputExcerpt({ ...output, agent_name: "discovery" })
      ]
    };
    const collectorOutput = collectorResult.output;
    collectorOperations.push(...(Array.isArray(collectorOutput.operations) ? collectorOutput.operations.map(asJsonRecord) : []));
    if (Array.isArray(collectorOutput.errors)) collectorErrors.push(...collectorOutput.errors.map(String));
    discoveryRuns.push({
      turn,
      agent_name: "collector",
      next_action: collectorOutput.next_action ?? null,
      next_agent: collectorOutput.next_agent ?? null,
      reason: trimText(collectorOutput.reason_for_next_action, 500),
      tool_calls: Array.isArray(collectorOutput.tool_calls) ? collectorOutput.tool_calls.length : 0,
      errors: Array.isArray(collectorOutput.errors) ? collectorOutput.errors : []
    });
    llmPayload = preparePayloadForLlmPrompt(workingPayload, {
      mode: "discovery",
      hypothesisType: "global",
      topicText: [params.focus, params.sector, params.query].filter(Boolean).join(" ")
    });
  }

  return { output, payload: workingPayload, llmPayload, discoveryRuns, collectorOperations, collectorErrors };
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

type LlmAgentName = "hypothesis" | "skeptic" | "researcher";
type AgentName = LlmAgentName | "collector";

const HYPOTHESIS_LOOP_INSTRUCTION =
  "仮説検証、反証、深堀り・リサーチ、データ収集の工程がnext_agentで互いに呼び出しあいます。各工程はrouting_contextを見て、次に呼ぶべき工程を自律的に指定してください。APIはnext_action/next_agentを推測補完しません。制御値が欠落・不正な場合はそこで停止してログ化されます。データ不足ならnext_action=request_data、next_agent=collectorを明示してください。collectorは不足情報に応じて、政策・公的統計・信頼ニュース本文・指定された銘柄の決算/株価/ニュースを追加取得します。候補企業群の整理や統合判断はhypothesis/skeptic/researcherが担当します。finalizeできるのはresearcherだけですが、根拠と反証が不足している場合はfinalizeせず次工程を指定してください。";
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
    ui_summary: trimText(output.ui_summary, 220),
    reason: trimText(output.reason ?? output.reason_for_next_action ?? output.ui_summary, 400),
    handoff_text: trimText(output.handoff_text, 1200),
    claims: compactRecordList(output.claims, 5, ["claim", "evidence_ids", "confidence"]),
    questions: compactRecordList(output.questions, 5, ["question", "priority", "target_agent"]),
    global_analysis: Object.keys(asJsonRecord(output.global_analysis)).length ? asJsonRecord(output.global_analysis) : undefined,
    data_requests: compactRecordList(output.data_requests, 6, ["query", "source", "ticker", "reason", "priority"]),
    missing_information: compactTextList(output.missing_information, 6),
    recommended_next_research: compactTextList(output.recommended_next_research, 6),
    scores: Object.keys(asJsonRecord(output.scores)).length ? asJsonRecord(output.scores) : undefined,
    final_report: trimText(output.final_report, 600),
    llm_parse_failed: Boolean(output.llm_parse_failed || output.llm_parse_warning || output.llm_control_parse_warning || output.raw_model_output || output.llm_fallback)
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
      ? "前工程のhandoff_text/ui_summary/data_requests/missing_information/recommended_next_researchを引き継ぎ、重複を避けて次の工程を実行する。"
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
    appendTextParts(
      target,
      record.query ??
        record.question ??
        record.claim ??
        record.title ??
        record.summary ??
        record.reason ??
        record.description ??
        record.target ??
        record.source ??
        record.url
    );
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
  appendTextParts(parts, previousOutput?.data_requests);
  appendTextParts(parts, previousOutput?.tool_calls);
  appendTextParts(parts, previousOutput?.claims);
  appendTextParts(parts, previousOutput?.ui_summary);
  appendTextParts(parts, previousOutput?.handoff_text);
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

function collectorThematicQueries(baseQuery: string, topicText: string, dataRequests: JsonRecord[] = []): Array<{ query: string; reason: string }> {
  const text = topicText.toLowerCase();
  const queries: Array<{ query: string; reason: string }> = [];
  dataRequests.forEach((request) => {
    const query = collectorRequestQuery(request);
    if (!query) return;
    queries.push({
      query,
      reason: trimText(request.reason, 180) ?? "前工程のdata_requestsから作成した検索"
    });
  });
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

type CollectorTurnParams = {
  basePayload: JsonRecord;
  previousOutput: JsonRecord | null;
  hypothesisType: string;
  ticker: string | null;
  sector?: string;
  since: string;
  lookbackDays: number;
  documentLimit: number;
  priceLimit: number;
};

type CollectorToolName =
  | "db.reload_company_context"
  | "db.reload_global_context"
  | "market.fetch_company_foundation"
  | "net.fetch_macro_data"
  | "net.search_company_news"
  | "net.search_thematic_news"
  | "net.fetch_document_bodies";

type CollectorToolCall = {
  id: string;
  name: CollectorToolName;
  input: JsonRecord;
  reason: string;
  requested_by_agent?: string | null;
};

type CollectorToolResult = {
  tool_call_id: string;
  tool_name: CollectorToolName;
  ok: boolean;
  duration_ms: number;
  input: JsonRecord;
  result?: JsonRecord;
  error?: string;
};

type CollectorToolContext = {
  params: CollectorTurnParams;
  topicText: string;
  query: string;
  dataRequirements: string[];
  thematicQueries: Array<{ query: string; reason: string }>;
  dataRequests: JsonRecord[];
  nextPayload: JsonRecord;
  collectedNewsDocuments: DocumentRecord[];
  companyDocuments: DocumentRecord[];
};

type CollectorTool = {
  description: string;
  source: "db" | "network" | "mixed";
  execute: (context: CollectorToolContext, call: CollectorToolCall) => Promise<JsonRecord>;
};

function collectorRequestQuery(request: JsonRecord): string | null {
  return trimText(
    request.query ??
      request.question ??
      request.title ??
      request.target ??
      request.description ??
      request.reason ??
      request.claim,
    220
  );
}

function collectorStructuredRequests(previousOutput: JsonRecord | null): JsonRecord[] {
  if (!previousOutput) return [];
  const requests: JsonRecord[] = [];
  const pushRecord = (value: unknown, sourceHint?: string) => {
    if (typeof value === "string") {
      const query = trimText(value, 220);
      if (query) requests.push({ query, source: sourceHint ?? "web", reason: "前工程の不足情報から生成" });
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 16).forEach((item) => pushRecord(item, sourceHint));
      return;
    }
    const record = asJsonRecord(value);
    const query = collectorRequestQuery(record);
    if (!query) return;
    requests.push({
      ...record,
      query,
      source: typeof record.source === "string" ? record.source : sourceHint ?? "web",
      reason: trimText(record.reason ?? record.summary ?? record.description, 260) ?? "前工程からのCollector要求"
    });
  };

  pushRecord(previousOutput.data_requests);
  pushRecord(previousOutput.tool_calls);
  pushRecord(previousOutput.missing_information, "db");
  pushRecord(previousOutput.recommended_next_research, "web");
  pushRecord(previousOutput.questions, "db");

  const seen = new Set<string>();
  return requests.filter((request) => {
    const key = `${request.source ?? ""}:${collectorRequestQuery(request) ?? ""}`.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectorAvailableTools(): JsonRecord[] {
  return Object.entries(collectorTools).map(([name, tool]) => ({
    name,
    source: tool.source,
    description: tool.description
  }));
}

function collectorRequestedTickers(dataRequests: JsonRecord[]): string[] {
  const tickers = new Set<string>();
  for (const request of dataRequests) {
    const source = String(request.source ?? "").toLowerCase();
    const query = [
      request.ticker,
      request.query,
      request.target,
      request.company,
      request.company_name,
      request.reason
    ]
      .map((value) => String(value ?? ""))
      .join(" ");
    const sourceLooksCompanySpecific = /company|disclosure|market_data|ticker|銘柄|企業|開示|決算/.test(source);
    const matches = [...query.matchAll(/(?:^|[^\d])(\d{4,5})(?:\.T)?(?:[^\d]|$)/g)].map((match) => normalizeTicker(match[1]));
    if (sourceLooksCompanySpecific || matches.length) matches.forEach((ticker) => tickers.add(ticker));
  }
  return [...tickers].filter(Boolean).slice(0, 8);
}

function makeCollectorToolCall(
  index: number,
  name: CollectorToolName,
  input: JsonRecord,
  reason: string,
  requestedByAgent?: string | null
): CollectorToolCall {
  return {
    id: `collector_tool_${String(index + 1).padStart(2, "0")}`,
    name,
    input,
    reason,
    requested_by_agent: requestedByAgent
  };
}

function planCollectorToolCalls(context: CollectorToolContext): CollectorToolCall[] {
  const calls: CollectorToolCall[] = [];
  const requestedByAgent = typeof context.params.previousOutput?.agent_name === "string" ? context.params.previousOutput.agent_name : null;
  const add = (name: CollectorToolName, input: JsonRecord, reason: string) => {
    calls.push(makeCollectorToolCall(calls.length, name, input, reason, requestedByAgent));
  };

  if (context.params.hypothesisType === "company" && context.params.ticker) {
    add("market.fetch_company_foundation", { ticker: context.params.ticker }, "対象企業の基礎情報、決算、株価を取得する");
    add("net.search_company_news", { ticker: context.params.ticker, query: context.query }, "対象企業に関するニュースを過去期間で検索する");
    add("db.reload_company_context", { ticker: context.params.ticker, phase: "after_network_search" }, "DBから企業文書と株価を再読込する");
    add("net.fetch_document_bodies", { scope: "company", terms: collectorBodySearchTerms(context.topicText).slice(0, 12) }, "タイトル/URLのみの文書から本文を取得する");
    add("db.reload_company_context", { ticker: context.params.ticker, phase: "after_body_fetch" }, "本文取得後の文書をDBから再読込する");
    return calls;
  }

  add("net.fetch_document_bodies", { scope: "existing_payload", terms: collectorBodySearchTerms(context.topicText).slice(0, 12) }, "既に渡された文書の本文を優先取得する");
  add("net.fetch_macro_data", {}, "マクロ指数、金利、為替、商品市況を取得する");
  context.thematicQueries.forEach((thematicQuery) => {
    add(
      "net.search_thematic_news",
      { query: thematicQuery.query, lookback_days: context.params.lookbackDays },
      thematicQuery.reason
    );
  });
  collectorRequestedTickers(context.dataRequests).forEach((ticker) => {
    add("market.fetch_company_foundation", { ticker }, "他Agentが指定した銘柄の基礎情報、決算、株価、ニュースを取得する");
  });
  add("net.fetch_document_bodies", { scope: "global", terms: collectorBodySearchTerms(context.topicText).slice(0, 12) }, "検索・DB再読込で得たニュースや一次情報の本文を取得する");
  add(
    "db.reload_global_context",
    { search: globalSearchTerm(context.params.sector) ?? (context.query === "Japan" ? null : context.query), sector: context.params.sector ?? null },
    "DBから文書、マクロ、セクター、イベントを再読込して次工程へ渡す"
  );
  return calls;
}

async function executeCollectorTool(context: CollectorToolContext, call: CollectorToolCall): Promise<CollectorToolResult> {
  const startedAt = Date.now();
  const tool = collectorTools[call.name];
  try {
    const result = await tool.execute(context, call);
    return {
      tool_call_id: call.id,
      tool_name: call.name,
      ok: true,
      duration_ms: Date.now() - startedAt,
      input: call.input,
      result
    };
  } catch (error) {
    return {
      tool_call_id: call.id,
      tool_name: call.name,
      ok: false,
      duration_ms: Date.now() - startedAt,
      input: call.input,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function collectorResultErrors(result: CollectorToolResult): string[] {
  if (!result.ok) return [`${result.tool_name}: ${result.error ?? "unknown error"}`];
  const directErrors = Array.isArray(result.result?.errors) ? result.result.errors : [];
  const nested = asJsonRecord(result.result?.result);
  const nestedErrors = Array.isArray(nested.errors) ? nested.errors : [];
  return [...directErrors, ...nestedErrors].map((error) => `${result.tool_name}: ${String(error)}`);
}

const collectorTools: Record<CollectorToolName, CollectorTool> = {
  "market.fetch_company_foundation": {
    source: "network",
    description: "J-Quantsから企業基礎情報、決算、株価、企業ニュースを取得してDBへ保存する",
    async execute(context, call) {
      const ticker = normalizeOptionalTicker(call.input.ticker) ?? context.params.ticker;
      if (!ticker) return { skipped: true, reason: "ticker_missing" };
      const result = await fetchCompanyFoundation(ticker, {
        includePrices: true,
        includeStatements: true,
        includeNews: true,
        newsLookbackDays: context.params.lookbackDays,
        newsLimit: Math.min(300, Math.max(80, context.params.documentLimit * 2))
      });
      return { result };
    }
  },
  "net.search_company_news": {
    source: "network",
    description: "GDELT/RSSなどから企業関連ニュースを検索してDBへ保存する",
    async execute(context, call) {
      const ticker = normalizeOptionalTicker(call.input.ticker) ?? context.params.ticker;
      if (!ticker) return { skipped: true, reason: "ticker_missing" };
      const result = await fetchAndSaveCompanyNews(ticker, {
        query: typeof call.input.query === "string" ? call.input.query : context.query,
        lookbackDays: context.params.lookbackDays,
        limit: Math.min(300, Math.max(80, context.params.documentLimit * 2))
      });
      return compactNewsFetchResult(result as JsonRecord);
    }
  },
  "db.reload_company_context": {
    source: "db",
    description: "DBから企業、文書、株価を再読込して次工程のpayloadを更新する",
    async execute(context, call) {
      const ticker = normalizeOptionalTicker(call.input.ticker) ?? context.params.ticker;
      if (!ticker) return { skipped: true, reason: "ticker_missing" };
      const [documents, prices, company] = await Promise.all([
        listDocuments({ ticker, limit: Math.min(500, context.params.documentLimit * 2), since: context.params.since }),
        getPrices(ticker),
        getCompany(ticker)
      ]);
      context.companyDocuments = documents;
      context.nextPayload.documents = mergeCompactDocuments(context.nextPayload.documents, documents, context.params.documentLimit);
      context.nextPayload.prices = prices.slice(-context.params.priceLimit);
      context.nextPayload.company = company ?? context.nextPayload.company ?? null;
      return { documents: documents.length, prices: prices.length, company: company ? { ticker: company.ticker, name: company.name } : null };
    }
  },
  "net.fetch_document_bodies": {
    source: "mixed",
    description: "DBまたはpayload上の文書URLへアクセスし、本文を抽出してDBへ保存する",
    async execute(context, call) {
      const scope = typeof call.input.scope === "string" ? call.input.scope : "global";
      const terms = collectorBodySearchTerms(context.topicText);
      let candidates: DocumentRecord[] = [];

      if (scope === "company") {
        candidates = context.companyDocuments.length
          ? context.companyDocuments
          : context.params.ticker
            ? await listDocuments({ ticker: context.params.ticker, limit: Math.min(500, context.params.documentLimit * 2), since: context.params.since })
            : [];
      } else if (scope === "existing_payload") {
        candidates = payloadDocumentsForBodyFetch(context.params.basePayload);
      } else {
        const [targetedBodyCandidates, macroBodyCandidates, ...searchedBodyCandidateGroups] = await Promise.all([
          listDocuments({ sourceType: "news", search: globalSearchTerm(context.params.sector), sector: globalSearchTerm(context.params.sector), limit: 140, since: context.params.since }),
          listMacroNews(100),
          ...terms.slice(0, 8).map((term) => listDocuments({ sourceType: "news", search: term, limit: 80, since: context.params.since }))
        ]);
        candidates = [
          ...payloadDocumentsForBodyFetch(context.params.basePayload),
          ...context.collectedNewsDocuments,
          ...targetedBodyCandidates,
          ...macroBodyCandidates,
          ...searchedBodyCandidateGroups.flat()
        ];
      }

      const bodyCandidates = prioritizeBodyFetchDocuments(candidates, context.topicText);
      if (!bodyCandidates.length) {
        return {
          scope,
          skipped: true,
          reason: "no_relevant_body_candidates",
          terms: terms.slice(0, 12),
          candidates_preview: []
        };
      }

      const result = await fetchAndCacheDocumentBodies(bodyCandidates, {
        limit: collectorBodyFetchLimit(),
        maxChars: collectorBodyMaxChars()
      });
      return {
        scope,
        terms: terms.slice(0, 12),
        candidates_preview: bodyFetchPreview(bodyCandidates, context.topicText),
        result
      };
    }
  },
  "net.fetch_macro_data": {
    source: "network",
    description: "マクロ指数、為替、金利、商品市況、公式RSSを取得してDBへ保存する",
    async execute() {
      const result = await fetchMacroData();
      return { result };
    }
  },
  "net.search_thematic_news": {
    source: "network",
    description: "仮説・不足情報に基づくテーマ検索で、信頼ニュースと過去ニュースをDBへ保存する",
    async execute(context, call) {
      const query = typeof call.input.query === "string" ? call.input.query : context.query;
      if (!query || query === "Japan") return { skipped: true, reason: "query_empty_or_too_broad", query };
      const result = await fetchAndSaveMacroNews({
        query,
        lookbackDays: context.params.lookbackDays,
        limit: Math.min(220, Math.max(60, context.params.documentLimit))
      });
      if (Array.isArray(result.documents)) context.collectedNewsDocuments.push(...(result.documents as DocumentRecord[]));
      return { query, result: compactNewsFetchResult(result as JsonRecord) };
    }
  },
  "db.reload_global_context": {
    source: "db",
    description: "DBから文書、マクロ指標、セクター集計、イベントを再読込して次工程のpayloadを更新する",
    async execute(context, call) {
      const requestedSearch = typeof call.input.search === "string" && call.input.search.trim() ? call.input.search.trim() : undefined;
      const refreshed = await reloadGlobalResearchContext({
        search: requestedSearch,
        sector: context.params.sector,
        since: context.params.since,
        documentLimit: context.params.documentLimit
      });
      context.nextPayload.documents = mergeCompactDocuments(
        context.nextPayload.documents,
        refreshed.documents as unknown as DocumentRecord[],
        context.params.documentLimit
      );
      context.nextPayload.context = {
        ...refreshed.context,
        collector_focus: {
          query: context.query,
          data_requirements: context.dataRequirements,
          data_requests: context.dataRequests,
          thematic_queries: context.thematicQueries,
          available_tools: collectorAvailableTools(),
          topic_excerpt: trimText(context.topicText, 900)
        }
      };
      const payloadContext = asJsonRecord(context.nextPayload.context);
      return {
        documents: Array.isArray(context.nextPayload.documents) ? context.nextPayload.documents.length : 0,
        macro_indicators: Array.isArray(payloadContext.macro_indicators) ? payloadContext.macro_indicators.length : 0,
        sector_snapshots: Array.isArray(payloadContext.sector_snapshots) ? payloadContext.sector_snapshots.length : 0,
        recent_events: Array.isArray(payloadContext.recent_events) ? payloadContext.recent_events.length : 0
      };
    }
  }
};

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
  return nextAction === "finalize";
}

function hasLlmParseFailure(output: JsonRecord): boolean {
  return Boolean(output.llm_parse_failed || output.llm_parse_warning || output.llm_control_parse_warning || output.raw_model_output || output.llm_fallback);
}

function validateLoopControl(agentName: AgentName, output: JsonRecord): string | null {
  if (hasLlmParseFailure(output)) return trimText(output.llm_control_parse_warning ?? output.llm_parse_warning, 240) ?? "llm_control_parse_failed";
  const nextAction = normalizedNextAction(output);
  const requested = parseLoopAgentName(output.next_agent);

  if (!["call_agent", "request_data", "finalize", "stop"].includes(nextAction)) {
    return "next_action_missing_or_invalid";
  }
  if (typeof output.should_continue !== "boolean") {
    return "should_continue_missing_or_invalid";
  }
  if (nextAction === "call_agent") {
    if (requested !== "hypothesis" && requested !== "skeptic" && requested !== "researcher") {
      return "call_agent_requires_hypothesis_skeptic_or_researcher";
    }
    return null;
  }
  if (nextAction === "request_data") {
    if (requested !== "collector") return "request_data_requires_next_agent_collector";
    return null;
  }
  if (nextAction === "finalize") {
    if (agentName !== "researcher") return "only_researcher_can_finalize";
    if (output.next_agent !== null && output.next_agent !== undefined) return "finalize_requires_null_next_agent";
    return null;
  }
  if (nextAction === "stop") {
    if (output.next_agent !== null && output.next_agent !== undefined) return "stop_requires_null_next_agent";
    return null;
  }
  return "next_action_missing_or_invalid";
}

function nextAgentFromControl(output: JsonRecord): AgentName | null {
  return parseLoopAgentName(output.next_agent);
}

function loopSummary(output: JsonRecord): string | undefined {
  return trimText(output.ui_summary ?? output.reason ?? output.reason_for_next_action ?? output.final_report ?? output.handoff_text, 500) ?? undefined;
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
        role: "外部データ取得・DB再読込を行う非LLM工程。data_requestsを読み、DB検索、ネット検索、記事本文取得、指定銘柄の企業基礎データ取得などの関数ツールを実行する"
      }
    ],
    routing_guidance: [
      "next_agentはAPIではなく各エージェントが指定する",
      "APIはnext_action/next_agentを推測補完しない。不正・欠落時はinvalid_controlとして停止する",
      "同じエージェントを続けて呼ぶのは、新しい入力や明確な追加作業がある場合に限る",
      "データ不足で判断できない場合はcollectorを呼ぶ",
      "collectorで取得したデータは、反証または統合のどちらに渡すべきかを次工程で判断する",
      "ニュースがタイトル/URLだけで本文根拠が不足する場合はcollectorで本文取得を要求する",
      "collectorに渡す要求はdata_requestsへ query/source/reason/priority を具体的に書く",
      "候補企業群の整理、代表企業の選定、セクター内の勝ち筋の統合はhypothesis/skeptic/researcherが行い、collectorに丸投げしない",
      "global仮説ではcompany/ticker未指定が正常なので、それだけを理由に判断不能にしない",
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

async function runCollectorTurn(params: CollectorTurnParams): Promise<{ output: JsonRecord; payload: JsonRecord }> {
  const startedAt = Date.now();
  const topicText = normalizeCollectorText(collectorTextCorpus(params.basePayload, params.previousOutput));
  const query = collectorQuery(params.basePayload, params.previousOutput);
  const dataRequests = collectorStructuredRequests(params.previousOutput);
  const dataRequirements = collectorDataRequirements(topicText);
  const thematicQueries = collectorThematicQueries(query, topicText, dataRequests);
  const nextPayload: JsonRecord = { ...params.basePayload };

  const collectorContext: CollectorToolContext = {
    params,
    topicText,
    query,
    dataRequirements,
    thematicQueries,
      dataRequests,
      nextPayload,
      collectedNewsDocuments: [],
      companyDocuments: []
    };

  const toolCalls = planCollectorToolCalls(collectorContext);
  const toolResults: CollectorToolResult[] = [];
  const operations: JsonRecord[] = [];
  const errors: string[] = [];

  for (const toolCall of toolCalls) {
    const tool = collectorTools[toolCall.name];
    const result = await executeCollectorTool(collectorContext, toolCall);
    toolResults.push(result);
    errors.push(...collectorResultErrors(result));
    operations.push({
      operation: toolCall.name,
      tool_call_id: toolCall.id,
      source: tool.source,
      description: tool.description,
      input: toolCall.input,
      reason: toolCall.reason,
      ok: result.ok,
      duration_ms: result.duration_ms,
      result: result.result,
      error: result.error
    });
  }

  nextPayload.collector_history = [
    ...(Array.isArray(params.basePayload.collector_history) ? params.basePayload.collector_history : []),
    {
      query,
      data_requests: dataRequests,
      data_requirements: dataRequirements,
      thematic_queries: thematicQueries,
      available_tools: collectorAvailableTools(),
      tool_calls: toolCalls,
      tool_results: toolResults,
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
      data_requests: dataRequests,
      data_requirements: dataRequirements,
      thematic_queries: thematicQueries,
      available_tools: collectorAvailableTools(),
      tool_calls: toolCalls,
      tool_results: toolResults,
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
  context: ApiRequestContext;
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
    throwIfAborted(params.context.signal);
    const reachedSafetyTurn = turn === safetyMaxTurns;
    const agentName = currentAgent;
    const agentHandoff = buildAgentHandoff(agentName, agentRuns);
    const loopHistory = Array.isArray(agentHandoff.loop_history) ? agentHandoff.loop_history : [];
    const richTurnPayload: JsonRecord = {
      ...workingPayload,
      loop_turn: turn,
      loop_history: loopHistory,
      agent_handoff: agentHandoff,
      routing_context: routingContext(agentName, agentRuns),
      loop_instruction: HYPOTHESIS_LOOP_INSTRUCTION,
      turn_timeout_ms: config.researchTimeoutMs
    };
    const turnPayload = preparePayloadForLlmPrompt(richTurnPayload, {
      mode: "agent",
      agentName,
      hypothesisType: params.hypothesisType
    });
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
      if (params.context.signal.aborted) {
        const durationMs = Date.now() - turnStartedAt;
        const cancelledOutput: JsonRecord = {
          agent_name: agentName,
          input: inputSummary,
          loop_turn: turn,
          duration_ms: durationMs,
          turn_timeout_ms: config.researchTimeoutMs,
          next_action: "cancelled",
          next_agent: null,
          status: "cancelled",
          error: "request_cancelled"
        };
        await updateAgentRun(startedRun.id, {
          input: inputSummary,
          output: cancelledOutput,
          next_action: "cancelled",
          next_agent: null
        });
        logger.warn(
          {
            request_id: params.context.requestId,
            hypothesis_id: params.hypothesisId,
            turn,
            agent_name: agentName,
            duration_ms: durationMs
          },
          "hypothesis loop turn cancelled"
        );
        throwIfAborted(params.context.signal);
      }
    } else {
      try {
        agentOutput = await researchPost<JsonRecord>(`/agents/${agentName}`, turnPayload, params.context);
      } catch (error) {
        const durationMs = Date.now() - turnStartedAt;
        const details = error instanceof ResearchError ? normalizeDetails(error.details) : serializeError(error);
        const wasAborted = params.context.signal.aborted || hasAbortSignal(error);
        const failedOutput: JsonRecord = {
          agent_name: agentName,
          input: inputSummary,
          loop_turn: turn,
          duration_ms: durationMs,
          turn_timeout_ms: config.researchTimeoutMs,
          next_action: wasAborted ? "cancelled" : "error",
          next_agent: null,
          status: wasAborted ? "cancelled" : "error",
          error: wasAborted ? "request_cancelled" : "llm_request_failed",
          details
        };
        await updateAgentRun(startedRun.id, {
          input: { ...inputSummary, request_payload: turnPayload },
          output: failedOutput,
          next_action: wasAborted ? "cancelled" : "error",
          next_agent: null
        });
        const logPayload = {
          request_id: params.context.requestId,
          hypothesis_id: params.hypothesisId,
          turn,
          agent_name: agentName,
          duration_ms: durationMs,
          error: details
        };
        if (wasAborted) {
          logger.warn(logPayload, "hypothesis loop turn cancelled");
        } else {
          logger.error(logPayload, "hypothesis loop turn failed");
        }
        throw error;
      }
    }
    const durationMs = Date.now() - turnStartedAt;
    const controlError = validateLoopControl(agentName, agentOutput);
    const stopRequested = !controlError && normalizedNextAction(agentOutput) === "stop";
    const finalized = !controlError && researcherHasFinalized(agentName, agentOutput);
    const selectedNextAgent = finalized || stopRequested || controlError ? null : nextAgentFromControl(agentOutput);
    const nextAgent = finalized || stopRequested || controlError || reachedSafetyTurn ? null : selectedNextAgent;
    const runOutput: JsonRecord = {
      ...agentOutput,
      id: startedRun.id,
      status: controlError ? "invalid_control" : "completed",
      agent_name: agentName,
      input: inputSummary,
      loop_turn: turn,
      duration_ms: durationMs,
      turn_timeout_ms: config.researchTimeoutMs,
      requested_next_agent: agentOutput.next_agent ?? null,
      requested_next_action: agentOutput.next_action ?? null,
      control_error: controlError ?? undefined,
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
      control_error: controlError,
      duration_ms: durationMs,
      timeout_ms: config.researchTimeoutMs,
      summary: loopSummary(runOutput)
    };

    agentRuns.push(runOutput);
    loopTrace.push(traceItem);
    await updateAgentRun(startedRun.id, {
      input: inputSummary,
      output: runOutput,
      next_action: typeof runOutput.next_action === "string" ? runOutput.next_action : controlError ? "invalid_control" : undefined,
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
        control_error: controlError,
        duration_ms: durationMs,
        finalized
      },
      "hypothesis loop turn completed"
    );

    if (controlError || finalized || stopRequested || reachedSafetyTurn) {
      finalOutput = runOutput;
      stoppedReason = controlError
        ? "invalid_control"
        : finalized
          ? "researcher_finalized"
          : stopRequested
            ? "agent_stopped"
            : "safety_cap_reached";
      break;
    }

    if (!nextAgent) {
      finalOutput = runOutput;
      stoppedReason = "next_agent_missing";
      break;
    }
    currentAgent = nextAgent;
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
    const context = requestContext(req, res);
    const input = hypothesisDiscoverySchema.parse(req.body ?? {});
    const focus = input.focus?.trim() || undefined;
    const sector = input.sector?.trim() || undefined;
    const requestedLimit = input.limit ?? 3;
    const configuredPromoteLimit = Number(process.env.DISCOVERY_HYPOTHESIS_PROMOTE_LIMIT ?? 3);
    const promoteCap = Number.isFinite(configuredPromoteLimit) ? configuredPromoteLimit : 3;
    const promoteLimit = Math.max(1, Math.min(requestedLimit, promoteCap));
    const documentLimit = input.document_limit ?? 90;
    const configuredEvidenceLimit = Number(process.env.DISCOVERY_EVIDENCE_LIMIT ?? 24);
    const evidenceCap = Number.isFinite(configuredEvidenceLimit) ? configuredEvidenceLimit : 24;
    const evidenceLimit = Math.max(8, Math.min(documentLimit, evidenceCap));
    const configuredCompanyLimit = input.company_limit ?? Number(process.env.DISCOVERY_COMPANY_LIMIT ?? 60);
    const companyLimit = Math.max(30, Math.min(Number.isFinite(configuredCompanyLimit) ? Math.floor(configuredCompanyLimit) : 60, 220));
    const lookbackDays = input.lookback_days ?? Number(process.env.NEWS_LOOKBACK_DAYS ?? 450);
    const since = daysAgoIso(lookbackDays);
    const query = discoveryNewsQuery({ focus, sector });
    const operations: JsonRecord[] = [];
    const errors: string[] = [];

    throwIfAborted(context.signal);
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

    throwIfAborted(context.signal);
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
    const discoveryEvidence = buildEvidenceSelection(globalResearch.documents, {
      mode: "discovery",
      topicText: [focus, sector, query].filter(Boolean).join(" "),
      selectedLimit: evidenceLimit,
      bodyLimit: Number.isFinite(Number(process.env.DISCOVERY_BODY_EVIDENCE_LIMIT))
        ? Number(process.env.DISCOVERY_BODY_EVIDENCE_LIMIT)
        : 0
    });
    const payload: JsonRecord = {
      task: "discover_underappreciated_growth_hypotheses",
      focus: focus ?? null,
      sector: sector ?? null,
      limit: promoteLimit,
      requested_signal_limit: requestedLimit,
      lookback_days: lookbackDays,
      collector_operations: operations,
      collector_errors: errors,
      documents: discoveryEvidence.documents,
      evidence_pack: discoveryEvidence.evidence_pack,
      context: {
        ...globalResearch.context,
        evidence_selection: asJsonRecord(discoveryEvidence.evidence_pack).selection_summary
      },
      companies: companiesForDiscovery,
      existing_hypotheses: existingHypotheses.slice(0, 40).map((hypothesis) => compactHypothesisForResearch(hypothesis as JsonRecord)),
      agent_memory: agentMemory,
      hypothesis_creation_policy: {
        max_created_hypotheses: promoteLimit,
        requested_signal_limit: requestedLimit,
        do_not_split_minor_variants: true,
        use_backlog_signals_for_non_promoted_ideas: true
      },
      source_quality_policy: {
        primary_sources_first: ["timely_disclosure", "financial_statement", "company_profile", "official_statistics", "policy_document"],
        weak_leads_only: ["ranking_article", "listicle", "seo_growth_stock_article", "headline_only_news"],
        reject_if: [
          "二次情報だけで裏取りできない",
          "根拠文書のpublished_atが古く現在の事業環境と接続できない",
          "話題性だけで業績インパクトが示せない"
        ]
      },
      discovery_depth_policy: {
        purpose: "candidate_generation_not_full_verification",
        max_collector_rounds: discoveryMaxCollectorRounds(),
        save_draft_when_testable_candidate_exists: true,
        request_data_only_when_no_candidate_should_be_saved: true,
        verification_belongs_to_hypothesis_loop: true
      },
      llm_thinking_mode: input.llm_thinking_mode ?? "auto",
      input_summary: {
        mode: "hypothesis_discovery",
        focus,
        sector,
        query,
        documents_available: globalResearch.documents.length,
        documents_sent: discoveryEvidence.documents.length,
        evidence_selection: asJsonRecord(discoveryEvidence.evidence_pack).selection_summary,
        companies_sent: companiesForDiscovery.length,
        existing_hypotheses_sent: Math.min(40, existingHypotheses.length),
        agent_memory_sent: agentMemory.length,
        news_since: since
      }
    };

    throwIfAborted(context.signal);
    const discoveryLoop = await runDiscoveryAgentLoop({
      basePayload: payload,
      focus,
      sector,
      query,
      since,
      lookbackDays,
      documentLimit,
      promoteLimit,
      context
    });
    const output = discoveryLoop.output;
    const llmPayload = discoveryLoop.llmPayload;
    throwIfAborted(context.signal);
    const discoveryNextAction = String(output.next_action ?? "").trim();
    const candidateRecords =
      discoveryNextAction === "create_hypotheses" && Array.isArray(output.hypotheses)
        ? output.hypotheses.map(asJsonRecord).slice(0, promoteLimit)
        : [];
    const created: Hypothesis[] = [];
    const skipped: JsonRecord[] = [];

    if (input.create !== false && discoveryNextAction === "create_hypotheses") {
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
          input: discoveryContextSummary(llmPayload),
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
      discovery_runs: discoveryLoop.discoveryRuns,
      collector_operations: [...operations, ...discoveryLoop.collectorOperations],
      collector_errors: [...errors, ...discoveryLoop.collectorErrors],
      context_summary: discoveryContextSummary(llmPayload)
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
    const globalCompanyLimit = Number(req.body?.company_limit ?? process.env.GLOBAL_HYPOTHESIS_COMPANY_LIMIT ?? 60);
    let company: Awaited<ReturnType<typeof getCompany>> = undefined;
    let companiesForGlobal: Company[] = [];
    let documents: DocumentRecord[] = [];
    let prices: Awaited<ReturnType<typeof getPrices>> = [];
    let globalContext: JsonRecord = {};

    if (hypothesisType === "company" && ticker) {
      [company, documents, prices] = await Promise.all([getCompany(ticker), listDocuments({ ticker, limit: 80, since: researchSince }), getPrices(ticker)]);
    } else {
      const search = globalSearchTerm(sector);
      const [targetedDocuments, broadDocuments, macroIndicators, macroNews, sectorSnapshots, events, companies] = await Promise.all([
        listDocuments({ sourceType: "news", sector: search, search, limit: 140, since: researchSince }),
        listDocuments({ limit: 180, since: researchSince }),
        listMacroIndicators(16),
        listMacroNews(80),
        listSectorSnapshots(24),
        listEvents(),
        listCompanies(2000)
      ]);
      companiesForGlobal = companyUniverseForGlobalHypothesis(companies, String(hypothesisRecord.title ?? ""), sector, globalCompanyLimit);
      documents = dedupeDocuments([...(targetedDocuments.length ? targetedDocuments : []), ...macroNews, ...broadDocuments]).slice(0, 120);
      globalContext = {
        mode: "global_sector_research",
        requested_sector: sector ?? null,
        effective_search: search ?? null,
        company_universe_summary: {
          sent: companiesForGlobal.length,
          source: "listed_companies_db",
          responsibility: "hypothesis_skeptic_researcher_select_candidate_groups",
          note: "Collector does not select candidate companies; LLM agents use this universe to form company traits and representative groups."
        },
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
    const requestedDocumentLimit = Number(req.body?.document_limit);
    const defaultDocumentSendLimit = hypothesisType === "company" ? 24 : 32;
    const documentSendLimit = Math.max(
      8,
      Math.min(Number.isFinite(requestedDocumentLimit) ? Math.floor(requestedDocumentLimit) : defaultDocumentSendLimit, 80)
    );
    const evidenceSelection = buildEvidenceSelection(documents, {
      mode: "verification",
      topicText: evidenceTopicFromPayload({
        hypothesis,
        hypothesis_type: hypothesisType,
        company: company ?? null,
        context: globalContext
      }),
      selectedLimit: documentSendLimit,
      bodyLimit: Number.isFinite(Number(req.body?.body_limit)) ? Number(req.body?.body_limit) : hypothesisType === "company" ? 4 : 5
    });
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
        companies: companiesForGlobal.map(compactCompanyForDiscovery),
        documents: evidenceSelection.documents,
        evidence_pack: evidenceSelection.evidence_pack,
        prices: prices.slice(-priceSendLimit),
        context: {
          ...globalContext,
          evidence_selection: asJsonRecord(evidenceSelection.evidence_pack).selection_summary
        },
        llm_thinking_mode: req.body?.llm_thinking_mode ?? "auto",
        input_summary: {
          mode: hypothesisType === "company" ? "company_hypothesis" : "global_hypothesis",
          sector,
          ticker,
          documents_available: documents.length,
          documents_sent: evidenceSelection.documents.length,
          evidence_selection: asJsonRecord(evidenceSelection.evidence_pack).selection_summary,
          prices_available: prices.length,
          prices_sent: Math.min(priceSendLimit, prices.length),
          companies_sent: companiesForGlobal.length,
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
  if (res.headersSent || res.writableEnded) {
    logger.warn({ request_id: requestId, method: req.method, path: req.originalUrl, error: serializeError(error) }, "request failed after response closed");
    return;
  }

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
  logger[status === 499 ? "warn" : "error"]({ request_id: requestId, method: req.method, path: req.originalUrl, status, error: serializedError }, "request failed");
  res.status(status).json({
    error: status === 499 ? "request_cancelled" : status === 504 ? "timeout_error" : "internal_error",
    message:
      status === 499
        ? "Request was cancelled by the client"
        : status === 504
          ? "Upstream request timed out before the response reached the API"
          : typeof serializedError.message === "string"
            ? serializedError.message
            : "Unknown error",
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
