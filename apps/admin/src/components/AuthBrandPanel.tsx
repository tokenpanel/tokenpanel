import type { ReactElement, ReactNode } from "react";
import { Github } from "lucide-react";
import BrandLogo from "@/components/BrandLogo";
import { WindowRuler } from "@/components/Scale";

const GITHUB_REPO_URL = "https://github.com/tokenpanel/tokenpanel";

interface PlateRow {
  legend: string;
  text: string;
}

// Facts from the product README; no claims beyond what ships.
const PLATE: readonly PlateRow[] = [
  {
    legend: "Spend",
    text: "Per-model price and upstream cost, tracked separately against prepaid balances.",
  },
  {
    legend: "Access",
    text: "Scoped API keys and model allow-lists behind one OpenAI- and Anthropic-compatible API.",
  },
  {
    legend: "Limits",
    text: "Rolling token, request, and spend caps over windows like 1h, 5h, weekly, or 30d.",
  },
];

// The window lengths named in the Limits line, drawn on the console's ruler.
const EXAMPLE_WINDOWS = [
  { key: "1h", windowSeconds: 3600, caption: "" },
  { key: "5h", windowSeconds: 18000, caption: "" },
  { key: "1w", windowSeconds: 604800, caption: "" },
  { key: "30d", windowSeconds: 2592000, caption: "" },
] as const;

/** The charcoal front plate beside every sign-in form (desktop). */
function FrontPlate(): ReactElement {
  return (
    <aside className="relative hidden w-[min(46%,40rem)] shrink-0 flex-col justify-between bg-sidebar px-10 py-9 text-sidebar-foreground lg:flex xl:px-14">
      <div className="flex items-center gap-2.5">
        <BrandLogo className="size-8 ring-1 ring-sidebar-border" />
        <span className="text-[15px] font-semibold tracking-[-0.01em]">TokenPanel</span>
      </div>

      <div className="flex max-w-[30rem] flex-col gap-10">
        <h2 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.025em] text-sidebar-foreground xl:text-[40px]">
          AI spend control and access management.
        </h2>

        <dl className="flex flex-col">
          {PLATE.map((row) => (
            <div
              key={row.legend}
              className="grid grid-cols-[5.5rem_1fr] gap-4 border-t border-sidebar-border py-4 last:border-b"
            >
              <dt className="legend pt-[3px] text-sidebar-legend">{row.legend}</dt>
              <dd className="m-0 text-[14.5px] leading-relaxed text-sidebar-foreground/85">{row.text}</dd>
            </div>
          ))}
        </dl>

        <div aria-hidden>
          <WindowRuler size="lg" markers={EXAMPLE_WINDOWS} className="text-sidebar-legend [&_.bg-signal]:bg-sidebar-primary" />
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 text-xs text-sidebar-legend">
        <span>Open source · AGPL-3.0</span>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-sm text-sidebar-legend transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <Github className="size-3.5" strokeWidth={1.75} aria-hidden />
          Source on GitHub
        </a>
      </div>
    </aside>
  );
}

/** Mobile/tablet: the plate collapses into a charcoal band. */
function PlateBand(): ReactElement {
  return (
    <div className="flex items-center gap-2.5 bg-sidebar px-5 py-4 text-sidebar-foreground lg:hidden">
      <BrandLogo className="size-7 ring-1 ring-sidebar-border" />
      <span className="text-[15px] font-semibold tracking-[-0.01em]">TokenPanel</span>
      <span className="ml-auto text-xs text-sidebar-legend">Admin console</span>
    </div>
  );
}

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background lg:flex-row">
      <PlateBand />
      <FrontPlate />
      <main className="flex flex-1 flex-col px-5 pb-12 pt-10 sm:px-10 sm:pt-16 lg:justify-center lg:py-10">
        <div className="mx-auto w-full max-w-[25rem]">
          <header className="mb-7">
            <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
            {description ? (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
          </header>
          {children}
          {footer ? (
            <div className="mt-8 border-t border-border pt-5 text-[13px] leading-relaxed text-muted-foreground">
              {footer}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export function AuthLoading(): ReactElement {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background" role="status">
      <span className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <BrandLogo className="size-6" />
        Loading…
      </span>
    </div>
  );
}
