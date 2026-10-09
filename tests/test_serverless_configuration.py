"""The private module must never be built from a bot token as identity."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("configure_serverless", Path(__file__).parents[1] / "scripts" / "configure-serverless.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_serverless_environment_precedence_and_server_only_destination(tmp_path, monkeypatch, capsys):
    (tmp_path / ".env").write_text("MARKETAPP_API_TOKEN=file-token\nTELEGRAM_OWNER_USER_ID=987\n", encoding="utf-8")
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "environment-token")
    monkeypatch.setenv("TELEGRAM_OWNER_USER_ID", "123")
    path = module.configure(tmp_path, "456")
    assert path == tmp_path / "serverless/tgcloud/lib/private-config.js"
    content = path.read_text(encoding="utf-8")
    assert 'ownerTelegramId = 456' in content
    assert '"environment-token"' in content
    assert "file-token" not in content
    assert capsys.readouterr().out == ""
    assert not list(tmp_path.rglob(".private-config-*"))


@pytest.mark.parametrize("owner", [None, "", "123:bot-secret", "-1", "0", "9007199254740992", "１２３"])
def test_serverless_invalid_owner_fails_closed(tmp_path, monkeypatch, owner):
    monkeypatch.delenv("TELEGRAM_OWNER_USER_ID", raising=False)
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "test-token")
    with pytest.raises(ValueError, match="personal Telegram user ID"):
        module.configure(tmp_path, owner)
    assert not (tmp_path / "serverless/tgcloud/lib/private-config.js").exists()


@pytest.mark.parametrize("token", ["", " token", "token\nInjected: value", "token\x7f"])
def test_serverless_bad_token_does_not_overwrite_previous_config(tmp_path, monkeypatch, token):
    monkeypatch.setenv("MARKETAPP_API_TOKEN", "good-test-token")
    path = module.configure(tmp_path, "123")
    original = path.read_bytes()
    monkeypatch.setenv("MARKETAPP_API_TOKEN", token)
    with pytest.raises(ValueError, match="MARKETAPP_API_TOKEN"):
        module.configure(tmp_path, "123")
    assert path.read_bytes() == original
