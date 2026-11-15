import { CheckCircle2, CircleDashed, CircleDot, CircleSlash } from "lucide-react";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { aggregate, fmt } from "../agg";
import { api } from "../api";
import { PageHead } from "../components/Layout";
import { useAsync } from "../hooks";
import { useLive } from "../live";
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
  x: number; y: number; w: number; h: number;
  shape?: "db";
  role: string;              // what the component does in a production platform
  here: string[];            // how this repo covers it
  where?: { label: string; to?: string; code?: string }[];
}

const NODES: Node[] = [
  { id: "client", title: "Client apps", lines: ["ibench load generator", "N concurrent streams"], status: "built", x: 20, y: 60, w: 170, h: 90,
    role: "Applications calling the platform through an SDK or REST, usually streaming.",
    here: ["The load generator sends N streaming requests at once, each with its own prompt of an exact token length.", "Every request produces exactly the requested number of tokens (ignore_eos), so runs are comparable.", "The dashboard is a second client: it drives sweeps and watches them live."],
    where: [{ label: "ibench/loadgen.py", code: "ibench/loadgen.py" }, { label: "ibench/prompts.py", code: "ibench/prompts.py" }, { label: "New sweep page", to: "/run" }] },
  { id: "lb", title: "Global load balancer", lines: ["single machine"], status: "out", x: 205, y: 70, w: 192, h: 70,
    role: "Spreads traffic across regions and clusters; health-checks and fails over.",
    here: ["Not built: everything runs on one machine. Results from several machines are compared offline instead."] },
  { id: "gateway", title: "Inference API gateway", lines: ["OpenAI-compatible", "/v1/chat/completions", "streaming pass-through"], status: "built", x: 430, y: 40, w: 290, h: 150,
    role: "The one public entry point: OpenAI-style endpoints, authentication, rate limits, request validation.",
    here: ["One OpenAI-compatible endpoint (/v1/chat/completions, /v1/models) in front of two llama.cpp servers; streaming responses pass straight through.", "The benchmark load generator still calls llama-server's /completion directly, so the gateway's overhead never enters the engine measurements.", "Docker Compose runs the two servers, the gateway and Jaeger together; on a Mac the containers use the CPU only, so the native gateway with Metal is several times faster."],
    where: [{ label: "ibench/gateway/app.py", code: "ibench/gateway/app.py" }, { label: "Gateway page", to: "/gateway" }] },
  { id: "goals", title: "Core goals", lines: [], status: "built", x: 930, y: 30, w: 290, h: 180,
    role: "What an inference platform is judged on.", here: [] },
  { id: "auth", title: "Auth & usage metering", lines: ["API keys from a config file", "tokens per key"], status: "built", x: 15, y: 240, w: 215, h: 100,
    role: "Validates API keys, enforces tiers and quotas, meters usage per key.",
    here: ["Bearer API keys read from gateway.toml (or an environment variable); an unknown key gets 401.", "Every request, including rejected ones, writes a usage row: key, model, backend, input/output/cached tokens and timings.", "Quotas, tiers and user management are out of scope."],
    where: [{ label: "gateway.toml", code: "gateway.toml" }, { label: "Usage report", to: "/gateway" }] },
  { id: "store", title: "Usage store", lines: ["SQLite (Postgres in prod)"], status: "built", x: 20, y: 395, w: 200, h: 95, shape: "db",
    role: "System of record for accounts, keys and usage.",
    here: ["A SQLite requests table written by the gateway (gateway-data/usage.db), grouped into usage by key, model, backend or day and exported as CSV."],
    where: [{ label: "ibench/gateway/store.py", code: "ibench/gateway/store.py" }] },
  { id: "router", title: "Model router", lines: ["by model name", "or prompt length"], status: "built", x: 255, y: 300, w: 175, h: 130,
    role: "Chooses a model and backend for each request: by model, region, canary version or fallback.",
    here: ["Routes by the requested model name (qwen-fast → 4-bit backend, qwen-quality → 8-bit backend).", "model=auto routes by prompt length: an estimate of characters ÷ 4 against a threshold sends long prompts to the backend with the larger context. The reason is recorded on every request.", "Learned or cost-optimized routing is out of scope."],
    where: [{ label: "ibench/gateway/app.py", code: "ibench/gateway/app.py" }] },
  { id: "scheduler", title: "Request queue", lines: ["bounded queue", "per-backend limit", "429 when full"], status: "built", x: 455, y: 300, w: 190, h: 130,
    role: "Admission control: priority tiers, fair sharing, separate prefill and decode queues, shedding load.",
    here: ["Each backend has a concurrency limit (matching its llama.cpp slots) and a bounded wait queue; once the queue is full, the gateway answers 429 instead of letting latency grow without bound.", "Queue wait is recorded per request. A 30-request burst against the fast backend (4 running, 16 waiting) served 20 and rejected 10, with waits stepping up four at a time.", "Priority tiers and separate prefill/decode queues are out of scope."],
    where: [{ label: "Traffic generator", to: "/gateway" }, { label: "ibench/gateway/app.py", code: "ibench/gateway/app.py" }] },
  { id: "engine", title: "Continuous batching", lines: ["llama.cpp server", "slots share each step"], status: "built", x: 670, y: 300, w: 185, h: 130,
    role: "Batches tokens from many requests into each forward pass, so throughput grows with load.",
    here: ["llama.cpp's server batches all active slots into every decode step (continuous batching).", "The concurrency sweep (1, 4, 8) shows the trade: total tokens/s rises while each request slows down.", "Paged attention and speculative decoding are not used."],
    where: [{ label: "Total throughput chart", to: "/results" }] },
  { id: "workers", title: "Worker pool", lines: ["llama-server processes", "CPU (Arm, x86) or Metal", "restarted per config"], status: "built", x: 880, y: 250, w: 190, h: 200,
    role: "The accelerators that run the model, with sharding, health checks and model loading.",
    here: ["One llama-server process per configuration, started with the exact threads, slots and GPU layers under test, health-checked before use.", "The same CLI runs on an Apple Silicon laptop, an x86 instance, a Graviton instance or Colab, so the CPUs can be compared."],
    where: [{ label: "ibench/server.py", code: "ibench/server.py" }, { label: "Compare machines", to: "/compare" }] },
  { id: "kv", title: "KV cache", lines: ["per slot, sized", "prompt + output", "prefix cache off"], status: "partial", x: 1090, y: 260, w: 140, h: 120,
    role: "Keeps attention keys and values so earlier tokens aren't recomputed; prefix caching reuses shared prompts.",
    here: ["Each slot gets a KV cache sized for the longest prompt plus output; its cost shows in peak memory as concurrency rises.", "Prefix caching is deliberately off in the benchmark (cache_prompt: false), so every request pays for its prompt.", "Next: agent-style traffic with a growing context, with and without prompt caching."] },
  { id: "registry", title: "Model registry", lines: ["models/*.gguf", "Q4_K_M · Q8_0"], status: "built", x: 1060, y: 480, w: 170, h: 110, shape: "db",
    role: "Stores weights, checkpoints and quantized variants; workers load from it.",
    here: ["models/ holds Qwen2.5-1.5B-Instruct in two quantizations, 4-bit (Q4_K_M) and 8-bit (Q8_0).", "Weights are loaded without mmap so the memory measurement includes them."],
    where: [{ label: "Overview: models", to: "/" }] },
  { id: "streaming", title: "Streaming responses", lines: ["SSE token stream", "TTFT = first chunk"], status: "built", x: 20, y: 610, w: 190, h: 100,
    role: "Streams tokens back as server-sent events; handles stop sequences.",
    here: ["Every request streams; time to first token is taken when the first token arrives at the client.", "The dashboard's live view is also an SSE stream from the backend."],
    where: [{ label: "Live page", to: "/live" }] },
  { id: "autoscaler", title: "Autoscaler", lines: ["fixed capacity"], status: "out", x: 240, y: 610, w: 180, h: 100,
    role: "Adds and removes workers on queue depth or utilization; scales cold models to zero.",
    here: ["Not built. Kubernetes and autoscaling are out of scope."] },
  { id: "monitoring", title: "Monitoring", lines: ["TTFT · tok/s · memory", "per-request timelines", "OpenTelemetry traces"], status: "built", x: 450, y: 600, w: 215, h: 130,
    role: "Metrics, traces and alerts: TTFT, tokens/s, accelerator memory, queue wait, errors.",
    here: ["Every run records TTFT, tokens/s per request and in total, prompt speed, peak memory and errors to CSV, with one row per request too.", "The dashboard charts them live and after the fact.", "The gateway records an OpenTelemetry trace per request (queue wait, prefill, decode spans) and exports it over OTLP; under Docker Compose they appear in Jaeger, linked from the Gateway page. Dashboards and alerting are out of scope."],
    where: [{ label: "Results", to: "/results" }, { label: "ibench/sweep.py", code: "ibench/sweep.py" }] },
  { id: "billing", title: "Usage & cost", lines: ["$ per 1M output tokens", "tokens per API key"], status: "partial", x: 695, y: 620, w: 195, h: 100,
    role: "Input and output tokens per request, cost per request, billing.",
    here: ["Given an instance price, each run reports cost per million output tokens (price ÷ total throughput).", "The gateway reports input, output and cached tokens per API key, model, backend or day. Billing is out of scope."],
    where: [{ label: "Usage report", to: "/gateway" }] },
  { id: "warehouse", title: "Data warehouse", lines: ["CSV in results/"], status: "out", x: 920, y: 640, w: 170, h: 80,
    role: "Long-term store for usage and performance analytics.",
    here: ["Not built: results/<sweep>/*.csv files stand in, and are committed with the repo."] },
];

