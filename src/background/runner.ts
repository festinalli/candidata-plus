import type { BgResponse, BgToContentMessage, ContentRpcResponses } from '../shared/messages.ts';
import type { AnswerEntry, BatchJobItem, JobOutcomeKind, PendingQuestion, WorkMode } from '../shared/types.ts';
import { makeQuestionKey } from '../shared/normalize.ts';
import { emptyBatchRunState, loadState, updateState } from '../shared/storage.ts';
import { buildLinkedInSearchUrl } from '../shared/search-url.ts';
import { solveFormStep } from '../core/solver.ts';

const MAX_DIARY_LINES = 500;
const MAX_STEPS_PER_JOB = 20;

let activeLoopPromise: Promise<void> | null = null;
let controlSignal: 'run' | 'pause' | 'stop' = 'run';
let runStartEpoch = 0;

function elapsedTag(): string {
  const sec = Math.max(0, (Date.now() - runStartEpoch) / 1000);
  return `+${sec.toFixed(1)}s`;
}

async function addDiary(line: string): Promise<void> {
  const stamped = `[${elapsedTag()}] ${line}`.slice(0, 350);
  await updateState((st) => ({
    ...st,
    run: {
      ...st.run,
      diary: [...st.run.diary, stamped].slice(-MAX_DIARY_LINES),
    },
  }));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mantém o serviço da extensão acordado durante o envio. O Chrome desliga o serviço depois de 30 s sem nenhuma
 * chamada dele; numa espera longa (a IA, uma página lenta) o envio morria calado e a tela ficava em "Rodando" para sempre.
 * Uma chamada simples a cada 20 s é a forma documentada pelo Chrome de evitar isso.
 */
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepAlive(): void {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    try {
      void chrome.runtime.getPlatformInfo().catch(() => undefined);
    } catch {
      // ignore
    }
  }, 20_000);
}

function stopKeepAlive(): void {
  if (keepAliveTimer !== null) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function waitTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {
      return;
    }
    await sleepMs(250);
  }
}

async function waitPauseOrStop(totalMs: number): Promise<'ok' | 'stop'> {
  if (totalMs <= 0) return controlSignal === 'stop' ? 'stop' : 'ok';
  const end = Date.now() + totalMs;
  while (Date.now() < end) {
    if (controlSignal === 'stop') return 'stop';
    while (controlSignal === 'pause') {
      await sleepMs(300);
      if ((controlSignal as string) === 'stop') return 'stop';
    }
    await sleepMs(Math.min(200, Math.max(40, end - Date.now())));
  }
  return controlSignal === 'stop' ? 'stop' : 'ok';
}

function isLinkedinUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === 'linkedin.com' || host.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

function rankTabUrl(url: string): number {
  if (/\/jobs\/(search-results|search|collections|view)\b/i.test(url)) return 4;
  if (/\/jobs\b/i.test(url)) return 3;
  return 1;
}

async function findLinkedInJobsTab(preferredTabId?: number): Promise<chrome.tabs.Tab | null> {
  if (preferredTabId !== undefined) {
    try {
      const pref = await chrome.tabs.get(preferredTabId);
      if (pref && isLinkedinUrl(pref.url) && rankTabUrl(pref.url ?? '') >= 3) {
        return pref;
      }
    } catch {
      // ignore
    }
  }

  // Checa a aba ativa da janela focada primeiro
  try {
    const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const focusedLi = focusedTabs.find((t) => isLinkedinUrl(t.url) && rankTabUrl(t.url ?? '') >= 3);
    if (focusedLi) return focusedLi;
  } catch {
    // ignore
  }

  const allLiTabs = await chrome.tabs.query({ url: ['https://www.linkedin.com/*', 'https://*.linkedin.com/*'] });
  if (allLiTabs.length === 0) return null;

  const sorted = [...allLiTabs].sort((a, b) => {
    const scoreDiff = rankTabUrl(b.url ?? '') - rankTabUrl(a.url ?? '');
    if (scoreDiff !== 0) return scoreDiff;
    return Number(Boolean(b.active)) - Number(Boolean(a.active));
  });

  return sorted[0] ?? null;
}

async function sendToLinkedIn<K extends BgToContentMessage['type']>(
  tabId: number,
  msg: Extract<BgToContentMessage, { type: K }>,
): Promise<BgResponse<ContentRpcResponses[K]>> {
  const trySend = async (): Promise<BgResponse<ContentRpcResponses[K]> | null> => {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, msg)) as BgResponse<ContentRpcResponses[K]> | undefined;
      return res ?? null;
    } catch {
      return null;
    }
  };

  let response = await trySend();
  if (response !== null) return response;

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/linkedin.css'] });
  } catch {
    // ignore
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/linkedin.js'] });
    await sleepMs(250);
    response = await trySend();
    if (response !== null) return response;
  } catch {
    // ignore
  }

  return { ok: false, error: 'Não foi possível comunicar com a aba do LinkedIn. Dê F5 na página de vagas do LinkedIn.' };
}

type ListData = ContentRpcResponses['LIST_CARDS'];

