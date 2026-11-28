import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AcpmClient,
  AcpmError,
  AcpmModelDTO,
  friendlyAcpmError,
  normalizeAsrLanguage,
} from './acpm';
import {
  buildAsrPrompt,
  buildPolishPayload,
  buildTranslationPayload,
  buildVerbatimPrompt,
  buildVoiceTranslationPrompt,
  combineBeforeContext,
  hasCorrectionDiff,
  loadPromptTemplates,
  parseCorrectionTerms,
  PromptTemplates,
  protectMarkdownCode,
  restoreMarkdownCode,
  TRANSLATION_PROMPT,
} from './prompts';
import { maxAudioBytes, TaskAudio } from './processes';
import {
  AcpmModelSummary,
  AcpmRuntimeInfo,
  AcpmSettings,
  Action,
  ASRResult,
  Capability,
  defaultAcpmInfo,
  Language,
  LLMPurpose,
  Settings,
  Stage,
  TaskEvent,
} from './shared';

export interface OnlineSecrets {
  online: Partial<Record<Capability, string>>;
  acpmToken: string;
}

export interface OnlineEndpointPayload {
  base_url: string;
  model: string;
  api_key: string;
}

export interface InferenceTaskPayload {
  task_id: string;
  operation: 'dictation' | 'voiceTranslation' | 'selectionTranslation' | 'polish';
  text: string;
  target_language: Language;
  asr_results: ASRResult[];
  pretranscribed?: boolean;
  polish: boolean;
  style: string;
  archive_audio: boolean;
  asr_hotwords?: string[];
  acpm: AcpmSettings;
  acpmToken: string;
  acpmTextReady: boolean;
  acpmVadReady: boolean;
  online: Partial<Record<Capability, OnlineEndpointPayload>>;
  context: {
    application: string;
    category: string;
    lexicon: { term: string; hint: string; aliases: string[] }[];
    before: string;
    after: string;
    user_text?: string;
  };
}

export interface InferenceUsageRecorder {
  startLlmCall(purpose: LLMPurpose, model: string): string | undefined;
  finishLlmCall(callId: string | undefined, status: 'response' | 'request_error', usage?: Record<string, unknown>): void;
}

