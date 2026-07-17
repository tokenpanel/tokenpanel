import type { ReactElement } from "react";
import {
  Github,
  KeyRound,
  ShieldCheck,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import BrandLogo from "@/components/BrandLogo";

const GITHUB_REPO_URL = "https://github.com/tokenpanel/tokenpanel";

interface Capability {
  icon: LucideIcon;
  title: string;
  description: string;
}

const CAPABILITIES: readonly Capability[] = [
  {
    icon: Waypoints,
    title: "OpenAI & Anthropic-compatible gateway",
    description: "One governed API surface for your apps and teams.",
  },
  {
    icon: ShieldCheck,
    title: "Per-account budgets & rolling limits",
    description: "Cap spend, tokens, and requests over custom windows.",
  },
  {
    icon: KeyRound,
    title: "API keys with model access controls",
    description: "Issue scoped keys without exposing provider secrets.",
  },
];

function CapabilityRow({
  icon: Icon,
  title,
  description,
  index,
}: Capability & { index: number }): ReactElement {
  return (
    <li
      className="animate-fade-in-up flex gap-3.5 rounded-xl border border-sidebar-border/80 bg-sidebar-accent/35 p-3.5"
      style={{ animationDelay: `${0.12 + index * 0.06}s` }}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar-accent text-sidebar-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex flex-col gap-0.5 pt-0.5">
        <span className="text-sm font-medium leading-snug text-sidebar-foreground">
          {title}
        </span>
        <span className="text-[13px] leading-snug text-sidebar-foreground/70">
          {description}
        </span>
      </div>
    </li>
  );
}

export function AuthBrandPanel(): ReactElement {
  return (
    <aside className="relative hidden min-h-[100dvh] w-[min(50%,34rem)] shrink-0 flex-col justify-between overflow-hidden border-r border-sidebar-border bg-sidebar px-10 py-10 text-sidebar-foreground lg:flex xl:w-[min(48%,38rem)] xl:px-12">
      <div className="relative flex items-center gap-2.5">
        <BrandLogo className="size-8 shadow-sm" />
        <span className="text-[15px] font-semibold tracking-tight">TokenPanel</span>
      </div>

      <div className="relative flex w-full flex-col gap-9">
        <div className="animate-fade-in-up flex flex-col gap-5">
          <div className="flex flex-col gap-2.5">
            <h2 className="text-[2rem] font-semibold leading-none tracking-tight xl:text-[2.375rem]">
              TokenPanel
            </h2>
            <p className="text-base font-medium leading-snug tracking-tight text-sidebar-foreground/80">
              AI spend control and access management
            </p>
          </div>
          <p className="w-full text-[15px] leading-relaxed text-sidebar-foreground/72">
            See what each account spends, decide who can call which models, and
            set budgets and rolling limits before costs run away. Issue scoped
            API keys and route traffic through one OpenAI- and
            Anthropic-compatible API without sharing provider credentials.
          </p>
        </div>

        <ul className="flex w-full flex-col gap-2.5">
          {CAPABILITIES.map((item, index) => (
            <CapabilityRow key={item.title} {...item} index={index} />
          ))}
        </ul>
      </div>

      <div className="relative flex items-center justify-between gap-4">
        <p className="text-xs text-sidebar-foreground/55">
          &copy; {new Date().getFullYear()} TokenPanel
        </p>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="TokenPanel on GitHub"
          className="inline-flex items-center gap-1.5 text-xs text-sidebar-foreground/70 no-underline transition-colors hover:text-sidebar-foreground"
        >
          <Github className="size-3.5" strokeWidth={1.75} aria-hidden />
          GitHub
        </a>
      </div>
    </aside>
  );
}

export function AuthMobileBrand(): ReactElement {
  return (
    <div className="mb-8 flex items-center gap-2.5 lg:hidden">
      <BrandLogo className="size-8 shadow-sm" />
      <span className="text-[15px] font-semibold tracking-tight">TokenPanel</span>
    </div>
  );
}
