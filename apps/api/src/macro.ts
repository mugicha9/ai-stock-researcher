import { createDocument, deleteDocumentByUrl, listMacroIndicators, listMacroNews } from "./repositories.js";
import { fetchAndSaveMacroNews } from "./news.js";
import type { DocumentRecord, MacroIndicator } from "./types.js";

type MacroSource = {
  symbol: string;
  label: string;
};

type MacroNewsItem = {
  title: string;
  url: string;
  source_name: string;
  published_at?: string | null;
  summary?: string | null;
};

const DEFAULT_SOURCES: MacroSource[] = [
  { symbol: "^nkx", label: "日経平均" },
  { symbol: "^topx", label: "TOPIX" },
  { symbol: "usdjpy", label: "USD/JPY" },
  { symbol: "eurjpy", label: "EUR/JPY" },
  { symbol: "^spx", label: "S&P 500" },
  { symbol: "^ndq", label: "NASDAQ" },
  { symbol: "10usy.b", label: "米10年債利回り" },
  { symbol: "cl.f", label: "WTI原油" },
  { symbol: "gc.f", label: "金先物" }
];

const DEFAULT_RSS_FEEDS = [
  { url: "https://news.yahoo.co.jp/rss/topics/business.xml", source_name: "Yahoo!ニュース 経済" },
  { url: "https://www3.nhk.or.jp/rss/news/cat5.xml", source_name: "NHK 経済" }
];

function macroSources(): MacroSource[] {
  const configured = process.env.MACRO_INDEX_SYMBOLS?.trim();
  if (!configured) return DEFAULT_SOURCES;
  const sources = configured
    .split(",")
    .map((entry) => {
      const [symbol, label] = entry.split(":").map((part) => part.trim());
      return symbol ? { symbol, label: label || symbol } : null;
    })
    .filter((entry): entry is MacroSource => Boolean(entry));
  return sources.length ? sources : DEFAULT_SOURCES;
}

function rssFeeds(): { url: string; source_name: string }[] {
  const configured = process.env.MACRO_NEWS_RSS_URLS?.trim();
  if (!configured) return DEFAULT_RSS_FEEDS;
  const feeds = configured
    .split(",")
    .map((entry) => {
      const [url, sourceName] = entry.split("|").map((part) => part.trim());
      return url ? { url, source_name: sourceName || new URL(url).hostname } : null;
    })
    .filter((entry): entry is { url: string; source_name: string } => Boolean(entry));
  return feeds.length ? feeds : DEFAULT_RSS_FEEDS;
}

function toNumber(value: string | undefined): number | null {
  if (!value || value === "N/D") return null;
  const number = Number(value.replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function splitCsvLine(line: string): string[] {
  const output: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      output.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  output.push(current);
  return output.map((item) => item.trim());
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value: string): string {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function xmlValue(item: string, tag: string): string | null {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtml(match[1].trim()) : null;
}

async function fetchText(url: string, timeoutMs = 20_000): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/csv, application/rss+xml, application/xml, text/xml, text/plain;q=0.8",
      "user-agent": "ai-stock-adviser/0.1 research tool"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw Object.assign(new Error(`${url} returned ${response.status}`), { status: 502 });
  }
  return response.text();
}

export async function fetchMacroIndicators(): Promise<MacroIndicator[]> {
  const sources = macroSources();
  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(source.symbol)}&f=sd2t2ohlcv&h&e=csv`;
      const csv = await fetchText(url);
      const [headerLine, line] = csv.trim().split(/\r?\n/);
      if (!headerLine || !line) return null;
      const headers = splitCsvLine(headerLine);
      const values = splitCsvLine(line);
      const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
      const close = toNumber(row.Close);
      if (close === null || !row.Date || row.Date === "N/D") return null;
      const open = toNumber(row.Open);
      const change = open === null ? null : close - open;
      const changePercent = open === null || open === 0 || change === null ? null : (change / open) * 100;
      return {
        symbol: source.symbol,
        label: source.label,
        date: row.Date,
        time: row.Time === "N/D" ? null : row.Time,
        open,
        high: toNumber(row.High),
        low: toNumber(row.Low),
        close,
        volume: toNumber(row.Volume),
        change,
        change_percent: changePercent,
        source_name: "Stooq",
        source_url: url
      } satisfies MacroIndicator;
    })
  );

  return settled
    .flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []))
    .slice(0, sources.length);
}

export async function fetchMacroNews(): Promise<MacroNewsItem[]> {
  const settled = await Promise.allSettled(
    rssFeeds().map(async (feed) => {
      const xml = await fetchText(feed.url);
      const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].slice(0, 12);
      const news: MacroNewsItem[] = [];
      for (const match of items) {
        const item = match[1];
        const title = xmlValue(item, "title");
        const link = xmlValue(item, "link") ?? xmlValue(item, "guid");
        if (!title || !link) continue;
        const published = xmlValue(item, "pubDate");
        const description = xmlValue(item, "description");
        news.push({
          title: stripTags(title),
          url: link,
          source_name: feed.source_name,
          published_at: published ? new Date(published).toISOString() : null,
          summary: description ? stripTags(description).slice(0, 320) : null
        });
      }
      return news;
    })
  );

  return settled
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.url === item.url) === index)
    .slice(0, 20);
}

async function saveMacroIndicator(indicator: MacroIndicator): Promise<DocumentRecord> {
  const changePercent = indicator.change_percent;
  const direction = changePercent === null || changePercent === undefined ? "" : ` ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(2)}%`;
  const documentUrl = `macro://indicator/${encodeURIComponent(indicator.symbol)}/${indicator.date}`;
  await deleteDocumentByUrl(documentUrl);
  return createDocument({
    source_type: "macro_stat",
    source_name: indicator.source_name,
    title: `${indicator.label} ${indicator.close}${direction}`,
    url: documentUrl,
    published_at: `${indicator.date}T${indicator.time && /^\d{2}:\d{2}/.test(indicator.time) ? indicator.time.slice(0, 5) : "00:00"}:00+09:00`,
    storage_level: "structured",
    retrieval_status: "structured",
    raw_text: JSON.stringify(indicator),
    summary_short: `${indicator.label}は${indicator.close}${direction}。`,
    summary_investment: "市場全体のリスク選好、為替感応度、外部環境の確認に使うマクロ指標です。",
    summary_risk: "無料データソースの遅延や欠損があり得ます。重要判断には一次情報や契約データで確認してください。",
    key_points: [indicator.label, indicator.symbol, indicator.date],
    event_type: "macro_index",
    sentiment: changePercent === null || changePercent === undefined ? "neutral" : changePercent > 0 ? "positive" : changePercent < 0 ? "negative" : "neutral",
    impact_horizon: "short",
    affected_metrics: ["risk_appetite", "fx", "discount_rate"],
    importance_score: 0.55,
    confidence: 0.8
  });
}

