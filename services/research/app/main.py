from __future__ import annotations

import asyncio
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

from fastapi import FastAPI, Request, Response

from .fallback import discovery_response, document_summary
from .llama_client import LlamaClient
from .prompts import AGENT_SYSTEMS, DISCOVERY_SYSTEM, SUMMARY_SYSTEM, agent_user_prompt, discovery_user_prompt, summary_user_prompt
from .schemas import AgentRequest, CompanyResearchRequest, DocumentSummaryRequest

app = FastAPI(title="Stock Research Backend", version="0.1.0")
llama = LlamaClient()
logger = logging.getLogger("research.api")
active_request_tasks: dict[str, asyncio.Task[Any]] = {}


def log_event(event: str, **fields: Any) -> None:
    logger.info("%s %s", event, json.dumps(fields, ensure_ascii=False, default=str))


def bool_env(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.strip().lower() not in {"0", "false", "no", "off"}


def int_env(name: str, fallback: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(fallback)))
    except (TypeError, ValueError):
        value = fallback
    return max(minimum, min(value, maximum))


def request_id(request: Request) -> str:
    return request.headers.get("x-request-id") or str(uuid.uuid4())


def register_active_request(current_request_id: str | None) -> asyncio.Task[Any] | None:
    if not current_request_id:
        return None
    task = asyncio.current_task()
    if task is not None:
        active_request_tasks[current_request_id] = task
    return task


def unregister_active_request(current_request_id: str | None, task: asyncio.Task[Any] | None) -> None:
    if current_request_id and task is not None and active_request_tasks.get(current_request_id) is task:
        active_request_tasks.pop(current_request_id, None)


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
        return " 必要なら内部で深く検討してよいですが、最終出力には思考過程ではなく、先頭のCONTROL_JSONと次工程へ渡す分析本文だけを書いてください。"
    return (
        " /no_think "
        "内部推論、<think>、Markdownコードフェンスを出さず、先頭のCONTROL_JSONと次工程へ渡す分析本文だけを出してください。"
    )


def resolve_thinking_enabled(payload: dict[str, Any]) -> tuple[bool, str]:
    mode = str(payload.get("llm_thinking_mode") or os.getenv("LLM_THINKING_MODE", "auto")).strip().lower()
    if mode == "think":
        return True, "think"
    if mode == "no_think":
        return False, "no_think"
    return bool_env("LLM_AUTO_THINKING_FOR_JSON", False), "auto"


def discovery_max_tokens(payload: dict[str, Any]) -> int:
    cap = int_env("LLM_DISCOVERY_MAX_TOKENS", 4096, 1200, 8192)
    configured = payload.get("llm_output_max_tokens")
    if configured is not None:
        try:
            return max(900, min(int(configured), cap))
        except (TypeError, ValueError):
            pass
    try:
        candidate_limit = int(payload.get("limit") or 4)
    except (TypeError, ValueError):
        candidate_limit = 4
    return max(1800, min(cap, 1600 + candidate_limit * 900))


def agent_max_tokens(agent_name: str, payload: dict[str, Any], override: int | None = None) -> int:
    if override is not None:
        return override
    cap = (
        int_env("LLM_RESEARCHER_MAX_TOKENS", 4096, 1200, 8192)
        if agent_name == "researcher"
        else int_env("LLM_AGENT_MAX_TOKENS", 3072, 900, 8192)
    )
    configured = payload.get("llm_output_max_tokens")
    if configured is not None:
        try:
            return max(700, min(int(configured), cap))
        except (TypeError, ValueError):
            pass
    return cap


CONTROL_BLOCK_RE = re.compile(r"<CONTROL_JSON>\s*(\{.*?\})\s*</CONTROL_JSON>", re.DOTALL | re.IGNORECASE)
CONTROL_KEYS = {
    "next_action",
    "next_agent",
    "should_continue",
    "ui_summary",
    "reason_for_next_action",
    "data_requests",
    "missing_information",
    "recommended_next_research",
    "final_decision",
    "final_report",
}


def text_excerpt(value: Any, limit: int = 4000) -> str:
    text = str(value or "").strip()
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"\s+\n", "\n", text)
    return text if len(text) <= limit else f"{text[:limit]}\n...[truncated {len(text) - limit} chars]"


def strip_json_code_fence(value: str) -> str:
    text = value.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    return fenced.group(1).strip() if fenced else text


def has_control_keys(value: Any) -> bool:
    return isinstance(value, dict) and any(key in value for key in CONTROL_KEYS)


