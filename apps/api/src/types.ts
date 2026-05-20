export type JsonRecord = Record<string, unknown>;

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
  listed_at?: string | null;
  edinet_code?: string | null;
  latest_metrics?: JsonRecord | null;
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
  company_id?: number | null;
  ticker?: string | null;
  company_name?: string | null;
  source_type?: string | null;
  source_name?: string | null;
  title: string;
  url?: string | null;
  published_at?: string | null;
  storage_level?: string | null;
  retrieval_status?: string | null;
  raw_text?: string | null;
  summary_short?: string | null;
  summary_investment?: string | null;
  summary_risk?: string | null;
  key_points?: string[] | JsonRecord[];
  event_type?: string | null;
  sentiment?: string | null;
  impact_horizon?: string | null;
  affected_metrics?: string[];
  importance_score?: number | string | null;
  confidence?: number | string | null;
};

export type Hypothesis = {
  id: number;
  title: string;
  summary?: string | null;
  status?: string | null;
  hypothesis_type?: "global" | "company" | string | null;
  target_company_id?: number | null;
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
  created_by_agent?: string | null;
  documents?: DocumentRecord[];
  agent_runs?: AgentRun[];
};

export type AgentRun = {
  id: number;
  hypothesis_id?: number | null;
  agent_name: string;
  input?: JsonRecord | null;
  output?: JsonRecord | null;
  next_action?: string | null;
  next_agent?: string | null;
  created_at?: string | null;
};

export type EventRecord = {
  id: number;
  company_id?: number | null;
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
