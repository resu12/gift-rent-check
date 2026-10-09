"""A sequential HTTP client confined to the four read-only free routes."""

from __future__ import annotations

import math
import json
import random as random_module
import re
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Callable
from urllib.parse import unquote

import httpx

from .domain import ApiError, ApiResponse, AuthError, BudgetExceeded


BASE_URL = "https://api.marketapp.org"
LISTINGS_PATH = "/v1/rent/gifts/"
HISTORY_PATH = "/v1/rent/gifts/history/"
COLLECTIONS_PATH = "/v1/collections/gifts/"
LISTING_SORTS = frozenset({"price_per_day", "min_price", "duration_asc", "duration_desc", "item_num_asc", "item_num_desc", "recently_touch"})
HISTORY_ORDERS = frozenset({"new_to_old", "old_to_new"})
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_ATTRIBUTE_ROUTE = re.compile(r"/v1/collections/([^/?#\\]+)/attributes/\Z")
_SAFE_ADDRESS = re.compile(r"[A-Za-z0-9_:-]+\Z")
_JSON_STRING = re.compile(rb'"(?:[^"\\]|\\.)*"', re.DOTALL)


class ApiClient:
    def __init__(
        self, token: str, *, timeout: float = 30, requests_per_second: float = 1,
        max_attempts: int = 25, retry_attempts: int = 4, run_seconds: float = 300,
        not_before: str | None = None,
        transport: httpx.BaseTransport | None = None,
        observer: Callable[[dict], None] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        random: Callable[[], float] = random_module.random,
    ) -> None:
        if not isinstance(token, str) or not token.strip() or any(ord(c) < 32 or ord(c) > 126 for c in token):
            raise ValueError("API token must be nonempty printable ASCII")
        for name, value in (("timeout", timeout), ("requests_per_second", requests_per_second), ("run_seconds", run_seconds)):
            if isinstance(value, bool) or not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be finite and positive")
        for name, value in (("max_attempts", max_attempts), ("retry_attempts", retry_attempts)):
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} must be a positive integer")
        self._token = token
        self._timeout = timeout
        self._interval = 1 / requests_per_second
        self._max_attempts = max_attempts
        self._retry_attempts = retry_attempts
        self._sleep = sleep
        self._clock = monotonic
        self._random = random
        self._observer = observer
        self._deadline = monotonic() + run_seconds
        self._next_attempt_at = self._clock()
        if not_before is not None:
            try:
                when = datetime.fromisoformat(not_before)
                if when.tzinfo is None:
                    raise ValueError
                delay = max(0, (when - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                raise ValueError("Saved request cooldown must be a timezone-aware ISO timestamp") from None
            self._next_attempt_at += delay
        self.attempts_used = 0
        self._client = httpx.Client(
            base_url=BASE_URL, headers={"Authorization": token, "Accept": "application/json"},
            timeout=timeout, follow_redirects=False, transport=transport, trust_env=False,
        )

    def __enter__(self) -> ApiClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _safe_text(self, value: str) -> str:
        return value.replace(self._token, "[REDACTED]")

    def _safe_body(self, body: bytes) -> bytes:
        # Redact individual JSON strings rather than parse/reserialize the
        # whole document. This preserves malformed structure, duplicate keys,
        # and precise number bytes for the independent schema validator.
        def redact_string(match: re.Match[bytes]) -> bytes:
            original = match[0]
            try:
                decoded = json.loads(original)
                clean = self._safe_text(decoded)
                if decoded != clean:
                    return json.dumps(clean, ensure_ascii=True).encode("ascii")
            except (ValueError, UnicodeError):
                pass
            return original

        scrubbed = _JSON_STRING.sub(redact_string, body)
        return scrubbed.replace(self._token.encode("ascii"), b"[REDACTED]")

    def _observe(self, path: str, params: dict, status: int | None, body: bytes | None, error: str | None, retry_after_at: str | None = None) -> str:
        observed_at = datetime.now(timezone.utc).isoformat()
        if self._observer is not None:
            self._observer({
                "path": self._safe_text(path),
                "params": {key: self._safe_text(value) if isinstance(value, str) else value for key, value in params.items()},
                "observed_at": observed_at, "status_code": status,
                "body": self._safe_body(body) if body is not None else None,
                "error": self._safe_text(error) if error is not None else None,
                "retry_after_at": retry_after_at,
            })
        return observed_at

    def _wait(self, seconds: float) -> None:
        seconds = max(0, seconds)
        remaining = self._deadline - self._clock()
        if remaining <= 0 or seconds >= remaining:
            raise BudgetExceeded("Invocation time budget reached; resume the run", retryable=True, reason="time_budget")
        if seconds:
            self._sleep(seconds)

    @staticmethod
    def _validate_request(path: str, params: dict) -> dict:
        attribute = _ATTRIBUTE_ROUTE.fullmatch(path)
        valid_attribute = attribute is not None and _SAFE_ADDRESS.fullmatch(unquote(attribute[1])) is not None
        if path == LISTINGS_PATH:
            allowed = {"cursor", "collection_address", "sort_by", "model", "symbol", "backdrop", "limit"}
        elif path == HISTORY_PATH:
            allowed = {"cursor", "collection_address", "order_by", "limit"}
        elif path == COLLECTIONS_PATH or valid_attribute:
            allowed = set()
        else:
            raise ApiError("Route is outside the read-only allowlist", retryable=False, reason="invalid_request")
        if not isinstance(params, dict) or any(key not in allowed for key in params):
            raise ApiError("Unsupported request parameter", retryable=False, reason="invalid_request")
        for key, value in params.items():
            if key == "limit":
                valid = type(value) is int and 1 <= value <= 100
            elif key == "sort_by":
                valid = isinstance(value, str) and value in LISTING_SORTS
            elif key == "order_by":
                valid = isinstance(value, str) and value in HISTORY_ORDERS
            else:
                valid = value is None or isinstance(value, str)
            if not valid:
                raise ApiError("Invalid request parameter value", retryable=False, reason="invalid_request")
        return {key: value for key, value in params.items() if value is not None}

    @staticmethod
    def _retry_after(response: httpx.Response) -> float | None:
        value = response.headers.get("Retry-After")
        if value is None:
            return None
        try:
            seconds = float(value)
            if math.isfinite(seconds):
                return max(0, seconds)
        except ValueError:
            pass
        try:
            when = parsedate_to_datetime(value)
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            return max(0, (when - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None

    def get(self, path: str, params: dict) -> ApiResponse:
        """GET one page, counting every retry against the invocation budget."""
        query = self._validate_request(path, params)
        for attempt in range(self._retry_attempts):
            if self.attempts_used >= self._max_attempts:
                raise BudgetExceeded("HTTP attempt budget reached; resume the run", retryable=True, reason="attempt_budget")
            self._wait(self._next_attempt_at - self._clock())
            self.attempts_used += 1
            self._next_attempt_at = self._clock() + self._interval
            retry_after = None
            try:
                response = self._client.get(path, params=query, timeout=min(self._timeout, self._deadline - self._clock()))
            except httpx.TransportError:
                message = "Network request failed"
                self._observe(path, query, None, None, message)
                failure = ApiError(message, retryable=True, reason="network")
            else:
                status = response.status_code
                error = None if status == 200 else f"HTTP {status}"
                retry_after_at = None
                if status in RETRY_STATUSES:
                    retry_after = self._retry_after(response)
                    if retry_after is not None:
                        # The server cooldown applies to later streams too,
                        # even when this request has exhausted its retries.
                        self._next_attempt_at = max(self._next_attempt_at, self._clock() + retry_after)
                        try:
                            not_before = datetime.now(timezone.utc) + timedelta(seconds=retry_after)
                        except OverflowError:
                            not_before = datetime.max.replace(tzinfo=timezone.utc)
                        retry_after_at = not_before.isoformat()
                observed_at = self._observe(path, query, status, response.content, error, retry_after_at)
                if status == 200:
                    return ApiResponse(body=self._safe_body(response.content), status_code=status, observed_at=observed_at)
                if status in {401, 403}:
                    raise AuthError("Authentication failed; check the configured API token", retryable=False, status_code=status, reason="authentication")
                if status in RETRY_STATUSES:
                    failure = ApiError(f"HTTP {status}: transient request failure", retryable=True, status_code=status, reason="http_transient")
                else:
                    is_cursor = "cursor" in query and status in {400, 404, 410, 422}
                    message = f"HTTP {status}: request rejected"
                    if is_cursor:
                        message += "; the saved cursor may have expired; start a fresh run"
                    raise ApiError(message, retryable=False, status_code=status, reason="cursor_rejected" if is_cursor else "http_rejected")
            if attempt + 1 >= self._retry_attempts:
                raise failure
            if self.attempts_used >= self._max_attempts:
                raise BudgetExceeded("HTTP attempt budget reached; resume the run", retryable=True, reason="attempt_budget")
            delay = 2 ** attempt + self._random()
            self._wait(max(delay, retry_after or 0, self._next_attempt_at - self._clock()))
        raise AssertionError("unreachable retry state")
