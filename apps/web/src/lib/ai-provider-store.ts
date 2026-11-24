import { decryptApiKey, maskApiKey, type AiProviderType } from "@clipforge/core";
import { prisma, type AiProviderConfig } from "@clipforge/db";

export interface SafeAiProviderDto {
  id: string;
  provider: AiProviderType;
  label: string;
  model: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  keyPreview: string;
  isDefault: boolean;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toSafeAiProviderDto(row: AiProviderConfig): SafeAiProviderDto {
  let keyPreview = "No key (local)";
  if (row.encryptedApiKey) {
    try {
      const plain = decryptApiKey(row.encryptedApiKey);
      keyPreview = maskApiKey(plain);
    } catch {
      keyPreview = row.keyLast4 ? `••••${row.keyLast4}` : "••••••••";
    }
  }
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    model: row.model,
    baseUrl: row.baseUrl,
    hasApiKey: Boolean(row.encryptedApiKey),
    keyPreview,
    isDefault: row.isDefault,
    isEnabled: row.isEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listUserAiProviders(userId: string): Promise<SafeAiProviderDto[]> {
  const rows = await prisma.aiProviderConfig.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  return rows.map(toSafeAiProviderDto);
}
