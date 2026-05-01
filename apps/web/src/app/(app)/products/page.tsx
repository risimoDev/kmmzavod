"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import {
  Button,
  Card,
  CardContent,
  Input,
  Textarea,
  Badge,
  LoadingSpinner,
  EmptyState,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { productsApi, type Product } from "@/lib/api";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export default function ProductsPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const LIMIT = 20;

  // Edit modal
  const [editing, setEditing] = useState<Product | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    features: "",
    targetAudience: "",
    brandVoice: "",
    category: "",
    price: "",
    websiteUrl: "",
  });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await productsApi.list({ page, limit: LIMIT });
      setProducts(resp.data);
      setTotal(resp.pagination.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, [page]);

  useEffect(() => { loadProducts(); }, [loadProducts]);

  const filtered = search.trim()
    ? products.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          (p.description ?? "").toLowerCase().includes(search.toLowerCase()) ||
          (p.category ?? "").toLowerCase().includes(search.toLowerCase())
      )
    : products;

  const openEdit = (p: Product) => {
    setEditing(p);
    setEditForm({
      name: p.name,
      description: p.description ?? "",
      features: p.features.join(", "),
      targetAudience: p.targetAudience ?? "",
      brandVoice: p.brandVoice ?? "",
      category: p.category ?? "",
      price: p.price ?? "",
      websiteUrl: p.websiteUrl ?? "",
    });
    setEditError(null);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    setEditError(null);
    try {
      await productsApi.update(editing.id, {
        name: editForm.name,
        description: editForm.description || undefined,
        features: editForm.features.split(",").map((f) => f.trim()).filter(Boolean),
        targetAudience: editForm.targetAudience || undefined,
        brandVoice: editForm.brandVoice || undefined,
        category: editForm.category || undefined,
        price: editForm.price || undefined,
        websiteUrl: editForm.websiteUrl || undefined,
      });
      setEditing(null);
      loadProducts();
    } catch (err: any) {
      setEditError(err.message ?? "Ошибка сохранения");
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Архивировать продукт?")) return;
    try {
      await productsApi.delete(id);
      loadProducts();
    } catch { /* ignore */ }
  };

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <>
      <TopBar title="Продукты" />
      <main className="flex-1 p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <p className="text-sm text-text-tertiary">
                {total} {total === 1 ? "продукт" : "продуктов"} · Выбирайте при создании видео
              </p>
            </div>
            <div className="flex items-center gap-3 w-full sm:w-auto">
              <Input
                placeholder="Поиск..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="w-full sm:w-56"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => router.push("/create")}
              >
                + Создать видео
              </Button>
            </div>
          </div>

          {/* Products grid */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <LoadingSpinner size={28} />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              title="Нет продуктов"
              description="Продукты создаются автоматически при создании видео. Также можно добавить через Wildberries."
              icon={
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-tertiary">
                  <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
                  <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>
                </svg>
              }
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filtered.map((product) => (
                <Card key={product.id} hoverable onClick={() => openEdit(product)}>
                  <CardContent className="pt-4 pb-4 space-y-3">
                    {/* Product image */}
                    {product.images.length > 0 ? (
                      <div className="aspect-square rounded-lg bg-surface-2 overflow-hidden">
                        <img
                          src={`${BASE}/api/v1/products/${product.id}/image-preview?key=${encodeURIComponent(product.images[0])}`}
                          alt={product.name}
                          className="w-full h-full object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      </div>
                    ) : (
                      <div className="aspect-square rounded-lg bg-surface-2 flex items-center justify-center">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-text-tertiary">
                          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
                        </svg>
                      </div>
                    )}

                    <div>
                      <h3 className="text-sm font-semibold text-text-primary line-clamp-1">{product.name}</h3>
                      {product.description && (
                        <p className="text-xs text-text-tertiary mt-1 line-clamp-2">{product.description}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      {product.category && (
                        <Badge variant="default">{product.category}</Badge>
                      )}
                      {product.price && (
                        <span className="text-xs font-medium text-brand-400">{product.price}</span>
                      )}
                      {product._count?.videos !== undefined && product._count.videos > 0 && (
                        <span className="text-xs text-text-tertiary">{product._count.videos} видео</span>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <span className="text-xs text-text-tertiary">
                        {new Date(product.createdAt).toLocaleDateString("ru-RU")}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/create?productId=${product.id}`);
                          }}
                        >
                          Создать видео
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-red-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(product.id);
                          }}
                        >
                          ✕
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ← Назад
              </Button>
              <span className="text-sm text-text-tertiary">{page} / {totalPages}</span>
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Далее →
              </Button>
            </div>
          )}
        </div>
      </main>

      {/* ── Edit modal ──────────────────────────────────────────── */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditing(null)}>
          <div className="bg-surface-0 border border-border rounded-2xl w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-text-primary">Редактировать продукт</h3>
                <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>✕</Button>
              </div>

              {editError && (
                <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{editError}</div>
              )}

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-secondary">Название</label>
                  <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-secondary">Описание</label>
                  <Textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={3} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-secondary">Характеристики</label>
                    <Input value={editForm.features} onChange={(e) => setEditForm({ ...editForm, features: e.target.value })} placeholder="Через запятую" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-secondary">Целевая аудитория</label>
                    <Input value={editForm.targetAudience} onChange={(e) => setEditForm({ ...editForm, targetAudience: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-secondary">Категория</label>
                    <Input value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-text-secondary">Цена</label>
                    <Input value={editForm.price} onChange={(e) => setEditForm({ ...editForm, price: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-secondary">Тон бренда</label>
                  <select
                    className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary"
                    value={editForm.brandVoice}
                    onChange={(e) => setEditForm({ ...editForm, brandVoice: e.target.value })}
                  >
                    <option value="">Не задан</option>
                    <option value="professional">Профессиональный</option>
                    <option value="friendly">Дружелюбный</option>
                    <option value="expert">Экспертный</option>
                    <option value="casual">Неформальный</option>
                    <option value="luxury">Премиальный</option>
                  </select>
                </div>
              </div>

              {/* Images preview */}
              {editing.images.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-secondary">Изображения ({editing.images.length})</label>
                  <div className="flex gap-2 overflow-x-auto">
                    {editing.images.map((key, i) => (
                      <img
                        key={i}
                        src={`${BASE}/api/v1/products/${editing.id}/image-preview?key=${encodeURIComponent(key)}`}
                        alt={`Image ${i + 1}`}
                        className="w-16 h-16 rounded-lg object-cover flex-shrink-0 bg-surface-2"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <Button variant="primary" onClick={handleSave} disabled={saving || !editForm.name.trim()} className="flex-1">
                  {saving ? <LoadingSpinner size={14} className="mr-1" /> : null}
                  Сохранить
                </Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>Отмена</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
