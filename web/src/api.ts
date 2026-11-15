import type { RequestRow, RunRow, SweepMeta, SweepSpec, SweepSummary, SystemInfo } from "./types";

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  system: () => j<SystemInfo>("/api/system"),
  sweeps: () => j<SweepSummary[]>("/api/sweeps"),
  sweep: (id: string) => j<{ meta: SweepMeta; runs: RunRow[] }>(`/api/sweeps/${id}`),
  requests: (id: string) => j<RequestRow[]>(`/api/sweeps/${id}/requests`),
  memory: (id: string) => j<{ t: number; rss_gb: number; server: string }[]>(`/api/sweeps/${id}/memory`),
  logs: (id: string) => j<Record<string, string[]>>(`/api/sweeps/${id}/logs`),
  start: (spec: SweepSpec) =>
    j<{ id: string; total_runs: number }>("/api/sweeps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    }),
  cancel: (id: string) => j<{ ok: boolean }>(`/api/sweeps/${id}/cancel`, { method: "POST" }),
  remove: (id: string) => j<{ ok: boolean }>(`/api/sweeps/${id}`, { method: "DELETE" }),
  importZip: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return j<{ id: string }>("/api/import", { method: "POST", body: fd });
  },
  fileUrl: (id: string, name: string) => `/api/sweeps/${id}/files/${name}`,
};
