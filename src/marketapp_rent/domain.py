"""Shared boundary objects; amounts never require binary floating point."""

from dataclasses import dataclass
from typing import Any


class ValidationError(ValueError):
    """A response or local input cannot be interpreted safely."""


class ApiError(Exception):
    def __init__(
        self, message: str, *, retryable: bool = False,
        status_code: int | None = None, reason: str = "api_error",
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code
        self.reason = reason


class BudgetExceeded(ApiError):
    """The configured request or time budget has been consumed."""


class AuthError(ApiError):
    """Authentication/authorization failed; do not retry."""


@dataclass(frozen=True)
class ApiResponse:
    body: bytes
    status_code: int
    observed_at: str


@dataclass(frozen=True)
class NormalizedRecord:
    kind: str
    identity: str
    source_json: str
    data: dict[str, Any]


@dataclass(frozen=True)
class ParsedPage:
    records: list[NormalizedRecord]
    next_cursor: str | None
