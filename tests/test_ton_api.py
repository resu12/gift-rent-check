from datetime import datetime, timedelta, timezone

import httpx
import pytest

from marketapp_rent.api import ApiClient, COLLECTIONS_PATH
from marketapp_rent.domain import ApiError, AuthError, BudgetExceeded
from marketapp_rent.ton_api import ACCOUNT_STATES_PATH, NFT_ITEMS_PATH, NFT_TRANSFERS_PATH, TonClient


class Clock:
    def __init__(self):
        self.now = 0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        self.sleeps.append(seconds)


def client(handler, **kwargs):
    clock = kwargs.pop("clock", Clock())
    token = kwargs.pop("token", "ton-secret")
    return TonClient(token, transport=httpx.MockTransport(handler), sleep=clock.sleep,
                     monotonic=clock, random=lambda: 0, **kwargs)


def test_exact_routes_repeated_array_params_and_auth_isolation():
    seen = []
    handler = lambda request: seen.append(request) or httpx.Response(200, content=b"{}")
    with client(handler) as ton:
        ton.get(NFT_ITEMS_PATH, {"address": ["one", "two"], "limit": 100, "offset": 0, "include_on_sale": False})
        ton.get(NFT_TRANSFERS_PATH, {"owner_address": ["wallet"], "end_lt": 123, "sort": "desc", "limit": 1000})
        ton.get(ACCOUNT_STATES_PATH, {"address": ["a", "b"], "include_boc": True})
    assert seen[0].url.params.get_list("address") == ["one", "two"]
    assert dict(seen[0].url.params) == {"address": "one", "limit": "100", "offset": "0", "include_on_sale": "false"}
    assert all(request.method == "GET" and request.url.host == "toncenter.com" for request in seen)
    assert all(request.headers["X-API-Key"] == "ton-secret" and "Authorization" not in request.headers for request in seen)
    with ApiClient("market-secret", transport=httpx.MockTransport(handler)) as market:
        market.get(COLLECTIONS_PATH, {})
    assert seen[-1].headers["Authorization"] == "market-secret"
    assert "X-API-Key" not in seen[-1].headers
    assert not hasattr(TonClient, "post")


@pytest.mark.parametrize("token", [None, ""])
def test_no_key_preserves_bodies_without_empty_string_redaction(token):
    seen = []
    with client(lambda request: seen.append(request) or httpx.Response(200, content=b'{"ok":true}'), token=token) as ton:
        assert ton.get(NFT_ITEMS_PATH, {}).body == b'{"ok":true}'
    assert "X-API-Key" not in seen[0].headers


@pytest.mark.parametrize("path", ["/api/v2/runGetMethod", "/api/v2/sendBoc", "/api/v3/transactions",
                                  COLLECTIONS_PATH, "https://evil.invalid/api/v3/nft/items", "//evil.invalid/api/v3/nft/items"])
def test_forbidden_routes_send_nothing(path):
    with client(lambda request: pytest.fail("network")) as ton:
        with pytest.raises(ApiError, match="allowlist"):
            ton.get(path, {})
        assert ton.attempts_used == 0


@pytest.mark.parametrize("path, params", [
    (NFT_ITEMS_PATH, {"limit": 1001}), (NFT_ITEMS_PATH, {"offset": -1}),
    (NFT_ITEMS_PATH, {"include_on_sale": "false"}), (NFT_ITEMS_PATH, {"address": []}),
    (NFT_ITEMS_PATH, {"sort_by_last_transaction_lt": "desc"}),
    (NFT_TRANSFERS_PATH, {"direction": "both"}), (NFT_TRANSFERS_PATH, {"sort": "new_to_old"}),
    (NFT_TRANSFERS_PATH, {"end_lt": True}), (NFT_TRANSFERS_PATH, {"cursor": "opaque"}),
    (ACCOUNT_STATES_PATH, {}), (ACCOUNT_STATES_PATH, {"address": [None]}),
    (ACCOUNT_STATES_PATH, {"address": ["a"] * 1001}),
])
def test_invalid_query_is_rejected_before_request(path, params):
    with client(lambda request: pytest.fail("network")) as ton:
        with pytest.raises(ApiError):
            ton.get(path, params)


def test_rate_limit_network_retry_and_redaction_in_json_and_array_params():
    clock = Clock()
    attempts = []
    calls = []
    def handler(request):
        calls.append(clock.now)
        if len(calls) == 1:
            raise httpx.ConnectError("echo ton-secret", request=request)
        return httpx.Response(200, content=b'{"echo":"\\u0074on-secret","amount":0.1234567890123456789}')
    with client(handler, observer=attempts.append, clock=clock) as ton:
        result = ton.get(NFT_ITEMS_PATH, {"address": ["ton-secret"]})
        ton.get(NFT_TRANSFERS_PATH, {})
    assert calls == [0, 1, 2]
    assert "ton-secret" not in str(attempts)
    assert b"[REDACTED]" in result.body
    assert b"0.1234567890123456789" in result.body


@pytest.mark.parametrize("status", [401, 403])
def test_auth_error_stops_immediately(status):
    with client(lambda request: httpx.Response(status)) as ton:
        with pytest.raises(AuthError):
            ton.get(NFT_ITEMS_PATH, {})
        assert ton.attempts_used == 1


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_retry_exhaustion(status):
    clock = Clock()
    with client(lambda request: httpx.Response(status), clock=clock) as ton:
        with pytest.raises(ApiError):
            ton.get(NFT_ITEMS_PATH, {})
        assert ton.attempts_used == 4
    assert clock.sleeps == [1, 2, 4]


def test_retry_after_beyond_budget_persisted_and_resume_honors_it():
    attempts = []
    clock = Clock()
    with client(lambda request: httpx.Response(429, headers={"Retry-After": "600"}), observer=attempts.append, clock=clock, run_seconds=5) as ton:
        with pytest.raises(BudgetExceeded):
            ton.get(NFT_ITEMS_PATH, {})
    assert clock.sleeps == []
    assert datetime.fromisoformat(attempts[0]["retry_after_at"]) > datetime.now(timezone.utc) + timedelta(seconds=590)
    with client(lambda request: pytest.fail("cooldown"), clock=clock, not_before=attempts[0]["retry_after_at"], run_seconds=5) as ton:
        with pytest.raises(BudgetExceeded):
            ton.get(NFT_ITEMS_PATH, {})


def test_attempt_limit_and_redirect_are_not_followed():
    with client(lambda request: httpx.Response(500), max_attempts=1) as ton:
        with pytest.raises(BudgetExceeded):
            ton.get(NFT_ITEMS_PATH, {})
        assert ton.attempts_used == 1
    with client(lambda request: httpx.Response(302, headers={"Location": "https://evil.invalid"})) as ton:
        with pytest.raises(ApiError):
            ton.get(NFT_ITEMS_PATH, {})
        assert ton.attempts_used == 1
