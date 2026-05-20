import { config } from "./config.js";
import { fetchAndSaveCompanyNews } from "./news.js";
import {
  createDocument,
  deleteDocumentByUrl,
  getCompany,
  purgeSampleData,
  upsertCompany,
  upsertEvent,
  upsertMetrics,
  upsertPrices
} from "./repositories.js";
import type { Company, DocumentRecord, PricePoint } from "./types.js";

type JQuantsListedInfo = {
  Date?: string;
  Code: string;
  CompanyName: string;
  CompanyNameEnglish?: string;
  Sector17CodeName?: string;
  Sector33CodeName?: string;
  MarketCodeName?: string;
  [key: string]: unknown;
};

type JQuantsDailyQuote = {
  Date: string;
  Code?: string;
  Open: number | null;
  High: number | null;
  Low: number | null;
  Close: number | null;
  Volume: number | null;
  TurnoverValue: number | null;
  AdjustmentClose: number | null;
  [key: string]: unknown;
};

type JQuantsStatement = {
  DisclosedDate?: string;
  DisclosedTime?: string;
  LocalCode?: string;
  DisclosureNumber?: string;
  TypeOfDocument?: string;
  TypeOfCurrentPeriod?: string;
  CurrentFiscalYearEndDate?: string;
  NetSales?: string;
  OperatingProfit?: string;
  OrdinaryProfit?: string;
  Profit?: string;
  EarningsPerShare?: string;
  TotalAssets?: string;
  Equity?: string;
  EquityToAssetRatio?: string;
  ForecastNetSales?: string;
  ForecastOperatingProfit?: string;
  ForecastProfit?: string;
  [key: string]: unknown;
};

type Paginated<T> = T & { pagination_key?: string };
type JQuantsMode = "v1" | "v2";
type RawRecord = Record<string, unknown>;

export function normalizeTicker(input: string): string {
  const code = input.trim().replace(/\.T$/i, "").replace(/\D/g, "");
  if (code.length === 5 && code.endsWith("0")) return code.slice(0, 4);
  return code;
}

function jquantsCodeCandidates(ticker: string): string[] {
  return ticker.length === 4 ? [ticker, `${ticker}0`] : [ticker, normalizeTicker(ticker)];
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function stringField(row: RawRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== "") return String(value);
  }
  return undefined;
}

function numberField(row: RawRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const number = toNumber(row[key]);
    if (number !== null) return number;
  }
  return null;
}

