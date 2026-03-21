"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Card, CardContent, Input, Badge, LoadingSpinner } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { relativeTime, formatDuration } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { projectsApi, videosApi, getAccessToken, type Project, type ProjectDetail } from "@/lib/api";

const COLORS = ["#7C3AED", "#0EA5E9", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#8B5CF6", "#06B6D4"];

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) { router.replace("/login"); return; }
    projectsApi.list()
      .then(setProjects)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [router]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setDetailLoading(true);
    projectsApi.get(selected)
      .then(setDetail)
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  }, [selected]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const p = await projectsApi.create({ name: newName, description: newDesc || undefined });
      setProjects((prev) => [p, ...prev]);
      setNewName("");
      setNewDesc("");
      setCreateOpen(false);
    } catch {}
    setCreating(false);
  };

  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.description ?? "").toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <>
        <TopBar title="Проекты" />
        <main className="flex-1 flex items-center justify-center"><LoadingSpinner size={32} /></main>
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Проекты"
        actions={
          <Button variant="primary" size="sm" icon={<PlusIcon />} onClick={() => setCreateOpen(true)}>
            Новый проект
          </Button>
        }
      />

      <main className="flex-1 flex h-[calc(100vh-56px)] overflow-hidden">
        {/* Project list */}
        <aside className="w-72 flex-shrink-0 border-r border-border flex flex-col bg-surface-0">
          <div className="p-3 border-b border-border">
            <Input placeholder="Поиск проектов…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <ul className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {filtered.map((p, i) => (
              <li key={p.id}>
                <button
                  onClick={() => setSelected(p.id)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-lg transition-all",
                    selected === p.id
                      ? "bg-brand-500/10 border border-brand-500/25"
                      : "hover:bg-surface-2 border border-transparent"
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className={cn("text-sm font-medium truncate", selected === p.id ? "text-brand-400" : "text-text-primary")}>
                      {p.name}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1 pl-[18px]">
                    <span className="text-xs text-text-tertiary">{p._count.videos} видео</span>
                    <span className="text-xs text-text-tertiary">{relativeTime(p.createdAt)}</span>
                  </div>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="text-center text-text-tertiary text-sm py-8">
                {projects.length === 0 ? "Нет проектов" : "Ничего не найдено"}
              </li>
            )}
          </ul>
        </aside>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {selected && detail ? (
            <div className="animate-slide-up space-y-6">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-brand-500/10">
                    <FolderIcon className="w-5 h-5 text-brand-400" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-text-primary">{detail.name}</h2>
                    {detail.description && (
                      <p className="text-xs text-text-tertiary mt-0.5">{detail.description}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Card>
                  <CardContent className="py-3 px-4">
                    <p className="text-2xl font-bold text-text-primary">{detail._count.videos}</p>
                    <p className="text-xs text-text-tertiary mt-0.5">Всего видео</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-3 px-4">
                    <p className="text-2xl font-bold text-text-primary">{detail._count.assets}</p>
                    <p className="text-xs text-text-tertiary mt-0.5">Ассетов</p>
                  </CardContent>
                </Card>
              </div>

              {detail.videos.length > 0 ? (
                <div>
                  <p className="text-sm font-semibold text-text-primary mb-3">Видео в проекте</p>
                  <div className="rounded-xl border border-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-surface-1 text-text-tertiary text-xs uppercase tracking-wider">
                          <th className="text-left py-2.5 px-4 font-medium">Название</th>
                          <th className="text-left py-2.5 px-4 font-medium">Статус</th>
                          <th className="text-left py-2.5 px-4 font-medium">Дата</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.videos.map((v) => (
                          <tr
                            key={v.id}
                            onClick={() => router.push(`/videos/${v.id}`)}
                            className="border-t border-border hover:bg-surface-1 cursor-pointer transition-colors"
                          >
                            <td className="py-2.5 px-4 font-medium text-text-primary">{v.title}</td>
                            <td className="py-2.5 px-4"><StatusBadge status={v.status as any} /></td>
                            <td className="py-2.5 px-4 text-text-tertiary">{relativeTime(v.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-surface-1 p-8 text-center">
                  <p className="text-text-tertiary text-sm">В проекте пока нет видео</p>
                </div>
              )}
            </div>
          ) : selected && detailLoading ? (
            <div className="flex items-center justify-center h-full"><LoadingSpinner size={32} /></div>
          ) : (
            <div className="animate-slide-up">
              <p className="text-sm text-text-tertiary mb-6">Выберите проект слева или создайте новый</p>
              {projects.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {projects.map((p, i) => (
                    <button
                      key={p.id}
                      onClick={() => setSelected(p.id)}
                      className="w-full text-left rounded-xl border border-border bg-surface-1 p-5 hover:border-border/60 hover:shadow-elevation-2 transition-all"
                    >
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div
                          className="w-9 h-9 rounded-lg flex items-center justify-center"
                          style={{ background: COLORS[i % COLORS.length] + "22" }}
                        >
                          <FolderIcon style={{ color: COLORS[i % COLORS.length] }} />
                        </div>
                        <Badge variant="outline">{p._count.videos} видео</Badge>
                      </div>
                      <h3 className="text-sm font-semibold text-text-primary mb-1">{p.name}</h3>
                      {p.description && <p className="text-xs text-text-tertiary line-clamp-2">{p.description}</p>}
                    </button>
                  ))}
                  <button
                    onClick={() => setCreateOpen(true)}
                    className="rounded-xl border border-dashed border-border bg-transparent p-5 hover:border-brand-500/40 hover:bg-surface-1 transition-all flex flex-col items-center justify-center gap-2 min-h-[160px] text-text-tertiary hover:text-brand-400"
                  >
                    <PlusIcon className="w-6 h-6" />
                    <span className="text-sm font-medium">Новый проект</span>
                  </button>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-surface-1 p-12 text-center">
                  <FolderIcon className="w-10 h-10 text-text-tertiary mx-auto mb-3" />
                  <p className="text-text-secondary text-sm mb-4">Создайте первый проект для организации видео</p>
                  <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>Создать проект</Button>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Create modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-surface-1 border border-border rounded-xl p-6 w-full max-w-md shadow-elevation-3 animate-slide-up">
            <h3 className="text-base font-semibold text-text-primary mb-4">Новый проект</h3>
            <div className="space-y-3">
              <Input placeholder="Название проекта" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Input placeholder="Описание (опционально)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>Отмена</Button>
              <Button variant="primary" size="sm" onClick={handleCreate} disabled={creating || !newName.trim()}>
                {creating ? "Создание…" : "Создать"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// в”Ђв”Ђ Icons в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

function PlusIcon({ className }: { className?: string }) {
  return <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
}

function FolderIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <svg className={className} style={style} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>;
}
