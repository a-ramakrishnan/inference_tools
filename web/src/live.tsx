import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import type { LiveEvent, Machine, RunRow, SweepSpec } from "./types";

export interface LiveServer {
  quant: string;
  threads: number;
  threads_preset: string;
  concurrency: number;
  device: string;
  args: string[];
  ready: boolean;
  load_s?: number;
  label?: string;
}

export interface LiveState {
  connected: boolean;
  lastSeq: number;
  sweepId: string | null;
  status: "idle" | "running" | "completed" | "cancelled" | "failed";
  total: number;
  done: number;
  machine: Machine | null;
  spec: SweepSpec | null;
  startedAt: number | null;
  server: LiveServer | null;
  currentRun: { run_id: string; concurrency: number; prompt_tokens: number; repeat: number; quant: string; threads: number } | null;
  progress: Record<number, number>;
  runs: RunRow[];
  memory: { t: number; rss_gb: number; server: string }[];
  log: { t: number; text: string; kind?: "error" | "ok" }[];
  error: string | null;
  thermal: string | null;
  control: any | null;
  phase: string | null;
}

const initial: LiveState = {
  connected: false, lastSeq: 0, sweepId: null, status: "idle", total: 0, done: 0, machine: null, spec: null,
  startedAt: null, server: null, currentRun: null, progress: {}, runs: [], memory: [], log: [], error: null,
  thermal: null, control: null, phase: null,
};

type Action = { type: "connected"; value: boolean } | { type: "event"; ev: LiveEvent };

function addLog(s: LiveState, t: number, text: string, kind?: "error" | "ok") {
  return [...s.log.slice(-199), { t, text, kind }];
}

function reduce(s: LiveState, a: Action): LiveState {
  if (a.type === "connected") return { ...s, connected: a.value };
  const { ev } = a;
  if (ev.seq <= s.lastSeq) return s;
  s = { ...s, lastSeq: ev.seq };
  const d = ev.data;
  switch (ev.type) {
    case "sweep_started":
      return {
        ...initial, connected: s.connected, lastSeq: ev.seq, sweepId: d.id, status: "running", total: d.total_runs,
        machine: d.machine, spec: d.spec, startedAt: ev.t,
        log: [{ t: ev.t, text: `Sweep ${d.id} started: ${d.total_runs} runs on ${d.machine.label}` }],
      };
    case "server_starting":
      return { ...s, server: { ...d, ready: false }, log: addLog(s, ev.t, `Starting llama-server · ${d.quant} · ${d.threads} threads · ${d.concurrency} slots · ${d.device.toUpperCase()}`) };
    case "server_ready":
      return { ...s, server: s.server && { ...s.server, ready: true, load_s: d.load_s, label: d.label }, log: addLog(s, ev.t, `Server ready in ${d.load_s}s`, "ok") };
    case "server_stopped":
      return { ...s, server: null, currentRun: null };
    case "run_started":
      return { ...s, currentRun: d, progress: {}, phase: null };
    case "cooldown":
      return { ...s, phase: `Cooling down for ${d.seconds}s`, log: addLog(s, ev.t, `Cooling down ${d.seconds}s`) };
    case "control_started":
      return { ...s, phase: `Control re-run of ${d.run_id}`, log: addLog(s, ev.t, `Control re-run of ${d.run_id} (checks for drift)`) };
    case "control_done": {
      const dp = d.drift_pct;
      const bad = Math.abs(dp.decode_tps_mean ?? 0) > 10 || Math.abs(dp.ttft_ms_p50 ?? 0) > 15;
      return { ...s, control: d, phase: null, log: addLog(s, ev.t, `Control: TTFT ${dp.ttft_ms_p50 > 0 ? "+" : ""}${dp.ttft_ms_p50}% · tok/s/req ${dp.decode_tps_mean > 0 ? "+" : ""}${dp.decode_tps_mean}% vs the first run`, bad ? "error" : "ok") };
    }
    case "token_progress":
      return { ...s, progress: { ...s.progress, [d.request]: d.tokens } };
    case "run_done": {
      const r: RunRow = d.row;
      return {
        ...s, done: d.done, runs: [...s.runs, r], currentRun: null, thermal: r.thermal ?? s.thermal,
        log: addLog(s, ev.t, `${r.run_id}: TTFT ${Math.round(r.ttft_ms_p50 ?? 0)} ms · ${r.decode_tps_mean?.toFixed(1)} tok/s/req · ${r.total_tps?.toFixed(1)} tok/s total`),
      };
    }
    case "memory":
      return { ...s, memory: s.memory.length > 6000 ? [...s.memory.filter((_, i) => i % 2 === 0), d] : [...s.memory, d] };
    case "error":
      return { ...s, error: d.message, log: addLog(s, ev.t, d.message, "error") };
    case "sweep_done":
      return { ...s, status: d.status, server: null, currentRun: null, log: addLog(s, ev.t, `Sweep ${d.status} · ${d.done} runs saved`, d.status === "completed" ? "ok" : "error") };
    default:
      return s;
  }
}

const Ctx = createContext<LiveState>(initial);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initial);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => dispatch({ type: "connected", value: true });
    es.onerror = () => dispatch({ type: "connected", value: false });
    es.onmessage = (m) => {
      try {
        dispatch({ type: "event", ev: JSON.parse(m.data) });
      } catch {
        /* ignore malformed */
      }
    };
    return () => es.close();
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);