const EDGES: { from: [number, number]; to: [number, number]; label?: string; labelAt?: [number, number]; flow?: boolean; both?: boolean; via?: [number, number][] }[] = [
  { from: [190, 105], to: [205, 105], flow: true },
  { from: [397, 105], to: [430, 105], flow: true },
  { from: [575, 190], to: [575, 230], via: [[575, 230], [342, 230]], flow: true },
  { from: [342, 230], to: [342, 300], flow: true },
  { from: [430, 365], to: [455, 365], flow: true },
  { from: [645, 365], to: [670, 365], flow: true },
  { from: [855, 365], to: [880, 365], flow: true },
  { from: [1070, 320], to: [1090, 320], both: true },
  { from: [1145, 480], to: [1145, 380], via: [[1145, 380]], label: "load weights" },
  { from: [430, 120], to: [220, 270], via: [[300, 120], [300, 270]], both: true },
  { from: [120, 340], to: [120, 395], both: true },
  { from: [105, 150], to: [105, 230], both: false },
  { from: [20, 130], to: [20, 660], via: [[6, 130], [6, 660]], label: "stream tokens", labelAt: [1, 600], flow: true },
  { from: [330, 610], to: [330, 560], via: [[330, 560], [975, 560], [975, 450]] },
  { from: [890, 670], to: [920, 670] },
];

