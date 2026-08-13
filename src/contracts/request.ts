export const REQUEST_SCHEMA_VERSION = 1 as const;

export interface RequestIdentity {
  readonly schemaVersion: typeof REQUEST_SCHEMA_VERSION;
  readonly contextId: string;
}
