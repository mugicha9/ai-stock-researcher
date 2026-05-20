import http from "node:http";
import https from "node:https";
import { createDocument, deleteDocumentByUrl, getCompany, updateDocumentBody } from "./repositories.js";
import type { DocumentRecord } from "./types.js";

type NewsItem = {
  title: string;
  url: string;
  source_name: string;
  published_at: string;
  summary?: string | null;
  source_group?: "official" | "trusted_news" | "archive";
  perspective?: string;
  source_url?: string;
  raw?: Record<string, unknown>;
};

type NewsFetchOptions = {
  query?: string;
  ticker?: string;
  companyName?: string;
  sector?: string;
  lookbackDays?: number;
  limit?: number;
};

type NewsSource = {
  url: string;
  source_name: string;
  source_group: "official" | "trusted_news";
  perspective: string;
};

const DEFAULT_LOOKBACK_DAYS = Number(process.env.NEWS_LOOKBACK_DAYS ?? 450);
const DEFAULT_LIMIT = Number(process.env.NEWS_MAX_RECORDS ?? 320);
const GDELT_BASE_URL = process.env.NEWS_GDELT_BASE_URL?.trim() || "https://api.gdeltproject.org/api/v2/doc/doc";
const GDELT_MIN_INTERVAL_MS = Number(process.env.NEWS_GDELT_MIN_INTERVAL_MS ?? 7_000);
const ARTICLE_BODY_MIN_CHARS = Number(process.env.ARTICLE_BODY_MIN_CHARS ?? 320);
const ARTICLE_BODY_TIMEOUT_MS = Number(process.env.ARTICLE_BODY_TIMEOUT_MS ?? 20_000);
const MACRO_NEWS_QUERY =
  process.env.MACRO_NEWS_QUERY?.trim() ||
  "Japan";

const OFFICIAL_NEWS_SOURCES: NewsSource[] = [
  { url: "https://www.boj.or.jp/rss/whatsnew.xml", source_name: "日本銀行 更新情報", source_group: "official", perspective: "monetary_policy" },
  { url: "https://www.boj.or.jp/rss/statistics.xml", source_name: "日本銀行 統計", source_group: "official", perspective: "macro_economy" },
  { url: "https://www.mof.go.jp/english/news.rss", source_name: "財務省 What's New", source_group: "official", perspective: "fiscal_policy" },
  { url: "https://www.meti.go.jp/ml_index_en_atom.xml", source_name: "経済産業省 Latest information", source_group: "official", perspective: "industrial_policy" },
  { url: "https://www.meti.go.jp/english/statistics/st_en_news.xml", source_name: "経済産業省 統計", source_group: "official", perspective: "macro_economy" },
  { url: "https://www.esri.cao.go.jp/rss-en.xml", source_name: "内閣府ESRI", source_group: "official", perspective: "macro_economy" },
  { url: "https://www.federalreserve.gov/feeds/press_all.xml", source_name: "Federal Reserve Press Releases", source_group: "official", perspective: "global_monetary_policy" },
  { url: "https://www.federalreserve.gov/feeds/speeches.xml", source_name: "Federal Reserve Speeches", source_group: "official", perspective: "global_monetary_policy" },
  { url: "https://www.bis.org/doclist/all_pressrels.rss", source_name: "BIS Press Releases", source_group: "official", perspective: "global_finance" },
  { url: "https://www.bis.org/doclist/all_statistics.rss", source_name: "BIS Statistics", source_group: "official", perspective: "global_finance" },
  { url: "https://www.ecb.europa.eu/rss/press.html", source_name: "ECB Press Releases", source_group: "official", perspective: "global_monetary_policy" }
];

