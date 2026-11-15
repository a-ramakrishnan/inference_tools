import { CheckCircle2, CircleDashed, CircleDot, CircleSlash } from "lucide-react";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { aggregate, fmt } from "../agg";
import { api } from "../api";
import { PageHead } from "../components/Layout";
import { useAsync } from "../hooks";
import { Lifecycle } from "../components/arch/Lifecycle";
import { Worker } from "../components/arch/Worker";

const ORDER: Record<string, number> = { built: 0, partial: 1, next: 2, out: 3 };

type Status = "built" | "partial" | "next" | "out";

const STATUS: Record<Status, { label: string; cls: string; icon: ReactNode; stroke: string; fill: string; dash?: string; text: string }> = {
  built: { label: "Built", cls: "good", icon: <CheckCircle2 size={12} />, stroke: "var(--good)", fill: "color-mix(in srgb, var(--good) 8%, var(--surface-1))", text: "var(--text-primary)" },
  partial: { label: "Partial", cls: "info", icon: <CircleDot size={12} />, stroke: "var(--accent)", fill: "color-mix(in srgb, var(--accent) 8%, var(--surface-1))", text: "var(--text-primary)" },
  next: { label: "Next", cls: "warn", icon: <CircleDashed size={12} />, stroke: "var(--warning)", fill: "var(--surface-1)", dash: "6 4", text: "var(--text-primary)" },
  out: { label: "Out of scope", cls: "", icon: <CircleSlash size={12} />, stroke: "var(--border-strong)", fill: "var(--surface-2)", dash: "3 4", text: "var(--text-muted)" },
};

interface Node {
  id: string;
  title: string;
  lines: string[];           // what this repo uses for it, shown in the box
  status: Status;
  role: string;              // what the component does in a production platform
  here: string[];            // how this repo covers it
  where?: { label: string; to?: string; code?: string }[];
}