function pageKindOf(data: ListData): 'list' | 'job' | 'other' {
  return data.pageKind ?? (data.isSearchPage ? 'list' : 'other');
}

/** O endereço da lista sem a vaga selecionada, para poder voltar a ela. */
function listUrlOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (/^\/(?:comm\/)?jobs\/view\//i.test(u.pathname)) return null;
    u.searchParams.delete('currentJobId');
    return u.href;
  } catch {
    return null;
  }
}

/** Os dois endereços são da MESMA lista? (mesmo tipo de página e mesma palavra buscada) */
function sameList(listUrl: string, currentUrl: string): boolean {
  try {
    const a = new URL(listUrl);
    const b = new URL(currentUrl);
    // A busca antiga (/jobs/search/) e a nova (/jobs/search-results/) são a mesma lista.
    const family = (path: string): string => (/^\/jobs\/search/i.test(path) ? 'search' : path.replace(/\/+$/, ''));
    return family(a.pathname) === family(b.pathname) && (a.searchParams.get('keywords') ?? '') === (b.searchParams.get('keywords') ?? '');
  } catch {
    return true;
  }
}

/**
 * A aba ainda mostra a lista em que o envio está trabalhando?
 * - numa página de lista: sim, se é a mesma lista e tem vagas;
 * - num endereço de vaga só (/jobs/view/<id>/): só se a lista continua na tela, isto é, se há vários cartões e algum
 *   deles é uma vaga que este envio já percorreu (é o caso do formulário aberto sobre a lista). Uma página de vaga
 *   solta, ou o feed, não é a lista.
 */
export function isStillOnList(listUrl: string, data: ListData, processedJobIds: ReadonlySet<string>): boolean {
  const kind = pageKindOf(data);
  if (kind === 'other' || data.cards.length === 0) return false;
  if (kind === 'list') return sameList(listUrl, data.url);
  return data.cards.length >= 2 && data.cards.some((c) => processedJobIds.has(c.jobId));
}

const MAX_RETURNS_TO_LIST = 8;

/**
 * Lê a lista de vagas esperando ela ficar pronta: devolve na hora em que `ready` aceita a leitura, ou a última
 * leitura quando o tempo acaba. A lista do LinkedIn se redesenha (ao abrir a página, ao fechar um formulário), e uma
 * leitura feita nesse instante vinha vazia ou pela metade.
 */
async function readCardsWaiting(tabId: number, maxWaitMs: number, ready: (data: ListData) => boolean): Promise<ListData | null> {
  const end = Date.now() + maxWaitMs;
  let last: ListData | null = null;
  for (;;) {
    const res = await sendToLinkedIn(tabId, { type: 'LIST_CARDS' });
    if (res.ok && res.data) {
      last = res.data;
      if (ready(res.data)) return res.data;
    }
    if (Date.now() >= end || controlSignal === 'stop') return last;
    await sleepMs(400);
  }
}

function workModeLabel(mode: WorkMode): string {
  if (mode === 'remote') return 'Remoto';
  if (mode === 'hybrid') return 'Híbrido';
  return 'Presencial';
}

async function recordJobOutcome(item: BatchJobItem): Promise<void> {
  await updateState((st) => {
    const c = { ...st.run.counts };
    if (item.outcome === 'applied') c.applied += 1;
    else if (item.outcome === 'simulated') c.simulated += 1;
    else if (item.outcome === 'needs_answer') c.needsAnswer += 1;
    else if (item.outcome === 'failed') c.failed += 1;
    else c.skipped += 1;

    return {
      ...st,
      run: {
        ...st.run,
        counts: c,
        jobs: [item, ...st.run.jobs].slice(0, 200),
      },
    };
  });
}

