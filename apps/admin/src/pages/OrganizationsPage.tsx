import { useCallback, useEffect, useState, type FormEvent } from "react";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import { ApiError, deleteJson, getJson, patchJson, postJson, setToken } from "../api/client.ts";
import type {
  Organization,
  OrganizationCreateRequest,
  OrganizationCreateResponse,
  OrganizationDeleteResponse,
  OrganizationListResponse,
  OrganizationUpdateRequest,
} from "../api/types.ts";
import { formatDate } from "../utils/format.ts";
import { toast } from "sonner";
import { Building2, Loader2, MoreVertical, Pencil, Plus, Trash2, Check } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Panel } from "@/components/Instrument";
import { orgInitials } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const SLUG_RE = /^[a-z0-9-]+$/;

interface CreateForm {
  name: string;
  slug: string;
  defaultCurrency: string;
}

interface RenameForm {
  name: string;
  slug: string;
  defaultCurrency: string;
}

const CREATE_EMPTY: CreateForm = { name: "", slug: "", defaultCurrency: "USD" };

export function deriveSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || ""
  );
}

export default function OrganizationsPage(): React.ReactElement {
  const { user, switchOrganization } = useAuth();
  // Rename requires organization:write on the target membership; create/delete
  // are owner/auth-scoped on the API (create: any member, delete: owner only).
  const canWriteOrg = hasPermission(user, "organization:write");

  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(CREATE_EMPTY);
  const [creating, setCreating] = useState(false);

  const [renameTarget, setRenameTarget] = useState<Organization | null>(null);
  const [renameForm, setRenameForm] = useState<RenameForm>({
    name: "",
    slug: "",
    defaultCurrency: "USD",
  });
  const [renaming, setRenaming] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Organization | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [switchingId, setSwitchingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJson<OrganizationListResponse>("/admin/organizations");
      setOrgs(res.items);
      setActiveId(res.activeOrganizationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load organizations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setCreateForm(CREATE_EMPTY);
    setCreateOpen(true);
  };

  const onCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = createForm.name.trim();
    if (!name) return;
    const slug = createForm.slug.trim();
    if (slug && !SLUG_RE.test(slug)) {
      toast.error("Slug must be lowercase letters, numbers, and hyphens only.");
      return;
    }
    setCreating(true);
    try {
      const body: OrganizationCreateRequest = {
        name,
        defaultCurrency: createForm.defaultCurrency.trim().toUpperCase() || undefined,
      };
      if (slug) body.slug = slug;
      const res = await postJson<OrganizationCreateResponse>("/admin/organizations", body);
      // Create already switched the session to the new org and rotated the
      // token server-side. Adopt the fresh token BEFORE any further request:
      // presenting the now-stale JWT (e.g. to /organizations or /switch) can
      // 401 and bounce the session to /login.
      setToken(res.token);
      await switchOrganization(res.organization.id);
      await load();
      setActiveId(res.organization.id);
      setCreateOpen(false);
      toast.success(`Created "${res.organization.name}". Now active.`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to create organization.";
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const openRename = (org: Organization) => {
    setRenameTarget(org);
    setRenameForm({
      name: org.name,
      slug: org.slug,
      defaultCurrency: org.defaultCurrency,
    });
  };

  const onRename = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!renameTarget) return;
    const name = renameForm.name.trim();
    if (!name) return;
    const slug = renameForm.slug.trim();
    if (slug && !SLUG_RE.test(slug)) {
      toast.error("Slug must be lowercase letters, numbers, and hyphens only.");
      return;
    }
    setRenaming(true);
    try {
      const body: OrganizationUpdateRequest = {
        name,
        slug: slug || undefined,
        defaultCurrency: renameForm.defaultCurrency.trim().toUpperCase() || undefined,
      };
      await patchJson(`/admin/organizations/${encodeURIComponent(renameTarget.id)}`, body);
      await load();
      setRenameTarget(null);
      toast.success("Organization updated.");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to update organization.";
      toast.error(msg);
    } finally {
      setRenaming(false);
    }
  };

  const onDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteJson<OrganizationDeleteResponse>(
        `/admin/organizations/${encodeURIComponent(deleteTarget.id)}`,
      );
      await load();
      setDeleteTarget(null);
      toast.success("Organization deleted.");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to delete organization.";
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  };

  const onSwitch = async (orgId: string) => {
    if (orgId === activeId) return;
    setSwitchingId(orgId);
    try {
      await switchOrganization(orgId);
      setActiveId(orgId);
      toast.success("Switched organization.");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to switch organization.";
      toast.error(msg);
    } finally {
      setSwitchingId(null);
    }
  };

  const isOwner = (org: Organization) => user?.id === org.ownerId;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Organizations"
        description="Each organization has its own providers, models, plans, customers, and keys. Switch to work inside one."
      >
        <Button onClick={openCreate}>
          <Plus />
          New organization
        </Button>
      </PageHeader>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="skeleton h-40 rounded-xl" aria-hidden />
      ) : orgs.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Building2 />}
            title="No organizations"
            description="Create an organization to hold providers, models, plans, and customers."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus />
                New organization
              </Button>
            }
          />
        </Panel>
      ) : (
        <Panel as="ul" className="overflow-hidden">
          {orgs.map((org) => {
            const active = org.id === activeId;
            const owned = isOwner(org);
            return (
              <li
                key={org.id}
                className={cn(
                  "flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-rule px-4 py-4 last:border-b-0 sm:flex-nowrap sm:px-5",
                  active && "bg-accent/50",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-10 shrink-0 items-center justify-center rounded-md text-[13px] font-semibold",
                    active ? "bg-foreground text-background" : "bg-secondary text-secondary-foreground",
                  )}
                >
                  {orgInitials(org.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{org.name}</span>
                    {active ? <Badge variant="info">Current</Badge> : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="font-mono">{org.slug}</span>
                    <span className="tabular-nums">{org.defaultCurrency}</span>
                    <span>{owned ? "Owner" : org.role === "admin" ? "Admin" : "Member"}</span>
                    <span>Created {formatDate(org.createdAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {active ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={switchingId === org.id}
                      onClick={() => void onSwitch(org.id)}
                    >
                      {switchingId === org.id ? <Loader2 className="animate-spin" /> : null}
                      Switch
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${org.name}`}>
                        <MoreVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      {canWriteOrg ? (
                        <DropdownMenuItem onClick={() => openRename(org)}>
                          <Pencil className="size-4" />
                          <span>Edit details</span>
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem disabled={active} onClick={() => void onSwitch(org.id)}>
                        <Check className="size-4" />
                        <span>{active ? "Current organization" : "Switch to this"}</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {owned ? (
                        <DropdownMenuItem
                          onClick={() => setDeleteTarget(org)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="size-4" />
                          <span>Delete…</span>
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem disabled>
                          <Trash2 className="size-4" />
                          <span>Delete (owner only)</span>
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </Panel>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New organization</DialogTitle>
            <DialogDescription>
              You become the owner of organizations you create. The new org becomes your active org.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={onCreate}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org-create-name">Name</Label>
              <Input
                id="org-create-name"
                value={createForm.name}
                placeholder="Acme Inc."
                autoFocus
                onChange={(e) =>
                  setCreateForm((prev) => ({
                    ...prev,
                    name: e.target.value,
                    slug: prev.slug || deriveSlug(e.target.value),
                  }))
                }
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-create-slug">Slug <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Input
                  id="org-create-slug"
                  value={createForm.slug}
                  placeholder="acme-inc"
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, slug: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-create-currency">Currency</Label>
                <Input
                  id="org-create-currency"
                  value={createForm.defaultCurrency}
                  maxLength={3}
                  onChange={(e) =>
                    setCreateForm((prev) => ({
                      ...prev,
                      defaultCurrency: e.target.value.toUpperCase(),
                    }))
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !createForm.name.trim()}>
                {creating ? <Loader2 className="size-4 animate-spin" /> : null}
                Create organization
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit organization</DialogTitle>
            <DialogDescription>Update the name, slug, or currency for this organization.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={onRename}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org-rename-name">Name</Label>
              <Input
                id="org-rename-name"
                value={renameForm.name}
                onChange={(e) => setRenameForm((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-rename-slug">Slug</Label>
                <Input
                  id="org-rename-slug"
                  value={renameForm.slug}
                  onChange={(e) => setRenameForm((prev) => ({ ...prev, slug: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-rename-currency">Currency</Label>
                <Input
                  id="org-rename-currency"
                  value={renameForm.defaultCurrency}
                  maxLength={3}
                  onChange={(e) =>
                    setRenameForm((prev) => ({
                      ...prev,
                      defaultCurrency: e.target.value.toUpperCase(),
                    }))
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)} disabled={renaming}>
                Cancel
              </Button>
              <Button type="submit" disabled={renaming || !renameForm.name.trim()}>
                {renaming ? <Loader2 className="size-4 animate-spin" /> : null}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete organization?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `This permanently deletes "${deleteTarget.name}" and removes it from all members. This cannot be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            <AlertDescription>
              The organization must be empty (no providers, customers, models, plans, or API keys) before it can be deleted.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void onDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
