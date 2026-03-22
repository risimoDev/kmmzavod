/**
 * Image generation client — провайдер-агностик.
 *
 * Поддерживает: fal.ai (flux-pro), Replicate (SDXL), ComfyUI (self-hosted).
 * Provider `'runway'` maps to fal.ai flux-pro as fallback because Runway
 * does not expose a standalone image-generation API.
 *
 * @see https://fal.ai/models/fal-ai/flux-pro          — fal.ai flux-pro model
 * @see https://docs.dev.runwayml.com/                  — Runway (video-only)
 * @see https://replicate.com/stability-ai/sdxl          — Replicate SDXL
 */
import axios from 'axios';
import { logger } from '../logger';

export type ImageGenProvider = 'runway' | 'fal' | 'replicate' | 'comfyui';

interface GenerateImageOpts {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
}

interface ImageResult {
  url: string;
  /** MIME type */
  contentType: string;
}

export class ImageGenClient {
  constructor(
    private readonly provider: ImageGenProvider,
    private readonly apiKey: string
  ) {}

  /**
   * Generate an image using the configured provider.
   * Routes to the appropriate backend.
   */
  async generate(opts: GenerateImageOpts): Promise<ImageResult> {
    switch (this.provider) {
      case 'runway':
        return this.generateRunway(opts);
      case 'fal':
        return this.generateFal(opts);
      case 'replicate':
        return this.generateReplicate(opts);
      case 'comfyui':
        return this.generateComfyUI(opts);
    }
  }

  // ── Runway (fallback → fal.ai flux-pro) ────────────────────────────────────
  // Runway has no image-generation API; we route to fal.ai flux-pro instead.
  /**
   * Generate an image when provider is `'runway'`.
   * Runway does not offer a standalone image endpoint, so we use
   * fal.ai **flux-pro** as a drop-in fallback.
   *
   * The API key passed to `ImageGenClient` when `provider='runway'` must be
   * a valid fal.ai key (format: `Key <fal-key>`).
   *
   * @see https://fal.ai/models/fal-ai/flux-pro
   */
  private async generateRunway(opts: GenerateImageOpts): Promise<ImageResult> {
    return this.generateFalFluxPro(opts);
  }

  // ── Fal.ai ─────────────────────────────────────────────────────────────────
  /**
   * Generate an image via fal.ai (flux-dev model).
   * Used when `provider='fal'`.
   *
   * @see https://fal.ai/models/fal-ai/flux/dev
   */
  private async generateFal(opts: GenerateImageOpts): Promise<ImageResult> {
    return this.runFalModel('fal-ai/flux/dev', opts);
  }

  /**
   * Generate an image via fal.ai **flux-pro** model.
   * Used as the fallback for `provider='runway'` and can be called directly.
   *
   * @see https://fal.ai/models/fal-ai/flux-pro
   */
  private async generateFalFluxPro(opts: GenerateImageOpts): Promise<ImageResult> {
    return this.runFalModel('fal-ai/flux-pro', opts);
  }

  /**
   * Shared helper — submit + poll any fal.ai image model.
   *
   * @param model  fal model path, e.g. `'fal-ai/flux/dev'` or `'fal-ai/flux-pro'`
   */
  private async runFalModel(model: string, opts: GenerateImageOpts): Promise<ImageResult> {
    const http = axios.create({
      baseURL: 'https://queue.fal.run',
      headers: { Authorization: `Key ${this.apiKey}` },
      timeout: 120_000,
    });

    const sub = await http.post(`/${model}`, {
      prompt: opts.prompt,
      negative_prompt: opts.negativePrompt,
      image_size: { width: opts.width ?? 1080, height: opts.height ?? 1920 },
      num_images: 1,
    });

    const requestId: string = sub.data.request_id;

    for (let i = 0; i < 20; i++) {
      await sleep(5_000);
      const status = await http.get(`/${model}/requests/${requestId}/status`);

      if (status.data.status === 'COMPLETED') {
        const result = await http.get(`/${model}/requests/${requestId}`);
        const img = result.data.images?.[0];
        if (!img?.url) throw new Error(`fal (${model}): пустой ответ`);
        return { url: img.url, contentType: img.content_type ?? 'image/jpeg' };
      }

      if (status.data.status === 'FAILED') {
        throw new Error(`fal (${model}): задача упала — ${JSON.stringify(status.data.error)}`);
      }

      logger.debug({ requestId, model, attempt: i + 1 }, 'fal: ожидаем изображение');
    }

    throw new Error(`fal (${model}): timeout генерации изображения`);
  }

