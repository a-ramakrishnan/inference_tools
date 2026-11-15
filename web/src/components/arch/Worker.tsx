import { Bar, CartesianGrid, ComposedChart, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { DIMS, dimValue, dimValues, fmtDim, type DimKey } from "../../agg";
import { api } from "../../api";
import { useAsync } from "../../hooks";
import { Legend } from "../Charts";
import { useSweepSelection } from "./useSweepData";

const DIM_SEL: DimKey[] = ["quant", "threads_preset", "concurrency"];
const PART = {
  weights: { label: "Weights (GGUF file)", color: "var(--series-1)" },
  kv: { label: "KV cache (predicted)", color: "var(--series-2)" },
  other: { label: "Everything else (compute buffers, runtime)", color: "var(--series-3)" },
};

export function Worker() {
  const s = useSweepSelection(DIM_SEL);
  const sys = useAsync(api.system);
  const spec = s.meta?.spec;
  const quant = s.value("quant");
  const threadsPreset = s.value("threads_preset");
  const conc = Number(s.value("concurrency") ?? 1);
  const anyRun = s.configs.find((c) => c.quant === quant)?.runs[0];
  const model = sys.data?.models.find((m) => m.file === anyRun?.model);
  const meta = model?.meta;
  const kvPerTok = meta?.kv_bytes_per_token_f16 ?? 0;
  const ctxPerSlot = spec ? Math.max(...spec.prompt_tokens) + spec.n_predict + 128 : 0;
  const threads = s.configs.find((c) => c.threads_preset === threadsPreset)?.threads ?? 0;
  const gpu = (spec?.gpu_layers ?? 0) > 0;

  // memory budget: one bar per concurrency level, for the selected quant and threads
  const budget = dimValues(s.configs, "concurrency").map((cv) => {
    const cs = s.configs.filter((c) => c.quant === quant && c.threads_preset === threadsPreset && dimValue(c, "concurrency") === cv);
    const measured = Math.max(0, ...cs.map((c) => c.m.mem_peak_gb?.max ?? 0));
    const ctx = Math.ceil((ctxPerSlot * Number(cv)) / 256) * 256;      // llama.cpp pads the context to 256
    const kv = (ctx * kvPerTok) / 2 ** 30;
    const weights = model?.size_gib ?? 0;
    return { x: `${cv} slot${Number(cv) > 1 ? "s" : ""}`, conc: cv, ctx, weights, kv, other: Math.max(0, measured - weights - kv), measured };
  }).filter((b) => b.measured > 0);

  if (!s.configs.length) return <div className="card empty"><h2>No results yet</h2><p>Run a sweep to see the worker's memory budget.</p></div>;

  // schematic geometry
  const n = Math.min(conc, 16);
  const rowH = 30;
  const H = Math.max(300, 70 + n * rowH + 120);
  const barW = 300;
  const promptTok = spec ? Math.max(...spec.prompt_tokens) : 0;
  const pFrac = ctxPerSlot ? promptTok / ctxPerSlot : 0;
  const oFrac = ctxPerSlot && spec ? spec.n_predict / ctxPerSlot : 0;
  const slotsTop = 60;
  const slotsBottom = slotsTop + n * rowH;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="filters">
        <label className="field">Sweep
          <select value={s.id ?? ""} onChange={(e) => s.setSid(e.target.value)}>
            {s.sweeps.filter((x) => x.done_runs > 0).map((x) => <option key={x.id} value={x.id}>{x.label || x.id}</option>)}
          </select>
        </label>
        {DIM_SEL.map((d) => (
          <label className="field" key={d}>{DIMS[d]}
            <select value={String(s.value(d))} onChange={(e) => s.set(d, dimValues(s.configs, d).find((v) => String(v) === e.target.value)!)}>
              {dimValues(s.configs, d).map((v) => <option key={String(v)} value={String(v)}>{fmtDim(d, v, s.configs)}</option>)}
            </select>
          </label>
        ))}
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="card-head"><div><h2>Inside one llama-server</h2><p>{conc} slot{conc > 1 && "s"}, each with its own KV cache of {ctxPerSlot.toLocaleString()} tokens; every decode step batches one token from each active slot.</p></div></div>
          <div className="card-body">
            <svg viewBox={`0 0 760 ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="llama-server internals">
              <defs>
                <marker id="w-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--text-muted)" /></marker>
              </defs>
              <g fontFamily="var(--sans)">
                <rect x={10} y={slotsTop} width={130} height={Math.max(60, n * rowH - 6)} rx={10} fill="var(--surface-2)" stroke="var(--border-strong)" />
                <text x={75} y={slotsTop + 22} textAnchor="middle" fontSize={14} fontWeight={600} fill="var(--text-primary)">HTTP server</text>
                <text x={75} y={slotsTop + 40} textAnchor="middle" fontSize={12} fill="var(--text-secondary)">task queue</text>
                <text x={75} y={slotsTop + 56} textAnchor="middle" fontSize={12} fill="var(--text-secondary)">/completion, /v1/…</text>
                <text x={170 + barW / 2} y={slotsTop - 12} textAnchor="middle" fontSize={12} fill="var(--text-muted)">slots and their KV cache (prompt · output · spare)</text>
                {Array.from({ length: n }, (_, i) => {
                  const y = slotsTop + i * rowH;
                  return (
                    <g key={i}>
                      <path d={`M140,${slotsTop + 30} C155,${slotsTop + 30} 150,${y + 12} 168,${y + 12}`} fill="none" stroke="var(--border-strong)" />
                      <text x={176} y={y + 16} fontSize={11.5} fill="var(--text-secondary)">slot {i}</text>
                      <rect x={220} y={y + 3} width={barW} height={18} rx={4} fill="var(--surface-2)" stroke="var(--border-strong)" />
                      <rect x={220} y={y + 3} width={barW * pFrac} height={18} rx={4} fill={PART.kv.color} opacity={0.85} />
                      <rect x={220 + barW * pFrac + 1} y={y + 3} width={Math.max(0, barW * oFrac - 1)} height={18} fill={PART.kv.color} opacity={0.45} />
                      <path d={`M${222 + barW},${y + 12} C${560},${y + 12} ${555},${slotsTop + 40} ${580},${slotsTop + 40}`} fill="none" stroke="var(--border-strong)" />
                    </g>
                  );
                })}
                {conc > n && <text x={220} y={slotsBottom + 14} fontSize={12} fill="var(--text-muted)">… {conc - n} more slots</text>}
                <rect x={580} y={slotsTop} width={170} height={80} rx={10} fill="color-mix(in srgb, var(--good) 8%, var(--surface-1))" stroke="var(--good)" />
                <text x={665} y={slotsTop + 26} textAnchor="middle" fontSize={14} fontWeight={600} fill="var(--text-primary)">Forward pass</text>
                <text x={665} y={slotsTop + 46} textAnchor="middle" fontSize={12} fill="var(--text-secondary)">batch of ≤{conc} tokens</text>
                <text x={665} y={slotsTop + 64} textAnchor="middle" fontSize={12} fill="var(--text-secondary)">{meta?.layers ?? "?"} layers</text>
                {(() => {
                  const y0 = Math.max(slotsBottom, slotsTop + 90) + 30;
                  return (
                    <>
                      <line x1={665} y1={y0} x2={665} y2={slotsTop + 82} stroke="var(--text-muted)" markerEnd="url(#w-arrow)" />
                      <text x={672} y={y0 - 8} fontSize={11.5} fill="var(--text-muted)">all weights, every step</text>
                      <rect x={460} y={y0} width={290} height={64} rx={10} fill="color-mix(in srgb, var(--series-1) 10%, var(--surface-1))" stroke="var(--series-1)" />
                      <text x={475} y={y0 + 24} fontSize={14} fontWeight={600} fill="var(--text-primary)">Weights · {quant}</text>
                      <text x={475} y={y0 + 44} fontSize={12} fill="var(--text-secondary)">{model?.size_gib?.toFixed(2) ?? "?"} GiB · {meta?.heads ?? "?"} heads, {meta?.kv_heads ?? "?"} KV heads × {meta?.head_dim ?? "?"}</text>
                      <rect x={10} y={y0} width={430} height={64} rx={10} fill="var(--surface-2)" stroke="var(--border-strong)" />
                      <text x={25} y={y0 + 24} fontSize={14} fontWeight={600} fill="var(--text-primary)">{gpu ? "Metal GPU (all layers)" : `CPU · ${threads} threads`}</text>
                      {!gpu && Array.from({ length: Math.min(threads, 16) }, (_, i) => (
                        <rect key={i} x={25 + i * 24} y={y0 + 36} width={18} height={16} rx={3} fill="var(--accent)" opacity={0.75} />
                      ))}
                      {gpu && <text x={25} y={y0 + 46} fontSize={12} fill="var(--text-secondary)">-ngl 99: weights and KV cache in unified memory</text>}
                    </>
                  );
                })()}
              </g>
            </svg>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><h2>Memory budget: predicted vs measured</h2><p>Weights are the GGUF file. The KV cache is predicted from the model's own metadata. What's left of the measured peak is compute buffers and runtime.</p></div></div>
          <div className="card-body stack" style={{ gap: 8 }}>
            <Legend items={[...Object.values(PART), { label: "Measured peak", color: "var(--text-primary)" }]} />
            <div className="small muted" style={{ marginBottom: -6 }}>GiB</div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={budget} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="x" stroke="var(--border-strong)" tickLine={false} />
                <YAxis stroke="var(--border-strong)" tickLine={false} width={40} tickFormatter={(v) => v.toFixed(1)} />
                <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload;
                  return (
                    <div className="tooltip">
                      <div className="t-title">{p.x} · {p.ctx.toLocaleString()} tokens of context</div>
                      {(["weights", "kv", "other"] as const).map((k) => <div className="t-row" key={k}><span><i style={{ background: PART[k].color }} />{PART[k].label}</span><b>{p[k].toFixed(3)} GiB</b></div>)}
                      <div className="t-row"><span>Measured peak</span><b>{p.measured.toFixed(3)} GiB</b></div>
                    </div>
                  );
                }} />
                <Bar dataKey="weights" stackId="m" fill={PART.weights.color} stroke="var(--surface-1)" strokeWidth={2} maxBarSize={56} isAnimationActive={false} />
                <Bar dataKey="kv" stackId="m" fill={PART.kv.color} stroke="var(--surface-1)" strokeWidth={2} maxBarSize={56} isAnimationActive={false} />
                <Bar dataKey="other" stackId="m" fill={PART.other.color} stroke="var(--surface-1)" strokeWidth={2} radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false} />
                <Scatter dataKey="measured" fill="var(--text-primary)" shape="diamond" isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
            <table className="data small">
              <thead><tr><th>Slots</th><th className="num">Context</th><th className="num">KV predicted</th><th className="num">Weights</th><th className="num">Measured</th><th className="num">Explained</th></tr></thead>
              <tbody>
                {budget.map((b) => (
                  <tr key={b.x}>
                    <td>{b.conc}</td><td className="num">{b.ctx.toLocaleString()}</td><td className="num">{(b.kv * 1024).toFixed(0)} MiB</td>
                    <td className="num">{b.weights.toFixed(2)} GiB</td><td className="num">{b.measured.toFixed(2)} GiB</td>
                    <td className="num">{b.measured ? Math.round((100 * (b.weights + b.kv)) / b.measured) : 0}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {meta && !meta.error && (
        <div className="card">
          <div className="card-head"><div><h2>Model, from its GGUF header</h2><p>Read by <code>ibench/gguf.py</code> without loading weights.</p></div></div>
          <div className="card-body">
            <div className="grid g4">
              {[
                ["Architecture", meta.architecture], ["Layers", meta.layers], ["Hidden size", meta.embedding], ["FFN size", meta.ffn],
                ["Attention heads", meta.heads], ["KV heads (GQA)", meta.kv_heads], ["Head size", meta.head_dim], ["Vocabulary", meta.vocab?.toLocaleString()],
                ["Trained context", meta.context_train?.toLocaleString()], ["KV per token (f16)", kvPerTok ? `${(kvPerTok / 1024).toFixed(0)} KiB` : "–"],
                ["KV per slot", kvPerTok ? `${((kvPerTok * ctxPerSlot) / 2 ** 20).toFixed(0)} MiB` : "–"], ["KV saved by GQA", meta.heads && meta.kv_heads ? `${meta.heads / meta.kv_heads}× smaller` : "–"],
              ].map(([k, v]) => (
                <div key={String(k)}><div className="small muted">{k}</div><div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{v ?? "–"}</div></div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
