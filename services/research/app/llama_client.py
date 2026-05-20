from __future__ import annotations

import json
import logging
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
            "chat_template_kwargs": {"enable_thinking": thinking_enabled},
        }

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
        attempts: list[dict[str, Any]] = []
        last_error_response: dict[str, Any] | None = None
        last_raw_request: dict[str, Any] | None = None
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
            thinking_enabled=thinking_enabled,
        )
        for attempt_index, base_url in enumerate(self.base_urls, start=1):
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
                attempt=attempt_index,
                base_url=base_url,
            )
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                try:
                    response = await client.post(
                        f"{base_url}/chat/completions",
                        json={
                            "model": self.model,
                            "messages": [
                                {"role": "system", "content": system},
                                {"role": "user", "content": user},
                            ],
                            "temperature": temperature,
                            "max_tokens": max_tokens,
                            "chat_template_kwargs": {"enable_thinking": thinking_enabled},
                        },
                    )
                    duration_ms = round((time.perf_counter() - attempt_started_at) * 1000)
                    if not response.is_success:
                        last_error_response = {"status_code": response.status_code, "body": response.text[:4000]}
                        attempts.append(
                            {
                                "attempt": attempt_index,
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
                            attempt=attempt_index,
                            base_url=base_url,
                            status_code=response.status_code,
                            duration_ms=duration_ms,
                            response_text=response.text[:1000],
                        )
                        continue
                    data = response.json()
                    content = data["choices"][0]["message"]["content"]
                    log_event(
                        "llm_response_received",
                        request_id=request_id,
                        operation=operation,
                        status_code=response.status_code,
                        attempt=attempt_index,
                        base_url=base_url,
                        duration_ms=duration_ms,
                        response_chars=len(content),
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
                                        "attempt": attempt_index,
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
                        logger.warning(
                            "llm_json_parse_failed %s",
                            json.dumps(
                                {
                                    "request_id": request_id,
                                    "operation": operation,
                                    "duration_ms": round((time.perf_counter() - started_at) * 1000),
                                    "reason": str(parse_exc),
                                    "response_chars": len(content),
                                },
                                ensure_ascii=False,
                                default=str,
                            ),
                        )
                        return self._fallback_with_raw_output(
                            fallback,
                            content,
                            str(parse_exc),
                            self._raw_interaction(
                                request_payload=raw_request,
                                status_code=response.status_code,
                                duration_ms=round((time.perf_counter() - started_at) * 1000),
                                response_content=content,
                                response_body={"usage": data.get("usage"), "model": data.get("model"), "attempts": attempts},
                            ),
                        )
                except Exception as exc:
                    duration_ms = round((time.perf_counter() - attempt_started_at) * 1000)
                    attempts.append(
                        {
                            "attempt": attempt_index,
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
                                "attempt": attempt_index,
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
        raise HTTPException(
            status_code=503,
            detail={
                "message": "llama.cpp server is unavailable or returned non-JSON output",
                "base_url": self.base_url,
                "base_urls": self.base_urls,
                "model": self.model,
                "request_id": request_id,
                "operation": operation,
                "timeout_seconds": self.timeout,
                "error": error_message,
                "attempts": attempts,
                "llm_raw": self._raw_interaction(
                    request_payload=last_raw_request,
                    status_code=last_error_response.get("status_code") if last_error_response else None,
                    duration_ms=duration_ms,
                    response_body={"error": error_message, "attempts": attempts},
                ),
            },
        )

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
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if match:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                return parsed

        raise ValueError("model output did not contain a JSON object")
