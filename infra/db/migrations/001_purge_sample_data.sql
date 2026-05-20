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
SELECT 'sample data purged' AS result;

