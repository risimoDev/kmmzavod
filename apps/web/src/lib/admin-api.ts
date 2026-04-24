/**
 * Type-safe admin API client.
 * All requests include JWT from localStorage (or cookie, depending on your auth flow).
 *
 * Base URL is read from NEXT_PUBLIC_API_URL env var.
 */

import { getAccessToken, getRefreshToken, setTokens, clearTokens } from './api';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

async function refreshTokens(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: getRefreshToken() }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getAccessToken()}`,
    ...(init.headers as Record<string, string> ?? {}),
  };
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}/api/v1/admin${path}`, {
    ...init,
    headers,
  });

  // Token expired — try refresh
  if (res.status === 401 && getRefreshToken()) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      const retryHeaders: Record<string, string> = {
        Authorization: `Bearer ${getAccessToken()}`,
        ...(init.headers as Record<string, string> ?? {}),
      };
      if (init.body) retryHeaders['Content-Type'] = 'application/json';

      const retry = await fetch(`${BASE}/api/v1/admin${path}`, {
        ...init,
        headers: retryHeaders,
      });
      if (retry.ok) {
        if (retry.status === 204) return undefined as T;
        return retry.json() as Promise<T>;
      }
    }
    clearTokens();
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as any).message;
    throw new Error(typeof msg === 'string' ? msg : (msg ? JSON.stringify(msg) : `HTTP ${res.status}`));
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
    runwayTaskId: string | null;
    error: string | null;
    // Asset storage keys (MinIO) — present when the asset has been generated & saved
    avatarUrl: string | null;
    clipUrl: string | null;
    imageUrl: string | null;
    frameUrl: string | null;
    avatarDone: boolean;
    clipDone: boolean;
    imageDone: boolean;
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

export interface ServiceHealth {
  name: string;
  status: 'online' | 'offline';
  details: {
    pid: number;
    uptime: number;
    workers?: number;
    timestamp: string;
  } | null;
}

export interface ApiCheckResult {
  name: string;
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
  info?: string;
}

export interface DualApiCheck {
  name: string;
  direct: ApiCheckResult;
  proxy: ApiCheckResult | null;
}

export interface ProxyEndpointResult {
  status: 'ok' | 'error';
  latencyMs: number;
  ip?: string | null;
  error?: string;
}

export interface ProxyCheckResult {
  configured: boolean;
  proxyUrl: string | null;
  direct: ProxyEndpointResult;
  proxy: ProxyEndpointResult | null;
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

  recomposeJob: (id: string) =>
    apiFetch<{ jobId: string; status: string; mode: string }>(`/jobs/${id}/recompose`, { method: 'POST' }),

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

  // ── Services ────────────────────────────────────────────────────────────
  getServicesHealth: () =>
    apiFetch<{ services: ServiceHealth[] }>('/services/health'),

  restartService: (name: string) =>
    apiFetch<{ ok: boolean; service: string; message: string }>(`/services/${name}/restart`, { method: 'POST' }),

  // ── AI API Checks ──────────────────────────────────────────────────────
  checkApis: () =>
    apiFetch<{ checks: DualApiCheck[]; proxyUrl: string | null }>('/api-checks'),

  checkProxy: () =>
    apiFetch<ProxyCheckResult>('/proxy-check'),