const TRUSTED_NEWS_SOURCES: NewsSource[] = [
  { url: "https://www3.nhk.or.jp/rss/news/cat5.xml", source_name: "NHK 経済", source_group: "trusted_news", perspective: "economy" },
  { url: "https://www3.nhk.or.jp/rss/news/cat6.xml", source_name: "NHK 国際", source_group: "trusted_news", perspective: "geopolitics" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source_name: "BBC Business", source_group: "trusted_news", perspective: "global_economy" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", source_name: "BBC World", source_group: "trusted_news", perspective: "geopolitics" },
  { url: "https://news.yahoo.co.jp/rss/topics/business.xml", source_name: "Yahoo!ニュース 経済", source_group: "trusted_news", perspective: "economy" }
];

let lastGdeltRequestAt = 0;

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function sinceDate(lookbackDays = DEFAULT_LOOKBACK_DAYS): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - clampNumber(lookbackDays, 30, 1200));
  return date;
}

function gdeltDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "").replace(/[-:T]/g, "");
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseGdeltSeenDate(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  }
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseRssDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function xmlValue(item: string, tag: string): string | null {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeHtml(match[1].trim()) : null;
}

function xmlAttribute(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1].trim()) : null;
}

function atomLinkValue(item: string): string | null {
  const links = [...item.matchAll(/<link\b([^>]*)\/?>/gi)]
    .map((match) => ({ href: xmlAttribute(match[1], "href"), rel: xmlAttribute(match[1], "rel") ?? "alternate" }))
    .filter((link): link is { href: string; rel: string } => Boolean(link.href));
  const preferred = links.find((link) => link.rel === "alternate") ?? links[0];
  return preferred?.href ?? null;
}

function absoluteUrl(value: string | null, baseUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(decodeHtml(value.trim()), baseUrl).toString();
  } catch {
    return null;
  }
}

function feedPublishedAt(item: string): string | null {
  return parseRssDate(
    xmlValue(item, "pubDate") ??
      xmlValue(item, "dc:date") ??
      xmlValue(item, "date") ??
      xmlValue(item, "published") ??
      xmlValue(item, "updated")
  );
}

function quoted(value: string): string {
  return `"${value.replace(/"/g, "").trim()}"`;
}

function uniqueTerms(values: Array<string | null | undefined>): string[] {
  const terms = values.flatMap((value) => {
    const trimmed = value?.trim();
    if (!trimmed) return [];
    const normalized = trimmed.normalize("NFKC");
    return normalized === trimmed ? [trimmed] : [trimmed, normalized];
  });
  return [...new Set(terms)];
}

function companyQuery(input: { ticker: string; companyName?: string | null; englishName?: string | null; sector?: string | null }): string {
  const terms = uniqueTerms([input.companyName, input.englishName, input.ticker]).map(quoted);
  const sector = input.sector?.trim();
  const base = terms.length ? `(${terms.join(" OR ")})` : quoted(input.ticker);
  return `${base}${sector ? ` OR ${quoted(sector)}` : ""} sourcelang:japanese`;
}

function normalizeLimit(limit?: number): number {
  return clampNumber(limit ?? DEFAULT_LIMIT, 20, 600);
}

function parseConfiguredSources(envName: string, fallback: NewsSource[], sourceGroup: NewsSource["source_group"]): NewsSource[] {
  const configured = process.env[envName]?.trim();
  if (!configured) return fallback;
  return configured
    .split(",")
    .map((entry) => {
      const [url, sourceName, perspective] = entry.split("|").map((part) => part.trim());
      if (!url) return null;
      let host = "custom-source";
      try {
        host = new URL(url).hostname;
      } catch {
        return null;
      }
      return {
        url,
        source_name: sourceName || host,
        source_group: sourceGroup,
        perspective: perspective || (sourceGroup === "official" ? "official" : "news")
      };
    })
    .filter((entry): entry is NewsSource => Boolean(entry));
}

function officialSources(): NewsSource[] {
  return parseConfiguredSources("OFFICIAL_NEWS_RSS_URLS", OFFICIAL_NEWS_SOURCES, "official");
}

