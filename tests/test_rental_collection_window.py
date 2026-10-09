"""Selected rental windows bound traversal without changing provider queries."""
import json
import sqlite3
from dataclasses import replace

import httpx
import pytest

from marketapp_rent.api import ApiClient, COLLECTIONS_PATH, HISTORY_PATH
from marketapp_rent.config import Settings
from marketapp_rent.price_collection import collect_rental_prices
from marketapp_rent.storage import Store


COLLECTION = "0:" + "33" * 32
NFT = "0:" + "22" * 32
GIFT = {"nft_address": NFT, "collection_address": COLLECTION, "model": "A",
        "is_portfolio": True, "category": "portfolio"}
SETTINGS = Settings(token="mock", page_size=100, max_pages=10)


def history(ts):
    return {"address": NFT, "name": "Example #1", "collection_address": COLLECTION,
            "ts": ts, "src": "source", "dst": "destination", "price": "0.15",
            "price_nano": "150000000", "currency": "GRAM", "duration": 86400}


class WindowAPI:
    def __init__(self, pages):
        self.pages = pages
        self.requests = []
        self.now = 0.0

    def respond(self, request):
        self.requests.append(request)
        assert request.method == "GET"
        assert request.headers["Authorization"] == "mock"
        if request.url.path == COLLECTIONS_PATH:
            return httpx.Response(200, json=[])
        assert request.url.path == HISTORY_PATH
        assert set(request.url.params) <= {"collection_address", "order_by", "limit", "cursor"}
        return httpx.Response(200, json=self.pages[request.url.params.get("cursor")])

    def sleep(self, seconds):
        self.now += seconds

    def factory(self, *args, **kwargs):
        return ApiClient(*args, **kwargs, transport=httpx.MockTransport(self.respond),
                         sleep=self.sleep, monotonic=lambda: self.now)


def page(cursor, *timestamps):
    return {"cursor": cursor, "items": [history(ts) for ts in timestamps]}


def history_stream(store, run_id):
    return next(stream for stream in store.streams(run_id) if stream["kind"] == "history")


def test_inclusive_boundary_keeps_ties_and_commits_whole_crossing_page():
    api = WindowAPI({None: page("ties", 110, 100), "ties": page("older", 100, 99),
                     "older": page(None, 98)})
    with Store(":memory:") as store:
        result = collect_rental_prices(store, SETTINGS, gifts=[GIFT], history_since=100, client_factory=api.factory)
        assert (result.state, result.reason) == ("complete", "timeframe_covered")
        assert len(api.requests) == 3  # Catalog and two pages; no deliberately skipped boundary ties.
        stream = history_stream(store, result.run_id)
        assert (stream["state"], stream["reason"], stream["next_cursor"]) == ("complete", "timeframe_covered", "older")
        assert [item["data"]["ts"] for item in store.records("history")] == [110, 100, 99]
        assert len(store.observations("history")) == 4
        saved = store.get_run(result.run_id)["settings"]
        assert saved["history_since"] == 100
        assert saved["history_timestamp_semantics"] == "marketapp-rent-history-ui-v1"
        raw = store.connection.execute("SELECT body,next_cursor FROM pages WHERE stream_id=? ORDER BY id DESC", (stream["id"],)).fetchone()
        assert json.loads(raw["body"]) == page("older", 100, 99)
        assert raw["next_cursor"] == "older"
        assert collect_rental_prices(store, SETTINGS, resume_id=result.run_id, client_factory=api.factory) == replace(result, pages_committed=0)
        assert len(api.requests) == 3


def test_resume_freezes_cutoff_even_when_default_order_changes():
    api = WindowAPI({None: page("next", 110), "next": page("older", 99)})
    with Store(":memory:") as store:
        first = collect_rental_prices(store, replace(SETTINGS, max_pages=1), gifts=[GIFT], history_since=100, client_factory=api.factory)
        assert first.state == "partial"
        for options in ({"history_since": 105}, {"explicit_stream_options": {"history_since": None}}):
            with pytest.raises(ValueError, match="Cannot change"):
                collect_rental_prices(store, SETTINGS, resume_id=first.run_id, client_factory=api.factory, **options)
        assert len(api.requests) == 2
        final = collect_rental_prices(store, replace(SETTINGS, order_by="old_to_new"), resume_id=first.run_id, client_factory=api.factory)
        assert (final.state, final.reason) == ("complete", "timeframe_covered")
        assert api.requests[-1].url.params["order_by"] == "new_to_old"
        assert api.requests[-1].url.params["cursor"] == "next"


def test_empty_continuation_does_not_end_window_and_natural_end_is_distinct():
    api = WindowAPI({None: page("empty"), "empty": page(None, 99)})
    with Store(":memory:") as store:
        result = collect_rental_prices(store, SETTINGS, gifts=[GIFT], history_since=100, client_factory=api.factory)
        assert result.state == "complete" and result.reason is None
        assert history_stream(store, result.run_id)["reason"] is None
        assert len(api.requests) == 3