async function saveAiLearnedAndPending(params: {
  learned: Array<{ questionKey: string; question: string; answer: string; fieldType: AnswerEntry['fieldType'] }>;
  pending: Array<Omit<PendingQuestion, 'id' | 'jobId' | 'jobTitle' | 'company' | 'askedAt'>>;
  jobId: string;
  jobTitle: string;
  company: string;
  aiStatsDelta: {
    calls: number;
    questionsSent: number;
    answered: number;
    unknown: number;
    errors: number;
    lastModel?: string;
    lastError?: string;
    lastMs?: number;
  };
}): Promise<void> {
  const now = new Date().toISOString();
  await updateState((st) => {
    const nextAnswers = [...st.answers];
    for (const item of params.learned) {
      const existingIdx = nextAnswers.findIndex((a) => a.questionKey === item.questionKey);
      if (existingIdx >= 0) {
        if (nextAnswers[existingIdx]!.source !== 'ai') continue;
        nextAnswers[existingIdx] = {
          ...nextAnswers[existingIdx]!,
          answer: item.answer,
          updatedAt: now,
        };
      } else {
        nextAnswers.unshift({
          id: `ans_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          questionKey: item.questionKey,
          question: item.question,
          answer: item.answer,
          fieldType: item.fieldType,
          source: 'ai',
          updatedAt: now,
        });
      }
    }

    const nextPending = [...st.pending];
    for (const p of params.pending) {
      if (nextAnswers.some((a) => a.questionKey === p.questionKey && a.source !== 'ai')) continue;
      const alreadyPending = nextPending.some((existing) => existing.questionKey === p.questionKey);
      if (!alreadyPending) {
        nextPending.unshift({
          id: `pend_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          questionKey: p.questionKey,
          question: p.question,
          fieldType: p.fieldType,
          options: p.options,
          jobId: params.jobId,
          jobTitle: params.jobTitle,
          company: params.company,
          reason: p.reason,
          askedAt: now,
        });
      }
    }

    const prevAi = st.run.aiStats;
    return {
      ...st,
      answers: nextAnswers.slice(0, 500),
      pending: nextPending.slice(0, 200),
      run: {
        ...st.run,
        aiStats: {
          calls: prevAi.calls + params.aiStatsDelta.calls,
          questionsSent: prevAi.questionsSent + params.aiStatsDelta.questionsSent,
          answered: prevAi.answered + params.aiStatsDelta.answered,
          unknown: prevAi.unknown + params.aiStatsDelta.unknown,
          errors: prevAi.errors + params.aiStatsDelta.errors,
          lastModel: params.aiStatsDelta.lastModel ?? prevAi.lastModel,
          lastError: params.aiStatsDelta.lastError ?? prevAi.lastError,
          lastMs: params.aiStatsDelta.lastMs ?? prevAi.lastMs,
        },
      },
    };
  });
}

