import { Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Legend } from "../components/Charts";
import { PageHead, Stat, StatusBadge } from "../components/Layout";

interface Row {
  condition: "agent-cache" | "agent-nocache" | "chat"; mode: string; cache: string; sessions: number; session: number; turn: number;
  ok: number; error: string | null; prompt_tokens: number | null; cached_tokens: number | null; computed_tokens: number | null;
  completion_tokens: number | null; queue_ms: number | null; ttft_ms: number | null; total_ms: number | null; decode_tps: number | null;
  server_prompt_ms: number | null; tool_call: number; tool_name: string | null; t_start: number; t_end: number;
}
interface Meta {
  id: string; label: string; status: string; started: string; duration_s?: number; total: number; done?: number;
  spec: { model: string; sessions: number[]; turns: number; tool_tokens: number; system_tokens: number; conditions: string[] };
}

const COND = {
  "agent-cache": { label: "Agent, prompt cache on", color: "var(--series-1)" },
  "agent-nocache": { label: "Agent, prompt cache off", color: "var(--series-2)" },
  chat: { label: "Chat", color: "var(--series-3)" },
} as const;
type Cond = keyof typeof COND;

const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const pct = (xs: number[], q: number) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
const ms = (v: number | null | undefined) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const nums = (rows: Row[], k: keyof Row) => rows.map((r) => r[k] as number).filter((v) => v != null) as number[];

function TT({ active, payload, label, fmt, title }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="t-title">{title ? title(label) : label}</div>
      {payload.map((p: any) => <div className="t-row" key={p.dataKey}><span><i style={{ background: p.color || p.fill }} />{p.name}</span><b>{fmt(p.value)}</b></div>)}
    </div>
  );
}

function Controls({ busy, onStart }: { busy: boolean; onStart: (body: object) => void }) {
  const [sessions, setSessions] = useState("1,4,8");
  const [turns, setTurns] = useState(8);
  const [toolTokens, setToolTokens] = useState(250);
  return (
    <div className="card card-pad">
      <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
        <label className="field">Concurrent sessions<input type="text" value={sessions} onChange={(e) => setSessions(e.target.value)} style={{ width: 110 }} /></label>
        <label className="field">Turns per session<input type="number" min={1} max={30} value={turns} onChange={(e) => setTurns(+e.target.value)} style={{ width: 90 }} /></label>
        <label className="field">Tool result, tokens<input type="number" min={20} max={2000} step={10} value={toolTokens} onChange={(e) => setToolTokens(+e.target.value)} style={{ width: 110 }} /></label>
        <span className="small muted" style={{ maxWidth: 380 }}>Runs all three conditions through the gateway's <b>qwen-fast</b> backend. Keep the context under its 4,096 tokens per slot: about 1,400 + turns × (tool tokens + 100).</span>
        <span className="spacer" />
        <button className="btn primary" disabled={busy} onClick={() => onStart({ sessions: sessions.split(",").map((x) => +x.trim()).filter(Boolean), turns, tool_tokens: toolTokens })}><Play size={14} />Run experiment</button>
      </div>
    </div>
  );
}

