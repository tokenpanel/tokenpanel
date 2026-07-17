import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext.tsx";
import { ApiError, deleteJson, getJson, patchJson, postJson } from "../api/client.ts";
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
import { FadeIn, StaggerItem } from "@/components/anim";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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

function deriveSlug(name: string): string {
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
      await load();
      await switchOrganization(res.organization.id);
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
    <div className="flex flex-col gap-6 p-6 lg:p-8">
      <PageHeader title="Organizations" icon={<Building2 strokeWidth={1.75} />}>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          New organization
        </Button>
      </PageHeader>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : orgs.length === 0 ? (
        <Card className="p-8">
          <EmptyState
            icon={<Building2 className="size-5" />}
            title="No organizations"
            description="Create your first organization to start managing providers and customers."
            action={
              <Button onClick={openCreate}>
                <Plus className="size-4" />
                New organization
              </Button>
            }
          />
        </Card>
      ) : (
        <FadeIn>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {orgs.map((org, i) => {
              const active = org.id === activeId;
              const owned = isOwner(org);
              return (
                <StaggerItem key={org.id} index={i}>
                  <Card className={cn("flex flex-col gap-4 p-5", active && "ring-2 ring-primary/40")}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Building2 className="size-5" />
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="font-semibold leading-tight">{org.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{org.slug}</span>
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="Organization actions">
                            <MoreVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openRename(org)}>
                            <Pencil className="size-4" />
                            <span>Rename</span>
                          </DropdownMenuItem>
                          {owned ? (
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(org)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="size-4" />
                              <span>Delete</span>
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem disabled>
                              <Trash2 className="size-4" />
                              <span>Delete (owner only)</span>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={active}
                            onClick={() => void onSwitch(org.id)}
                          >
                            <Check className="size-4" />
                            <span>{active ? "Currently active" : "Switch to"}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                      <div className="text-muted-foreground">Currency</div>
                      <div>{org.defaultCurrency}</div>
                      <div className="text-muted-foreground">Role</div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={org.role === "admin" ? "secondary" : "outline"}>
                          {org.role === "admin" ? "Admin" : "Member"}
                        </Badge>
                        {owned ? <Badge variant="success">Owner</Badge> : null}
                      </div>
                      <div className="text-muted-foreground">Created</div>
                      <div className="text-xs">{formatDate(org.createdAt)}</div>
                    </div>

                    <div className="mt-auto flex items-center justify-between">
                      {active ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Inactive</span>
                      )}
                      <Button
                        variant={active ? "outline" : "default"}
                        size="sm"
                        disabled={active || switchingId === org.id}
                        onClick={() => void onSwitch(org.id)}
                      >
                        {switchingId === org.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                        {active ? "Current" : "Switch"}
                      </Button>
                    </div>
                  </Card>
                </StaggerItem>
              );
            })}
          </div>
        </FadeIn>
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
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-create-slug">Slug (optional)</Label>
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
                Create
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
            <div className="grid grid-cols-2 gap-4">
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
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete organization</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `This permanently deletes "${deleteTarget.name}" and removes it from all members. This cannot be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
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
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
