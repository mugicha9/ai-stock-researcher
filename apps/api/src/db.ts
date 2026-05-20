import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const hasDatabase = Boolean(config.databaseUrl);

export const pool = hasDatabase
  ? new Pool({
      connectionString: config.databaseUrl,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000
    })
  : undefined;

export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) {
    throw new Error("DATABASE_URL is not configured");
  }

  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function checkDatabase(): Promise<boolean> {
  if (!pool) {
    return false;
  }

  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function ensureDatabaseSchema(): Promise<void> {
  if (!pool) {
    throw new Error("DATABASE_URL is not configured");
  }

  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS companies (
      id BIGSERIAL PRIMARY KEY,
      ticker VARCHAR(10) NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );

    ALTER TABLE companies ADD COLUMN IF NOT EXISTS english_name TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS market TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS sector TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_summary TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS fiscal_year_end TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS market_cap NUMERIC;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS listed_at DATE;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS edinet_code TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();

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
      title TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );

    ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_name TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS url TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_level TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS retrieval_status TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS raw_text_uri TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS pdf_uri TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS raw_text TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS summary_short TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS summary_investment TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS summary_risk TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS key_points JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS evidence_snippets JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS event_type TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS sentiment TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS impact_horizon TEXT;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS affected_metrics JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS importance_score NUMERIC;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS confidence NUMERIC;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding VECTOR(1024);
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();

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
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );

    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS summary TEXT;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS status TEXT;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS hypothesis_type TEXT DEFAULT 'company';
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS target_company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS target_sector TEXT;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS growth_driver TEXT;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS required_evidence JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS risk_factors JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS missing_information JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS recommended_next_research JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS score_growth NUMERIC;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS score_evidence NUMERIC;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS score_contradiction NUMERIC;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS score_valuation_risk NUMERIC;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS score_overlooked NUMERIC;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS score_overall NUMERIC;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS final_decision TEXT;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS final_report TEXT;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS created_by_agent TEXT;
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();
    ALTER TABLE hypotheses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();

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
  `);
}
