from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import httpx
import pytest

from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, HISTORY_PATH, LISTINGS_PATH
from marketapp_rent.domain import ApiError, AuthError, BudgetExceeded
from marketapp_rent.domain import ValidationError
from marketapp_rent.models import parse_page


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def client(handler, **kwargs):
    clock = kwargs.pop("clock", Clock())
    return ApiClient(
        "test-secret-token", transport=httpx.MockTransport(handler),
        sleep=clock.sleep, monotonic=clock, random=lambda: 0,
        **kwargs,
    )


def test_allowed_requests_raw_auth_opaque_cursor_and_exact_query():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, content=b'{"cursor":null,"items":[]}')

    params = {
        "cursor": " opaque+/=?&% ", "collection_address": "EQ_collection",
        "sort_by": "recently_touch", "model": "Gold", "symbol": "S",
        "backdrop": "Blue", "limit": 10,
    }
    with client(handler) as api:
        result = api.get(LISTINGS_PATH, params)
        api.get(HISTORY_PATH, {"cursor": "x", "collection_address": "c", "order_by": "new_to_old", "limit": 100})
        api.get(COLLECTIONS_PATH, {})
        api.get("/v1/collections/0%3Aabc_123-DEF/attributes/", {})
        assert api.attempts_used == 4
    assert result.status_code == 200
    assert result.observed_at.endswith("+00:00")
    assert dict(requests[0].url.params) == {key: str(value) for key, value in params.items()}
    assert all(request.method == "GET" for request in requests)
    assert all(request.headers["Authorization"] == "test-secret-token" for request in requests)
    assert all(request.url.host == "api.marketapp.org" for request in requests)


@pytest.mark.parametrize("path", [
    "/v1/rent/gifts/my-rented/", "/v1/rent/gifts/rent-out/", "/v1/gifts/",
    "https://evil.example/v1/rent/gifts/", "//evil.example/v1/rent/gifts/",
    "/v1/collections/../attributes/", "/v1/collections/%2e%2e/attributes/",
    "/v1/collections/a/b/attributes/", "/v1/collections/a?x/attributes/",
    "/v1/collections/a\\b/attributes/", "/v1/rent/usernames/history/",
    "/v1/collections/a%2Fb/attributes/", "/v1/collections/a%252Fb/attributes/",
])
def test_routes_outside_allowlist_rejected_without_http(path):
    with client(lambda request: pytest.fail("unexpected HTTP call")) as api:
        with pytest.raises(ApiError, match="allowlist"):
            api.get(path, {})
        assert api.attempts_used == 0


@pytest.mark.parametrize("params", [
    {"limit": 0}, {"limit": 101}, {"limit": True}, {"limit": "10"},
    {"sort_by": "unknown"}, {"sort_by": None}, {"cursor": 10},
    {"unknown": "value"}, {"order_by": "new_to_old"},
])
def test_invalid_query_rejected_before_http(params):
    with client(lambda request: pytest.fail("unexpected HTTP call")) as api:
        with pytest.raises(ApiError):
            api.get(LISTINGS_PATH, params)


def test_no_collection_query_and_nullable_queries_are_omitted():
    seen = []
    with client(lambda request: seen.append(request) or httpx.Response(200, json={})) as api:
        with pytest.raises(ApiError):
            api.get(COLLECTIONS_PATH, {"limit": 10})
        with pytest.raises(ApiError):
            api.get(HISTORY_PATH, {"order_by": "bad"})
        api.get(LISTINGS_PATH, {"cursor": None, "collection_address": None})
    assert not seen[0].url.query


