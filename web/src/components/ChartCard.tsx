import { useMemo, useState, type ReactNode } from "react";
import { DIMS, METRICS, defaultFilter, dimValue, dimValues, fmtDim, type ConfigAgg, type DimKey, type MetricKey } from "../agg";
import { SeriesChart } from "./Charts";

export interface ChartDef {
  title: string;
  hint?: ReactNode;
  metric: MetricKey;
  x: DimKey;
  series: DimKey | null;
}

const ALL_DIMS = Object.keys(DIMS) as DimKey[];

/** A chart plus one filter row for every dimension that is neither on the x-axis nor a series and varies. */
export function ChartCard({ def, configs, editable = false }: { def: ChartDef; configs: ConfigAgg[]; editable?: boolean }) {
  const [metric, setMetric] = useState<MetricKey>(def.metric);
  const [x, setX] = useState<DimKey>(def.x);
  const [series, setSeries] = useState<DimKey | null>(def.series);
  const [filters, setFilters] = useState<Partial<Record<DimKey, string | number>>>({});

  const held = ALL_DIMS.filter((d) => d !== x && d !== series && dimValues(configs, d).length > 1);
  const filtered = useMemo(
    () => configs.filter((c) => held.every((d) => dimValue(c, d) === (filters[d] ?? defaultFilter(configs, d)))),
    [configs, held.join(), filters], // eslint-disable-line
  );
  const hasMetric = configs.some((c) => c.m[metric]);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>{editable ? "Chart explorer" : def.title}</h2>
          <p>{editable ? "Any metric against any setting. Points are the mean over repeats; whiskers span the fastest and slowest repeat." : def.hint}</p>
        </div>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {(editable || held.length > 0) && (
          <div className="filters">
            {editable && (
              <>
                <label className="field">Metric
                  <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
                    {(Object.keys(METRICS) as MetricKey[]).map((k) => <option key={k} value={k}>{METRICS[k].label}</option>)}
                  </select>
                </label>
                <label className="field">X axis
                  <select value={x} onChange={(e) => { const v = e.target.value as DimKey; setX(v); if (v === series) setSeries(null); }}>
                    {ALL_DIMS.map((d) => <option key={d} value={d}>{DIMS[d]}</option>)}
                  </select>
                </label>
                <label className="field">Series
                  <select value={series ?? ""} onChange={(e) => setSeries((e.target.value || null) as DimKey | null)}>
                    <option value="">None</option>
                    {ALL_DIMS.filter((d) => d !== x).map((d) => <option key={d} value={d}>{DIMS[d]}</option>)}
                  </select>
                </label>
              </>
            )}
            {held.map((d) => (
              <label className="field" key={d}>{DIMS[d]}
                <select value={String(filters[d] ?? defaultFilter(configs, d))}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const v = dimValues(configs, d).find((x) => String(x) === raw);
                    setFilters((f) => ({ ...f, [d]: v }));
                  }}>
                  {dimValues(configs, d).map((v) => <option key={String(v)} value={String(v)}>{fmtDim(d, v, configs)}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}
        {hasMetric ? (
          <SeriesChart configs={filtered} allConfigs={configs} metric={metric} x={x} series={series} />
        ) : (
          <div className="empty small">{METRICS[metric].label} was not recorded in this sweep{metric === "cost_per_m_tokens" && " (set an instance price when starting a sweep)"}.</div>
        )}
      </div>
    </div>
  );
}
