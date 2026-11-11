/**
 * Cliente rápido para o Google AI Studio (Gemini):
 * 1. Monta a fila de modelos pela velocidade (Flash-Lite primeiro), e não pela ordem em que foram guardados;
 * 2. Pede o "raciocínio" mais curto que cada modelo aceita (é o raciocínio longo que fazia cada etapa levar 30 a 80 s);
 * 3. Lembra, enquanto a extensão está acordada, qual modelo respondeu e quais falharam, para não pagar a mesma espera de novo;
 * 4. Tem um teto de tempo por tentativa e por chamada inteira, e devolve quanto tempo cada tentativa levou (vai para o diário).
 */

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const DEFAULT_FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-flash'];

/** Uma resposta que demora mais de 30 s derruba o serviço da extensão no Chrome; nenhuma tentativa passa disso. */
const HARD_ATTEMPT_LIMIT_MS = 28_000;

const EXCLUDED_MODEL_TOKENS = [
  'embedding',
  'imagen',
  'veo',
  'tts',
  'audio',
  'aqa',
  'learnlm',
  'robotics',
  'computer-use',
  'live',
  'image',
  'thinking',
  'gemma',
  'transcribe',
  'omni',
  'banana',
  'customtools',
];

export interface GeminiCallOptions {
  apiKey: string;
  preferredModel?: string;
  /** true quando a pessoa escolheu o modelo na lista; aí ele é tentado primeiro. Sem isso a fila é só pela velocidade. */
  userPickedModel?: boolean;
  discoveredModels?: readonly string[];
  systemInstruction?: string;
  prompt: string;
  pdfBase64?: string;
  /** Teto de cada tentativa (padrão 12 s). */
  timeoutMs?: number;
  /** Teto da chamada inteira, somando as tentativas (padrão 26 s). */
  totalBudgetMs?: number;
  /** Quantos modelos tentar no máximo (padrão 3). */
  maxAttempts?: number;
  /** 'fast' (padrão) pede o raciocínio mais curto; 'default' deixa o do modelo. */
  thinking?: 'fast' | 'default';
  /** 'speed' (padrão) para responder formulário; 'quality' põe o Flash mais novo na frente (leitura do currículo). */
  prefer?: 'speed' | 'quality';
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface GeminiAttempt {
  model: string;
  ms: number;
  outcome: 'ok' | 'timeout' | 'network' | 'bad_format' | `http_${number}`;
}

export type GeminiJsonResult<T> =
  | {
      ok: true;
      data: T;
      modelUsed: string;
      elapsedMs: number;
      attempts: GeminiAttempt[];
    }
  | {
      ok: false;
      errorPtBr: string;
      statusCode?: number;
      modelTried?: string;
      elapsedMs: number;
      attempts: GeminiAttempt[];
    };

export interface DiscoveredModelsResult {
  ok: boolean;
  models: string[];
  bestModel: string;
  errorPtBr?: string;
}

// Memória curta (vale enquanto o serviço da extensão está acordado).
let lastGoodModel: string | null = null;
const modelRestUntil = new Map<string, number>();
const rejectsThinkingConfig = new Set<string>();

/** Só para os testes: esquece o que foi aprendido sobre os modelos. */
export function resetGeminiModelMemory(): void {
  lastGoodModel = null;
  modelRestUntil.clear();
  rejectsThinkingConfig.clear();
}

function cleanModelId(raw: string): string {
  return raw.trim().replace(/^models\//i, '');
}

function modelVersion(lower: string): number {
  const ver = Number(/^gemini-(\d+(?:\.\d+)?)/.exec(lower)?.[1] ?? Number.NaN);
  return Number.isFinite(ver) ? ver : Number.NaN;
}

export function scoreModelForAutoFill(id: string): number {
  const lower = id.toLowerCase();
  if (!lower.startsWith('gemini-')) return -1;
  if (EXCLUDED_MODEL_TOKENS.some((tok) => lower.includes(tok))) return -1;

  let score = 100;
  // Todos os Flash-Lite ficam na frente de qualquer Flash: respondem em 1 a 2 s e têm a maior cota gratuita.
  if (lower.includes('flash-lite')) score += 100;
  else if (lower.includes('flash')) score += 45;
  else if (lower.includes('pro')) score += 5;

  // Preferir versões estáveis sobre preview/exp
  if (lower.includes('preview') || lower.includes('exp')) score -= 18;
  if (lower.endsWith('-latest')) score -= 5;

  const ver = modelVersion(lower);
  if (Number.isFinite(ver)) score += ver * 25;

  return score;
}

export function rankGeminiModels(rawModels: ReadonlyArray<{ name?: string; supportedGenerationMethods?: readonly string[] }>): string[] {
  const scored: Array<{ id: string; score: number }> = [];
  const seen = new Set<string>();

  for (const item of rawModels) {
    const methods = item.supportedGenerationMethods ?? [];
    if (!methods.includes('generateContent')) continue;
    const id = cleanModelId(item.name ?? '');
    if (!id || seen.has(id)) continue;
    const score = scoreModelForAutoFill(id);
    if (score < 0) continue;
    seen.add(id);
    scored.push({ id, score });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.map((s) => s.id);
}

/**
 * O raciocínio mais curto que cada modelo aceita no generateContent (documentação do Google conferida em 2026-11-11):
 * - 2.5 Flash: `thinkingBudget: 0` desliga; 2.5 Flash-Lite já vem desligado; o campo `thinkingLevel` dá erro antes do Gemini 3.
 * - Gemini 3 em diante: `thinkingLevel`. "MINIMAL" existe nos Flash-Lite, no 3 Flash e no 3.6 Flash; no 3.8 Flash e nos
 *   Gemini 4 o menor é "LOW". Para versão que não conheço, "LOW" (aceito por todos os listados).
 * Devolve null quando o melhor é não mandar nada.
 */
export function fastThinkingConfigFor(model: string): Record<string, unknown> | null {
  const lower = model.toLowerCase();
  const ver = modelVersion(lower);
  if (!Number.isFinite(ver) || ver < 2.5) return null;
  if (ver < 3) {
    if (lower.includes('flash-lite') || lower.includes('pro')) return null;
    return { thinkingBudget: 0 };
  }
  if (lower.includes('flash-lite')) return { thinkingLevel: 'MINIMAL' };
  if (lower.includes('flash') && (ver === 3 || ver === 3.6)) return { thinkingLevel: 'MINIMAL' };
  return { thinkingLevel: 'LOW' };
}

export function translateGeminiHttpError(status: number, rawMessage?: string): string {
  const msg = (rawMessage ?? '').toLowerCase();
  if (status === 400 && (msg.includes('api_key_invalid') || msg.includes('api key not valid') || msg.includes('invalid api key'))) {
    return 'A chave colada não é válida. Confira se copiou a chave inteira lá do Google AI Studio (começa com AIza...).';
  }
  if (status === 401 || status === 403) {
    return 'O Google recusou a chave (sem permissão ou chave inválida). Gere uma chave nova no Google AI Studio.';
  }
  if (status === 404) {
    return 'O modelo escolhido não está disponível nesta conta do Google AI Studio.';
  }
  if (status === 429) {
    return 'O limite gratuito por minuto/dia do Google AI Studio foi atingido neste modelo. Aguarde 1 minuto ou troque o modelo.';
  }
  if (status >= 500) {
    return 'O servidor do Google AI Studio está instável neste momento. Tente novamente em instantes.';
  }
  return `Falha na comunicação com o Google AI Studio (código ${status}).`;
}

export async function discoverGeminiModels(
  apiKeyRaw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModelsResult> {
  const apiKey = apiKeyRaw.trim();
  if (!apiKey) {
    return {
      ok: false,
      models: [],
      bestModel: DEFAULT_FALLBACK_MODELS[0]!,
      errorPtBr: 'Cole a sua chave do Google AI Studio primeiro.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetchImpl(`${GEMINI_HOST}/v1beta/models?pageSize=100`, {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      let errText = '';
      try {
        const errJson = (await res.json()) as { error?: { message?: string } };
        errText = errJson?.error?.message ?? '';
      } catch {
        // ignore
      }
      return {
        ok: false,
        models: [],
        bestModel: DEFAULT_FALLBACK_MODELS[0]!,
        errorPtBr: translateGeminiHttpError(res.status, errText),
      };
    }

    const body = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const ranked = rankGeminiModels(body.models ?? []);
    const models = ranked.length > 0 ? ranked : [...DEFAULT_FALLBACK_MODELS];
    return {
      ok: true,
      models,
      bestModel: models[0]!,
    };
  } catch {
    return {
      ok: false,
      models: [],
      bestModel: DEFAULT_FALLBACK_MODELS[0]!,
      errorPtBr: 'Sem conexão ou demora no Google AI Studio. Verifique sua internet.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function extractJsonFromText<T>(rawText: string): T | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch?.[1]) {
    candidates.unshift(fenceMatch[1].trim());
  } else {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * A fila de modelos de uma chamada. Sem escolha da pessoa, a ordem é a da velocidade, com o último modelo que respondeu
 * na frente e os que acabaram de falhar no fim. A ordem em que os modelos foram guardados não importa: era ela que deixava
 * os modelos lentos na frente mesmo depois de a lista ter sido corrigida.
 */
export function buildCandidateModelChain(opts: {
  preferred?: string;
  userPicked?: boolean;
  discovered?: readonly string[];
  nowMs?: number;
  prefer?: 'speed' | 'quality';
}): string[] {
  const valid = (m?: string): string => {
    const clean = m ? cleanModelId(m) : '';
    return clean && /^[a-z0-9][a-z0-9.-]{1,63}$/i.test(clean) ? clean : '';
  };
  const pool: string[] = [];
  const add = (m?: string): void => {
    const clean = valid(m);
    if (clean && !pool.includes(clean)) pool.push(clean);
  };
  add(opts.preferred);
  for (const m of opts.discovered ?? []) add(m);
  if ((opts.discovered ?? []).length === 0) for (const m of DEFAULT_FALLBACK_MODELS) add(m);

  const ranked = pool
    .map((id, index) => ({ id, index, score: scoreModelForAutoFill(id) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.id);

  const picked = opts.userPicked ? valid(opts.preferred) : '';
  // Qualidade: o Flash (não Lite) de versão mais alta, estável, vai na frente; os demais seguem pela velocidade.
  const careful =
    opts.prefer === 'quality'
      ? ranked
          .filter((id) => /flash/i.test(id) && !/flash-lite/i.test(id) && !/preview|exp|latest/i.test(id))
          .sort((a, b) => modelVersion(b.toLowerCase()) - modelVersion(a.toLowerCase()))[0]
      : undefined;
  const head = picked ? [picked] : careful ? [careful] : lastGoodModel && ranked.includes(lastGoodModel) ? [lastGoodModel] : [];
  const ordered = [...head, ...ranked.filter((id) => !head.includes(id))];

  const nowMs = opts.nowMs ?? Date.now();
  const resting = (id: string): boolean => (modelRestUntil.get(id) ?? 0) > nowMs;
  return [...ordered.filter((id) => !resting(id)), ...ordered.filter(resting)];
}

function buildPayloadForModel(model: string, options: GeminiCallOptions, withThinkingConfig: boolean): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  if (options.pdfBase64) {
    parts.push({
      inlineData: {
        mimeType: 'application/pdf',
        data: options.pdfBase64,
      },
    });
  }
  parts.push({ text: options.prompt });

  const generationConfig: Record<string, unknown> = {
    temperature: 0.1,
    responseMimeType: 'application/json',
  };

  if (withThinkingConfig) {
    const thinkingConfig = fastThinkingConfigFor(model);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
  }

  const payload: Record<string, unknown> = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };

  if (options.systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: options.systemInstruction }],
    };
  }
  return payload;
}

function restFor(outcome: GeminiAttempt['outcome']): number {
  if (outcome === 'http_404') return 60 * 60_000;
  if (outcome === 'http_429') return 60_000;
  if (outcome === 'timeout') return 3 * 60_000;
  if (outcome === 'bad_format') return 60_000;
  if (outcome === 'network') return 0;
  return 30_000;
}

/** Resumo curto das tentativas, para o diário: "gemini-x 1.2s ok" ou "gemini-y 12.0s demorou; gemini-x 1.4s ok". */
export function describeAttempts(attempts: readonly GeminiAttempt[]): string {
  const word = (outcome: GeminiAttempt['outcome']): string => {
    if (outcome === 'ok') return 'ok';
    if (outcome === 'timeout') return 'demorou demais';
    if (outcome === 'network') return 'sem rede';
    if (outcome === 'bad_format') return 'resposta fora do formato';
    if (outcome === 'http_429') return 'limite gratuito atingido';
    if (outcome === 'http_404') return 'modelo indisponível';
    return `erro ${outcome.slice(5)}`;
  };
  return attempts.map((a) => `${a.model} ${(a.ms / 1000).toFixed(1)}s ${word(a.outcome)}`).join('; ');
}

export async function callGeminiJson<T>(options: GeminiCallOptions): Promise<GeminiJsonResult<T>> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    return { ok: false, errorPtBr: 'Chave do Google AI Studio não configurada no Passo 2.', elapsedMs: 0, attempts: [] };
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = Math.min(options.timeoutMs ?? 12_000, HARD_ATTEMPT_LIMIT_MS);
  const totalBudgetMs = options.totalBudgetMs ?? 26_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const wantFast = (options.thinking ?? 'fast') === 'fast';
  const started = now();
  const models = buildCandidateModelChain({
    preferred: options.preferredModel,
    userPicked: options.userPickedModel,
    discovered: options.discoveredModels,
    nowMs: started,
    prefer: options.prefer,
  });

  const attempts: GeminiAttempt[] = [];
  let lastError = 'Não foi possível obter resposta da IA.';
  let lastStatus: number | undefined;
  let lastModel: string | undefined;
  let modelsTried = 0;

  const fail = (): GeminiJsonResult<T> => ({
    ok: false,
    errorPtBr: lastError,
    statusCode: lastStatus,
    modelTried: lastModel,
    elapsedMs: now() - started,
    attempts,
  });

  for (const model of models) {
    if (modelsTried >= maxAttempts) break;
    modelsTried += 1;
    lastModel = model;

    // Até duas idas ao mesmo modelo: a segunda só acontece se ele recusou a configuração de raciocínio curto.
    for (let pass = 0; pass < 2; pass += 1) {
      const remaining = totalBudgetMs - (now() - started);
      if (remaining < 1_500) return fail();
      const withThinkingConfig = wantFast && !rejectsThinkingConfig.has(model);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
      const attemptStart = now();
      const note = (outcome: GeminiAttempt['outcome']): void => {
        attempts.push({ model, ms: now() - attemptStart, outcome });
        const rest = restFor(outcome);
        if (outcome !== 'ok' && rest > 0) modelRestUntil.set(model, now() + rest);
      };

      try {
        const payload = buildPayloadForModel(model, options, withThinkingConfig);
        const res = await fetchFn(`${GEMINI_HOST}/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          lastStatus = res.status;
          let errMessage = '';
          try {
            const errBody = (await res.json()) as { error?: { message?: string } };
            errMessage = errBody?.error?.message ?? '';
          } catch {
            // ignore
          }
          lastError = translateGeminiHttpError(res.status, errMessage);
          const keyProblem = res.status === 401 || res.status === 403 || (res.status === 400 && errMessage.toLowerCase().includes('api key'));

          if (keyProblem) {
            attempts.push({ model, ms: now() - attemptStart, outcome: `http_${res.status}` });
            return fail();
          }
          if (res.status === 400 && withThinkingConfig && 'thinkingConfig' in (payload.generationConfig as Record<string, unknown>)) {
            // O modelo não aceita a configuração de raciocínio curto: guarda isso e tenta o mesmo modelo sem ela.
            attempts.push({ model, ms: now() - attemptStart, outcome: 'http_400' });
            rejectsThinkingConfig.add(model);
            continue;
          }
          note(`http_${res.status}`);
          break;
        }

        const json = (await res.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string; thought?: boolean }> };
          }>;
        };
        const text =
          json.candidates?.[0]?.content?.parts
            ?.filter((p) => p.thought !== true)
            .map((p) => p.text ?? '')
            .join('\n')
            .trim() ?? '';

        const parsed = extractJsonFromText<T>(text);
        if (parsed === null) {
          lastError = `O modelo ${model} respondeu num formato inesperado.`;
          note('bad_format');
          break;
        }

        note('ok');
        if (options.prefer !== 'quality') lastGoodModel = model;
        modelRestUntil.delete(model);
        return { ok: true, data: parsed, modelUsed: model, elapsedMs: now() - started, attempts };
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        lastError = isAbort ? `O modelo ${model} demorou demais para responder.` : 'Falha de rede ao chamar o Google AI Studio.';
        note(isAbort ? 'timeout' : 'network');
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return fail();
}
