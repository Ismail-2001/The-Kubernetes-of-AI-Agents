import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{3,63}$/;

export const NamespaceTier = {
  SANDBOX: "sandbox",
  STANDARD: "standard",
  ENTERPRISE: "enterprise",
} as const;

export type NamespaceTierValue = (typeof NamespaceTier)[keyof typeof NamespaceTier];

export interface NamespaceQuotas {
  maxAgents: number;
  maxConcurrentExecutions: number;
  maxMemoryMB: number;
  maxToolCallsPerMinute: number;
}

export interface Namespace {
  id: string;
  slug: string;
  displayName: string;
  tier: NamespaceTierValue;
  ownerId: string;
  quotas: NamespaceQuotas;
  createdAt: Date;
  updatedAt: Date;
  suspendedAt?: Date;
  deletedAt?: Date;
}

export interface AuditLogEntry {
  id: string;
  namespaceId: string;
  actorId: string;
  action: "create" | "suspend" | "delete" | "update";
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown>;
  timestamp: Date;
}

export const NamespaceQuotasSchema = z.object({
  maxAgents: z.number().int().min(1).max(10000),
  maxConcurrentExecutions: z.number().int().min(1).max(1000),
  maxMemoryMB: z.number().int().min(64).max(1048576),
  maxToolCallsPerMinute: z.number().int().min(1).max(100000),
});

export const CreateNamespaceSchema = z.object({
  slug: z.string().regex(SLUG_RE, "Slug must be 3-63 lowercase alphanumeric or hyphen characters"),
  displayName: z.string().min(1).max(255),
  tier: z.enum(["sandbox", "standard", "enterprise"]),
  ownerId: z.string().regex(UUID_RE, "Owner ID must be a valid UUID"),
  quotas: NamespaceQuotasSchema,
});

export const UpdateNamespaceSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  quotas: NamespaceQuotasSchema.partial().optional(),
}).refine((data) => data.displayName !== undefined || data.quotas !== undefined, {
  message: "At least one field must be provided for update",
});

export const DEFAULT_QUOTAS: Record<NamespaceTierValue, NamespaceQuotas> = {
  sandbox: {
    maxAgents: 5,
    maxConcurrentExecutions: 2,
    maxMemoryMB: 512,
    maxToolCallsPerMinute: 30,
  },
  standard: {
    maxAgents: 50,
    maxConcurrentExecutions: 20,
    maxMemoryMB: 8192,
    maxToolCallsPerMinute: 500,
  },
  enterprise: {
    maxAgents: 1000,
    maxConcurrentExecutions: 200,
    maxMemoryMB: 131072,
    maxToolCallsPerMinute: 10000,
  },
};

export function validateSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function isNamespaceSuspended(ns: Namespace): boolean {
  return ns.suspendedAt !== undefined && ns.deletedAt === undefined;
}

export function isNamespaceDeleted(ns: Namespace): boolean {
  return ns.deletedAt !== undefined;
}
