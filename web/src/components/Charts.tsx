import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ErrorBar, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useMemo } from "react";
import { DIMS, METRICS, dimValue, dimValues, fmt, fmtDim, type ConfigAgg, type DimKey, type MetricKey } from "../agg";

export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];

const axisProps = { stroke: "var(--border-strong)", tickLine: false, axisLine: { stroke: "var(--border-strong)" } } as const;

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <div className="legend">
      {items.map((it) => (
        <span key={it.label}><i style={{ background: it.color }} />{it.label}</span>
      ))}
    </div>
  );
}

interface TipRow { label: string; color: string; value: string; sub?: string }
function Tip({ title, rows }: { title: string; rows: TipRow[] }) {
  return (
    <div className="tooltip">
      <div className="t-title">{title}</div>
      {rows.map((r) => (
        <div className="t-row" key={r.label}>
          <span><i style={{ background: r.color }} />{r.label}</span>
          <b>{r.value}{r.sub && <span className="muted" style={{ fontWeight: 400 }}> {r.sub}</span>}</b>
        </div>
      ))}
    </div>
  );
}

export interface SeriesChartProps {
  configs: ConfigAgg[];          // already filtered to what should be drawn
  allConfigs?: ConfigAgg[];      // used for stable colors: a series keeps its color when filters change
  metric: MetricKey;
  x: DimKey;
  series: DimKey | null;
  height?: number;
}

