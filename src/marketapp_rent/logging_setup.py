"""JSON lines on stderr; credentials and response bodies are never logged."""

import logging
import sys

from .util import canonical_json, utc_now


class JsonFormatter(logging.Formatter):
    def __init__(self, token: str = "", *secrets: str) -> None:
        super().__init__()
        self.secrets = sorted({value for value in (token, *secrets) if value}, key=len, reverse=True)

    def _redact(self, value: str) -> str:
        for secret in self.secrets:
            value = value.replace(secret, "[REDACTED]")
        return value

    def _redact_context(self, value):
        if isinstance(value, str):
            return self._redact(value)
        if isinstance(value, dict):
            return {self._redact(str(key)): self._redact_context(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._redact_context(item) for item in value]
        return value

    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        message = self._redact(message)
        result = canonical_json({
            "timestamp": utc_now(), "level": record.levelname.lower(),
            "event": getattr(record, "event", "message"), "message": message,
            **self._redact_context(getattr(record, "context", {})),
        })
        return self._redact(result)


def configure_logging(token: str = "", *secrets: str) -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter(token, *secrets))
    logger = logging.getLogger("marketapp_rent")
    logger.handlers[:] = [handler]
    logger.setLevel(logging.INFO)
    logger.propagate = False
