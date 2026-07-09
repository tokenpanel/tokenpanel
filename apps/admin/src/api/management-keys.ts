export interface ManagementScopeMeta {
  scope: string;
  group: string;
  description: string;
}

export interface ManagementScopeMetaListResponse {
  items: ManagementScopeMeta[];
}

export interface ManagementKey {
  _id: string;
  organizationId: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: string;
  lastUsedAt?: string | null;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagementKeyListResponse {
  items: ManagementKey[];
}

export interface ManagementKeyCreateRequest {
  name: string;
  scopes: string[];
}

export interface ManagementKeyCreateResponse {
  managementKey: ManagementKey;
  key: string;
}

export interface ManagementKeyUpdateRequest {
  name?: string;
  scopes?: string[];
  status?: "active" | "revoked";
}

export interface ManagementKeyDeleteResponse {
  ok: boolean;
  status: string;
}
