import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Plug,
  Boxes,
  Users,
  CreditCard,
  BarChart3,
  KeyRound,
  Settings,
  MessageSquare,
  LogOut,
  ChevronsUpDown,
  Building2,
  Check,
  Plus,
  ShieldCheck,
  PanelLeft,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import type { PanelPermission } from "../auth/AuthContext.tsx";
import { getJson } from "../api/client.ts";
import type { OrganizationListResponse, Organization } from "../api/types.ts";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import BrandLogo from "@/components/BrandLogo";
import { ThemeCycleButton, ThemeSwitch } from "@/components/ThemeSwitch";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  /**
   * Required panel permission to show this nav item.
   * `null` = always visible (orgs list, self settings).
   */
  permission: PanelPermission | null;
}

interface NavSectionDef {
  label: string;
  items: readonly NavItem[];
}

const NAV_SECTIONS: readonly NavSectionDef[] = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, permission: "dashboard:read" },
      { to: "/analytics", label: "Analytics", icon: BarChart3, permission: "usage:read" },
    ],
  },
  {
    label: "Catalog",
    items: [
      { to: "/providers", label: "Providers", icon: Plug, permission: "providers:read" },
      { to: "/models", label: "Models", icon: Boxes, permission: "models:read" },
      { to: "/plans", label: "Plans", icon: CreditCard, permission: "plans:read" },
    ],
  },
  {
    label: "Access",
    items: [
      { to: "/customers", label: "Customers", icon: Users, permission: "customers:read" },
      { to: "/api-keys", label: "API Keys", icon: KeyRound, permission: "customer_keys:read" },
      {
        to: "/management-keys",
        label: "Management Keys",
        icon: ShieldCheck,
        permission: "management_keys:read",
      },
    ],
  },
  {
    label: "Tools",
    items: [
      { to: "/playground", label: "Playground", icon: MessageSquare, permission: "playground:write" },
    ],
  },
  {
    label: "Admin",
    items: [
      { to: "/organizations", label: "Organizations", icon: Building2, permission: null },
      { to: "/settings", label: "Settings", icon: Settings, permission: null },
    ],
  },
];

const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

export function pathLabel(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  const match = NAV_ITEMS.find((n) => n.to === pathname);
  return match ? match.label : "TokenPanel";
}

export function orgInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "O";
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "O").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

/** Shared org list so the rail switcher and the top bar agree on the name. */
function useOrganizations(): {
  orgs: Organization[];
  activeId: string;
  setActiveId: (id: string) => void;
} {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [activeId, setActiveId] = useState<string>(user?.activeOrganizationId ?? "");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await getJson<OrganizationListResponse>("/admin/organizations");
        if (cancelled) return;
        setOrgs(res.items);
        setActiveId(res.activeOrganizationId);
      } catch {
        /* sidebar switcher is best-effort */
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [user?.activeOrganizationId]);

  return { orgs, activeId, setActiveId };
}

function OrgMark({ name, active, className }: { name: string; active?: boolean; className?: string }): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[5px] font-semibold tracking-tight",
        active
          ? "bg-sidebar-foreground text-sidebar"
          : "bg-sidebar-accent text-sidebar-foreground ring-1 ring-inset ring-sidebar-border",
        className,
      )}
    >
      {orgInitials(name)}
    </span>
  );
}

