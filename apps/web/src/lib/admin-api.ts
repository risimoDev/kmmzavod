/**
 * Type-safe admin API client.
 * All requests include JWT from localStorage (or cookie, depending on your auth flow).
 *
 * Base URL is read from NEXT_PUBLIC_API_URL env var.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('access_token') ?? '';
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api/v1/admin${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).message ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  tenant: { id: string; name: string; slug: string; plan: string };
  _count: { sessions: number };
}

export interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  plan: 'starter' | 'pro' | 'enterprise';
  credits: number;
  isActive: boolean;
  createdAt: string;
  _count: { users: number; jobs: number; videos: number };
}

export interface AdminVideo {
  id: string;
  title: string;
  status: string;
  durationSec: number | null;
  creditsUsed: number;
  createdAt: string;
  tenant:  { id: string; name: string; slug: string };
  creator: { id: string; email: string; displayName: string | null } | null;
  job:     { id: string; status: string; creditsUsed: number } | null;
}

export interface AdminJob {
  id: string;
  status: string;
  error: string | null;
  creditsUsed: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  tenant:  { id: string; name: string; slug: string };
  creator: { id: string; email: string } | null;
  video:   { id: string; title: string } | null;
  _count:  { scenes: number; events: number };
}

export interface AdminJobDetail extends AdminJob {
  scenes: Array<{
    id: string;
    sceneIndex: number;
    type: string;
    status: string;
    costUsd: number;
    heygenVideoId: string | null;
    klingTaskId: string | null;
    imageGenTaskId: string | null;
    error: string | null;
    generations: Array<{
      id: string;
      provider: string;
      model: string | null;
      status: string;
      costUsd: number;
      latencyMs: number | null;
      startedAt: string | null;
      completedAt: string | null;
    }>;
  }>;
  events: Array<{
    id: number;
    stage: string;
    status: string;
    message: string | null;
    meta: unknown;
    createdAt: string;
  }>;
}

export interface QueueStat {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface PlatformStats {
  tenants:      { total: number; active: number };
  users:        { total: number };
  videos:       { total: number; completedToday: number; failedToday: number };
  jobs:         { running: number; failedAll: number };
  credits:      { totalBalance: number };
  costUsdToday: number;
  queues:       QueueStat[];
}

export interface UsageRecord {
  id: string;
  tenantId: string;
  date: string;
  videosCreated: number;
  creditsUsed: number;
  totalCostUsd: number;
  apiCallsCount: number;
  tenant?: { id: string; name: string; slug: string };
}

export interface GenerationRecord {
  id: string;
  tenantId: string;
  jobId: string | null;
  sceneId: string | null;
  provider: string;
  model: string | null;
  status: string;
  costUsd: number;
  creditsCharged: number;
  latencyMs: number | null;
  createdAt: string;
  tenant: { id: string; name: string };
}

export interface ProviderCostBreakdown {
  provider: string;
  count: number;
  totalCostUsd: number;
  totalCredits: number;
  avgLatencyMs: number;
}

export interface AdminSetting {
  key: string;
  value: string;
  description: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  note: string | null;
  ipAddress: string | null;
  createdAt: string;
  admin: { id: string; email: string; displayName: string | null };
}

// ── API methods ───────────────────────────────────────────────────────────────

export const adminApi = {

  // ── Stats ──────────────────────────────────────────────────────────────────
  getStats: () =>
    apiFetch<PlatformStats>('/stats'),

  getQueueStats: () =>
    apiFetch<QueueStat[]>('/queue-stats'),

  // ── Users ──────────────────────────────────────────────────────────────────
  getUsers: (params: { page?: number; limit?: number; search?: string; role?: string; tenantId?: string; active?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.page)     q.set('page',     String(params.page));
    if (params.limit)    q.set('limit',    String(params.limit));
    if (params.search)   q.set('search',   params.search);
    if (params.role)     q.set('role',     params.role);
    if (params.tenantId) q.set('tenantId', params.tenantId);
    if (params.active !== undefined) q.set('active', String(params.active));
    return apiFetch<{ data: AdminUser[]; pagination: Pagination }>(`/users?${q}`);
  },

  getUser: (id: string) =>
    apiFetch<AdminUser & { recentJobs: unknown[]; lifetimeCostUsd: number }>(`/users/${id}`),

  updateUser: (id: string, body: { role?: string; isActive?: boolean; displayName?: string }) =>
    apiFetch<{ id: string; role: string; isActive: boolean }>(`/users/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),

  // ── Tenants ────────────────────────────────────────────────────────────────
  getTenants: (params: { page?: number; limit?: number; search?: string; plan?: string; active?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.page)     q.set('page',   String(params.page));
    if (params.limit)    q.set('limit',  String(params.limit));
    if (params.search)   q.set('search', params.search);
    if (params.plan)     q.set('plan',   params.plan);
    if (params.active !== undefined) q.set('active', String(params.active));
    return apiFetch<{ data: AdminTenant[]; pagination: Pagination }>(`/tenants?${q}`);
  },

  getTenant: (id: string) =>
    apiFetch<AdminTenant & { users: unknown[]; usageLast30: UsageRecord[]; creditHistory: unknown[]; costByProvider: ProviderCostBreakdown[] }>(`/tenants/${id}`),

  updateTenant: (id: string, body: { name?: string; plan?: string; isActive?: boolean }) =>
    apiFetch<{ id: string; name: string; plan: string; isActive: boolean }>(`/tenants/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),

  suspendTenant: (id: string) =>
    apiFetch<{ id: string; isActive: boolean }>(`/tenants/${id}/suspend`, { method: 'PATCH' }),

  reinstateTenant: (id: string) =>
    apiFetch<{ id: string; isActive: boolean }>(`/tenants/${id}/reinstate`, { method: 'PATCH' }),

  grantCredits: (id: string, amount: number, description?: string) =>
    apiFetch<{ id: string; credits: number }>(`/tenants/${id}/credits`, {
      method: 'PATCH', body: JSON.stringify({ amount, description }),
    }),

  // ── Videos ────────────────────────────────────────────────────────────────
  getVideos: (params: { page?: number; limit?: number; tenantId?: string; status?: string; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); });
    return apiFetch<{ data: AdminVideo[]; pagination: Pagination }>(`/videos?${q}`);
  },

  deleteVideo: (id: string) =>
    apiFetch<void>(`/videos/${id}`, { method: 'DELETE' }),

  // ── Jobs ──────────────────────────────────────────────────────────────────
  getJobs: (params: { page?: number; limit?: number; tenantId?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); });
    return apiFetch<{ data: AdminJob[]; pagination: Pagination }>(`/jobs?${q}`);
  },

  getJob: (id: string) =>
    apiFetch<AdminJobDetail>(`/jobs/${id}`),

  retryJob: (id: string) =>
    apiFetch<{ jobId: string; status: string }>(`/jobs/${id}/retry`, { method: 'POST' }),

  cancelJob: (id: string) =>
    apiFetch<{ jobId: string; status: string }>(`/jobs/${id}/cancel`, { method: 'POST' }),

  // ── Usage & Generations ───────────────────────────────────────────────────
  getUsage: (params: { tenantId?: string; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); });
    return apiFetch<{ data: UsageRecord[]; totals: { videosCreated: number; creditsUsed: number; costUsd: number; apiCalls: number } }>(`/usage?${q}`);
  },

  getGenerations: (params: { page?: number; limit?: number; tenantId?: string; provider?: string; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); });
    return apiFetch<{ data: GenerationRecord[]; byProvider: ProviderCostBreakdown[]; pagination: Pagination }>(`/generations?${q}`);
  },

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings: () =>
    apiFetch<AdminSetting[]>('/settings'),

  upsertSetting: (key: string, value: unknown, description?: string) =>
    apiFetch<AdminSetting>(`/settings/${key}`, {
      method: 'PUT', body: JSON.stringify({ value, description }),
    }),

  deleteSetting: (key: string) =>
    apiFetch<void>(`/settings/${key}`, { method: 'DELETE' }),

  // ── Audit ─────────────────────────────────────────────────────────────────
  getAudit: (params: { page?: number; limit?: number; action?: string; targetType?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); });
    return apiFetch<{ data: AuditEntry[]; pagination: Pagination }>(`/audit?${q}`);
  },
};
