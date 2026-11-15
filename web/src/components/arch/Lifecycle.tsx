import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DIMS, dimValues, fmtDim, type DimKey } from "../../agg";
import { api } from "../../api";
import { useAsync } from "../../hooks";
import { Legend } from "../Charts";
import { useSweepSelection } from "./useSweepData";

const DIM_SEL: DimKey[] = ["quant", "threads_preset", "prompt_tokens_target", "concurrency"];
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);

const PHASE = {
  wait: { label: "Waiting (slot, batching, HTTP)", color: "var(--series-4)" },
  prefill: { label: "Prompt processing (prefill)", color: "var(--series-2)" },
  decode: { label: "Generating (decode)", color: "var(--series-1)" },
};

export function Lifecycle() {
  const s = useSweepSelection(DIM_SEL);
  const sys = useAsync(api.system);
  const c = s.config;
  const runIds = new Set(c?.runs.map((r) => r.run_id));
  const reqs = s.requests.filter((r) => runIds.has(r.run_id) && !r.error);
  const firstRun = c?.runs[0]?.run_id;
  const lanes = reqs.filter((r) => r.run_id === firstRun).map((r) => {
    const prefill = r.server_prompt_ms ?? 0;
    return { name: `#${r.request_index}`, start: r.start_offset_ms, wait: Math.max(0, r.ttft_ms - prefill), prefill: Math.min(prefill, r.ttft_ms), decode: Math.max(0, r.e2e_ms - r.ttft_ms), r };
  });
  const ttft = median(reqs.map((r) => r.ttft_ms));
  const prefill = median(reqs.map((r) => Math.min(r.server_prompt_ms ?? 0, r.ttft_ms)));
  const e2e = median(reqs.map((r) => r.e2e_ms));
  const decodeTps = median(reqs.map((r) => r.decode_tps ?? 0));
  const out = median(reqs.map((r) => r.output_tokens));
  const promptTok = median(reqs.map((r) => r.prompt_tokens));
  const model = sys.data?.models.find((m) => m.file === c?.runs[0]?.model);
  const kvPerTok = model?.meta?.kv_bytes_per_token_f16;
  const weightsGiB = model?.size_gib;
  // Each decode step reads every weight once, whatever the batch size: a lower bound on memory traffic.
  const stepsPerSec = c?.m.total_tps?.mean && c.concurrency ? c.m.total_tps.mean / c.concurrency : decodeTps;
  const bw = weightsGiB && stepsPerSec ? weightsGiB * stepsPerSec : null;

  const steps = [
    { t: "before t = 0", title: "Build the prompt", code: "ibench/prompts.py", body: `A synthetic passage cut to exactly ${promptTok || "N"} tokens with the server's own tokenizer, with a unique first line so no two requests share a prefix.` },
    { t: "at 0 ms", title: "POST /completion, stream: true", code: "ibench/loadgen.py", body: `All ${c?.concurrency ?? "N"} requests leave at the same moment over separate connections. The clock starts here.` },
    { t: `+${ms(Math.max(0, ttft - prefill))}`, title: "Wait for a slot and a batch", code: "llama-server -np", body: c && c.concurrency > 1 ? `The server has ${c.concurrency} slots, so nobody queues for a slot, but prompts share each forward pass and the cores. This bar grows with concurrency.` : "With one request there is nothing to wait for beyond HTTP and scheduling." },
    { t: `+${ms(prefill)}`, title: "Prefill: the whole prompt through every layer", code: `${model?.meta?.layers ?? "?"} layers`, body: `Matrix-matrix work, spread over ${c?.threads ?? "?"} threads. It writes this request's keys and values into its slot's KV cache${kvPerTok && promptTok ? `: ${promptTok} tokens × ${(kvPerTok / 1024).toFixed(0)} KiB = ${((promptTok * kvPerTok) / 2 ** 20).toFixed(1)} MiB` : ""}.` },
    { t: `at ${ms(ttft)}`, title: "First token streamed back", code: "SSE chunk", body: "The first sampled token goes out as a server-sent event. Time to first token is measured on its arrival at the client." },
    { t: `+${ms(e2e - ttft)}`, title: `Decode ${out || "N"} tokens, one per step`, code: "continuous batching", body: `Every step runs one new token for every active slot at once and reads all the weights${weightsGiB ? ` (${weightsGiB.toFixed(2)} GiB)` : ""}. ${bw ? `At ${stepsPerSec.toFixed(1)} steps/s that is at least ${bw.toFixed(0)} GiB/s of weight reads, which is why decode speed tracks memory bandwidth more than core count.` : ""}` },
    { t: `at ${ms(e2e)}`, title: "Final chunk with llama.cpp's own timings", code: "timings", body: "The last event carries the server's prompt and decode timings, saved next to the client's numbers as a cross-check." },
  ];

  if (!s.configs.length) return <div className="card empty"><h2>No results yet</h2><p>Run a sweep to see where the time goes in a real request.</p></div>;

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

      {!c || !reqs.length ? <div className="card empty small">This combination was not run in this sweep.</div> : (
        <>
          <div className="card">
            <div className="card-head"><div><h2>Where the time goes in one request</h2><p>Median over {reqs.length} request{reqs.length > 1 && "s"} ({c.repeats} repeat{c.repeats > 1 && "s"} × {c.concurrency} concurrent). End to end: <b>{ms(e2e)}</b>; time to first token: <b>{ms(ttft)}</b>, of which prefill is {ttft ? Math.round((100 * prefill) / ttft) : 0}%.</p></div></div>
            <div className="card-body stack" style={{ gap: 10 }}>
              <div style={{ display: "flex", height: 30, borderRadius: 6, overflow: "hidden", gap: 2 }}>
                {([["wait", Math.max(0, ttft - prefill)], ["prefill", prefill], ["decode", Math.max(0, e2e - ttft)]] as const).map(([k, v]) => (
                  <div key={k} title={`${PHASE[k].label}: ${ms(v)}`} style={{ flex: `${v} 0 0`, background: PHASE[k].color, minWidth: v > 0 ? 3 : 0, display: "grid", placeItems: "center", color: "white", fontSize: 12, fontWeight: 600 }}>
                    {e2e && v / e2e > 0.09 ? ms(v) : ""}
                  </div>
                ))}
              </div>
              <Legend items={Object.values(PHASE)} />
            </div>
          </div>

          <div className="grid g2">
            <div className="card">
              <div className="card-head"><div><h2>Step by step</h2><p>What runs at each stage, and the code or setting responsible.</p></div></div>
              <div className="card-body">
                <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
                  {steps.map((st, i) => (
                    <li key={i} style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 10, padding: "8px 0", borderTop: i ? "1px solid var(--border)" : undefined }}>
                      <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent)", fontSize: 12, fontWeight: 700, display: "grid", placeItems: "center" }}>{i + 1}</span>
                      <div>
                        <div className="row" style={{ gap: 8 }}><b>{st.title}</b><span className="spacer" /><span className="mono small muted">{st.t}</span></div>
                        <div className="small secondary">{st.body}</div>
                        <code className="small muted">{st.code}</code>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><div><h2>Every request in the first repeat</h2><p>Bars start when the request was sent. With more concurrency, watch the wait and prefill segments.</p></div></div>
              <div className="card-body">
                <Legend items={Object.values(PHASE)} />
                <ResponsiveContainer width="100%" height={Math.max(180, lanes.length * 30 + 50)}>
                  <BarChart data={lanes} layout="vertical" margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap={5}>
                    <CartesianGrid horizontal={false} stroke="var(--grid)" />
                    <XAxis type="number" stroke="var(--border-strong)" tickLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(1)}s`} />
                    <YAxis type="category" dataKey="name" stroke="var(--border-strong)" tickLine={false} width={36} />
                    <Tooltip cursor={{ fill: "var(--surface-2)" }} content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const p = payload[0].payload;
                      return (
                        <div className="tooltip">
                          <div className="t-title">Request {p.name}</div>
                          {(["wait", "prefill", "decode"] as const).map((k) => <div className="t-row" key={k}><span><i style={{ background: PHASE[k].color }} />{PHASE[k].label}</span><b>{ms(p[k])}</b></div>)}
                          <div className="t-row"><span>Decode speed</span><b>{p.r.decode_tps?.toFixed(1) ?? "–"} tok/s</b></div>
                        </div>
                      );
                    }} />
                    <Bar dataKey="start" stackId="a" fill="transparent" isAnimationActive={false} />
                    <Bar dataKey="wait" stackId="a" fill={PHASE.wait.color} stroke="var(--surface-1)" strokeWidth={1} isAnimationActive={false} />
                    <Bar dataKey="prefill" stackId="a" fill={PHASE.prefill.color} stroke="var(--surface-1)" strokeWidth={1} isAnimationActive={false} />
                    <Bar dataKey="decode" stackId="a" fill={PHASE.decode.color} stroke="var(--surface-1)" strokeWidth={1} radius={[0, 4, 4, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