const NODES: Node[] = [
  { id: "client", title: "Client apps", lines: ["ibench load generator", "N concurrent streams"], status: "built",
    role: "Applications calling the platform through an SDK or REST, usually streaming.",
    here: ["The load generator sends N streaming requests at once, each with its own prompt of an exact token length.", "Every request produces exactly the requested number of tokens (ignore_eos), so runs are comparable.", "The dashboard is a second client: it drives sweeps and watches them live."],
    where: [{ label: "ibench/loadgen.py", code: "ibench/loadgen.py" }, { label: "ibench/prompts.py", code: "ibench/prompts.py" }, { label: "New sweep page", to: "/run" }] },
  { id: "lb", title: "Global load balancer", lines: ["single machine"], status: "out",
    role: "Spreads traffic across regions and clusters; health-checks and fails over.",
    here: ["Not built: everything runs on one machine. Results from several machines are compared offline instead."] },
  { id: "gateway", title: "Inference API gateway", lines: ["OpenAI-compatible", "/v1/chat/completions", "streaming pass-through"], status: "built",
    role: "The one public entry point: OpenAI-style endpoints, authentication, rate limits, request validation.",
    here: ["One OpenAI-compatible endpoint (/v1/chat/completions, /v1/models) in front of two llama.cpp servers; streaming responses pass straight through.", "The benchmark load generator still calls llama-server's /completion directly, so the gateway's overhead never enters the engine measurements.", "Docker Compose runs the two servers, the gateway and Jaeger together; on a Mac the containers use the CPU only, so the native gateway with Metal is several times faster."],
    where: [{ label: "ibench/gateway/app.py", code: "ibench/gateway/app.py" }, { label: "Gateway page", to: "/gateway" }] },
  { id: "goals", title: "Core goals", lines: [], status: "built",
    role: "What an inference platform is judged on.", here: [] },
  { id: "auth", title: "Auth & usage metering", lines: ["API keys from a config file", "tokens per key"], status: "built",
    role: "Validates API keys, enforces tiers and quotas, meters usage per key.",
    here: ["Bearer API keys read from gateway.toml (or an environment variable); an unknown key gets 401.", "Every request, including rejected ones, writes a usage row: key, model, backend, input/output/cached tokens and timings.", "Quotas, tiers and user management are out of scope."],
    where: [{ label: "gateway.toml", code: "gateway.toml" }, { label: "Usage report", to: "/gateway" }] },
  { id: "store", title: "Usage store", lines: ["SQLite (Postgres in prod)"], status: "built",
    role: "System of record for accounts, keys and usage.",
    here: ["A SQLite requests table written by the gateway (gateway-data/usage.db), grouped into usage by key, model, backend or day and exported as CSV."],
    where: [{ label: "ibench/gateway/store.py", code: "ibench/gateway/store.py" }] },
  { id: "router", title: "Model router", lines: ["by model name", "or prompt length"], status: "built",
    role: "Chooses a model and backend for each request: by model, region, canary version or fallback.",
    here: ["Routes by the requested model name (qwen-fast → 4-bit backend, qwen-quality → 8-bit backend).", "model=auto routes by prompt length: an estimate of characters ÷ 4 against a threshold sends long prompts to the backend with the larger context. The reason is recorded on every request.", "Learned or cost-optimized routing is out of scope."],
    where: [{ label: "ibench/gateway/app.py", code: "ibench/gateway/app.py" }] },
  { id: "scheduler", title: "Request queue", lines: ["bounded queue", "per-backend limit", "429 when full"], status: "built",
    role: "Admission control: priority tiers, fair sharing, separate prefill and decode queues, shedding load.",
    here: ["Each backend has a concurrency limit (matching its llama.cpp slots) and a bounded wait queue; once the queue is full, the gateway answers 429 instead of letting latency grow without bound.", "Queue wait is recorded per request. A 30-request burst against the fast backend (4 running, 16 waiting) served 20 and rejected 10, with waits stepping up four at a time.", "Priority tiers and separate prefill/decode queues are out of scope."],
    where: [{ label: "Traffic generator", to: "/gateway" }, { label: "ibench/gateway/app.py", code: "ibench/gateway/app.py" }] },
  { id: "engine", title: "Continuous batching", lines: ["llama.cpp server", "slots share each step"], status: "built",
    role: "Batches tokens from many requests into each forward pass, so throughput grows with load.",
    here: ["llama.cpp's server batches all active slots into every decode step (continuous batching).", "The concurrency sweep (1, 4, 8) shows the trade: total tokens/s rises while each request slows down.", "Paged attention and speculative decoding are not used."],
    where: [{ label: "Total throughput chart", to: "/results" }] },
  { id: "workers", title: "Worker pool", lines: ["llama-server processes", "CPU (Arm, x86) or Metal", "restarted per config"], status: "built",
    role: "The accelerators that run the model, with sharding, health checks and model loading.",
    here: ["One llama-server process per configuration, started with the exact threads, slots and GPU layers under test, health-checked before use.", "The same CLI runs on an Apple Silicon laptop, an x86 instance, a Graviton instance or Colab, so the CPUs can be compared."],
    where: [{ label: "ibench/server.py", code: "ibench/server.py" }, { label: "Compare machines", to: "/compare" }] },
  { id: "kv", title: "KV cache", lines: ["per slot, sized", "prompt + output", "prefix cache off"], status: "partial",
    role: "Keeps attention keys and values so earlier tokens aren't recomputed; prefix caching reuses shared prompts.",
    here: ["Each slot gets a KV cache sized for the longest prompt plus output; its cost shows in peak memory as concurrency rises.", "Prefix caching is deliberately off in the benchmark (cache_prompt: false), so every request pays for its prompt.", "Next: agent-style traffic with a growing context, with and without prompt caching."] },
  { id: "registry", title: "Model registry", lines: ["models/*.gguf", "Q4_K_M · Q8_0"], status: "built",
    role: "Stores weights, checkpoints and quantized variants; workers load from it.",
    here: ["models/ holds Qwen2.5-1.5B-Instruct in two quantizations, 4-bit (Q4_K_M) and 8-bit (Q8_0).", "Weights are loaded without mmap so the memory measurement includes them."],
    where: [{ label: "Overview: models", to: "/" }] },
  { id: "streaming", title: "Streaming responses", lines: ["SSE token stream", "TTFT = first chunk"], status: "built",
    role: "Streams tokens back as server-sent events; handles stop sequences.",
    here: ["Every request streams; time to first token is taken when the first token arrives at the client.", "The dashboard's live view is also an SSE stream from the backend."],
    where: [{ label: "Live page", to: "/live" }] },
  { id: "autoscaler", title: "Autoscaler", lines: ["fixed capacity"], status: "out",
    role: "Adds and removes workers on queue depth or utilization; scales cold models to zero.",
    here: ["Not built. Kubernetes and autoscaling are out of scope."] },
  { id: "monitoring", title: "Monitoring", lines: ["TTFT · tok/s · memory", "per-request timelines", "OpenTelemetry traces"], status: "built",
    role: "Metrics, traces and alerts: TTFT, tokens/s, accelerator memory, queue wait, errors.",
    here: ["Every run records TTFT, tokens/s per request and in total, prompt speed, peak memory and errors to CSV, with one row per request too.", "The dashboard charts them live and after the fact.", "The gateway records an OpenTelemetry trace per request (queue wait, prefill, decode spans) and exports it over OTLP; under Docker Compose they appear in Jaeger, linked from the Gateway page. Dashboards and alerting are out of scope."],
    where: [{ label: "Results", to: "/results" }, { label: "ibench/sweep.py", code: "ibench/sweep.py" }] },
  { id: "billing", title: "Usage & cost", lines: ["$ per 1M output tokens", "tokens per API key"], status: "partial",
    role: "Input and output tokens per request, cost per request, billing.",
    here: ["Given an instance price, each run reports cost per million output tokens (price ÷ total throughput).", "The gateway reports input, output and cached tokens per API key, model, backend or day. Billing is out of scope."],
    where: [{ label: "Usage report", to: "/gateway" }] },
  { id: "warehouse", title: "Data warehouse", lines: ["CSV in results/"], status: "out",
    role: "Long-term store for usage and performance analytics.",
    here: ["Not built: results/<sweep>/*.csv files stand in, and are committed with the repo."] },
];

