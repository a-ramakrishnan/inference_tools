import { Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { aggregate, fmt, METRICS, type MetricKey } from "../agg";
import { api } from "../api";
import { ChartCard } from "../components/ChartCard";
import { PageHead, StatusBadge } from "../components/Layout";
import { useAsync } from "../hooks";
import type { RunRow } from "../types";

const COLS: MetricKey[] = ["ttft_ms_p50", "decode_tps_mean", "total_tps", "mem_peak_gb", "cost_per_m_tokens"];

export default function Compare() {
  const sweeps = useAsync(api.sweeps);
  const [picked, setPicked] = useState<string[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!picked.length && sweeps.data) {
      // default: the latest sweep from each machine
      const seen = new Set<string>();
      const first = sweeps.data.filter((s) => s.done_runs > 0 && !seen.has(s.machine) && seen.add(s.machine));
      setPicked(first.slice(0, 3).map((s) => s.id));
    }
  }, [sweeps.data]); // eslint-disable-line

  useEffect(() => {
    Promise.all(picked.map((id) => api.sweep(id))).then((ds) => setRuns(ds.flatMap((d) => d.runs.map((r) => ({
      ...r,
      // two sweeps on one machine (e.g. CPU vs GPU) still need distinct series
      machine: ds.filter((x) => x.meta.machine.label === d.meta.machine.label).length > 1 ? `${r.machine} · ${d.meta.spec.label || d.meta.id}` : r.machine,
    })))));
  }, [picked]);

  const configs = useMemo(() => aggregate(runs), [runs]);
  const machines = Array.from(new Set(configs.map((c) => c.machine)));
  // configurations present on every machine, for the side-by-side table
  const matched = useMemo(() => {
    const byKey = new Map<string, Record<string, (typeof configs)[number]>>();
    for (const c of configs) {
      const k = [c.quant, c.threads_preset, c.prompt_tokens_target, c.concurrency].join("|");
      byKey.set(k, { ...(byKey.get(k) ?? {}), [c.machine]: c });
    }
    return Array.from(byKey.entries()).filter(([, v]) => Object.keys(v).length === machines.length);
  }, [configs, machines.length]);

  const onImport = async (f: File) => {
    setMsg(null);
    try {
      const r = await api.importZip(f);
      setMsg(`Imported ${r.id}`);
      sweeps.reload();
      setPicked((p) => [...p, r.id]);
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHead title="Compare machines" sub="Put sweeps from different machines side by side: the laptop, an x86 instance, a Graviton instance, Colab. Run `ibench run --preset cloud` there, zip its results/<id> folder, and import it here.">
        <input ref={file} type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
        <button className="btn" onClick={() => file.current?.click()}><Upload size={14} />Import results zip</button>
      </PageHead>
      {msg && <div className="small secondary">{msg}</div>}

      <div className="card">
        <div className="card-head"><div><h2>Sweeps</h2><p>Pick up to three: charts stay readable and colorblind-safe with three series.</p></div></div>
        <div className="card-body table-wrap">
          <table className="data">
            <thead><tr><th></th><th>Sweep</th><th>Machine</th><th>Arch</th><th>Status</th><th className="num">Runs</th></tr></thead>
            <tbody>
              {sweeps.data?.filter((s) => s.done_runs > 0).map((s) => (
                <tr key={s.id}>
                  <td><input type="checkbox" checked={picked.includes(s.id)} disabled={!picked.includes(s.id) && picked.length >= 3}
                    onChange={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))} /></td>
                  <td>{s.label || s.id} <span className="muted mono small">{s.id}</span></td>
                  <td>{s.machine}</td><td>{s.arch}</td><td><StatusBadge status={s.status} /></td><td className="num">{s.done_runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {configs.length > 0 && (
        <>
          <div className="grid g2">
            <ChartCard def={{ title: "Time to first token by machine", metric: "ttft_ms_p50", x: "concurrency", series: "machine", hint: "Same model, quantization and prompt on each machine." }} configs={configs} />
            <ChartCard def={{ title: "Total throughput by machine", metric: "total_tps", x: "concurrency", series: "machine", hint: "All output tokens per second across concurrent requests." }} configs={configs} />
            <ChartCard def={{ title: "Tokens/s per request by machine", metric: "decode_tps_mean", x: "concurrency", series: "machine", hint: "Single-stream speed under load." }} configs={configs} />
            <ChartCard def={{ title: "Cost per million output tokens", metric: "cost_per_m_tokens", x: "concurrency", series: "machine", hint: "Instance price ÷ total throughput. Only for sweeps started with a price." }} configs={configs} />
          </div>
          <div className="card">
            <div className="card-head"><div><h2>Matched configurations</h2><p>Only configurations every selected sweep ran.</p></div></div>
            <div className="card-body table-wrap">
              {matched.length ? (
                <table className="data">
                  <thead>
                    <tr><th>Quant</th><th>Threads</th><th className="num">Prompt</th><th className="num">Conc.</th>
                      {COLS.map((k) => machines.map((m) => <th key={k + m} className="num" title={m}>{METRICS[k].short}<br /><span style={{ textTransform: "none" }}>{m.length > 22 ? m.slice(0, 22) + "…" : m}</span></th>))}
                    </tr>
                  </thead>
                  <tbody>
                    {matched.map(([k, v]) => {
                      const c0 = Object.values(v)[0];
                      return (
                        <tr key={k}>
                          <td>{c0.quant}</td><td>{c0.threads_preset}</td><td className="num">{c0.prompt_tokens_target}</td><td className="num">{c0.concurrency}</td>
                          {COLS.map((mk) => machines.map((m) => <td key={mk + m} className="num">{fmt(v[m]?.m[mk]?.mean, mk)}</td>))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : <span className="muted">No configuration was run on every selected machine.</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
