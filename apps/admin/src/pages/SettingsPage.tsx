import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  hasPermission,
  useAuth,
  type PanelPermission,
  type UserRole,
} from "../auth/AuthContext.tsx";
import { deleteJson, getJson, postJson } from "../api/client.ts";
import type {
  InviteCreateResponse,
  InviteDeleteResponse,
  InviteListResponse,
  Invite,
} from "../api/types.ts";
import {
  PANEL_PERMISSION_DEFINITIONS,
  PANEL_PERMISSIONS,
  PANEL_READ_PERMISSIONS,
  canGrantPanelAccess,
  type PanelPermission as CatalogPermission,
} from "@tokenpanel/contracts";
import { formatDate, formatRelative } from "../utils/format.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PasswordInput } from "@/components/ui/password-input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { User, Mail, Lock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel, PanelHeader, SpecList } from "@/components/Instrument";
import { OneTimeSecret } from "@/components/OneTimeSecret";
import { ThemeSegmented } from "@/components/ThemeSwitch";
import { cn } from "@/lib/utils";

export function statusVariant(status: string): "warning" | "success" | "destructive" | "off" {
  switch (status) {
    case "pending":
      return "warning";
    case "accepted":
      return "success";
    case "expired":
      return "off";
    case "revoked":
      return "destructive";
    default:
      return "warning";
  }
}