// The platform as layers, top to bottom, and the order one chat request visits components.
const LAYERS: { id: string; title: string; sub: string; nodes: string[] }[] = [
  { id: "ingress", title: "Ingress", sub: "where requests arrive", nodes: ["client", "lb", "gateway"] },
  { id: "control", title: "Control plane", sub: "who may run, where, and when", nodes: ["auth", "router", "scheduler", "store"] },
  { id: "data", title: "Data plane", sub: "where tokens are computed", nodes: ["engine", "workers", "kv", "registry"] },
  { id: "ops", title: "Egress & operations", sub: "what goes back out, and what is recorded", nodes: ["streaming", "monitoring", "billing", "autoscaler", "warehouse"] },
];
const PATH: { id: string; label: string }[] = [
  { id: "client", label: "Client sends" },
  { id: "gateway", label: "Gateway" },
  { id: "auth", label: "Key check" },
  { id: "router", label: "Pick backend" },
  { id: "scheduler", label: "Wait for a slot" },
  { id: "engine", label: "Batch" },
  { id: "workers", label: "Prefill + decode" },
  { id: "streaming", label: "Stream back" },
  { id: "billing", label: "Meter + trace" },
];
const STEP: Record<string, number> = Object.fromEntries(PATH.map((p, i) => [p.id, i + 1]));

