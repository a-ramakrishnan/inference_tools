"""ibench: measure LLM inference latency, throughput and memory with llama.cpp."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
RESULTS_DIR = ROOT / "results"