def decode_control_fragment(value: str) -> tuple[dict[str, Any], str] | None:
    text = strip_json_code_fence(value)
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", text):
        start = match.start()
        fragment = text[start:]
        left_trimmed = fragment.lstrip()
        leading = len(fragment) - len(left_trimmed)
        try:
            parsed, end = decoder.raw_decode(left_trimmed)
        except Exception:
            continue
        if not has_control_keys(parsed):
            continue
        end_index = start + leading + end
        handoff = f"{text[:start].strip()}\n{text[end_index:].strip()}".strip()
        return parsed, handoff
    return None


def extract_control_json(content: str) -> tuple[dict[str, Any], str, str | None]:
    text = str(content or "").strip()
    match = CONTROL_BLOCK_RE.search(text)
    raw_control: str | None = match.group(1) if match else None
    if match:
        handoff = f"{text[: match.start()].strip()}\n{text[match.end() :].strip()}".strip()
        try:
            parsed = json.loads(raw_control)
            if isinstance(parsed, dict):
                return parsed, text_excerpt(handoff), None
            return {}, text_excerpt(handoff), "control_json_not_object"
        except Exception as exc:
            return {}, text_excerpt(handoff), f"control_json_parse_failed: {exc}"

    marker = re.search(r"CONTROL_JSON\s*:?", text, flags=re.IGNORECASE)
    if marker:
        decoded = decode_control_fragment(text[marker.end() :])
        if decoded:
            parsed, marker_handoff = decoded
            handoff = f"{text[: marker.start()].strip()}\n{marker_handoff}".strip()
            return parsed, text_excerpt(handoff), None

    decoded = decode_control_fragment(text)
    if decoded:
        parsed, handoff = decoded
        return parsed, text_excerpt(handoff), None
    return {}, text_excerpt(text), "control_json_missing"


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


def normalize_next_agent(value: Any) -> str | None:
    if value in {"hypothesis", "skeptic", "researcher", "collector"}:
        return str(value)
    if value is None or value == "null":
        return None
    return None


def normalize_next_action(value: Any) -> str | None:
    if value in {"call_agent", "request_data", "finalize", "stop"}:
        return str(value)
    return None


def normalize_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0"}:
            return False
    return None


def control_validation_error(agent_name: str, control: dict[str, Any], parse_warning: str | None) -> str | None:
    if parse_warning:
        return parse_warning

    next_action = normalize_next_action(control.get("next_action"))
    next_agent = normalize_next_agent(control.get("next_agent"))
    should_continue = normalize_bool(control.get("should_continue"))

    if next_action is None:
        return "next_action_missing_or_invalid"
    if should_continue is None:
        return "should_continue_missing_or_invalid"

    if next_action == "call_agent":
        if next_agent not in {"hypothesis", "skeptic", "researcher"}:
            return "call_agent_requires_hypothesis_skeptic_or_researcher"
        return None

    if next_action == "request_data":
        if next_agent != "collector":
            return "request_data_requires_next_agent_collector"
        return None

    if next_action == "finalize":
        if agent_name != "researcher":
            return "only_researcher_can_finalize"
        if next_agent is not None:
            return "finalize_requires_null_next_agent"
        return None

    if next_action == "stop":
        if next_agent is not None:
            return "stop_requires_null_next_agent"
        return None

    return "next_action_missing_or_invalid"


def normalize_agent_text_output(
    agent_name: str,
    text_result: dict[str, Any],
) -> dict[str, Any]:
    content = str(text_result.get("content") or "")
    control, handoff_text, parse_warning = extract_control_json(content)
    next_action = normalize_next_action(control.get("next_action"))
    next_agent = normalize_next_agent(control.get("next_agent"))
    should_continue = normalize_bool(control.get("should_continue"))
    validation_error = control_validation_error(agent_name, control, parse_warning)

    missing_control_message = "LLM応答はありましたが、有効なCONTROL_JSONを抽出できませんでした。"
    summary_source = control.get("ui_summary") or control.get("summary") or handoff_text or missing_control_message
    reason_source = control.get("reason_for_next_action") or control.get("reason") or summary_source

    output: dict[str, Any] = {
        "agent_name": agent_name,
        "handoff_text": handoff_text,
        "ui_summary": text_excerpt(summary_source, 180),
        "next_action": next_action,
        "next_agent": next_agent,
        "should_continue": should_continue,
        "reason_for_next_action": text_excerpt(reason_source, 240),
        "data_requests": compact_dict_list(
            control.get("data_requests"),
            5,
            {"query", "source", "reason", "priority", "ticker", "target", "company", "company_name"},
        ),
        "missing_information": compact_string_list(control.get("missing_information"), 6),
        "recommended_next_research": compact_string_list(control.get("recommended_next_research"), 6),
        "llm_control_format": "text_with_control_json",
        "llm_raw": text_result.get("llm_raw"),
        "llm_finish_reason": text_result.get("finish_reason"),
    }

    claims = compact_dict_list(control.get("claims"), 5, {"claim", "evidence_ids", "confidence", "status"})
    questions = compact_dict_list(control.get("questions"), 5, {"question", "priority", "target_agent", "reason"})
    if claims:
        output["claims"] = claims
    if questions:
        output["questions"] = questions

    for key in ["final_decision", "evidence_strength", "contradiction_strength"]:
        if control.get(key) is not None:
            output[key] = control.get(key)
    if isinstance(control.get("scores"), dict):
        output["scores"] = control.get("scores")
    if isinstance(control.get("final_report"), str):
        output["final_report"] = text_excerpt(control.get("final_report"), 1200)
    elif agent_name == "researcher" and next_action in {"finalize", "stop"}:
        output["final_report"] = text_excerpt(handoff_text, 1200)
    if validation_error:
        output["llm_control_parse_warning"] = validation_error
        output["raw_model_output"] = content[:4000]
    if text_result.get("llm_fallback"):
        output["llm_fallback"] = True
        output["fallback_reason"] = text_result.get("fallback_reason")
    return output


