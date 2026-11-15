"""Command line: run a sweep without the web app (on a cloud box, in Colab, in CI).

    ibench info
    ibench run --models qwen2.5-1.5b-instruct-q4_k_m.gguf --threads all_p --prompt 200 --concurrency 1 --repeats 1
    ibench run --preset laptop
"""

from __future__ import annotations

import argparse
import json

from .hardware import detect
from .presets import PRESETS
from .sweep import Sweep, SweepSpec, list_models


def _csv(cast):
    return lambda s: [cast(x) if cast is int and x.strip().isdigit() else x.strip() for x in s.split(",") if x.strip()]


def _print_event(kind: str, d: dict) -> None:
    if kind == "sweep_started":
        print(f"sweep {d['id']}: {d['total_runs']} runs on {d['machine']['label']}")
    elif kind == "server_starting":
        print(f"  starting llama-server: {d['quant']} threads={d['threads']} concurrency={d['concurrency']} ({d['device']})")
    elif kind == "server_ready":
        print(f"  ready in {d['load_s']}s")
    elif kind == "run_done":
        r = d["row"]
        mem = r["mem_peak_gb"] or r["rss_peak_gb"]
        print(f"  [{d['done']}/{d['total']}] {r['run_id']}: TTFT p50 {r['ttft_ms_p50']} ms · "
              f"{r['decode_tps_mean']} tok/s/req · {r['total_tps']} tok/s total · {mem} GB")
    elif kind == "control_done":
        d2 = d["drift_pct"]
        print(f"  control re-run of {d['run_id']}: TTFT {d2['ttft_ms_p50']:+}% · tok/s/req {d2['decode_tps_mean']:+}% "
              f"(thermal {d['thermal_first']} → {d['thermal_last']})" if None not in d2.values() else "  control run done")
    elif kind == "error":
        print(f"  ERROR {d['message']}")
    elif kind == "sweep_done":
        print(f"sweep {d['id']} {d['status']}: {d['done']} runs saved to results/{d['id']}/")


def main() -> None:
    ap = argparse.ArgumentParser(prog="ibench", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info", help="machine, llama.cpp version and models found")
    sv = sub.add_parser("serve", help="start the dashboard API (and the built web app) on http://127.0.0.1:8000")
    sv.add_argument("--port", type=int, default=8000)
    gw = sub.add_parser("gateway", help="start the OpenAI-compatible gateway (and its llama.cpp backends) on :8080")
    gw.add_argument("--config", help="gateway TOML file (default: gateway.toml)")
    gw.add_argument("--no-start", action="store_true", help="don't start llama-servers; use the URLs in the config")
    gw.add_argument("--host")
    gw.add_argument("--port", type=int)
    r = sub.add_parser("run", help="run a sweep")
    r.add_argument("--preset", choices=sorted(PRESETS))
    r.add_argument("--models", type=_csv(str), help="GGUF file names in models/, comma separated")
    r.add_argument("--threads", type=_csv(int), help="half_p, all_p, all or numbers")
    r.add_argument("--prompt", type=_csv(int), help="prompt lengths in tokens")
    r.add_argument("--concurrency", type=_csv(int))
    r.add_argument("--repeats", type=int)
    r.add_argument("--n-predict", type=int)
    r.add_argument("--gpu-layers", type=int, help="0 = CPU only (default), 99 = all on GPU")
    r.add_argument("--hourly-cost", type=float, help="instance price in USD/hour, for cost per million tokens")
    r.add_argument("--cooldown", type=float, help="seconds to pause between runs (fanless laptops throttle)")
    r.add_argument("--no-control", action="store_true", help="skip re-running the first configuration at the end")
    r.add_argument("--label", default="")
    ag = sub.add_parser("agent", help="agent-style vs chat traffic through the gateway (gateway must be running)")
    ag.add_argument("--sessions", type=_csv(int), default=[1, 4, 8], help="concurrent sessions, comma separated")
    ag.add_argument("--turns", type=int, default=8, help="requests per session")
    ag.add_argument("--tool-tokens", type=int, default=250, help="approximate size of each tool result")
    ag.add_argument("--system-tokens", type=int, default=700, help="approximate size of the shared system prompt")
    ag.add_argument("--conditions", type=_csv(str), default=["agent-cache", "agent-nocache", "chat"])
    ag.add_argument("--model", default="qwen-fast", help="gateway model name")
    ag.add_argument("--gateway", default="http://127.0.0.1:8080")
    ag.add_argument("--label", default="")
    a = ap.parse_args()

    if a.cmd == "serve":
        import uvicorn
        uvicorn.run("ibench.api:app", host="127.0.0.1", port=a.port)
        return
    if a.cmd == "gateway":
        import uvicorn
        from .gateway.app import create_app
        from .gateway.config import load
        cfg = load(a.config)
        app = create_app(a.config, start_backends=not a.no_start)
        print(f"gateway: {len(cfg.backends)} backends, {len(cfg.keys)} API keys, usage in {cfg.db_path}")
        uvicorn.run(app, host=a.host or cfg.host, port=a.port or cfg.port, log_level="warning")
        return
    if a.cmd == "agent":
        from .agent import AgentRun, AgentSpec

        def show(kind: str, d: dict) -> None:
            if kind == "agent_phase":
                print(f"\n{d['condition']}, {d['sessions']} session(s)")
            elif kind == "agent_request":
                r = d["row"]
                print(f"  [{d['done']}/{d['total']}] s{r['session']} t{r['turn']}  prompt {r['prompt_tokens']} "
                      f"(cached {r['cached_tokens']})  ttft {r['ttft_ms']} ms  {r['tool_name'] or ''}{r['error'] or ''}")
        spec = AgentSpec(gateway=a.gateway, model=a.model, sessions=a.sessions, turns=a.turns, tool_tokens=a.tool_tokens,
                         system_tokens=a.system_tokens, conditions=a.conditions, label=a.label or "CLI agent run")
        print(AgentRun(spec, on_event=show).run())
        return
    if a.cmd == "info":
        print(json.dumps({"machine": detect(), "models": list_models()}, indent=2))
        return
    base = dict(PRESETS[a.preset]["spec"]) if a.preset else {}
    if not base.get("models"):
        base["models"] = [m["file"] for m in list_models()]
    for key, val in (("models", a.models), ("threads", a.threads), ("prompt_tokens", a.prompt),
                     ("concurrency", a.concurrency), ("repeats", a.repeats), ("n_predict", a.n_predict),
                     ("gpu_layers", a.gpu_layers), ("hourly_cost", a.hourly_cost), ("cooldown_s", a.cooldown)):
        if val is not None:
            base[key] = val
    if a.no_control:
        base["control_run"] = False
    base["label"] = a.label or (PRESETS[a.preset]["name"] if a.preset else "CLI run")
    Sweep(SweepSpec(**base), emit=_print_event).run()


if __name__ == "__main__":
    main()
