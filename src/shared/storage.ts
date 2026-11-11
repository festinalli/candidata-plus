import type { AiConfig, AppState, BatchRunState, KnowledgeBase, RunSettings } from './types.ts';

export const STORAGE_KEY = 'candidata_plus_v2_state';
/** O PDF do currículo fica numa chave só dele. Dentro do estado, ele era lido e regravado (até 3 MB) a cada passo do envio. */
export const RESUME_PDF_KEY = 'candidata_plus_v2_resume_pdf';

export async function loadResumePdf(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get([RESUME_PDF_KEY, STORAGE_KEY]);
  const own = stored[RESUME_PDF_KEY];
  if (typeof own === 'string' && own !== '') return own;
  // Estado antigo, ainda com o PDF dentro.
  const legacy = (stored[STORAGE_KEY] as Partial<AppState> | undefined)?.resume?.pdfBase64;
  return typeof legacy === 'string' && legacy !== '' ? legacy : undefined;
}

export async function saveResumePdf(pdfBase64: string | undefined): Promise<void> {
  if (pdfBase64) await chrome.storage.local.set({ [RESUME_PDF_KEY]: pdfBase64 });
  else await chrome.storage.local.remove(RESUME_PDF_KEY);
}

export function emptyKnowledgeBase(): KnowledgeBase {
  return {
    fullName: '',
    email: '',
    phone: '',
    city: '',
    state: '',
    country: 'Brasil',
    linkedinUrl: '',
    portfolioUrl: '',
    targetRole: '',
    seniority: '',
    totalYearsExperience: 0,
    salaryExpectation: '',
    currentSalary: '',
    currency: 'BRL',
    noticePeriodDays: 'Imediato',
    workAuthorizationBrazil: true,
    needsVisaSponsorship: false,
    willingToRelocate: false,
    acceptedWorkModes: ['remote', 'hybrid', 'onsite'],
    skills: [],
    experiences: [],
    languages: [],
    education: [],
    certifications: [],
    summary: '',
    extraFacts: '',
  };
}

export function defaultAiConfig(): AiConfig {
  return {
    apiKey: '',
    preferredModel: '',
    discoveredModels: [],
  };
}

export function defaultRunSettings(): RunSettings {
  return {
    maxJobs: 20,
    simulateOnly: false,
    unfollowCompany: true,
    acceptedWorkModes: ['remote', 'hybrid', 'onsite'],
    pauseAfterSubmitSec: 3,
    pauseAfterSkipSec: 0.4,
  };
}

export function emptyBatchRunState(): BatchRunState {
  return {
    status: 'idle',
    counts: {
      opened: 0,
      applied: 0,
      simulated: 0,
      needsAnswer: 0,
      skipped: 0,
      failed: 0,
    },
    aiStats: {
      calls: 0,
      questionsSent: 0,
      answered: 0,
      unknown: 0,
      errors: 0,
    },
    jobs: [],
    diary: [],
  };
}

export function defaultAppState(): AppState {
  return {
    resume: null,
    knowledge: emptyKnowledgeBase(),
    ai: defaultAiConfig(),
    answers: [],
    pending: [],
    settings: defaultRunSettings(),
    run: emptyBatchRunState(),
  };
}

let writeQueue: Promise<unknown> = Promise.resolve();

export async function loadState(): Promise<AppState> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = stored[STORAGE_KEY] as Partial<AppState> | undefined;
  const base = defaultAppState();
  if (!raw || typeof raw !== 'object') return base;

  const mergedSettings: RunSettings = { ...base.settings, ...(raw.settings ?? {}) };
  // Migra os padrões lentos antigos (8s / 2s) para os novos mais ágeis (3s / 0.4s)
  if (raw.settings?.pauseAfterSubmitSec === 8 && raw.settings?.pauseAfterSkipSec === 2) {
    mergedSettings.pauseAfterSubmitSec = 3;
    mergedSettings.pauseAfterSkipSec = 0.4;
  }

  // O PDF não viaja com o estado (ver RESUME_PDF_KEY).
  const resume = raw.resume ? { ...raw.resume, pdfBase64: undefined } : base.resume;

  return {
    resume,
    knowledge: { ...base.knowledge, ...(raw.knowledge ?? {}) },
    ai: { ...base.ai, ...(raw.ai ?? {}) },
    answers: Array.isArray(raw.answers) ? raw.answers : [],
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    settings: mergedSettings,
    run: {
      ...base.run,
      ...(raw.run ?? {}),
      counts: { ...base.run.counts, ...(raw.run?.counts ?? {}) },
      aiStats: { ...base.run.aiStats, ...(raw.run?.aiStats ?? {}) },
      jobs: Array.isArray(raw.run?.jobs) ? raw.run.jobs : [],
      diary: Array.isArray(raw.run?.diary) ? raw.run.diary : [],
    },
  };
}

export function updateState(mutator: (current: AppState) => AppState | Promise<AppState>): Promise<AppState> {
  const nextOp = writeQueue.then(async () => {
    // Estado antigo com o PDF dentro: passa o PDF para a chave dele antes da primeira gravação sem ele.
    const stored = await chrome.storage.local.get([STORAGE_KEY, RESUME_PDF_KEY]);
    const legacyPdf = (stored[STORAGE_KEY] as Partial<AppState> | undefined)?.resume?.pdfBase64;
    if (typeof legacyPdf === 'string' && legacyPdf !== '' && typeof stored[RESUME_PDF_KEY] !== 'string') {
      await chrome.storage.local.set({ [RESUME_PDF_KEY]: legacyPdf });
    }

    const current = await loadState();
    const mutated = await mutator(current);
    const updated: AppState = mutated.resume?.pdfBase64 !== undefined ? { ...mutated, resume: { ...mutated.resume, pdfBase64: undefined } } : mutated;
    await chrome.storage.local.set({ [STORAGE_KEY]: updated });
    return updated;
  });
  writeQueue = nextOp.catch(() => undefined);
  return nextOp;
}
