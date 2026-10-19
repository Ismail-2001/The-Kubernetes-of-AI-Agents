import { encrypt, isLegacyPayload, type EncryptedPayload } from "@e-gaop/shared";
import type { SecretRepository } from "./repository";

export interface UpgradeResult {
  upgraded: boolean;
}

export async function upgradeLegacyRow(params: {
  repo: SecretRepository;
  namespace: string;
  name: string;
  rowType: string;
  payload: EncryptedPayload;
  plaintext: string;
  masterKey: string;
  keyId: string;
}): Promise<UpgradeResult> {
  if (!isLegacyPayload(params.payload, params.masterKey)) {
    return { upgraded: false };
  }
  const upgraded = await encrypt(params.plaintext, params.masterKey, params.keyId);
  await params.repo.upsert({
    namespace: params.namespace,
    name: params.name,
    encryptedData: JSON.stringify(upgraded),
    type: params.rowType,
  });
  return { upgraded: true };
}
