"""Secret import stays local, explicitly persisted, and absent from responses."""
import json
import logging
import sys
import uuid
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from marketapp_rent.config import Settings
from marketapp_rent.dashboard import create_app
from marketapp_rent.dashboard_credentials import (
    CredentialStoreError, DashboardCredentials, SessionOnlyCredentialStore,
    credential_target, valid_api_key,
    WindowsCredentialStore,
    UnavailableWindowsCredentialStore,
)


WALLET = "0:" + "11" * 32
KEY = "test-private-key-12345"
NEW_KEY = "replacement-private-key-54321"


class FakeStore:
    available = True

    def __init__(self):
        self.saved = {}
        self.calls = []
        self.fail = None

    def read(self, target):
        self.calls.append(("read", target))
        if self.fail == "read":
            raise CredentialStoreError("Native detail must not be returned")
        return self.saved.get(target)

    def write(self, target, key):
        self.calls.append(("write", target))
        if self.fail == "write":
            raise CredentialStoreError(key)
        self.saved[target] = key

    def delete(self, target):
        self.calls.append(("delete", target))
        if self.fail == "delete":
            raise CredentialStoreError(KEY)
        self.saved.pop(target, None)


@pytest.fixture
def settings(tmp_path):
    return Settings(db_path=tmp_path / "main.sqlite3", owner_address=WALLET)


def app_for(settings, store=None, **options):
    return create_app(settings, start_worker=False,
                      credential_store=store if store is not None else FakeStore(), **options)


def csrf(app):
    return {"x-dashboard-csrf": app.state.csrf_token}


def save(client, app, key=KEY, persist=False, **kwargs):
    return client.post("/api/settings/marketapp", json={"api_key": key, "persist": persist},
                       headers=csrf(app), **kwargs)


def assert_private(response):
    assert KEY not in response.text
    assert NEW_KEY not in response.text
    assert "api_key" not in response.json()


def test_status_and_session_key_update_without_network_or_plaintext_storage(settings, tmp_path):
    store = FakeStore()
    app = app_for(settings, store)
    with TestClient(app) as client:
        status = client.get("/api/settings/marketapp")
        assert status.json() == {"configured": False, "source": "none", "persistent_storage_available": True,
                                 "network_enabled": False, "can_manage": True, "restart_required": False}
        result = save(client, app)
        assert result.status_code == 200
        assert result.json()["source"] == "session"
        assert result.json()["restart_required"] is True
        assert result.json()["network_enabled"] is False
        assert_private(result)
        assert client.get("/api/dashboard").json()["capabilities"]["marketapp_configured"] is True
        assert client.post("/api/jobs", json={"kind": "prices"}, headers=csrf(app)).status_code == 409
        assert store.saved == {}
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert KEY.encode() not in path.read_bytes()
    with TestClient(app_for(settings, store)) as client:
        assert client.get("/api/settings/marketapp").json()["configured"] is False


def test_persisted_key_reloads_and_delete_removes_only_its_database_key(settings):
    store = FakeStore()
    store.saved["unrelated-target"] = "unrelated-secret"
    app = app_for(settings, store, allow_network=True)
    with TestClient(app) as client:
        response = save(client, app, persist=True)
        assert response.status_code == 200
        assert response.json()["source"] == "secure_store"
        assert response.json()["restart_required"] is False
    reloaded = app_for(settings, store)
    with TestClient(reloaded) as client:
        status = client.get("/api/settings/marketapp")
        assert status.json()["configured"] is True
        assert status.json()["source"] == "secure_store"
        assert_private(status)
        assert client.get("/api/dashboard").json()["capabilities"]["marketapp_configured"] is True
        removed = client.delete("/api/settings/marketapp", headers=csrf(reloaded))
        assert removed.status_code == 200
        assert removed.json()["configured"] is False
        assert client.get("/api/dashboard").json()["capabilities"]["marketapp_configured"] is False
    assert store.saved == {"unrelated-target": "unrelated-secret"}


def test_session_replacement_removes_old_persisted_key(settings):
    store = FakeStore()
    store.saved[credential_target(settings.db_path)] = KEY
    app = app_for(settings, store)
    with TestClient(app) as client:
        result = save(client, app, NEW_KEY, False)
        assert result.json()["source"] == "session"
        assert store.saved == {}
    assert DashboardCredentials(settings.db_path, store=store).key == ""


