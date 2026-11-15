import { useMemo, useState } from "react";
import { aggregate, defaultFilter, dimValue, dimValues, type ConfigAgg, type DimKey } from "../../agg";
import { api } from "../../api";
import { useAsync } from "../../hooks";

/** The latest sweep with data (or a chosen one), aggregated, plus a per-dimension selection. */
export function useSweepSelection(dims: DimKey[]) {
  const sweeps = useAsync(api.sweeps);
  const [sid, setSid] = useState<string | null>(null);
  const id = sid ?? sweeps.data?.find((s) => s.done_runs > 0)?.id ?? null;
  const detail = useAsync(() => (id ? api.sweep(id) : Promise.resolve(null)), [id]);
  const requests = useAsync(() => (id ? api.requests(id) : Promise.resolve([])), [id]);
  const configs = useMemo(() => (detail.data ? aggregate(detail.data.runs) : []), [detail.data]);
  const [pick, setPick] = useState<Partial<Record<DimKey, string | number>>>({});
  const value = (d: DimKey) => {
    const v = pick[d];
    return v != null && dimValues(configs, d).includes(v) ? v : defaultFilter(configs, d);
  };
  const config: ConfigAgg | undefined = configs.find((c) => dims.every((d) => dimValue(c, d) === value(d)));
  return {
    sweeps: sweeps.data ?? [], id, setSid, meta: detail.data?.meta ?? null, configs, requests: requests.data ?? [],
    value, set: (d: DimKey, v: string | number) => setPick((p) => ({ ...p, [d]: v })), config,
  };
}
