export type Company = {
  id: number;
  ticker: string;
  name: string;
  english_name?: string | null;
  market?: string | null;
  sector?: string | null;
  industry?: string | null;
  description?: string | null;
  business_summary?: string | null;
  fiscal_year_end?: string | null;
  market_cap?: number | string | null;
  latest_metrics?: Record<string, number | string | null> | null;
};

export type PricePoint = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover?: number;
  adjusted_close?: number;
};

export type MacroIndicator = {
  symbol: string;
  label: string;
  date: string;
  time?: string | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number;
  volume?: number | null;
  change?: number | null;
  change_percent?: number | null;
  source_name: string;
  source_url: string;
};

export type DocumentRecord = {
  id: number;
  ticker?: string | null;
  company_name?: string | null;
  source_type?: string | null;
  source_name?: string | null;
  title: string;
  url?: string | null;
  published_at?: string | null;
  storage_level?: string | null;
  retrieval_status?: string | null;
  summary_short?: string | null;
  summary_investment?: string | null;
  summary_risk?: string | null;
  key_points?: string[];
  event_type?: string | null;
  sentiment?: string | null;
  impact_horizon?: string | null;
  affected_metrics?: string[];
  importance_score?: number | string | null;
  confidence?: number | string | null;
};

export type EventRecord = {
  id: number;
  ticker?: string | null;
  company_name?: string | null;
  sector?: string | null;
  event_type?: string | null;
  title?: string | null;
  summary?: string | null;
  sentiment?: string | null;
  impact_score?: number | string | null;
  impact_horizon?: string | null;
  published_at?: string | null;
};

export type Hypothesis = {
  id: number;
  title: string;
  summary?: string | null;
  status?: string | null;
  hypothesis_type?: "global" | "company" | string | null;
  ticker?: string | null;
  company_name?: string | null;
  target_sector?: string | null;
  growth_driver?: string | null;
  required_evidence?: string[];
  risk_factors?: string[];
  missing_information?: string[];
  recommended_next_research?: string[];
  score_growth?: number | string | null;
  score_evidence?: number | string | null;
  score_contradiction?: number | string | null;
  score_valuation_risk?: number | string | null;
  score_overlooked?: number | string | null;
  score_overall?: number | string | null;
  final_decision?: string | null;
  final_report?: string | null;
  documents?: DocumentRecord[];
  agent_runs?: AgentRun[];
};

export type AgentRun = {
  id: number;
  agent_name: string;
  input?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  next_action?: string | null;
  next_agent?: string | null;
  created_at?: string | null;
};

export type Overview = {
  macro_summary: string[];
  macro_indicators?: MacroIndicator[];
  macro_news?: DocumentRecord[];
  sectors: { sector: string; attention_score: number; event_count: number }[];
  company_count?: number;
  companies: Company[];
  events: EventRecord[];
  documents: DocumentRecord[];
  hypotheses: Hypothesis[];
};

export type DataStatus = {
  jquants: {
    configured: boolean;
    mode?: "v1" | "v2";
    has_api_key?: boolean;
    has_id_token: boolean;
    has_refresh_token: boolean;
    has_password_auth: boolean;
    base_url: string;
  };
};

export type FoundationFetchResult = {
  ticker: string;
  company?: Company;
  listed_info: number;
  prices: number;
  statements: number;
  documents: number;
  metrics: number;
  news?: number;
  news_lookback_days?: number;
  oldest_news_published_at?: string | null;
};

const serverBaseUrl = process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
export const publicApiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function detailMessage(value: unknown): string | null {
  const parsed = typeof value === "string" ? parseMaybeJson(value) : value;
  if (typeof parsed === "string") return parsed.trim() ? parsed.slice(0, 600) : null;
  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  for (const key of ["message", "error"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  if ("detail" in record) return detailMessage(record.detail);
  if ("details" in record) return detailMessage(record.details);
  return null;
}

function nestedErrorMessage(value: unknown): string | null {
  const parsed = typeof value === "string" ? parseMaybeJson(value) : value;
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  return detailMessage(record.details) ?? detailMessage(record.detail);
}

export async function apiErrorMessage(response: Response, context: string): Promise<string> {
  const responseText = await response.text();
  const body = responseText ? parseMaybeJson(responseText) : null;
  const primaryMessage = detailMessage(body);
  const nestedMessage = nestedErrorMessage(body);
  const message =
    primaryMessage && nestedMessage && primaryMessage !== nestedMessage
      ? `${primaryMessage}: ${nestedMessage}`
      : (primaryMessage ?? nestedMessage);
  const requestIdFromBody =
    body && typeof body === "object" && typeof (body as Record<string, unknown>).request_id === "string"
      ? ((body as Record<string, unknown>).request_id as string)
      : null;
  const requestId = response.headers.get("x-request-id") ?? requestIdFromBody;
  return `${context} returned ${response.status}${message ? `: ${message}` : ""}${requestId ? ` (request_id: ${requestId})` : ""}`;
}

export async function apiFetch<T>(path: string): Promise<T> {
  const response = await fetch(`${serverBaseUrl}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(await apiErrorMessage(response, `API ${path}`));
  }

  return (await response.json()) as T;
}
