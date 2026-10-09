"""Fresh dashboard scans are bounded while frozen work and old data survive."""
from datetime import datetime, timedelta, timezone
import json

import pytest

from marketapp_rent.config import Settings
from marketapp_rent.dashboard_jobs import JobStore, execute_job
from marketapp_rent.discovery_config import DiscoverySettings
from marketapp_rent.pricing_window import dashboard_window, pricing_window, validate_saved_dashboard_window, window_metadata


WALLET = "0:" + "01" * 32
NOW = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)


def test_offline_legacy_analytics_keep_all_but_dashboard_does_not():
    assert pricing_window("all", now=NOW)["from"].year == 1
    with pytest.raises(ValueError, match="90 days"):
        dashboard_window("all", now=NOW)
    assert dashboard_window("60d", now=NOW)["from"] == NOW - timedelta(days=60)


@pytest.mark.parametrize("days,accepted", [(90, True), (91, False)])
def test_future_end_does_not_disguise_oversized_custom_range(days, accepted):
    end = NOW.date() + timedelta(days=2)
    start = end - timedelta(days=days - 1)
    if accepted:
        assert dashboard_window("custom", start.isoformat(), end.isoformat(), now=NOW)["to"] == NOW
    else:
        with pytest.raises(ValueError, match="inclusive"):
            dashboard_window("custom", start.isoformat(), end.isoformat(), now=NOW)


@pytest.mark.parametrize("kind", ["collect", "rental_prices"])
def test_legacy_queued_history_work_pauses_before_provider_attempt(tmp_path, monkeypatch, kind):
    from marketapp_rent.api import ApiClient
    from marketapp_rent.ton_api import TonClient
    monkeypatch.setattr(ApiClient, "get", lambda *args, **kwargs: pytest.fail("Legacy job requested Marketapp"))
    monkeypatch.setattr(TonClient, "get", lambda *args, **kwargs: pytest.fail("Legacy job requested TON"))
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    job, _ = jobs.enqueue(kind, WALLET)
    with jobs.connect() as connection:
        connection.execute("UPDATE dashboard_jobs SET collection_window_json=NULL WHERE id=?", (job["id"],))
    result = execute_job(jobs.get(job["id"]), jobs, Settings(token="unused", db_path=tmp_path / "data.sqlite3"), DiscoverySettings())
    assert result["state"] == "partial"
    assert result["pages_committed"] == 0
    assert "fresh 30-day" in result["reason"]
    assert jobs.marketapp_usage(500)["used_24h"] == 0


def test_legacy_listing_only_job_remains_resumable(tmp_path):
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    job, _ = jobs.enqueue("prices", WALLET)
    with jobs.connect() as connection:
        connection.execute("UPDATE dashboard_jobs SET state='partial',collection_window_json=NULL WHERE id=?", (job["id"],))
    resumed, _ = jobs.enqueue(resume_job_id=job["id"])
    assert resumed["state"] == "queued"
    assert resumed["collection_window"] is None


@pytest.mark.parametrize("kind", ["collect", "rental_prices"])
@pytest.mark.parametrize("timeframe", ["7d", "custom"])
def test_direct_queue_new_history_cannot_bypass_age_policy(tmp_path, kind, timeframe):
    jobs = JobStore(tmp_path / "jobs.sqlite3")
    old = datetime.now(timezone.utc) - timedelta(days=365)
    window = window_metadata(dashboard_window(timeframe, old.date().isoformat() if timeframe == "custom" else None,
                                              old.date().isoformat() if timeframe == "custom" else None, now=old))
    with pytest.raises(ValueError, match="last 90"):
        jobs.enqueue(kind, WALLET, collection_window=window)
    assert jobs.list() == []


@pytest.mark.parametrize("bad", [None, {}, {"timeframe": "all"},
                                 {"timeframe": "90d", "window_from": "2026-01-01T00:00:00Z", "window_to": "2026-10-09T00:00:00Z", "timezone": "UTC"}])
def test_saved_window_rejects_missing_or_overlong_span(bad):
    with pytest.raises(ValueError, match="fresh 30-day"):
        validate_saved_dashboard_window(bad)


def test_saved_custom_ninety_dates_can_resume_years_later():
    window = window_metadata(dashboard_window("custom", "2020-01-01", "2020-03-30", now=NOW))
    assert validate_saved_dashboard_window(json.loads(json.dumps(window))) == window
