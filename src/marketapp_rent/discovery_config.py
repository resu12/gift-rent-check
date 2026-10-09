"""Independent invocation budgets for read-only TON wallet discovery."""

import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values


@dataclass(frozen=True)
class DiscoverySettings:
    api_key: str = field(default="", repr=False)
    page_size: int = 100
    batch_size: int = 100
    max_pages: int = 10
    max_attempts: int = 100
    run_seconds: float = 300
    requests_per_second: float = 1
    timeout: float = 30
    retry_attempts: int = 4

    def __post_init__(self) -> None:
        for name in ("page_size", "batch_size", "max_pages", "max_attempts", "retry_attempts"):
            if type(getattr(self, name)) is not int or getattr(self, name) < 1:
                raise ValueError(f"{name} must be a positive integer")
        if self.page_size > 1000:
            raise ValueError("TON discovery page_size must be between 1 and 1000")
        if self.batch_size > 100:
            raise ValueError("TON discovery batch_size must be between 1 and 100")
        for name in ("run_seconds", "requests_per_second", "timeout"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be a finite positive number")
        if any(ord(character) < 32 or ord(character) > 126 for character in self.api_key):
            raise ValueError("TONCENTER_API_KEY must contain only printable ASCII")


def load_discovery_settings(
    env_file: str | Path = ".env", environ: Mapping[str, str] | None = None,
) -> DiscoverySettings:
    values = {**dotenv_values(env_file), **(os.environ if environ is None else environ)}
    kwargs = {}
    for key, converter in {
        "page_size": int, "batch_size": int, "max_pages": int, "max_attempts": int,
        "run_seconds": float, "requests_per_second": float, "timeout": float, "retry_attempts": int,
    }.items():
        name = "TON_DISCOVERY_" + key.upper()
        if name in values:
            try:
                kwargs[key] = converter(values[name])
            except (ValueError, TypeError):
                raise ValueError(f"Invalid {name}") from None
    return DiscoverySettings(api_key=(values.get("TONCENTER_API_KEY") or "").strip(), **kwargs)
