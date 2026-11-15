import type { RunRow } from "./types";

/** Metrics that can be charted. `better` says which direction is good, for "best" tiles. */
export const METRICS = {
  ttft_ms_p50: { label: "Time to first token", short: "TTFT p50", unit: "ms", better: "lower", digits: 0 },
  decode_tps_mean: { label: "Tokens/s per request", short: "tok/s/req", unit: "tok/s", better: "higher", digits: 1 },
  total_tps: { label: "Total tokens/s (all requests)", short: "total tok/s", unit: "tok/s", better: "higher", digits: 1 },
  mem_peak_gb: { label: "Peak memory", short: "peak mem", unit: "GiB", better: "lower", digits: 2 },
  e2e_ms_mean: { label: "End-to-end latency", short: "e2e", unit: "ms", better: "lower", digits: 0 },
  server_prompt_tps_mean: { label: "Prompt processing (prefill)", short: "prefill tok/s", unit: "tok/s", better: "higher", digits: 0 },
  cost_per_m_tokens: { label: "Cost per 1M output tokens", short: "$/1M", unit: "$", better: "lower", digits: 3 },
} as const;
export type MetricKey = keyof typeof METRICS;

export const DIMS = {
  quant: "Quantization",
  threads_preset: "Threads",
  prompt_tokens_target: "Prompt length",
  concurrency: "Concurrent requests",
  device: "Device",
  machine: "Machine",
} as const;
export type DimKey = keyof typeof DIMS;

export interface Stat {
  mean: number;
  min: number;
  max: number;
  n: number;
}

export interface ConfigAgg {
  key: string;
  quant: string;
  threads_preset: string;
  threads: number;
  prompt_tokens_target: number;
  concurrency: number;
  device: string;
  machine: string;
  sweep_id: string;
  repeats: number;
  m: Partial<Record<MetricKey, Stat>>;
  runs: RunRow[];
}

const THREAD_ORDER: Record<string, number> = { half_p: 0, all_p: 1, all: 2 };

export function metricValue(r: RunRow, k: MetricKey): number | null {
  if (k === "mem_peak_gb") return r.mem_peak_gb ?? r.rss_peak_gb;
  const v = r[k as keyof RunRow];
  return typeof v === "number" ? v : null;
}

function stat(xs: number[]): Stat | undefined {
  if (!xs.length) return undefined;
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

/** One entry per configuration, with mean / min / max over its repeats. */
export function aggregate(runs: RunRow[]): ConfigAgg[] {
  const groups = new Map<string, RunRow[]>();
  for (const r of runs) {
    const key = [r.sweep_id, r.machine, r.device, r.quant, r.threads_preset, r.prompt_tokens_target, r.concurrency].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const out: ConfigAgg[] = [];
  for (const [key, rs] of groups) {
    const r0 = rs[0];
    const m: ConfigAgg["m"] = {};
    for (const k of Object.keys(METRICS) as MetricKey[]) {
      const s = stat(rs.map((r) => metricValue(r, k)).filter((v): v is number => v != null));
      if (s) m[k] = s;
    }
    out.push({
      key, quant: r0.quant, threads_preset: String(r0.threads_preset), threads: r0.threads,
      prompt_tokens_target: r0.prompt_tokens_target, concurrency: r0.concurrency, device: r0.device,
      machine: r0.machine, sweep_id: r0.sweep_id, repeats: rs.length, m, runs: rs,
    });
  }
  return out.sort(compareConfigs);
}

export function compareConfigs(a: ConfigAgg, b: ConfigAgg) {
  return (
    a.machine.localeCompare(b.machine) || a.device.localeCompare(b.device) || a.quant.localeCompare(b.quant) ||
    (THREAD_ORDER[a.threads_preset] ?? a.threads) - (THREAD_ORDER[b.threads_preset] ?? b.threads) ||
    a.prompt_tokens_target - b.prompt_tokens_target || a.concurrency - b.concurrency
  );
}

export function dimValue(c: ConfigAgg, d: DimKey): string | number {
  return c[d];
}

export function dimValues(configs: ConfigAgg[], d: DimKey): (string | number)[] {
  const vals = Array.from(new Set(configs.map((c) => dimValue(c, d))));
  return vals.sort((a, b) => {
    if (d === "threads_preset") return (THREAD_ORDER[String(a)] ?? 9) - (THREAD_ORDER[String(b)] ?? 9) || String(a).localeCompare(String(b));
    return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
  });
}

export const THREAD_LABEL: Record<string, string> = { half_p: "Half P-cores", all_p: "All P-cores", all: "All cores" };

export function fmtDim(d: DimKey, v: string | number, configs?: ConfigAgg[]): string {
  if (d === "threads_preset") {
    const t = configs?.find((c) => c.threads_preset === v)?.threads;
    return `${THREAD_LABEL[String(v)] ?? v}${t != null ? ` (${t})` : ""}`;
  }
  if (d === "prompt_tokens_target") return `${Number(v).toLocaleString()} tok prompt`;
  if (d === "concurrency") return `${v} concurrent`;
  if (d === "device") return v === "gpu" ? "GPU" : "CPU";
  return String(v);
}

export function fmt(v: number | null | undefined, k: MetricKey | null = null, withUnit = false): string {
  if (v == null || Number.isNaN(v)) return "–";
  const digits = k ? METRICS[k].digits : 1;
  const s = v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: k === "mem_peak_gb" ? 2 : 0 });
  if (!withUnit || !k) return s;
  const u = METRICS[k].unit;
  return u === "$" ? `$${s}` : `${s} ${u}`;
}

/** Pick a sensible default value for a dimension that is held fixed. */
export function defaultFilter(configs: ConfigAgg[], d: DimKey): string | number | undefined {
  const vals = dimValues(configs, d);
  if (d === "threads_preset" && vals.includes("all_p")) return "all_p";
  if (d === "concurrency" && vals.includes(1)) return 1;
  return vals[0];
}
