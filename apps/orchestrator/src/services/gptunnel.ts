/**
 * GPTunnel service wrapper — chat completions, TTS, creative-lab images.
 * Uses GPTunnel's OpenAI-compatible chat endpoint + native TTS + media create/result.
 */
import axios from 'axios';
import { config } from '../config';
import type { MinioStorageClient } from '@kmmzavod/storage';
import { logger } from '../logger';

const BASE_URL = config.GPTUNNEL_BASE_URL.replace(/\/+$/, '');
const API_KEY = config.GPTUNNEL_API_KEY;

function authHeaders() {
  return { Authorization: API_KEY, 'Content-Type': 'application/json' };
}

export class GptunnelService {
  constructor(private storage: MinioStorageClient) {}

  // ── Chat Completions (OpenAI-compatible) ────────────────────────────────────

  async chatCompletion(opts: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: { type: 'json_object' | 'text' };
  }) {
    const res = await axios.post(
      `${BASE_URL}/chat/completions`,
      {
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens,
        response_format: opts.responseFormat,
      },
      { headers: authHeaders(), timeout: 60_000 },
    );
    return res.data as {
      choices: Array<{ message: { content: string; role: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
  }

  // ── Script + captions (ONE call per job) ────────────────────────────────────

  /**
   * Generate, in a single chat call, an ad voiceover script for the video plus
   * one unique caption/hashtag set per variant. Doing both in one call (and once
   * per job, not per variant) keeps token spend flat regardless of variant count.
   *
   * The script drives the whole video length — the montage is later cut to fit
   * the generated voiceover, so we ask for a concise, well-paced narration.
   */
  async generateScript(opts: {
    title: string;
    description?: string;
    language?: string; // ISO code, e.g. 'ru'
    variantCount: number;
    targetSeconds?: number;
  }): Promise<{ script: string; captions: Array<{ caption: string; hashtags: string[] }> }> {
    const lang = opts.language ?? 'ru';
    const seconds = opts.targetSeconds ?? 30;
    const res = await this.chatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.85,
      maxTokens: 2000,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a senior short-form video copywriter for product marketing. ' +
            'You write punchy, natural-sounding voiceover scripts and platform captions. ' +
            'Always respond with a single valid JSON object and nothing else.',
        },
        {
          role: 'user',
          content:
            `Language: ${lang}. Write content for a product video.\n` +
            `Product title: "${opts.title}".\n` +
            `Details: "${opts.description ?? ''}".\n\n` +
            `Return JSON with this exact shape:\n` +
            `{\n` +
            `  "script": "<a spoken voiceover narration in ${lang}, ~${seconds} seconds when read aloud, ` +
            `with a strong hook in the first sentence, 2-3 concrete benefits, and a short call to action. ` +
            `Plain sentences only — no scene directions, no emojis, no markdown>",\n` +
            `  "captions": [ ${opts.variantCount} objects like ` +
            `{"caption":"<short engaging caption in ${lang}>","hashtags":["#tag", "..."]} — ` +
            `each caption MUST be unique and different in wording, 5-10 relevant hashtags each ]\n` +
            `}`,
        },
      ],
    });

    const raw = res.choices[0]?.message?.content ?? '{}';
    let parsed: any = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('Gptunnel.generateScript: failed to parse JSON, using fallback');
    }
    const script: string = typeof parsed.script === 'string' && parsed.script.trim()
      ? parsed.script.trim()
      : `${opts.title}. ${opts.description ?? ''}`.trim();
    let captions: Array<{ caption: string; hashtags: string[] }> = Array.isArray(parsed.captions)
      ? parsed.captions
      : [];
    captions = captions
      .filter((c) => c && typeof c.caption === 'string')
      .map((c) => ({
        caption: c.caption,
        hashtags: Array.isArray(c.hashtags) ? c.hashtags.map(String) : [],
      }));
    return { script, captions };
  }

  // ── TTS ───────────────────────────────────────────────────────────────────────

  /**
   * Generate the voiceover ONCE per job and store it under a job-level key.
   * Every variant reuses this same file, so TTS spend does not scale with the
   * number of variants (the voice is identical by design; uniqueness is in the
   * montage + per-variant music).
   */
  async ttsCreate(opts: {
    text: string;
    voiceId: string;
    tenantId: string;
    uniquifyJobId: string;
  }) {
    const res = await axios.post(
      `${BASE_URL}/tts/create`,
      { text: opts.text, voice_id: opts.voiceId },
      { headers: authHeaders(), timeout: 120_000 },
    );
    const data = res.data as { data: string; cost?: number; id?: string };
    if (!data?.data) throw new Error('Gptunnel TTS returned no audio data');
    const buffer = Buffer.from(data.data, 'base64');
    const key = `tenants/${opts.tenantId}/uniquify/${opts.uniquifyJobId}/voiceover.mp3`;
    await this.storage.uploadBuffer(key, buffer, { contentType: 'audio/mpeg' });
    logger.info({ key, cost: data.cost, ttsId: data.id }, 'Gptunnel: voiceover uploaded to MinIO');
    return { storageKey: key, cost: data.cost ?? 0 };
  }

  // ── Creative Lab Image ────────────────────────────────────────────────────────

  async imageCreate(opts: { model: string; prompt: string }) {
    const res = await axios.post(
      `${BASE_URL}/media/create`,
      { model: opts.model, prompt: opts.prompt },
      { headers: authHeaders(), timeout: 30_000 },
    );
    const data = res.data as { task_id?: string; id?: string; error?: string };
    if (data.error) throw new Error(`Image create failed: ${data.error}`);
    const taskId = data.task_id ?? data.id;
    if (!taskId) throw new Error('Image create returned no task_id');
    return { taskId };
  }

  async imageResult(taskId: string) {
    const res = await axios.post(
      `${BASE_URL}/media/result`,
      { task_id: taskId },
      { headers: authHeaders(), timeout: 10_000 },
    );
    const data = res.data as {
      status: string;
      url?: string;
      error?: string;
      progress?: number;
    };
    if (data.error) throw new Error(`Image result error: ${data.error}`);
    return data;
  }

  /** Poll image result until done or timeout. */
  async imagePoll(taskId: string, opts?: { maxWaitSec?: number; pollIntervalSec?: number }) {
    const maxWait = opts?.maxWaitSec ?? 120;
    const interval = (opts?.pollIntervalSec ?? 3) * 1000;
    const start = Date.now();
    while (Date.now() - start < maxWait * 1000) {
      const result = await this.imageResult(taskId);
      if (result.status === 'done') {
        return { url: result.url! };
      }
      if (result.status === 'failed' || result.error) {
        throw new Error(`Image generation failed: ${result.error ?? result.status}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Image generation timeout after ${maxWait}s`);
  }

  /** Create + poll + download + upload to MinIO. */
  async generateImageAndUpload(opts: {
    model: string;
    prompt: string;
    tenantId: string;
    jobId: string;
    suffix: string;
  }) {
    const { taskId } = await this.imageCreate({ model: opts.model, prompt: opts.prompt });
    const { url } = await this.imagePoll(taskId);
    const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 30_000 });
    const buffer = Buffer.from(imgRes.data);
    const ext = url.endsWith('.webp') ? 'webp' : 'png';
    const key = `tenants/${opts.tenantId}/uniquify/${opts.jobId}/${opts.suffix}.${ext}`;
    await this.storage.uploadBuffer(key, buffer, { contentType: `image/${ext}` });
    logger.info({ key, taskId }, 'Gptunnel: image uploaded to MinIO');
    return { storageKey: key, url };
  }
}
