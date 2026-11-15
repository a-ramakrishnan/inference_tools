import { Download, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { METRICS, aggregate, dimValues, fmt, fmtDim, type ConfigAgg, type MetricKey } from "../agg";
import { api } from "../api";
import { ChartCard, type ChartDef } from "../components/ChartCard";
import { MemoryChart, RequestTimeline } from "../components/Charts";
import { PageHead, Stat, StatusBadge } from "../components/Layout";
import { fmtDuration, useAsync } from "../hooks";
import type { RunRow, SweepMeta } from "../types";

const KEY_CHARTS: ChartDef[] = [
  { title: "Time to first token vs concurrency", metric: "ttft_ms_p50", x: "concurrency", series: "prompt_tokens_target",
    hint: "Every waiting request needs its prompt processed before its first token. Compare how the short and long prompt lines grow." },
  { title: "Tokens/s per request vs concurrency", metric: "decode_tps_mean", x: "concurrency", series: "quant",
    hint: "What one user feels while tokens stream. Concurrent requests share the same cores and memory bandwidth." },
  { title: "Total throughput vs concurrency", metric: "total_tps", x: "concurrency", series: "quant",
    hint: "What the server delivers across all requests. Continuous batching makes this grow even as per-request speed falls." },
  { title: "Peak memory vs concurrency", metric: "mem_peak_gb", x: "concurrency", series: "quant",
    hint: "Weights are fixed per quantization; each slot adds its own KV cache sized for prompt + output." },
  { title: "Decode speed vs threads", metric: "decode_tps_mean", x: "threads_preset", series: "quant",
    hint: "Token generation reads every weight once per token, so it tends to hit memory bandwidth before core count." },
  { title: "Prompt processing vs threads", metric: "server_prompt_tps_mean", x: "threads_preset", series: "quant",
    hint: "Prefill is large matrix-matrix work, so it is the part most likely to use extra cores." },
];

function ThrottleBanner({ meta, runs }: { meta: SweepMeta; runs: RunRow[] }) {
  const states = runs.map((r) => r.thermal).filter(Boolean) as string[];
  const hot = states.filter((t) => t === "serious" || t === "critical").length;
  const c = meta.control;
  const drift = c?.drift_pct?.decode_tps_mean;
  const driftBad = drift != null && Math.abs(drift) > 10;
  const others = runs.map((r) => r.other_cpu_pct).filter((v): v is number => v != null);
  const otherMax = others.length ? Math.max(...others) : null;
  const busy = otherMax != null && otherMax > 15;
  if (!c && !states.length && !others.length) return null;
  const warn = hot || driftBad || busy;
  const tone = warn ? "var(--warning)" : "var(--good)";
  return (
    <div className="card card-pad row" style={{ borderLeft: `4px solid ${tone}`, gap: 16 }}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <b>{warn ? "This sweep may be affected by other load or throttling" : "No sign of other load or throttling"}</b>
        <div className="small secondary">
          {c ? <>Control re-run of <span className="mono">{c.run_id}</span> at the end: TTFT {fmtPct(c.drift_pct.ttft_ms_p50)}, tokens/s per request {fmtPct(drift)} compared with the first run{c.thermal_first || c.thermal_last ? ` (thermal ${c.thermal_first ?? "?"} → ${c.thermal_last ?? "?"})` : ""}. </> : "No control run. "}
          {otherMax != null && <>Other work on the machine took up to {otherMax.toFixed(0)}% of all cores during a run. </>}
          {states.length > 0 && <>Thermal state per run: {Object.entries(states.reduce<Record<string, number>>((a, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ×${v}`).join(", ")}.</>}
        </div>
      </div>
    </div>
  );
}

const fmtPct = (v: number | null | undefined) => (v == null ? "–" : `${v > 0 ? "+" : ""}${v}%`);

const TABLE_COLS: MetricKey[] = ["ttft_ms_p50", "decode_tps_mean", "total_tps", "mem_peak_gb", "e2e_ms_mean", "server_prompt_tps_mean", "cost_per_m_tokens"];

export default function Results() {
  const { id } = useParams();
  const nav = useNavigate();
  const sweeps = useAsync(api.sweeps);
  const sid = id ?? sweeps.data?.find((s) => s.done_runs > 0)?.id;
  const detail = useAsync(() => (sid ? api.sweep(sid) : Promise.resolve(null)), [sid]);
  const memory = useAsync(() => (sid ? api.memory(sid) : Promise.resolve([])), [sid]);
  const requests = useAsync(() => (sid ? api.requests(sid) : Promise.resolve([])), [sid]);
  const configs = useMemo(() => (detail.data ? aggregate(detail.data.runs) : []), [detail.data]);
  const [selected, setSelected] = useState<ConfigAgg | null>(null);
  const [sort, setSort] = useState<{ k: MetricKey | null; dir: 1 | -1 }>({ k: null, dir: 1 });

  if (sweeps.data && !sweeps.data.length) {
    return <div className="card empty"><h2>No results yet</h2><p>Run a sweep first.</p><Link to="/run" className="btn primary">New sweep</Link></div>;
  }
  if (!detail.data) return <div className="muted">{detail.error ?? "Loading…"}</div>;
  const { meta, runs } = detail.data;
  const charts = KEY_CHARTS.filter((c) => dimValues(configs, c.x).length > 1 && configs.some((x) => x.m[c.metric]));
  const sorted = sort.k ? [...configs].sort((a, b) => ((a.m[sort.k!]?.mean ?? 0) - (b.m[sort.k!]?.mean ?? 0)) * sort.dir) : configs;
  const sel = selected && configs.find((c) => c.key === selected.key);
  const selRun = sel?.runs[0];
  const selReqs = selRun ? (requests.data ?? []).filter((r) => r.run_id === selRun.run_id) : [];
  const totalTokens = runs.reduce((a, r) => a + (r.output_tokens ?? 0) * r.concurrency, 0);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHead title={meta.spec.label || "Results"} sub={<>{meta.machine.label} · {meta.machine.os} · llama.cpp <span className="mono">{meta.machine.llama_cpp}</span></>}>
        <select value={sid} onChange={(e) => nav(`/results/${e.target.value}`)} style={{ maxWidth: 340 }}>
          {sweeps.data?.map((s) => <option key={s.id} value={s.id}>{s.label || s.id} · {s.machine} · {s.id}</option>)}
        </select>
        <a className="btn" href={api.fileUrl(meta.id, "runs.csv")}><Download size={14} />runs.csv</a>
        <a className="btn" href={api.fileUrl(meta.id, "requests.csv")}><Download size={14} />requests.csv</a>
        <button className="btn danger" title="Delete this sweep" onClick={async () => {
          if (!confirm(`Delete sweep ${meta.id} and its CSV files? This cannot be undone.`)) return;
          await api.remove(meta.id); nav("/results"); sweeps.reload();
        }}><Trash2 size={14} /></button>
      </PageHead>

      <ThrottleBanner meta={meta} runs={runs} />

      <div className="grid g4">
        <Stat label="Status" value={<StatusBadge status={meta.status} />} sub={`${meta.done_runs} of ${meta.total_runs} runs · ${fmtDuration(meta.duration_s)}`} />
        <Stat label="Configurations" value={configs.length} sub={`${meta.spec.repeats} repeat${meta.spec.repeats > 1 ? "s" : ""} each · ${meta.spec.n_predict} output tokens per request`} />
        <Stat label="Tokens generated" value={totalTokens.toLocaleString()} sub={`${runs.reduce((a, r) => a + r.concurrency, 0)} requests`} />
        <Stat label="Device" value={meta.spec.gpu_layers > 0 ? "GPU" : "CPU"} sub={meta.spec.gpu_layers > 0 ? meta.machine.gpu ?? "" : `${meta.machine.performance_cores} P + ${meta.machine.efficiency_cores} E cores`} />
      </div>

      {charts.length > 0 && <div className="grid g2">{charts.map((c) => <ChartCard key={c.title} def={c} configs={configs} />)}</div>}
      <ChartCard editable def={{ title: "", metric: "total_tps", x: "concurrency", series: "quant" }} configs={configs} />

      <div className="card">
        <div className="card-head"><div><h2>All configurations</h2><p>Mean over repeats. Click a row to see its requests. Click a column to sort.</p></div></div>
        <div className="card-body table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Quant</th><th>Device</th><th>Threads</th><th className="num">Prompt</th><th className="num">Conc.</th><th className="num">n</th>
                {TABLE_COLS.filter((k) => configs.some((c) => c.m[k])).map((k) => (
                  <th key={k} className="num sortable" onClick={() => setSort((s) => ({ k, dir: s.k === k ? (-s.dir as 1 | -1) : 1 }))}>
                    {METRICS[k].short}{sort.k === k ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.key} className={sel?.key === c.key ? "selected" : ""} onClick={() => setSelected(c)} style={{ cursor: "pointer" }}>
                  <td>{c.quant}</td><td>{c.device.toUpperCase()}</td><td>{fmtDim("threads_preset", c.threads_preset, configs)}</td>
                  <td className="num">{c.prompt_tokens_target.toLocaleString()}</td><td className="num">{c.concurrency}</td><td className="num muted">{c.repeats}</td>
                  {TABLE_COLS.filter((k) => configs.some((x) => x.m[k])).map((k) => <td key={k} className="num">{fmt(c.m[k]?.mean, k)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><div><h2>Requests in one run</h2><p>{sel ? `${sel.quant} · ${sel.threads} threads · ${sel.prompt_tokens_target} tok prompt · ${sel.concurrency} concurrent · repeat 1` : "Pick a configuration in the table above."}</p></div></div>
          <div className="card-body">
            {sel ? (selReqs.length ? <RequestTimeline rows={selReqs} /> : <span className="muted">No request rows for this run.</span>) : <div className="empty small">Concurrent requests start together; the timeline shows which of them waited for their prompt to be processed.</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h2>Server memory over the sweep</h2><p>Resident memory of llama-server, sampled every 100 ms. Each step is a server restart with new settings.</p></div></div>
          <div className="card-body"><MemoryChart points={memory.data ?? []} height={260} /></div>
        </div>
      </div>
    </div>
  );
}