async function processSingleJob(
  tabId: number,
  jobId: string,
  cardTitle: string,
  cardCompany: string,
  cardWorkMode: WorkMode | null,
): Promise<{
  outcome: JobOutcomeKind;
  pauseSec: number;
}> {
  const st0 = await loadState();
  await updateState((st) => ({
    ...st,
    run: {
      ...st.run,
      counts: { ...st.run.counts, opened: st.run.counts.opened + 1 },
      currentJob: { jobId, title: cardTitle, company: cardCompany, stepInfo: 'Abrindo vaga...' },
    },
  }));

  await addDiary(`Abrindo vaga ${jobId}: "${cardTitle}" (${cardCompany || 'empresa'})`);

  const cleared = await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
  if (cleared.ok && cleared.data && !cleared.data.closed) {
    await addDiary('Aviso: ficou um diálogo aberto no LinkedIn que não consegui fechar; vou tentar de novo antes de abrir o formulário.');
  }

  const openRes = await sendToLinkedIn(tabId, { type: 'OPEN_CARD', jobId });
  if (!openRes.ok || !openRes.data) {
    await addDiary(`Falha ao abrir cartão da vaga ${jobId}: ${openRes.error ?? 'sem resposta'}`);
    return { outcome: 'failed', pauseSec: st0.settings.pauseAfterSkipSec };
  }

  const openJob = openRes.data.openJob;
  const title = openJob.title || cardTitle;
  const company = openJob.company || cardCompany;

  if (openJob.jobId !== jobId) {
    await addDiary(`Painel não carregou a vaga ${jobId} a tempo (mostrou ${openJob.jobId ?? 'vazio'}) — pulando.`);
    await recordJobOutcome({
      jobId,
      title,
      company,
      outcome: 'failed',
      detail: 'Painel do LinkedIn demorou para carregar a vaga',
      at: new Date().toISOString(),
    });
    return { outcome: 'failed', pauseSec: st0.settings.pauseAfterSkipSec };
  }

  if (openJob.alreadyApplied) {
    await addDiary(`Vaga "${title}" já tinha candidatura enviada — pulando.`);
    await recordJobOutcome({
      jobId,
      title,
      company,
      outcome: 'skipped_already_applied',
      detail: 'Já candidatado anteriormente',
      at: new Date().toISOString(),
    });
    return { outcome: 'skipped_already_applied', pauseSec: st0.settings.pauseAfterSkipSec };
  }

  if (!cardWorkMode && openJob.workMode && !st0.settings.acceptedWorkModes.includes(openJob.workMode)) {
    const modeName = workModeLabel(openJob.workMode);
    await addDiary(`Vaga "${title}" é ${modeName} (fora do seu filtro) — pulando.`);
    await recordJobOutcome({
      jobId,
      title,
      company,
      outcome: 'skipped_work_mode',
      detail: `Modalidade ${modeName}`,
      at: new Date().toISOString(),
    });
    return { outcome: 'skipped_work_mode', pauseSec: st0.settings.pauseAfterSkipSec };
  }

  if (!openJob.hasEasyApply) {
    // Só diz "site externo" quando o botão de site externo está na tela; senão, diz o que de fato viu.
    await addDiary(
      openJob.hasExternalApply
        ? `Vaga "${title}" é de site externo: a candidatura é feita fora do LinkedIn, e a extensão só faz Candidatura simplificada — pulando.`
        : `Vaga "${title}": o botão de Candidatura simplificada não apareceu no painel — pulando. (Topo da vaga: "${openJob.descriptionSnippet.slice(0, 120)}")`,
    );
    await recordJobOutcome({
      jobId,
      title,
      company,
      outcome: 'skipped_no_easy_apply',
      detail: openJob.hasExternalApply ? 'Sem Candidatura simplificada (site externo)' : 'Botão de Candidatura simplificada não apareceu',
      at: new Date().toISOString(),
    });
    return { outcome: 'skipped_no_easy_apply', pauseSec: st0.settings.pauseAfterSkipSec };
  }

  const startRes = await sendToLinkedIn(tabId, { type: 'CLICK_EASY_APPLY', jobId });
  if (!startRes.ok || !startRes.data || (startRes.data.outcome !== 'opened' && startRes.data.outcome !== 'already_open')) {
    const reason = startRes.data?.outcome ?? startRes.error ?? 'desconhecido';
    await addDiary(
      reason === 'blocked_by_dialog'
        ? `Não abri o formulário da vaga "${title}": o formulário de outra vaga ficou aberto e não fechou. Feche-o à mão no LinkedIn (X e depois Descartar).`
        : `Não abriu o formulário da vaga "${title}" (${reason}) — pulando.`,
    );
    const kind: JobOutcomeKind =
      reason === 'already_applied' ? 'skipped_already_applied' : reason === 'blocked_by_dialog' || reason === 'timeout' ? 'failed' : 'skipped_no_easy_apply';
    await recordJobOutcome({
      jobId,
      title,
      company,
      outcome: kind,
      detail: `Botão não abriu formulário (${reason})`,
      at: new Date().toISOString(),
    });
    return { outcome: kind, pauseSec: st0.settings.pauseAfterSkipSec };
  }

  await addDiary(`Formulário aberto para "${title}" (${company}).`);

  const todayIso = new Date().toISOString().slice(0, 10);

  for (let stepIdx = 1; stepIdx <= MAX_STEPS_PER_JOB; stepIdx += 1) {
    if ((await waitPauseOrStop(20)) === 'stop') {
      await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
      return { outcome: 'failed', pauseSec: 0 };
    }

    const stepRes = await sendToLinkedIn(tabId, { type: 'READ_FORM_STEP' });
    if (!stepRes.ok || !stepRes.data || !stepRes.data.step.modalOpen) {
      await addDiary(`Modal fechou antes do fim na etapa ${stepIdx}.`);
      await recordJobOutcome({
        jobId,
        title,
        company,
        outcome: 'failed',
        detail: 'Formulário fechou inesperadamente',
        at: new Date().toISOString(),
      });
      return { outcome: 'failed', pauseSec: st0.settings.pauseAfterSkipSec };
    }

    let step = stepRes.data.step;
    const stepLabel = [step.stepTitle, step.progressText].filter(Boolean).join(' · ') || `Etapa ${stepIdx}`;
    if (stepIdx === 1 && step.modalTitle) await addDiary(`Cabeçalho do formulário: "${step.modalTitle}".`);

    await updateState((st) => ({
      ...st,
      run: {
        ...st.run,
        currentJob: { jobId, title, company, stepInfo: stepLabel },
      },
    }));

    await addDiary(
      `Lendo ${stepLabel}: ${step.fields.length} campo(s)${step.hasResumeCards ? ', currículo presente' : ''}, botão "${step.buttonLabel || step.buttonKind}".`,
    );

    for (let retry = 0; retry < 2; retry += 1) {
      const freshState = await loadState();
      const effectiveKnowledge = {
        ...freshState.knowledge,
        acceptedWorkModes: freshState.settings.acceptedWorkModes,
      };
      const solved = await solveFormStep({
        step,
        knowledge: effectiveKnowledge,
        resumeText: freshState.resume?.text ?? '',
        answers: freshState.answers,
        apiKey: freshState.ai.apiKey,
        preferredModel: freshState.ai.preferredModel,
        discoveredModels: freshState.ai.discoveredModels,
        userPickedModel: freshState.ai.userPickedModel,
        unfollowCompany: freshState.settings.unfollowCompany,
        todayIso,
        onAiCall: async (count) => {
          await updateState((st) => ({
            ...st,
            run: { ...st.run, currentJob: { jobId, title, company, stepInfo: `IA respondendo ${count} pergunta(s)...` } },
          }));
        },
      });

      if (solved.aiCallMade) {
        const secs = ((solved.aiElapsedMs ?? 0) / 1000).toFixed(1);
        const tries = solved.aiAttempts ? ` [${solved.aiAttempts}]` : '';
        await addDiary(
          solved.aiError
            ? `IA falhou nesta etapa depois de ${secs}s: ${solved.aiError}${tries}`
            : `IA respondeu em ${secs}s${tries}: ${solved.aiQuestionsSent} pergunta(s) enviada(s), ${solved.aiAnswered} respondida(s), ${solved.aiUnknown} sem certeza.`,
        );
      }

      for (const tr of solved.traces) {
        if (tr.source !== 'prefilled') {
          await addDiary(`  • Campo "${tr.label}" -> [${tr.source}] ${tr.valueSummary}`);
        }
      }

      await saveAiLearnedAndPending({
        learned: solved.learnedFromAi,
        pending: solved.missingRequired,
        jobId,
        jobTitle: title,
        company,
        aiStatsDelta: {
          calls: solved.aiCallMade ? 1 : 0,
          questionsSent: solved.aiQuestionsSent,
          answered: solved.aiAnswered,
          unknown: solved.aiUnknown,
          errors: solved.aiError ? 1 : 0,
          lastModel: solved.aiModelUsed,
          lastError: solved.aiError,
          lastMs: solved.aiCallMade ? solved.aiElapsedMs : undefined,
        },
      });

      if (solved.instructions.length > 0 || (step.hasResumeCards && !step.resumeSelected)) {
        await sendToLinkedIn(tabId, { type: 'APPLY_FIELDS', instructions: solved.instructions });
      }

      if (solved.missingRequired.length > 0) {
        const missingNames = solved.missingRequired.map((m) => `"${m.question}"`).join(', ');
        await addDiary(`Faltou resposta obrigatória (${missingNames}) -> salva em "Responda 1 vez". Descartando rascunho.`);
        await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
        await recordJobOutcome({
          jobId,
          title,
          company,
          outcome: 'needs_answer',
          detail: `Faltou responder: ${solved.missingRequired.map((m) => m.question).join('; ')}`,
          at: new Date().toISOString(),
        });
        return { outcome: 'needs_answer', pauseSec: freshState.settings.pauseAfterSkipSec };
      }

      if (step.buttonKind === 'submit') {
        if (freshState.settings.simulateOnly) {
          await addDiary(`Modo simulação: chegou até "Enviar candidatura" sem erros! Descartando sem enviar.`);
          await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
          await recordJobOutcome({
            jobId,
            title,
            company,
            outcome: 'simulated',
            detail: 'Preenchida até a revisão (modo simulação)',
            at: new Date().toISOString(),
          });
          return { outcome: 'simulated', pauseSec: freshState.settings.pauseAfterSkipSec };
        }

        await addDiary(`Clicando em "${step.buttonLabel || 'Enviar candidatura'}"...`);
        const subRes = await sendToLinkedIn(tabId, {
          type: 'CLICK_STEP_BUTTON',
          kind: 'submit',
          fromSignature: step.signature,
        });

        if (subRes.ok && subRes.data?.outcome === 'submitted') {
          await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'post_apply' });
          await addDiary(`CANDIDATURA ENVIADA COM SUCESSO: "${title}" (${company})!`);
          await recordJobOutcome({
            jobId,
            title,
            company,
            outcome: 'applied',
            detail: 'Candidatura enviada!',
            at: new Date().toISOString(),
          });
          return { outcome: 'applied', pauseSec: freshState.settings.pauseAfterSubmitSec };
        }

        const errs = subRes.data?.pageErrors ?? [];
        await addDiary(`Envio recusado na revisão (${errs.join('; ') || 'sem detalhe'}) — descartando.`);
        await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
        await recordJobOutcome({
          jobId,
          title,
          company,
          outcome: 'failed',
          detail: errs.join('; ') || 'Não confirmou envio na revisão',
          at: new Date().toISOString(),
        });
        return { outcome: 'failed', pauseSec: freshState.settings.pauseAfterSkipSec };
      }

      if (step.buttonKind === 'none') {
        await addDiary(`Nenhum botão de avanço apareceu na etapa depois de esperar 8 s — descartando. O diálogo mostra: ${step.diag ?? 'sem detalhe'}`);
        await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
        await recordJobOutcome({
          jobId,
          title,
          company,
          outcome: 'failed',
          detail: 'Botão de avanço não reconhecido',
          at: new Date().toISOString(),
        });
        return { outcome: 'failed', pauseSec: freshState.settings.pauseAfterSkipSec };
      }

      const navRes = await sendToLinkedIn(tabId, {
        type: 'CLICK_STEP_BUTTON',
        kind: step.buttonKind,
        fromSignature: step.signature,
      });

      if (navRes.ok && navRes.data?.outcome === 'advanced') {
        break;
      }

      if (navRes.ok && navRes.data?.outcome === 'validation_error') {
        const errs = navRes.data.pageErrors.join(' | ');
        if (retry === 0) {
          await addDiary(`Página pediu correção (${errs}) — tentando corrigir automaticamente com a IA...`);
          step = navRes.data.step;
          continue;
        }

        const erroredFields = navRes.data.step.fields.filter((f) => f.errorText);
        const toSave = (erroredFields.length > 0 ? erroredFields : navRes.data.step.fields.filter((f) => f.required)).map((f) => ({
          questionKey: f.questionKey || makeQuestionKey(f.label, f.type),
          question: f.label,
          fieldType: f.type,
          options: f.options.map((o) => o.label),
          reason: `LinkedIn recusou com: ${f.errorText ?? errs}`,
        }));

        await saveAiLearnedAndPending({
          learned: [],
          pending: toSave,
          jobId,
          jobTitle: title,
          company,
          aiStatsDelta: { calls: 0, questionsSent: 0, answered: 0, unknown: 0, errors: 0 },
        });

        await addDiary(`Validação continuou recusando (${errs}) -> salva em "Responda 1 vez". Descartando rascunho.`);
        await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
        await recordJobOutcome({
          jobId,
          title,
          company,
          outcome: 'needs_answer',
          detail: `Validação recusou: ${errs}`,
          at: new Date().toISOString(),
        });
        return { outcome: 'needs_answer', pauseSec: freshState.settings.pauseAfterSkipSec };
      }

      await addDiary(`Etapa travou ao clicar em "${step.buttonLabel}" — descartando rascunho.`);
      await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
      await recordJobOutcome({
        jobId,
        title,
        company,
        outcome: 'failed',
        detail: `Não avançou na etapa "${stepLabel}"`,
        at: new Date().toISOString(),
      });
      return { outcome: 'failed', pauseSec: freshState.settings.pauseAfterSkipSec };
    }
  }

  await addDiary(`Limite de ${MAX_STEPS_PER_JOB} etapas atingido na vaga "${title}" — descartando.`);
  await sendToLinkedIn(tabId, { type: 'DISMISS_ALL_DIALOGS', mode: 'discard' });
  await recordJobOutcome({
    jobId,
    title,
    company,
    outcome: 'failed',
    detail: 'Mais de 20 etapas no formulário',
    at: new Date().toISOString(),
  });
  return { outcome: 'failed', pauseSec: 0.4 };
}

