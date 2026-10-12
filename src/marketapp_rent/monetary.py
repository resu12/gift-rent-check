"""Resource bounds for exact decimal evidence and fixed-point display.

These are processing limits, not currency scale rules. They leave room for
existing price-tracking precision and preserve accepted values without rounding.
"""

from decimal import Decimal, InvalidOperation

MAX_DECIMAL_INPUT_CHARS = 2200
MAX_DECIMAL_DIGITS = 1100
MAX_DECIMAL_EXPONENT = 1000
MAX_DECIMAL_OUTPUT_CHARS = 2200


def bounded_decimal(value: str | int | float | Decimal) -> Decimal:
    """Reject unsupported values before any potentially large expansion."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise ValueError("Unsupported decimal value")
    try:
        if isinstance(value, Decimal):
            number = value
        else:
            text = str(value)
            if len(text) > MAX_DECIMAL_INPUT_CHARS:
                raise ValueError("Decimal input exceeds processing limit")
            number = Decimal(text)
    except InvalidOperation:
        raise ValueError("Invalid decimal value") from None
    if not number.is_finite():
        raise ValueError("Non-finite decimal value")
    sign, digits, exponent = number.as_tuple()
    if len(digits) > MAX_DECIMAL_DIGITS or abs(exponent) > MAX_DECIMAL_EXPONENT:
        raise ValueError("Decimal exceeds processing limit")
    # Count fixed-point characters without formatting or doing arithmetic.
    length = (len(digits) + exponent if exponent >= 0 else
              len(digits) + 1 if len(digits) + exponent > 0 else 2 - exponent)
    if length + sign > MAX_DECIMAL_OUTPUT_CHARS:
        raise ValueError("Decimal display exceeds processing limit")
    return number


def decimal_text(value: str | int | float | Decimal) -> str:
    return format(bounded_decimal(value), "f")