function groupBy<T, K extends string>(items: readonly T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

/** Support-style preset: read dashboards/customers/usage + invite list. */
const SUPPORT_PRESET: readonly CatalogPermission[] = [
  "dashboard:read",
  "customers:read",
  "balances:read",
  "usage:read",
  "plans:read",
  "customer_keys:read",
  "invites:read",
  "catalog_sources:read",
];

/** Billing-style preset: balances + customers + plans read/write for ledger work. */
const BILLING_PRESET: readonly CatalogPermission[] = [
  "dashboard:read",
  "customers:read",
  "balances:read",
  "balances:write",
  "usage:read",
  "plans:read",
  "subscriptions:write",
];

function inviteId(inv: Invite): string {
  return inv._id ?? inv.id ?? "";
}

/** Intersect a preset with permissions the actor may grant. */
function filterGrantable(
  perms: readonly CatalogPermission[],
  grantable: ReadonlySet<PanelPermission>,
): CatalogPermission[] {
  return perms.filter((p) => grantable.has(p));
}

export default function SettingsPage(): React.ReactElement {
  const { user, updateEmail, changePassword } = useAuth();
  const isAdmin = user?.role === "admin";
  const canWriteInvites = hasPermission(user, "invites:write");
  // write implies read via hasPanelPermission (contracts).
  const canReadInvites = hasPermission(user, "invites:read");

  /** Permissions this actor may attach to an invite (own effective set). */
  const grantablePermissions = useMemo((): ReadonlySet<PanelPermission> => {
    if (!user) return new Set();
    if (user.role === "admin") return new Set(PANEL_PERMISSIONS);
    return new Set(user.permissions ?? []);
  }, [user]);

  /** Only admins (full catalog) may create admin-role invites. */
  const canInviteAdmin =
    !!user &&
    canGrantPanelAccess(
      user.role,
      user.permissions ?? [],
      "admin",
      [],
    );

  const grantableDefinitions = useMemo(
    () =>
      PANEL_PERMISSION_DEFINITIONS.filter((d) =>
        grantablePermissions.has(d.value),
      ),
    [grantablePermissions],
  );

  const groupEntries = useMemo(
    () =>
      Object.entries(groupBy(grantableDefinitions, (d) => d.group)) as [
        string,
        (typeof PANEL_PERMISSION_DEFINITIONS)[number][],
      ][],
    [grantableDefinitions],
  );

  const [invites, setInvites] = useState<Invite[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Profile: email form ---
  const [emailValue, setEmailValue] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (user?.email) setEmailValue(user.email);
  }, [user?.email]);

  const emailDirty = emailValue.trim() !== (user?.email ?? "");

  async function onSaveEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = emailValue.trim();
    if (!next || next === user?.email) return;
    setEmailSaving(true);
    setEmailMsg(null);
    try {
      await updateEmail(next);
      setEmailMsg({ kind: "success", text: "Email updated." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update email.";
      setEmailMsg({ kind: "error", text: msg });
    } finally {
      setEmailSaving(false);
    }
  }

  // --- Profile: password form ---
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function onChangePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!curPw || !newPw || !confirmPw) return;
    if (newPw !== confirmPw) {
      setPwMsg({ kind: "error", text: "New password and confirmation do not match." });
      return;
    }
    if (newPw.length < 8) {
      setPwMsg({ kind: "error", text: "New password must be at least 8 characters." });
      return;
    }
    if (newPw === curPw) {
      setPwMsg({ kind: "error", text: "New password must differ from current." });
      return;
    }
    setPwSaving(true);
    setPwMsg(null);
    try {
      await changePassword(curPw, newPw);
      // changePassword revokes all sessions and clears local auth — user is
      // sent to login via AuthProvider; keep message brief if UI still paints.
      setPwMsg({
        kind: "success",
        text: "Password changed. Sign in again with the new password.",
      });
      setCurPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to change password.";
      setPwMsg({ kind: "error", text: msg });
    } finally {
      setPwSaving(false);
    }
  }

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<UserRole>("member");
  const [inviteTtl, setInviteTtl] = useState("");
  const [invitePermissions, setInvitePermissions] = useState<Set<PanelPermission>>(
    () => new Set(),
  );
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const permissionCount = invitePermissions.size;

  // Drop any selected grants that become ungrantable (e.g. org switch).
  useEffect(() => {
    setInvitePermissions((prev) => {
      let changed = false;
      const next = new Set<PanelPermission>();
      for (const p of prev) {
        if (grantablePermissions.has(p)) next.add(p);
        else changed = true;
      }
      return changed ? next : prev;
    });
    if (!canInviteAdmin && inviteRole === "admin") {
      setInviteRole("member");
    }
  }, [grantablePermissions, canInviteAdmin, inviteRole]);

  useEffect(() => {
    if (!canReadInvites) return;
    let cancelled = false;
    async function load() {
      setLoadingInvites(true);
      setError(null);
      try {
        const res = await getJson<InviteListResponse>("/admin/invites");
        if (cancelled) return;
        setInvites(res.items);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load invites.");
      } finally {
        if (!cancelled) setLoadingInvites(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [canReadInvites]);

  function setRole(next: UserRole) {
    if (next === "admin" && !canInviteAdmin) return;
    setInviteRole(next);
    // Admins get the full catalog server-side; clear grants on role flip.
    if (next === "admin") {
      setInvitePermissions(new Set());
    }
  }

  function applyPreset(perms: readonly CatalogPermission[]) {
    setInvitePermissions(
      new Set(filterGrantable(perms, grantablePermissions) as PanelPermission[]),
    );
  }

  function togglePermission(perm: PanelPermission) {
    if (!grantablePermissions.has(perm)) return;
    setInvitePermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  async function onInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setCreating(true);
    setError(null);
    const ttlHours = inviteTtl.trim() ? Number(inviteTtl.trim()) : undefined;
    try {
      const body: {
        email: string;
        role?: string;
        permissions?: string[];
        ttlHours?: number;
      } = {
        email: inviteEmail.trim(),
        role: inviteRole,
      };
      if (inviteRole === "member") {
        body.permissions = Array.from(invitePermissions).sort();
      }
      if (ttlHours !== undefined && !Number.isNaN(ttlHours) && ttlHours > 0) {
        body.ttlHours = ttlHours;
      }
      const res = await postJson<InviteCreateResponse>("/admin/invites", body);
      setCreatedToken(res.token);
      const newId = inviteId(res.invite);
      setInvites((prev) => [
        res.invite,
        ...prev.filter((i) => inviteId(i) !== newId),
      ]);
      setInviteEmail("");
      setInviteTtl("");
      setInviteRole("member");
      setInvitePermissions(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite.");
    } finally {
      setCreating(false);
    }
  }

  async function onRevokeInvite(id: string) {
    setRevokingId(id);
    setError(null);
    try {
      await deleteJson<InviteDeleteResponse>(`/admin/invites/${encodeURIComponent(id)}`);
      setInvites((prev) => prev.filter((i) => inviteId(i) !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke invite.");
    } finally {
      setRevokingId(null);
    }
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  const signupUrl = createdToken
    ? `${window.location.origin}/signup#/token=${encodeURIComponent(createdToken)}`
    : "";

  const initials = (user?.username ?? "U").slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Your account, appearance, and who can join this organization." />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue="profile" className="gap-5">
        <TabsList className="self-start">
          <TabsTrigger value="profile"><User />Account</TabsTrigger>
          <TabsTrigger value="invites"><Mail />Team invites</TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <div className="grid max-w-5xl grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-6">
              <Panel>
                <div className="flex items-center gap-4 px-5 pb-4 pt-5">
                  <Avatar className="size-12">
                    <AvatarFallback className="text-sm">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="truncate text-[17px] font-semibold">{user?.username ?? "—"}</div>
                    <div className="truncate text-[13px] text-muted-foreground">{user?.email ?? ""}</div>
                  </div>
                </div>
                <SpecList
                  className="px-5 pb-3"
                  rows={[
                    { label: "Role", value: <span><span className="capitalize">{user?.role ?? "—"}</span>{isAdmin ? " · full panel access" : ""}</span> },
                    { label: "Organization ID", value: <span className="font-mono text-xs">{user?.activeOrganizationId ?? "—"}</span> },
                  ]}
                />
              </Panel>

              <Panel>
                <PanelHeader title="Appearance" description="Follow the system setting, or pin light or dark on this browser." />
                <div className="px-5 py-4">
                  <ThemeSegmented />
                </div>
              </Panel>

              <Panel>
                <PanelHeader title="Email" description="The address on your account. Must be unique across this instance." />
                <form className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-end" onSubmit={onSaveEmail}>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="profile-email">Email address</Label>
                    <Input
                      id="profile-email"
                      type="email"
                      value={emailValue}
                      onChange={(e) => setEmailValue(e.target.value)}
                      disabled={emailSaving}
                      required
                    />
                  </div>
                  <Button type="submit" disabled={emailSaving || !emailDirty}>
                    {emailSaving ? "Saving…" : "Save email"}
                  </Button>
                </form>
                {emailMsg ? (
                  <p role="status" className={cn("px-5 pb-4 text-sm font-medium", emailMsg.kind === "success" ? "text-success" : "text-destructive")}>
                    {emailMsg.text}
                  </p>
                ) : null}
              </Panel>
            </div>

            <Panel>
              <PanelHeader title="Password" description="Enter your current password to set a new one. At least 8 characters." />
              <form className="flex flex-col gap-4 px-5 py-4" onSubmit={onChangePassword}>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cur-pw">Current password</Label>
                  <PasswordInput
                    id="cur-pw"
                    value={curPw}
                    onChange={(e) => setCurPw(e.target.value)}
                    showPassword={showCur}
                    onToggleShow={() => setShowCur((v) => !v)}
                    disabled={pwSaving}
                    autoComplete="current-password"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-pw">New password</Label>
                  <PasswordInput
                    id="new-pw"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    showPassword={showNew}
                    onToggleShow={() => setShowNew((v) => !v)}
                    disabled={pwSaving}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm-pw">Confirm new password</Label>
                  <PasswordInput
                    id="confirm-pw"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    showPassword={showConfirm}
                    onToggleShow={() => setShowConfirm((v) => !v)}
                    disabled={pwSaving}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <div>
                  <Button type="submit" disabled={pwSaving || !curPw || !newPw || !confirmPw}>
                    {pwSaving ? "Changing…" : "Change password"}
                  </Button>
                </div>
                {pwMsg ? (
                  <p role="status" className={cn("text-sm font-medium", pwMsg.kind === "success" ? "text-success" : "text-destructive")}>
                    {pwMsg.text}
                  </p>
                ) : null}
              </form>
            </Panel>
          </div>
        </TabsContent>

        <TabsContent value="invites">
          {canReadInvites ? (
            <div className="flex flex-col gap-4">
              {createdToken ? (
                <OneTimeSecret
                  className="mb-0"
                  label="Invite created. Send this signup link to the invitee; it is shown only once."
                  secret={signupUrl}
                  copied={copied}
                  onCopy={() => void copyToken(signupUrl)}
                  onDismiss={() => setCreatedToken(null)}
                />
              ) : null}

              {canWriteInvites ? (
                <Panel>
                  <PanelHeader title="Invite someone" description="They get a signup link that joins this organization. Links expire after 7 days unless you set a TTL." />
                  <form className="flex flex-col gap-5 px-5 py-4" onSubmit={onInvite}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <div className="flex flex-1 flex-col gap-1.5">
                        <Label htmlFor="invite-email">Email</Label>
                        <Input
                          id="invite-email"
                          type="email"
                          placeholder="newuser@example.com"
                          value={inviteEmail}
                          required
                          disabled={creating}
                          onChange={(e) => setInviteEmail(e.target.value)}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="invite-role">Role</Label>
                        <Select
                          value={inviteRole}
                          onValueChange={(v) => setRole(v as UserRole)}
                          disabled={creating}
                        >
                          <SelectTrigger id="invite-role" className="sm:w-[130px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Member</SelectItem>
                            {canInviteAdmin ? (
                              <SelectItem value="admin">Admin</SelectItem>
                            ) : null}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="invite-ttl">Expires after (hours)</Label>
                        <Input
                          id="invite-ttl"
                          type="number"
                          min={1}
                          placeholder="168"
                          value={inviteTtl}
                          disabled={creating}
                          onChange={(e) => setInviteTtl(e.target.value)}
                          className="sm:w-[150px]"
                        />
                      </div>
                      <Button type="submit" disabled={creating}>
                        {creating ? "Creating link…" : "Create invite link"}
                      </Button>
                    </div>

                    {inviteRole === "member" ? (
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-[13px] font-medium">Panel permissions</div>
                            <p className="text-xs text-muted-foreground">
                              Only permissions you hold can be granted.
                              {permissionCount > 0
                                ? ` ${permissionCount} selected.`
                                : " None selected (empty access until granted)."}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={creating}
                              onClick={() => applyPreset([])}
                            >
                              Empty
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={
                                creating ||
                                filterGrantable(
                                  PANEL_READ_PERMISSIONS,
                                  grantablePermissions,
                                ).length === 0
                              }
                              onClick={() =>
                                applyPreset(PANEL_READ_PERMISSIONS)
                              }
                            >
                              Viewer
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={
                                creating ||
                                filterGrantable(
                                  SUPPORT_PRESET,
                                  grantablePermissions,
                                ).length === 0
                              }
                              onClick={() => applyPreset(SUPPORT_PRESET)}
                            >
                              Support
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={
                                creating ||
                                filterGrantable(
                                  BILLING_PRESET,
                                  grantablePermissions,
                                ).length === 0
                              }
                              onClick={() => applyPreset(BILLING_PRESET)}
                            >
                              Billing
                            </Button>
                          </div>
                        </div>
                        {groupEntries.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            You have no grantable panel permissions beyond invite
                            management itself. Invites will create members with
                            empty access.
                          </p>
                        ) : (
                          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
                            {groupEntries.map(([group, items]) => (
                              <fieldset
                                key={group}
                                className="flex flex-col gap-2.5 border-t border-rule pt-3"
                              >
                                <legend className="sr-only">{group}</legend>
                                <div className="legend text-muted-foreground">
                                  {group}
                                </div>
                                {items.map((def) => (
                                  <label
                                    key={def.value}
                                    className="flex cursor-pointer items-start gap-2 text-sm"
                                    title={def.description}
                                  >
                                    <Checkbox
                                      checked={invitePermissions.has(def.value)}
                                      onCheckedChange={() =>
                                        togglePermission(def.value)
                                      }
                                      disabled={creating}
                                      className="mt-0.5"
                                    />
                                    <span className="flex flex-col">
                                      <span className="font-medium leading-tight">
                                        {def.description}
                                      </span>
                                      <code className="font-mono text-[11px] text-muted-foreground">
                                        {def.value}
                                      </code>
                                    </span>
                                  </label>
                                ))}
                              </fieldset>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Admin invites receive the full panel permission catalog
                        automatically.
                      </p>
                    )}
                  </form>
                </Panel>
              ) : null}

              {loadingInvites ? null : invites.length === 0 ? (
                <Panel>
                  <EmptyState
                    icon={<Mail />}
                    title="No invites yet"
                    description="Invite links you create appear here with their status and expiry."
                  />
                </Panel>
              ) : (
                <Panel className="overflow-hidden">
                  <PanelHeader title="Invites" />
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Email</TableHead>
                          <TableHead className="hidden sm:table-cell">Role</TableHead>
                          <TableHead className="hidden lg:table-cell">Permissions</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="hidden md:table-cell">Expires</TableHead>
                          <TableHead className="hidden md:table-cell">Created</TableHead>
                          <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {invites.map((inv) => {
                          const id = inviteId(inv);
                          const perms = inv.permissions ?? [];
                          return (
                            <TableRow key={id || inv.email}>
                              <TableCell>{inv.email}</TableCell>
                              <TableCell className="hidden capitalize sm:table-cell">{inv.role}</TableCell>
                              <TableCell className="hidden whitespace-normal lg:table-cell">
                                {inv.role === "admin" ? (
                                  <span className="text-xs text-muted-foreground">Full access</span>
                                ) : perms.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">None</span>
                                ) : (
                                  <div className="flex max-w-[280px] flex-wrap gap-1">
                                    {perms.map((p) => (
                                      <span
                                        key={p}
                                        className="rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
                                      >
                                        {p}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge variant={statusVariant(inv.status)} className="capitalize">{inv.status}</Badge>
                              </TableCell>
                              <TableCell className="hidden md:table-cell">{formatDate(inv.expiresAt)}</TableCell>
                              <TableCell className="hidden text-muted-foreground md:table-cell">
                                {formatRelative(inv.createdAt)}
                              </TableCell>
                              <TableCell className="text-right">
                                {inv.status === "pending" && canWriteInvites && id ? (
                                  <Button
                                    variant="ghost-destructive"
                                    size="sm"
                                    disabled={revokingId === id}
                                    onClick={() => void onRevokeInvite(id)}
                                  >
                                    {revokingId === id ? "Revoking…" : "Revoke"}
                                  </Button>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                </Panel>
              )}
            </div>
          ) : (
            <Panel className="max-w-2xl">
              <EmptyState
                icon={<Lock />}
                title="No invite access"
                description="Managing invites needs invites:read or invites:write. Ask an admin to invite someone for you."
              />
            </Panel>
          )}
        </TabsContent>

      </Tabs>
    </div>
  );
}