def normalize_discovery_output(output: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
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
        normalized["next_action"] = None
        normalized.setdefault("llm_parse_warning", "discovery next_action missing or invalid")

    if not isinstance(normalized.get("reason"), str) or not normalized.get("reason"):
        normalized["reason"] = "仮説発見結果に有効な理由が含まれていません。"

    return normalized


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    current_request_id = request_id(request)
    started_at = time.perf_counter()
    try:
        response = await call_next(request)
    except asyncio.CancelledError:
        log_event(
            "request_cancelled",
            request_id=current_request_id,
            api_route=request.headers.get("x-api-route"),
            method=request.method,
            path=request.url.path,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
        )
        return Response(status_code=499)
    except RuntimeError as exc:
        if str(exc) == "No response returned.":
            log_event(
                "request_cancelled",
                request_id=current_request_id,
                api_route=request.headers.get("x-api-route"),
                method=request.method,
                path=request.url.path,
                duration_ms=round((time.perf_counter() - started_at) * 1000),
            )
            return Response(status_code=499)
        raise
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


@app.post("/requests/{target_request_id}/cancel")
async def cancel_request(target_request_id: str) -> dict[str, Any]:
    task = active_request_tasks.get(target_request_id)
    if task is None or task.done():
        return {"ok": True, "cancelled": False, "request_id": target_request_id, "reason": "not_active"}
    task.cancel()
    log_event("request_cancel_requested", request_id=target_request_id)
    return {"ok": True, "cancelled": True, "request_id": target_request_id}


@app.post("/documents/summarize")
async def summarize_document(body: DocumentSummaryRequest, request: Request) -> dict[str, Any]:
    current_request_id = request_id(request)
    active_task = register_active_request(current_request_id)
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
    try:
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
    except asyncio.CancelledError:
        log_event("document_summarize_cancelled", request_id=current_request_id)
        raise
    finally:
        unregister_active_request(current_request_id, active_task)


async def run_agent(
    agent_name: str,
    payload: dict[str, Any],
    max_tokens: int | None = None,
    current_request_id: str | None = None,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    active_task = register_active_request(current_request_id)
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
        text_result = await llama.complete_text(
            system=AGENT_SYSTEMS[agent_name] + thinking_text_instruction(thinking_enabled),
            user=agent_user_prompt(agent_name, payload),
            fallback={},
            temperature=0.25 if agent_name == "hypothesis" else 0.15,
            max_tokens=effective_max_tokens,
            request_id=current_request_id,
            operation=f"agent.{agent_name}",
            thinking_enabled=thinking_enabled,
        )
        output = normalize_agent_text_output(agent_name, text_result)
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
    except asyncio.CancelledError:
        log_event(
            "agent_cancelled",
            request_id=current_request_id,
            agent_name=agent_name,
            duration_ms=round((time.perf_counter() - started_at) * 1000),
        )
        raise
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
    finally:
        unregister_active_request(current_request_id, active_task)


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
    active_task = register_active_request(current_request_id)
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
    try:
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
        output = normalize_discovery_output(output, payload)
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
    except asyncio.CancelledError:
        log_event("hypothesis_discovery_cancelled", request_id=current_request_id)
        raise
    finally:
        unregister_active_request(current_request_id, active_task)


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