function arrayField<T>(payload: RawRecord, ...keys: string[]): T[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function looksLikeJwt(token?: string): boolean {
  const trimmed = token?.trim();
  return Boolean(trimmed && trimmed.startsWith("eyJ") && trimmed.split(".").length === 3);
}

function percentNumber(value: unknown): number | null {
  const number = toNumber(value);
  if (number === null) return null;
  return number <= 1 ? number * 100 : number;
}

function defaultFromDate(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const fromTime = new Date(`${from}T00:00:00.000Z`).getTime();
  const toTime = new Date(`${to}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 365;
  return Math.max(1, Math.round((toTime - fromTime) / 86_400_000));
}

function coverageWindowFromError(error: unknown): { from: string; to: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/covers the following dates:\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
  return match ? { from: match[1], to: match[2] } : null;
}

function clampToCoverage(from: string, to: string, coverage: { from: string; to: string }): { from: string; to: string } {
  const requestedDays = daysBetween(from, to);
  const clampedTo = to > coverage.to ? coverage.to : to < coverage.from ? coverage.from : to;
  let clampedFrom = from < coverage.from ? coverage.from : from;
  if (clampedFrom > clampedTo) clampedFrom = addDays(clampedTo, -requestedDays);
  if (clampedFrom < coverage.from) clampedFrom = coverage.from;
  return { from: clampedFrom, to: clampedTo };
}

function statementPublishedAt(statement: JQuantsStatement): string | null {
  if (!statement.DisclosedDate) return null;
  const time = statement.DisclosedTime?.trim();
  const normalizedTime = time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : time && /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : "00:00:00";
  return `${statement.DisclosedDate}T${normalizedTime}+09:00`;
}

function statementSummary(statement: JQuantsStatement): string {
  const parts = [
    statement.TypeOfDocument,
    statement.TypeOfCurrentPeriod,
    statement.NetSales ? `売上高 ${statement.NetSales}` : null,
    statement.OperatingProfit ? `営業利益 ${statement.OperatingProfit}` : null,
    statement.Profit ? `当期利益 ${statement.Profit}` : null
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "J-Quantsから取得した財務情報です。";
}

function normalizeListedInfoRow(row: JQuantsListedInfo): JQuantsListedInfo {
  const raw = row as RawRecord;
  return {
    ...row,
    Date: stringField(raw, "Date"),
    Code: stringField(raw, "Code", "LocalCode") ?? "",
    CompanyName: stringField(raw, "CompanyName", "CoName", "Name") ?? "",
    CompanyNameEnglish: stringField(raw, "CompanyNameEnglish", "CoNameEn", "NameEn"),
    Sector17CodeName: stringField(raw, "Sector17CodeName", "S17Nm"),
    Sector33CodeName: stringField(raw, "Sector33CodeName", "S33Nm"),
    MarketCodeName: stringField(raw, "MarketCodeName", "MktNm")
  };
}

function normalizeDailyQuoteRow(row: JQuantsDailyQuote): JQuantsDailyQuote {
  const raw = row as RawRecord;
  return {
    ...row,
    Date: stringField(raw, "Date") ?? "",
    Code: stringField(raw, "Code"),
    Open: numberField(raw, "Open", "O"),
    High: numberField(raw, "High", "H"),
    Low: numberField(raw, "Low", "L"),
    Close: numberField(raw, "Close", "C"),
    Volume: numberField(raw, "Volume", "Vo", "AdjVo"),
    TurnoverValue: numberField(raw, "TurnoverValue", "Va"),
    AdjustmentClose: numberField(raw, "AdjustmentClose", "AdjustmentClosePrice", "AdjClose", "AdjC")
  };
}

function normalizeStatementRow(row: JQuantsStatement): JQuantsStatement {
  const raw = row as RawRecord;
  return {
    ...row,
    DisclosedDate: stringField(raw, "DisclosedDate", "DiscDate"),
    DisclosedTime: stringField(raw, "DisclosedTime", "DiscTime"),
    LocalCode: stringField(raw, "LocalCode", "Code"),
    DisclosureNumber: stringField(raw, "DisclosureNumber", "DiscNum"),
    TypeOfDocument: stringField(raw, "TypeOfDocument", "DocType") ?? "FinancialSummary",
    TypeOfCurrentPeriod: stringField(raw, "TypeOfCurrentPeriod", "FQ"),
    CurrentFiscalYearEndDate: stringField(raw, "CurrentFiscalYearEndDate", "FYE"),
    NetSales: stringField(raw, "NetSales", "Sales"),
    OperatingProfit: stringField(raw, "OperatingProfit", "OP"),
    OrdinaryProfit: stringField(raw, "OrdinaryProfit", "OrdinaryIncome"),
    Profit: stringField(raw, "Profit", "NP", "NetIncome"),
    EarningsPerShare: stringField(raw, "EarningsPerShare", "EPS"),
    TotalAssets: stringField(raw, "TotalAssets", "TA"),
    Equity: stringField(raw, "Equity", "Eq"),
    EquityToAssetRatio: stringField(raw, "EquityToAssetRatio", "EqRatio"),
    ForecastNetSales: stringField(raw, "ForecastNetSales", "ForecastSales"),
    ForecastOperatingProfit: stringField(raw, "ForecastOperatingProfit", "ForecastOP"),
    ForecastProfit: stringField(raw, "ForecastProfit", "ForecastNP")
  };
}

class JQuantsClient {
  private cachedIdToken: string | undefined;
  private v2PriceCoverage: { from: string; to: string } | undefined;

  async status() {
    const mode = this.mode();
    return {
      configured: mode === "v2" ? Boolean(this.apiKey()) : Boolean(config.jquantsIdToken || config.jquantsRefreshToken || (config.jquantsEmail && config.jquantsPassword)),
      mode,
      has_api_key: Boolean(this.apiKey()),
      has_id_token: Boolean(config.jquantsIdToken && looksLikeJwt(config.jquantsIdToken)),
      has_refresh_token: Boolean(config.jquantsRefreshToken),
      has_password_auth: Boolean(config.jquantsEmail && config.jquantsPassword),
      base_url: this.baseUrl(mode)
    };
  }

  async listedInfo(code?: string): Promise<JQuantsListedInfo[]> {
    if (this.mode() === "v2") {
      const rows = await this.getPaginated<JQuantsListedInfo>("/equities/master", code ? { code } : {}, "data", "info");
      return rows.map(normalizeListedInfoRow).filter((row) => row.Code && row.CompanyName);
    }
    const payload = await this.getV1Json<Paginated<{ info: JQuantsListedInfo[] }>>("/listed/info", code ? { code } : {});
    return payload.info ?? [];
  }

  async dailyQuotes(code: string, from = defaultFromDate(), to = today()): Promise<JQuantsDailyQuote[]> {
    if (this.mode() === "v2") {
      const initialWindow = this.v2PriceCoverage ? clampToCoverage(from, to, this.v2PriceCoverage) : { from, to };
      try {
        return await this.dailyQuotesV2(code, initialWindow.from, initialWindow.to);
      } catch (error) {
        const coverage = coverageWindowFromError(error);
        if (!coverage) throw error;
        this.v2PriceCoverage = coverage;
        const fallbackWindow = clampToCoverage(from, to, coverage);
        if (fallbackWindow.from === initialWindow.from && fallbackWindow.to === initialWindow.to) throw error;
        return this.dailyQuotesV2(code, fallbackWindow.from, fallbackWindow.to);
      }
    }

    const rows: JQuantsDailyQuote[] = [];
    let paginationKey: string | undefined;
    do {
      const payload = await this.getV1Json<Paginated<{ daily_quotes: JQuantsDailyQuote[] }>>("/prices/daily_quotes", {
        code,
        from,
        to,
        pagination_key: paginationKey
      });
      rows.push(...(payload.daily_quotes ?? []));
      paginationKey = payload.pagination_key;
    } while (paginationKey);
    return rows;
  }

  private async dailyQuotesV2(code: string, from: string, to: string): Promise<JQuantsDailyQuote[]> {
    const rows = await this.getPaginated<JQuantsDailyQuote>("/equities/bars/daily", { code, from, to }, "daily_quotes", "data");
    return rows.map(normalizeDailyQuoteRow).filter((row) => row.Date);
  }

  async statements(code: string): Promise<JQuantsStatement[]> {
    if (this.mode() === "v2") {
      const rows = await this.getPaginated<JQuantsStatement>("/fins/summary", { code }, "data", "statements", "summary");
      return rows.map(normalizeStatementRow);
    }

    const rows: JQuantsStatement[] = [];
    let paginationKey: string | undefined;
    do {
      const payload = await this.getV1Json<Paginated<{ statements: JQuantsStatement[] }>>("/fins/statements", {
        code,
        pagination_key: paginationKey
      });
      rows.push(...(payload.statements ?? []));
      paginationKey = payload.pagination_key;
    } while (paginationKey);
    return rows;
  }

  private mode(): JQuantsMode {
    return this.apiKey() ? "v2" : "v1";
  }

  private apiKey(): string | undefined {
    return config.jquantsApiKey || (config.jquantsIdToken && !looksLikeJwt(config.jquantsIdToken) ? config.jquantsIdToken : undefined);
  }

  private baseUrl(mode: JQuantsMode): string {
    const configured = config.jquantsBaseUrl?.replace(/\/+$/, "");
    if (!configured) return `https://api.jquants.com/${mode}`;
    if (mode === "v2" && configured.endsWith("/v1")) return configured.replace(/\/v1$/, "/v2");
    if (mode === "v1" && configured.endsWith("/v2")) return configured.replace(/\/v2$/, "/v1");
    return configured;
  }

  private async getPaginated<T>(path: string, params: Record<string, string | undefined>, ...rowKeys: string[]): Promise<T[]> {
    const rows: T[] = [];
    let paginationKey: string | undefined;
    do {
      const payload = await this.getV2Json<Paginated<RawRecord>>(path, { ...params, pagination_key: paginationKey });
      rows.push(...arrayField<T>(payload, ...rowKeys));
      paginationKey = typeof payload.pagination_key === "string" && payload.pagination_key ? payload.pagination_key : undefined;
    } while (paginationKey);
    return rows;
  }

  private async getV2Json<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const apiKey = this.apiKey();
    if (!apiKey) {
      throw Object.assign(new Error("J-Quants API key is not configured. Set JQUANTS_API_KEY or JQUANTS_API_TOKEN."), {
        status: 400
      });
    }
    const url = new URL(`${this.baseUrl("v2")}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) {
      throw Object.assign(new Error(`J-Quants v2 ${path} returned ${response.status}: ${await response.text()}`), {
        status: response.status === 429 ? 429 : 502
      });
    }
    return (await response.json()) as T;
  }

  private async getV1Json<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const token = await this.getIdToken();
    const url = new URL(`${this.baseUrl("v1")}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) {
      throw Object.assign(new Error(`J-Quants ${path} returned ${response.status}: ${await response.text()}`), { status: 502 });
    }
    return (await response.json()) as T;
  }

  private async getIdToken(): Promise<string> {
    if (looksLikeJwt(config.jquantsIdToken)) return config.jquantsIdToken as string;
    if (this.cachedIdToken) return this.cachedIdToken;

    let refreshToken = config.jquantsRefreshToken;
    if (!refreshToken && config.jquantsEmail && config.jquantsPassword) {
      const response = await fetch(`${this.baseUrl("v1")}/token/auth_user`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mailaddress: config.jquantsEmail, password: config.jquantsPassword }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) {
        throw Object.assign(new Error(`J-Quants auth_user returned ${response.status}: ${await response.text()}`), { status: 502 });
      }
      const payload = (await response.json()) as { refreshToken?: string };
      refreshToken = payload.refreshToken;
    }

    if (!refreshToken) {
      throw Object.assign(new Error("J-Quants credentials are not configured. For v2 set JQUANTS_API_KEY or JQUANTS_API_TOKEN. For legacy v1 set JQUANTS_REFRESH_TOKEN or JQUANTS_EMAIL/JQUANTS_PASSWORD."), {
        status: 400
      });
    }

    const url = new URL(`${this.baseUrl("v1")}/token/auth_refresh`);
    url.searchParams.set("refreshtoken", refreshToken);
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw Object.assign(new Error(`J-Quants auth_refresh returned ${response.status}: ${await response.text()}`), { status: 502 });
    }
    const payload = (await response.json()) as { idToken?: string };
    if (!payload.idToken) {
      throw Object.assign(new Error("J-Quants auth_refresh did not return idToken"), { status: 502 });
    }
    this.cachedIdToken = payload.idToken;
    return payload.idToken;
  }
}