async function runBatchLoop(preferredTabId?: number): Promise<void> {
  runStartEpoch = Date.now();
  controlSignal = 'run';

  const initial = await loadState();
  const maxJobs = Math.max(1, Math.min(200, initial.settings.maxJobs || 20));

  await updateState((st) => ({
    ...st,
    run: {
      ...emptyBatchRunState(),
      status: 'running',
      startedAt: new Date().toISOString(),
      diary: [],
    },
  }));

  await addDiary(
    `Iniciando rodada (meta: até ${maxJobs} vagas · modo: ${initial.settings.simulateOnly ? 'SIMULAÇÃO SEM ENVIAR' : 'ENVIO REAL'} · modalidades: ${initial.settings.acceptedWorkModes.map(workModeLabel).join(', ')}).`,
  );

  if (!initial.ai.apiKey.trim()) {
    await addDiary('Aviso: nenhuma chave da IA configurada no Passo 2. Só campos da Ficha e Respostas Guardadas serão preenchidos.');
  }

  const searchUrl = buildLinkedInSearchUrl(initial.knowledge.targetRole, initial.settings.acceptedWorkModes);
  let tab = await findLinkedInJobsTab(preferredTabId);
  if (!tab?.id) {
    await addDiary('Nenhuma aba do LinkedIn aberta: abrindo a busca de vagas com Candidatura simplificada.');
    tab = await chrome.tabs.create({ url: searchUrl, active: true });
    if (tab.id !== undefined) await waitTabComplete(tab.id, 20_000);
  }
  if (!tab?.id) {
    await addDiary('FIM: não consegui abrir uma aba do LinkedIn.');
    await updateState((st) => ({
      ...st,
      run: {
        ...st.run,
        status: 'finished',
        finishedAt: new Date().toISOString(),
        finishReason: 'Não consegui abrir o LinkedIn. Abra a busca de vagas e clique em Começar.',
      },
    }));
    return;
  }

  const tabId = tab.id;
  // A aba precisa estar na frente: numa aba escondida o Chrome atrasa a página e a lista de vagas não carrega.
  try {
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // ignore
  }
  await addDiary(`Conectado à aba do LinkedIn: ${tab.url ?? `id=${tabId}`}`);

  // Se a aba não mostra uma lista de vagas, a extensão abre a busca sozinha (antes ela só avisava e parava).
  const hasCards = (data: ListData): boolean => data.cards.length > 0;
  // Fora da área de vagas (o feed, um perfil) não há o que esperar: abre a busca na hora.
  let firstList = await readCardsWaiting(tabId, 6_000, (data) => hasCards(data) || pageKindOf(data) !== 'list');
  if (!firstList || pageKindOf(firstList) !== 'list' || firstList.cards.length === 0) {
    await addDiary(
      firstList && pageKindOf(firstList) === 'job'
        ? 'Esta aba mostra uma vaga só, não uma lista. Abrindo a busca de vagas com Candidatura simplificada...'
        : `Esta aba não mostra uma lista de vagas (${firstList?.diag ?? 'sem resposta da página'}). Abrindo a busca de vagas com Candidatura simplificada...`,
    );
    try {
      await chrome.tabs.update(tabId, { url: searchUrl, active: true });
    } catch {
      // ignore
    }
    await sleepMs(800);
    await waitTabComplete(tabId, 20_000);
    firstList = await readCardsWaiting(tabId, 15_000, hasCards);
  }

  const processedJobIds = new Set<string>();
  let targetSubmissionsReached = 0;
  let loggedInitialCards = false;
  let mostCardsOnThisPage = 0;
  let awaitingNewPage = false;
  // A lista em que o envio está trabalhando. Depois de descartar um formulário, o LinkedIn às vezes tira a aba da
  // lista (volta para a página anterior, por exemplo o feed); com o endereço guardado dá para voltar e continuar.
  let listUrl: string | null = firstList && pageKindOf(firstList) === 'list' && firstList.cards.length > 0 ? listUrlOf(firstList.url) : null;
  let returnsToList = 0;

  while (targetSubmissionsReached < maxJobs && processedJobIds.size < maxJobs * 5) {
    if ((await waitPauseOrStop(20)) === 'stop') {
      await addDiary('Envio interrompido a seu pedido.');
      break;
    }

    // A lista se redesenha depois de fechar um formulário: espera ela voltar ao tamanho que já teve nesta página
    // (ou mostrar uma vaga ainda não vista) antes de concluir que acabou.
    // Logo depois de trocar de página de resultados, a lista antiga ainda fica um instante na tela: espera as vagas novas.
    const wanted = mostCardsOnThisPage;
    const freshOnly = awaitingNewPage;
    awaitingNewPage = false;
    const listData = await readCardsWaiting(tabId, freshOnly ? 8_000 : processedJobIds.size === 0 ? 1_000 : 5_000, (data) => {
      if (pageKindOf(data) === 'other') return true; // saiu da área de vagas: não há o que esperar
      if (data.cards.length === 0) return false;
      const hasUnseen = data.cards.some((c) => !processedJobIds.has(c.jobId));
      return freshOnly ? hasUnseen : hasUnseen || data.cards.length >= wanted;
    });
    if (!listData) {
      await addDiary('Erro ao ler a lista de vagas: a página do LinkedIn não respondeu. Dê F5 nela e clique em Começar.');
      break;
    }

    // A aba saiu da lista em que o envio estava (o LinkedIn faz isso às vezes ao descartar um formulário): volta e continua.
    const kind = pageKindOf(listData);
    const leftList = listUrl !== null && !isStillOnList(listUrl, listData, processedJobIds);
    if (leftList && listUrl !== null && returnsToList < MAX_RETURNS_TO_LIST) {
      returnsToList += 1;
      await addDiary(`A página saiu da lista de vagas (${listData.diag}). Voltando para a lista para continuar...`);
      try {
        await chrome.tabs.update(tabId, { url: listUrl, active: true });
      } catch {
        // ignore
      }
      await sleepMs(800);
      await waitTabComplete(tabId, 20_000);
      mostCardsOnThisPage = 0;
      awaitingNewPage = false;
      await readCardsWaiting(tabId, 15_000, (data) => pageKindOf(data) === 'list' && data.cards.length > 0);
      continue;
    }
    if (listUrl === null && kind === 'list' && listData.cards.length > 0) listUrl = listUrlOf(listData.url);

    if (listData.cards.length === 0) {
      await addDiary(`Nenhuma vaga encontrada nesta página. Diagnóstico: ${listData.diag}`);
      await addDiary('Confira se você está logado no LinkedIn e se a busca tem resultados; depois clique em Começar.');
      break;
    }
    mostCardsOnThisPage = Math.max(mostCardsOnThisPage, listData.cards.length);

    if (!loggedInitialCards) {
      loggedInitialCards = true;
      await addDiary(`Lista lida com sucesso: ${listData.cards.length} vaga(s) visíveis nesta tela.`);
    }

    const nextCard = listData.cards.find((c) => !processedJobIds.has(c.jobId));

    if (!nextCard) {
      await addDiary('Rolando a lista para carregar mais vagas...');
      await sendToLinkedIn(tabId, { type: 'SCROLL_NEXT_CARDS' });
      const recheck = await sendToLinkedIn(tabId, { type: 'LIST_CARDS' });
      const hasUnseenAfterScroll = recheck.data?.cards.some((c) => !processedJobIds.has(c.jobId)) ?? false;

      if (hasUnseenAfterScroll) continue;

      await addDiary('Tentando avançar para a próxima página de resultados...');
      const pageRes = await sendToLinkedIn(tabId, { type: 'GO_NEXT_RESULTS_PAGE' });
      if (pageRes.ok && pageRes.data?.navigated) {
        mostCardsOnThisPage = 0;
        awaitingNewPage = true;
        continue;
      }

      await addDiary('FIM: Todas as vagas encontradas na busca foram percorridas.');
      break;
    }

    processedJobIds.add(nextCard.jobId);

    if (nextCard.alreadyAppliedOnCard) {
      await addDiary(`Cartão "${nextCard.title}" já marca candidatura enviada — pulando.`);
      await recordJobOutcome({
        jobId: nextCard.jobId,
        title: nextCard.title,
        company: nextCard.company,
        outcome: 'skipped_already_applied',
        detail: 'Já candidatado no cartão',
        at: new Date().toISOString(),
      });
      continue;
    }

    if (nextCard.workMode) {
      const accepted = (await loadState()).settings.acceptedWorkModes;
      if (!accepted.includes(nextCard.workMode)) {
        const modeName = workModeLabel(nextCard.workMode);
        await addDiary(`Cartão "${nextCard.title}" é ${modeName} (fora do seu filtro) — pulando sem abrir.`);
        await recordJobOutcome({
          jobId: nextCard.jobId,
          title: nextCard.title,
          company: nextCard.company,
          outcome: 'skipped_work_mode',
          detail: `Modalidade ${modeName}`,
          at: new Date().toISOString(),
        });
        continue;
      }
    }

    const result = await processSingleJob(tabId, nextCard.jobId, nextCard.title, nextCard.company, nextCard.workMode ?? null);
    if (result.outcome === 'applied' || result.outcome === 'simulated') {
      targetSubmissionsReached += 1;
    }

    if ((controlSignal as string) === 'stop') {
      await addDiary('Envio interrompido a seu pedido.');
      break;
    }

    if (targetSubmissionsReached >= maxJobs) {
      await addDiary(`Meta atingida: ${targetSubmissionsReached} candidatura(s) concluída(s)!`);
      break;
    }

    if (result.pauseSec > 0) {
      if (result.pauseSec >= 1) {
        await updateState((st) => ({
          ...st,
          run: {
            ...st.run,
            currentJob: {
              jobId: nextCard.jobId,
              title: nextCard.title,
              company: nextCard.company,
              stepInfo: `Próxima vaga em ${result.pauseSec}s...`,
            },
          },
        }));
      }
      if ((await waitPauseOrStop(result.pauseSec * 1000)) === 'stop') {
        await addDiary('Envio interrompido a seu pedido.');
        break;
      }
    }
  }

  const endState = await loadState();
  const summary = `Concluído: ${endState.run.counts.applied} enviada(s), ${endState.run.counts.simulated} simulada(s), ${endState.run.counts.needsAnswer} precisam de resposta, ${endState.run.counts.skipped} pulada(s).`;
  await addDiary(`FIM DA RODADA — ${summary}`);

  await updateState((st) => ({
    ...st,
    run: {
      ...st.run,
      status: 'finished',
      finishedAt: new Date().toISOString(),
      currentJob: undefined,
      finishReason: summary,
    },
  }));
}