  // ── Test Compose ──────────────────────────────────────────────────────
  testCompose: (params: {
    preset?: 'dynamic' | 'smooth' | 'minimal';
    scene_count?: number;
    scene_duration?: number;
    with_subtitles?: boolean;
    scene_keys?: string[];
  } = {}) =>
    apiFetch<{
      test_id: string;
      preset: string;
      compose_result: {
        output_key: string;
        duration_sec: number;
        file_size_bytes: number;
        width: number;
        height: number;
        scene_count: number;
      };
      output_url: string;
      elapsed_ms: number;
    }>('/test-compose', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // ── Pipeline Test (step-by-step) ─────────────────────────────────────────

  pipelineTestScript: (params: {
    productName: string;
    productDescription?: string;
    features?: string[];
    targetAudience?: string;
    brandVoice?: string;
    prompt: string;
    language?: string;
    imageKeys?: string[];
  }) =>
    apiFetch<{
      title: string;
      scenes: Array<{
        scene_index: number;
        type: 'avatar' | 'clip' | 'image' | 'text';
        script?: string;
        b_roll_prompt?: string;
        duration_sec: number;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    }>('/pipeline-test/script', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  pipelineTestUploadScene: async (file: File): Promise<{ key: string; url: string; size: number; mimetype: string }> => {
    const form = new FormData();
    form.append('file', file);

    const doUpload = (token: string) =>
      fetch(`${BASE}/api/v1/admin/pipeline-test/upload-scene`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

    let res = await doUpload(getAccessToken());

    // Token expired — try refresh
    if (res.status === 401 && getRefreshToken()) {
      const refreshed = await refreshTokens();
      if (refreshed) {
        res = await doUpload(getAccessToken());
      } else {
        clearTokens();
        if (typeof window !== 'undefined') window.location.href = '/login';
        throw new Error('Session expired');
      }
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as any).message ?? `HTTP ${res.status}`);
    }
    return res.json();
  },

  pipelineTestCompose: (params: {
    scenes: Array<{
      type: 'avatar' | 'clip' | 'image' | 'text';
      storage_key: string;
      duration_sec: number;
      script?: string;
    }>;
    preset?: 'dynamic' | 'smooth' | 'minimal';
    with_subtitles?: boolean;
    subtitle_style?: 'tiktok' | 'cinematic' | 'minimal' | 'default';
  }) =>
    apiFetch<{
      test_id: string;
      preset: string;
      compose_result: {
        output_key: string;
        duration_sec: number;
        file_size_bytes: number;
        width: number;
        height: number;
        scene_count: number;
      };
      output_url: string;
      elapsed_ms: number;
    }>('/pipeline-test/compose', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  pipelineTestStartAvatar: (params: {
    script: string;
    avatar_id: string;
    voice_id: string;
    bg_color?: string;
    target_duration?: number;
  }) =>
    apiFetch<{ heygen_video_id: string }>('/pipeline-test/start-avatar', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  pipelineTestAvatarStatus: (videoId: string) =>
    apiFetch<{
      status: string;
      key?: string;
      url?: string;
      duration_sec?: number;
      error?: string;
    }>(`/pipeline-test/avatar-status/${encodeURIComponent(videoId)}`),

  // ── Test run history ────────────────────────────────────────────────────
  pipelineTestSaveRun: (params: Record<string, any>) =>
    apiFetch<{ id: string }>('/pipeline-test/runs', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  pipelineTestListRuns: (limit = 20, offset = 0) =>
    apiFetch<{
      data: Array<{
        id: string;
        productName: string;
        title: string | null;
        layoutTemplate: string;
        targetDuration: number;
        outputUrl: string | null;
        durationSec: number | null;
        status: string;
        createdAt: string;
        avatarId: string;
        voiceId: string;
      }>;
      total: number;
    }>(`/pipeline-test/runs?limit=${limit}&offset=${offset}`),

  pipelineTestLoadRun: (id: string) =>
    apiFetch<{
      id: string;
      productName: string;
      prompt: string;
      language: string;
      avatarId: string;
      voiceId: string;
      layoutTemplate: string;
      targetDuration: number;
      subtitleStyle: string | null;
      title: string | null;
      fullScript: string | null;
      outputUrl: string | null;
      outputKey: string | null;
      durationSec: number | null;
      fileSizeBytes: number | null;
      elapsedMs: number | null;
      params: Record<string, any>;
      status: string;
    }>(`/pipeline-test/runs/${encodeURIComponent(id)}`),

  pipelineTestDeleteRun: (id: string) =>
    apiFetch<void>(`/pipeline-test/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── Layout mode ───────────────────────────────────────────────────────────

  pipelineTestLayoutTemplates: () =>
    apiFetch<Record<string, {
      name: string;
      description: string;
      segments: Array<{ layout: string; weight: number; bg_type: string }>;
    }>>('/pipeline-test/layout-templates'),

  pipelineTestGenerateScriptLayout: (params: {
    productName: string;
    productDescription?: string;
    features: string[];
    targetAudience?: string;
    brandVoice?: string;
    prompt: string;
    language: string;
    imageKeys: string[];
    targetDuration?: number;
    gender?: 'male' | 'female';
  }) =>
    apiFetch<{
      title: string;
      full_script: string;
      b_roll_prompts: Array<{ type: string; prompt: string }>;
    }>('/pipeline-test/generate-script-layout', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  pipelineTestComposeLayout: (params: {
    avatar_storage_key: string;
    backgrounds: Array<{ storage_key: string; type: string }>;
    layout_template: string;
    with_subtitles: boolean;
    subtitle_style: string;
    full_script?: string;
    audio_track?: { storage_key: string; volume: number };
  }) =>
    apiFetch<{
      test_id: string;
      layout_template: string;
      compose_result: {
        output_key: string;
        duration_sec: number;
        file_size_bytes: number;
        width: number;
        height: number;
        scene_count: number;
      };
      output_url: string;
      elapsed_ms: number;
    }>('/pipeline-test/compose-layout', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
};