  // ── Replicate ─────────────────────────────────────────────────────────────
  /**
   * Generate an image via Replicate (SDXL model).
   *
   * @see https://replicate.com/stability-ai/sdxl
   */
  private async generateReplicate(opts: GenerateImageOpts): Promise<ImageResult> {
    const http = axios.create({
      baseURL: 'https://api.replicate.com/v1',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120_000,
    });

    // stable-diffusion-xl-base-1.0 (публичная модель)
    const create = await http.post('/models/stability-ai/sdxl/versions/da77bc59ee60423279fd632efb4795ab731d9e3ca9705d97b235e35c5b6ef14e/predictions', {
      input: {
        prompt: opts.prompt,
        negative_prompt: opts.negativePrompt,
        width: opts.width ?? 1080,
        height: opts.height ?? 1920,
        num_outputs: 1,
      },
    });

    const predictionUrl: string = create.data.urls.get;

    for (let i = 0; i < 20; i++) {
      await sleep(5_000);
      const poll = await http.get(predictionUrl);

      if (poll.data.status === 'succeeded') {
        const url = poll.data.output?.[0];
        if (!url) throw new Error('replicate: пустой вывод');
        return { url, contentType: 'image/webp' };
      }

      if (poll.data.status === 'failed') {
        throw new Error(`replicate: предсказание упало — ${poll.data.error}`);
      }

      logger.debug({ predictionUrl, attempt: i + 1 }, 'replicate: ожидаем изображение');
    }

    throw new Error('replicate: timeout генерации изображения');
  }

  // ── ComfyUI (self-hosted) ──────────────────────────────────────────────────
  /**
   * Generate an image via a self-hosted ComfyUI instance.
   * Expects `apiKey` in the format `"http://host:8188|optional_key"`.
   *
   * @see https://github.com/comfyanonymous/ComfyUI
   */
  private async generateComfyUI(opts: GenerateImageOpts): Promise<ImageResult> {
    // COMFYUI_URL берётся из apiKey поля (передаём как "http://host:8188|api_key_if_any")
    const [baseURL, key] = this.apiKey.split('|');
    const http = axios.create({
      baseURL,
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      timeout: 180_000,
    });

    const prompt = buildComfyWorkflow(opts.prompt, opts.negativePrompt, opts.width, opts.height);
    const queue = await http.post('/prompt', { prompt });
    const promptId: string = queue.data.prompt_id;

    for (let i = 0; i < 30; i++) {
      await sleep(6_000);
      const history = await http.get(`/history/${promptId}`);

      if (history.data[promptId]) {
        const outputs = history.data[promptId].outputs;
        const imageData = Object.values(outputs as Record<string, any>)
          .flatMap((o: any) => o.images ?? [])
          .find((img: any) => img.type === 'output');

        if (!imageData) throw new Error('comfyui: изображение не найдено в outputs');

        const imageUrl = `${baseURL}/view?filename=${imageData.filename}&type=output`;
        return { url: imageUrl, contentType: 'image/png' };
      }

      logger.debug({ promptId, attempt: i + 1 }, 'comfyui: ожидаем изображение');
    }

    throw new Error('comfyui: timeout генерации изображения');
  }
}

/** Минимальный ComfyUI workflow (KSampler → SaveImage) */
function buildComfyWorkflow(
  prompt: string,
  negativePrompt = 'ugly, blurry',
  width = 1080,
  height = 1920
) {
  return {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.ckpt' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['4', 1] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { batch_size: 1, height, width } },
    '3': {
      class_type: 'KSampler',
      inputs: { cfg: 8, denoise: 1, latent_image: ['5', 0], model: ['4', 0], negative: ['7', 0], positive: ['6', 0], sampler_name: 'euler', scheduler: 'normal', seed: Math.floor(Math.random() * 1e15), steps: 30 },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'orchestrator', images: ['8', 0] } },
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
