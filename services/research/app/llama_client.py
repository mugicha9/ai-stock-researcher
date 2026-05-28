from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import time
from typing import Any

import httpx
from fastapi import HTTPException

logger = logging.getLogger("research.llama")


def log_event(event: str, **fields: Any) -> None:
    logger.info("%s %s", event, json.dumps(fields, ensure_ascii=False, default=str))


class LlamaClient:
    def __init__(self) -> None:
        primary_base_url = os.getenv("LLAMA_BASE_URL", "http://localhost:8080/v1").rstrip("/")
        configured_base_urls = os.getenv("LLAMA_BASE_URLS", primary_base_url)
        self.base_urls = self._dedupe_urls([primary_base_url, *configured_base_urls.split(",")])
        self.base_url = self.base_urls[0]
        self.model = os.getenv("LLAMA_MODEL_NAME", "local-gguf")
        self.allow_fallback = os.getenv("ALLOW_LLM_FALLBACK", "false").lower() == "true"
        self.timeout = float(os.getenv("LLAMA_REQUEST_TIMEOUT", "300"))
        self.connect_timeout = float(os.getenv("LLAMA_CONNECT_TIMEOUT", "20"))
        self.request_retries = max(0, self._int_env("LLM_REQUEST_RETRIES", 2))
        self.retry_backoff_seconds = max(0.0, float(os.getenv("LLM_RETRY_BACKOFF_SECONDS", "2")))
        self.json_repair_retries = max(0, self._int_env("LLM_JSON_REPAIR_RETRIES", 1))
        self.json_repair_max_tokens = max(250, min(self._int_env("LLM_JSON_REPAIR_MAX_TOKENS", 700), 1200))
        self.json_repair_input_chars = max(2000, min(self._int_env("LLM_JSON_REPAIR_INPUT_CHARS", 6000), 12000))
        self.json_repair_fallback_chars = max(1000, min(self._int_env("LLM_JSON_REPAIR_FALLBACK_CHARS", 2500), 6000))
        self.response_format_json = os.getenv("LLM_RESPONSE_FORMAT_JSON", "true").lower() not in {"0", "false", "no", "off"}
        self.raw_log_enabled = os.getenv("LLM_RAW_LOG_ENABLED", "true").lower() != "false"
        self.raw_log_max_chars = self._int_env("LLM_RAW_LOG_MAX_CHARS", 24000)

    def _dedupe_urls(self, values: list[str]) -> list[str]:
        urls: list[str] = []
        for value in values:
            url = value.strip().rstrip("/")
            if url and url not in urls:
                urls.append(url)
        return urls or ["http://localhost:8080/v1"]

    def _int_env(self, name: str, fallback: int) -> int:
        try:
            return int(os.getenv(name, str(fallback)))
        except ValueError:
            return fallback

    def _clip(self, value: Any, limit: int | None = None) -> str:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
        max_chars = max(1000, limit or self.raw_log_max_chars)
        return text if len(text) <= max_chars else f"{text[:max_chars]}\n...[truncated {len(text) - max_chars} chars]"

    def _raw_request(
        self,
        *,
        base_url: str,
        system: str,
        user: str,
        temperature: float,
        max_tokens: int,
        operation: str,
        thinking_enabled: bool,
        force_response_format: bool = True,
    ) -> dict[str, Any] | None:
        if not self.raw_log_enabled:
            return None
        return {
            "operation": operation,
            "base_url": base_url,
            "model": self.model,
            "messages": [
                {"role": "system", "content": self._clip(system)},
                {"role": "user", "content": self._clip(user)},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "timeout_seconds": self.timeout,
            "connect_timeout_seconds": self.connect_timeout,
            "response_format": "json_object" if self.response_format_json and force_response_format else None,
            "chat_template_kwargs": {"enable_thinking": thinking_enabled},
        }

    def _http_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(self.timeout, connect=self.connect_timeout)

    def _json_contract(self, thinking_enabled: bool) -> str:
        no_think = "\n/no_think" if not thinking_enabled else ""
        return (
            f"{no_think}\n"
            "JSON STRICT MODE:\n"
            "- Return exactly one valid JSON object and nothing else.\n"
            "- The first non-whitespace character must be { and the last non-whitespace character must be }.\n"
            "- Do not output Markdown fences, prose, XML tags, <think> blocks, comments, or trailing text.\n"
            "- Use double quotes for every JSON key and string value.\n"
            "- Do not use undefined, NaN, Infinity, comments, or trailing commas.\n"
            "- If uncertain, put the uncertainty in JSON fields such as missing_information or reason_for_next_action.\n"
        )

    def _enforce_json_system(self, system: str, thinking_enabled: bool) -> str:
        return f"{system.rstrip()}\n\n{self._json_contract(thinking_enabled)}"

    def _enforce_json_user(self, user: str) -> str:
        return (
            f"{user.rstrip()}\n\n"
            "FINAL OUTPUT CHECK: output only the JSON object. Start with { immediately. End with }."
        )

    def _chat_payload(
        self,
        *,
        system: str,
        user: str,
        temperature: float,
        max_tokens: int,
        thinking_enabled: bool,
        force_response_format: bool = True,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "chat_template_kwargs": {"enable_thinking": thinking_enabled},
        }
        if self.response_format_json and force_response_format:
            payload["response_format"] = {"type": "json_object"}
        return payload

    async def _retry_pause(self, retry_index: int) -> None:
        if retry_index <= 0 or self.retry_backoff_seconds <= 0:
            return
        await asyncio.sleep(self.retry_backoff_seconds * retry_index)

    def _raw_interaction(
        self,
        *,
        request_payload: dict[str, Any] | None,
        status_code: int | None,
        duration_ms: int,
        response_content: str | None = None,
        response_body: Any = None,
    ) -> dict[str, Any] | None:
        if not self.raw_log_enabled:
            return None
        response: dict[str, Any] = {"status_code": status_code, "duration_ms": duration_ms}
        if response_content is not None:
            response["message_content"] = self._clip(response_content)
        if response_body is not None:
            response["body"] = self._clip(response_body, min(self.raw_log_max_chars, 12000))
        return {"request": request_payload, "response": response}

    def _attempt_summary(self, attempts: list[dict[str, Any]]) -> str:
        if not attempts:
            return "no connection attempts were recorded"
        parts: list[str] = []
        for attempt in attempts[-4:]:
            base_url = attempt.get("base_url") or "unknown"
            status = attempt.get("status_code")
            exception_type = attempt.get("exception_type")
            error = str(attempt.get("error") or "").strip()
            label = f"{base_url}"
            if status:
                label += f" status={status}"
            if exception_type:
                label += f" {exception_type}"
            if error:
                label += f" {error[:180]}"
            parts.append(label)
        return " | ".join(parts)

    async def health(self) -> dict[str, Any]:
        attempts: list[dict[str, Any]] = []
        async with httpx.AsyncClient(timeout=3) as client:
            for base_url in self.base_urls:
                try:
                    response = await client.get(f"{base_url}/models")
                    result = {
                        "base_url": base_url,
                        "status_code": response.status_code,
                        "ok": response.is_success,
                    }
                    attempts.append(result)
                    if response.is_success:
                        return {
                            "ok": True,
                            "base_url": base_url,
                            "base_urls": self.base_urls,
                            "model": self.model,
                            "status_code": response.status_code,
                            "fallback_enabled": self.allow_fallback,
                            "thinking_mode": os.getenv("LLM_THINKING_MODE", "auto"),
                            "auto_thinking_for_json": os.getenv("LLM_AUTO_THINKING_FOR_JSON", "false"),
                            "response_format_json": self.response_format_json,
                            "request_retries": self.request_retries,
                            "json_repair_retries": self.json_repair_retries,
                            "json_repair_max_tokens": self.json_repair_max_tokens,
                            "connect_timeout_seconds": self.connect_timeout,
                            "attempts": attempts,
                        }
                except Exception as exc:
                    attempts.append({"base_url": base_url, "ok": False, "error": str(exc)})
        return {
            "ok": False,
            "base_url": self.base_url,
            "base_urls": self.base_urls,
            "model": self.model,
            "error": attempts[-1].get("error") if attempts else "no llama base URLs configured",
            "fallback_enabled": self.allow_fallback,
            "thinking_mode": os.getenv("LLM_THINKING_MODE", "auto"),
            "auto_thinking_for_json": os.getenv("LLM_AUTO_THINKING_FOR_JSON", "false"),
            "response_format_json": self.response_format_json,
            "request_retries": self.request_retries,
            "json_repair_retries": self.json_repair_retries,
            "json_repair_max_tokens": self.json_repair_max_tokens,
            "connect_timeout_seconds": self.connect_timeout,
            "attempts": attempts,
        }

    async def complete_json(
        self,
        *,
        system: str,
        user: str,
        fallback: dict[str, Any],
        temperature: float = 0.2,
        max_tokens: int = 2400,
        request_id: str | None = None,
        operation: str = "llm",
        thinking_enabled: bool = False,
    ) -> dict[str, Any]:
        started_at = time.perf_counter()
        system = self._enforce_json_system(system, thinking_enabled)
        user = self._enforce_json_user(user)
        attempts: list[dict[str, Any]] = []
        last_error_response: dict[str, Any] | None = None
        last_raw_request: dict[str, Any] | None = None
        attempt_number = 0
        log_event(
            "llm_request_started",
            request_id=request_id,
            operation=operation,
            base_urls=self.base_urls,
            model=self.model,
            system_chars=len(system),
            user_chars=len(user),
            max_tokens=max_tokens,
            temperature=temperature,
            timeout_seconds=self.timeout,
            connect_timeout_seconds=self.connect_timeout,
            request_retries=self.request_retries,
            json_repair_retries=self.json_repair_retries,
            response_format_json=self.response_format_json,
            thinking_enabled=thinking_enabled,
        )
        for base_url in self.base_urls:
            for retry_index in range(self.request_retries + 1):
                await self._retry_pause(retry_index)
                attempt_number += 1
                attempt_started_at = time.perf_counter()
                raw_request = self._raw_request(
                    base_url=base_url,
                    system=system,
                    user=user,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    operation=operation,
                    thinking_enabled=thinking_enabled,
                )
                last_raw_request = raw_request
                log_event(
                    "llm_request_attempt_started",
                    request_id=request_id,
                    operation=operation,
                    attempt=attempt_number,
                    retry=retry_index,
                    base_url=base_url,
                )
                async with httpx.AsyncClient(timeout=self._http_timeout()) as client:
                    try:
                        response = await client.post(
                            f"{base_url}/chat/completions",
                            json=self._chat_payload(
                                system=system,
                                user=user,
                                temperature=temperature,
                                max_tokens=max_tokens,
                                thinking_enabled=thinking_enabled,
                            ),
                        )
                        duration_ms = round((time.perf_counter() - attempt_started_at) * 1000)
                        if not response.is_success:
                            last_error_response = {"status_code": response.status_code, "body": response.text[:4000]}
                            attempts.append(
                                {
                                    "attempt": attempt_number,
                                    "retry": retry_index,
                                    "base_url": base_url,
                                    "status_code": response.status_code,
                                    "duration_ms": duration_ms,
                                    "error": response.text[:1000],
                                }
                            )
                            log_event(
                                "llm_request_failed_status",
                                request_id=request_id,
                                operation=operation,
                                attempt=attempt_number,
                                retry=retry_index,
                                base_url=base_url,
                                status_code=response.status_code,
                                duration_ms=duration_ms,
                                response_text=response.text[:1000],
                            )
                            continue

                        try:
                            data = response.json()
                        except Exception as decode_exc:
                            last_error_response = {"status_code": response.status_code, "body": response.text[:4000]}
                            attempts.append(
                                {
                                    "attempt": attempt_number,
                                    "retry": retry_index,
                                    "base_url": base_url,
                                    "status_code": response.status_code,
                                    "duration_ms": duration_ms,
                                    "exception_type": type(decode_exc).__name__,
                                    "error": f"HTTP response was not JSON: {decode_exc}",
                                    "body_excerpt": response.text[:1000],
                                }
                            )
                            log_event(
                                "llm_http_json_decode_failed",
                                request_id=request_id,
                                operation=operation,
                                attempt=attempt_number,
                                retry=retry_index,
                                base_url=base_url,
                                duration_ms=duration_ms,
                                error=str(decode_exc),
                                body_excerpt=response.text[:1000],
                            )
                            continue

                        try:
                            choice = data["choices"][0]
                            content = choice["message"]["content"]
                            finish_reason = choice.get("finish_reason")
                        except Exception as content_exc:
                            attempts.append(
                                {
                                    "attempt": attempt_number,
                                    "retry": retry_index,
                                    "base_url": base_url,
                                    "status_code": response.status_code,
                                    "duration_ms": duration_ms,
                                    "exception_type": type(content_exc).__name__,
                                    "error": f"OpenAI-compatible response missing choices[0].message.content: {content_exc}",
                                    "body_excerpt": self._clip(data, 2000),
                                }
                            )
                            log_event(
                                "llm_response_content_missing",
                                request_id=request_id,
                                operation=operation,
                                attempt=attempt_number,
                                retry=retry_index,
                                base_url=base_url,
                                duration_ms=duration_ms,
                                error=str(content_exc),
                            )
                            continue

                        log_event(
                            "llm_response_received",
                            request_id=request_id,
                            operation=operation,
                            status_code=response.status_code,
                            attempt=attempt_number,
                            retry=retry_index,
                            base_url=base_url,
                            duration_ms=duration_ms,
                            response_chars=len(content),
                            finish_reason=finish_reason,
                            usage=data.get("usage"),
                        )
                        try:
                            parsed = self._parse_json(content)
                            raw_interaction = self._raw_interaction(
                                request_payload=raw_request,
                                status_code=response.status_code,
                                duration_ms=duration_ms,
                                response_content=content,
                                response_body={
                                    "usage": data.get("usage"),
                                    "model": data.get("model"),
                                    "attempts": [
                                        *attempts,
                                        {
                                            "attempt": attempt_number,
                                            "retry": retry_index,
                                            "base_url": base_url,
                                            "status_code": response.status_code,
                                            "duration_ms": duration_ms,
                                            "ok": True,
                                        },
                                    ],
                                },
                            )
                            if raw_interaction:
                                parsed["llm_raw"] = raw_interaction
                            log_event(
                                "llm_json_parsed",
                                request_id=request_id,
                                operation=operation,
                                duration_ms=round((time.perf_counter() - started_at) * 1000),
                                output_keys=list(parsed.keys())[:20],
                            )
                            return parsed
                        except Exception as parse_exc:
                            raw_interaction = self._raw_interaction(
                                request_payload=raw_request,
                                status_code=response.status_code,
                                duration_ms=round((time.perf_counter() - started_at) * 1000),
                                response_content=content,
                                response_body={
                                    "usage": data.get("usage"),
                                    "model": data.get("model"),
                                    "finish_reason": finish_reason,
                                    "attempts": attempts,
                                },
                            )
                            attempts.append(
                                {
                                    "attempt": attempt_number,
                                    "retry": retry_index,
                                    "base_url": base_url,
                                    "status_code": response.status_code,
                                    "duration_ms": duration_ms,
                                    "error": f"json_parse_failed: {parse_exc}",
                                    "response_chars": len(content),
                                    "finish_reason": finish_reason,
                                }
                            )
                            logger.warning(
                                "llm_json_parse_failed %s",
                                json.dumps(
                                    {
                                        "request_id": request_id,
                                        "operation": operation,
                                        "duration_ms": round((time.perf_counter() - started_at) * 1000),
                                        "reason": str(parse_exc),
                                        "response_chars": len(content),
                                        "finish_reason": finish_reason,
                                    },
                                    ensure_ascii=False,
                                    default=str,
                                ),
                            )
                            if finish_reason == "length":
                                logger.warning(
                                    "llm_json_parse_failed_truncated %s",
                                    json.dumps(
                                        {
                                            "request_id": request_id,
                                            "operation": operation,
                                            "duration_ms": round((time.perf_counter() - started_at) * 1000),
                                            "response_chars": len(content),
                                            "max_tokens": max_tokens,
                                        },
                                        ensure_ascii=False,
                                        default=str,
                                    ),
                                )
                                return self._fallback_with_raw_output(
                                    fallback,
                                    content,
                                    "model output reached max_tokens before closing valid JSON",
                                    raw_interaction,
                                )
                            repaired = await self._repair_json_output(
                                base_url=base_url,
                                invalid_content=content,
                                fallback=fallback,
                                original_operation=operation,
                                request_id=request_id,
                                attempts=attempts,
                                max_tokens=max_tokens,
                                raw_request=raw_request,
                                original_status_code=response.status_code,
                                original_duration_ms=duration_ms,
                                original_data=data,
                            )
                            if repaired is not None:
                                return repaired
                            return self._fallback_with_raw_output(
                                fallback,
                                content,
                                str(parse_exc),
                                raw_interaction,
                            )
                    except Exception as exc:
                        duration_ms = round((time.perf_counter() - attempt_started_at) * 1000)
                        attempts.append(
                            {
                                "attempt": attempt_number,
                                "retry": retry_index,
                                "base_url": base_url,
                                "duration_ms": duration_ms,
                                "exception_type": type(exc).__name__,
                                "error": str(exc),
                            }
                        )
                        logger.warning(
                            "llm_request_attempt_exception %s",
                            json.dumps(
                                {
                                    "request_id": request_id,
                                    "operation": operation,
                                    "attempt": attempt_number,
                                    "retry": retry_index,
                                    "duration_ms": duration_ms,
                                    "base_url": base_url,
                                    "model": self.model,
                                    "error": str(exc),
                                    "exception_type": type(exc).__name__,
                                },
                                ensure_ascii=False,
                                default=str,
                            ),
                        )

        duration_ms = round((time.perf_counter() - started_at) * 1000)
        error_message = attempts[-1].get("error") if attempts else "no llama request attempted"
        logger.error(
            "llm_request_all_attempts_failed %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "operation": operation,
                    "duration_ms": duration_ms,
                    "base_urls": self.base_urls,
                    "model": self.model,
                    "attempts": attempts,
                },
                ensure_ascii=False,
                default=str,
            ),
        )
        if self.allow_fallback:
            return {
                **fallback,
                "llm_fallback": True,
                "fallback_reason": error_message,
                "llm_raw": self._raw_interaction(
                    request_payload=last_raw_request,
                    status_code=last_error_response.get("status_code") if last_error_response else None,
                    duration_ms=duration_ms,
                    response_body={"error": error_message, "attempts": attempts},
                ),
            }
        summary = self._attempt_summary(attempts)
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"llama.cpp server is unavailable or returned non-JSON output: {summary}",
                "base_url": self.base_url,
                "base_urls": self.base_urls,
                "model": self.model,
                "request_id": request_id,
                "operation": operation,
                "timeout_seconds": self.timeout,
                "error": error_message,
                "attempt_summary": summary,
                "attempts": attempts,
                "llm_raw": self._raw_interaction(
                    request_payload=last_raw_request,
                    status_code=last_error_response.get("status_code") if last_error_response else None,
                    duration_ms=duration_ms,
                    response_body={"error": error_message, "attempts": attempts},
                ),
            },
        )

    async def complete_text(
        self,
        *,
        system: str,
        user: str,
        fallback: dict[str, Any],
        temperature: float = 0.2,
        max_tokens: int = 1800,
        request_id: str | None = None,
        operation: str = "llm.text",
        thinking_enabled: bool = False,
    ) -> dict[str, Any]:
        started_at = time.perf_counter()
        attempts: list[dict[str, Any]] = []
        last_error_response: dict[str, Any] | None = None
        last_raw_request: dict[str, Any] | None = None
        attempt_number = 0
        log_event(
            "llm_text_request_started",
            request_id=request_id,
            operation=operation,
            base_urls=self.base_urls,
            model=self.model,
            system_chars=len(system),
            user_chars=len(user),
            max_tokens=max_tokens,
            temperature=temperature,
            timeout_seconds=self.timeout,
            connect_timeout_seconds=self.connect_timeout,
            request_retries=self.request_retries,
            thinking_enabled=thinking_enabled,
        )
        for base_url in self.base_urls:
            for retry_index in range(self.request_retries + 1):
                await self._retry_pause(retry_index)
                attempt_number += 1
                attempt_started_at = time.perf_counter()
                raw_request = self._raw_request(
                    base_url=base_url,
                    system=system,
                    user=user,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    operation=operation,
                    thinking_enabled=thinking_enabled,
                    force_response_format=False,
                )
                last_raw_request = raw_request
                log_event(
                    "llm_text_attempt_started",
                    request_id=request_id,
                    operation=operation,
                    attempt=attempt_number,
                    retry=retry_index,
                    base_url=base_url,
                )
                async with httpx.AsyncClient(timeout=self._http_timeout()) as client:
                    try:
                        response = await client.post(
                            f"{base_url}/chat/completions",
                            json=self._chat_payload(
                                system=system,
                                user=user,
                                temperature=temperature,
                                max_tokens=max_tokens,
                                thinking_enabled=thinking_enabled,
                                force_response_format=False,
                            ),
                        )
                        duration_ms = round((time.perf_counter() - attempt_started_at) * 1000)
                        if not response.is_success:
                            last_error_response = {"status_code": response.status_code, "body": response.text[:4000]}
                            attempts.append(
                                {
                                    "attempt": attempt_number,
                                    "retry": retry_index,
                                    "base_url": base_url,
                                    "status_code": response.status_code,
                                    "duration_ms": duration_ms,
                                    "error": response.text[:1000],
                                }
                            )
                            log_event(
                                "llm_text_failed_status",
                                request_id=request_id,
                                operation=operation,
                                attempt=attempt_number,
                                retry=retry_index,
                                base_url=base_url,
                                status_code=response.status_code,
                                duration_ms=duration_ms,
                                response_text=response.text[:1000],
                            )
                            continue

                        try:
                            data = response.json()
                            choice = data["choices"][0]
                            content = choice["message"]["content"]
                            finish_reason = choice.get("finish_reason")
                        except Exception as exc:
                            attempts.append(
                                {
                                    "attempt": attempt_number,
                                    "retry": retry_index,
                                    "base_url": base_url,
                                    "status_code": response.status_code,
                                    "duration_ms": duration_ms,
                                    "exception_type": type(exc).__name__,
                                    "error": str(exc),
                                    "body_excerpt": response.text[:1000],
                                }
                            )
                            log_event(
                                "llm_text_response_parse_failed",
                                request_id=request_id,
                                operation=operation,
                                attempt=attempt_number,
                                retry=retry_index,
                                base_url=base_url,
                                duration_ms=duration_ms,
                                error=str(exc),
                            )
                            continue

                        raw_interaction = self._raw_interaction(
                            request_payload=raw_request,
                            status_code=response.status_code,
                            duration_ms=duration_ms,
                            response_content=content,
                            response_body={
                                "usage": data.get("usage"),
                                "model": data.get("model"),
                                "finish_reason": finish_reason,
                                "attempts": [
                                    *attempts,
                                    {
                                        "attempt": attempt_number,
                                        "retry": retry_index,
                                        "base_url": base_url,
                                        "status_code": response.status_code,
                                        "duration_ms": duration_ms,
                                        "ok": True,
                                    },
                                ],
                            },
                        )
                        log_event(
                            "llm_text_completed",
                            request_id=request_id,
                            operation=operation,
                            duration_ms=round((time.perf_counter() - started_at) * 1000),
                            response_chars=len(content),
                            finish_reason=finish_reason,
                            usage=data.get("usage"),
                        )
                        return {
                            "content": content,
                            "finish_reason": finish_reason,
                            "llm_raw": raw_interaction,
                        }
                    except Exception as exc:
                        duration_ms = round((time.perf_counter() - attempt_started_at) * 1000)
                        attempts.append(
                            {
                                "attempt": attempt_number,
                                "retry": retry_index,
                                "base_url": base_url,
                                "duration_ms": duration_ms,
                                "exception_type": type(exc).__name__,
                                "error": str(exc),
                            }
                        )
                        logger.warning(
                            "llm_text_attempt_exception %s",
                            json.dumps(
                                {
                                    "request_id": request_id,
                                    "operation": operation,
                                    "attempt": attempt_number,
                                    "retry": retry_index,
                                    "duration_ms": duration_ms,
                                    "base_url": base_url,
                                    "model": self.model,
                                    "error": str(exc),
                                    "exception_type": type(exc).__name__,
                                },
                                ensure_ascii=False,
                                default=str,
                            ),
                        )

        duration_ms = round((time.perf_counter() - started_at) * 1000)
        error_message = attempts[-1].get("error") if attempts else "no llama text request attempted"
        logger.error(
            "llm_text_all_attempts_failed %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "operation": operation,
                    "duration_ms": duration_ms,
                    "base_urls": self.base_urls,
                    "model": self.model,
                    "attempts": attempts,
                },
                ensure_ascii=False,
                default=str,
            ),
        )
        if self.allow_fallback:
            return {
                "content": fallback.get("handoff_text") or fallback.get("reason_for_next_action") or "",
                "llm_fallback": True,
                "fallback_reason": error_message,
                "llm_raw": self._raw_interaction(
                    request_payload=last_raw_request,
                    status_code=last_error_response.get("status_code") if last_error_response else None,
                    duration_ms=duration_ms,
                    response_body={"error": error_message, "attempts": attempts},
                ),
            }
        summary = self._attempt_summary(attempts)
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"llama.cpp server is unavailable: {summary}",
                "base_url": self.base_url,
                "base_urls": self.base_urls,
                "model": self.model,
                "request_id": request_id,
                "operation": operation,
                "timeout_seconds": self.timeout,
                "error": error_message,
                "attempt_summary": summary,
                "attempts": attempts,
                "llm_raw": self._raw_interaction(
                    request_payload=last_raw_request,
                    status_code=last_error_response.get("status_code") if last_error_response else None,
                    duration_ms=duration_ms,
                    response_body={"error": error_message, "attempts": attempts},
                ),
            },
        )

    async def _repair_json_output(
        self,
        *,
        base_url: str,
        invalid_content: str,
        fallback: dict[str, Any],
        original_operation: str,
        request_id: str | None,
        attempts: list[dict[str, Any]],
        max_tokens: int,
        raw_request: dict[str, Any] | None,
        original_status_code: int,
        original_duration_ms: int,
        original_data: dict[str, Any],
    ) -> dict[str, Any] | None:
        if self.json_repair_retries <= 0:
            return None

        repair_system = (
            "You are a JSON repair tool. Convert the invalid model output into one valid JSON object.\n"
            "Return only JSON. Do not add Markdown, explanations, code fences, or comments.\n"
            "Preserve the original meaning when possible. If fields are missing, use the fallback shape."
        )
        repair_user = (
            "Fallback JSON shape:\n"
            f"{self._clip(fallback, self.json_repair_fallback_chars)}\n\n"
            "Invalid model output to repair:\n"
            f"{self._clip(invalid_content, self.json_repair_input_chars)}\n\n"
            "Return exactly one valid JSON object now."
        )
        repair_max_tokens = max(250, min(max_tokens, self.json_repair_max_tokens))

        for repair_index in range(1, self.json_repair_retries + 1):
            await self._retry_pause(repair_index - 1)
            started_at = time.perf_counter()
            operation = f"{original_operation}.json_repair"
            repair_raw_request = self._raw_request(
                base_url=base_url,
                system=repair_system,
                user=repair_user,
                temperature=0.0,
                max_tokens=repair_max_tokens,
                operation=operation,
                thinking_enabled=False,
            )
            log_event(
                "llm_json_repair_attempt_started",
                request_id=request_id,
                operation=original_operation,
                repair_attempt=repair_index,
                base_url=base_url,
                max_tokens=repair_max_tokens,
                input_chars=len(repair_user),
            )
            try:
                async with httpx.AsyncClient(timeout=self._http_timeout()) as client:
                    response = await client.post(
                        f"{base_url}/chat/completions",
                        json=self._chat_payload(
                            system=repair_system,
                            user=repair_user,
                            temperature=0.0,
                            max_tokens=repair_max_tokens,
                            thinking_enabled=False,
                        ),
                    )
                duration_ms = round((time.perf_counter() - started_at) * 1000)
                if not response.is_success:
                    attempts.append(
                        {
                            "attempt": f"repair-{repair_index}",
                            "base_url": base_url,
                            "status_code": response.status_code,
                            "duration_ms": duration_ms,
                            "error": response.text[:1000],
                        }
                    )
                    log_event(
                        "llm_json_repair_failed_status",
                        request_id=request_id,
                        operation=original_operation,
                        repair_attempt=repair_index,
                        status_code=response.status_code,
                        duration_ms=duration_ms,
                        response_text=response.text[:1000],
                    )
                    continue

                try:
                    data = response.json()
                    content = data["choices"][0]["message"]["content"]
                    parsed = self._parse_json(content)
                except Exception as exc:
                    attempts.append(
                        {
                            "attempt": f"repair-{repair_index}",
                            "base_url": base_url,
                            "status_code": response.status_code,
                            "duration_ms": duration_ms,
                            "exception_type": type(exc).__name__,
                            "error": f"json_repair_parse_failed: {exc}",
                            "body_excerpt": response.text[:1000],
                        }
                    )
                    log_event(
                        "llm_json_repair_parse_failed",
                        request_id=request_id,
                        operation=original_operation,
                        repair_attempt=repair_index,
                        duration_ms=duration_ms,
                        error=str(exc),
                    )
                    continue

                raw_interaction = self._raw_interaction(
                    request_payload=repair_raw_request,
                    status_code=response.status_code,
                    duration_ms=duration_ms,
                    response_content=content,
                    response_body={
                        "usage": data.get("usage"),
                        "model": data.get("model"),
                        "original_status_code": original_status_code,
                        "original_duration_ms": original_duration_ms,
                        "original_usage": original_data.get("usage"),
                        "attempts": [
                            *attempts,
                            {
                                "attempt": f"repair-{repair_index}",
                                "base_url": base_url,
                                "status_code": response.status_code,
                                "duration_ms": duration_ms,
                                "ok": True,
                            },
                        ],
                        "original_raw": self._raw_interaction(
                            request_payload=raw_request,
                            status_code=original_status_code,
                            duration_ms=original_duration_ms,
                            response_content=invalid_content,
                            response_body={"usage": original_data.get("usage"), "model": original_data.get("model")},
                        ),
                    },
                )
                if raw_interaction:
                    parsed["llm_raw"] = raw_interaction
                parsed["llm_json_repaired"] = True
                log_event(
                    "llm_json_repair_completed",
                    request_id=request_id,
                    operation=original_operation,
                    repair_attempt=repair_index,
                    duration_ms=duration_ms,
                    output_keys=list(parsed.keys())[:20],
                )
                return parsed
            except Exception as exc:
                duration_ms = round((time.perf_counter() - started_at) * 1000)
                attempts.append(
                    {
                        "attempt": f"repair-{repair_index}",
                        "base_url": base_url,
                        "duration_ms": duration_ms,
                        "exception_type": type(exc).__name__,
                        "error": str(exc),
                    }
                )
                logger.warning(
                    "llm_json_repair_exception %s",
                    json.dumps(
                        {
                            "request_id": request_id,
                            "operation": original_operation,
                            "repair_attempt": repair_index,
                            "duration_ms": duration_ms,
                            "base_url": base_url,
                            "error": str(exc),
                            "exception_type": type(exc).__name__,
                        },
                        ensure_ascii=False,
                        default=str,
                    ),
                )
        return None

    def _fallback_with_raw_output(
        self,
        fallback: dict[str, Any],
        content: str,
        reason: str,
        raw_interaction: dict[str, Any] | None,
    ) -> dict[str, Any]:
        output = {
            **fallback,
            "llm_parse_warning": reason,
            "raw_model_output": content[:4000],
        }
        if raw_interaction:
            output["llm_raw"] = raw_interaction
        output["llm_parse_failed"] = True
        output["next_action"] = "call_agent"
        output["next_agent"] = output.get("agent_name") if output.get("agent_name") in {"hypothesis", "skeptic", "researcher"} else "researcher"
        output["should_continue"] = True
        output["reason_for_next_action"] = "LLMは応答しましたがJSON整形に失敗したため、回収した生出力を暫定レポートとして返します。"
        output["reason"] = "LLM応答のJSON整形に失敗しました。生出力を確認してください。"
        if isinstance(output.get("final_report"), str):
            output["final_report"] = (
                "# LLM出力の回収\n"
                "モデルは応答しましたがJSON整形に失敗したため、以下に生出力の先頭を保存します。\n\n"
                f"{content[:1600]}"
            )
        elif isinstance(output.get("summary_short"), str):
            output["summary_short"] = f"{output['summary_short']} モデル応答はありましたがJSON整形に失敗したため暫定整形です。"
        return output

    def _parse_json(self, content: str) -> dict[str, Any]:
        text = content.strip()
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?", "", text).strip()
            text = re.sub(r"```$", "", text).strip()

        try:
            parsed = json.loads(text, parse_constant=self._reject_invalid_json_constant)
            if isinstance(parsed, dict):
                return self._sanitize_json_object(parsed)
        except json.JSONDecodeError:
            pass

        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if match:
            parsed = json.loads(match.group(0), parse_constant=self._reject_invalid_json_constant)
            if isinstance(parsed, dict):
                return self._sanitize_json_object(parsed)

        raise ValueError("model output did not contain a JSON object")

    def _reject_invalid_json_constant(self, value: str) -> None:
        raise ValueError(f"invalid JSON constant: {value}")

    def _sanitize_json_object(self, value: dict[str, Any]) -> dict[str, Any]:
        sanitized = self._sanitize_json_value(value)
        if isinstance(sanitized, dict):
            return sanitized
        raise ValueError("model output was not a JSON object")

    def _sanitize_json_value(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {str(key): self._sanitize_json_value(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._sanitize_json_value(item) for item in value]
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
