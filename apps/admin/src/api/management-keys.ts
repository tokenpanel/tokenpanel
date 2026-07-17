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

export interface ManagementKeyCreateResponse {
  managementKey: ManagementKey;
  key: string;
}