async function saveMacroNews(item: MacroNewsItem): Promise<DocumentRecord> {
  await deleteDocumentByUrl(item.url);
  return createDocument({
    source_type: "news",
    source_name: item.source_name,
    title: item.title,
    url: item.url,
    published_at: item.published_at ?? new Date().toISOString(),
    storage_level: "summary_only",
    retrieval_status: "summary_only",
    summary_short: item.summary ?? item.title,
    summary_investment: "マクロ環境や市場テーマの変化を把握するためのニュース見出しです。",
    summary_risk: "RSSの見出し・短い説明のみを保存しています。本文と事実関係は配信元で確認してください。",
    key_points: [item.source_name, "macro"],
    event_type: "macro",
    sentiment: "neutral",
    impact_horizon: "short",
    affected_metrics: ["risk_appetite", "sector_rotation"],
    importance_score: 0.45,
    confidence: 0.75
  });
}

export async function fetchMacroData() {
  const [indicatorResult, newsResult] = await Promise.allSettled([
    fetchMacroIndicators(),
    fetchAndSaveMacroNews({
      lookbackDays: Number(process.env.NEWS_LOOKBACK_DAYS ?? 450),
      limit: Number(process.env.MACRO_NEWS_MAX_RECORDS ?? process.env.NEWS_MAX_RECORDS ?? 360)
    })
  ]);
  const indicators = indicatorResult.status === "fulfilled" ? indicatorResult.value : [];

  const savedIndicators = await Promise.all(indicators.map(saveMacroIndicator));
  const savedNews = newsResult.status === "fulfilled" ? newsResult.value.documents : [];

  return {
    indicators: savedIndicators.length,
    news: savedNews.length,
    news_lookback_days: newsResult.status === "fulfilled" ? newsResult.value.lookback_days : null,
    oldest_news_published_at: newsResult.status === "fulfilled" ? newsResult.value.oldest_published_at : null,
    news_source_counts: newsResult.status === "fulfilled" ? newsResult.value.source_counts : null,
    errors: [
      indicatorResult.status === "rejected" ? String(indicatorResult.reason?.message ?? indicatorResult.reason) : null,
      newsResult.status === "rejected" ? String(newsResult.reason?.message ?? newsResult.reason) : null,
      ...(newsResult.status === "fulfilled" ? newsResult.value.errors : [])
    ].filter(Boolean),
    latest: await getMacroSnapshot()
  };
}

export async function getMacroSnapshot() {
  const [indicators, news] = await Promise.all([listMacroIndicators(12), listMacroNews(24)]);
  return { indicators, news };
}
