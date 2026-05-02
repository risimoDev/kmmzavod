/**
 * User-facing API client.
 * Handles auth tokens, refresh flow, and typed endpoints.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

// ── Token management ─────────────────────────────────────────────────────────

export function getAccessToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('access_token') ?? '';
}

export function getRefreshToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('refresh_token') ?? '';
}

export function setTokens(access: string, refresh: string) {
  localStorage.setItem('access_token', access);
  localStorage.setItem('refresh_token', refresh);
}

export function clearTokens() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('user');
  localStorage.removeItem('tenant');
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getStoredTenant(): AuthTenant | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('tenant');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── Fetch wrapper with auto-refresh ──────────────────────────────────────────

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getAccessToken()}`,
    ...(init.headers as Record<string, string> ?? {}),
  };
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
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

      const retry = await fetch(`${BASE}${path}`, {
        ...init,
        headers: retryHeaders,
      });
      if (retry.ok) {
        if (retry.status === 204) return undefined as T;
        return retry.json() as Promise<T>;
      }
    }
    // Refresh failed — clear everything, redirect to login
    clearTokens();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  platformRole?: string;
  displayName?: string;
}

export interface AuthTenant {
  id: string;
  slug: string;
  plan?: string;
}

export interface Video {
  id: string;
  title: string;
  status: string;
  thumbnailUrl: string | null;
  durationSec: number | null;
  creditsUsed: number;
  createdAt: string;
  completedAt: string | null;
}

export interface VideoDetail extends Video {
  description: string | null;
  outputUrl: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  variants: VideoVariant[];
  publishJobs: PublishJob[];
  job: {
    id: string;
    status: string;
    error: string | null;
    scenes: Array<{
      id: string;
      sceneIndex: number;
      type: string;
      status: string;
      durationSec: number | null;
      avatarDone: boolean;
      clipDone: boolean;
      imageDone: boolean;
      error: string | null;
    }>;
    events: Array<{
      id: number;
      stage: string;
      status: string;
      message: string | null;
      createdAt: string;
    }>;
  } | null;
}

export interface VideoVariant {
  id: string;
  preset: string;
  status: string;
  outputUrl: string | null;
  previewUrl: string | null;  // presigned URL for playback (expires 1h, set by API)
  durationSec: number | null;
  fileSizeMb: number | null;
  selectedAt: string | null;
}

export interface PublishJob {
  id: string;
  platform: string;
  status: string;
  publishedAt: string | null;
  externalPostId: string | null;
  error: string | null;
  scheduledAt: string | null;
  socialAccountId: string;
}

export interface SocialAccount {
  id: string;
  platform: string;
  accountName: string;
  isActive: boolean;
  expiresAt: string | null;
  proxyUrl: string | null;
  createdAt: string;
  _count?: { publishJobs: number };
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  settings: Record<string, unknown>;
  isArchived: boolean;
  createdAt: string;
  _count: { videos: number; assets: number };
}

export interface ProjectDetail extends Project {
  videos: Array<{ id: string; title: string; status: string; createdAt: string }>;
  assets: Array<{ id: string; type: string; filename: string; url: string }>;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface DashboardStats {
  videosTotal: number;
  videosThisWeek: number;
  activeJobs: number;
  creditsUsed: number;
  creditsTotal: number;
  storageUsedBytes: number;
  storageLimitBytes: number;
}

// ── Auth API ──────────────────────────────────────────────────────────────────

export const authApi = {
  login: async (email: string, password: string) => {
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as any).message ?? 'Login failed');
    }
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    localStorage.setItem('tenant', JSON.stringify(data.tenant));
    return data as { user: AuthUser; tenant: AuthTenant; accessToken: string; refreshToken: string };
  },

  register: async (email: string, password: string, tenantName: string, displayName?: string) => {
    const res = await fetch(`${BASE}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, tenantName, displayName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as any).message ?? 'Registration failed');
    }
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    localStorage.setItem('tenant', JSON.stringify(data.tenant));
    return data as { user: AuthUser; tenant: AuthTenant; accessToken: string; refreshToken: string };
  },

  logout: async () => {
    try {
      await fetch(`${BASE}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({ refreshToken: getRefreshToken() }),
      });
    } catch {}
    clearTokens();
  },
};

// ── Videos API ────────────────────────────────────────────────────────────────

export const videosApi = {
  list: (params: { status?: string; projectId?: string; page?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.projectId) q.set('projectId', params.projectId);
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    return apiFetch<{ data: Video[]; pagination: Pagination }>(`/api/v1/videos?${q}`);
  },

  get: (id: string) => apiFetch<VideoDetail>(`/api/v1/videos/${id}`),

  avatars: () =>
    apiFetch<{
      avatars: Array<{
        avatar_id: string;
        avatar_name: string;
        preview_image_url: string | null;
        gender: string | null;
      }>;
    }>('/api/v1/videos/avatars'),

  voices: (params: { language?: string; gender?: string; limit?: number; token?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.language) q.set('language', params.language);
    if (params.gender) q.set('gender', params.gender);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.token) q.set('token', params.token);
    return apiFetch<{
      data: Array<{
        voice_id: string;
        name: string;
        gender: string | null;
        language: string | null;
        preview_audio_url: string | null;
        support_locale: boolean;
      }>;
      has_more: boolean;
      next_token: string | null;
    }>(`/api/v1/videos/voices?${q}`);
  },

  create: (body: {
    title: string;
    scriptPrompt?: string;
    projectId?: string;
    productId?: string;
    description?: string;
    avatarId?: string;
    voiceId?: string;
    durationSec?: number;
    settings?: { resolution?: string; fps?: number; language?: string; bgm_enabled?: boolean; video_format?: string; [key: string]: unknown };
    audioTrack?: { storage_key: string; volume: number };
  }) =>
    apiFetch<{ video: { id: string; title: string; status: string; createdAt: string }; jobId: string }>(
      '/api/v1/videos',
      { method: 'POST', body: JSON.stringify(body) }
    ),

  delete: (id: string) =>
    apiFetch<void>(`/api/v1/videos/${id}`, { method: 'DELETE' }),

  downloadUrl: (id: string) =>
    apiFetch<{ url: string; expiresIn: number }>(`/api/v1/videos/${id}/download`),

  variantStreamUrl: (videoId: string, variantId: string) =>
    apiFetch<{ url: string; expiresIn: number }>(`/api/v1/videos/${videoId}/variants/${variantId}/stream`),

  selectVariant: (id: string, variantId: string) =>
    apiFetch<void>(`/api/v1/videos/${id}/select-variant`, {
      method: 'PATCH',
      body: JSON.stringify({ variantId }),
    }),

  publish: (id: string, body: { socialAccountId: string; platform: string; scheduledAt?: string }) =>
    apiFetch<PublishJob>(`/api/v1/videos/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── Social Accounts API ───────────────────────────────────────────────────────

export const socialAccountsApi = {
  list: () => apiFetch<{ data: SocialAccount[] }>('/api/v1/social-accounts').then(r => r.data),

  create: (body: {
    platform: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    accountName: string;
    igUserId?: string;
    proxyUrl?: string;
  }) =>
    apiFetch<SocialAccount>('/api/v1/social-accounts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  delete: (id: string) =>
    apiFetch<{ success: boolean }>(`/api/v1/social-accounts/${id}`, { method: 'DELETE' }),
};

// ── Projects API ──────────────────────────────────────────────────────────────

export const projectsApi = {
  list: () => apiFetch<Project[]>('/api/v1/projects'),

  get: (id: string) => apiFetch<ProjectDetail>(`/api/v1/projects/${id}`),

  create: (body: { name: string; description?: string }) =>
    apiFetch<Project>('/api/v1/projects', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: { name?: string; description?: string }) =>
    apiFetch<Project>(`/api/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  delete: (id: string) =>
    apiFetch<void>(`/api/v1/projects/${id}`, { method: 'DELETE' }),
};

// ── Product Types ─────────────────────────────────────────────────────────────

export interface Product {
  id: string;
  name: string;
  description: string | null;
  features: string[];
  targetAudience: string | null;
  brandVoice: string | null;
  category: string | null;
  price: string | null;
  websiteUrl: string | null;
  images: string[];
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { videos: number };
}

export interface ProductDetail extends Product {
  videos: Array<{
    id: string;
    title: string;
    status: string;
    thumbnailUrl: string | null;
    durationSec: number | null;
    createdAt: string;
  }>;
}

// ── Products API ──────────────────────────────────────────────────────────────

export const productsApi = {
  list: (params: { projectId?: string; page?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.projectId) q.set('projectId', params.projectId);
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    return apiFetch<{ data: Product[]; pagination: Pagination }>(`/api/v1/products?${q}`);
  },

  get: (id: string) => apiFetch<ProductDetail>(`/api/v1/products/${id}`),

  create: (body: {
    name: string;
    description?: string;
    features?: string[];
    targetAudience?: string;
    brandVoice?: string;
    category?: string;
    price?: string;
    websiteUrl?: string;
    images?: string[];
    projectId?: string;
  }) =>
    apiFetch<Product>('/api/v1/products', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: {
    name?: string;
    description?: string;
    features?: string[];
    targetAudience?: string;
    brandVoice?: string;
    category?: string;
    price?: string;
    websiteUrl?: string;
    images?: string[];
  }) =>
    apiFetch<Product>(`/api/v1/products/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  delete: (id: string) =>
    apiFetch<void>(`/api/v1/products/${id}`, { method: 'DELETE' }),

  uploadImage: async (file: File): Promise<{ key: string; url: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/api/v1/products/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAccessToken()}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as any).message ?? `HTTP ${res.status}`);
    }
    return res.json();
  },

  scrapeWb: (url: string) =>
    apiFetch<{
      articleId: string;
      name: string;
      description: string;
      price: string | null;
      brand: string;
      characteristics: string[];
      imageUrls: string[];
      sourceUrl: string;
    }>('/api/v1/products/scrape-wb', { method: 'POST', body: JSON.stringify({ url }) }),
};

export interface VideoPreset {
  id: string;
  tenantId: string;
  productId: string;
  name: string;
  status: 'draft' | 'preview' | 'active' | 'paused';
  heygenAvatarId: string;
  heygenVoiceId: string;
  editStyle: string;
  targetDurationSec: number;
  customPrompt: string | null;
  cronExpression: string | null;
  timezone: string;
  autoPublish: boolean;
  publishPlatforms: string[];
  socialAccountIds: string[];
  bgmEnabled: boolean;
  totalRuns: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  product?: { id: string; name: string };
  previewVideo?: { id: string; status: string; outputUrl: string | null; thumbnailUrl?: string | null };
  _count?: { videos: number };
}

export const presetsApi = {
  list: (params?: { productId?: string; status?: string; page?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.productId) qs.set('productId', params.productId);
    if (params?.status) qs.set('status', params.status);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return apiFetch<{ presets: VideoPreset[]; total: number; page: number; limit: number }>(
      `/api/v1/presets${query ? `?${query}` : ''}`,
    );
  },

  get: (id: string) =>
    apiFetch<{ preset: VideoPreset }>(`/api/v1/presets/${id}`),

  create: (body: {
    productId: string;
    name?: string;
    heygenAvatarId?: string;
    heygenVoiceId?: string;
    editStyle?: string;
    targetDurationSec?: number;
    customPrompt?: string;
    cronExpression?: string;
    timezone?: string;
    autoPublish?: boolean;
    publishPlatforms?: string[];
    socialAccountIds?: string[];
    bgmEnabled?: boolean;
  }) =>
    apiFetch<{ preset: VideoPreset }>('/api/v1/presets', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: Partial<Parameters<typeof presetsApi.create>[1]>) =>
    apiFetch<{ preset: VideoPreset }>(`/api/v1/presets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  delete: (id: string) =>
    apiFetch<void>(`/api/v1/presets/${id}`, { method: 'DELETE' }),

  preview: (id: string) =>
    apiFetch<{ video: any; jobId: string }>(`/api/v1/presets/${id}/preview`, { method: 'POST' }),

  activate: (id: string) =>
    apiFetch<{ preset: VideoPreset }>(`/api/v1/presets/${id}/activate`, { method: 'POST' }),

  pause: (id: string) =>
    apiFetch<{ preset: VideoPreset }>(`/api/v1/presets/${id}/pause`, { method: 'POST' }),
};
