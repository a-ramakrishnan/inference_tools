import { ArrowRight, Cpu, Database, Gauge, HardDrive, Layers, Timer, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { aggregate, fmt, type ConfigAgg } from "../agg";
import { api } from "../api";
import { PageHead, Stat, StatusBadge } from "../components/Layout";
import { fmtDuration, useAsync } from "../hooks";

function best(configs: ConfigAgg[], k: "ttft_ms_p50" | "decode_tps_mean" | "total_tps", lower: boolean) {
  const xs = configs.filter((c) => c.m[k]);
  if (!xs.length) return null;
  return xs.reduce((a, b) => ((lower ? b.m[k]!.mean < a.m[k]!.mean : b.m[k]!.mean > a.m[k]!.mean) ? b : a));
}

const describe = (c: ConfigAgg) =>
  `${c.quant} · ${c.threads} threads · ${c.prompt_tokens_target.toLocaleString()} tok prompt · ${c.concurrency} concurrent · ${c.device.toUpperCase()}`;

export default function Overview() {
  const sys = useAsync(api.system);
  const sweeps = useAsync(api.sweeps);
  // prefer the latest completed sweep; fall back to any sweep with data
  const latest = sweeps.data?.find((s) => s.status === "completed" && s.done_runs > 1) ?? sweeps.data?.find((s) => s.done_runs > 0);
  const detail = useAsync(() => (latest ? api.sweep(latest.id) : Promise.resolve(null)), [latest?.id]);
  const configs = detail.data ? aggregate(detail.data.runs) : [];
  const fastest = best(configs, "ttft_ms_p50", true);
  const decode = best(configs, "decode_tps_mean", false);
  const total = best(configs, "total_tps", false);
  const mem = configs.filter((c) => c.m.mem_peak_gb).sort((a, b) => a.m.mem_peak_gb!.mean - b.m.mem_peak_gb!.mean);
  const m = sys.data?.machine;

  return (
    <div className="stack" style={{ gap: 22 }}>
      <PageHead
        title="LLM inference, measured"
        sub={<>How quantization, threads, prompt length and concurrency change time to first token, throughput and memory for a small open model served by <b>llama.cpp</b>. Every number here comes from a real run and is saved to CSV.</>}
      >
        <Link className="btn" to="/architecture">How it fits together</Link>
        <Link className="btn primary" to="/run"><Zap size={15} />New sweep</Link>
      </PageHead>

      {latest ? (
        <>
          <div className="row small muted">
            Headline numbers from <Link to={`/results/${latest.id}`}><b>{latest.label || latest.id}</b></Link> · {latest.machine} · {latest.done_runs} runs
          </div>
          <div className="grid g4">
            <Stat icon={<Timer size={13} />} label="Fastest time to first token" value={fmt(fastest?.m.ttft_ms_p50?.mean, "ttft_ms_p50")} unit="ms" sub={fastest && describe(fastest)} />
            <Stat icon={<Gauge size={13} />} label="Best tokens/s per request" value={fmt(decode?.m.decode_tps_mean?.mean, "decode_tps_mean")} unit="tok/s" sub={decode && describe(decode)} />
            <Stat icon={<Layers size={13} />} label="Best total throughput" value={fmt(total?.m.total_tps?.mean, "total_tps")} unit="tok/s" sub={total && describe(total)} />
            <Stat icon={<HardDrive size={13} />} label="Peak memory range" value={mem.length ? `${fmt(mem[0].m.mem_peak_gb!.mean, "mem_peak_gb")}–${fmt(mem[mem.length - 1].m.mem_peak_gb!.mean, "mem_peak_gb")}` : "–"} unit="GiB" sub="llama-server process, physical footprint" />
          </div>
        </>
      ) : (
        <div className="card empty">
          <h2>No results yet</h2>
          <p>Run the smoke test to make the first measurement (under a minute).</p>
          <Link className="btn primary" to="/run?preset=smoke">Start a smoke test</Link>
        </div>
      )}

      <div className="grid g3">
        <div className="card">
          <div className="card-head"><h2><Cpu size={14} style={{ verticalAlign: -2 }} /> This machine</h2></div>
          <div className="card-body">
            {m ? (
              <dl className="kv">
                <dt>CPU</dt><dd>{m.cpu} ({m.arch})</dd>
                <dt>Cores</dt><dd>{m.performance_cores} performance{m.efficiency_cores ? ` + ${m.efficiency_cores} efficiency` : ""}</dd>
                <dt>Memory</dt><dd>{m.memory_gb} GiB</dd>
                <dt>GPU</dt><dd>{m.gpu ?? "none"}</dd>
                <dt>OS</dt><dd>{m.os}</dd>
                <dt>llama.cpp</dt><dd className="mono">{m.llama_cpp ?? "not found"}</dd>
              </dl>
            ) : <span className="muted">{sys.error ?? "Loading…"}</span>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2><Database size={14} style={{ verticalAlign: -2 }} /> Models</h2></div>
          <div className="card-body">
            {sys.data?.models.length ? (
              <table className="data">
                <thead><tr><th>File</th><th>Quant</th><th className="num">Size</th></tr></thead>
                <tbody>
                  {sys.data.models.map((x) => (
                    <tr key={x.file}><td className="mono" style={{ whiteSpace: "normal" }}>{x.file}</td><td>{x.quant}</td><td className="num">{x.size_gb} GB</td></tr>
                  ))}
                </tbody>
              </table>
            ) : <span className="muted">No GGUF files in models/. See the README.</span>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>What a run measures</h2></div>
          <div className="card-body small secondary">
            <dl className="kv">
              <dt>TTFT</dt><dd>Request sent → first token back. Includes queueing and prompt processing.</dd>
              <dt>tok/s/req</dt><dd>One request's decode speed after its first token.</dd>
              <dt>Total tok/s</dt><dd>All output tokens / wall time, across concurrent requests.</dd>
              <dt>Peak mem</dt><dd>OS peak physical footprint of the server (vmmap or /proc).</dd>
            </dl>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div><h2>Recent sweeps</h2><p>Results from other machines appear here once their folder is copied into results/ or imported on the Compare page.</p></div>
          <Link to="/results" className="btn sm">All results <ArrowRight size={13} /></Link>
        </div>
        <div className="card-body table-wrap">
          {sweeps.data?.length ? (
            <table className="data">
              <thead><tr><th>Sweep</th><th>Machine</th><th>Status</th><th className="num">Runs</th><th className="num">Duration</th><th>Started</th></tr></thead>
              <tbody>
                {sweeps.data.slice(0, 8).map((s) => (
                  <tr key={s.id}>
                    <td><Link to={`/results/${s.id}`}>{s.label || s.id}</Link> <span className="muted mono small">{s.id}</span></td>
                    <td>{s.machine}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="num">{s.done_runs}/{s.total_runs}</td>
                    <td className="num">{fmtDuration(s.duration_s)}</td>
                    <td className="muted">{s.started_at?.replace("T", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <span className="muted">None yet.</span>}
        </div>
      </div>
    </div>
  );
}
