"""Named sweeps. `models: []` means every GGUF in models/."""

PRESETS = {
    "smoke": {
        "name": "Smoke test",
        "description": "One configuration, one repeat. Checks that everything works (under a minute).",
        "spec": {"models": [], "threads": ["all_p"], "prompt_tokens": [200], "concurrency": [1], "repeats": 1},
    },
    "laptop": {
        "name": "Laptop sweep",
        "description": "The full study: 2 quants × 3 thread settings × 2 prompt lengths × 3 concurrency levels × 3 repeats.",
        "spec": {"models": [], "threads": ["half_p", "all_p", "all"], "prompt_tokens": [200, 4000],
                 "concurrency": [1, 4, 8], "repeats": 3},
    },
    "cloud": {
        "name": "Cloud subset",
        "description": "For the x86 vs Graviton comparison: 4-bit, all performance cores, 2 prompt lengths × 3 concurrency levels.",
        "spec": {"models": ["qwen2.5-1.5b-instruct-q4_k_m.gguf"], "threads": ["all_p"], "prompt_tokens": [200, 4000],
                 "concurrency": [1, 4, 8], "repeats": 3},
    },
    "metal": {
        "name": "CPU vs Metal GPU",
        "description": "The same 4-bit cloud subset with every layer on the Apple GPU, to compare against the CPU runs.",
        "spec": {"models": ["qwen2.5-1.5b-instruct-q4_k_m.gguf"], "threads": ["all_p"], "prompt_tokens": [200, 4000],
                 "concurrency": [1, 4, 8], "repeats": 3, "gpu_layers": 99},
    },
}
