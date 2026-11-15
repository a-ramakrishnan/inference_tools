import { ExternalLink, Send, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Legend } from "../components/Charts";
import { PageHead, Stat } from "../components/Layout";

// ---------------------------------------------------------------- types
interface BackendSnap {
  name: string; model: string; gguf: string; url: string; healthy: boolean; managed: boolean;
  active: number; waiting: number; max_concurrency: number; max_queue: number; slots: number;
  threads: number; gpu_layers: number; ctx_per_slot: number; served: number; rejected: number;
}
interface GwStatus {
  backends: BackendSnap[]; models: string[]; keys: string[]; long_prompt_chars: number; uptime_s: number;
  tracing: { enabled: boolean; endpoint: string | null; ui_url: string | null; error: string | null };
}
interface GwRow {
  id: string; trace_id: string; ts: number; key_name: string; model_requested: string; model: string; backend: string;
  route_reason: string; stream: number; status: string; http_status: number; prompt_tokens: number | null;
  completion_tokens: number | null; cached_tokens: number | null; queue_ms: number | null; ttft_ms: number | null;
  gen_ms: number | null; total_ms: number | null; decode_tps: number | null; tag: string | null; error: string | null;
}
interface UsageRow {
  grp: string; requests: number; ok: number; rejected: number; errors: number; prompt_tokens: number;
  completion_tokens: number; cached_tokens: number; ttft_ms_mean: number | null; ttft_ms_p95: number | null; queue_ms_mean: number | null;
}

const GW = "/api/gateway";
const PHASE = {
  queue: { label: "Queue wait", color: "var(--series-4)" },
  prefill: { label: "Prefill (to first token)", color: "var(--series-2)" },
  decode: { label: "Decode", color: "var(--series-1)" },
};
const ms = (v: number | null | undefined) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const DEMO_KEYS: Record<string, string> = { demo: "sk-ibench-demo", agent: "sk-ibench-agent", batch: "sk-ibench-batch" };

// ---------------------------------------------------------------- live data
function useGateway() {
  const [status, setStatus] = useState<GwStatus | null>(null);
  const [rows, setRows] = useState<GwRow[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    fetch(`${GW}/gateway/requests?limit=100`).then((r) => (r.ok ? r.json() : [])).then(setRows).catch(() => {});
    const es = new EventSource(`${GW}/gateway/events`);
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === "status") { setStatus(ev.data); setOnline(true); }
      if (ev.type === "request_done") setRows((rs) => [ev.data, ...rs.filter((r) => r.id !== ev.data.id)].slice(0, 500));
    };
    return () => es.close();
  }, []);
  return { status, rows, online };
}

function Meter({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div>
      <div className="row small" style={{ justifyContent: "space-between" }}><span className="secondary">{label}</span><b className="mono">{value}/{max}</b></div>
      <div className="bar" style={{ marginTop: 4 }}><div style={{ width: `${Math.min(100, (100 * value) / Math.max(1, max))}%`, background: color }} /></div>
    </div>
  );
}

