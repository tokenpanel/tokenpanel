import * as React from "react";

/**
 * Layout wrappers kept for call-site compatibility. The console loads straight
 * into the task: no page-load choreography or per-item cascades, so these
 * render their children as-is (the only authored motion lives in the scale
 * needles and control presses).
 */

export interface FadeInProps {
  children: React.ReactNode;
  className?: string;
  /** Ignored; kept for API compatibility. */
  delay?: number;
  style?: React.CSSProperties;
  as?: React.ElementType;
}

export function FadeIn({ children, className, style, as: Tag = "div" }: FadeInProps): React.ReactElement {
  return (
    <Tag className={className} style={style}>
      {children}
    </Tag>
  );
}

export interface StaggerItemProps {
  children: React.ReactNode;
  className?: string;
  /** Ignored; kept for API compatibility. */
  index?: number;
  /** Ignored; kept for API compatibility. */
  step?: number;
  style?: React.CSSProperties;
  as?: React.ElementType;
}

export function StaggerItem({ children, className, style, as: Tag = "div" }: StaggerItemProps): React.ReactElement {
  return (
    <Tag className={className} style={style}>
      {children}
    </Tag>
  );
}
