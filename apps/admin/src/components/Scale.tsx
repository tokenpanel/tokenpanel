import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Graduated scale — the console's signature instrument. A printed tick ruler
 * with a single indicator needle, read like an appliance dial. Use it only for
 * real ratios the API returns (cache hit rate, margin, share of spend); never
 * for values the backend does not provide.
 */

type Tone = "signal" | "success" | "warning" | "destructive" | "muted";

const TONE_VAR: Record<Tone, string> = {
  signal: "var(--signal)",
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
  muted: "var(--muted-foreground)",
};

export interface ScaleProps {
  /** 0..1; clamped. `null` renders the ruler with no needle (no data). */
  value: number | null;
  /** Accessible name, e.g. "Cache hit rate". */
  label: string;
  /** Spoken value, e.g. "42.1%". */
  valueText?: string;
  /** Number of major divisions. */
  divisions?: number;
  /** Minor ticks per major division. */
  minor?: number;
  /** Printed labels under the ruler, spread evenly from 0 to 1. */
  marks?: readonly string[];
  size?: "md" | "sm";
  tone?: Tone;
  className?: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Settles the needle from zero once on mount (reduced motion: instant via global CSS). */
function useSettled(target: number): number {
  const [pos, setPos] = React.useState(0);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setPos(target));
    return () => cancelAnimationFrame(id);
  }, [target]);
  return pos;
}

