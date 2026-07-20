import { CONFIG_FIELDS } from "./fields.ts";
import type { ConfigField, ConfigValue, ManifestField, ReleaseManifest } from "./types.ts";

export const MANAGER_RELEASE_DIR = "manager/release";
export const MANIFEST_JSON = "manifest.json";
export const MANIFEST_ENV = "manifest.env";
export const DEFAULTS_ENV = "defaults.env";
export const ALLOWED_KEYS_TXT = "allowed-env-keys.txt";

export function buildManifest(minManagerVersion: string): ReleaseManifest {
  const fields: ManifestField[] = CONFIG_FIELDS.map((field) => toManifestField(field)).sort(
    (a, b) => a.key.localeCompare(b.key),
  );
  return { schema: 1, minManagerVersion, fields };
}

function toManifestField(field: ConfigField): ManifestField {
  const base: ManifestField = {
    key: field.key,
    kind: field.kind,
    scope: field.scope,
    required: field.required,
    secret: field.secret === true,
    derived: field.derived === true,
  };
  const out: Record<string, unknown> = { ...base };
  if (field.yamlPath !== undefined) out.yamlPath = field.yamlPath;
  if (field.default !== undefined) out.default = field.default;
  if (field.runtimeKey !== undefined) out.runtimeKey = field.runtimeKey;
  if (field.validation !== undefined) out.validation = field.validation;
  if (field.deprecatedSince !== undefined) out.deprecatedSince = field.deprecatedSince;
  if (field.since !== undefined) out.since = field.since;
  return out as unknown as ManifestField;
}

export function manifestJson(manifest: ReleaseManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function requiredKeys(manifest: ReleaseManifest): readonly string[] {
  return manifest.fields
    .filter((field) => field.required && !field.derived)
    .map((field) => field.key);
}

export function secretKeys(manifest: ReleaseManifest): readonly string[] {
  return manifest.fields.filter((field) => field.secret).map((field) => field.key);
}

export function allowedKeys(manifest: ReleaseManifest): readonly string[] {
  return manifest.fields.map((field) => field.key);
}

export function defaultsEnv(manifest: ReleaseManifest): string {
  const lines: string[] = [];
  for (const field of manifest.fields) {
    if (field.secret || field.derived || field.default === undefined) continue;
    lines.push(`${field.key}=${formatEnvValue(field.default)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function manifestEnv(manifest: ReleaseManifest): string {
  const lines = [
    "MANIFEST_SCHEMA=1",
    `MIN_MANAGER_VERSION=${manifest.minManagerVersion}`,
    `REQUIRED_KEYS=${requiredKeys(manifest).join(",")}`,
    `SECRET_KEYS=${secretKeys(manifest).join(",")}`,
    `ALLOWED_KEYS=${allowedKeys(manifest).join(",")}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function allowedKeysTxt(manifest: ReleaseManifest): string {
  return `${allowedKeys(manifest).join("\n")}\n`;
}

export function formatEnvValue(value: ConfigValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value.join(",");
}