function path(e: (typeof EDGES)[number]) {
  const pts = [e.from, ...(e.via ?? []), e.to];
  return pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
}

export default function Architecture() {
  const live = useLive();
  const [sel, setSel] = useState<string>("workers");
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
  const running = live.status === "running";
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
        <div className="card card-pad arch-scroll">
          <svg className="arch-svg" viewBox="-22 0 1272 750" role="img" aria-label="Inference platform architecture diagram">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--text-muted)" />
              </marker>
            </defs>
            <style>{`
              .edge { fill: none; stroke: var(--text-muted); stroke-width: 1.5; }
              .edge.flowing { stroke: var(--accent); stroke-dasharray: 6 6; animation: flow 0.9s linear infinite; }
              @keyframes flow { to { stroke-dashoffset: -12; } }
              @media (prefers-reduced-motion: reduce) { .edge.flowing { animation: none; } }
              .n-title { font: 600 16px var(--sans); }
              .n-line { font: 13.5px var(--sans); fill: var(--text-secondary); }
              .n-badge { font: 700 10.5px var(--sans); letter-spacing: 0.05em; text-transform: uppercase; }
              .e-label { font: italic 12px var(--sans); fill: var(--text-muted); }
            `}</style>
            {EDGES.map((e, i) => (
              <g key={i}>
                <path d={path(e)} className={`edge ${running && e.flow ? "flowing" : ""}`} markerEnd="url(#arrow)" markerStart={e.both ? "url(#arrow)" : undefined} />
                {e.label && (e.labelAt
                  ? <text className="e-label" x={e.labelAt[0]} y={e.labelAt[1]} transform={`rotate(-90 ${e.labelAt[0]} ${e.labelAt[1]})`}>{e.label}</text>
                  : <text className="e-label" x={(e.from[0] + (e.via?.[0]?.[0] ?? e.to[0])) / 2 + 8} y={(e.from[1] + e.to[1]) / 2}>{e.label}</text>)}
              </g>
            ))}
            {NODES.map((n) => {
              const st = STATUS[n.status];
              const isGoals = n.id === "goals";
              return (
                <g key={n.id} className={`arch-node ${sel === n.id ? "sel" : ""}`} tabIndex={0} role="button" aria-label={`${n.title}: ${st.label}`}
                  onClick={() => choose(n.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && choose(n.id)}>
                  {n.shape === "db" ? (
                    <>
                      <rect className="box" x={n.x} y={n.y + 10} width={n.w} height={n.h - 10} rx={6} fill={st.fill} stroke={st.stroke} strokeWidth={1.5} strokeDasharray={st.dash} />
                      <ellipse cx={n.x + n.w / 2} cy={n.y + 10} rx={n.w / 2} ry={10} fill={st.fill} stroke={st.stroke} strokeWidth={1.5} strokeDasharray={st.dash} />
                    </>
                  ) : (
                    <rect className="box" x={n.x} y={n.y} width={n.w} height={n.h} rx={12} fill={isGoals ? "var(--surface-1)" : st.fill}
                      stroke={isGoals ? "var(--series-7, #6250d6)" : st.stroke} strokeWidth={1.5} strokeDasharray={isGoals ? "6 4" : st.dash} />
                  )}
                  <text className="n-title" x={n.x + 14} y={n.y + (n.shape === "db" ? 40 : 26)} fill={st.text}>{n.title}</text>
                  {!isGoals && (
                    <text className="n-badge" x={n.x + n.w - 10} y={n.y + n.h - 10} textAnchor="end" fill={n.status === "out" ? "var(--text-muted)" : n.status === "next" ? "var(--text-secondary)" : st.stroke === "var(--good)" ? "var(--good-text)" : st.stroke}>
                      {st.label}
                    </text>
                  )}
                  {(isGoals ? goals.map(([a, b]) => `${a}: ${b}`) : n.lines).map((l, i) => (
                    <text key={i} className="n-line" style={isGoals ? { fontSize: 13 } : undefined} x={n.x + 14} y={n.y + (n.shape === "db" ? 62 : 50) + i * 19}>{isGoals ? "• " : ""}{l}</text>
                  ))}
                </g>
              );
            })}
          </svg>
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
            <p className="small muted" style={{ margin: 0 }}>The diagram follows a common reference layout for LLM serving. Boxes marked "Out of scope" are named so the boundary of this project is explicit, not implied.</p>
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
