"""Offline source-language hint for the prompt; never judges generated text."""
from functools import lru_cache
import re

PROTECTED = re.compile(r"(?ms)^\s*(`{3,}|~{3,})[^\n]*\n.*?(?:^\s*\1\s*$|\Z)|`+[^`\n]*`+|https?://[^\s<>\u3000-\u303f]+|⟦YANMO_CODE_[^⟧]+⟧|\b[A-Za-z_]\w*\d\w*\b")


@lru_cache(maxsize=1)
def identifier():
    # The small classifier is bundled with the Python dependency; no downloads.
    # Cache only the classifier, never the user's text or classification results.
    from langid.langid import LanguageIdentifier, model
    return LanguageIdentifier.from_modelstring(model, norm_probs=True)


def prose(text):
    return PROTECTED.sub(" ", text)


def language_hint(source):
    source = prose(source)
    if not any(char.isalpha() for char in source):
        return None
    language, score = identifier().classify(source)
    return language if score >= 0.9 else None