export const jquants = new JQuantsClient();

export async function fetchListedMaster(): Promise<{ imported: number }> {
  const rows = await jquants.listedInfo();
  let imported = 0;
  for (const row of rows) {
    if (!row.Code || !row.CompanyName) continue;
    await upsertCompany(mapListedInfo(row));
    imported += 1;
  }
  return { imported };
}

export async function fetchCompanyFoundation(
  tickerInput: string,
  options: { includePrices?: boolean; includeStatements?: boolean; includeNews?: boolean; from?: string; to?: string; newsLookbackDays?: number; newsLimit?: number } = {}
) {
  await purgeSampleData();
  const ticker = normalizeTicker(tickerInput);
  if (!/^\d{4,5}$/.test(ticker)) {
    throw Object.assign(new Error("日本株の4桁または5桁コードを入力してください。"), { status: 400 });
  }

  const candidates = jquantsCodeCandidates(ticker);
  let infoRows: JQuantsListedInfo[] = [];
  for (const code of candidates) {
    infoRows = await jquants.listedInfo(code);
    if (infoRows.length) break;
  }
  const company = infoRows[0] ? await upsertCompany(mapListedInfo(infoRows[0], ticker)) : await ensureMinimalCompany(ticker);

  const result = {
    ticker,
    company,
    listed_info: infoRows.length,
    prices: 0,
    statements: 0,
    documents: 0,
    metrics: 0,
    news: 0,
    news_lookback_days: options.newsLookbackDays ?? Number(process.env.NEWS_LOOKBACK_DAYS ?? 450),
    oldest_news_published_at: null as string | null
  };

  if (options.includePrices !== false) {
    let quotes: JQuantsDailyQuote[] = [];
    for (const code of candidates) {
      quotes = await jquants.dailyQuotes(code, options.from ?? defaultFromDate(), options.to ?? today());
      if (quotes.length) break;
    }
    const prices = quotes
      .map(mapDailyQuote)
      .filter((price): price is PricePoint => Boolean(price));
    result.prices = await upsertPrices(ticker, prices);
  }

  if (options.includeStatements !== false) {
    let statements: JQuantsStatement[] = [];
    for (const code of candidates) {
      statements = await jquants.statements(code);
      if (statements.length) break;
    }
    result.statements = statements.length;
    result.documents = await saveStatements(ticker, company, statements);
    const metricsUpdated = await saveLatestMetrics(ticker, statements);
    result.metrics = metricsUpdated ? 1 : 0;
  }

  if (options.includeNews !== false) {
    const newsResult = await fetchAndSaveCompanyNews(ticker, {
      lookbackDays: options.newsLookbackDays,
      limit: options.newsLimit ?? Number(process.env.COMPANY_NEWS_MAX_RECORDS ?? process.env.NEWS_MAX_RECORDS ?? 260)
    });
    result.news = newsResult.saved;
    result.oldest_news_published_at = newsResult.oldest_published_at;
  }

  return result;
}

