export interface Money {
  amountUnits: number;
  currency: string;
}

export interface Customer {
  _id: string;
  name: string;
  email: string;
  /** Redacted when caller lacks balances:read. */
  balance?: Money;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomerListResponse {
  items: Customer[];
  total: number;
}

export interface Model {
  _id: string;
  name: string;
  providerId: string;
  status?: string;
}

export interface ModelListResponse {
  items: Model[];
}

export interface Provider {
  _id: string;
  name: string;
  status?: string;
}

export interface ProviderListResponse {
  items: Provider[];
}

export interface Plan {
  _id: string;
  name: string;
  status: string;
}

export interface PlanListResponse {
  items: Plan[];
}

export interface ApiKey {
  _id: string;
  organizationId: string;
  /** Stripped when caller lacks customers:read. */
  customerId?: string;
  name: string;
  prefix: string;
  modelWhitelist: string[] | null;
  status: string;
  lastUsedAt?: string | null;
  hasKey: boolean;
}

export interface ApiKeyListResponse {
  items: ApiKey[];
  total: number;
}

export interface ApiKeyCreateRequest {
  customerId: string;
  name: string;
  modelWhitelist?: string[];
}

export interface ApiKeyCreateResponse {
  apiKey: ApiKey;
  key: string;
}

export interface ApiKeyDeleteResponse {
  ok: boolean;
}

export interface Invite {
  /** Backend domain field is `id`; some responses may still expose `_id`. */
  _id?: string;
  id?: string;
  email: string;
  role: string;
  /** Stored grants for member invites (empty for admin). */
  permissions?: string[];
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface InviteListResponse {
  items: Invite[];
}

export interface InviteCreateRequest {
  email: string;
  role?: string;
  /** Member grants only; ignored for admin invites on the server. */
  permissions?: string[];
  ttlHours?: number;
}

export interface InviteCreateResponse {
  invite: Invite;
  token: string;
}

export interface InviteDeleteResponse {
  ok: boolean;
}

export interface UsageByModel {
  model: string;
  requests: number;
  tokens: number;
  costUnits: number;
  priceUnits: number;
}

export interface CustomerUsageResponse {
  totalRequests: number;
  totalTokens: number;
  totalCostUnits: number;
  totalPriceUnits: number;
  currency: string;
  byModel: UsageByModel[];
}

// ---- Playground ----

export interface PlaygroundModel {
  _id: string;
  aliasId: string;
  displayName: string;
  description?: string | null;
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  attachment: boolean;
  limits: { context: number; input?: number; output?: number };
  modalities: { input: string[]; output: string[] };
  status?: string;
  currency: string;
  active: boolean;
}

export interface PlaygroundModelListResponse {
  items: PlaygroundModel[];
}

export interface PlaygroundCustomer {
  _id: string;
  name: string;
  email: string;
  status: string;
  /** Redacted when caller lacks balances:read. */
  balance?: Money;
}

export interface PlaygroundCustomerListResponse {
  items: PlaygroundCustomer[];
  total: number;
}

// ---- Organizations ----

export interface Organization {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  defaultCurrency: string;
  /** Caller's role in this org (per-membership). */
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationListResponse {
  items: Organization[];
  activeOrganizationId: string;
}

export interface OrganizationCreateRequest {
  name: string;
  slug?: string | undefined;
  defaultCurrency?: string | undefined;
}

export interface OrganizationCreateResponse {
  organization: Organization;
  token: string;
}

export interface OrganizationUpdateRequest {
  name?: string | undefined;
  slug?: string | undefined;
  defaultCurrency?: string | undefined;
}

export interface OrganizationSwitchRequest {
  organizationId: string;
}

export interface OrganizationSwitchResponse {
  token: string;
  role: string;
  activeOrganizationId: string;
  organization: Organization;
}

export interface OrganizationDeleteResponse {
  ok: boolean;
}