export default function Agent() {
  const [runs, setRuns] = useState<Meta[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [data, setData] = useState<{ meta: Meta; rows: Row[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState<number | null>(null);

  const loadRuns = () => fetch("/api/agent-runs").then((r) => r.json()).then((xs: Meta[]) => {
    setRuns(xs);
    setSel((s) => s ?? (xs.find((x) => x.status === "completed") ?? xs[0])?.id ?? null);
  }).catch(() => setErr("Backend offline: run `ibench serve`"));
  useEffect(() => { loadRuns(); }, []);

  useEffect(() => {
    if (!sel) return;
    let stop = false;
    const tick = async () => {
      const r = await fetch(`/api/agent-runs/${sel}`);
      if (!r.ok || stop) return;
      const d = await r.json();
      setData(d);
      if (d.meta.status === "running") setTimeout(tick, 1500);
      else loadRuns();
    };
    tick();
    return () => { stop = true; };
  }, [sel]);

  const start = async (body: object) => {
    setErr(null);
    const r = await fetch("/api/agent-runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { setErr(typeof d.detail === "string" ? d.detail : JSON.stringify(d.detail)); return; }
    await loadRuns();
    setSel(d.id);
  };
  const cancel = () => sel && fetch(`/api/agent-runs/${sel}/cancel`, { method: "POST" });

  const meta = data?.meta;
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => r.ok), [data]);
  const sessionsList = meta?.spec.sessions ?? [];
  const cur = n != null && sessionsList.includes(n) ? n : sessionsList[0] ?? 1;
  const at = (c: Cond, s = cur) => rows.filter((r) => r.condition === c && r.sessions === s);
  const running = meta?.status === "running";

  // turn-by-turn medians for the selected session count
  const byTurn = useMemo(() => {
    const turns = meta?.spec.turns ?? 0;
    return Array.from({ length: turns }, (_, t) => {
      const o: Record<string, number | null> = { turn: t + 1 };
      (Object.keys(COND) as Cond[]).forEach((c) => {
        const rs = at(c).filter((r) => r.turn === t);
        o[c] = median(nums(rs, "ttft_ms"));
        o[`${c}-prompt`] = median(nums(rs, "prompt_tokens"));
      });
      const rs = at("agent-cache").filter((r) => r.turn === t);
      o.cached = median(nums(rs, "cached_tokens"));
      o.computed = median(nums(rs, "computed_tokens"));
      return o;
    });
  }, [rows, cur, meta]);

  const bySessions = useMemo(() => sessionsList.map((s) => {
    const on = at("agent-cache", s), off = at("agent-nocache", s), chat = at("chat", s);
    const split = (rs: Row[], c: Cond) => {
      const q = median(nums(rs, "queue_ms")) ?? 0, t = median(nums(rs, "ttft_ms"));
      return { [`${c}-q`]: t == null ? null : Math.min(q, t), [`${c}-r`]: t == null ? null : Math.max(0, t - q), [c]: t, [`${c}-qv`]: q };
    };
    return {
      sessions: s, ...split(on, "agent-cache"), ...split(off, "agent-nocache"), ...split(chat, "chat"),
      reuse: sum(on.map((r) => r.prompt_tokens)) ? (100 * sum(on.map((r) => r.cached_tokens))) / sum(on.map((r) => r.prompt_tokens)) : null,
    };
  }), [rows, sessionsList]);

  const on = at("agent-cache"), off = at("agent-nocache"), chat = at("chat");
  const ratio = (rs: Row[]) => (sum(rs.map((r) => r.completion_tokens)) ? sum(rs.map((r) => r.prompt_tokens)) / sum(rs.map((r) => r.completion_tokens)) : null);
  const reuse = sum(on.map((r) => r.prompt_tokens)) ? (100 * sum(on.map((r) => r.cached_tokens))) / sum(on.map((r) => r.prompt_tokens)) : null;
  const lastTurn = (meta?.spec.turns ?? 1) - 1;
  const lastOn = median(nums(on.filter((r) => r.turn === lastTurn), "ttft_ms"));
  const lastOff = median(nums(off.filter((r) => r.turn === lastTurn), "ttft_ms"));
  const toolRate = on.length + off.length ? (100 * sum([...on, ...off].map((r) => r.tool_call))) / (on.length + off.length) : null;

  const summary = (Object.keys(COND) as Cond[]).flatMap((c) => sessionsList.map((s) => {
    const rs = at(c, s);
    const all = (data?.rows ?? []).filter((r) => r.condition === c && r.sessions === s);
    return {
      c, s, n: rs.length, failed: all.length - rs.length, queue50: median(nums(rs, "queue_ms")), ttft50: median(nums(rs, "ttft_ms")), ttft95: pct(nums(rs, "ttft_ms"), 0.95),
      prompt: median(nums(rs, "prompt_tokens")), computed: sum(rs.map((r) => r.computed_tokens)), out: median(nums(rs, "completion_tokens")),
      tps: median(nums(rs, "decode_tps")), reuse: sum(rs.map((r) => r.prompt_tokens)) ? (100 * sum(rs.map((r) => r.cached_tokens))) / sum(rs.map((r) => r.prompt_tokens)) : null,
      tools: c === "chat" ? null : rs.length ? (100 * sum(rs.map((r) => r.tool_call))) / rs.length : null,
    };
  }));

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHead title="Agent traffic" sub={<>A coding agent is asked to call a tool every turn and resends the whole, growing conversation each time. Chat sends short, independent questions. Both go through the gateway to the same llama.cpp backend, so the difference is the traffic, not the server.</>}>
        {runs.length > 0 && (
          <select value={sel ?? ""} onChange={(e) => setSel(e.target.value)}>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.label || r.id} · {r.status}</option>)}
          </select>
        )}
      </PageHead>

      <Controls busy={!!running} onStart={start} />
      {err && <div className="card card-pad small" style={{ color: "var(--critical)" }}>{err}</div>}

      {meta && (
        <>
          <div className="row small secondary" style={{ gap: 12 }}>
            <StatusBadge status={meta.status} />
            <span>{rows.length} / {meta.total} requests</span>
            <span>{meta.spec.turns} turns · tool results about {meta.spec.tool_tokens} tokens · model <code>{meta.spec.model}</code></span>
            {meta.duration_s != null && <span>{Math.round(meta.duration_s)} s</span>}
            {running && <button className="btn sm" onClick={cancel}><Square size={12} />Cancel</button>}
            <span className="spacer" />
            {sessionsList.length > 1 && (
              <div className="row" role="tablist" style={{ gap: 6 }}>
                {sessionsList.map((s) => <button key={s} className={`chip ${s === cur ? "on" : ""}`} onClick={() => setN(s)}>{s} session{s > 1 ? "s" : ""}</button>)}
              </div>
            )}
          </div>

          <div className="grid g4">
            <Stat label="Prompt tokens per output token" value={ratio([...on, ...off])?.toFixed(0) ?? "–"} unit="agent" sub={`chat: ${ratio(chat)?.toFixed(2) ?? "–"}. Agent work is mostly prefill; chat work is mostly decode.`} />
            <Stat label="Prompt served from cache" value={reuse != null ? reuse.toFixed(0) : "–"} unit="%" sub="agent, cache on: share of prompt tokens llama.cpp did not recompute" />
            <Stat label={`Time to first token, turn ${lastTurn + 1}`} value={ms(lastOn)} sub={`cache off: ${ms(lastOff)}${lastOn && lastOff ? ` (${(lastOff / lastOn).toFixed(1)}× slower)` : ""}`} />
            <Stat label="Turns that called a tool" value={toolRate != null ? toolRate.toFixed(0) : "–"} unit="%" sub="real tool calls from the model; the rest answered in text and were told to continue" />
          </div>

          <div className="grid g2" style={{ alignItems: "start" }}>
            <div className="card">
              <div className="card-head"><div><h2>Time to first token, turn by turn</h2><p>Median over {cur} concurrent session{cur > 1 ? "s" : ""}, including any wait in the gateway queue. Each agent turn resends everything so far; chat stays flat.</p></div></div>
              <div className="card-body">
                <Legend items={Object.values(COND)} />
                <div className="small muted" style={{ margin: "6px 0 2px" }}>seconds</div>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={byTurn} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="turn" stroke="var(--border-strong)" tickLine={false} tickFormatter={(t) => `turn ${t}`} />
                    <YAxis stroke="var(--border-strong)" tickLine={false} width={40} tickFormatter={(v) => (v / 1000).toFixed(1)} />
                    <Tooltip content={<TT fmt={ms} title={(t: number) => `Turn ${t}`} />} />
                    {(Object.keys(COND) as Cond[]).map((c) => <Line key={c} dataKey={c} name={COND[c].label} stroke={COND[c].color} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} connectNulls />)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><div><h2>What each agent turn costs to prefill</h2><p>Prompt tokens per turn with the cache on: the part llama.cpp reused, and the part it had to compute. With the cache off, all of it is computed.</p></div></div>
              <div className="card-body">
                <Legend items={[{ label: "Reused from cache", color: "var(--series-1)" }, { label: "Computed", color: "var(--series-2)" }]} />
                <div className="small muted" style={{ margin: "6px 0 2px" }}>prompt tokens</div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={byTurn} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap="25%">
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="turn" stroke="var(--border-strong)" tickLine={false} tickFormatter={(t) => `turn ${t}`} />
                    <YAxis stroke="var(--border-strong)" tickLine={false} width={48} />
                    <Tooltip cursor={{ fill: "var(--surface-2)" }} content={<TT fmt={(v: number) => Math.round(v).toLocaleString()} title={(t: number) => `Turn ${t}`} />} />
                    <Bar dataKey="cached" name="Reused from cache" stackId="p" fill="var(--series-1)" isAnimationActive={false} />
                    <Bar dataKey="computed" name="Computed" stackId="p" fill="var(--series-2)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {sessionsList.length > 1 && (
            <div className="card">
              <div className="card-head"><div><h2>More sessions than slots</h2><p>The fast backend has 4 llama.cpp slots and the gateway admits 4 requests at a time. Median time to first token across all turns, split into waiting in the gateway queue (lighter) and the time after a slot was free. The label on each cache-on bar is the share of prompt tokens reused.</p></div></div>
              <div className="card-body">
                <Legend items={Object.values(COND)} />
                <div className="small muted" style={{ margin: "6px 0 2px" }}>seconds</div>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={bySessions} margin={{ top: 20, right: 16, bottom: 4, left: 0 }} barGap={2}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="sessions" stroke="var(--border-strong)" tickLine={false} tickFormatter={(s) => `${s} session${s > 1 ? "s" : ""}`} />
                    <YAxis stroke="var(--border-strong)" tickLine={false} width={40} tickFormatter={(v) => (v / 1000).toFixed(1)} />
                    <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload, label }: any) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="tooltip">
                          <div className="t-title">{label} concurrent session{label > 1 ? "s" : ""}</div>
                          {(Object.keys(COND) as Cond[]).map((c) => <div className="t-row" key={c}><span><i style={{ background: COND[c].color }} />{COND[c].label}</span><b>{ms(d[c])} <span className="muted">({ms(d[`${c}-qv`])} queued)</span></b></div>)}
                        </div>
                      );
                    }} />
                    {(Object.keys(COND) as Cond[]).flatMap((c) => [
                      <Bar key={c + "q"} dataKey={`${c}-q`} stackId={c} name={`${COND[c].label}, queued`} fill={`color-mix(in srgb, ${COND[c].color} 35%, var(--surface-1))`} maxBarSize={36} isAnimationActive={false} />,
                      <Bar key={c + "r"} dataKey={`${c}-r`} stackId={c} name={COND[c].label} fill={COND[c].color} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}
                        label={c === "agent-cache" ? ({ x, y, width, index }: any) => <text x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={11} fill="var(--text-secondary)">{bySessions[index]?.reuse != null ? `${bySessions[index].reuse!.toFixed(0)}%` : ""}</text> : undefined} />,
                    ])}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head"><div><h2>All conditions</h2><p>One row per condition and session count. Computed tokens are the prompt tokens the backend actually processed.</p></div></div>
            <div className="card-body table-wrap">
              <table className="data">
                <thead><tr><th>Condition</th><th className="num">Sessions</th><th className="num">Requests</th><th className="num">Queue p50</th><th className="num">TTFT p50</th><th className="num">TTFT p95</th><th className="num">Prompt p50</th><th className="num">Reused</th><th className="num">Computed total</th><th className="num">Output p50</th><th className="num">Decode tok/s</th><th className="num">Tool calls</th></tr></thead>
                <tbody>
                  {summary.map((x) => (
                    <tr key={x.c + x.s}>
                      <td><span className="legend-dot" style={{ background: COND[x.c].color }} />{COND[x.c].label}</td>
                      <td className="num">{x.s}</td><td className="num">{x.n}{x.failed ? <span className="muted"> (+{x.failed} failed)</span> : ""}</td>
                      <td className="num">{ms(x.queue50)}</td><td className="num">{ms(x.ttft50)}</td><td className="num">{ms(x.ttft95)}</td><td className="num">{x.prompt != null ? Math.round(x.prompt).toLocaleString() : "–"}</td>
                      <td className="num">{x.reuse != null ? `${x.reuse.toFixed(0)}%` : "–"}</td><td className="num">{x.computed.toLocaleString()}</td>
                      <td className="num">{x.out != null ? Math.round(x.out) : "–"}</td><td className="num">{x.tps != null ? x.tps.toFixed(1) : "–"}</td>
                      <td className="num">{x.tools != null ? `${x.tools.toFixed(0)}%` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {!meta && !err && <div className="card empty"><h2>No agent runs yet</h2><p>Start the gateway (<code>ibench gateway</code>), then run the experiment above or with <code>ibench agent</code>.</p></div>}
    </div>
  );
}