function mapListedInfo(row: JQuantsListedInfo, fallbackTicker?: string): Partial<Company> & { ticker: string; name: string } {
  const ticker = normalizeTicker(row.Code || fallbackTicker || "");
  return {
    ticker,
    name: row.CompanyName,
    english_name: row.CompanyNameEnglish ?? null,
    market: row.MarketCodeName ?? null,
    sector: row.Sector17CodeName ?? row.Sector33CodeName ?? null,
    industry: row.Sector33CodeName ?? null,
    description: null,
    business_summary: null
  };
}

async function ensureMinimalCompany(ticker: string): Promise<Company> {
  const existing = await getCompany(ticker);
  if (existing) return existing;
  return upsertCompany({
    ticker,
    name: `${ticker}`,
    description: "J-Quantsの銘柄マスターで会社名を取得できませんでした。",
    business_summary: null
  });
}

function mapDailyQuote(row: JQuantsDailyQuote): PricePoint | null {
  const open = toNumber(row.Open);
  const high = toNumber(row.High);
  const low = toNumber(row.Low);
  const close = toNumber(row.Close);
  if (open === null || high === null || low === null || close === null) return null;
  return {
    date: row.Date,
    open,
    high,
    low,
    close,
    volume: toNumber(row.Volume) ?? 0,
    turnover: toNumber(row.TurnoverValue) ?? undefined,
    adjusted_close: toNumber(row.AdjustmentClose) ?? close
  };
}

