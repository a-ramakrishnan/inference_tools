"""Prompts of an exact token length.

The text is synthetic (seeded, so every machine gets the same prompts) and each request gets its own opening
line, so concurrent requests never share a prefix the server could reuse. The length is fixed with the server's
own tokenizer: tokenize a passage that is too long, keep the first N tokens, turn them back into text.
"""

from __future__ import annotations

import random

import httpx

_SUBJECTS = ["The engineer", "A small team", "The scheduler", "Each worker", "The old library", "A data center",
             "The river pilot", "Our compiler", "The night shift", "A field biologist", "The city council",
             "The test harness", "A cargo ship", "The orchestra", "The weather model", "A junior analyst"]
_VERBS = ["measured", "rebuilt", "questioned", "documented", "compressed", "delayed", "rerouted", "inspected",
          "simplified", "replaced", "monitored", "estimated", "balanced", "recorded", "translated", "tuned"]
_OBJECTS = ["the quarterly forecast", "every incoming request", "the cooling system", "a stack of old maps",
            "the slowest query", "the harbour schedule", "three competing designs", "the memory budget",
            "the bridge sensors", "a backlog of reports", "the evening timetable", "the cache policy",
            "the long survey", "a set of field notes", "the power readings", "the release plan"]
_TAILS = ["before the deadline.", "without telling anyone.", "after a long argument.", "with surprising care.",
          "while the rain continued.", "to everyone's relief.", "for the second time that week.",
          "using only a notebook.", "as the lights flickered.", "and wrote down every number."]

INSTRUCTION = "\n\nSummarize the passage above in plain language, then list its main events in order."


def passage(n_sentences: int, seed: int = 0) -> str:
    rng = random.Random(seed)
    return " ".join(f"{rng.choice(_SUBJECTS)} {rng.choice(_VERBS)} {rng.choice(_OBJECTS)} {rng.choice(_TAILS)}"
                    for _ in range(n_sentences))


class PromptBuilder:
    """Builds prompts of `target_tokens` tokens (including the instruction) against a running llama-server."""

    def __init__(self, server_url: str):
        self.url = server_url
        self._body_cache: dict[int, list[int]] = {}

    def _tokenize(self, text: str) -> list[int]:
        r = httpx.post(self.url + "/tokenize", json={"content": text}, timeout=60)
        r.raise_for_status()
        return r.json()["tokens"]

    def _detokenize(self, tokens: list[int]) -> str:
        r = httpx.post(self.url + "/detokenize", json={"tokens": tokens}, timeout=60)
        r.raise_for_status()
        return r.json()["content"]

    def build(self, target_tokens: int, request_id: str) -> tuple[str, int]:
        """Returns (prompt text, exact token count)."""
        head = f"Document {request_id}.\n\n"
        fixed = len(self._tokenize(head)) + len(self._tokenize(INSTRUCTION))
        body_len = max(1, target_tokens - fixed)
        if body_len not in self._body_cache:
            text = passage(n_sentences=body_len // 8 + 20, seed=body_len)
            self._body_cache[body_len] = self._tokenize(text)[:body_len]
        prompt = head + self._detokenize(self._body_cache[body_len]) + INSTRUCTION
        return prompt, len(self._tokenize(prompt))
