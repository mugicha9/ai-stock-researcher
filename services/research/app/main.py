from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from typing import Any

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

from fastapi import FastAPI, Request

from .fallback import agent_response, discovery_response, document_summary
from .llama_client import LlamaClient
from .prompts import AGENT_SYSTEMS, DISCOVERY_SYSTEM, SUMMARY_SYSTEM, agent_user_prompt, discovery_user_prompt, summary_user_prompt
from .schemas import AgentRequest, CompanyResearchRequest, DocumentSummaryRequest

app = FastAPI(title="Stock Research Backend", version="0.1.0")
llama = LlamaClient()
logger = logging.getLogger("research.api")


def log_event(event: str, **fields: Any) -> None:
    logger.info("%s %s", event, json.dumps(fields, ensure_ascii=False, default=str))


def bool_env(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.strip().lower() not in {"0", "false", "no", "off"}


def request_id(request: Request) -> str:
    return request.headers.get("x-request-id") or str(uuid.uuid4())


def payload_stats(payload: dict[str, Any]) -> dict[str, Any]:
    handoff = payload.get("agent_handoff") if isinstance(payload.get("agent_handoff"), dict) else {}
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    return {
        "bytes": len(json.dumps(payload, ensure_ascii=False, default=str)),
        "documents": len(payload.get("documents") or []),
        "hypotheses": len(payload.get("hypotheses") or []),
        "companies": len(payload.get("companies") or []),
        "prices": len(payload.get("prices") or []),
        "macro_indicators": len(context.get("macro_indicators") or []),
        "sector_snapshots": len(context.get("sector_snapshots") or []),
        "recent_events": len(context.get("recent_events") or []),
        "history_turns": len(payload.get("loop_history") or []),
        "handoff_from": handoff.get("from_agent"),
        "has_company": bool(payload.get("company")),
        "has_hypothesis": bool(payload.get("hypothesis")),
        "has_question": bool(payload.get("question")),
        "llm_input_budget": payload.get("llm_input_budget"),
    }


def summarize_input(agent_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    hypothesis = payload.get("hypothesis") or {}
    company = payload.get("company") or {}
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    handoff = payload.get("agent_handoff") if isinstance(payload.get("agent_handoff"), dict) else {}
    return {
        "agent_name": agent_name,
        "hypothesis_type": payload.get("hypothesis_type") or hypothesis.get("hypothesis_type"),
        "hypothesis_title": hypothesis.get("title"),
        "company": company.get("name") or company.get("ticker"),
        "sector": hypothesis.get("target_sector") or company.get("sector"),
        "documents": len(payload.get("documents") or []),
        "prices": len(payload.get("prices") or []),
        "macro_indicators": len(context.get("macro_indicators") or []),
        "sector_snapshots": len(context.get("sector_snapshots") or []),
        "recent_events": len(context.get("recent_events") or []),
        "history_turns": len(payload.get("loop_history") or []),
        "handoff_from": handoff.get("from_agent"),
        "llm_thinking_mode": payload.get("llm_thinking_mode"),
    }


def thinking_system_instruction(enabled: bool) -> str:
    if enabled:
        return " 必要なら内部で深く検討してよいですが、最終出力は必ず単一のJSONオブジェクトだけにしてください。"
    return (
        " /no_think "
        "最終出力は単一のJSONオブジェクトのみです。最初の非空白文字は {、最後の非空白文字は } にしてください。"
        "内部推論、説明文、Markdown、コードフェンス、<think>、JSON前後の文章を絶対に出さないでください。"
    )


def thinking_text_instruction(enabled: bool) -> str:
    if enabled:
        return " 必要なら内部で深く検討してよいですが、最終出力には思考過程ではなく、次工程へ渡す分析本文とCONTROL_JSONだけを書いてください。"
    return (
        " /no_think "
        "内部推論、<think>、Markdownコードフェンスを出さず、次工程へ渡す分析本文と最後のCONTROL_JSONだけを出してください。"
    )


def resolve_thinking_enabled(payload: dict[str, Any]) -> tuple[bool, str]:
    mode = str(payload.get("llm_thinking_mode") or os.getenv("LLM_THINKING_MODE", "auto")).strip().lower()
    if mode == "think":
        return True, "think"
    if mode == "no_think":
        return False, "no_think"
    return bool_env("LLM_AUTO_THINKING_FOR_JSON", False), "auto"


def discovery_max_tokens(payload: dict[str, Any]) -> int:
    configured = payload.get("llm_output_max_tokens")
    if configured is not None:
        try:
            return max(900, min(int(configured), 2400))
        except (TypeError, ValueError):
            pass
    try:
        candidate_limit = int(payload.get("limit") or 4)
    except (TypeError, ValueError):
        candidate_limit = 4
    return max(1400, min(3000, 900 + candidate_limit * 350))


def agent_max_tokens(agent_name: str, payload: dict[str, Any], override: int | None = None) -> int:
    if override is not None:
        return override
    configured = payload.get("llm_output_max_tokens")
    if configured is not None:
        try:
            return max(700, min(int(configured), 2200))
        except (TypeError, ValueError):
            pass
    return 2200 if agent_name == "researcher" else 1600


CONTROL_BLOCK_RE = re.compile(r"<CONTROL_JSON>\s*(\{.*?\})\s*</CONTROL_JSON>", re.DOTALL | re.IGNORECASE)


def text_excerpt(value: Any, limit: int = 4000) -> str:
    text = str(value or "").strip()
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"\s+\n", "\n", text)
    return text if len(text) <= limit else f"{text[:limit]}\n...[truncated {len(text) - limit} chars]"


def extract_control_json(content: str) -> tuple[dict[str, Any], str, str | None]:
    text = str(content or "").strip()
    match = CONTROL_BLOCK_RE.search(text)
    raw_control: str | None = match.group(1) if match else None
    if raw_control is None:
        marker = re.search(r"CONTROL_JSON\s*:?\s*(\{.*\})\s*$", text, flags=re.DOTALL | re.IGNORECASE)
        raw_control = marker.group(1) if marker else None
        match = marker
    handoff = text[: match.start()].strip() if match else text
    if raw_control is None:
        return {}, text_excerpt(handoff), "control_json_missing"
    try:
        parsed = json.loads(raw_control)
        if isinstance(parsed, dict):
            return parsed, text_excerpt(handoff), None
        return {}, text_excerpt(handoff), "control_json_not_object"
    except Exception as exc:
        return {}, text_excerpt(handoff), f"control_json_parse_failed: {exc}"


def compact_string_list(value: Any, limit: int = 6, item_limit: int = 180) -> list[str]:
    if isinstance(value, str):
        return [text_excerpt(value, item_limit)] if value.strip() else []
    if not isinstance(value, list):
        return []
    output: list[str] = []
    for item in value[:limit]:
        text = text_excerpt(item, item_limit)
        if text:
            output.append(text)
    return output


def compact_dict_list(value: Any, limit: int, allowed_keys: set[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    output: list[dict[str, Any]] = []
    for item in value[:limit]:
        if not isinstance(item, dict):
            continue
        record = {key: item.get(key) for key in allowed_keys if item.get(key) is not None}
        for key, item_value in list(record.items()):
            if isinstance(item_value, str):
                record[key] = text_excerpt(item_value, 220)
        if record:
            output.append(record)
    return output


def normalize_next_agent(value: Any, fallback: str | None) -> str | None:
    if value in {"hypothesis", "skeptic", "researcher", "collector"}:
        return str(value)
    if value is None or value == "null":
        return None
    return fallback


def normalize_next_action(value: Any, fallback: str = "call_agent") -> str:
    if value in {"call_agent", "request_data", "finalize", "stop"}:
        return str(value)
    return fallback


def normalize_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0"}:
            return False
    return fallback


def normalize_agent_text_output(
    agent_name: str,
    payload: dict[str, Any],
    text_result: dict[str, Any],
    fallback: dict[str, Any],
) -> dict[str, Any]:
    content = str(text_result.get("content") or "")
    control, handoff_text, parse_warning = extract_control_json(content)
    fallback_next_agent = fallback.get("next_agent") if isinstance(fallback.get("next_agent"), str) else "researcher"
    next_action = normalize_next_action(control.get("next_action"), str(fallback.get("next_action") or "call_agent"))
    inferred_next_agent = "collector" if next_action == "request_data" else fallback_next_agent
    next_agent = normalize_next_agent(control.get("next_agent"), inferred_next_agent)
    if next_action in {"finalize", "stop"}:
        next_agent = None if control.get("next_agent") in {None, "null"} else next_agent

    output: dict[str, Any] = {
        **fallback,
        "agent_name": agent_name,
        "handoff_text": handoff_text,
        "ui_summary": text_excerpt(control.get("ui_summary") or control.get("summary") or fallback.get("ui_summary") or handoff_text, 180),
        "next_action": next_action,
        "next_agent": next_agent,
        "should_continue": normalize_bool(control.get("should_continue"), next_action not in {"finalize", "stop"}),
        "reason_for_next_action": text_excerpt(
            control.get("reason_for_next_action") or control.get("reason") or fallback.get("reason_for_next_action") or handoff_text,
            240,
        ),
        "data_requests": compact_dict_list(
            control.get("data_requests"),
            5,
            {"query", "source", "reason", "priority", "ticker", "target", "company", "company_name"},
        ),
        "missing_information": compact_string_list(control.get("missing_information"), 6),
        "recommended_next_research": compact_string_list(control.get("recommended_next_research"), 6),
        "llm_control_format": "text_with_control_json",
        "llm_raw": text_result.get("llm_raw"),
    }

    for key in ["final_decision", "evidence_strength", "contradiction_strength"]:
        if control.get(key) is not None:
            output[key] = control.get(key)
    if isinstance(control.get("scores"), dict):
        output["scores"] = control.get("scores")
    if isinstance(control.get("final_report"), str):
        output["final_report"] = text_excerpt(control.get("final_report"), 1200)
    elif agent_name == "researcher" and next_action in {"finalize", "stop"}:
        output["final_report"] = text_excerpt(handoff_text, 1200)
    if parse_warning:
        output["llm_control_parse_warning"] = parse_warning
        output["raw_model_output"] = content[:4000]
    if text_result.get("llm_fallback"):
        output["llm_fallback"] = True
        output["fallback_reason"] = text_result.get("fallback_reason")
    return output


def normalize_discovery_output(output: dict[str, Any], fallback: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    normalized = {**output}
    try:
        hypothesis_limit = max(1, min(int(payload.get("limit") or 3), 12))
    except (TypeError, ValueError):
        hypothesis_limit = 3

    signals = normalized.get("signals")
    if not isinstance(signals, list):
        normalized["signals"] = []

    hypotheses = normalized.get("hypotheses")
    if not isinstance(hypotheses, list):
        normalized["hypotheses"] = []
        normalized.setdefault("llm_parse_warning", "discovery output did not contain hypotheses array")
    else:
        normalized["hypotheses"] = [item for item in hypotheses if isinstance(item, dict)][:hypothesis_limit]

    rejected_signals = normalized.get("rejected_signals")
    if not isinstance(rejected_signals, list):
        normalized["rejected_signals"] = []

    backlog_signals = normalized.get("backlog_signals")
    if not isinstance(backlog_signals, list):
        normalized["backlog_signals"] = []

    next_action = normalized.get("next_action")
    if next_action not in {"create_hypotheses", "request_data", "stop"}:
        normalized["next_action"] = "request_data" if not normalized["hypotheses"] else "create_hypotheses"

    if not isinstance(normalized.get("reason"), str) or not normalized.get("reason"):
        normalized["reason"] = fallback.get("reason") or "仮説発見結果を正規化しました。"

    return normalized


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    current_request_id = request_id(request)
    started_at = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception(
            "request_failed %s",
            json.dumps(
                {
                    "request_id": current_request_id,
                    "api_route": request.headers.get("x-api-route"),
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": round((time.perf_counter() - started_at) * 1000),
                },
                ensure_ascii=False,
                default=str,
            ),
        )
        raise

    response.headers["x-request-id"] = current_request_id
    log_event(
        "request_completed",
        request_id=current_request_id,
        api_route=request.headers.get("x-api-route"),
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        duration_ms=round((time.perf_counter() - started_at) * 1000),
    )
    return response


@app.get("/health")
async def health() -> dict[str, Any]:
    llama_health = await llama.health()
    return {"ok": True, "llama": llama_health}


@app.post("/documents/summarize")
async def summarize_document(body: DocumentSummaryRequest, request: Request) -> dict[str, Any]:
    current_request_id = request_id(request)
    payload = body.model_dump()
    thinking_enabled, thinking_mode = resolve_thinking_enabled(payload)
    log_event(
        "document_summarize_started",
        request_id=current_request_id,
        title_chars=len(payload.get("title") or ""),
        raw_text_chars=len(payload.get("raw_text") or ""),
        ticker=payload.get("ticker"),
        llm_thinking_mode=thinking_mode,
        thinking_enabled=thinking_enabled,
    )
    return await llama.complete_json(
        system=SUMMARY_SYSTEM + thinking_system_instruction(thinking_enabled),
        user=summary_user_prompt(payload),
        fallback=document_summary(payload),
        temperature=0.1,
        max_tokens=1800,
        request_id=current_request_id,
        operation="documents.summarize",
        thinking_enabled=thinking_enabled,
    )


async def run_agent(
    agent_name: str,
    payload: dict[str, Any],
    max_tokens: int | None = None,
    current_request_id: str | None = None,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    thinking_enabled, thinking_mode = resolve_thinking_enabled(payload)
    effective_max_tokens = agent_max_tokens(agent_name, payload, max_tokens)
    log_event(
        "agent_started",
        request_id=current_request_id,
        agent_name=agent_name,
        max_tokens=effective_max_tokens,
        llm_thinking_mode=thinking_mode,
        thinking_enabled=thinking_enabled,
        input=summarize_input(agent_name, payload),
        payload=payload_stats(payload),
    )
    try:
        fallback = agent_response(agent_name, payload)
        text_result = await llama.complete_text(
            system=AGENT_SYSTEMS[agent_name] + thinking_text_instruction(thinking_enabled),
            user=agent_user_prompt(agent_name, payload),
            fallback=fallback,
            temperature=0.25 if agent_name == "hypothesis" else 0.15,
            max_tokens=effective_max_tokens,
            request_id=current_request_id,
            operation=f"agent.{agent_name}",
            thinking_enabled=thinking_enabled,
        )
        output = normalize_agent_text_output(agent_name, payload, text_result, fallback)
        output.setdefault("agent_name", agent_name)
        output.setdefault("input", summarize_input(agent_name, payload))
        output.setdefault("llm_thinking_mode", thinking_mode)
        output.setdefault("thinking_enabled", thinking_enabled)
        log_event(
            "agent_completed",
            request_id=current_request_id,
            agent_name=agent_name,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
            output_keys=list(output.keys())[:20],
        )
        return output
    except Exception:
        logger.exception(
            "agent_failed %s",
            json.dumps(
                {
                    "request_id": current_request_id,
                    "agent_name": agent_name,
                    "duration_ms": round((time.perf_counter() - started_at) * 1000),
                },
                ensure_ascii=False,
                default=str,
            ),
        )
        raise


@app.post("/agents/hypothesis")
async def hypothesis_agent(body: AgentRequest, request: Request) -> dict[str, Any]:
    return await run_agent("hypothesis", body.model_dump(), current_request_id=request_id(request))


@app.post("/agents/skeptic")
async def skeptic_agent(body: AgentRequest, request: Request) -> dict[str, Any]:
    return await run_agent("skeptic", body.model_dump(), current_request_id=request_id(request))


@app.post("/agents/researcher")
async def researcher_agent(body: AgentRequest, request: Request) -> dict[str, Any]:
    return await run_agent("researcher", body.model_dump(), current_request_id=request_id(request))


@app.post("/hypotheses/discover")
async def discover_hypotheses(body: AgentRequest, request: Request) -> dict[str, Any]:
    current_request_id = request_id(request)
    payload = body.model_dump()
    thinking_enabled, thinking_mode = resolve_thinking_enabled(payload)
    log_event(
        "hypothesis_discovery_started",
        request_id=current_request_id,
        llm_thinking_mode=thinking_mode,
        thinking_enabled=thinking_enabled,
        payload=payload_stats(payload),
        focus=payload.get("focus"),
        sector=payload.get("sector"),
    )
    fallback = discovery_response(payload)
    output = await llama.complete_json(
        system=DISCOVERY_SYSTEM + thinking_system_instruction(thinking_enabled),
        user=discovery_user_prompt(payload),
        fallback=fallback,
        temperature=0.2,
        max_tokens=discovery_max_tokens(payload),
        request_id=current_request_id,
        operation="hypotheses.discover",
        thinking_enabled=thinking_enabled,
    )
    output = normalize_discovery_output(output, fallback, payload)
    output.setdefault("agent_name", "discovery")
    output.setdefault("llm_thinking_mode", thinking_mode)
    output.setdefault("thinking_enabled", thinking_enabled)
    log_event(
        "hypothesis_discovery_completed",
        request_id=current_request_id,
        hypotheses=len(output.get("hypotheses") or []),
        next_action=output.get("next_action"),
    )
    return output


@app.post("/companies/research")
async def research_company(body: CompanyResearchRequest, request: Request) -> dict[str, Any]:
    current_request_id = request_id(request)
    started_at = time.perf_counter()
    payload = body.model_dump()
    log_event("company_research_started", request_id=current_request_id, payload=payload_stats(payload))
    researcher = await run_agent("researcher", payload, max_tokens=1400, current_request_id=current_request_id)
    log_event(
        "company_research_completed",
        request_id=current_request_id,
        duration_ms=round((time.perf_counter() - started_at) * 1000),
    )
    return {
        "agent_runs": [researcher],
        **researcher,
    }


@app.post("/hypotheses/deepen")
async def deepen_hypothesis(body: AgentRequest, request: Request) -> dict[str, Any]:
    current_request_id = request_id(request)
    payload = body.model_dump()
    payload["deepening_mode"] = True
    return await run_agent("researcher", payload, current_request_id=current_request_id)
