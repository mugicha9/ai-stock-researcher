CREATE TABLE IF NOT EXISTS companies (
  id BIGSERIAL PRIMARY KEY,
  ticker VARCHAR(10) NOT NULL UNIQUE,
  name TEXT NOT NULL,
  english_name TEXT,
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

CREATE TABLE IF NOT EXISTS price_daily (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS company_metrics (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  source_type TEXT,
  source_name TEXT,
  title TEXT NOT NULL,
  url TEXT,
  published_at TIMESTAMP,
  storage_level TEXT,
  retrieval_status TEXT,
  raw_text_uri TEXT,
  pdf_uri TEXT,
  raw_text TEXT,
  summary_short TEXT,
  summary_investment TEXT,
  summary_risk TEXT,
  key_points JSONB DEFAULT '[]'::jsonb,
  evidence_snippets JSONB DEFAULT '[]'::jsonb,
  event_type TEXT,
  sentiment TEXT,
  impact_horizon TEXT,
  affected_metrics JSONB DEFAULT '[]'::jsonb,
  importance_score NUMERIC,
  confidence NUMERIC,
  embedding VECTOR(1024),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_entities (
  id BIGSERIAL PRIMARY KEY,
  document_id BIGINT REFERENCES documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  relevance_score NUMERIC,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  document_id BIGINT REFERENCES documents(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS hypotheses (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT,
  hypothesis_type TEXT DEFAULT 'company',
  target_company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
  target_sector TEXT,
  growth_driver TEXT,
  required_evidence JSONB DEFAULT '[]'::jsonb,
  risk_factors JSONB DEFAULT '[]'::jsonb,
  missing_information JSONB DEFAULT '[]'::jsonb,
  recommended_next_research JSONB DEFAULT '[]'::jsonb,
  score_growth NUMERIC,
  score_evidence NUMERIC,
  score_contradiction NUMERIC,
  score_valuation_risk NUMERIC,
  score_overlooked NUMERIC,
  score_overall NUMERIC,
  final_decision TEXT,
  final_report TEXT,
  created_by_agent TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hypothesis_documents (
  id BIGSERIAL PRIMARY KEY,
  hypothesis_id BIGINT REFERENCES hypotheses(id) ON DELETE CASCADE,
  document_id BIGINT REFERENCES documents(id) ON DELETE CASCADE,
  relation_type TEXT,
  evidence_strength NUMERIC,
  note TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id BIGSERIAL PRIMARY KEY,
  hypothesis_id BIGINT REFERENCES hypotheses(id) ON DELETE SET NULL,
  agent_name TEXT NOT NULL,
  input JSONB,
  output JSONB,
  next_action TEXT,
  next_agent TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_daily_company_date ON price_daily(company_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_documents_company_published ON documents(company_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_event_type ON documents(event_type);
CREATE INDEX IF NOT EXISTS idx_events_company_published ON events(company_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status);
CREATE INDEX IF NOT EXISTS idx_hypotheses_type ON hypotheses(hypothesis_type);
CREATE INDEX IF NOT EXISTS idx_hypotheses_target_company ON hypotheses(target_company_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_hypothesis_created ON agent_runs(hypothesis_id, created_at DESC);
