/**
 * Image generation client — провайдер-агностик.
 * Поддерживает: runway, fal.ai, Replicate, ComfyUI (self-hosted)
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

  // ── Runway ─────────────────────────────────────────────────────────────────
  private async generateRunway(opts: GenerateImageOpts): Promise<ImageResult> {
    const http = axios.create({
      baseURL: 'https://api.dev.runwayml.com/v1',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });

    // Use short video generation as image source (first frame)
    const create = await http.post('/image_to_video', {
      model: 'gen3a_turbo',
      promptText: opts.prompt,
      duration: 5,
      ratio: '9:16',
    });

    const taskId: string = create.data.id;

    for (let i = 0; i < 60; i++) {
      await sleep(10_000);
      const poll = await http.get(`/tasks/${taskId}`);
      const task = poll.data;

      if (task.status === 'SUCCEEDED') {
        const url = task.output?.[0];
        if (!url) throw new Error('Runway: пустой ответ при генерации изображения');
        return { url, contentType: 'image/png' };
      }

      if (task.status === 'FAILED' || task.status === 'CANCELLED') {
        throw new Error(`Runway image gen failed: ${task.failure ?? 'unknown'}`);
      }

      logger.debug({ taskId, attempt: i + 1 }, 'Runway: ожидаем изображение');
    }

    throw new Error('Runway: timeout генерации изображения');
  }

  // ── Fal.ai ─────────────────────────────────────────────────────────────────
  private async generateFal(opts: GenerateImageOpts): Promise<ImageResult> {
    const http = axios.create({
      baseURL: 'https://queue.fal.run',
      headers: { Authorization: `Key ${this.apiKey}` },
      timeout: 120_000,
    });

    // Submitt задачу
    const sub = await http.post('/fal-ai/flux/dev', {
      prompt: opts.prompt,
      negative_prompt: opts.negativePrompt,
      image_size: { width: opts.width ?? 1080, height: opts.height ?? 1920 },
      num_images: 1,
    });

    const requestId: string = sub.data.request_id;

    // Опрос
    for (let i = 0; i < 20; i++) {
      await sleep(5_000);
      const status = await http.get(`/fal-ai/flux/dev/requests/${requestId}/status`);

      if (status.data.status === 'COMPLETED') {
        const result = await http.get(`/fal-ai/flux/dev/requests/${requestId}`);
        const img = result.data.images?.[0];
        if (!img?.url) throw new Error('fal: пустой ответ');
        return { url: img.url, contentType: img.content_type ?? 'image/jpeg' };
      }

      if (status.data.status === 'FAILED') {
        throw new Error(`fal: задача упала — ${JSON.stringify(status.data.error)}`);
      }

      logger.debug({ requestId, attempt: i + 1 }, 'fal: ожидаем изображение');
    }

    throw new Error('fal: timeout генерации изображения');
  }

  // ── Replicate ───────────────────────────────────────────────────────────────
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
