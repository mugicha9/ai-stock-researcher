import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { URL } from "node:url";
import pino from "pino";
import { config } from "./config.js";
import type { JsonRecord } from "./types.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined
});

export class ResearchError extends Error {
  constructor(
    message: string,
    public status = 502,
    public details?: unknown
  ) {
    super(message);
  }
}

type ResearchPostOptions = {
  requestId?: string;
  route?: string;
  signal?: AbortSignal;
};

type LongHttpResponse = {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  text: string;
};

class ResearchTransportTimeoutError extends Error {
  code = "RESEARCH_RESPONSE_TIMEOUT";

  constructor(timeoutMs: number) {
    super(`Research backend did not send a complete response within ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

function payloadStats(payload: JsonRecord) {
  const context = payload.context && typeof payload.context === "object" && !Array.isArray(payload.context) ? (payload.context as JsonRecord) : {};
  return {
    bytes: Buffer.byteLength(JSON.stringify(payload)),
    documents: Array.isArray(payload.documents) ? payload.documents.length : undefined,
    hypotheses: Array.isArray(payload.hypotheses) ? payload.hypotheses.length : undefined,
    companies: Array.isArray(payload.companies) ? payload.companies.length : undefined,
    prices: Array.isArray(payload.prices) ? payload.prices.length : undefined,
    macro_indicators: Array.isArray(context.macro_indicators) ? context.macro_indicators.length : undefined,
    sector_snapshots: Array.isArray(context.sector_snapshots) ? context.sector_snapshots.length : undefined,
    recent_events: Array.isArray(context.recent_events) ? context.recent_events.length : undefined,
    llm_input_budget: payload.llm_input_budget
  };
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

function responseHeaderSummary(headers: IncomingHttpHeaders): JsonRecord {
  return {
    content_type: headers["content-type"],
    content_length: headers["content-length"],
    request_id: headers["x-request-id"]
  };
}

function notifyResearchCancel(requestId?: string, route?: string, researchPath?: string): void {
  if (!requestId) return;
  const url = new URL(`${config.researchApiUrl}/requests/${encodeURIComponent(requestId)}/cancel`);
  const client = url.protocol === "https:" ? https : http;
  const request = client.request(
    url,
    {
      method: "POST",
      headers: {
        "x-request-id": requestId,
        "x-api-route": route ?? "",
        accept: "application/json"
      },
      timeout: 5000
    },
    (response) => {
      response.resume();
      logger.warn(
        {
          request_id: requestId,
          route,
          research_path: researchPath,
          cancel_status: response.statusCode
        },
        "research cancel notification sent"
      );
    }
  );
  request.on("timeout", () => request.destroy());
  request.on("error", (error) => {
    logger.warn({ request_id: requestId, route, research_path: researchPath, error: serializeError(error) }, "research cancel notification failed");
  });
  request.end();
}

function postJsonWithLongTimeout(
  urlString: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  onHeaders: (response: Omit<LongHttpResponse, "text">) => void,
  signal?: AbortSignal,
  onAbort?: () => void
): Promise<LongHttpResponse> {
  return new Promise((resolve, reject) => {
    const abortError = () => {
      if (signal?.reason instanceof Error) return signal.reason;
      const error = new Error("Research request aborted by client");
      error.name = "AbortError";
      (error as Error & { code?: string }).code = "ABORT_ERR";
      return error;
    };
    if (signal?.aborted) {
      onAbort?.();
      reject(abortError());
      return;
    }
    const url = new URL(urlString);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-length": Buffer.byteLength(body)
        },
        timeout: timeoutMs
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const statusText = response.statusMessage ?? "";
        onHeaders({ status, statusText, headers: response.headers });

        response.setEncoding("utf8");
        let text = "";
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status, statusText, headers: response.headers, text });
        });
        response.on("error", reject);
      }
    );

    request.on("timeout", () => {
      request.destroy(new ResearchTransportTimeoutError(timeoutMs));
    });
    request.on("error", reject);
    let abortNotified = false;
    const abortRequest = () => {
      if (!abortNotified) {
        abortNotified = true;
        onAbort?.();
      }
      request.destroy(abortError());
    };
    signal?.addEventListener("abort", abortRequest, { once: true });
    request.on("close", () => signal?.removeEventListener("abort", abortRequest));
    request.end(body);
  });
}

export async function researchPost<T extends JsonRecord = JsonRecord>(
  path: string,
  payload: JsonRecord,
  options: ResearchPostOptions = {}
): Promise<T> {
  const url = `${config.researchApiUrl}${path}`;
  const startedAt = Date.now();
  const stats = payloadStats(payload);
  const body = JSON.stringify(payload);
  const waitLogger = setInterval(() => {
    logger.info(
      {
        request_id: options.requestId,
        route: options.route,
        research_path: path,
        duration_ms: Date.now() - startedAt,
        timeout_ms: config.researchTimeoutMs
      },
      "research request still waiting"
    );
  }, 60_000);
  waitLogger.unref();
  logger.info(
    { request_id: options.requestId, route: options.route, research_path: path, timeout_ms: config.researchTimeoutMs, payload: stats },
    "research request started"
  );

  try {
    const response = await postJsonWithLongTimeout(
      url,
      body,
      {
        "content-type": "application/json",
        accept: "application/json",
        "x-request-id": options.requestId ?? "",
        "x-api-route": options.route ?? ""
      },
      config.researchTimeoutMs,
      (headersResponse) => {
        logger.info(
          {
            request_id: options.requestId,
            route: options.route,
            research_path: path,
            status: headersResponse.status,
            duration_ms: Date.now() - startedAt,
            response_headers: responseHeaderSummary(headersResponse.headers)
          },
          "research response headers received"
        );
      },
      options.signal,
      () => notifyResearchCancel(options.requestId, options.route, path)
    );

    if (response.status < 200 || response.status >= 300) {
      logger.error(
        {
          request_id: options.requestId,
          route: options.route,
          research_path: path,
          status: response.status,
          duration_ms: Date.now() - startedAt,
          body: response.text.slice(0, 2000)
        },
        "research request failed"
      );
      throw new ResearchError(`Research backend returned ${response.status}`, response.status, response.text);
    }

    logger.info(
      {
        request_id: options.requestId,
        route: options.route,
        research_path: path,
        status: response.status,
        duration_ms: Date.now() - startedAt,
        response_bytes: Buffer.byteLength(response.text)
      },
      "research request completed"
    );
    try {
      return JSON.parse(response.text) as T;
    } catch (error) {
      logger.error(
        {
          request_id: options.requestId,
          route: options.route,
          research_path: path,
          status: response.status,
          duration_ms: Date.now() - startedAt,
          response_excerpt: response.text.slice(0, 2000),
          error: serializeError(error)
        },
        "research response invalid json"
      );
      throw new ResearchError("Research backend returned invalid JSON", 502, {
        response_excerpt: response.text.slice(0, 2000),
        parse_error: serializeError(error)
      });
    }
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    const aborted = options.signal?.aborted || (error instanceof Error && error.name === "AbortError");
    logger[aborted ? "warn" : "error"](
      { request_id: options.requestId, route: options.route, research_path: path, duration_ms: Date.now() - startedAt, error: serializeError(error) },
      aborted ? "research request aborted" : "research request errored"
    );
    throw error;
  } finally {
    clearInterval(waitLogger);
  }
}

export async function researchHealth(): Promise<JsonRecord> {
  const response = await fetch(`${config.researchApiUrl}/health`, {
    signal: AbortSignal.timeout(3_000)
  });
  if (!response.ok) {
    throw new ResearchError(`Research health returned ${response.status}`, response.status);
  }
  return (await response.json()) as JsonRecord;
}