/** Lines over an ordered x dimension, one per series value, with min–max whiskers across repeats. */
export function SeriesChart({ configs, allConfigs, metric, x, series, height = 260 }: SeriesChartProps) {
  const M = METRICS[metric];
  const { data, seriesVals, colorOf } = useMemo(() => {
    const xs = dimValues(configs, x);
    const seriesVals = series ? dimValues(configs, series) : ["all"];
    const stable = series ? dimValues(allConfigs ?? configs, series) : ["all"];
    const colorOf = (v: string | number) => SERIES[Math.max(0, stable.indexOf(v)) % SERIES.length];
    const data = xs.map((xv) => {
      const row: Record<string, any> = { x: xv, xLabel: fmtDim(x, xv, configs) };
      for (const sv of seriesVals) {
        const hits = configs.filter((c) => dimValue(c, x) === xv && (!series || dimValue(c, series) === sv));
        const stats = hits.map((h) => h.m[metric]).filter(Boolean);
        if (!stats.length) continue;
        const mean = stats.reduce((a, s) => a + s!.mean, 0) / stats.length;
        const min = Math.min(...stats.map((s) => s!.min));
        const max = Math.max(...stats.map((s) => s!.max));
        row[`s_${sv}`] = mean;
        row[`e_${sv}`] = [mean - min, max - mean];
        row[`n_${sv}`] = stats.reduce((a, s) => a + s!.n, 0);
      }
      return row;
    });
    return { data, seriesVals, colorOf };
  }, [configs, allConfigs, metric, x, series]);

  if (!data.length) return <div className="empty small">No data for this selection.</div>;
  const legend = seriesVals.map((v) => ({ label: series ? fmtDim(series, v, configs) : M.label, color: colorOf(v) }));
  const single = data.length === 1;

  const tooltip = (
    <Tooltip
      cursor={single ? { fill: "var(--surface-2)" } : { stroke: "var(--border-strong)", strokeWidth: 1 }}
      content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const row = payload[0].payload;
        return (
          <Tip
            title={`${DIMS[x]}: ${row.xLabel}`}
            rows={seriesVals.filter((v) => row[`s_${v}`] != null).map((v) => ({
              label: series ? fmtDim(series, v, configs) : M.short,
              color: colorOf(v),
              value: fmt(row[`s_${v}`], metric, true),
              sub: row[`n_${v}`] > 1 ? `(${fmt(row[`s_${v}`] - row[`e_${v}`][0], metric)}–${fmt(row[`s_${v}`] + row[`e_${v}`][1], metric)}, n=${row[`n_${v}`]})` : undefined,
            }))}
          />
        );
      }}
    />
  );
  const maxY = Math.max(0, ...data.flatMap((r) => seriesVals.map((v) => (r[`s_${v}`] ?? 0) + (r[`e_${v}`]?.[1] ?? 0))));
  const inSeconds = M.unit === "ms" && maxY >= 5000;
  const yAxis = (
    <YAxis {...axisProps} width={52} tickFormatter={(v) => (inSeconds ? `${+(v / 1000).toFixed(1)}` : fmt(v, metric))} />
  );

  return (
    <div className="stack" style={{ gap: 8 }}>
      <Legend items={legend} />
      <div className="small muted" style={{ marginBottom: -6 }}>{inSeconds ? "seconds" : M.unit}</div>
      <ResponsiveContainer width="100%" height={height}>
        {single ? (
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} barGap={2}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="xLabel" {...axisProps} />
            {yAxis}
            {tooltip}
            {seriesVals.map((v) => (
              <Bar key={String(v)} dataKey={`s_${v}`} fill={colorOf(v)} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                <ErrorBar dataKey={`e_${v}`} width={6} stroke="var(--text-secondary)" strokeWidth={1.25} />
              </Bar>
            ))}
          </BarChart>
        ) : (
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="xLabel" {...axisProps} padding={{ left: 18, right: 18 }} />
            {yAxis}
            {tooltip}
            {seriesVals.map((v) => (
              <Line key={String(v)} dataKey={`s_${v}`} stroke={colorOf(v)} strokeWidth={2} isAnimationActive={false}
                dot={{ r: 4, fill: colorOf(v), stroke: "var(--surface-1)", strokeWidth: 2 }}
                activeDot={{ r: 6, stroke: "var(--surface-1)", strokeWidth: 2 }} connectNulls>
                <ErrorBar dataKey={`e_${v}`} width={5} stroke={colorOf(v)} strokeWidth={1.25} />
              </Line>
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** Server memory over time. One server per segment, so the steps line up with server restarts. */
export function MemoryChart({ points, height = 200 }: { points: { t: number; rss_gb: number; server: string }[]; height?: number }) {
  if (!points.length) return <div className="empty small">No memory samples yet.</div>;
  return (
    <>
    <div className="small muted">GiB</div>
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id="memfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} {...axisProps} tickFormatter={(v) => `${Math.round(v)}s`} />
        <YAxis {...axisProps} width={44} tickFormatter={(v) => v.toFixed(1)} />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload;
            return <Tip title={`${p.t.toFixed(1)} s · ${p.server}`} rows={[{ label: "Server RSS", color: "var(--series-1)", value: `${p.rss_gb.toFixed(3)} GiB` }]} />;
          }}
        />
        <Area type="stepAfter" dataKey="rss_gb" stroke="var(--series-1)" strokeWidth={2} fill="url(#memfill)" isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
    </>
  );
}

/** Per-request timeline for one run: waiting for the first token, then generating. */
export function RequestTimeline({ rows, height = 220 }: {
  rows: { request_index: number; start_offset_ms: number; ttft_ms: number; e2e_ms: number; decode_tps: number | null }[];
  height?: number;
}) {
  const data = rows.map((r) => ({
    name: `#${r.request_index}`, start: r.start_offset_ms, ttft: r.ttft_ms, gen: Math.max(0, r.e2e_ms - r.ttft_ms), tps: r.decode_tps,
  }));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Legend items={[{ label: "Waiting for first token (queue + prefill)", color: "var(--series-2)" }, { label: "Generating", color: "var(--series-1)" }]} />
      <ResponsiveContainer width="100%" height={Math.max(height, data.length * 26 + 40)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 0 }} barCategoryGap={4}>
          <CartesianGrid horizontal={false} stroke="var(--grid)" />
          <XAxis type="number" {...axisProps} tickFormatter={(v) => `${(v / 1000).toFixed(1)}s`} />
          <YAxis type="category" dataKey="name" {...axisProps} width={36} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload;
              return <Tip title={`Request ${p.name}`} rows={[
                { label: "Time to first token", color: "var(--series-2)", value: `${Math.round(p.ttft)} ms` },
                { label: "Generation", color: "var(--series-1)", value: `${Math.round(p.gen)} ms` },
                { label: "Decode speed", color: "transparent", value: p.tps ? `${p.tps.toFixed(1)} tok/s` : "–" },
              ]} />;
            }}
          />
          <Bar dataKey="start" stackId="a" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="ttft" stackId="a" fill="var(--series-2)" isAnimationActive={false} stroke="var(--surface-1)" strokeWidth={1} />
          <Bar dataKey="gen" stackId="a" fill="var(--series-1)" radius={[0, 4, 4, 0]} isAnimationActive={false} stroke="var(--surface-1)" strokeWidth={1} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