function OrgSwitcher({
  orgs,
  activeId,
  setActiveId,
}: ReturnType<typeof useOrganizations>): React.ReactElement {
  const { user, switchOrganization } = useAuth();
  const { state, isMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const active = orgs.find((o) => o.id === activeId) ?? null;
  const activeName = active?.name ?? "Organization";

  async function onSwitch(orgId: string) {
    if (orgId === activeId) return;
    setSwitchingId(orgId);
    try {
      await switchOrganization(orgId);
      setActiveId(orgId);
    } catch {
      /* toast handled by caller surface; keep silent in sidebar */
    } finally {
      setSwitchingId(null);
    }
  }

  const menu = (
    <>
      <DropdownMenuLabel>Switch organization</DropdownMenuLabel>
      {orgs.map((org) => (
        <DropdownMenuItem
          key={org.id}
          onClick={() => void onSwitch(org.id)}
          disabled={switchingId === org.id || org.id === activeId}
          className="gap-2.5 data-[disabled]:opacity-100"
        >
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold",
              org.id === activeId ? "bg-foreground text-background" : "bg-secondary text-secondary-foreground",
            )}
          >
            {orgInitials(org.name)}
          </span>
          <span className="min-w-0 flex-1 truncate">{org.name}</span>
          {org.id === activeId ? <Check className="size-3.5 text-signal" strokeWidth={2.5} /> : null}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <NavLink to="/organizations">
          <Plus className="size-4" />
          <span>Manage organizations</span>
        </NavLink>
      </DropdownMenuItem>
    </>
  );

  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label={`Organization: ${activeName}. Switch organization`}
            title={activeName}
          >
            <OrgMark name={activeName} active className="size-8 text-[11px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-64">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex w-full items-center gap-2.5 rounded-lg p-1.5 pr-2 text-left outline-none transition-colors",
            "bg-sidebar-accent/70 ring-1 ring-inset ring-sidebar-border hover:bg-sidebar-accent",
            "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          )}
          aria-label={`Organization: ${activeName}. Switch organization`}
        >
          <OrgMark name={activeName} active className="size-8 text-[11px]" />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[13px] font-medium text-sidebar-foreground">{activeName}</span>
            <span className="truncate text-[11.5px] capitalize text-sidebar-legend">
              {user?.role ?? "member"}
              {orgs.length > 1 ? ` · ${orgs.length} orgs` : ""}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-legend transition-colors group-hover:text-sidebar-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56">
        {menu}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrandHeader(): React.ReactElement {
  const { state, isMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  return (
    <div
      className={cn(
        "flex h-14 items-center gap-2.5",
        collapsed ? "justify-center px-0" : "px-3",
        // Room for sheet close (X) on mobile drawer
        isMobile && "pr-12",
      )}
    >
      <BrandLogo className="size-7 ring-1 ring-sidebar-border" />
      {collapsed ? null : (
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-sidebar-foreground">
          TokenPanel
        </span>
      )}
    </div>
  );
}

function NavSections(): React.ReactElement {
  const location = useLocation();
  const { user } = useAuth();

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => item.permission === null || hasPermission(user, item.permission),
    ),
  })).filter((section) => section.items.length > 0);

  return (
    <>
      {sections.map((section) => (
        <SidebarGroup key={section.label} className="px-2 py-1">
          <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-px">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive =
                  item.to === "/"
                    ? location.pathname === "/"
                    : location.pathname.startsWith(item.to);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.label}
                      className="h-8 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-foreground"
                    >
                      <NavLink to={item.to} end={item.to === "/"} aria-current={isActive ? "page" : undefined}>
                        <Icon className="size-4 shrink-0" strokeWidth={isActive ? 2 : 1.7} />
                        <span className="flex-1">{item.label}</span>
                        {isActive ? (
                          <span
                            aria-hidden
                            className="ml-auto size-1.5 shrink-0 rounded-full bg-sidebar-primary shadow-[0_0_0_3px_oklch(0.66_0.19_266/0.18)] group-data-[collapsible=icon]:hidden"
                          />
                        ) : null}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function SidebarUser(): React.ReactElement {
  const { user, logout } = useAuth();
  const { state, isMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  const initials = (user?.username ?? "U").slice(0, 2).toUpperCase();

  const content = (
    <>
      <DropdownMenuLabel className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{user?.username ?? ""}</span>
        <span className="truncate text-xs font-normal text-muted-foreground">{user?.email ?? ""}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <NavLink to="/settings">
          <Settings className="size-4" />
          <span>Account settings</span>
        </NavLink>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => void logout()}>
        <LogOut className="size-4" />
        <span>Sign out</span>
      </DropdownMenuItem>
    </>
  );

  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="Account menu"
            title={user?.username ?? "Account"}
          >
            <Avatar className="size-7">
              <AvatarFallback className="bg-sidebar-accent text-[10px] text-sidebar-foreground ring-1 ring-inset ring-sidebar-border">
                {initials}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-56">
          {content}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1 pr-1.5 text-left outline-none transition-colors",
            "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          )}
          aria-label="Account menu"
        >
          <Avatar className="size-7">
            <AvatarFallback className="bg-sidebar-accent text-[10px] text-sidebar-foreground ring-1 ring-inset ring-sidebar-border">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-sidebar-foreground">
            {user?.username ?? ""}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-legend" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        {content}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RailFooter(): React.ReactElement {
  const { state, isMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 py-2.5">
        <ThemeCycleButton />
        <SidebarUser />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5 px-3 pb-3 pt-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="legend text-sidebar-legend">Theme</span>
        <ThemeSwitch className="w-[6.75rem]" />
      </div>
      <div className="flex items-center gap-2">
        <SidebarUser />
        <span className="shrink-0 text-[10.5px] tabular-nums text-sidebar-legend">v0.1.0</span>
      </div>
    </div>
  );
}

function TopBar({ orgName }: { orgName: string | null }): React.ReactElement {
  const location = useLocation();
  const { toggleSidebar } = useSidebar();
  const label = pathLabel(location.pathname);
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:px-5">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label="Toggle navigation"
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring"
      >
        <PanelLeft className="size-4" strokeWidth={1.8} />
      </button>
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <nav aria-label="Location" className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {orgName ? (
          <>
            <span className="truncate text-muted-foreground">{orgName}</span>
            <span aria-hidden className="text-muted-foreground/60">/</span>
          </>
        ) : null}
        <span className="truncate font-medium text-foreground">{label}</span>
      </nav>
    </header>
  );
}

/** Dismiss mobile drawer after navigation (links, org switcher, etc.). */
function CloseMobileSidebarOnNavigate(): null {
  const location = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [location.pathname, isMobile, setOpenMobile]);

  return null;
}

export default function Layout(): React.ReactElement {
  const { user } = useAuth();
  const orgState = useOrganizations();
  const activeOrg = orgState.orgs.find((o) => o.id === orgState.activeId) ?? null;

  return (
    <div className="flex min-h-svh w-full">
      <CloseMobileSidebarOnNavigate />
      <Sidebar collapsible="icon" className="border-r-0">
        <SidebarHeader className="gap-0 p-0">
          <BrandHeader />
          <div className="px-2.5 pb-2 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-1">
            <OrgSwitcher {...orgState} />
          </div>
        </SidebarHeader>

        <SidebarContent className="gap-1 py-1.5">
          <NavSections />
        </SidebarContent>

        <SidebarFooter className="gap-0 border-t border-sidebar-border p-0">
          <RailFooter />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-w-0">
        <TopBar orgName={activeOrg?.name ?? null} />
        <main className="flex-1">
          {/* Remount page tree on org switch so lists + one-time secrets
              cannot leak across organizations via stale local state. */}
          <div className="mx-auto w-full max-w-[1440px] px-4 pb-16 pt-6 sm:px-6 lg:px-8 lg:pt-8">
            <Outlet key={user?.activeOrganizationId ?? "no-org"} />
          </div>
        </main>
      </SidebarInset>
    </div>
  );
}
