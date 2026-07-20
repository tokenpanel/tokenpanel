export type ConfigScope = "api" | "deploy" | "shared";

export type ConfigKind =
  | "string"
  | "secret"
  | "boolean"
  | "integer"
  | "stringList"
  | "originList"
  | "proxyList"
  | "environment"
  | "mongoUri"
  | "mongoDbName"
  | "email"
  | "domain"
  | "timezone";

export type ConfigValue = string | number | boolean | readonly string[];

export interface ConfigValidation {
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly choices?: readonly string[];
}

export interface ConfigField {
  readonly key: string;
  readonly kind: ConfigKind;
  readonly scope: ConfigScope;
  readonly required: boolean;
  readonly description: string;
  readonly yamlPath?: string;
  readonly default?: ConfigValue;
  readonly secret?: boolean;
  readonly derived?: boolean;
  readonly runtimeKey?: string;
  booleanFormat?: "trueFalse" | "yn";
  readonly validation?: ConfigValidation;
  readonly deprecatedSince?: string;
  readonly since?: string;
}

export interface ConfigIssue {
  readonly key: string;
  readonly yamlPath?: string | undefined;
  readonly reason: string;
}

export class ConfigResolutionError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const summary = issues
      .map((issue) => `${issue.key}: ${issue.reason}`)
      .join("; ");
    super(`Invalid TokenPanel configuration: ${summary}`);
    this.name = "ConfigResolutionError";
    this.issues = issues;
  }
}

export interface ManifestField {
  readonly key: string;
  readonly kind: ConfigKind;
  readonly scope: ConfigScope;
  readonly required: boolean;
  readonly secret: boolean;
  readonly derived: boolean;
  readonly yamlPath?: string | undefined;
  readonly default?: ConfigValue | undefined;
  readonly runtimeKey?: string | undefined;
  readonly validation?: ConfigValidation | undefined;
  readonly deprecatedSince?: string | undefined;
  readonly since?: string | undefined;
}

export interface ReleaseManifest {
  readonly schema: 1;
  readonly minManagerVersion: string;
  readonly fields: readonly ManifestField[];
}
