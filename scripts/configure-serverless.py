"""Create server-only, Git-ignored credentials without printing their values."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile

from dotenv import load_dotenv


def configure(project: Path, owner_id: str | None) -> Path:
    load_dotenv(project / ".env", override=False)
    identity = owner_id or os.environ.get("TELEGRAM_OWNER_USER_ID", "")
    if not identity.isascii() or not identity.isdecimal() or not 0 < int(identity) <= 2**53 - 1:
        raise ValueError("Provide your numeric personal Telegram user ID with --owner-id or TELEGRAM_OWNER_USER_ID. A bot token is not a user ID.")
    token = os.environ.get("MARKETAPP_API_TOKEN", "")
    if not token or token != token.strip() or any(ord(c) < 32 or ord(c) == 127 for c in token):
        raise ValueError("Set a valid MARKETAPP_API_TOKEN in the environment or the project's local .env.")
    target = project / "serverless" / "tgcloud" / "lib" / "private-config.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    content = (
        "// Generated server-only configuration. Git-ignored; never import into frontend code.\n"
        f"export const ownerTelegramId = {int(identity)};\n"
        f"export const marketappToken = {json.dumps(token)};\n"
    )
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent,
                                     prefix=".private-config-", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(content)
    try:
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-id", help="Your personal numeric Telegram user ID, not the bot ID")
    args = parser.parse_args()
    try:
        configure(Path(__file__).resolve().parents[1], args.owner_id)
    except ValueError as error:
        parser.error(str(error))
    print("Private backend configuration saved. No credentials are included in the frontend build.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