def test_external_configuration_has_priority_and_cannot_be_replaced_or_deleted(settings):
    store = FakeStore()
    store.saved[credential_target(settings.db_path)] = KEY
    app = app_for(replace(settings, token=NEW_KEY), store)
    with TestClient(app) as client:
        status = client.get("/api/settings/marketapp")
        assert status.json()["source"] == "environment"
        assert status.json()["can_manage"] is False
        assert status.json()["reason"] == "external_configuration"
        assert save(client, app).status_code == 409
        assert client.delete("/api/settings/marketapp", headers=csrf(app)).status_code == 409
        assert_private(status)
    assert store.calls == []
    assert store.saved[credential_target(settings.db_path)] == KEY


def test_session_fallback_never_persists_on_unsupported_platform(settings):
    app = app_for(settings, SessionOnlyCredentialStore())
    with TestClient(app) as client:
        initial = client.get("/api/settings/marketapp").json()
        assert initial["persistent_storage_available"] is False
        assert initial["can_manage"] is True
        assert save(client, app, persist=True).status_code == 409
        assert save(client, app).json()["source"] == "session"
        assert client.delete("/api/settings/marketapp", headers=csrf(app)).json()["configured"] is False


@pytest.mark.parametrize("method", ["POST", "DELETE"])
def test_mutations_require_csrf_and_same_origin(settings, method):
    app = app_for(settings)
    with TestClient(app) as client:
        body = {"api_key": KEY, "persist": False} if method == "POST" else None
        assert client.request(method, "/api/settings/marketapp", json=body).status_code == 403
        assert client.request(method, "/api/settings/marketapp", json=body, headers={**csrf(app), "origin": "https://foreign.invalid"}).status_code == 403
        assert client.get("/api/settings/marketapp", headers={"origin": "https://foreign.invalid"}).status_code == 403
        assert client.get("/api/settings/marketapp").json()["configured"] is False


@pytest.mark.parametrize("body", [
    {"api_key": KEY}, {"api_key": KEY, "persist": "true"}, {"api_key": KEY, "persist": 1},
    {"api_key": KEY, "persist": False, "extra": KEY}, {"api_key": 123, "persist": False},
    {"api_key": "Bearer " + KEY, "persist": False}, {"api_key": KEY + "\n", "persist": False},
    {"api_key": " " + KEY, "persist": False}, {"api_key": "", "persist": False},
    {"api_key": KEY + "\u2603", "persist": False}, {"api_key": "x" * 513, "persist": False},
    {"api_key": KEY + "\u007f", "persist": False}, [KEY], None,
])
def test_invalid_input_has_static_errors_without_reflecting_keys(settings, body):
    app = app_for(settings)
    with TestClient(app) as client:
        response = client.post("/api/settings/marketapp", content=json.dumps(body), headers=csrf(app))
        assert response.status_code == 422
        assert KEY not in response.text
        assert "input" not in response.json()
        assert client.get("/api/settings/marketapp").json()["configured"] is False


@pytest.mark.parametrize("body", [b'{"api_key":"test-private-key-12345', b'\xff',
                                    b'{"api_key":"a","api_key":"test-private-key-12345","persist":false}',
                                    b'[' * 1100 + b'0' + b']' * 1100])
def test_malformed_json_never_reflects_secrets(settings, body):
    app = app_for(settings)
    with TestClient(app) as client:
        response = client.post("/api/settings/marketapp", content=body, headers=csrf(app))
        assert response.status_code == 422
        assert KEY not in response.text


def test_actual_request_size_enforced_with_chunked_and_false_content_length(settings):
    app = app_for(settings)
    with TestClient(app) as client:
        oversized = json.dumps({"api_key": KEY, "persist": False, "padding": "x" * 5000}).encode()
        for headers in [csrf(app), {**csrf(app), "content-length": "1"}]:
            response = client.post("/api/settings/marketapp", content=iter([oversized[:100], oversized[100:]]), headers=headers)
            assert response.status_code == 413
            assert KEY not in response.text
            deleted = client.request("DELETE", "/api/settings/marketapp", content=iter([oversized[:100], oversized[100:]]), headers=headers)
            assert deleted.status_code == 413
        assert client.request("DELETE", "/api/settings/marketapp", content=KEY, headers=csrf(app)).status_code == 422
        assert client.get("/api/settings/marketapp").json()["configured"] is False