export interface InferenceClient {
  checkStatus(settings: Settings, secrets: OnlineSecrets, signal?: AbortSignal): Promise<AcpmRuntimeInfo>;
  prewarm(settings: Settings, secrets: OnlineSecrets, action: Action): Promise<void>;
  transcribeSegment?(
    payload: InferenceTaskPayload,
    audio: TaskAudio,
    priorTranscript: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; engine: string; language: string | null; languageSource: ASRResult['language_source'] }>;
  startAsrStream?(
    payload: InferenceTaskPayload,
    priorTranscript?: string,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; model: string } | null>;
  feedAsrStreamChunk?(
    payload: InferenceTaskPayload,
    sessionId: string,
    pcm16Base64: string,
    signal?: AbortSignal,
  ): Promise<{ confirmedText: string; provisionalText: string } | null>;
  resetAsrStream?(
    payload: InferenceTaskPayload,
    sessionId: string,
    priorTranscript?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  finishAsrStream?(
    payload: InferenceTaskPayload,
    sessionId: string,
    options?: { pcm16Base64?: string; closeAfter?: boolean },
    signal?: AbortSignal,
  ): Promise<{ text: string; engine: string; language: string | null; languageSource: ASRResult['language_source'] } | null>;
  closeAsrStream?(
    payload: InferenceTaskPayload,
    sessionId: string,
  ): Promise<void>;
  run(
    payload: InferenceTaskPayload,
    audio: TaskAudio | undefined,
    onEvent: (event: TaskEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  extractCorrectionTerms(
    original: string,
    corrected: string,
    settings: Settings,
    secrets: OnlineSecrets,
    transcript?: string,
    signal?: AbortSignal,
  ): Promise<string[]>;
  cancel(taskId: string): Promise<void>;
}

export interface InferenceServiceOptions {
  promptsDir: string;
  diagnosticsDir?: string;
  usage?: InferenceUsageRecorder;
  archiveAudio?: (audio: TaskAudio, taskId: string) => Promise<Buffer | undefined>;
  acpmDataDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function summarizeModels(models: AcpmModelDTO[]): AcpmModelSummary[] {
  return models.map(model => ({
    id: model.id,
    capability: model.capability,
    displayName: model.display_name,
    installed: model.installed === true,
    state: model.state,
    selectedVariant: model.selected_variant ?? null,
  }));
}

export class InferenceService implements InferenceClient {
  private readonly templates: PromptTemplates;
  private readonly diagnosticsDir?: string;
  private readonly usage?: InferenceUsageRecorder;
  private readonly archiveAudio?: (audio: TaskAudio, taskId: string) => Promise<Buffer | undefined>;
  private readonly acpmDataDir?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly activeTasks = new Map<string, AbortController>();

  constructor(options: InferenceServiceOptions) {
    this.templates = loadPromptTemplates(options.promptsDir);
    this.diagnosticsDir = options.diagnosticsDir;
    this.usage = options.usage;
    this.archiveAudio = options.archiveAudio;
    this.acpmDataDir = options.acpmDataDir;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private diagnostic(event: string, fields: Record<string, unknown> = {}) {
    if (!this.diagnosticsDir) return;
    try {
      mkdirSync(this.diagnosticsDir, { recursive: true, mode: 0o700 });
      const path = join(this.diagnosticsDir, 'inference.jsonl');
      try {
        if (statSync(path).size > 2_000_000) renameSync(path, path + '.1');
      } catch { /* Rotation is best-effort. */ }
      appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n', { mode: 0o600 });
    } catch { /* Diagnostics never interrupt input. */ }
  }

  private createAcpmClient(acpm: AcpmSettings, token: string): AcpmClient {
    return new AcpmClient({
      mode: acpm.mode,
      remoteBaseURL: acpm.remoteBaseURL,
      remoteToken: token,
      caller: 'yanmo-ime',
      dataDir: this.acpmDataDir,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  async checkStatus(settings: Settings, secrets: OnlineSecrets, signal?: AbortSignal): Promise<AcpmRuntimeInfo> {
    const mode = settings.acpm.mode;
    const base = defaultAcpmInfo(mode);
    const client = this.createAcpmClient(settings.acpm, secrets.acpmToken);
    try {
      const models = await client.models(signal);
      const summaries = summarizeModels(models);
      const asr = summaries.find(item => item.id === settings.acpm.asrModel);
      const text = summaries.find(item => item.id === settings.acpm.textModel);
      const vad = summaries.find(item => item.id === 'speech-vad-pyannote');
      return {
        connected: true,
        source: mode,
        baseURL: mode === 'remote' ? settings.acpm.remoteBaseURL.trim().replace(/\/+$/, '') : undefined,
        models: summaries,
        asrReady: asr?.installed === true,
        textReady: text?.installed === true,
        vadReady: vad ? vad.installed === true : true,
      };
    } catch (error) {
      return {
        ...base,
        baseURL: mode === 'remote' ? settings.acpm.remoteBaseURL.trim().replace(/\/+$/, '') : undefined,
        error: friendlyAcpmError(error),
      };
    }
  }

  async prewarm(settings: Settings, secrets: OnlineSecrets, action: Action): Promise<void> {
    const models: string[] = [];
    const promptCacheKeys: string[] = [];
    if (!settings.online.asr.enabled) {
      models.push(settings.acpm.asrModel);
    }
    const needsText = action !== 'dictation' || settings.polishEnabled;
    if (needsText && !settings.online.text.enabled) {
      models.push(settings.acpm.textModel);
      if (action === 'voiceTranslation') promptCacheKeys.push(`yanmo-translate-voice-${settings.voiceTarget}`);
      else if (action === 'selectionTranslation') promptCacheKeys.push('yanmo-translate-selection');
      else promptCacheKeys.push(settings.style === '保留原话' ? 'yanmo-verbatim' : 'yanmo-polish');
    }
    if (!models.length) return;
    const client = this.createAcpmClient(settings.acpm, secrets.acpmToken);
    await client.prewarm(models, promptCacheKeys.length ? promptCacheKeys : undefined);
  }

  async transcribeSegment(
    request: InferenceTaskPayload,
    audio: TaskAudio,
    priorTranscript: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; engine: string; language: string | null; languageSource: ASRResult['language_source'] }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const combinedSignal = controller.signal;
    try {
      const before = combineBeforeContext(request.context.before, priorTranscript, 300);
      const prompt = buildAsrPrompt({ ...request.context, before }, request.asr_hotwords);
      const onlineAsr = request.online.asr;
      if (onlineAsr) {
        const text = await this.onlineTranscribe(onlineAsr, audio, prompt, combinedSignal, request.task_id);
        return { text, engine: onlineAsr.model, language: null, languageSource: 'unknown' };
      }
      const client = this.createAcpmClient(request.acpm, request.acpmToken);
      let ranVad = false;
      if (request.acpm.vadEnabled && request.acpmVadReady) {
        try {
          const vad = await client.vad(audio, { minSpeechMs: 250, minSilenceMs: 300 }, combinedSignal);
          if (Array.isArray(vad.segments) && vad.segments.length === 0) {
            return { text: '', engine: request.acpm.asrModel, language: null, languageSource: 'unknown' };
          }
          ranVad = true;
        } catch (error) {
          if (combinedSignal.aborted) throw error;
          this.diagnostic('vad_skipped', {
            task_id: request.task_id,
            error_type: error instanceof Error ? error.name : 'Unknown',
          });
        }
      }
      this.diagnostic('model_start', { task_id: request.task_id, command: 'transcribe_segment', provider: 'acpm' });
      const asrBegin = Date.now();
      try {
        const res = await client.transcribe(
          audio,
          {
            model: request.acpm.asrModel,
            language: 'auto',
            vadFilter: !ranVad,
            timestamps: false,
            ...(prompt ? { prompt } : {}),
          },
          combinedSignal,
        );
        const text = String(res.text ?? '').trim();
        const detectedLanguage = normalizeAsrLanguage(res.language);
        this.diagnostic('model_complete', {
          task_id: request.task_id,
          command: 'transcribe_segment',
          elapsed_ms: Date.now() - asrBegin,
          output_chars: text.length,
        });
        return {
          text,
          engine: request.acpm.asrModel,
          language: detectedLanguage,
          languageSource: detectedLanguage ? 'detected' : 'unknown',
        };
      } catch (error) {
        if (combinedSignal.aborted) throw error;
        throw new Error(friendlyAcpmError(error));
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async startAsrStream(
    request: InferenceTaskPayload,
    priorTranscript = '',
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; model: string } | null> {
    if (request.online.asr) return null;
    const client = this.createAcpmClient(request.acpm, request.acpmToken);
    const prompt = buildAsrPrompt(
      { ...request.context, before: combineBeforeContext(request.context.before, priorTranscript, 300) },
      request.asr_hotwords,
    );
    try {
      const res = await client.startAsrStream(
        { model: request.acpm.asrModel, language: 'auto', ...(prompt ? { prompt } : {}) },
        signal,
      );
      this.diagnostic('stream_start', { task_id: request.task_id, ok: true });
      return { sessionId: res.session_id, model: res.model };
    } catch (error) {
      this.diagnostic('stream_start', {
        task_id: request.task_id,
        ok: false,
        error_type: error instanceof Error ? error.name : 'Unknown',
        ...(error instanceof AcpmError ? { http_status: error.httpStatus } : {}),
      });
      if (error instanceof AcpmError && (error.httpStatus === 404 || error.httpStatus === 501)) {
        return null;
      }
      throw error;
    }
  }

  async feedAsrStreamChunk(
    request: InferenceTaskPayload,
    sessionId: string,
    pcm16Base64: string,
    signal?: AbortSignal,
  ): Promise<{ confirmedText: string; provisionalText: string } | null> {
    if (request.online.asr) return null;
    const client = this.createAcpmClient(request.acpm, request.acpmToken);
    try {
      const res = await client.feedAsrStreamChunk(
        { model: request.acpm.asrModel, sessionId, pcm16Base64 },
        signal,
      );
      return {
        confirmedText: res.confirmed_text ?? '',
        provisionalText: res.provisional_text ?? '',
      };
    } catch (error) {
      if (signal?.aborted) return null;
      this.diagnostic('stream_chunk_failed', {
        task_id: request.task_id,
        error_type: error instanceof Error ? error.name : 'Unknown',
        ...(error instanceof AcpmError ? { http_status: error.httpStatus } : {}),
      });
      throw error;
    }
  }

  async resetAsrStream(
    request: InferenceTaskPayload,
    sessionId: string,
    priorTranscript = '',
    signal?: AbortSignal,
  ): Promise<void> {
    if (request.online.asr) return;
    const client = this.createAcpmClient(request.acpm, request.acpmToken);
    const prompt = buildAsrPrompt(
      { ...request.context, before: combineBeforeContext(request.context.before, priorTranscript, 300) },
      request.asr_hotwords,
    );
    try {
      await client.resetAsrStream(
        { model: request.acpm.asrModel, sessionId, language: 'auto', ...(prompt ? { prompt } : {}) },
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof AcpmError && (error.httpStatus === 404 || error.httpStatus === 501)) return;
      throw error;
    }
  }

  async finishAsrStream(
    request: InferenceTaskPayload,
    sessionId: string,
    options: { pcm16Base64?: string; closeAfter?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ text: string; engine: string; language: string | null; languageSource: ASRResult['language_source'] } | null> {
    if (request.online.asr || !sessionId) return null;
    const client = this.createAcpmClient(request.acpm, request.acpmToken);
    const started = Date.now();
    this.diagnostic('model_start', { task_id: request.task_id, command: 'stream_finish', provider: 'acpm' });
    try {
      const res = await client.finishAsrStream(
        {
          model: request.acpm.asrModel,
          sessionId,
          pcm16Base64: options.pcm16Base64,
          closeAfter: options.closeAfter,
        },
        signal,
      );
      const text = String(res.text ?? '').trim();
      const detectedLanguage = normalizeAsrLanguage(res.language);
      this.diagnostic('model_complete', {
        task_id: request.task_id,
        command: 'stream_finish',
        elapsed_ms: Date.now() - started,
        output_chars: text.length,
      });
      return {
        text,
        engine: request.acpm.asrModel,
        language: detectedLanguage,
        languageSource: detectedLanguage ? 'detected' : 'unknown',
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      this.diagnostic('stream_finish_failed', {
        task_id: request.task_id,
        error_type: error instanceof Error ? error.name : 'Unknown',
        ...(error instanceof AcpmError ? { http_status: error.httpStatus } : {}),
      });
      if (error instanceof AcpmError && (error.httpStatus === 404 || error.httpStatus === 501)) {
        return null;
      }
      throw new Error(friendlyAcpmError(error));
    }
  }

  async closeAsrStream(request: InferenceTaskPayload, sessionId: string): Promise<void> {
    if (request.online.asr || !sessionId) return;
    const client = this.createAcpmClient(request.acpm, request.acpmToken);
    await client.closeAsrStream(
      { model: request.acpm.asrModel, sessionId },
      AbortSignal.timeout(2000),
    ).catch(() => {});
  }

  private async onlineTranscribe(
    config: OnlineEndpointPayload,
    audio: TaskAudio,
    prompt: string | undefined,
    signal: AbortSignal,
    taskId: string,
  ): Promise<string> {
    const started = Date.now();
    this.diagnostic('api_start', { task_id: taskId, endpoint: '/audio/transcriptions' });
    const bytes = typeof audio === 'string' ? await readFile(audio, { signal }) : audio;
    const form = new FormData();
    form.set('model', config.model);
    form.set('response_format', 'json');
    if (prompt) form.set('prompt', prompt);
    form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'recording.wav');
    const headers: Record<string, string> = {};
    if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;
    let response: Response;
    try {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
      response = await this.fetchImpl(`${config.base_url.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: combined,
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      this.diagnostic('api_error', {
        task_id: taskId,
        endpoint: '/audio/transcriptions',
        error_type: error instanceof Error ? error.name : 'Unknown',
        elapsed_ms: Date.now() - started,
      });
      throw new Error('无法连接在线服务，已保留原文。');
    }
    this.diagnostic('api_response', {
      task_id: taskId,
      endpoint: '/audio/transcriptions',
      status: response.status,
      elapsed_ms: Date.now() - started,
    });
    const text = await response.text().catch(() => '');
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch { /* Handled below. */ }
    if (response.status === 401 || response.status === 403) throw new Error('在线服务拒绝了 API Key，请在设置中检查。');
    if (response.status === 404) throw new Error('在线服务没有这个接口或模型，请检查服务地址与模型 ID。');
    if (response.status === 429) throw new Error('在线服务请求过多或额度不足，请稍后重试。');
    if (response.status >= 300) throw new Error(`在线服务返回错误（HTTP ${response.status}），已保留原文。`);
    if (!parsed || typeof parsed !== 'object') {
      this.diagnostic('api_error', { task_id: taskId, endpoint: '/audio/transcriptions', error_type: 'InvalidJSON' });
      throw new Error('在线服务返回了无法识别的结果。');
    }
    return String(parsed.text ?? '').trim();
  }

  private async onlineChat(
    config: OnlineEndpointPayload,
    system: string,
    payload: unknown,
    purpose: LLMPurpose,
    signal: AbortSignal,
    taskId?: string,
  ): Promise<{ content: string; finishReason: string | null }> {
    const callId = this.usage?.startLlmCall(purpose, config.model);
    const started = Date.now();
    this.diagnostic('api_start', { task_id: taskId ?? '', endpoint: '/chat/completions', purpose });
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      temperature: 0,
      max_tokens: 4096,
    };
    try {
      if (new URL(config.base_url).hostname === 'api.deepseek.com') {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = 'low';
      }
    } catch { /* Invalid URL fails in fetch. */ }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;
    let response: Response;
    try {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
      response = await this.fetchImpl(`${config.base_url.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combined,
        redirect: 'error',
      });
    } catch (error) {
      this.usage?.finishLlmCall(callId, 'request_error');
      if (signal.aborted) throw error;
      this.diagnostic('api_error', {
        task_id: taskId ?? '',
        endpoint: '/chat/completions',
        error_type: error instanceof Error ? error.name : 'Unknown',
        elapsed_ms: Date.now() - started,
      });
      throw new Error('无法连接在线服务，已保留原文。');
    }
    this.diagnostic('api_response', {
      task_id: taskId ?? '',
      endpoint: '/chat/completions',
      status: response.status,
      elapsed_ms: Date.now() - started,
    });
    const rawText = await response.text().catch(() => '');
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch { /* Handled below. */ }
    const validJson = !!parsed && typeof parsed === 'object';
    this.usage?.finishLlmCall(
      callId,
      response.status < 300 && validJson ? 'response' : 'request_error',
      validJson && typeof parsed!.usage === 'object' && parsed!.usage ? (parsed!.usage as Record<string, unknown>) : undefined,
    );
    if (response.status === 401 || response.status === 403) throw new Error('在线服务拒绝了 API Key，请在设置中检查。');
    if (response.status === 404) throw new Error('在线服务没有这个接口或模型，请检查服务地址与模型 ID。');
    if (response.status === 429) throw new Error('在线服务请求过多或额度不足，请稍后重试。');
    if (response.status >= 300) throw new Error(`在线服务返回错误（HTTP ${response.status}），已保留原文。`);
    if (!validJson) {
      this.diagnostic('api_error', { task_id: taskId ?? '', endpoint: '/chat/completions', error_type: 'InvalidJSON' });
      throw new Error('在线服务返回了无法识别的结果。');
    }
    const choices = parsed!.choices;
    const first = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined;
    const message = first && typeof first.message === 'object' && first.message ? (first.message as Record<string, unknown>) : undefined;
    if (!first || !message || !('content' in message)) {
      this.diagnostic('api_error', { task_id: taskId ?? '', endpoint: '/chat/completions', error_type: 'InvalidResponseShape' });
      throw new Error('在线服务返回了无法识别的结果。');
    }
    const content = typeof message.content === 'string' ? message.content : '';
    const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : null;
    this.diagnostic('api_generation', {
      task_id: taskId ?? '',
      finish_reason: ['stop', 'length', 'content_filter', 'tool_calls', 'insufficient_system_resource'].includes(finishReason ?? '') ? finishReason : 'other',
      output_chars: content.length,
      max_tokens: 4096,
    });
    return { content, finishReason };
  }

  private async acpmChat(
    client: AcpmClient,
    model: string,
    system: string,
    payload: unknown,
    promptCacheKey: string,
    purpose: LLMPurpose,
    priority: 'interactive' | 'normal',
    signal: AbortSignal,
    taskId?: string,
  ): Promise<{ content: string; finishReason: string | null }> {
    const callId = this.usage?.startLlmCall(purpose, model);
    const started = Date.now();
    this.diagnostic('model_start', { task_id: taskId ?? '', command: purpose, provider: 'acpm' });
    try {
      const response = await client.chatCompletions(
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(payload) },
          ],
          temperature: 0,
          maxTokens: 4096,
          separateReasoning: true,
          promptCacheKey,
        },
        priority,
        signal,
      );
      this.usage?.finishLlmCall(callId, 'response', response.usage);
      const choice = response.choices?.[0];
      if (!choice || !choice.message) {
        throw new Error('AcpmRuntime 返回了无法识别的响应格式。');
      }
      const content = choice.message.content ?? '';
      const finishReason = choice.finish_reason ?? null;
      this.diagnostic('model_complete', {
        task_id: taskId ?? '',
        command: purpose,
        elapsed_ms: Date.now() - started,
        output_chars: content.length,
      });
      return { content, finishReason };
    } catch (error) {
      this.usage?.finishLlmCall(callId, 'request_error');
      if (signal.aborted) throw error;
      if (error instanceof Error && error.message === 'AcpmRuntime 返回了无法识别的响应格式。') throw error;
      throw new Error(friendlyAcpmError(error));
    }
  }

  private async generateText(
    request: Pick<InferenceTaskPayload, 'acpm' | 'acpmToken' | 'acpmTextReady' | 'online'>,
    system: string,
    payload: unknown,
    promptCacheKey: string,
    purpose: LLMPurpose,
    priority: 'interactive' | 'normal',
    signal: AbortSignal,
    taskId?: string,
  ): Promise<{ text: string; engine: string }> {
    const online = request.online.text;
    let output: { content: string; finishReason: string | null };
    let engine: string;
    if (online) {
      engine = online.model;
      output = await this.onlineChat(online, system, payload, purpose, signal, taskId);
    } else if (request.acpmTextReady) {
      engine = request.acpm.textModel;
      const client = this.createAcpmClient(request.acpm, request.acpmToken);
      output = await this.acpmChat(client, request.acpm.textModel, system, payload, promptCacheKey, purpose, priority, signal, taskId);
    } else {
      throw new Error('请先启动 AcpmRuntime 并准备文字模型，或在设置中启用在线文字处理 API。');
    }
    if (output.finishReason !== 'stop') {
      throw new Error('处理超出长度上限，未写入截断内容；请分段后重试。');
    }
    if (!output.content.trim()) {
      throw new Error('模型返回空正文；已保留原始转写。');
    }
    return { text: output.content, engine };
  }

  async run(
    request: InferenceTaskPayload,
    audio: TaskAudio | undefined,
    onEvent: (event: TaskEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    this.activeTasks.set(request.task_id, controller);

    const started = Date.now();
    let currentStage: Stage | 'starting' = 'starting';
    let original = '';
    let terminalEmitted = false;
    this.diagnostic('task_start', { task_id: request.task_id, operation: request.operation });

    const emitTerminal = (event: TaskEvent) => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      onEvent(event);
    };

    const emitStage = (stage: Stage) => {
      controller.signal.throwIfAborted();
      currentStage = stage;
      this.diagnostic('stage', { task_id: request.task_id, stage });
      onEvent({ event: 'stage', task_id: request.task_id, stage });
    };

    try {
      const operation = request.operation;
      const hasText = Boolean(request.online.text || request.acpmTextReady);
      const useText = operation !== 'dictation' || (request.polish && hasText);
      const candidates: ASRResult[] = [...(request.asr_results ?? [])];

      if (operation === 'dictation' || operation === 'voiceTranslation') {
        if (request.pretranscribed) {
          original = request.text.trim();
          if (!original) {
            throw new Error('没有识别到语音，请靠近麦克风后重试。');
          }
          if (!candidates.length) {
            candidates.push({
              engine_name: request.online.asr?.model ?? request.acpm.asrModel,
              transcript: original,
              language: null,
              language_source: 'unknown',
            });
          }
          controller.signal.throwIfAborted();
          onEvent({ event: 'transcript', task_id: request.task_id, text: original, asr_results: structuredClone(candidates) });
        } else {
          if (!audio) throw new Error('缺少录音文件。');
          if (Buffer.isBuffer(audio) && (!audio.length || audio.length > maxAudioBytes)) {
            throw new Error('音频大小无效，请分段处理。');
          }
          emitStage('transcribing');
          const onlineAsr = request.online.asr;
          const prompt = buildAsrPrompt(request.context, request.asr_hotwords);
          let transcriptText = '';
          let detectedLanguage: string | null = null;
          let languageSource: ASRResult['language_source'] = 'unknown';
          let engineName = '';

          if (onlineAsr) {
            engineName = onlineAsr.model;
            transcriptText = await this.onlineTranscribe(onlineAsr, audio, prompt, controller.signal, request.task_id);
          } else {
            engineName = request.acpm.asrModel;
            const client = this.createAcpmClient(request.acpm, request.acpmToken);
            let ranVad = false;
            if (request.acpm.vadEnabled && request.acpmVadReady) {
              try {
                const vad = await client.vad(audio, { minSpeechMs: 250, minSilenceMs: 300 }, controller.signal);
                if (Array.isArray(vad.segments) && vad.segments.length === 0) {
                  throw new Error('没有识别到语音，请靠近麦克风后重试。');
                }
                ranVad = true;
              } catch (error) {
                if (controller.signal.aborted) throw error;
                if (error instanceof Error && error.message === '没有识别到语音，请靠近麦克风后重试。') throw error;
                this.diagnostic('vad_skipped', {
                  task_id: request.task_id,
                  error_type: error instanceof Error ? error.name : 'Unknown',
                });
              }
            }
            this.diagnostic('model_start', { task_id: request.task_id, command: 'transcribe', provider: 'acpm' });
            const asrBegin = Date.now();
            try {
              const res = await client.transcribe(
                audio,
                {
                  model: request.acpm.asrModel,
                  language: 'auto',
                  vadFilter: !ranVad,
                  timestamps: false,
                  ...(prompt ? { prompt } : {}),
                },
                controller.signal,
              );
              transcriptText = String(res.text ?? '').trim();
              detectedLanguage = normalizeAsrLanguage(res.language);
              languageSource = detectedLanguage ? 'detected' : 'unknown';
              this.diagnostic('model_complete', {
                task_id: request.task_id,
                command: 'transcribe',
                elapsed_ms: Date.now() - asrBegin,
                output_chars: transcriptText.length,
              });
            } catch (error) {
              if (controller.signal.aborted) throw error;
              throw new Error(friendlyAcpmError(error));
            }
          }

          if (!transcriptText) {
            throw new Error('没有识别到语音，请靠近麦克风后重试。');
          }
          original = transcriptText;
          candidates.push({
            engine_name: engineName,
            transcript: original,
            language: detectedLanguage,
            language_source: languageSource,
          });
          controller.signal.throwIfAborted();
          onEvent({ event: 'transcript', task_id: request.task_id, text: original, asr_results: structuredClone(candidates) });
        }

        if (request.archive_audio && this.archiveAudio && audio) {
          try {
            const archived = await this.archiveAudio(audio, request.task_id);
            controller.signal.throwIfAborted();
            if (archived?.length) {
              onEvent({ event: 'audio', task_id: request.task_id, audio_opus: archived.toString('base64') });
            } else {
              throw new Error('EmptyArchive');
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            this.diagnostic('audio_archive_failed', {
              task_id: request.task_id,
              error_type: error instanceof Error ? error.name : 'Unknown',
            });
            onEvent({
              event: 'audio',
              task_id: request.task_id,
              audio_warning: '录音未保存：音频压缩失败，文字处理继续。',
            });
          }
        }
      } else {
        original = request.text;
      }

      let resultText = original;
      let processed = false;
      const promptBase = {
        ...request.context,
        lexicon: [],
        text: original,
        asr_results: candidates,
        target_language: request.target_language,
      };

      if (operation === 'selectionTranslation') {
        emitStage('translating');
        const payload = buildTranslationPayload(promptBase);
        const source = String(payload.SOURCE_TEXT);
        const { masked, protectedMap } = protectMarkdownCode(source);
        if (protectedMap.has(masked.trim())) {
          resultText = source;
        } else {
          payload.SOURCE_TEXT = masked;
          const generated = await this.generateText(
            request,
            TRANSLATION_PROMPT,
            payload,
            'yanmo-translate-selection',
            'translate',
            'interactive',
            controller.signal,
            request.task_id,
          );
          resultText = restoreMarkdownCode(generated.text, protectedMap);
        }
        processed = true;
      } else if (operation === 'voiceTranslation') {
        emitStage('translating');
        const { system, payload, promptCacheKey } = buildVoiceTranslationPrompt(
          this.templates,
          promptBase,
          request.target_language,
        );
        const generated = await this.generateText(
          request,
          system,
          payload,
          promptCacheKey,
          'translate',
          'interactive',
          controller.signal,
          request.task_id,
        );
        resultText = generated.text;
        processed = true;
      } else if (useText) {
        emitStage('polishing');
        const isVerbatim = operation === 'dictation' && request.style === '保留原话';
        if (isVerbatim) {
          const { system, payload, promptCacheKey } = buildVerbatimPrompt(this.templates, promptBase);
          const generated = await this.generateText(
            request,
            system,
            payload,
            promptCacheKey,
            'polish',
            'interactive',
            controller.signal,
            request.task_id,
          );
          resultText = generated.text;
          processed = false;
        } else {
          const instruction = request.style === '即时消息'
            ? '整理为即时消息。'
            : request.style === '文档段落'
              ? '整理为文档段落。'
              : '';
          const payload = buildPolishPayload({ ...promptBase, instruction });
          const generated = await this.generateText(
            request,
            this.templates.polish,
            payload,
            'yanmo-polish',
            'polish',
            'interactive',
            controller.signal,
            request.task_id,
          );
          resultText = generated.text;
          processed = true;
        }
      }

      if (!resultText) {
        this.diagnostic('task_error', { task_id: request.task_id, stage: currentStage, error_type: 'EmptyModelOutput' });
        emitTerminal({
          event: 'error',
          task_id: request.task_id,
          message: '模型没有返回正文，识别原文已保留，请重试。',
          original,
        });
        return;
      }

      controller.signal.throwIfAborted();
      this.diagnostic('task_complete', { task_id: request.task_id, elapsed_ms: Date.now() - started });
      emitTerminal({ event: 'result', task_id: request.task_id, text: resultText, original, processed });
    } catch (error) {
      if (controller.signal.aborted) {
        this.diagnostic('task_cancelled', { task_id: request.task_id, stage: currentStage });
        emitTerminal({ event: 'cancelled', task_id: request.task_id, original });
      } else {
        this.diagnostic('task_error', {
          task_id: request.task_id,
          stage: currentStage,
          error_type: error instanceof Error ? error.name : 'Unknown',
          elapsed_ms: Date.now() - started,
        });
        emitTerminal({
          event: 'error',
          task_id: request.task_id,
          message: error instanceof Error ? error.message : '推理未完成，已保留原文。',
          original,
        });
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.activeTasks.get(request.task_id) === controller) {
        this.activeTasks.delete(request.task_id);
      }
    }
  }

  async extractCorrectionTerms(
    original: string,
    corrected: string,
    settings: Settings,
    secrets: OnlineSecrets,
    transcript?: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!hasCorrectionDiff(original, corrected)) return [];
    const payload: Record<string, string> = { ORIGINAL: original, CORRECTED: corrected };
    if (transcript) payload.ASR = transcript;
    const onlineText = settings.online.text.enabled
      ? {
          base_url: settings.online.text.baseURL,
          model: settings.online.text.model.trim(),
          api_key: secrets.online.text || '',
        }
      : undefined;
    const generated = await this.generateText(
      {
        acpm: settings.acpm,
        acpmToken: secrets.acpmToken,
        acpmTextReady: !onlineText,
        online: onlineText ? { text: onlineText } : {},
      },
      this.templates.correction,
      payload,
      'yanmo-correction-terms',
      'hotword_extract',
      'normal',
      signal ?? new AbortController().signal,
    );
    return parseCorrectionTerms(generated.text, corrected, original);
  }

  async cancel(taskId: string): Promise<void> {
    this.activeTasks.get(taskId)?.abort();
  }
}
