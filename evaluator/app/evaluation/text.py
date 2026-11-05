"""Quote normalization and verification (TRD 4.4), data-block wrapping (4.6)."""
from __future__ import annotations

import hashlib
import re
import secrets
import unicodedata

MAX_EXCERPT_CHARS = 6000
MIN_QUOTE_CHARS = 4

_QUOTES = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u00b4": "'", "`": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u00ab": '"', "\u00bb": '"', "\u300c": '"', "\u300d": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-",
})
_WS = re.compile(r"\s+")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text or "").translate(_QUOTES)
    return _WS.sub(" ", text).strip()


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def verify_quote(quote: str, excerpt: str) -> bool:
    q = normalize(quote)
    if len(q.replace(" ", "")) < MIN_QUOTE_CHARS:
        return False
    return q in normalize(excerpt)


def wrap_data_block(excerpt: str) -> tuple[str, str]:
    """Wrap untrusted posting text in nonce-delimited block. Returns (block, delimiter)."""
    nonce = secrets.token_hex(6)
    start, end = f"<<<POSTING_DATA_{nonce}", f"POSTING_DATA_{nonce}>>>"
    safe = excerpt.replace("<<<POSTING_DATA", "<<< POSTING_DATA").replace("POSTING_DATA_", "POSTING_DATA ")
    return f"{start}\n{safe}\n{end}", nonce
