from pathlib import Path

import pytest

from marketapp_rent.config import Settings, load_settings
from marketapp_rent.util import canonical_json
from decimal import Decimal


def test_environment_overrides_dotenv(tmp_path):
    env = tmp_path / ".env"
    env.write_text("MARKETAPP_API_TOKEN=file-secret\nMARKETAPP_PAGE_SIZE=20\n")
    settings = load_settings(env, {"MARKETAPP_API_TOKEN": "environment-secret"})
    assert settings.token == "environment-secret"
    assert settings.page_size == 20
    assert "secret" not in repr(settings)


@pytest.mark.parametrize("kwargs", [
    {"page_size": 101}, {"page_size": 0}, {"max_pages": 0},
    {"run_seconds": float("inf")}, {"requests_per_second": float("nan")},
    {"token": "abc\ndef"}, {"sort_by": "unsupported"},
    {"page_size": 1.5}, {"max_pages": 1.5}, {"retry_attempts": True},
    {"run_seconds": True}, {"timeout": "30"},
])
def test_invalid_settings(kwargs):
    with pytest.raises(ValueError):
        Settings(**kwargs)


def test_bad_numeric_environment_hides_value(tmp_path):
    with pytest.raises(ValueError, match="Invalid MARKETAPP_PAGE_SIZE") as exc:
        load_settings(tmp_path / "missing", {"MARKETAPP_PAGE_SIZE": "sensitive-value"})
    assert "sensitive-value" not in str(exc.value)


def test_canonical_json_preserves_decimal_without_context_rounding():
    number = Decimal("123456789012345678901234567890.123456789")
    assert canonical_json({"value": number}) == '{"value":123456789012345678901234567890.123456789}'
    assert canonical_json({"b": None, "a": Decimal("1.500")}) == '{"a":1.5,"b":null}'