export function Scale({
  value,
  label,
  valueText,
  divisions = 10,
  minor = 5,
  marks,
  size = "md",
  tone = "signal",
  className,
}: ScaleProps): React.ReactElement {
  const v = value === null ? null : clamp01(value);
  const pos = useSettled(v ?? 0);
  const sm = size === "sm";
  const total = divisions * minor;
  const ticks: React.ReactElement[] = [];
  for (let i = 0; i <= total; i += 1) {
    const x = (i / total) * 1000;
    const major = i % minor === 0;
    const half = !major && minor % 2 === 0 && i % (minor / 2) === 0;
    const h = sm ? (major ? 7 : 4) : major ? 11 : half ? 8 : 5;
    ticks.push(
      <line
        key={i}
        x1={x}
        x2={x}
        y1={(sm ? 8 : 12) - h}
        y2={sm ? 8 : 12}
        stroke="currentColor"
        strokeWidth={major ? 1.25 : 1}
        vectorEffect="non-scaling-stroke"
        opacity={major ? 0.75 : 0.4}
      />,
    );
  }
  const color = TONE_VAR[tone];
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v === null ? undefined : Math.round(v * 100)}
      aria-valuetext={valueText}
      className={cn("relative w-full select-none text-muted-foreground", className)}
    >
      <div className={cn("relative", sm ? "h-[10px]" : "h-[16px]")}>
        <svg
          className="absolute inset-x-0 top-0 h-full w-full overflow-visible"
          viewBox={`0 0 1000 ${sm ? 10 : 16}`}
          preserveAspectRatio="none"
          aria-hidden
        >
          {ticks}
          <line
            x1={0}
            x2={1000}
            y1={sm ? 9.5 : 15.5}
            y2={sm ? 9.5 : 15.5}
            stroke="currentColor"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            opacity={0.5}
          />
        </svg>
        {v !== null ? (
          <>
            <span
              aria-hidden
              className="absolute bottom-0 left-0 h-[3px] rounded-[1px] transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ width: `${pos * 100}%`, background: color, opacity: 0.85 }}
            />
            <span
              aria-hidden
              className={cn(
                "absolute bottom-[-3px] w-[2px] -translate-x-1/2 rounded-full transition-[left] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
                sm ? "top-[-3px]" : "top-[-5px]",
              )}
              style={{ left: `${pos * 100}%`, background: color }}
            />
          </>
        ) : null}
      </div>
      {marks && marks.length > 1 ? (
        <div className="mt-1.5 flex justify-between text-[10.5px] leading-none tabular-nums text-muted-foreground">
          {marks.map((m, i) => (
            <span
              key={`${m}-${i}`}
              className={cn(
                i === 0 && "-ml-px",
                i === marks.length - 1 && "-mr-px",
              )}
            >
              {m}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface WindowMarker {
  key: string;
  windowSeconds: number;
  /** Short printed caption, e.g. "250k tok". */
  caption: string;
  active?: boolean;
}

const RULER_MIN = 3600; // 1h
const RULER_MAX = 2592000; // 30d
const RULER_STOPS: ReadonlyArray<{ s: number; label: string }> = [
  { s: 3600, label: "1h" },
  { s: 18000, label: "5h" },
  { s: 86400, label: "1d" },
  { s: 604800, label: "1w" },
  { s: 2592000, label: "30d" },
];

/** Log-time position of a rolling window on the 1h → 30d ruler (clamped). */
export function windowPosition(seconds: number): number {
  const s = Math.min(RULER_MAX, Math.max(RULER_MIN, seconds));
  return Math.log(s / RULER_MIN) / Math.log(RULER_MAX / RULER_MIN);
}

/**
 * Rolling-limit windows drawn on a logarithmic time ruler (1h · 5h · 1d · 1w ·
 * 30d). Each configured rule is a needle with its cap printed beside it, so a
 * plan's guardrails read as one instrument instead of a list of sentences.
 */
export function WindowRuler({
  markers,
  className,
  size = "md",
}: {
  markers: readonly WindowMarker[];
  className?: string;
  size?: "md" | "lg";
}): React.ReactElement {
  const lg = size === "lg";
  // Stack captions that would collide (same or near-identical position).
  const placed = [...markers]
    .sort((a, b) => a.windowSeconds - b.windowSeconds)
    .map((m) => ({ ...m, x: windowPosition(m.windowSeconds) }));
  const rows: number[] = [];
  let lastX = -1;
  let row = 0;
  for (const p of placed) {
    row = p.x - lastX < 0.22 ? row + 1 : 0;
    rows.push(row);
    lastX = p.x;
  }
  const maxRow = rows.length ? Math.max(...rows) : 0;
  const minorTicks: number[] = [];
  for (let i = 0; i <= 60; i += 1) minorTicks.push(i / 60);
  return (
    <div className={cn("relative w-full text-muted-foreground", className)}>
      <div className="relative" style={{ height: `${22 + maxRow * 16}px` }}>
        {placed.map((p, i) => {
          const r = rows[i] ?? 0;
          const right = p.x > 0.7;
          return (
            <div
              key={p.key}
              className="absolute bottom-0"
              style={{ left: `${p.x * 100}%` }}
            >
              <span
                aria-hidden
                className={cn("absolute w-[2px] -translate-x-1/2 rounded-full", lg ? "bottom-[-18px]" : "bottom-[-12px]", p.active === false ? "bg-muted-foreground/50" : "bg-signal")}
                style={{ height: `${(lg ? 40 : 26) + r * 16}px` }}
              />
              <span
                className={cn(
                  "absolute whitespace-nowrap text-[11px] font-medium leading-none tabular-nums",
                  p.active === false ? "text-muted-foreground line-through" : "text-foreground",
                  right ? "right-[6px]" : "left-[6px]",
                )}
                style={{ bottom: `${4 + r * 16}px` }}
              >
                {p.caption}
              </span>
            </div>
          );
        })}
      </div>
      <svg className={cn("mt-[2px] w-full overflow-visible", lg ? "h-[16px]" : "h-[10px]")} viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden>
        {minorTicks.map((t) => (
          <line key={t} x1={t * 1000} x2={t * 1000} y1={5} y2={10} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.35} />
        ))}
        {RULER_STOPS.map((stop) => {
          const x = windowPosition(stop.s) * 1000;
          return <line key={stop.s} x1={x} x2={x} y1={0} y2={10} stroke="currentColor" strokeWidth={1.25} vectorEffect="non-scaling-stroke" opacity={0.8} />;
        })}
        <line x1={0} x2={1000} y1={9.5} y2={9.5} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.5} />
      </svg>
      <div className={cn("relative mt-1.5 leading-none tabular-nums", lg ? "h-4 text-[12px]" : "h-3 text-[10.5px]")}>
        {RULER_STOPS.map((stop, i) => (
          <span
            key={stop.s}
            className={cn("absolute", i === 0 ? "" : i === RULER_STOPS.length - 1 ? "-translate-x-full" : "-translate-x-1/2")}
            style={{ left: `${windowPosition(stop.s) * 100}%` }}
          >
            {stop.label}
          </span>
        ))}
      </div>
    </div>
  );
}