async function saveStatements(ticker: string, company: Company, statements: JQuantsStatement[]): Promise<number> {
  let count = 0;
  for (const statement of statements.slice(-12)) {
    const disclosureNumber = statement.DisclosureNumber ?? `${ticker}-${statement.DisclosedDate}-${statement.TypeOfDocument}`;
    const documentUrl = `jquants://statements/${disclosureNumber}`;
    const title = `${company.name} ${statement.DisclosedDate ?? ""} ${statement.TypeOfDocument ?? "財務情報"}`.trim();
    await deleteDocumentByUrl(documentUrl);
    const document: DocumentRecord = await createDocument({
      ticker,
      source_type: "financial_statement",
      source_name: "J-Quants",
      title,
      url: documentUrl,
      published_at: statementPublishedAt(statement) ?? undefined,
      storage_level: "structured",
      retrieval_status: "structured",
      raw_text: JSON.stringify(statement),
      summary_short: statementSummary(statement),
      summary_investment: "決算短信サマリーの数値データです。成長率、利益率、会社予想との乖離を確認してください。",
      summary_risk: "財務数値のみでは事業背景や一過性要因を判断できません。開示本文と補足資料の確認が必要です。",
      key_points: [
        statement.NetSales ? `売上高: ${statement.NetSales}` : null,
        statement.OperatingProfit ? `営業利益: ${statement.OperatingProfit}` : null,
        statement.ForecastNetSales ? `会社予想売上高: ${statement.ForecastNetSales}` : null
      ].filter(Boolean) as string[],
      event_type: "earnings",
      sentiment: "neutral",
      impact_horizon: "medium",
      affected_metrics: ["revenue_growth", "operating_margin", "eps"],
      importance_score: 0.6,
      confidence: 0.85
    });
    await upsertEvent({
      ticker,
      document_id: document.id,
      sector: company.sector,
      event_type: "earnings",
      title,
      summary: document.summary_short,
      sentiment: "neutral",
      impact_score: 0.6,
      impact_horizon: "medium",
      published_at: document.published_at ?? undefined
    });
    count += 1;
  }
  return count;
}

async function saveLatestMetrics(ticker: string, statements: JQuantsStatement[]): Promise<boolean> {
  const latest = [...statements]
    .filter((statement) => statement.CurrentFiscalYearEndDate || statement.DisclosedDate)
    .sort((a, b) => String(b.DisclosedDate ?? "").localeCompare(String(a.DisclosedDate ?? "")))[0];
  if (!latest) return false;

  const netSales = toNumber(latest.NetSales);
  const operatingProfit = toNumber(latest.OperatingProfit);
  const profit = toNumber(latest.Profit);
  const equity = toNumber(latest.Equity);
  const operatingMargin = netSales && operatingProfit !== null ? (operatingProfit / netSales) * 100 : null;
  const roe = equity && profit !== null ? (profit / equity) * 100 : null;

  await upsertMetrics(ticker, {
    date: latest.CurrentFiscalYearEndDate ?? latest.DisclosedDate ?? today(),
    roe,
    operating_margin: operatingMargin,
    equity_ratio: percentNumber(latest.EquityToAssetRatio)
  });
  return true;
}
