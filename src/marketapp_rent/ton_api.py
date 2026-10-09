"""TON Center mainnet GET-only client; shares the collector's retry machinery."""

from __future__ import annotations

import random as random_module
import time
from typing import Callable

import httpx

from .api import ApiClient
from .domain import ApiError

BASE_URL = "https://toncenter.com"
NFT_ITEMS_PATH = "/api/v3/nft/items"
NFT_TRANSFERS_PATH = "/api/v3/nft/transfers"
ACCOUNT_STATES_PATH = "/api/v3/accountStates"


class TonClient(ApiClient):
    """Only the three discovery routes, with isolated optional X-API-Key auth."""

    def __init__(
        self, token: str | None = None, *, timeout: float = 30,
        requests_per_second: float = 1, max_attempts: int = 100,
        retry_attempts: int = 4, run_seconds: float = 300,
        not_before: str | None = None, transport: httpx.BaseTransport | None = None,
        observer: Callable[[dict], None] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        random: Callable[[], float] = random_module.random,
    ) -> None:
        if token == "":
            token = None
        # Initialize the tested rate-limit/budget logic without sending a
        # request. Replace its transport client before any operation is exposed.
        super().__init__(
            token if token is not None else "unused-no-key", timeout=timeout,
            requests_per_second=requests_per_second, max_attempts=max_attempts,
            retry_attempts=retry_attempts, run_seconds=run_seconds,
            not_before=not_before, observer=observer, sleep=sleep,
            monotonic=monotonic, random=random,
        )
        self._client.close()
        self._token = token or ""
        headers = {"Accept": "application/json"}
        if token is not None:
            headers["X-API-Key"] = token
        self._client = httpx.Client(
            base_url=BASE_URL, headers=headers, timeout=timeout,
            follow_redirects=False, transport=transport, trust_env=False,
        )

    def _safe_text(self, value: str) -> str:
        return super()._safe_text(value) if self._token else value

    def _safe_body(self, body: bytes) -> bytes:
        return super()._safe_body(body) if self._token else body

    def _observe(self, path, params, status, body, error, retry_after_at=None):
        def clean(value):
            if isinstance(value, str):
                return self._safe_text(value)
            if isinstance(value, (list, tuple)):
                return [clean(item) for item in value]
            return value
        return super()._observe(path, {key: clean(value) for key, value in params.items()}, status, body, error, retry_after_at)

    @staticmethod
    def _validate_request(path: str, params: dict) -> dict:
        arrays = set()
        if path == NFT_ITEMS_PATH:
            arrays = {"address", "owner_address", "collection_address", "index"}
            allowed = arrays | {"include_on_sale", "sort_by_last_transaction_lt", "limit", "offset"}
        elif path == NFT_TRANSFERS_PATH:
            arrays = {"owner_address", "item_address"}
            allowed = arrays | {"collection_address", "direction", "start_utime", "end_utime", "start_lt", "end_lt", "limit", "offset", "sort"}
        elif path == ACCOUNT_STATES_PATH:
            arrays = {"address"}
            allowed = {"address", "include_boc"}
        else:
            raise ApiError("Route is outside the TON read-only allowlist", retryable=False, reason="invalid_request")
        if not isinstance(params, dict) or any(key not in allowed for key in params):
            raise ApiError("Unsupported TON request parameter", retryable=False, reason="invalid_request")
        query = {}
        for key, value in params.items():
            if value is None:
                continue
            if key in arrays:
                values = [value] if isinstance(value, str) else value
                valid = isinstance(values, (list, tuple)) and 1 <= len(values) <= 1000 and all(isinstance(item, str) and item for item in values)
                value = list(values) if valid else value
            elif key == "limit":
                valid = type(value) is int and 1 <= value <= 1000
            elif key in {"offset", "start_utime", "end_utime", "start_lt", "end_lt"}:
                valid = type(value) is int and value >= 0
            elif key in {"include_on_sale", "include_boc", "sort_by_last_transaction_lt"}:
                valid = type(value) is bool
            elif key == "sort":
                valid = isinstance(value, str) and value in {"asc", "desc"}
            elif key == "direction":
                valid = isinstance(value, str) and value in {"in", "out"}
            else:
                valid = isinstance(value, str) and bool(value)
            if not valid:
                raise ApiError("Invalid TON request parameter value", retryable=False, reason="invalid_request")
            query[key] = value
        if path == ACCOUNT_STATES_PATH and "address" not in query:
            raise ApiError("TON account states require addresses", retryable=False, reason="invalid_request")
        return query