function trustedNewsSources(): NewsSource[] {
  const configured = process.env.TRUSTED_NEWS_RSS_URLS?.trim() || process.env.MACRO_NEWS_RSS_URLS?.trim();
  if (!configured) return TRUSTED_NEWS_SOURCES;
  return configured
    .split(",")
    .flatMap((entry): NewsSource[] => {
      const [url, sourceName, perspective] = entry.split("|").map((part) => part.trim());
      if (!url) return [];
      let host = "custom-source";
      try {
        host = new URL(url).hostname;
      } catch {
        return [];
      }
      return [
        {
          url,
          source_name: sourceName || host,
          source_group: "trusted_news",
          perspective: perspective || "news"
        }
      ];
    });
}

function dedupeNewsItems(items: NewsItem[], limit = normalizeLimit()): NewsItem[] {
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = item.url || `${item.source_name}:${item.title}:${item.published_at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
    .slice(0, limit);
}

function selectDiverseByDate(items: NewsItem[], limit: number): NewsItem[] {
  const sorted = dedupeNewsItems(items, items.length || limit);
  const bucketMs = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const buckets = new Map<number, NewsItem[]>();
  for (const item of sorted) {
    const published = Date.parse(item.published_at);
    const bucket = Number.isFinite(published) ? Math.max(0, Math.floor((now - published) / bucketMs)) : 0;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), item]);
  }

  const selected: NewsItem[] = [];
  const selectedUrls = new Set<string>();
  const perBucket = Math.max(4, Math.floor(limit / Math.max(1, buckets.size)));
  for (const bucketItems of [...buckets.entries()].sort(([a], [b]) => a - b).map((entry) => entry[1])) {
    for (const item of bucketItems.slice(0, perBucket)) {
      if (selected.length >= limit) break;
      selected.push(item);
      selectedUrls.add(item.url);
    }
  }

  for (const item of sorted) {
    if (selected.length >= limit) break;
    if (selectedUrls.has(item.url)) continue;
    selected.push(item);
    selectedUrls.add(item.url);
  }

  return selected.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

async function fetchText(url: string, timeoutMs = 30_000, options: { family?: 4 | 6; redirects?: number } = {}): Promise<string> {
  const redirects = options.redirects ?? 3;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const request = client.get(
      parsed,
      {
        family: options.family,
        timeout: timeoutMs,
        headers: {
          accept: "text/html, application/json, application/rss+xml, application/xml, text/xml, text/plain;q=0.8",
          "accept-encoding": "identity",
          "user-agent": "ai-stock-adviser/0.1 research tool"
        }
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;
        if (statusCode >= 300 && statusCode < 400 && location && redirects > 0) {
          response.resume();
          resolve(fetchText(new URL(location, parsed).toString(), timeoutMs, { ...options, redirects: redirects - 1 }));
          return;
        }

        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (statusCode < 200 || statusCode >= 300) {
            const status = statusCode === 429 ? 429 : 502;
            reject(Object.assign(new Error(`${url} returned ${statusCode}: ${body.slice(0, 1000)}`), { status, upstreamStatus: statusCode }));
            return;
          }
          resolve(body);
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(Object.assign(new Error(`${url} timed out after ${timeoutMs}ms`), { status: 504 }));
    });
    request.on("error", reject);
  });
}

async function waitForGdeltRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastGdeltRequestAt;
  const waitMs = GDELT_MIN_INTERVAL_MS - elapsed;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastGdeltRequestAt = Date.now();
}

async function fetchGdeltWindow(query: string, start: Date, end: Date, limit: number): Promise<NewsItem[]> {
  const url = new URL(GDELT_BASE_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "artlist");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "datedesc");
  url.searchParams.set("maxrecords", String(Math.min(250, limit)));
  url.searchParams.set("startdatetime", gdeltDate(start));
  url.searchParams.set("enddatetime", gdeltDate(end));

  let rawPayload = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await waitForGdeltRateLimit();
      rawPayload = await fetchText(url.toString(), 60_000, { family: 4 });
      const trimmed = rawPayload.trim();
      if (/^Please limit requests/i.test(trimmed)) {
        throw Object.assign(new Error(`GDELT rate limited request: ${trimmed}`), { status: 429 });
      }
      if (!trimmed.startsWith("{")) {
        throw Object.assign(new Error(`GDELT returned non-JSON response: ${trimmed.slice(0, 300)}`), { status: 502 });
      }
      break;
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : null;
      if (status !== 429 || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, GDELT_MIN_INTERVAL_MS * (attempt + 1)));
    }
  }
  const payload = JSON.parse(rawPayload) as { articles?: Record<string, unknown>[] };
  return (payload.articles ?? [])
    .flatMap((article) => {
      const title = String(article.title ?? "").trim();
      const itemUrl = String(article.url ?? "").trim();
      const publishedAt = parseGdeltSeenDate(article.seendate);
      if (!title || !itemUrl || !publishedAt) return [];
      const item: NewsItem = {
        title,
        url: itemUrl,
        source_name: String(article.source ?? article.domain ?? "GDELT"),
        published_at: publishedAt,
        summary: String(article.sourcecountry ?? article.domain ?? "").trim() || null,
        source_group: "archive",
        perspective: "archive_search",
        source_url: GDELT_BASE_URL,
        raw: article
      };
      return [item];
    });
}

async function fetchGdeltNews(query: string, options: NewsFetchOptions = {}): Promise<NewsItem[]> {
  const limit = normalizeLimit(options.limit);
  const oldest = sinceDate(options.lookbackDays);
  const seen = new Set<string>();
  const items: NewsItem[] = [];
  let windowEnd = new Date();
  const windows: Array<{ start: Date; end: Date }> = [];

  while (windowEnd > oldest) {
    const windowStart = addDays(windowEnd, -90) > oldest ? addDays(windowEnd, -90) : oldest;
    windows.push({ start: windowStart, end: windowEnd });
    windowEnd = addDays(windowStart, -1);
  }

  const perWindowLimit = clampNumber(Math.ceil(limit / Math.max(1, windows.length)), 10, 250);
  const windowErrors: string[] = [];
  for (const window of windows) {
    let windowItems: NewsItem[] = [];
    try {
      windowItems = await fetchGdeltWindow(query, window.start, window.end, perWindowLimit);
    } catch (error) {
      windowErrors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const item of windowItems) {
      const published = new Date(item.published_at);
      if (published < oldest || seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
    }
  }

  if (!items.length && windowErrors.length) {
    throw new Error(windowErrors.join(" / "));
  }
  return selectDiverseByDate(items, limit);
}

function parseFeedItems(xml: string, source: NewsSource, oldest: Date): NewsItem[] {
  const rssItems = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
    const item = match[1];
    const title = xmlValue(item, "title");
    const link = absoluteUrl(xmlValue(item, "link") ?? xmlValue(item, "guid"), source.url);
    const publishedAt = feedPublishedAt(item);
    if (!title || !link || !publishedAt || new Date(publishedAt) < oldest) return [];
    const description = xmlValue(item, "description") ?? xmlValue(item, "summary") ?? xmlValue(item, "content:encoded");
    return [
      {
        title: stripTags(title),
        url: link,
        source_name: source.source_name,
        published_at: publishedAt,
        summary: description ? stripTags(description).slice(0, 420) : null,
        source_group: source.source_group,
        perspective: source.perspective,
        source_url: source.url
      } satisfies NewsItem
    ];
  });

  const atomItems = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].flatMap((match) => {
    const item = match[1];
    const title = xmlValue(item, "title");
    const link = absoluteUrl(atomLinkValue(item) ?? xmlValue(item, "link"), source.url);
    const publishedAt = feedPublishedAt(item);
    if (!title || !link || !publishedAt || new Date(publishedAt) < oldest) return [];
    const description = xmlValue(item, "summary") ?? xmlValue(item, "content") ?? xmlValue(item, "description");
    return [
      {
        title: stripTags(title),
        url: link,
        source_name: source.source_name,
        published_at: publishedAt,
        summary: description ? stripTags(description).slice(0, 420) : null,
        source_group: source.source_group,
        perspective: source.perspective,
        source_url: source.url
      } satisfies NewsItem
    ];
  });

  return [...rssItems, ...atomItems];
}

async function fetchFeedNews(sources: NewsSource[], options: NewsFetchOptions = {}): Promise<{ items: NewsItem[]; errors: string[] }> {
  const oldest = sinceDate(options.lookbackDays);
  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const xml = await fetchText(source.url);
      return parseFeedItems(xml, source, oldest);
    })
  );

  return {
    items: dedupeNewsItems(
      settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
      normalizeLimit(options.limit)
    ),
    errors: settled
      .flatMap((result, index) => (result.status === "rejected" ? [`${sources[index].source_name}: ${String(result.reason?.message ?? result.reason)}`] : []))
      .filter(Boolean)
  };
}

async function saveNewsItem(item: NewsItem, options: { ticker?: string; eventType: string; keyPoints: string[] }): Promise<DocumentRecord> {
  await deleteDocumentByUrl(item.url);
  const sourceGroup = item.source_group ?? (item.raw ? "archive" : "trusted_news");
  const perspective = item.perspective ?? "unknown";
  const investmentSummary =
    sourceGroup === "official"
      ? "公的機関・国際機関の一次情報です。金融政策、財政、産業政策、統計、国際金融環境の変化を投資仮説の根拠として確認します。"
      : sourceGroup === "trusted_news"
        ? "信頼できるニュースサイトの見出しです。経済・地政学テーマの発生、波及先、時間軸を確認する入口として保存しています。"
        : "GDELTの公開記事アーカイブ検索結果です。過去1年以上の報道量と論点を広く拾い、一次情報や配信元で裏取りします。";
  const riskSummary =
    sourceGroup === "official"
      ? "発表文の文脈、対象期間、統計改定、政策決定の条件を原文で確認してください。"
      : "本文全文は未取得です。タイトル、媒体、記事日時からの一次スクリーニングであり、重要判断には配信元本文と一次情報の確認が必要です。";
  return createDocument({
    ticker: options.ticker,
    source_type: "news",
    source_name: item.source_name,
    title: item.title,
    url: item.url,
    published_at: item.published_at,
    storage_level: "metadata_only",
    retrieval_status: "metadata_only",
    raw_text: JSON.stringify({
      source_group: sourceGroup,
      perspective,
      source_feed_url: item.source_url ?? null,
      archive_raw: item.raw ?? null
    }),
    summary_short: item.summary || item.title,
    summary_investment: investmentSummary,
    summary_risk: riskSummary,
    key_points: [item.source_name, sourceGroup, perspective, ...options.keyPoints],
    event_type: options.eventType,
    sentiment: "neutral",
    impact_horizon: "unknown",
    affected_metrics: ["revenue_growth", "operating_margin", "valuation"],
    importance_score: sourceGroup === "official" ? 0.6 : sourceGroup === "trusted_news" ? 0.48 : 0.38,
    confidence: sourceGroup === "official" ? 0.78 : sourceGroup === "trusted_news" ? 0.68 : 0.55
  });
}

function rawTextLooksLikeMetadata(rawText: string | null | undefined): boolean {
  const text = String(rawText ?? "").trim();
  return !text || text.startsWith("{") || text.startsWith("[");
}

function validArticleUrl(url: string | null | undefined): string | null {
  const text = String(url ?? "").trim();
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isUnsupportedBodyUrl(url: string): boolean {
  return /\.(?:pdf|zip|xlsx?|pptx?|docx?|csv)(?:[?#].*)?$/i.test(url);
}

function normalizeReadableText(text: string): string {
  return decodeHtml(text)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<(?:header|footer|nav|form|aside)\b[\s\S]*?<\/(?:header|footer|nav|form|aside)>/gi, " ")
    .replace(/<(?:br|p|li|h[1-6]|tr|div|section|article|main)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|li|h[1-6]|tr|div|section|article|main)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeReadableText(cleaned);
}

function articleCandidates(html: string): string[] {
  const candidates: string[] = [];
  for (const tag of ["article", "main"]) {
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match) candidates.push(match[1]);
  }
  const contentMatches = [...html.matchAll(/<(?:div|section)\b[^>]*(?:class|id)=["'][^"']*(?:article|entry|post|story|news|content|main|body)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|section)>/gi)];
  contentMatches.slice(0, 12).forEach((match) => candidates.push(match[1]));
  candidates.push(html);
  return candidates.map(htmlText).filter((text) => text.length >= ARTICLE_BODY_MIN_CHARS);
}

function extractArticleBody(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty article response");
  if (trimmed.startsWith("%PDF")) throw new Error("PDF article body extraction is not supported yet");
  if (/^<\?xml|<rss\b|<feed\b/i.test(trimmed)) throw new Error("feed document is not an article body");

  const body = /<html\b|<body\b|<article\b|<main\b/i.test(trimmed)
    ? articleCandidates(trimmed).sort((a, b) => b.length - a.length)[0]
    : normalizeReadableText(stripTags(trimmed));
  if (!body || body.length < ARTICLE_BODY_MIN_CHARS) {
    throw new Error(`article body was too short (${body?.length ?? 0} chars)`);
  }
  return body;
}

function canFetchDocumentBody(document: DocumentRecord): boolean {
  const url = validArticleUrl(document.url);
  if (!url || isUnsupportedBodyUrl(url)) return false;
  if (document.retrieval_status === "full_text" && !rawTextLooksLikeMetadata(document.raw_text) && String(document.raw_text ?? "").length >= ARTICLE_BODY_MIN_CHARS) {
    return false;
  }
  return true;
}

function documentKeyPoints(document: DocumentRecord): string[] {
  if (!Array.isArray(document.key_points)) return [];
  return document.key_points
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
    .filter((item) => item && item.length < 160);
}

export async function fetchAndCacheDocumentBody(document: DocumentRecord, options: { maxChars?: number } = {}) {
  const url = validArticleUrl(document.url);
  if (!url) return { document_id: document.id, title: document.title, skipped: true, reason: "missing_url" };
  if (isUnsupportedBodyUrl(url)) return { document_id: document.id, title: document.title, url, skipped: true, reason: "unsupported_binary_url" };
  if (!canFetchDocumentBody(document)) return { document_id: document.id, title: document.title, url, skipped: true, reason: "already_full_text" };

  const raw = await fetchText(url, ARTICLE_BODY_TIMEOUT_MS, { family: 4 });
  const body = extractArticleBody(raw);
  const maxChars = Math.max(2_000, Math.min(Number(options.maxChars ?? 40_000), 120_000));
  const storedBody = body.length > maxChars ? body.slice(0, maxChars) : body;
  const keyPoints = [...new Set(documentKeyPoints(document).slice(0, 12))];
  const updated = await updateDocumentBody(document.id, {
    raw_text: storedBody,
    summary_risk: "本文を取得済みです。投資判断では、記事本文の時点、媒体の文脈、一次情報での裏取りを確認してください。",
    key_points: [...new Set([...keyPoints, "full_text_body"])]
  });
  return {
    document_id: document.id,
    title: document.title,
    url,
    fetched_chars: body.length,
    stored_chars: storedBody.length,
    retrieval_status: updated?.retrieval_status ?? "full_text",
    skipped: false
  };
}

export async function fetchAndCacheDocumentBodies(
  documents: DocumentRecord[],
  options: { limit?: number; maxChars?: number } = {}
): Promise<{
  requested: number;
  attempted: number;
  fetched: number;
  skipped: number;
  errors: Array<{ document_id: number; title: string; url?: string | null; message: string }>;
  documents: Array<Record<string, unknown>>;
}> {
  const seen = new Set<string>();
  const unique = documents.filter((document) => {
    const key = document.url || String(document.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const limit = Math.max(0, Math.min(Number(options.limit ?? 8), 50));
  const candidates = unique.filter(canFetchDocumentBody).slice(0, limit);
  const fetched: Array<Record<string, unknown>> = [];
  const errors: Array<{ document_id: number; title: string; url?: string | null; message: string }> = [];

  for (const document of candidates) {
    try {
      const result = await fetchAndCacheDocumentBody(document, { maxChars: options.maxChars });
      if (result.skipped) {
        continue;
      }
      fetched.push(result);
    } catch (error) {
      errors.push({
        document_id: document.id,
        title: document.title,
        url: document.url,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    requested: unique.length,
    attempted: candidates.length,
    fetched: fetched.length,
    skipped: unique.length - candidates.length,
    errors,
    documents: fetched
  };
}

export async function fetchAndSaveCompanyNews(tickerInput: string, options: NewsFetchOptions = {}) {
  const ticker = tickerInput.trim().replace(/\.T$/i, "").replace(/\D/g, "").slice(0, 5);
  const company = await getCompany(ticker);
  const query =
    options.query ??
    companyQuery({
      ticker,
      companyName: company?.name ?? options.companyName,
      englishName: company?.english_name,
      sector: company?.sector ?? options.sector
    });
  const errors: string[] = [];
  let items: NewsItem[] = [];
  try {
    items = await fetchGdeltNews(query, options);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const saved = await Promise.all(items.map((item) => saveNewsItem(item, { ticker, eventType: "company_news", keyPoints: [ticker, company?.sector ?? "company"] })));
  return {
    ticker,
    query,
    lookback_days: options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
    fetched: items.length,
    saved: saved.length,
    newest_published_at: saved[0]?.published_at ?? null,
    oldest_published_at: saved[saved.length - 1]?.published_at ?? null,
    errors
  };
}

export async function fetchAndSaveMacroNews(options: NewsFetchOptions = {}) {
  const query = options.query ?? MACRO_NEWS_QUERY;
  const limit = normalizeLimit(options.limit);
  const official = await fetchFeedNews(officialSources(), { ...options, limit });
  const trusted = await fetchFeedNews(trustedNewsSources(), { ...options, limit });
  const officialQuota = Math.ceil(limit * 0.35);
  const trustedQuota = Math.ceil(limit * 0.3);
  const archiveQuota = Math.max(80, limit - officialQuota - trustedQuota);
  const errors = [...official.errors, ...trusted.errors];
  let archive: NewsItem[] = [];
  try {
    archive = await fetchGdeltNews(query, { ...options, limit: archiveQuota });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const quotaItems = [
    ...dedupeNewsItems(official.items, officialQuota),
    ...dedupeNewsItems(trusted.items, trustedQuota),
    ...selectDiverseByDate(archive, archiveQuota)
  ];
  const quotaUrls = new Set(quotaItems.map((item) => item.url));
  const fillItems = dedupeNewsItems([...official.items, ...trusted.items, ...archive], limit)
    .filter((item) => !quotaUrls.has(item.url))
    .slice(0, Math.max(0, limit - quotaItems.length));
  const items = dedupeNewsItems([...quotaItems, ...fillItems], limit);
  const saved = await Promise.all(
    items.map((item) => saveNewsItem(item, { eventType: "macro", keyPoints: ["macro", item.perspective ?? "unknown"] }))
  );
  return {
    query,
    lookback_days: options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
    fetched: items.length,
    saved: saved.length,
    source_counts: {
      official: official.items.length,
      trusted_news: trusted.items.length,
      archive: archive.length
    },
    documents: saved,
    newest_published_at: saved[0]?.published_at ?? null,
    oldest_published_at: saved[saved.length - 1]?.published_at ?? null,
    errors
  };
}

export function newsSourceCatalog() {
  return {
    official: officialSources(),
    trusted_news: trustedNewsSources(),
    archive: [
      {
        url: GDELT_BASE_URL,
        source_name: "GDELT DOC 2.0",
        source_group: "archive",
        perspective: "historical_news_archive"
      }
    ],
    defaults: {
      lookback_days: DEFAULT_LOOKBACK_DAYS,
      max_records: DEFAULT_LIMIT,
      gdelt_min_interval_ms: GDELT_MIN_INTERVAL_MS
    }
  };
}
