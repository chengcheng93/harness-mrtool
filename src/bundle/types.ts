export const TEMPLATE_BUNDLE_PAYLOAD_PATHS = [
  "layout.md",
  "policy.yml",
  "profiles/code.yml",
  "profiles/docs.yml",
  "profiles/general.yml",
  "profiles/ops.yml",
  "registries/checkboxes.json",
  "registries/fields.json",
  "schema.json",
] as const;

export type TemplateBundlePayloadPath =
  (typeof TEMPLATE_BUNDLE_PAYLOAD_PATHS)[number];

export interface TemplateBundleFileManifest {
  readonly path: TemplateBundlePayloadPath;
  readonly size: number;
  readonly sha256: string;
}

export interface TemplateBundleManifest {
  readonly manifestVersion: 1;
  readonly bundleId: string;
  readonly version: string;
  readonly inputSchema: number;
  readonly policySchema: number;
  readonly files: readonly TemplateBundleFileManifest[];
}