@pytest.mark.parametrize("state", ["queued", "running"])
def test_active_jobs_prevent_save_or_delete(settings, state):
    store = FakeStore()
    app = app_for(settings, store, allow_network=True)
    with TestClient(app) as client:
        assert save(client, app).status_code == 200
        job = client.post("/api/jobs", json={"kind": "prices"}, headers=csrf(app)).json()["job"]
        if state == "running":
            with app.state.jobs.connect() as connection:
                connection.execute("UPDATE dashboard_jobs SET state='running' WHERE id=?", (job["id"],))
        status = client.get("/api/settings/marketapp").json()
        assert status["can_manage"] is False
        assert status["reason"] == "active_job"
        assert save(client, app, NEW_KEY).status_code == 409
        assert client.delete("/api/settings/marketapp", headers=csrf(app)).status_code == 409
        app.state.jobs.finish(job["id"], "partial", "Stopped")
        assert save(client, app, NEW_KEY).status_code == 200


def test_worker_uses_current_settings_and_redacts_old_new_and_deleted_keys(settings, monkeypatch, capsys):
    received = []
    def fake_execute(job, jobs, runtime_settings, *args):
        received.append(runtime_settings.token)
        return {"state": "complete"}
    monkeypatch.setattr("marketapp_rent.dashboard.execute_job", fake_execute)
    app = app_for(settings)
    with TestClient(app) as client:
        save(client, app)
        app.state.worker.execute({"id": 1})
        save(client, app, NEW_KEY)
        app.state.worker.execute({"id": 2})
        client.delete("/api/settings/marketapp", headers=csrf(app))
        app.state.worker.execute({"id": 3})
        assert received == [KEY, NEW_KEY, ""]
        assert app.state.worker.clean(f"{KEY} {NEW_KEY}") == "[REDACTED] [REDACTED]"
        logging.getLogger("marketapp_rent.credentials_test").warning("Rejected %s and %s", KEY, NEW_KEY)
        output = capsys.readouterr().err
        assert KEY not in output and NEW_KEY not in output
        assert "[REDACTED]" in output


def test_store_failures_are_safe_and_preserve_current_runtime_key(settings):
    store = FakeStore()
    app = app_for(settings, store)
    with TestClient(app) as client:
        save(client, app)
        store.fail = "write"
        response = save(client, app, NEW_KEY, True)
        assert response.status_code == 503
        assert_private(response)
        assert client.get("/api/settings/marketapp").json()["source"] == "session"
    store.fail = "read"
    with TestClient(app_for(settings, store)) as client:
        status = client.get("/api/settings/marketapp").json()
        assert status["configured"] is False
        assert status["persistent_storage_available"] is False
        assert save(client, client.app).status_code == 200


def test_credential_target_is_canonical_scoped_and_contains_no_database_path(settings):
    target = credential_target(settings.db_path)
    assert target == credential_target(settings.db_path.parent / "." / settings.db_path.name)
    assert target != credential_target(settings.db_path.with_name("another.sqlite3"))
    assert str(settings.db_path) not in target
    assert len(target.rsplit(":", 1)[1]) == 64
    assert valid_api_key(KEY)


def test_unknown_persisted_state_must_be_removed_before_session_replacement_or_delete(settings):
    store = FakeStore()
    target = credential_target(settings.db_path)
    store.saved[target] = KEY
    store.fail = "read"
    for remove in [False, True]:
        store.saved[target] = KEY
        store.fail = "read"
        credentials = DashboardCredentials(settings.db_path, store=store)
        assert credentials.persisted_state_unknown is True
        store.fail = "delete"
        with pytest.raises(CredentialStoreError):
            credentials.delete() if remove else credentials.save(NEW_KEY, False)
        assert credentials.key == ""
        assert credentials.persisted_state_unknown is True
        store.fail = None
        credentials.delete() if remove else credentials.save(NEW_KEY, False)
        assert target not in store.saved
        assert DashboardCredentials(settings.db_path, store=store).key == ""


def test_native_initialization_failure_does_not_promise_session_replacement(settings):
    credentials = DashboardCredentials(settings.db_path, store=UnavailableWindowsCredentialStore())
    assert credentials.status(network_enabled=False)["can_manage"] is False
    with pytest.raises(CredentialStoreError):
        credentials.save(KEY, False)
    with pytest.raises(CredentialStoreError):
        credentials.delete()
    assert credentials.key == ""


@pytest.mark.skipif(sys.platform != "win32", reason="Native Windows credential API")
def test_native_windows_credential_round_trip_uses_isolated_fake_key():
    # A dedicated random test target never reads or replaces a user's saved key.
    target = "marketapp-rent:test:credential-roundtrip:" + uuid.uuid4().hex
    store = WindowsCredentialStore()
    try:
        assert store.read(target) is None
        store.write(target, KEY)
        assert store.read(target) == KEY
        store.write(target, NEW_KEY)
        assert store.read(target) == NEW_KEY
        store.delete(target)
        assert store.read(target) is None
    finally:
        store.delete(target)