function Waterfall({ r, scale }: { r: GwRow; scale: number }) {
  const q = r.queue_ms ?? 0;
  const pre = Math.max(0, (r.ttft_ms ?? q) - q);
  const dec = r.gen_ms ?? 0;
  const w = (v: number) => `${(100 * v) / Math.max(1, scale)}%`;
  return (
    <div style={{ display: "flex", height: 10, width: 160, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden", gap: 1 }}
      title={`queue ${ms(q)} · prefill ${ms(pre)} · decode ${ms(dec)}`}>
      <div style={{ width: w(q), background: PHASE.queue.color }} />
      <div style={{ width: w(pre), background: PHASE.prefill.color }} />
      <div style={{ width: w(dec), background: PHASE.decode.color }} />
    </div>
  );
}

function StatusPill({ s, code }: { s: string; code: number }) {
  const cls = s === "ok" ? "good" : s === "rejected" ? "warn" : "crit";
  return <span className={`badge ${cls}`}>{s === "ok" ? code : `${code} ${s}`}</span>;
}

// ---------------------------------------------------------------- playground
function Playground({ status }: { status: GwStatus | null }) {
  const [key, setKey] = useState("sk-ibench-demo");
  const [model, setModel] = useState("auto");
  const [prompt, setPrompt] = useState("Explain in three sentences why token generation on a CPU is limited by memory bandwidth.");
  const [maxTokens, setMaxTokens] = useState(160);
  const [out, setOut] = useState("");
  const [m, setM] = useState<{ backend?: string; route?: string; id?: string; ttft?: number; total?: number; tokens?: number; usage?: any; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const send = async () => {
    setBusy(true); setOut(""); setM(null);
    abort.current = new AbortController();
    const t0 = performance.now();
    let first: number | null = null, n = 0, usage: any = null;
    try {
      const r = await fetch(`${GW}/v1/chat/completions`, {
        method: "POST", signal: abort.current.signal,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-ibench-tag": "playground" },
        body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: prompt }] }),
      });
      const meta = { backend: r.headers.get("x-ibench-backend") ?? undefined, route: r.headers.get("x-ibench-route") ?? undefined, id: r.headers.get("x-request-id") ?? undefined };
      if (!r.ok || !r.body) {
        const body = await r.json().catch(() => ({}));
        setM({ ...meta, error: `${r.status}: ${body?.error?.message ?? body?.detail ?? r.statusText}` });
        return;
      }
      setM(meta);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const line = p.trim();
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          const chunk = JSON.parse(line.slice(6));
          if (chunk.usage) usage = chunk.usage;
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) {
            if (first == null) first = performance.now();
            n++;
            setOut((o) => o + text);
            setM((x) => ({ ...x, ttft: first! - t0, tokens: n }));
          }
        }
      }
      setM((x) => ({ ...x, ttft: first != null ? first - t0 : undefined, total: performance.now() - t0, tokens: usage?.completion_tokens ?? n, usage }));
    } catch (e: any) {
      if (e.name !== "AbortError") setM((x) => ({ ...x, error: String(e.message ?? e) }));
    } finally {
      setBusy(false);
    }
  };

  const tps = m?.total && m?.ttft && m.tokens && m.tokens > 1 ? (m.tokens - 1) / ((m.total - m.ttft) / 1000) : null;
  return (
    <div className="card">
      <div className="card-head"><div><h2>Playground</h2><p>A streaming request through the gateway, exactly as an OpenAI SDK would send it. Times are measured in this browser.</p></div></div>
      <div className="card-body stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
          <label className="field">API key
            <select value={key} onChange={(e) => setKey(e.target.value)}>
              {Object.entries(DEMO_KEYS).map(([n, k]) => <option key={k} value={k}>{n} · {k}</option>)}
              <option value="sk-wrong">invalid key (401)</option>
            </select>
          </label>
          <label className="field">Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {(status?.models ?? ["auto", "qwen-fast", "qwen-quality"]).map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label className="field">Max tokens<input type="number" min={1} max={2048} value={maxTokens} onChange={(e) => setMaxTokens(+e.target.value)} style={{ width: 100 }} /></label>
          <span className="spacer" />
          {busy ? <button className="btn" onClick={() => abort.current?.abort()}>Stop</button>
            : <button className="btn primary" onClick={send}><Send size={14} />Send</button>}
        </div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
          style={{ font: "inherit", width: "100%", padding: 10, borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--surface-1)", color: "var(--text-primary)", resize: "vertical" }} />
        <div className="log" style={{ minHeight: 90, whiteSpace: "pre-wrap", fontFamily: "var(--sans)", fontSize: 13.5, color: "var(--text-primary)" }}>
          {out || <span className="muted">{busy ? "Waiting for the first token…" : "The streamed answer appears here."}</span>}
        </div>
        {m && (
          <div className="row small" style={{ gap: 14 }}>
            {m.error ? <span style={{ color: "var(--critical)" }}>{m.error}</span> : null}
            {m.backend && <span>backend <b>{m.backend}</b></span>}
            {m.route && <span className="muted">{m.route}</span>}
            {m.ttft != null && <span>TTFT <b>{ms(m.ttft)}</b></span>}
            {m.total != null && <span>total <b>{ms(m.total)}</b></span>}
            {m.tokens != null && <span><b>{m.tokens}</b> tokens</span>}
            {tps && <span><b>{tps.toFixed(1)}</b> tok/s</span>}
            {m.usage && <span className="muted">{m.usage.prompt_tokens} prompt tokens</span>}
            {m.id && <span className="mono muted">{m.id}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- traffic generator
function Traffic({ rows, status }: { rows: GwRow[]; status: GwStatus | null }) {
  const [n, setN] = useState(30);
  const [model, setModel] = useState("qwen-fast");
  const [chars, setChars] = useState(400);
  const [maxTokens, setMaxTokens] = useState(64);
  const [tag, setTag] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mine = useMemo(() => rows.filter((r) => r.tag === tag).sort((a, b) => a.ts - b.ts), [rows, tag]);
  const start = async () => {
    setErr(null);
    const r = await fetch("/api/gateway-load", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: n, model, key: DEMO_KEYS.batch, prompt_chars: chars, max_tokens: maxTokens }) });
    const body = await r.json();
    if (!r.ok) setErr(body.detail ?? r.statusText); else setTag(body.tag);
  };
  const ok = mine.filter((r) => r.status === "ok");
  const rejected = mine.filter((r) => r.status === "rejected").length;
  const b = status?.backends.find((x) => x.model === model || x.name === model);
  const lanes = ok.map((r, i) => {
    const q = r.queue_ms ?? 0;
    return { name: `${i + 1}`, queue: q, prefill: Math.max(0, (r.ttft_ms ?? q) - q), decode: r.gen_ms ?? 0, r };
  }).sort((a, b) => a.queue - b.queue).map((x, i) => ({ ...x, name: `${i + 1}` }));

  return (
    <div className="card">
      <div className="card-head"><div><h2>Traffic generator</h2><p>Fires N requests at the same moment with the <b>batch</b> key. The gateway admits {b ? b.max_concurrency : "N"} at a time to this backend, queues up to {b ? b.max_queue : "M"} more, and rejects the rest with 429.</p></div></div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
          <label className="field">Requests<input type="number" min={1} max={200} value={n} onChange={(e) => setN(+e.target.value)} style={{ width: 90 }} /></label>
          <label className="field">Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>{(status?.models ?? ["qwen-fast"]).map((x) => <option key={x}>{x}</option>)}</select>
          </label>
          <label className="field">Prompt, characters<input type="number" min={20} max={40000} step={100} value={chars} onChange={(e) => setChars(+e.target.value)} style={{ width: 120 }} /></label>
          <label className="field">Max tokens<input type="number" min={1} max={1024} value={maxTokens} onChange={(e) => setMaxTokens(+e.target.value)} style={{ width: 100 }} /></label>
          <span className="spacer" />
          <button className="btn primary" onClick={start} disabled={!status}><Zap size={14} />Send burst</button>
        </div>
        {err && <div className="small" style={{ color: "var(--critical)" }}>{err}</div>}
        {tag && (
          <>
            <div className="row small" style={{ gap: 16 }}>
              <span>finished <b>{mine.length}</b> / {n}</span>
              <span className="badge good">{ok.length} served</span>
              {rejected > 0 && <span className="badge warn">{rejected} rejected (429)</span>}
              {ok.length > 0 && <span>queue wait up to <b>{ms(Math.max(...ok.map((r) => r.queue_ms ?? 0)))}</b></span>}
              {ok.length > 0 && <span>TTFT p50 <b>{ms([...ok].sort((a, b) => (a.ttft_ms ?? 0) - (b.ttft_ms ?? 0))[Math.floor(ok.length / 2)].ttft_ms)}</b></span>}
            </div>
            {lanes.length > 0 && (
              <>
                <Legend items={Object.values(PHASE)} />
                <ResponsiveContainer width="100%" height={Math.max(160, lanes.length * 14 + 50)}>
                  <BarChart data={lanes} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 0 }} barCategoryGap={1}>
                    <CartesianGrid horizontal={false} stroke="var(--grid)" />
                    <XAxis type="number" stroke="var(--border-strong)" tickLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(1)}s`} />
                    <YAxis type="category" dataKey="name" stroke="var(--border-strong)" tickLine={false} width={28} interval={lanes.length > 20 ? 4 : 0} />
                    <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const p = payload[0].payload;
                      return (
                        <div className="tooltip">
                          <div className="t-title">Request {p.r.id.slice(0, 12)}…</div>
                          {(["queue", "prefill", "decode"] as const).map((k) => <div className="t-row" key={k}><span><i style={{ background: PHASE[k].color }} />{PHASE[k].label}</span><b>{ms(p[k])}</b></div>)}
                          <div className="t-row"><span>Tokens</span><b>{p.r.prompt_tokens} in · {p.r.completion_tokens} out</b></div>
                        </div>
                      );
                    }} />
                    <Bar dataKey="queue" stackId="a" fill={PHASE.queue.color} isAnimationActive={false} />
                    <Bar dataKey="prefill" stackId="a" fill={PHASE.prefill.color} isAnimationActive={false} />
                    <Bar dataKey="decode" stackId="a" fill={PHASE.decode.color} radius={[0, 3, 3, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="small muted">Sorted by queue wait: the staircase is the concurrency limit letting requests through {b?.max_concurrency ?? ""} at a time.</div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- usage report
function Usage({ refreshKey }: { refreshKey: number }) {
  const [group, setGroup] = useState("key_name");
  const [rows, setRows] = useState<UsageRow[]>([]);
  useEffect(() => {
    fetch(`${GW}/gateway/usage?group=${group}`).then((r) => (r.ok ? r.json() : [])).then(setRows).catch(() => {});
  }, [group, refreshKey]);
  const label = { key_name: "API key", model: "Model", backend: "Backend", day: "Day" }[group];
  return (
    <div className="card">
      <div className="card-head">
        <div><h2>Usage report</h2><p>Every request is metered: input and output tokens per {group === "key_name" ? "API key" : label?.toLowerCase()}, from the backend's own counts.</p></div>
        <div className="row">
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="key_name">by API key</option><option value="model">by model</option><option value="backend">by backend</option><option value="day">by day</option>
          </select>
          <a className="btn sm" href={`${GW}/gateway/usage.csv`}>usage.csv</a>
        </div>
      </div>
      <div className="card-body stack" style={{ gap: 16 }}>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{label}</th><th className="num">Requests</th><th className="num">429</th><th className="num">Errors</th><th className="num">Input tok</th><th className="num">Output tok</th><th className="num">Cached</th><th className="num">TTFT p95</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.grp}>
                  <td><b>{r.grp}</b></td><td className="num">{r.requests}</td><td className="num">{r.rejected || "–"}</td><td className="num">{r.errors || "–"}</td>
                  <td className="num">{r.prompt_tokens.toLocaleString()}</td><td className="num">{r.completion_tokens.toLocaleString()}</td>
                  <td className="num">{r.cached_tokens ? r.cached_tokens.toLocaleString() : "–"}</td><td className="num">{ms(r.ttft_ms_p95)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8} className="muted">No requests yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <div>
          <Legend items={[{ label: "Input tokens", color: "var(--series-1)" }, { label: "Output tokens", color: "var(--series-2)" }]} />
          <ResponsiveContainer width="100%" height={Math.max(140, rows.length * 44 + 40)}>
            <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barGap={2}>
              <CartesianGrid horizontal={false} stroke="var(--grid)" />
              <XAxis type="number" stroke="var(--border-strong)" tickLine={false} />
              <YAxis type="category" dataKey="grp" stroke="var(--border-strong)" tickLine={false} width={90} />
              <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as UsageRow;
                return <div className="tooltip"><div className="t-title">{p.grp}</div>
                  <div className="t-row"><span><i style={{ background: "var(--series-1)" }} />Input</span><b>{p.prompt_tokens.toLocaleString()}</b></div>
                  <div className="t-row"><span><i style={{ background: "var(--series-2)" }} />Output</span><b>{p.completion_tokens.toLocaleString()}</b></div></div>;
              }} />
              <Bar dataKey="prompt_tokens" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={false} />
              <Bar dataKey="completion_tokens" fill="var(--series-2)" radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page
export default function Gateway() {
  const { status, rows, online } = useGateway();
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setTimeout(() => setTick((x) => x + 1), 800); return () => clearTimeout(t); }, [rows.length]);
  const scale = Math.max(1, ...rows.slice(0, 50).map((r) => r.total_ms ?? 0));
  const ok = rows.filter((r) => r.status === "ok");
  const tr = status?.tracing;

  if (online === false && !status) {
    return (
      <div className="stack">
        <PageHead title="Gateway" />
        <div className="card empty">
          <h2>Gateway offline</h2>
          <p>Start it in another terminal: <code>ibench gateway</code> (starts both llama.cpp backends) or <code>docker compose up --build</code>.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHead title="Gateway" sub={<>One OpenAI-compatible endpoint, <code>http://127.0.0.1:8080/v1</code>, in front of {status?.backends.length ?? "two"} llama.cpp servers: API keys, routing by model name or prompt length, a bounded queue per backend, per-key usage and a trace for every request.</>}>
        <span className={`badge ${online ? "good" : "crit"}`}>{online ? "online" : "offline"}</span>
        {tr?.enabled && tr.ui_url ? <a className="btn" href={tr.ui_url} target="_blank" rel="noreferrer"><ExternalLink size={14} />Traces (Jaeger)</a>
          : <span className="badge" title={tr?.error ?? "set [tracing] otlp_endpoint in gateway.toml"}>traces: SQLite only</span>}
      </PageHead>

      <div className="grid g4">
        <Stat label="Requests (last 500)" value={rows.length} sub={`${ok.length} ok · ${rows.filter((r) => r.status === "rejected").length} rejected · ${rows.filter((r) => !["ok", "rejected"].includes(r.status)).length} errors`} />
        <Stat label="TTFT p50" value={ok.length ? ms([...ok].sort((a, b) => (a.ttft_ms ?? 0) - (b.ttft_ms ?? 0))[Math.floor(ok.length / 2)].ttft_ms) : "–"} sub="request in → first token out, at the gateway" />
        <Stat label="Queue wait p95" value={ok.length ? ms([...ok].sort((a, b) => (a.queue_ms ?? 0) - (b.queue_ms ?? 0))[Math.floor(ok.length * 0.95)].queue_ms) : "–"} sub="time waiting for a backend slot" />
        <Stat label="Output tokens" value={ok.reduce((a, r) => a + (r.completion_tokens ?? 0), 0).toLocaleString()} sub={`${ok.reduce((a, r) => a + (r.prompt_tokens ?? 0), 0).toLocaleString()} input tokens`} />
      </div>

      <div className="grid g2">
        {status?.backends.map((b) => (
          <div className="card card-pad stack" key={b.name} style={{ gap: 10 }}>
            <div className="row">
              <h2>{b.name}</h2><span className="muted small mono">{b.model}</span><span className="spacer" />
              <span className={`badge ${b.healthy ? "good" : "crit"}`}>{b.healthy ? "healthy" : "down"}</span>
            </div>
            <div className="small secondary">{b.gguf || "external"} · {b.gpu_layers > 0 ? "GPU" : `CPU, ${b.threads} threads`} · {b.slots} llama.cpp slots × {b.ctx_per_slot.toLocaleString()} tokens · <span className="mono">{b.url}</span></div>
            <div className="grid g2" style={{ gap: 12 }}>
              <Meter label="In flight" value={b.active} max={b.max_concurrency} color="var(--series-1)" />
              <Meter label="Waiting in queue" value={b.waiting} max={b.max_queue} color="var(--series-4)" />
            </div>
            <div className="small muted">{b.served} served · {b.rejected} rejected since start</div>
          </div>
        ))}
      </div>

      <div className="grid g2" style={{ alignItems: "start" }}>
        <Playground status={status} />
        <Traffic rows={rows} status={status} />
      </div>

      <div className="card">
        <div className="card-head">
          <div><h2>Request log</h2><p>The latest requests, live. Each bar is one request: queue wait, then prefill, then decode, on a shared time scale.</p></div>
          <Legend items={Object.values(PHASE)} />
        </div>
        <div className="card-body table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table className="data">
            <thead><tr><th>Time</th><th>Key</th><th>Model → backend</th><th>Route</th><th>Status</th><th className="num">In</th><th className="num">Out</th><th className="num">Queue</th><th className="num">TTFT</th><th className="num">Total</th><th>Timeline</th><th>Trace</th></tr></thead>
            <tbody>
              {rows.slice(0, 100).map((r) => (
                <tr key={r.id}>
                  <td className="muted">{new Date(r.ts * 1000).toLocaleTimeString()}</td>
                  <td>{r.key_name}</td>
                  <td>{r.model_requested} → <b>{r.backend}</b></td>
                  <td className="muted small">{r.route_reason}</td>
                  <td><StatusPill s={r.status} code={r.http_status} /></td>
                  <td className="num">{r.prompt_tokens ?? "–"}</td><td className="num">{r.completion_tokens ?? "–"}</td>
                  <td className="num">{ms(r.queue_ms)}</td><td className="num">{ms(r.ttft_ms)}</td><td className="num">{ms(r.total_ms)}</td>
                  <td><Waterfall r={r} scale={scale} /></td>
                  <td className="mono small">{tr?.enabled && tr.ui_url ? <a href={`${tr.ui_url}/trace/${r.trace_id}`} target="_blank" rel="noreferrer">{r.trace_id.slice(0, 8)}</a> : <span className="muted">{r.trace_id?.slice(0, 8)}</span>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={12} className="muted">No requests yet. Send one from the playground.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Usage refreshKey={tick} />
    </div>
  );
}
