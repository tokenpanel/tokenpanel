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
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import type { PanelPermission } from "../auth/AuthContext.tsx";
import { getJson } from "../api/client.ts";
import type { OrganizationListResponse, Organization } from "../api/types.ts";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import BrandLogo from "@/components/BrandLogo";

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

function orgInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "O";
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "O").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

function OrgSwitcher(): React.ReactElement {
  const { user, switchOrganization } = useAuth();
  const { state, isMobile } = useSidebar();
  // Mobile sheet is always full-width chrome; collapse only applies on desktop.
  const collapsed = !isMobile && state === "collapsed";
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [activeId, setActiveId] = useState<string>(user?.activeOrganizationId ?? "");
  const [switchingId, setSwitchingId] = useState<string | null>(null);

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

  const active = orgs.find((o) => o.id === activeId) ?? null;
  const mark = orgInitials(active?.name ?? "Org");

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
      <DropdownMenuLabel className="font-normal">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">Organizations</span>
          <span className="text-sm font-medium truncate">
            {active?.name ?? "Select organization"}
          </span>
        </div>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      {orgs.map((org) => (
        <DropdownMenuItem
          key={org.id}
          onClick={() => void onSwitch(org.id)}
          disabled={switchingId === org.id || org.id === activeId}
          className="gap-2"
        >
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold",
              org.id === activeId
                ? "bg-foreground/10 text-foreground"
                : "bg-muted text-muted-foreground",
            )}
          >
            {orgInitials(org.name)}
          </span>
          <span className="min-w-0 flex-1 truncate">{org.name}</span>
          <Check
            className={cn(
              "size-3.5 shrink-0",
              org.id === activeId ? "opacity-100 text-foreground" : "opacity-0",
            )}
          />
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
            className={cn(
              "flex size-8 items-center justify-center rounded-lg outline-none transition-all",
              "bg-sidebar-accent text-sidebar-foreground ring-1 ring-inset ring-sidebar-border",
              "hover:bg-sidebar-accent/80 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            )}
            aria-label="Switch organization"
            title={active?.name ?? "Organizations"}
          >
            <span className="text-[10px] font-bold tracking-tight">{mark}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-60">
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
            "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none transition-all",
            "border border-sidebar-border/80 bg-sidebar-accent/40",
            "hover:bg-sidebar-accent hover:border-sidebar-border",
            "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          )}
          aria-label="Switch organization"
        >
          <div
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold",
              "bg-sidebar-accent text-sidebar-foreground ring-1 ring-inset ring-sidebar-border",
            )}
          >
            {mark}
          </div>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-sidebar-foreground">
              {active?.name ?? "Organization"}
            </span>
            <span className="truncate text-[11px] text-sidebar-foreground/70">
              {orgs.length === 0
                ? "No organizations"
                : `${orgs.length} organization${orgs.length === 1 ? "" : "s"}`}
            </span>
          </div>
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-64">
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
        "relative flex h-14 items-center gap-3",
        collapsed ? "justify-center px-0" : "px-2.5",
        // Room for sheet close (X) on mobile drawer
        isMobile && "pr-12",
      )}
    >
      <BrandLogo className="size-8 shadow-md ring-1 ring-sidebar-border/60" />
      <div
        className={cn(
          "flex min-w-0 flex-col leading-tight whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-linear",
          collapsed ? "w-0 opacity-0" : "w-auto opacity-100",
        )}
      >
        <span className="text-[15px] font-semibold tracking-tight text-sidebar-foreground">
          TokenPanel
        </span>
        <span className="text-[11px] font-medium tracking-wide text-sidebar-foreground/70">
          Admin console
        </span>
      </div>
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
        <SidebarGroup key={section.label} className="py-1.5">
          <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive =
                  item.to === "/"
                    ? location.pathname === "/"
                    : location.pathname.startsWith(item.to);
                return (
                  <SidebarMenuItem
                    key={item.to}
                    className={cn(
                      isActive &&
                        "before:absolute before:left-0 before:top-1/2 before:z-10 before:h-3.5 before:w-0.5 before:-translate-y-1/2 before:rounded-full before:bg-sidebar-foreground/80",
                    )}
                  >
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                      <NavLink to={item.to} end={item.to === "/"}>
                        <Icon className="size-4 shrink-0" strokeWidth={isActive ? 2 : 1.75} />
                        <span>{item.label}</span>
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

  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-lg outline-none ring-1 ring-sidebar-border transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="User menu"
            title={user?.username ?? "Account"}
          >
            <Avatar className="size-7">
              <AvatarFallback className="bg-sidebar-accent text-[10px] font-semibold text-sidebar-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-52">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{user?.username ?? ""}</span>
              <span className="text-xs text-muted-foreground truncate">
                {user?.email ?? ""}
              </span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <NavLink to="/settings">
              <Settings className="size-4" />
              <span>Settings</span>
            </NavLink>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void logout()}>
            <LogOut className="size-4" />
            <span>Log out</span>
          </DropdownMenuItem>
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
            "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left outline-none transition-all",
            "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          )}
          aria-label="User menu"
        >
          <Avatar className="size-8 ring-1 ring-sidebar-border/70">
            <AvatarFallback className="bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-sidebar-foreground">
              {user?.username ?? ""}
            </span>
            <span className="truncate text-[11px] capitalize text-sidebar-foreground/70">
              {user?.role ?? "member"}
            </span>
          </div>
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{user?.username ?? ""}</span>
            <span className="text-xs text-muted-foreground truncate">
              {user?.email ?? ""}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <NavLink to="/settings">
            <Settings className="size-4" />
            <span>Settings</span>
          </NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void logout()}>
          <LogOut className="size-4" />
          <span>Log out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HeaderBreadcrumb({ pathname }: { pathname: string }): React.ReactElement {
  const label = pathLabel(pathname);
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <span className="text-muted-foreground">TokenPanel</span>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{label}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
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
  const location = useLocation();
  const { user } = useAuth();
  // Dark-only shell — no theme toggle / useTheme.

  return (
    <div className="flex min-h-svh w-full">
      <CloseMobileSidebarOnNavigate />
      <Sidebar collapsible="icon" className="border-r border-sidebar-border/80">
        <SidebarHeader className="gap-0 p-0 group-data-[collapsible=icon]:px-0">
          <BrandHeader />
          <div className="px-2.5 pb-3 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:pb-2">
            <OrgSwitcher />
          </div>
          <div className="mx-3 h-px bg-sidebar-border/80 group-data-[collapsible=icon]:mx-2" />
        </SidebarHeader>

        <SidebarContent className="px-1 py-2 group-data-[collapsible=icon]:px-0">
          <NavSections />
        </SidebarContent>

        <SidebarFooter className="gap-0 p-0 group-data-[collapsible=icon]:px-0">
          <div className="mx-3 h-px bg-sidebar-border/80 group-data-[collapsible=icon]:mx-2" />
          <div className="flex items-center justify-between gap-1 px-2.5 py-1.5 group-data-[collapsible=icon]:hidden">
            <span className="text-[10px] font-medium tracking-wide text-sidebar-foreground/55">
              v0.1.0
            </span>
          </div>
          <div className="px-2 pb-2.5 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:py-2">
            <SidebarUser />
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="glass sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border/80 px-4 sm:px-6">
          <SidebarTrigger />
          <HeaderBreadcrumb pathname={location.pathname} />
        </header>
        <main className="flex-1 overflow-y-auto">
          {/* Remount page tree on org switch so lists + one-time secrets
              cannot leak across organizations via stale local state. */}
          <Outlet key={user?.activeOrganizationId ?? "no-org"} />
        </main>
      </SidebarInset>
    </div>
  );
}
