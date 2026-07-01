import * as React from "react";
import { cn } from "@/lib/utils";

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Minimal range slider styled to match the theme. Uses the native <input
 * type="range"> for keyboard + screen-reader support, with a CSS-styled track
 * + thumb. No extra dependency (radix-slider not in package.json).
 */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  className,
  ...rest
}: SliderProps): React.ReactElement {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn(
        "tp-slider h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      style={{
        background: `linear-gradient(to right, var(--primary) 0%, var(--primary) ${pct}%, var(--input) ${pct}%, var(--input) 100%)`,
      }}
      {...rest}
    />
  );
}