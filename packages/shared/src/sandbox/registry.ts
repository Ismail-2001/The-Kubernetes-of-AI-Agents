export interface SandboxRecord {
  executionId: string;
  agentId: string;
  namespace: string;
  ip: string;
  token: string;
  createdAt?: number;
  expiresAt?: number;
}

export interface ISandboxRegistry {
  register(record: SandboxRecord, ttlSeconds?: number): Promise<void>;
  get(executionId: string): Promise<SandboxRecord | null>;
  delete(executionId: string): Promise<boolean>;
  clear?(): Promise<void>;
}

export class InMemorySandboxRegistry implements ISandboxRegistry {
  private readonly store = new Map<string, { record: SandboxRecord; expiresAt: number }>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlSeconds = 3600) {
    this.defaultTtlMs = defaultTtlSeconds * 1000;
  }

  async register(record: SandboxRecord, ttlSeconds?: number): Promise<void> {
    const now = Date.now();
    const ttlMs = (ttlSeconds !== undefined ? ttlSeconds : this.defaultTtlMs / 1000) * 1000;
    const expiresAt = now + ttlMs;
    this.store.set(record.executionId, {
      record: {
        ...record,
        createdAt: record.createdAt ?? now,
        expiresAt,
      },
      expiresAt,
    });
  }

  async get(executionId: string): Promise<SandboxRecord | null> {
    const item = this.store.get(executionId);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(executionId);
      return null;
    }
    return { ...item.record };
  }

  async delete(executionId: string): Promise<boolean> {
    return this.store.delete(executionId);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

let defaultRegistryInstance: ISandboxRegistry | null = null;

export function getSandboxRegistry(): ISandboxRegistry {
  if (!defaultRegistryInstance) {
    defaultRegistryInstance = new InMemorySandboxRegistry();
  }
  return defaultRegistryInstance;
}

export function setSandboxRegistry(registry: ISandboxRegistry): void {
  defaultRegistryInstance = registry;
}