def test_network_retries_rate_limit_and_observer_count():
    clock = Clock()
    records = []

    def handler(request):
        if len(records) < 2:
            raise httpx.ConnectError("secret server text test-secret-token", request=request)
        return httpx.Response(200, content=b"[]")

    with client(handler, clock=clock, observer=records.append) as api:
        api.get(COLLECTIONS_PATH, {})
        api.get(COLLECTIONS_PATH, {})
    assert [record["status_code"] for record in records] == [None, None, 200, 200]
    assert clock.sleeps == [1, 2, 1]
    assert all("test-secret-token" not in str(record) for record in records)


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_retryable_http_is_bounded(status):
    records = []
    clock = Clock()
    with client(lambda request: httpx.Response(status), clock=clock, observer=records.append) as api:
        with pytest.raises(ApiError) as caught:
            api.get(LISTINGS_PATH, {})
        assert api.attempts_used == 4
        assert caught.value.retryable
        assert caught.value.status_code == status
    assert len(records) == 4
    assert clock.sleeps == [1, 2, 4]


@pytest.mark.parametrize("status", [401, 403])
def test_authentication_stops_immediately(status):
    records = []
    with client(lambda request: httpx.Response(status, content=b"test-secret-token"), observer=records.append) as api:
        with pytest.raises(AuthError) as caught:
            api.get(LISTINGS_PATH, {})
        assert not caught.value.retryable
        assert api.attempts_used == 1
    assert records[0]["body"] == b"[REDACTED]"
    assert "test-secret-token" not in str(caught.value)


@pytest.mark.parametrize("status", [301, 302, 400, 404, 422, 501])
def test_other_statuses_fail_without_retry_or_redirect(status):
    with client(lambda request: httpx.Response(status, headers={"Location": "https://evil.example"})) as api:
        with pytest.raises(ApiError) as caught:
            api.get(LISTINGS_PATH, {})
        assert not caught.value.retryable
        assert api.attempts_used == 1


def test_rejected_cursor_explains_fresh_run():
    with client(lambda request: httpx.Response(422)) as api:
        with pytest.raises(ApiError, match="start a fresh run") as caught:
            api.get(LISTINGS_PATH, {"cursor": "expired"})
        assert caught.value.reason == "cursor_rejected"


def test_retry_after_and_attempt_budget():
    clock = Clock()
    with client(lambda request: httpx.Response(429, headers={"Retry-After": "8"}), clock=clock, max_attempts=2) as api:
        with pytest.raises(BudgetExceeded) as caught:
            api.get(LISTINGS_PATH, {})
        assert api.attempts_used == 2
        assert caught.value.reason == "attempt_budget"
    assert clock.sleeps == [8]


def test_retry_after_date_is_parsed():
    future = datetime.now(timezone.utc) + timedelta(seconds=60)
    response = httpx.Response(429, headers={"Retry-After": format_datetime(future)})
    assert 58 < ApiClient._retry_after(response) <= 60
    assert ApiClient._retry_after(httpx.Response(429, headers={"Retry-After": "nonsense"})) is None


def test_retry_after_beyond_deadline_does_not_sleep():
    clock = Clock()
    attempts = []
    before = datetime.now(timezone.utc)
    with client(lambda request: httpx.Response(429, headers={"Retry-After": "600"}), clock=clock, run_seconds=20, observer=attempts.append) as api:
        with pytest.raises(BudgetExceeded) as caught:
            api.get(LISTINGS_PATH, {})
        assert api.attempts_used == 1
        assert caught.value.reason == "time_budget"
    assert clock.sleeps == []
    retry_at = datetime.fromisoformat(attempts[0]["retry_after_at"])
    assert 599 <= (retry_at - before).total_seconds() <= 601


