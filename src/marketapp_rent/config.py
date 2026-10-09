"""Environment configuration; no credentials are written to collection runs."""

import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from dotenv import dotenv_values


SORT_ORDERS = (
    "price_per_day", "min_price", "duration_asc", "duration_desc",
    "item_num_asc", "item_num_desc", "recently_touch",
)
HISTORY_ORDERS = ("new_to_old", "old_to_new")


@dataclass(frozen=True)
class Settings:
    token: str = field(default="", repr=False)
    db_path: Path = Path("data/marketapp.sqlite3")
    owner_address: str | None = None
    page_size: int = 10
    max_pages: int = 2
    max_collections: int = 3
    max_attempts: int = 25
    run_seconds: float = 300
    requests_per_second: float = 1
    timeout: float = 30
    retry_attempts: int = 4
    dashboard_max_attempts: int = 100
    dashboard_daily_max_attempts: int = 500
    dashboard_run_seconds: float = 300
    sort_by: str = "recently_touch"
    order_by: str = "new_to_old"

    def __post_init__(self) -> None:
        for name in ("page_size", "max_pages", "max_collections", "max_attempts", "retry_attempts", "dashboard_max_attempts", "dashboard_daily_max_attempts"):
            if type(getattr(self, name)) is not int:
                raise ValueError(f"{name} must be an integer")
        if not 1 <= self.page_size <= 100:
            raise ValueError("page_size must be between 1 and 100")
        for name in ("max_pages", "max_collections", "max_attempts", "retry_attempts", "dashboard_max_attempts", "dashboard_daily_max_attempts"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be at least 1")
        for name in ("run_seconds", "requests_per_second", "timeout", "dashboard_run_seconds"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be a finite positive number")
        if self.sort_by not in SORT_ORDERS or self.order_by not in HISTORY_ORDERS:
            raise ValueError("Invalid listing sort or history order")
        if any(ord(character) < 32 or ord(character) > 126 for character in self.token):
            raise ValueError("MARKETAPP_API_TOKEN must contain only printable ASCII")


def load_settings(
    env_file: str | Path = ".env", environ: Mapping[str, str] | None = None,
) -> Settings:
    values = {**dotenv_values(env_file), **(os.environ if environ is None else environ)}
    kwargs: dict = {}
    for key, converter in {
        "page_size": int, "max_pages": int, "max_collections": int,
        "max_attempts": int, "run_seconds": float, "requests_per_second": float,
        "timeout": float, "retry_attempts": int, "sort_by": str, "order_by": str,
        "dashboard_max_attempts": int, "dashboard_daily_max_attempts": int,
        "dashboard_run_seconds": float,
    }.items():
        name = "MARKETAPP_" + key.upper()
        if name in values:
            try:
                kwargs[key] = converter(values[name])
            except (ValueError, TypeError):
                raise ValueError(f"Invalid {name}") from None
    return Settings(
        token=(values.get("MARKETAPP_API_TOKEN") or "").strip(),
        db_path=Path(values.get("MARKETAPP_DB_PATH") or "data/marketapp.sqlite3"),
        owner_address=(values.get("MARKETAPP_OWNER_ADDRESS") or "").strip() or None,
        **kwargs,
    )
