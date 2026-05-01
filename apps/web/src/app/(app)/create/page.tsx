"use client";

import { useState, useRef, useCallback, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import * as Select from "@radix-ui/react-select";
import * as Switch from "@radix-ui/react-switch";
import { TopBar } from "@/components/layout/AppShell";
import { Button, Card, CardContent, Input, Textarea, Progress, Badge, LoadingSpinner } from "@/components/ui/primitives";
import { Stepper } from "@/components/ui/composite";
import { cn } from "@/lib/utils";
import { productsApi, videosApi, type Product } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

type UploadedImage = { key: string; url: string; file: File };

type FormData = {
  // Step 1 — Product
  productName: string;
  productDescription: string;
  features: string[];
  featureInput: string;
  targetAudience: string;
  brandVoice: string;
  category: string;
  price: string;
  websiteUrl: string;
  images: UploadedImage[];
  // Step 2 — Video settings
  videoIdea: string;
  language: string;
  style: string;
  avatar: string;
  voice: string;
  durationSec: number;
  subtitlesEnabled: boolean;
  subtitleStyle: string;
  bgmEnabled: boolean;
  videoFormat: "standard" | "slideshow";
  // Step 3 — Launch
};

const DEFAULT: FormData = {
  productName: "",
  productDescription: "",
  features: [],
  featureInput: "",
  targetAudience: "",
  brandVoice: "professional",
  category: "none",
  price: "",
  websiteUrl: "",
  images: [],
  videoIdea: "",
  language: "ru",
  style: "informative",
  avatar: "Anna_public_20240108",
  voice: "70856236390f4d0392d00187143d3900",
  durationSec: 30,
  subtitlesEnabled: true,
  subtitleStyle: "tiktok",
  bgmEnabled: true,
  videoFormat: "standard",
};

const STEPS = [
  { id: 1, label: "Product" },
  { id: 2, label: "Video settings" },
  { id: 3, label: "Launch" },
];

// ── Options ───────────────────────────────────────────────────────────────────

const LANGUAGES   = [{ value: "ru", label: "Russian" }, { value: "en", label: "English" }, { value: "de", label: "Deutsch" }];
const STYLES      = [{ value: "informative", label: "Informative" }, { value: "storytelling", label: "Narrative / Story" }, { value: "review", label: "Review" }, { value: "educational", label: "Educational" }, { value: "promo", label: "Promotional" }];
const BRAND_VOICES= [{ value: "professional", label: "Professional" }, { value: "friendly", label: "Friendly" }, { value: "expert", label: "Expert" }, { value: "casual", label: "Casual" }, { value: "luxury", label: "Premium" }];
const CATEGORIES  = [{ value: "none", label: "Not specified" }, { value: "tech", label: "Technology" }, { value: "beauty", label: "Beauty" }, { value: "food", label: "Food" }, { value: "fashion", label: "Fashion" }, { value: "education", label: "Education" }, { value: "finance", label: "Finance" }, { value: "health", label: "Health" }, { value: "other", label: "Other" }];
const FALLBACK_AVATARS = [
  { value: "Anna_public_20240108", label: "Anna", desc: "Realistic, female", image: null as string | null },
  { value: "Adrian_public_2_20240312", label: "Adrian", desc: "Business, male", image: null as string | null },
  { value: "Kristin_public_3_20240108", label: "Kristin", desc: "Youthful, female", image: null as string | null },
  { value: "none", label: "No avatar", desc: "Voice only", image: null as string | null },
];
const VOICES      = [
  { value: "70856236390f4d0392d00187143d3900", label: "Larisa", lang: "RU", gender: "Female" },
  { value: "ba1544b5eae84eae9cb92598f078b6b0", label: "Oleg", lang: "RU", gender: "Male" },
  { value: "bc69c9589d6747028dc5ec4aec2b43c3", label: "Daria", lang: "RU", gender: "Female" },
  { value: "81bb7c1a521442f6b812b2294a29acc1", label: "Dmitriy", lang: "RU", gender: "Male" },
] as const;

type HeyGenVoice = {
  voice_id: string;
  name: string;
  gender: string | null;
  language: string | null;
  preview_audio_url: string | null;
};

const SUB_STYLES  = [{ value: "tiktok", label: "TikTok Bold" }, { value: "cinematic", label: "Cinematic" }, { value: "minimal", label: "Minimal" }, { value: "default", label: "Default" }];
const DURATIONS   = [{ value: 30, label: "30 sec" }, { value: 45, label: "45 sec" }, { value: 60, label: "60 sec" }];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CreatePage() {
  return (
    <Suspense>
      <CreatePageInner />
    </Suspense>
  );
}

function CreatePageInner() {
  const [step, setStep]       = useState(1);
  const [form, setForm]       = useState<FormData>(DEFAULT);
  const [launching, setLaunching] = useState(false);
  const [launchProgress, setLaunchProgress] = useState(0);
  const [error, setError]     = useState<string | null>(null);
  const [existingProductId, setExistingProductId] = useState<string | null>(null);
  const [avatars, setAvatars] = useState(FALLBACK_AVATARS);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Load avatars from HeyGen API
  useEffect(() => {
    videosApi.avatars().then((res) => {
      const heygenAvatars = res.avatars.map((a) => ({
        value: a.avatar_id,
        label: a.avatar_name,
        desc: a.gender === 'female' ? 'Female' : a.gender === 'male' ? 'Male' : '',
        image: a.preview_image_url,
      }));
      if (heygenAvatars.length > 0) {
        setAvatars([...heygenAvatars, { value: "none", label: "No avatar", desc: "Voice only", image: null }]);
      }
    }).catch(() => {})
  }, []);

  // Load product from query string (?productId=xxx)
  useEffect(() => {
    const pid = searchParams.get("productId");
    if (!pid) return;
    productsApi.get(pid).then((p) => {
      setExistingProductId(p.id);
      setForm((prev) => ({
        ...prev,
        productName: p.name,
        productDescription: p.description ?? "",
        features: p.features,
        targetAudience: p.targetAudience ?? "",
        brandVoice: p.brandVoice ?? "professional",
        category: p.category ?? "none",
        price: p.price ?? "",
        websiteUrl: p.websiteUrl ?? "",
        images: p.images.map((key) => ({ key, url: `${BASE}/api/v1/products/${p.id}/image-preview?key=${encodeURIComponent(key)}`, file: null as any })),
      }));
    }).catch(() => {});
  }, [searchParams]);

  const set = <K extends keyof FormData>(key: K, val: FormData[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const addFeature = () => {
    const f = form.featureInput.trim();
    if (f && form.features.length < 10) {
      set("features", [...form.features, f]);
      set("featureInput", "");
    }
  };

  const removeFeature = (idx: number) => {
    set("features", form.features.filter((_, i) => i !== idx));
  };

  const canNext = () => {
    if (step === 1) return form.productName.trim().length > 0;
    if (step === 2) return true;
    return true;
  };

  const handleLaunch = async () => {
    setLaunching(true);
    setError(null);
    setLaunchProgress(10);

    try {
      let productId = existingProductId;

      if (!productId) {
        // 1. Create product
        setLaunchProgress(20);
        const product = await productsApi.create({
          name: form.productName,
          description: form.productDescription || undefined,
          features: form.features,
          targetAudience: form.targetAudience || undefined,
          brandVoice: form.brandVoice || undefined,
          category: form.category !== "none" ? form.category : undefined,
          price: form.price || undefined,
          websiteUrl: form.websiteUrl || undefined,
          images: form.images.map((img) => img.key),
        });
        productId = product.id;
      } else {
        setLaunchProgress(20);
      }

      // 2. Create video from product
      setLaunchProgress(50);
      const result = await videosApi.create({
        title: `${form.productName} — video`,
        scriptPrompt: form.videoIdea.trim() || undefined,
        productId: productId!,
        avatarId: form.avatar,
        voiceId: form.voice,
        durationSec: form.durationSec,
        settings: {
          resolution: "1080x1920",
          fps: 30,
          language: form.language,
          bgm_enabled: form.bgmEnabled,
          video_format: form.videoFormat,
        },
      });

      setLaunchProgress(100);
      setTimeout(() => router.push(`/videos/${result.video.id}`), 600);
    } catch (err: any) {
      setError(err.message ?? "Error creating");
      setLaunching(false);
      setLaunchProgress(0);
    }
  };

  return (
    <>
      <TopBar title="Create video" />

      <main className="flex-1 p-6">
        {/* Stepper */}
        <div className="max-w-3xl mx-auto mb-8">
          <Stepper
            steps={STEPS.map((s) => ({ id: s.id, label: s.label }))}
            current={step - 1}
          />
        </div>

        {/* Step cards */}
        <div className="max-w-3xl mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.2 }}
            >
              {step === 1 && <Step1Product form={form} set={set} addFeature={addFeature} removeFeature={removeFeature} existingProductId={existingProductId} setExistingProductId={setExistingProductId} setForm={setForm} />}
              {step === 2 && <Step2VideoSettings form={form} set={set} avatars={avatars} />}
              {step === 3 && <Step3Launch form={form} launching={launching} progress={launchProgress} error={error} avatars={avatars} />}
            </motion.div>
          </AnimatePresence>

          {/* Navigation */}
          {!launching && (
            <div className="flex justify-between mt-6">
              <Button variant="ghost" size="sm" disabled={step === 1} onClick={() => setStep((s) => s - 1)}>
                ← Back
              </Button>
              {step < 3 ? (
                  <Button variant="primary" size="sm" disabled={!canNext()} onClick={() => setStep((s) => s + 1)}>
                  Next →
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={handleLaunch} disabled={!canNext()}>
                  <RocketIcon />
                  {existingProductId ? "Start generation" : "Create product and start"}
                </Button>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────────

function Step1Product({ form, set, addFeature, removeFeature, existingProductId, setExistingProductId, setForm }: {
  form: FormData;
  set: (key: any, val: any) => void;
  addFeature: () => void;
  removeFeature: (idx: number) => void;
  existingProductId: string | null;
  setExistingProductId: (id: string | null) => void;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [wbUrl, setWbUrl] = useState("");
  const [wbLoading, setWbLoading] = useState(false);
  const [wbError, setWbError] = useState<string | null>(null);

  // Product picker
  const [showPicker, setShowPicker] = useState(false);
  const [pickerProducts, setPickerProducts] = useState<Product[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");

  const openPicker = async () => {
    setShowPicker(true);
    setPickerLoading(true);
    try {
      const resp = await productsApi.list({ limit: 50 });
      setPickerProducts(resp.data);
    } catch { /* ignore */ }
    setPickerLoading(false);
  };

  const selectProduct = (p: Product) => {
    setExistingProductId(p.id);
    setForm((prev: FormData) => ({
      ...prev,
      productName: p.name,
      productDescription: p.description ?? "",
      features: p.features,
      targetAudience: p.targetAudience ?? "",
      brandVoice: p.brandVoice ?? "professional",
      category: p.category ?? "none",
      price: p.price ?? "",
      websiteUrl: p.websiteUrl ?? "",
      images: p.images.map((key) => ({ key, url: `${BASE}/api/v1/products/${p.id}/image-preview?key=${encodeURIComponent(key)}`, file: null as any })),
    }));
    setShowPicker(false);
  };

  const clearExisting = () => {
    setExistingProductId(null);
    setForm(DEFAULT);
  };

  const pickerFiltered = pickerSearch.trim()
    ? pickerProducts.filter((p) =>
        p.name.toLowerCase().includes(pickerSearch.toLowerCase()) ||
        (p.description ?? "").toLowerCase().includes(pickerSearch.toLowerCase())
      )
    : pickerProducts;

  const handleScrapeWb = async () => {
    if (!wbUrl.trim()) return;
    setWbLoading(true);
    setWbError(null);
    try {
      const data = await productsApi.scrapeWb(wbUrl.trim());
      if (data.name) set("productName", data.name);
      if (data.description) set("productDescription", data.description);
      if (data.price) set("price", data.price);
      if (data.sourceUrl) set("websiteUrl", data.sourceUrl);
      if (data.characteristics.length > 0) {
        set("features", data.characteristics.slice(0, 10));
      }
    } catch (err: any) {
      setWbError(err.message ?? "Failed to load data");
    } finally {
      setWbLoading(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    if (form.images.length + files.length > 5) return;

    setUploading(true);
    setUploadError(null);
    try {
      const uploaded: UploadedImage[] = [];
      for (const file of files) {
        const result = await productsApi.uploadImage(file);
        uploaded.push({ ...result, file });
      }
      set("images", [...form.images, ...uploaded]);
    } catch (err: any) {
      setUploadError(err.message ?? "Failed to upload image");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeImage = (idx: number) => {
    set("images", form.images.filter((_: any, i: number) => i !== idx));
  };

  return (
    <Card>
      <CardContent className="space-y-5 pt-6 pb-6">
        <SectionHeader step={1} title="Product information" subtitle="Describe the product — AI will create idea, script and prompts for video generation" />

        {/* Select existing product */}
        {existingProductId ? (
          <div className="rounded-xl border border-brand-500/30 bg-brand-500/5 p-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="brand">Product selected</Badge>
              <span className="text-sm font-medium text-text-primary">{form.productName}</span>
            </div>
            <Button variant="ghost" size="sm" className="text-xs" onClick={clearExisting}>Clear</Button>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={openPicker} className="w-full">
            📦 Choose existing product
          </Button>
        )}

        {/* Product picker modal */}
        {showPicker && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowPicker(false)}>
            <div className="bg-surface-0 border border-border rounded-2xl w-full max-w-lg mx-4 max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-primary">Choose product</h3>
                <Button variant="ghost" size="sm" onClick={() => setShowPicker(false)}>✕</Button>
              </div>
              <div className="p-3 border-b border-border">
                <Input placeholder="Search..." value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} />
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                        {pickerLoading ? (
                          <div className="flex justify-center py-10"><LoadingSpinner size={24} /></div>
                        ) : pickerFiltered.length === 0 ? (
                          <p className="text-sm text-text-tertiary text-center py-10">No products</p>
                ) : (
                  <div className="space-y-1">
                    {pickerFiltered.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => selectProduct(p)}
                        className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-surface-2 transition-colors flex items-center gap-3"
                      >
                        {p.images.length > 0 ? (
                          <img
                            src={`${BASE}/api/v1/products/${p.id}/image-preview?key=${encodeURIComponent(p.images[0])}`}
                            alt=""
                            className="w-10 h-10 rounded-lg object-cover bg-surface-2 flex-shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-surface-2 flex items-center justify-center flex-shrink-0 text-text-tertiary">📦</div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-text-primary truncate">{p.name}</p>
                          <p className="text-xs text-text-tertiary truncate">{p.category ?? "Uncategorized"}{p.price ? ` · ${p.price}` : ""}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Wildberries auto-fill */}
        <div className="rounded-xl border border-border bg-surface-2 p-4 space-y-2">
          <p className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
            <WbIcon />
            Auto-fill from Wildberries
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="https://www.wildberries.ru/catalog/310531916/detail.aspx"
              value={wbUrl}
              onChange={(e) => setWbUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleScrapeWb(); } }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={handleScrapeWb}
              disabled={wbLoading || !wbUrl.trim()}
              className="shrink-0"
            >
              {wbLoading ? (
                <span className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
              ) : (
                "Fetch"
              )}
            </Button>
          </div>
          {wbError && <p className="text-xs text-red-400">{wbError}</p>}
          <p className="text-[10px] text-text-tertiary">Paste a product link — title, description, price and features will be filled automatically</p>
        </div>

        <Input label="Product name *" placeholder="Smart speaker Galaxy Home 3" value={form.productName} onChange={(e) => set("productName", e.target.value)} hint="This name will be used in the script" />

        <Textarea label="Product description" placeholder="Describe the product in detail: what it does, who it's for, main benefits..." rows={4} value={form.productDescription} onChange={(e) => set("productDescription", e.target.value)} hint="The more details — the better the video" />

        {/* Image upload */}
        <div>
          <p className="text-xs font-medium text-text-secondary mb-1.5">Product photos ({form.images.length}/5)</p>
          <div className="flex flex-wrap gap-3">
            {form.images.map((img, i) => (
              <div key={img.key} className="relative group w-20 h-20 rounded-lg overflow-hidden border border-border bg-surface-2">
                <img src={img.url} alt="" className="w-full h-full object-cover" />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <span className="text-white text-lg">&times;</span>
                </button>
              </div>
            ))}
            {form.images.length < 5 && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className={cn(
                  "w-20 h-20 rounded-lg border-2 border-dashed flex flex-col items-center justify-center transition-all",
                  uploading
                    ? "border-brand-500/30 bg-brand-500/5"
                    : "border-border hover:border-brand-500/50 hover:bg-brand-500/5"
                )}
              >
                    {uploading ? (
                  <span className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <CameraIcon />
                    <span className="text-[10px] text-text-tertiary mt-1">Upload</span>
                  </>
                )}
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={handleUpload}
          />
          <p className="text-[10px] text-text-tertiary mt-1.5">JPEG, PNG, WebP, GIF · up to 10 MB · AI uses photos to generate scenes</p>
          {uploadError && <p className="text-xs text-red-400 mt-1">{uploadError}</p>}
        </div>

        {/* Features */}
        <div>
          <p className="text-xs font-medium text-text-secondary mb-1.5">Key features ({form.features.length}/10)</p>
          <div className="flex gap-2">
            <Input placeholder="e.g.: AI voice assistant" value={form.featureInput} onChange={(e) => set("featureInput", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addFeature(); } }} />
            <Button variant="secondary" size="sm" onClick={addFeature} disabled={!form.featureInput.trim() || form.features.length >= 10}>+</Button>
          </div>
          {form.features.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {form.features.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-brand-500/10 text-brand-400 text-xs font-medium"
                >
                  {f}
                  <button onClick={() => removeFeature(i)} className="hover:text-red-400 transition-colors">&times;</button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Target audience" placeholder="Young adults 18-35, tech enthusiasts" value={form.targetAudience} onChange={(e) => set("targetAudience", e.target.value)} />
          <RadixSelect label="Brand tone" value={form.brandVoice} options={BRAND_VOICES} onValueChange={(v) => set("brandVoice", v)} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <RadixSelect label="Category" value={form.category} options={CATEGORIES} onValueChange={(v) => set("category", v)} />
          <Input label="Price" placeholder="e.g., 9,990 ₽" value={form.price} onChange={(e) => set("price", e.target.value)} />
        </div>

        <Input label="Product website" placeholder="https://example.com/product" value={form.websiteUrl} onChange={(e) => set("websiteUrl", e.target.value)} />
      </CardContent>
    </Card>
  );
}

function Step2VideoSettings({ form, set, avatars }: { form: FormData; set: (key: any, val: any) => void; avatars: typeof FALLBACK_AVATARS }) {
  const [avatarPage, setAvatarPage] = useState(0);
  const [avatarSort, setAvatarSort] = useState<"name" | "gender">("name");
  const [zoomedAvatar, setZoomedAvatar] = useState<string | null>(null);
  const AVATARS_PER_PAGE = 6;

  // ── Voice state ──────────────────────────────────────────────────────────
  const [voices, setVoices] = useState<HeyGenVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voiceFilter, setVoiceFilter] = useState<"all" | "male" | "female">("all");
  const [voiceLangFilter, setVoiceLangFilter] = useState<string>("Russian");
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voicePage, setVoicePage] = useState(0);
  const [voiceNextToken, setVoiceNextToken] = useState<string | null>(null);
  const [voiceHasMore, setVoiceHasMore] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const VOICES_PER_PAGE = 6;

  const fetchVoices = useCallback(async (lang: string, gender?: string, token?: string) => {
    setVoicesLoading(true);
    try {
      const params: Record<string, string | number> = { language: lang, limit: 100 };
      if (gender && gender !== "all") params.gender = gender;
      if (token) params.token = token;
      const res = await videosApi.voices(params as any);
      if (token) {
        setVoices((prev) => [...prev, ...res.data]);
      } else {
        setVoices(res.data);
      }
      setVoiceHasMore(res.has_more);
      setVoiceNextToken(res.next_token);
    } catch { /* keep existing */ }
    setVoicesLoading(false);
  }, []);

  useEffect(() => {
    fetchVoices(voiceLangFilter, voiceFilter === "all" ? undefined : voiceFilter);
    setVoicePage(0);
  }, [voiceLangFilter, voiceFilter, fetchVoices]);

  const loadMoreVoices = () => {
    if (voiceNextToken && voiceHasMore) {
      fetchVoices(voiceLangFilter, voiceFilter === "all" ? undefined : voiceFilter, voiceNextToken);
    }
  };

  const filteredVoices = voices.filter((v) => {
    if (voiceSearch) {
      const q = voiceSearch.toLowerCase();
      return v.name.toLowerCase().includes(q);
    }
    return true;
  });

  const voiceTotalPages = Math.max(1, Math.ceil(filteredVoices.length / VOICES_PER_PAGE));
  const pagedVoices = filteredVoices.slice(voicePage * VOICES_PER_PAGE, (voicePage + 1) * VOICES_PER_PAGE);

  const playPreview = (voice: HeyGenVoice) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (playingVoiceId === voice.voice_id) {
      setPlayingVoiceId(null);
      return;
    }
    if (!voice.preview_audio_url) return;
    const audio = new Audio(voice.preview_audio_url);
    audio.onended = () => setPlayingVoiceId(null);
    audio.onerror = () => setPlayingVoiceId(null);
    audio.play().catch(() => setPlayingVoiceId(null));
    audioRef.current = audio;
    setPlayingVoiceId(voice.voice_id);
  };

  // Find display info for selected voice
  const selectedVoice = voices.find((v) => v.voice_id === form.voice) ??
    VOICES.find((v) => v.value === form.voice);
  const selectedVoiceLabel = selectedVoice
    ? ("name" in selectedVoice ? selectedVoice.name : selectedVoice.label)
    : form.voice.slice(0, 8) + "…";

  const sorted = [...avatars].sort((a, b) => {
    if (avatarSort === "gender") return (a.desc ?? "").localeCompare(b.desc ?? "");
    return a.label.localeCompare(b.label);
  });
  const totalPages = Math.ceil(sorted.length / AVATARS_PER_PAGE);
  const paged = sorted.slice(avatarPage * AVATARS_PER_PAGE, (avatarPage + 1) * AVATARS_PER_PAGE);

  return (
    <Card>
      <CardContent className="space-y-5 pt-6 pb-6">
        <SectionHeader step={2} title="Video settings" subtitle="Describe the idea for the video — AI will automatically create script, prompts and scenes" />

        <Textarea
          label="Idea / brief for the video"
          placeholder="Leave empty — AI will invent a unique idea. Or describe yours: 'Show main features, start with a hook question...'"
          rows={4}
          value={form.videoIdea}
          onChange={(e) => set("videoIdea", e.target.value)}
          hint="Optional. If empty, AI will generate a unique creative idea based on product data"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <RadixSelect label="Language" value={form.language} options={LANGUAGES} onValueChange={(v) => set("language", v)} />
          <RadixSelect label="Style" value={form.style} options={STYLES} onValueChange={(v) => set("style", v)} />
        </div>

        {/* Video format selector */}
        <div>
          <p className="text-xs font-medium text-text-secondary mb-2">Video format</p>
          <div className="flex gap-2">
            {[
              { value: "standard" as const, label: "Standard", desc: "Avatar + clips + images" },
              { value: "slideshow" as const, label: "Slideshow", desc: "Images only + music" },
            ].map((f) => (
              <button
                key={f.value}
                onClick={() => set("videoFormat", f.value)}
                className={cn(
                  "flex-1 rounded-xl border px-4 py-3 text-center transition-all",
                  form.videoFormat === f.value
                    ? "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/30 text-brand-400"
                    : "border-border bg-surface-2 text-text-secondary hover:border-brand-500/40"
                )}
              >
                <span className="font-medium text-sm">{f.label}</span>
                <p className="text-[11px] text-text-tertiary mt-0.5">{f.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Duration selector */}
        <div>
          <p className="text-xs font-medium text-text-secondary mb-2">Video duration</p>
          <div className="flex gap-2">
            {DURATIONS.map((d) => (
              <button
                key={d.value}
                onClick={() => set("durationSec", d.value)}
                className={cn(
                  "flex-1 rounded-xl border px-4 py-3 text-center transition-all font-medium",
                  form.durationSec === d.value
                    ? "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/30 text-brand-400"
                    : "border-border bg-surface-2 text-text-secondary hover:border-brand-500/40"
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-text-tertiary mt-1">AI will limit the script and avatar speech to the selected duration</p>
        </div>

        {/* Avatar selection with pagination, sorting, zoom */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-text-secondary">Avatar</p>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-tertiary">Sort:</span>
              <button
                onClick={() => { setAvatarSort("name"); setAvatarPage(0); }}
                className={cn("text-[10px] px-2 py-0.5 rounded-full transition-colors", avatarSort === "name" ? "bg-brand-500/15 text-brand-400" : "text-text-tertiary hover:text-text-secondary")}
              >
                Name
              </button>
              <button
                onClick={() => { setAvatarSort("gender"); setAvatarPage(0); }}
                className={cn("text-[10px] px-2 py-0.5 rounded-full transition-colors", avatarSort === "gender" ? "bg-brand-500/15 text-brand-400" : "text-text-tertiary hover:text-text-secondary")}
              >
                Gender
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {paged.map((a) => (
              <button
                key={a.value}
                onClick={() => set("avatar", a.value)}
                className={cn(
                  "rounded-xl border p-3 text-left transition-all hover:border-brand-500/40 flex flex-col items-center gap-2 relative group",
                  form.avatar === a.value
                    ? "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/30"
                    : "border-border bg-surface-2 text-text-secondary"
                )}
              >
                {a.image ? (
                  <div className="relative w-16 h-16 rounded-full overflow-hidden bg-surface-3 flex-shrink-0">
                    <img
                      src={a.image}
                      alt={a.label}
                      className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <button
                      onClick={(e) => { e.stopPropagation(); setZoomedAvatar(a.image); }}
                      className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-full"
                      title="Zoom"
                    >
                      <span className="text-white text-lg">🔍</span>
                    </button>
                  </div>
                ) : (
                  <span className="w-16 h-16 rounded-full bg-surface-3 flex items-center justify-center text-2xl flex-shrink-0">
                    {a.value === "none" ? "🎬" : "👤"}
                  </span>
                )}
                <div className="text-center min-w-0">
                  <p className={cn("text-sm font-medium", form.avatar === a.value ? "text-brand-400" : "text-text-primary")}>{a.label}</p>
                  <p className="text-[11px] text-text-tertiary">{a.desc}</p>
                </div>
                {form.avatar === a.value && <CheckmarkIcon className="absolute top-2 right-2 text-brand-500" />}
              </button>
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-3">
              <button
                onClick={() => setAvatarPage((p) => Math.max(0, p - 1))}
                disabled={avatarPage === 0}
                className="text-xs text-text-tertiary hover:text-text-primary disabled:opacity-30 transition-colors"
              >
                ← Back
              </button>
              <span className="text-xs text-text-tertiary">{avatarPage + 1} / {totalPages}</span>
              <button
                onClick={() => setAvatarPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={avatarPage >= totalPages - 1}
                className="text-xs text-text-tertiary hover:text-text-primary disabled:opacity-30 transition-colors"
              >
                Next →
              </button>
            </div>
          )}
        </div>

        {/* Zoom modal */}
        {zoomedAvatar && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setZoomedAvatar(null)}>
            <div className="relative max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
              <img src={zoomedAvatar} alt="Avatar preview" className="w-full rounded-2xl shadow-elevation-3" />
              <button onClick={() => setZoomedAvatar(null)} className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors">✕</button>
            </div>
          </div>
        )}

        {/* Voice selection */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-text-secondary">Voiceover</p>
            {selectedVoice && (
              <span className="text-[10px] text-text-tertiary">
                Selected: <span className="text-brand-400 font-medium">{selectedVoiceLabel}</span>
              </span>
            )}
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2 mb-3">
            <select
              className="rounded-lg border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary"
              value={voiceLangFilter}
              onChange={(e) => { setVoiceLangFilter(e.target.value); setVoicePage(0); }}
            >
              <option value="Russian">Russian</option>
              <option value="Multilingual">Multilingual</option>
              <option value="English">English</option>
              <option value="Spanish">Spanish</option>
              <option value="German">German</option>
              <option value="French">French</option>
              <option value="Chinese">Chinese</option>
            </select>
            <div className="flex rounded-lg border border-border overflow-hidden">
                  {(["all", "female", "male"] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => { setVoiceFilter(g); setVoicePage(0); }}
                  className={cn(
                    "px-2.5 py-1.5 text-xs transition-colors",
                    voiceFilter === g ? "bg-brand-500/15 text-brand-400" : "bg-surface-1 text-text-tertiary hover:text-text-secondary"
                  )}
                >
                      {g === "all" ? "All" : g === "female" ? "Female" : "Male"}
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Search by name..."
              className="flex-1 rounded-lg border border-border bg-surface-1 px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary"
              value={voiceSearch}
              onChange={(e) => { setVoiceSearch(e.target.value); setVoicePage(0); }}
            />
          </div>

          {/* Voice list */}
          {voicesLoading && voices.length === 0 ? (
              <div className="flex items-center justify-center py-8">
              <LoadingSpinner size={20} />
              <span className="ml-2 text-xs text-text-tertiary">Loading voices…</span>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                {pagedVoices.map((v) => (
                  <button
                    key={v.voice_id}
                    onClick={() => set("voice", v.voice_id)}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2.5 text-left transition-all flex items-center gap-3",
                      form.voice === v.voice_id
                        ? "border-brand-500 bg-brand-500/10 ring-1 ring-brand-500/30"
                        : "border-border bg-surface-2 hover:border-brand-500/40"
                    )}
                  >
                    <span className="w-7 h-7 rounded-full bg-surface-3 flex items-center justify-center text-xs flex-shrink-0">
                      🎙
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={cn("text-sm font-medium truncate", form.voice === v.voice_id ? "text-brand-400" : "text-text-primary")}>
                        {v.name}
                      </p>
                      <p className="text-[10px] text-text-tertiary">{v.gender ?? "—"} · {v.language ?? "—"}</p>
                    </div>
                    {v.preview_audio_url && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); playPreview(v); }}
                        className={cn(
                          "shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs transition-colors",
                          playingVoiceId === v.voice_id ? "bg-brand-500/20 text-brand-400" : "bg-surface-3 hover:bg-surface-1"
                        )}
                        title="Listen"
                      >
                        {playingVoiceId === v.voice_id ? "⏸" : "▶"}
                      </button>
                    )}
                    {form.voice === v.voice_id && <CheckmarkIcon className="text-brand-500 flex-shrink-0" />}
                  </button>
                ))}
                {pagedVoices.length === 0 && !voicesLoading && (
                  <p className="text-xs text-text-tertiary text-center py-4">No voices found</p>
                )}
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-3">
                <span className="text-[10px] text-text-tertiary">{filteredVoices.length} voices</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setVoicePage((p) => Math.max(0, p - 1))}
                    disabled={voicePage === 0}
                    className="text-xs text-text-tertiary hover:text-text-primary disabled:opacity-30 transition-colors"
                  >
                    ←
                  </button>
                  <span className="text-[10px] text-text-tertiary">{voicePage + 1} / {voiceTotalPages}</span>
                  <button
                    onClick={() => {
                      if (voicePage >= voiceTotalPages - 1 && voiceHasMore) {
                        loadMoreVoices();
                      }
                      setVoicePage((p) => Math.min(voiceTotalPages - 1 + (voiceHasMore ? 1 : 0), p + 1));
                    }}
                    disabled={voicePage >= voiceTotalPages - 1 && !voiceHasMore}
                    className="text-xs text-text-tertiary hover:text-text-primary disabled:opacity-30 transition-colors"
                  >
                    →
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Background music</p>
          <p className="text-xs text-text-tertiary mt-0.5">Random track from BGM library</p>
        </div>
          <SwitchToggle checked={form.bgmEnabled} onCheckedChange={(v) => set("bgmEnabled", v)} />
        </div>

        <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">Subtitles</p>
          <p className="text-xs text-text-tertiary mt-0.5">Automatic subtitles on the video</p>
        </div>
          <SwitchToggle checked={form.subtitlesEnabled} onCheckedChange={(v) => set("subtitlesEnabled", v)} />
        </div>
        {form.subtitlesEnabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {SUB_STYLES.map((s) => (
              <button
                key={s.value}
                onClick={() => set("subtitleStyle", s.value)}
                className={cn(
                  "rounded-lg border px-4 py-3 text-sm font-medium transition-all",
                  form.subtitleStyle === s.value
                    ? "border-brand-500 bg-brand-500/10 text-brand-400"
                    : "border-border bg-surface-2 text-text-secondary hover:border-brand-500/40"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Step3Launch({ form, launching, progress, error, avatars }: {
  form: FormData;
  launching: boolean;
  progress: number;
  error: string | null;
  avatars: typeof FALLBACK_AVATARS;
}) {
  return (
    <Card>
      <CardContent className="space-y-5 pt-6 pb-6">
        <SectionHeader step={3} title="Review & launch" subtitle="Review details before creation" />

        {/* Product summary */}
        <div>
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">Product</p>
          <ul className="space-y-1.5 text-sm">
            {[
              ["Name",      form.productName || "(not set)"],
              ["Category",     CATEGORIES.find(c => c.value === form.category)?.label ?? "Not specified"],
              ["Brand tone",    BRAND_VOICES.find(b => b.value === form.brandVoice)?.label ?? ""],
              ["Features", form.features.length > 0 ? form.features.join(", ") : "none"],
              ["Photos",          form.images.length > 0 ? `${form.images.length}` : "not uploaded"],
              ["Price",          form.price || "Not specified"],
            ].map(([k, v]) => (
              <li key={k as string} className="flex items-start justify-between gap-2 py-1 border-b border-border/50 last:border-0">
                <span className="text-text-tertiary">{k}</span>
                <span className="text-text-primary text-right font-medium max-w-[250px] truncate">{v}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Video summary */}
        <div>
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">Video</p>
          <ul className="space-y-1.5 text-sm">
            {[
              ["Idea",     form.videoIdea?.trim() ? (form.videoIdea.slice(0, 80) + (form.videoIdea.length > 80 ? "…" : "")) : "🤖 AI will generate automatically"],
              ["Duration", `${form.durationSec} sec`],
              ["Language",     LANGUAGES.find(l => l.value === form.language)?.label ?? ""],
              ["Style",    STYLES.find(s => s.value === form.style)?.label ?? ""],
              ["Avatar",   avatars.find(a => a.value === form.avatar)?.label ?? form.avatar],
              ["Voice",    VOICES.find(v => v.value === form.voice)?.label ?? form.voice.slice(0, 12) + "…"],
              ["Subtitles", form.subtitlesEnabled ? SUB_STYLES.find(s => s.value === form.subtitleStyle)?.label ?? "" : "No"],
              ["Background music", form.bgmEnabled ? "Auto (random track)" : "No"],
              ["Format", form.videoFormat === "slideshow" ? "Slideshow" : "Standard"],
            ].map(([k, v]) => (
              <li key={k as string} className="flex items-start justify-between gap-2 py-1 border-b border-border/50 last:border-0">
                <span className="text-text-tertiary">{k}</span>
                <span className="text-text-primary text-right font-medium max-w-[250px] truncate">{v}</span>
              </li>
            ))}
          </ul>
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {launching && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary">
                {progress < 30 ? "Creating product…" : progress < 80 ? "Starting video generation…" : "Done!"}
              </span>
              <span className="text-brand-400 font-medium">{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} variant="brand" size="md" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionHeader({ step, title, subtitle }: { step: number; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-500/15 text-brand-400 text-xs font-bold flex items-center justify-center ring-1 ring-brand-500/30">
        {step}
      </span>
      <div>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        <p className="text-xs text-text-tertiary mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

function RadixSelect({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onValueChange: (v: string) => void;
}) {
  const current = options.find((o) => o.value === value)?.label ?? "Select…";
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary mb-1.5">{label}</p>
      <Select.Root value={value} onValueChange={onValueChange}>
        <Select.Trigger className={cn(
          "w-full flex items-center justify-between",
          "rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary",
          "hover:border-border/80 focus:outline-none focus:ring-2 focus:ring-brand-500/30 transition-all"
        )}>
          <Select.Value>{current}</Select.Value>
          <Select.Icon><ChevronIcon /></Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-50 min-w-[180px] rounded-xl border border-border bg-surface-1 shadow-elevation-3 overflow-hidden"
          >
            <Select.Viewport className="p-1">
              {options.map((o) => (
                <Select.Item
                  key={o.value}
                  value={o.value}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-text-primary rounded-lg cursor-pointer outline-none hover:bg-surface-2 data-[highlighted]:bg-surface-2"
                >
                  <Select.ItemText>{o.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}

function SwitchToggle({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (v: boolean) => void }) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={cn(
        "relative inline-flex h-5 w-9 rounded-full border-2 border-transparent transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-brand-500/30",
        checked ? "bg-brand-500" : "bg-surface-3"
      )}
    >
      <Switch.Thumb className={cn(
        "block h-4 w-4 rounded-full bg-white shadow transition-transform",
        checked ? "translate-x-4" : "translate-x-0"
      )} />
    </Switch.Root>
  );
}

// Icons
function RocketIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2 -.66-2.97-2-2.97A2.01 2.01 0 0 0 4.5 16.5"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>; }
function ChevronIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><polyline points="6 9 12 15 18 9"/></svg>; }
function CheckmarkIcon({ className }: { className?: string }) { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden><polyline points="20 6 9 17 4 12"/></svg>; }
function CameraIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-text-tertiary" aria-hidden><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>; }
function WbIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-brand-400" aria-hidden><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>; }