export function startBatchRunner(preferredTabId?: number): { started: boolean; error?: string } {
  if (activeLoopPromise !== null) {
    return { started: false, error: 'Já existe um envio em andamento.' };
  }
  startKeepAlive();
  activeLoopPromise = runBatchLoop(preferredTabId)
    .catch(async (err) => {
      await addDiary(`Erro inesperado no envio: ${err instanceof Error ? err.message : String(err)}`);
      await updateState((st) => ({
        ...st,
        run: {
          ...st.run,
          status: 'finished',
          finishedAt: new Date().toISOString(),
          currentJob: undefined,
          finishReason: 'Interrompido por erro inesperado (veja o Diário).',
        },
      }));
    })
    .finally(() => {
      stopKeepAlive();
      activeLoopPromise = null;
    });
  return { started: true };
}

/**
 * Chamado quando o serviço da extensão acorda. Se o estado guardado diz "rodando" mas não há envio em andamento,
 * o serviço foi desligado (ou a extensão recarregada) no meio: a tela ficava em "Rodando" para sempre. Fecha o envio
 * com o motivo escrito, para a pessoa poder começar de novo.
 */
export async function recoverInterruptedRun(): Promise<void> {
  if (activeLoopPromise !== null) return;
  const st = await loadState();
  if (st.run.status !== 'running' && st.run.status !== 'paused' && st.run.status !== 'stopping') return;
  const reason = 'Interrompido: o Chrome desligou a extensão no meio do envio (ou ela foi recarregada). Clique em Começar de novo.';
  await updateState((cur) => ({
    ...cur,
    run: {
      ...cur.run,
      status: 'finished',
      finishedAt: new Date().toISOString(),
      currentJob: undefined,
      finishReason: reason,
      diary: [...cur.run.diary, `[fim] ${reason}`].slice(-MAX_DIARY_LINES),
    },
  }));
}

export async function pauseBatchRunner(): Promise<void> {
  if (!activeLoopPromise) return;
  controlSignal = 'pause';
  await addDiary('Envio pausado.');
  await updateState((st) => ({
    ...st,
    run: { ...st.run, status: 'paused' },
  }));
}

export async function resumeBatchRunner(): Promise<void> {
  if (!activeLoopPromise) return;
  controlSignal = 'run';
  await addDiary('Envio retomado.');
  await updateState((st) => ({
    ...st,
    run: { ...st.run, status: 'running' },
  }));
}

export async function stopBatchRunner(): Promise<void> {
  controlSignal = 'stop';
  if (activeLoopPromise) {
    await updateState((st) => ({ ...st, run: { ...st.run, status: 'stopping' } }));
    return;
  }
  await updateState((st) => ({
    ...st,
    run: {
      ...st.run,
      status: 'finished',
      finishedAt: st.run.finishedAt ?? new Date().toISOString(),
      currentJob: undefined,
      finishReason: st.run.finishReason ?? 'Parado a seu pedido.',
    },
  }));
}
