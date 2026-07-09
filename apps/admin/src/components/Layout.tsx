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
  Sun,
  Moon,
  ChevronsUpDown,
  Building2,
  Check,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { getJson } from "../api/client.ts";
import type { OrganizationListResponse, Organization } from "../api/types.ts";
import { useTheme } from "../theme/ThemeContext.tsx";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
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

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/providers", label: "Providers", icon: Plug },
  { to: "/models", label: "Models", icon: Boxes },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/plans", label: "Plans", icon: CreditCard },
  { to: "/playground", label: "Playground", icon: MessageSquare },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/api-keys", label: "API Keys", icon: KeyRound },
  { to: "/management-keys", label: "Management Keys", icon: ShieldCheck },
  { to: "/organizations", label: "Organizations", icon: Building2 },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function pathLabel(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  const match = NAV_ITEMS.find((n) => n.to === pathname);
  return match ? match.label : "TokenPanel";
}

function OrgSwitcher(): React.ReactElement {
  const { user, switchOrganization } = useAuth();
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
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

  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-lg text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
            aria-label="Switch organization"
            title={active?.name ?? "Organizations"}
          >
            <Building2 className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-56">
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {orgs.map((org) => (
            <DropdownMenuItem
              key={org.id}
              onClick={() => void onSwitch(org.id)}
              disabled={switchingId === org.id || org.id === activeId}
            >
              <Check className={cn("size-4", org.id === activeId ? "opacity-100" : "opacity-0")} />
              <span className="truncate">{org.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <NavLink to="/organizations">
              <Plus className="size-4" />
              <span>Manage</span>
            </NavLink>
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
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Switch organization"
        >
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-primary">
            <Building2 className="size-4" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-sidebar-foreground">
              {active?.name ?? "Organization"}
            </span>
            <span className="truncate text-[11px] text-sidebar-foreground/50">
              {orgs.length} organization{orgs.length === 1 ? "" : "s"}
            </span>
          </div>
          <ChevronsUpDown className="size-3.5 shrink-0 text-sidebar-foreground/50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-60">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => void onSwitch(org.id)}
            disabled={switchingId === org.id || org.id === activeId}
          >
            <Check className={cn("size-4", org.id === activeId ? "opacity-100" : "opacity-0")} />
            <span className="truncate">{org.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <NavLink to="/organizations">
            <Plus className="size-4" />
            <span>Manage organizations</span>
          </NavLink>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrandHeader(): React.ReactElement {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  return (
    <div
      className={cn(
        "flex h-14 items-center gap-2.5",
        collapsed ? "justify-center px-0" : "px-2",
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-sm font-bold text-primary-foreground shadow-sm">
        T
      </div>
      <div
        className={cn(
          "flex flex-col leading-tight whitespace-nowrap overflow-hidden transition-[width,opacity] duration-200 ease-linear",
          collapsed ? "w-0 opacity-0" : "w-auto opacity-100",
        )}
      >
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">TokenPanel</span>
        <span className="text-[11px] uppercase tracking-wider text-sidebar-foreground/50">Admin Console</span>
      </div>
    </div>
  );
}

function NavSection(): React.ReactElement {
  const location = useLocation();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Platform</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive =
              item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                  <NavLink to={item.to} end={item.to === "/"}>
                    <Icon className="size-4 shrink-0" />
                    <span>{item.label}</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function ThemeToggle(): React.ReactElement {
  const { theme, toggleTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleTheme}
      aria-label="Toggle theme"
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

function UserMenu(): React.ReactElement {
  const { user, logout } = useAuth();
  const initials = (user?.username ?? "U").slice(0, 2).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg p-1 pr-1.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="User menu"
        >
          <Avatar className="size-7">
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <div className="hidden flex-col items-start leading-tight sm:flex">
            <span className="text-sm font-medium">{user?.username ?? ""}</span>
            <span className="text-xs capitalize text-muted-foreground">{user?.role ?? ""}</span>
          </div>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{user?.username ?? ""}</span>
            <span className="text-xs text-muted-foreground">{user?.email ?? ""}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
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

export default function Layout(): React.ReactElement {
  const location = useLocation();

  return (
    <div className="flex min-h-svh w-full">
      <Sidebar collapsible="icon" className="border-r border-sidebar-border">
        <SidebarHeader className="group-data-[collapsible=icon]:px-0">
          <BrandHeader />
          <Separator className="bg-sidebar-border" />
          <div className="px-2 py-2 group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:py-1">
            <OrgSwitcher />
          </div>
          <Separator className="bg-sidebar-border" />
        </SidebarHeader>
        <SidebarContent>
          <NavSection />
        </SidebarContent>
        <SidebarFooter className="group-data-[collapsible=icon]:px-0">
          <Separator className="bg-sidebar-border group-data-[collapsible=icon]:hidden" />
          <div className="flex h-8 items-center gap-1 px-2 group-data-[collapsible=icon]:hidden">
            <span className="text-[11px] text-sidebar-foreground/40">v0.1.0</span>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="glass sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <SidebarTrigger />
            <HeaderBreadcrumb pathname={location.pathname} />
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeToggle />
            <Separator orientation="vertical" className="mx-1 h-5" />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </SidebarInset>
    </div>
  );
}