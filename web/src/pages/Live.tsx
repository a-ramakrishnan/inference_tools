import { Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmt } from "../agg";
import { api } from "../api";
import { MemoryChart } from "../components/Charts";
import { PageHead, Stat, StatusBadge } from "../components/Layout";
import { fmtDuration } from "../hooks";
import { useLive } from "../live";

export function ThermalBadge({ state }: { state: string }) {
  const cls = state === "nominal" ? "good" : state === "fair" ? "" : state === "serious" ? "warn" : state === "critical" ? "crit" : "";
  return <span className={`badge ${cls}`} title="The operating system's thermal state after the last run. Serious or critical means the CPU is being throttled.">Thermal: {state}</span>;
}

export default function Live() {
  const s = useLive();
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);

  if (!s.sweepId) {
    return (
      <div className="stack">
        <PageHead title="Live" />
        <div className="card empty">
          <h2>Nothing running</h2>
          <p>{s.connected ? "Start a sweep and its progress streams here." : "Waiting for the backend. Start it with `ibench serve`."}</p>
          <Link to="/run" className="btn primary">New sweep</Link>
        </div>
      </div>
    );
  }

  const pct = s.total ? (100 * s.done) / s.total : 0;
  const elapsed = s.startedAt ? now - s.startedAt : 0;
  const eta = s.done && s.status === "running" ? (elapsed / s.done) * (s.total - s.done) : null;
  const last = s.runs[s.runs.length - 1];
  const nPredict = s.spec?.n_predict ?? 200;
  const memNow = s.memory[s.memory.length - 1]?.rss_gb;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHead title="Live" sub={<>Sweep <span className="mono">{s.sweepId}</span> · {s.spec?.label} · {s.machine?.label}</>}>
        <StatusBadge status={s.status} />
        {s.status === "running" && <button className="btn danger" onClick={() => api.cancel(s.sweepId!)}><Square size={13} />Stop after this run</button>}
        {s.status !== "running" && <Link className="btn primary" to={`/results/${s.sweepId}`}>Open results</Link>}
      </PageHead>

      <div className="card card-pad stack" style={{ gap: 10 }}>
        <div className="row"><b>{s.done} of {s.total} runs</b>
          {s.thermal && <ThermalBadge state={s.thermal} />}
          {s.phase && <span className="badge info">{s.phase}</span>}
          <span className="spacer" /><span className="muted small">elapsed {fmtDuration(elapsed)}{eta != null && ` · about ${fmtDuration(eta)} left`}</span></div>
        <div className="bar"><div style={{ width: `${pct}%` }} /></div>
      </div>

      <div className="grid g4">
        <Stat label="Last TTFT (p50)" value={fmt(last?.ttft_ms_p50, "ttft_ms_p50")} unit="ms" sub={last?.run_id} />
        <Stat label="Last tokens/s per request" value={fmt(last?.decode_tps_mean, "decode_tps_mean")} unit="tok/s" />
        <Stat label="Last total tokens/s" value={fmt(last?.total_tps, "total_tps")} unit="tok/s" />
        <Stat label="Server memory now" value={memNow != null ? memNow.toFixed(2) : "–"} unit="GiB" sub="resident set, sampled every 100 ms" />
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><div><h2>Now running</h2><p>Each bar is one in-flight request, filling as tokens stream back.</p></div></div>
          <div className="card-body stack" style={{ gap: 10 }}>
            {s.server ? (
              <dl className="kv">
                <dt>Server</dt><dd>{s.server.quant} · {s.server.threads} threads · {s.server.concurrency} slots · {s.server.device.toUpperCase()} {s.server.ready ? <span className="badge good">ready{s.server.load_s != null && ` ${s.server.load_s}s`}</span> : <span className="badge info">loading</span>}</dd>
                <dt>Command</dt><dd className="mono small" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>llama-server {s.server.args.join(" ")}</dd>
                {s.currentRun && <><dt>Run</dt><dd>{s.currentRun.run_id ?? ""} · prompt {s.currentRun.prompt_tokens} tok · repeat {s.currentRun.repeat}</dd></>}
              </dl>
            ) : <span className="muted">{s.status === "running" ? "Between servers…" : "Idle."}</span>}
            {s.currentRun && Array.from({ length: s.currentRun.concurrency }, (_, i) => {
              const n = s.progress[i] ?? 0;
              return (
                <div key={i} className="row" style={{ gap: 10 }}>
                  <span className="mono small muted" style={{ width: 28 }}>#{i}</span>
                  <div className="bar" style={{ flex: 1 }}><div style={{ width: `${(100 * n) / nPredict}%`, background: n ? "var(--series-1)" : "transparent" }} /></div>
                  <span className="mono small muted" style={{ width: 70, textAlign: "right" }}>{n ? `${n}/${nPredict}` : "prefill…"}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h2>Server memory</h2><p>Steps line up with server restarts and with KV cache size, which grows with concurrency.</p></div></div>
          <div className="card-body"><MemoryChart points={s.memory} height={230} /></div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><h2>Completed runs</h2></div>
          <div className="card-body table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
            <table className="data">
              <thead><tr><th>Run</th><th className="num">TTFT p50</th><th className="num">tok/s/req</th><th className="num">total tok/s</th><th className="num">peak GiB</th></tr></thead>
              <tbody>
                {[...s.runs].reverse().map((r) => (
                  <tr key={r.run_id}>
                    <td className="mono small">{r.run_id}</td>
                    <td className="num">{fmt(r.ttft_ms_p50, "ttft_ms_p50")}</td>
                    <td className="num">{fmt(r.decode_tps_mean, "decode_tps_mean")}</td>
                    <td className="num">{fmt(r.total_tps, "total_tps")}</td>
                    <td className="num">{fmt(r.mem_peak_gb ?? r.rss_peak_gb, "mem_peak_gb")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Event log</h2></div>
          <div className="card-body">
            <div className="log">
              {s.log.map((l, i) => (
                <div key={i} style={{ color: l.kind === "error" ? "var(--critical)" : l.kind === "ok" ? "var(--good-text)" : undefined }}>
                  {new Date(l.t * 1000).toLocaleTimeString()}  {l.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
