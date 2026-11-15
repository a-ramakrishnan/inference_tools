import { Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { PageHead } from "../components/Layout";
import { fmtDuration, useAsync } from "../hooks";
import type { SweepSpec } from "../types";

const PROMPTS = [200, 1000, 2000, 4000];
const CONC = [1, 2, 4, 8, 16];

function runsOf(spec: Partial<SweepSpec>) {
  return (spec.threads?.length ?? 1) * (spec.prompt_tokens?.length ?? 1) * (spec.concurrency?.length ?? 1) * (spec.repeats ?? 1) * 2;
}

function toggle<T>(xs: T[], v: T): T[] {
  return xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v];
}

/** A rough time estimate from the CPU speeds of the first measurement. Real runs replace it quickly. */
function estimateSeconds(spec: SweepSpec): number {
  const prefill = spec.gpu_layers > 0 ? 1500 : 120;   // tok/s
  const decode = spec.gpu_layers > 0 ? 90 : 50;
  let s = 0;
  for (const p of spec.prompt_tokens)
    for (const c of spec.concurrency) {
      const run = (p * c) / prefill + spec.n_predict / (decode / (1 + 0.12 * (c - 1)));
      s += run * spec.repeats * spec.models.length * spec.threads.length;
    }
  const runs = spec.models.length * spec.threads.length * spec.prompt_tokens.length * spec.concurrency.length * spec.repeats;
  return s + spec.models.length * spec.threads.length * spec.concurrency.length * 3 + runs * (spec.cooldown_s ?? 0);
}

