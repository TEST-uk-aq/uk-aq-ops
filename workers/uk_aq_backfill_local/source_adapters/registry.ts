/** Ordered source-adapter registration without source acquisition side effects. */

export type SourceAdapterKind =
  | "breathelondon"
  | "sensorcommunity"
  | "openaq"
  | "sos";

export type SourceAdapterDescriptor = {
  kind: SourceAdapterKind;
  enabled: boolean;
  connectorCode: string;
  fallbackConnectorId: number | null;
  prerequisiteAvailable?: boolean;
  disabledWarning: string;
  missingPrerequisiteWarning?: string;
  fallbackWarning: (connectorId: number) => string;
  unresolvedWarning: string;
};

export async function resolveSourceAdapterRegistry(
  descriptors: readonly SourceAdapterDescriptor[],
  resolveConnectorId: (connectorCode: string) => Promise<number | null>,
): Promise<{ registry: Map<number, SourceAdapterKind>; warnings: string[] }> {
  const registry = new Map<number, SourceAdapterKind>();
  const warnings: string[] = [];
  for (const descriptor of descriptors) {
    if (!descriptor.enabled) {
      warnings.push(descriptor.disabledWarning);
      continue;
    }
    if (descriptor.prerequisiteAvailable === false) {
      warnings.push(descriptor.missingPrerequisiteWarning || descriptor.unresolvedWarning);
      continue;
    }
    const resolved = await resolveConnectorId(descriptor.connectorCode);
    const fallback = descriptor.fallbackConnectorId;
    const connectorId = resolved || (
      Number.isInteger(fallback) && Number(fallback) > 0 ? Number(fallback) : null
    );
    if (!connectorId) {
      warnings.push(descriptor.unresolvedWarning);
      continue;
    }
    if (!resolved) {
      warnings.push(descriptor.fallbackWarning(connectorId));
    }
    registry.set(connectorId, descriptor.kind);
  }
  return { registry, warnings };
}
