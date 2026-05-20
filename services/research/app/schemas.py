from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class FlexibleModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class DocumentSummaryRequest(FlexibleModel):
    title: str | None = None
    url: str | None = None
    raw_text: str | None = None
    ticker: str | None = None


class AgentRequest(FlexibleModel):
    company: dict[str, Any] | None = None
    documents: list[dict[str, Any]] = Field(default_factory=list)
    hypothesis: dict[str, Any] | None = None
    hypothesis_type: str | None = None
    hypotheses: list[dict[str, Any]] = Field(default_factory=list)
    prices: list[dict[str, Any]] = Field(default_factory=list)
    question: str | None = None
    context: dict[str, Any] | list[dict[str, Any]] | None = None


class CompanyResearchRequest(FlexibleModel):
    company: dict[str, Any]
    documents: list[dict[str, Any]] = Field(default_factory=list)
    hypotheses: list[dict[str, Any]] = Field(default_factory=list)
    prices: list[dict[str, Any]] = Field(default_factory=list)
    question: str | None = None