export default function Architecture() {
  const [sel, setSel] = useState<string>("gateway");
  const [hover, setHover] = useState<string | null>(null);
  const sys = useAsync(api.system);
  const sweeps = useAsync(api.sweeps);
  const latest = sweeps.data?.find((s) => s.done_runs > 0);
  const detail = useAsync(() => (latest ? api.sweep(latest.id) : Promise.resolve(null)), [latest?.id]);
  const configs = useMemo(() => (detail.data ? aggregate(detail.data.runs) : []), [detail.data]);
  const pick = (k: "ttft_ms_p50" | "total_tps" | "cost_per_m_tokens", lower: boolean) => {
    const xs = configs.map((c) => c.m[k]?.mean).filter((v): v is number => v != null);
    return xs.length ? (lower ? Math.min(...xs) : Math.max(...xs)) : null;
  };
  const goals: [string, string][] = [
    ["Low latency (TTFT)", pick("ttft_ms_p50", true) != null ? `best ${fmt(pick("ttft_ms_p50", true), "ttft_ms_p50")} ms` : "measured"],
    ["High throughput", pick("total_tps", false) != null ? `best ${fmt(pick("total_tps", false), "total_tps")} tok/s` : "measured"],
    ["Hardware use", "threads sweep"],
    ["Multi-model", `${sys.data?.models.length ?? 0} quants · routed by gateway`],
    ["Cost per token", pick("cost_per_m_tokens", true) != null ? `$${fmt(pick("cost_per_m_tokens", true), "cost_per_m_tokens")} / 1M` : "with cloud price"],
  ];
  const node = NODES.find((n) => n.id === sel)!;
  const counts = (Object.keys(STATUS) as Status[]).map((s) => [s, NODES.filter((n) => n.id !== "goals" && n.status === s).length] as const);
  const [params, setParams] = useSearchParams();
  const view = params.get("view");
  const tab: "map" | "life" | "worker" = view === "life" || view === "worker" ? view : "map";
  const setTab = (k: "map" | "life" | "worker") => setParams(k === "map" ? {} : { view: k }, { replace: true });
  const panel = useRef<HTMLDivElement>(null);
  const choose = (id: string) => {
    setSel(id);
    const r = panel.current?.getBoundingClientRect();
    if (r && (r.top > window.innerHeight - 120 || r.bottom < 0)) panel.current!.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHead title="Architecture" sub="A reference LLM inference platform and how much of it this repo builds, then two zoomed-in views drawn from measured data: one request end to end, and the inside of a worker.">
        <div className="arch-legend">
          {counts.map(([s, n]) => <span key={s} className={`badge ${STATUS[s].cls}`}>{STATUS[s].icon}{STATUS[s].label} · {n}</span>)}
        </div>
      </PageHead>
      <div className="row" role="tablist" style={{ gap: 6, marginTop: -8 }}>
        {([["map", "Platform map"], ["life", "Request lifecycle"], ["worker", "Inside the worker"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`chip ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === "map" && (<>
      <div className="arch-wrap">
        <div className="card card-pad stack" style={{ gap: 14 }}>
          <div className="pm-goals" aria-label="What an inference platform is judged on">
            <button className={`pm-goals-title ${sel === "goals" ? "sel" : ""}`} onClick={() => choose("goals")}>Judged on</button>
            {goals.map(([a, b]) => <div key={a} className="pm-goal"><span>{a}</span><b>{b}</b></div>)}
          </div>
          <ol className="pm-path" aria-label="Path of one request">
            {PATH.map((p, i) => (
              <li key={p.id}>
                <button className={`${hover === p.id ? "hot" : ""} ${sel === p.id ? "sel" : ""}`} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(p.id)} onBlur={() => setHover(null)} onClick={() => choose(p.id)}>
                  <i>{i + 1}</i>{p.label}
                </button>
              </li>
            ))}
          </ol>
          <div className="pm-layers">
            {LAYERS.map((l, li) => (
              <section key={l.id} className="pm-layer">
                <header><span className="pm-ln">{li + 1}</span><div><b>{l.title}</b><small>{l.sub}</small></div></header>
                <div className="pm-cards">
                  {l.nodes.map((id) => {
                    const n = NODES.find((x) => x.id === id)!;
                    const st = STATUS[n.status];
                    return (
                      <button key={id} className={`pm-card s-${n.status} ${sel === id ? "sel" : ""} ${hover === id ? "hot" : ""}`} onClick={() => choose(id)}
                        onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} aria-label={`${n.title}: ${st.label}`}>
                        <span className="pm-top"><b>{n.title}</b>{STEP[id] && <i title={`Step ${STEP[id]} of a request`}>{STEP[id]}</i>}</span>
                        <span className="pm-lines">{n.lines.join(" · ")}</span>
                        <span className={`pm-status ${st.cls}`}>{st.icon}{st.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
          <p className="small muted" style={{ margin: 0 }}>Numbers follow one chat request through the gateway. Click any component for what it does in production and what this repo has for it.</p>
        </div>

        <div className="card arch-panel" ref={panel}>
          <div className="card-head">
            <h2>{node.title}</h2>
            {node.id !== "goals" && <span className={`badge ${STATUS[node.status].cls}`}>{STATUS[node.status].icon}{STATUS[node.status].label}</span>}
          </div>
          <div className="card-body stack" style={{ gap: 12 }}>
            {node.id === "goals" ? (
              <>
                <p className="secondary small" style={{ margin: 0 }}>Five things an inference platform is judged on, with what this repo measures for each{latest ? ` (from ${latest.label || latest.id})` : ""}.</p>
                <dl className="kv">{goals.map(([a, b]) => <Fragment key={a}><dt>{a}</dt><dd>{b}</dd></Fragment>)}</dl>
              </>
            ) : (
              <>
                <div><h3>In a production platform</h3><p className="secondary small" style={{ margin: "4px 0 0" }}>{node.role}</p></div>
                <div><h3>In this repo</h3><ul className="small">{node.here.map((h) => <li key={h}>{h}</li>)}</ul></div>
                {node.where && (
                  <div><h3>See it</h3>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}>
                      {node.where.map((w) => w.to ? <Link key={w.label} className="btn sm" to={w.to}>{w.label}</Link> : <code key={w.label} className="badge" style={{ textTransform: "none", fontWeight: 500 }}>{w.code}</code>)}
                    </div>
                  </div>
                )}
                {node.id === "workers" && sys.data && (
                  <div><h3>This machine</h3><p className="small secondary" style={{ margin: "4px 0 0" }}>{sys.data.machine.label} · {sys.data.machine.performance_cores}P + {sys.data.machine.efficiency_cores}E cores · {sys.data.machine.gpu ?? "no GPU"}</p></div>
                )}
              </>
            )}
            <p className="small muted" style={{ margin: 0 }}>Components marked "Out of scope" are named so the boundary of this project is explicit, not implied.</p>
          </div>
        </div>
      </div>
          <div className="card">
            <div className="card-head"><div><h2>Coverage</h2><p>Every component of the reference platform, what this repo does for it today, and what comes next.</p></div></div>
            <div className="card-body table-wrap">
              <table className="data">
                <thead><tr><th>Component</th><th>Status</th><th>In this repo</th></tr></thead>
                <tbody>
                  {NODES.filter((x) => x.id !== "goals").sort((a, b) => ORDER[a.status] - ORDER[b.status]).map((x) => (
                    <tr key={x.id} onClick={() => { setSel(x.id); window.scrollTo({ top: 0, behavior: "smooth" }); }} style={{ cursor: "pointer" }}>
                      <td style={{ fontWeight: 600 }}>{x.title}</td>
                      <td><span className={`badge ${STATUS[x.status].cls}`}>{STATUS[x.status].icon}{STATUS[x.status].label}</span></td>
                      <td className="secondary" style={{ whiteSpace: "normal" }}>{x.here.join(" ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
      </>)}
      {tab === "life" && <Lifecycle />}
      {tab === "worker" && <Worker />}
    </div>
  );
}
