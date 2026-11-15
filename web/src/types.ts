export interface Machine {
  label: string;
  cpu: string;
  arch: string;
  os: string;
  performance_cores: number;
  efficiency_cores: number;
  physical_cores: number;
  logical_cores: number;
  memory_gb: number;
  gpu: string | null;
  llama_cpp: string | null;
}

export interface ModelMeta {
  name?: string;
  architecture?: string;
  layers?: number;
  embedding?: number;
  heads?: number;
  kv_heads?: number;
  head_dim?: number;
  context_train?: number;
  ffn?: number;
  vocab?: number;
  kv_bytes_per_token_f16?: number;
  error?: string;
}

export interface ModelFile {
  file: string;
  quant: string;
  size_gb: number;
  size_gib?: number;
  meta?: ModelMeta;
}

export interface SweepSpec {
  models: string[];
  threads: (string | number)[];
  prompt_tokens: number[];
  concurrency: number[];
  repeats: number;
  n_predict: number;
  gpu_layers: number;
  hourly_cost: number | null;
  cooldown_s?: number;
  control_run?: boolean;
  label: string;
}

export interface Preset {
  name: string;
  description: string;
  spec: Partial<SweepSpec>;
}

export interface SystemInfo {
  machine: Machine;
  models: ModelFile[];
  thread_presets: { id: string; label: string; threads: number }[];
  presets: Record<string, Preset>;
  active_sweep: string | null;
}

export interface SweepSummary {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed" | "interrupted";
  started_at: string;
  finished_at?: string;
  duration_s?: number;
  total_runs: number;
  done_runs: number;
  error?: string | null;
  label: string;
  machine: string;
  arch: string;
  spec: SweepSpec;
}

export interface ControlRun {
  run_id: string;
  first: Record<string, number | null>;
  last: Record<string, number | null>;
  drift_pct: Record<string, number | null>;
  thermal_first?: string | null;
  thermal_last?: string | null;
}

export interface SweepMeta extends Omit<SweepSummary, "machine" | "label" | "arch"> {
  machine: Machine;
  control?: ControlRun;
  thermal_at_start?: string | null;
  thermal_at_end?: string | null;
}

export interface RunRow {
  sweep_id: string;
  run_id: string;
  machine: string;
  arch: string;
  model: string;
  quant: string;
  device: string;
  threads_preset: string;
  threads: number;
  prompt_tokens_target: number;
  prompt_tokens: number;
  output_tokens: number;
  concurrency: number;
  repeat: number;
  ttft_ms_p50: number | null;
  ttft_ms_mean: number | null;
  ttft_ms_max: number | null;
  decode_tps_mean: number | null;
  decode_tps_min: number | null;
  total_tps: number | null;
  e2e_ms_mean: number | null;
  wall_s: number;
  server_prompt_tps_mean: number | null;
  server_decode_tps_mean: number | null;
  rss_peak_gb: number | null;
  mem_peak_gb: number | null;
  server_load_s: number;
  cost_per_m_tokens: number | null;
  thermal?: string | null;
  system_cpu_pct?: number | null;
  server_cpu_pct?: number | null;
  other_cpu_pct?: number | null;
  errors: number;
  timestamp: string;
}

export interface RequestRow {
  sweep_id: string;
  run_id: string;
  request_index: number;
  prompt_tokens: number;
  output_tokens: number;
  ttft_ms: number;
  e2e_ms: number;
  decode_tps: number | null;
  server_prompt_ms: number | null;
  server_prompt_tps: number | null;
  server_decode_tps: number | null;
  start_offset_ms: number;
  error: string | null;
}

export interface LiveEvent {
  seq: number;
  type: string;
  t: number;
  data: any;
}
