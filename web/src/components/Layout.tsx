import { Activity, BarChart3, Bot, GitCompareArrows, LayoutDashboard, Monitor, Moon, Network, Play, Router, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useLive } from "../live";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("ibench-theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("ibench-theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return [theme, setTheme];
}

export function Layout({ children }: { children: ReactNode }) {
  const live = useLive();
  const [theme, setTheme] = useTheme();
  const running = live.status === "running";
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Activity size={16} strokeWidth={2.5} /></div>
          <div>
            <div className="brand-name">ibench</div>
            <div className="brand-sub">LLM inference on llama.cpp</div>
          </div>
        </div>
        <nav className="nav">
          <NavLink to="/" end><LayoutDashboard size={16} />Overview</NavLink>
          <NavLink to="/architecture"><Network size={16} />Architecture</NavLink>
          <NavLink to="/run"><Play size={16} />New sweep</NavLink>
          <NavLink to="/live"><Activity size={16} />Live{running && <span className="live-dot" title="A sweep is running" />}</NavLink>
          <NavLink to="/results"><BarChart3 size={16} />Results</NavLink>
          <NavLink to="/compare"><GitCompareArrows size={16} />Compare</NavLink>
          <NavLink to="/gateway"><Router size={16} />Gateway</NavLink>
          <NavLink to="/agent"><Bot size={16} />Agent traffic</NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="theme-toggle" role="group" aria-label="Theme">
            <button className={theme === "system" ? "on" : ""} onClick={() => setTheme("system")} title="Match system"><Monitor size={14} /></button>
            <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")} title="Light"><Sun size={14} /></button>
            <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")} title="Dark"><Moon size={14} /></button>
          </div>
          <span>{live.connected ? "Connected to backend" : "Backend offline: run `ibench serve`"}</span>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, unit, sub, icon }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">{icon}{label}</div>
      <div className="stat-value">{value}{unit && <span className="stat-unit">{unit}</span>}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const cls = status === "completed" ? "good" : status === "running" ? "info" : status === "failed" ? "crit" : "warn";
  return <span className={`badge ${cls}`}>{status}</span>;
}