@pytest.mark.parametrize("timestamps", [(110, 0, 99), (110, -1, 99), (110, 10**30, 99), (110, 99, 105)])
def test_invalid_or_unsorted_timestamps_disable_cutoff_for_stream_after_resume(timestamps):
    api = WindowAPI({None: page("next", *timestamps), "next": page("last", 98), "last": page(None, 97)})
    with Store(":memory:") as store:
        first = collect_rental_prices(store, replace(SETTINGS, max_pages=1), gifts=[GIFT], history_since=100, client_factory=api.factory)
        assert first.state == "partial"
        assert store.issues()[0]["reason"] == "history_timeframe_order_unverified"
        final = collect_rental_prices(store, SETTINGS, resume_id=first.run_id, client_factory=api.factory)
        assert final.state == "complete" and final.reason is None
        assert len(api.requests) == 4
        assert len([issue for issue in store.issues() if issue["reason"] == "history_timeframe_order_unverified"]) == 1


def test_newer_timestamp_across_page_boundary_disables_early_stop():
    api = WindowAPI({None: page("next", 110, 105), "next": page("last", 108, 99), "last": page(None, 98)})
    with Store(":memory:") as store:
        result = collect_rental_prices(store, SETTINGS, gifts=[GIFT], history_since=100, client_factory=api.factory)
        assert result.state == "complete" and result.reason is None
        assert len(api.requests) == 4
        assert store.issues()[0]["reason"] == "history_timeframe_order_unverified"


@pytest.mark.parametrize("missing", [None, "absent"])
def test_schema_invalid_timestamp_does_not_advance_checkpoint(missing):
    bad = history(missing)
    if missing == "absent":
        del bad["ts"]
    api = WindowAPI({None: {"cursor": "never-follow", "items": [bad]}})
    with Store(":memory:") as store:
        result = collect_rental_prices(store, SETTINGS, gifts=[GIFT], history_since=100, client_factory=api.factory)
        stream = history_stream(store, result.run_id)
        assert stream["state"] == "failed" and stream["pages"] == 0
        assert stream["next_cursor"] is None
        assert not store.observations("history")


def test_boundary_completion_survives_crash_after_page_commit(monkeypatch):
    api = WindowAPI({None: page("older", 99)})
    with Store(":memory:") as store:
        original = store.commit_page

        def commit_then_crash(*args, **kwargs):
            result = original(*args, **kwargs)
            if kwargs.get("completion_reason"):
                raise RuntimeError("crash after atomic page commit")
            return result

        monkeypatch.setattr(store, "commit_page", commit_then_crash)
        with pytest.raises(RuntimeError, match="atomic page"):
            collect_rental_prices(store, SETTINGS, gifts=[GIFT], history_since=100, client_factory=api.factory)
        saved = store.runs()[-1]
        assert history_stream(store, saved["id"])["state"] == "complete"
        monkeypatch.setattr(store, "commit_page", original)
        result = collect_rental_prices(store, SETTINGS, resume_id=saved["id"], client_factory=api.factory)
        assert (result.state, result.reason, result.pages_committed) == ("complete", "timeframe_covered", 0)
        assert len(api.requests) == 2 and len(store.observations("history")) == 1


def test_boundary_state_failure_rolls_back_raw_page_records_and_observations():
    api = WindowAPI({None: page("older", 99)})
    with Store(":memory:") as store:
        store.connection.executescript("""CREATE TEMP TRIGGER fail_boundary BEFORE UPDATE OF pages ON streams
            WHEN NEW.reason='timeframe_covered' BEGIN SELECT RAISE(ABORT,'boundary write failed'); END;""")
        with pytest.raises(sqlite3.IntegrityError, match="boundary write failed"):
            collect_rental_prices(store, SETTINGS, gifts=[GIFT], history_since=100, client_factory=api.factory)
        saved = store.runs()[-1]
        stream = history_stream(store, saved["id"])
        assert stream["pages"] == 0 and stream["next_cursor"] is None
        assert not store.records("history") and not store.observations("history")
        assert store.connection.execute("SELECT count(*) FROM pages WHERE stream_id=?", (stream["id"],)).fetchone()[0] == 0
        store.connection.execute("DROP TRIGGER fail_boundary")
        result = collect_rental_prices(store, SETTINGS, resume_id=saved["id"], client_factory=api.factory)
        assert result.reason == "timeframe_covered"
        assert len(store.observations("history")) == 1


@pytest.mark.parametrize("cutoff", [True, 0, -1, 1.5, "100", 10**30])
def test_invalid_cutoff_creates_no_run(cutoff):
    with Store(":memory:") as store:
        with pytest.raises(ValueError, match="cutoff"):
            collect_rental_prices(store, SETTINGS, gifts=[GIFT], history_since=cutoff)
        assert not store.runs()


def test_cutoff_requires_descending_order_and_cannot_be_added_on_resume():
    with Store(":memory:") as store:
        with pytest.raises(ValueError, match="new_to_old"):
            collect_rental_prices(store, replace(SETTINGS, order_by="old_to_new"), gifts=[GIFT], history_since=100)
        api = WindowAPI({None: page("older", 99), "older": page(None, 98)})
        initial = collect_rental_prices(store, replace(SETTINGS, max_pages=1), gifts=[GIFT], client_factory=api.factory)
        with pytest.raises(ValueError, match="Cannot change history cutoff"):
            collect_rental_prices(store, SETTINGS, resume_id=initial.run_id, history_since=100, client_factory=api.factory)
        final = collect_rental_prices(store, SETTINGS, resume_id=initial.run_id, client_factory=api.factory)
        assert final.reason is None and len(api.requests) == 3