export default function Run() {
  const sys = useAsync(api.system);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [spec, setSpec] = useState<SweepSpec | null>(null);
  const [preset, setPreset] = useState<string>(params.get("preset") ?? "smoke");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyPreset = (id: string) => {
    if (!sys.data) return;
    const p = sys.data.presets[id];
    const all = sys.data.models.map((m) => m.file);
    const models = p.spec.models?.length ? p.spec.models.filter((m) => all.includes(m)) : all;
    setPreset(id);
    setSpec({
      models, threads: p.spec.threads ?? ["all_p"], prompt_tokens: p.spec.prompt_tokens ?? [200],
      concurrency: p.spec.concurrency ?? [1], repeats: p.spec.repeats ?? 3, n_predict: p.spec.n_predict ?? 200,
      gpu_layers: p.spec.gpu_layers ?? 0, hourly_cost: null, label: p.name,
      cooldown_s: sys.data.machine.cpu.startsWith("Apple") && runsOf(p.spec) > 6 ? 10 : 0, control_run: true,
    });
  };
  useEffect(() => { if (sys.data && !spec) applyPreset(preset); }, [sys.data]); // eslint-disable-line

  const runs = spec ? spec.models.length * spec.threads.length * spec.prompt_tokens.length * spec.concurrency.length * spec.repeats : 0;
  const est = useMemo(() => (spec ? estimateSeconds(spec) : 0), [spec]);
  const update = (patch: Partial<SweepSpec>) => { setSpec((s) => (s ? { ...s, ...patch } : s)); setPreset("custom"); };

  const start = async () => {
    if (!spec) return;
    setBusy(true); setErr(null);
    try {
      await api.start(spec);
      nav("/live");
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (sys.error) return <div className="card empty"><h2>Backend offline</h2><p>Start it with <code>ibench serve</code>.</p></div>;
  if (!sys.data || !spec) return <div className="muted">Loading…</div>;
  const d = sys.data;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHead title="New sweep" sub="Pick a preset or build a grid. Every combination runs, each repeated, and the server restarts whenever the model, threads, concurrency or device changes so that memory belongs to that configuration." />

      <div className="grid g4">
        {Object.entries(d.presets).map(([id, p]) => (
          <button key={id} className="card card-pad" onClick={() => applyPreset(id)}
            style={{ textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit", borderColor: preset === id ? "var(--accent)" : undefined, outline: preset === id ? "1px solid var(--accent)" : "none" }}>
            <h2>{p.name}</h2>
            <p className="small secondary" style={{ margin: "4px 0 0" }}>{p.description}</p>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-head"><h2>Grid</h2></div>
        <div className="card-body stack">
          <Group label="Models (quantization)">
            {d.models.map((m) => (
              <button key={m.file} className={`chip ${spec.models.includes(m.file) ? "on" : ""}`} onClick={() => update({ models: toggle(spec.models, m.file) })}>
                {m.quant} <span className="muted">· {m.size_gb} GB</span>
              </button>
            ))}
          </Group>
          <Group label="Threads">
            {d.thread_presets.map((t) => (
              <button key={t.id} className={`chip ${spec.threads.includes(t.id) ? "on" : ""}`} onClick={() => update({ threads: toggle(spec.threads, t.id) })}>
                {t.label} <span className="muted">· {t.threads}</span>
              </button>
            ))}
          </Group>
          <Group label="Prompt length (tokens)">
            {PROMPTS.map((p) => (
              <button key={p} className={`chip ${spec.prompt_tokens.includes(p) ? "on" : ""}`} onClick={() => update({ prompt_tokens: toggle(spec.prompt_tokens, p) })}>{p.toLocaleString()}</button>
            ))}
          </Group>
          <Group label="Concurrent requests">
            {CONC.map((c) => (
              <button key={c} className={`chip ${spec.concurrency.includes(c) ? "on" : ""}`} onClick={() => update({ concurrency: toggle(spec.concurrency, c) })}>{c}</button>
            ))}
          </Group>
          <Group label="Device">
            <button className={`chip ${spec.gpu_layers === 0 ? "on" : ""}`} onClick={() => update({ gpu_layers: 0 })}>CPU only</button>
            <button className={`chip ${spec.gpu_layers > 0 ? "on" : ""}`} onClick={() => update({ gpu_layers: 99 })} disabled={!d.machine.gpu}>
              All layers on GPU {d.machine.gpu ? <span className="muted">· {d.machine.gpu}</span> : "(none found)"}
            </button>
          </Group>
          <div className="row" style={{ gap: 16, alignItems: "flex-end" }}>
            <label className="field">Repeats<input type="number" min={1} max={20} value={spec.repeats} onChange={(e) => update({ repeats: Math.max(1, +e.target.value) })} style={{ width: 90 }} /></label>
            <label className="field">Output tokens<input type="number" min={1} max={4096} value={spec.n_predict} onChange={(e) => update({ n_predict: Math.max(1, +e.target.value) })} style={{ width: 110 }} /></label>
            <label className="field">Instance price, $/hour (optional)<input type="number" min={0} step={0.01} value={spec.hourly_cost ?? ""} placeholder="for cost per 1M tokens" onChange={(e) => update({ hourly_cost: e.target.value ? +e.target.value : null })} style={{ width: 200 }} /></label>
            <label className="field">Cooldown between runs, s<input type="number" min={0} max={600} value={spec.cooldown_s ?? 0} onChange={(e) => update({ cooldown_s: Math.max(0, +e.target.value) })} style={{ width: 120 }} /></label>
            <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 6 }}>
              <input type="checkbox" checked={spec.control_run ?? true} onChange={(e) => update({ control_run: e.target.checked })} />Control re-run at the end
            </label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}>Label<input type="text" value={spec.label} onChange={(e) => setSpec({ ...spec, label: e.target.value })} /></label>
          </div>
        </div>
      </div>

      <div className="card card-pad row" style={{ justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 650 }}>{runs} runs <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>· roughly {fmtDuration(est)}</span></div>
          <div className="small muted">
            {spec.models.length} model{spec.models.length !== 1 && "s"} × {spec.threads.length} thread setting{spec.threads.length !== 1 && "s"} × {spec.prompt_tokens.length} prompt length{spec.prompt_tokens.length !== 1 && "s"} × {spec.concurrency.length} concurrency level{spec.concurrency.length !== 1 && "s"} × {spec.repeats} repeat{spec.repeats !== 1 && "s"}. The time is a rough guess from first-measurement speeds. On a fanless laptop, sustained runs throttle: the cooldown and the control re-run make that visible instead of silent.
          </div>
          {err && <div className="small" style={{ color: "var(--critical)", marginTop: 6 }}>{err}</div>}
        </div>
        <button className="btn primary" onClick={start} disabled={busy || runs === 0 || !!d.active_sweep}>
          <Play size={15} />{d.active_sweep ? "A sweep is running" : "Start sweep"}
        </button>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <div className="small secondary" style={{ width: 170, paddingTop: 6, fontWeight: 500 }}>{label}</div>
      <div className="row" style={{ flex: 1, gap: 8 }}>{children}</div>
    </div>
  );
}
