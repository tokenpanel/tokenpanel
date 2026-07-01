import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Lightweight fade-in built on the existing `@keyframes fade-in-up` defined in
 * index.css. No JS animation library — just a class + inline delay.
 *
 * Why this over `motion`/`AnimatePresence`: the old approach stacked a skeleton
 * loading state, a crossfade wrapper, AND a per-item stagger. Three layers of
 * indirection for what is, fundamentally, a one-shot opacity tween. Skeletons
 * also caused layout shift because they didn't match the real content's size.
 *
 * Now: pages render `null` while loading (header stays put as an anchor) and
 * fade content in once it arrives. Cheaper, simpler, no shift, no dependency.
 *
 * `prefers-reduced-motion` is honored via the global guard in index.css.
 */

export interface FadeInProps {
  children: React.ReactNode;
  className?: string;
  /** Delay (seconds) before the element animates in. Default 0. */
  delay?: number;
  /** Inline style passthrough. */
  style?: React.CSSProperties;
  /** Render as a different element. Default "div". */
  as?: React.ElementType;
}

export function FadeIn({
  children,
  className,
  delay = 0,
  style,
  as: Tag = "div",
}: FadeInProps): React.ReactElement {
  return (
    <Tag
      className={cn("animate-fade-in-up", className)}
      style={{ animationDelay: `${delay}s`, ...style }}
    >
      {children}
    </Tag>
  );
}

export interface StaggerItemProps {
  children: React.ReactNode;
  className?: string;
  /** Index used to compute the per-item delay (index * step). */
  index?: number;
  /** Per-step delay in seconds. Default 0.04. */
  step?: number;
  style?: React.CSSProperties;
  as?: React.ElementType;
}

/**
 * Grid/list item that fades in with a delay proportional to its index.
 * Pass the array index so each item cascades naturally.
 */
export function StaggerItem({
  children,
  className,
  index = 0,
  step = 0.04,
  style,
  as: Tag = "div",
}: StaggerItemProps): React.ReactElement {
  return (
    <Tag
      className={cn("animate-fade-in-up", className)}
      style={{ animationDelay: `${index * step}s`, ...style }}
    >
      {children}
    </Tag>
  );
}