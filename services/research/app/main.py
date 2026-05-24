from __future__ import annotations

import json
import logging
import os
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
    return {
        "bytes": len(json.dumps(payload, ensure_ascii=False, default=str)),
        "documents": len(payload.get("documents") or []),
        "hypotheses": len(payload.get("hypotheses") or []),
        "prices": len(payload.get("prices") or []),
        "history_turns": len(payload.get("loop_history") or []),
        "handoff_from": handoff.get("from_agent"),
        "has_company": bool(payload.get("company")),
        "has_hypothesis": bool(payload.get("hypothesis")),
        "has_question": bool(payload.get("question")),
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


def resolve_thinking_enabled(payload: dict[str, Any]) -> tuple[bool, str]:
    mode = str(payload.get("llm_thinking_mode") or os.getenv("LLM_THINKING_MODE", "auto")).strip().lower()
    if mode == "think":
        return True, "think"
    if mode == "no_think":
        return False, "no_think"
    return bool_env("LLM_AUTO_THINKING_FOR_JSON", False), "auto"


def discovery_max_tokens(payload: dict[str, Any]) -> int:
    try:
        candidate_limit = int(payload.get("limit") or 4)
    except (TypeError, ValueError):
        candidate_limit = 4
    return max(1200, min(2600, 700 + candidate_limit * 320))


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
    log_event(
        "agent_started",
        request_id=current_request_id,
        agent_name=agent_name,
        max_tokens=max_tokens or (2200 if agent_name == "researcher" else 1600),
        llm_thinking_mode=thinking_mode,
        thinking_enabled=thinking_enabled,
        input=summarize_input(agent_name, payload),
        payload=payload_stats(payload),
    )
    try:
        output = await llama.complete_json(
            system=AGENT_SYSTEMS[agent_name] + thinking_system_instruction(thinking_enabled),
            user=agent_user_prompt(agent_name, payload),
            fallback=agent_response(agent_name, payload),
            temperature=0.25 if agent_name == "hypothesis" else 0.15,
            max_tokens=max_tokens or (2200 if agent_name == "researcher" else 1600),
            request_id=current_request_id,
            operation=f"agent.{agent_name}",
            thinking_enabled=thinking_enabled,
        )
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
    output = await llama.complete_json(
        system=DISCOVERY_SYSTEM + thinking_system_instruction(thinking_enabled),
        user=discovery_user_prompt(payload),
        fallback=discovery_response(payload),
        temperature=0.2,
        max_tokens=discovery_max_tokens(payload),
        request_id=current_request_id,
        operation="hypotheses.discover",
        thinking_enabled=thinking_enabled,
    )
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