def test_saved_retry_after_is_respected_before_first_request():
    clock = Clock()
    request_times = []
    not_before = (datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat()
    with client(lambda request: request_times.append(clock.now) or httpx.Response(200, content=b"[]"), clock=clock, not_before=not_before) as api:
        api.get(COLLECTIONS_PATH, {})
    assert len(clock.sleeps) == 1
    assert 19 <= clock.sleeps[0] <= 20
    assert request_times == [clock.sleeps[0]]


def test_saved_retry_after_beyond_invocation_budget_sends_nothing():
    clock = Clock()
    not_before = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
    with client(lambda request: pytest.fail("request before saved cooldown"), clock=clock, not_before=not_before, run_seconds=10) as api:
        with pytest.raises(BudgetExceeded):
            api.get(COLLECTIONS_PATH, {})
        assert api.attempts_used == 0
    assert clock.sleeps == []


def test_retry_after_recorded_on_final_allowed_attempt():
    attempts = []
    with client(lambda request: httpx.Response(429, headers={"Retry-After": "600"}), observer=attempts.append, max_attempts=1, retry_attempts=1) as api:
        with pytest.raises(ApiError):
            api.get(LISTINGS_PATH, {})
    assert len(attempts) == 1
    assert attempts[0]["retry_after_at"] is not None


def test_retry_after_survives_exhaustion_for_next_stream_on_same_client():
    clock = Clock()
    requests = []

    def handler(request):
        requests.append(clock.now)
        return httpx.Response(429, headers={"Retry-After": "8"}) if len(requests) == 1 else httpx.Response(200)

    with client(handler, clock=clock, retry_attempts=1) as api:
        with pytest.raises(ApiError):
            api.get(LISTINGS_PATH, {})
        api.get(HISTORY_PATH, {})
    assert requests == [0, 8]
    assert clock.sleeps == [8]


def test_expired_cooldown_does_not_delay_and_invalid_cooldown_rejected():
    clock = Clock()
    with client(lambda request: httpx.Response(200), clock=clock, not_before="2000-01-01T00:00:00+00:00") as api:
        api.get(COLLECTIONS_PATH, {})
    assert clock.sleeps == []
    with pytest.raises(ValueError, match="timezone-aware"):
        client(lambda request: httpx.Response(200), not_before="2026-10-08T12:00:00")


def test_budget_applies_across_requests_and_redacts_success_body():
    records = []
    with client(lambda request: httpx.Response(200, content=b'{"echo":"test-secret-token"}'), max_attempts=1, observer=records.append) as api:
        response = api.get(COLLECTIONS_PATH, {})
        with pytest.raises(BudgetExceeded):
            api.get(COLLECTIONS_PATH, {})
    assert b"test-secret-token" not in response.body
    assert b"test-secret-token" not in records[0]["body"]


def test_json_escaped_token_echo_is_redacted_before_storage():
    records = []
    body = b'{"echo":"\\u0074est-secret-token","number":0.12345678901234567890123456789}'
    with client(lambda request: httpx.Response(200, content=body), observer=records.append) as api:
        response = api.get(COLLECTIONS_PATH, {})
    assert b"secret-token" not in response.body
    assert b"secret-token" not in records[0]["body"]
    assert b"0.12345678901234567890123456789" in response.body


@pytest.mark.parametrize("body", [
    b'{"cursor":null,"cursor":null,"items":[],"echo":"\\u0074est-secret-token"}',
    b'{"cursor":null,"items":[],"bad":NaN,"echo":"\\u0074est-secret-token"}',
])
def test_redaction_does_not_turn_malformed_json_into_valid_pages(body):
    records = []
    with client(lambda request: httpx.Response(200, content=body), observer=records.append) as api:
        response = api.get(LISTINGS_PATH, {})
    assert b"secret-token" not in response.body
    assert b"secret-token" not in records[0]["body"]
    with pytest.raises(ValidationError):
        parse_page("listing", response.body)


def test_request_timeout_clamped_to_run_budget():
    seen = []
    clock = Clock()
    with client(lambda request: seen.append(request.extensions["timeout"]) or httpx.Response(200), clock=clock, run_seconds=4) as api:
        api.get(COLLECTIONS_PATH, {})
        clock.now = 4
        with pytest.raises(BudgetExceeded):
            api.get(COLLECTIONS_PATH, {})
    assert all(timeout == 4 for timeout in seen[0].values())


@pytest.mark.parametrize("kwargs", [{"requests_per_second": 0}, {"run_seconds": float("inf")}, {"timeout": -1}, {"retry_attempts": 0}, {"max_attempts": True}])
def test_configuration_is_validated(kwargs):
    with pytest.raises(ValueError):
        client(lambda request: httpx.Response(200), **kwargs)
