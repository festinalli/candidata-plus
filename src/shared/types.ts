export type WorkMode = 'remote' | 'hybrid' | 'onsite';

export type FormFieldType = 'text' | 'number' | 'textarea' | 'radio' | 'select' | 'combobox' | 'checkbox';

export interface SkillFact {
  name: string;
  years: number;
}

export interface ExperienceFact {
  role: string;
  company: string;
  period: string;
  years: number;
  summary: string;
}

export interface LanguageFact {
  language: string;
  level: string;
}

export interface EducationFact {
  degree: string;
  field: string;
  institution: string;
  status: string;
}

export interface KnowledgeBase {
  fullName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  country: string;
  linkedinUrl: string;
  portfolioUrl: string;
  targetRole: string;
  seniority: string;
  totalYearsExperience: number;
  salaryExpectation: string;
  currentSalary: string;
  currency: string;
  noticePeriodDays: string;
  workAuthorizationBrazil: boolean;
  needsVisaSponsorship: boolean;
  willingToRelocate: boolean;
  acceptedWorkModes: WorkMode[];
  skills: SkillFact[];
  experiences: ExperienceFact[];
  languages: LanguageFact[];
  education: EducationFact[];
  certifications: string[];
  summary: string;
  extraFacts: string;
  generatedByAiAt?: string;
}

export interface ResumeData {
  fileName: string;
  text: string;
  pdfBase64?: string;
  updatedAt: string;
}

export interface AiConfig {
  apiKey: string;
  preferredModel: string;
  /** true só quando a pessoa escolheu o modelo na lista do Passo 2; sem isso a fila é montada pela velocidade. */
  userPickedModel?: boolean;
  discoveredModels: string[];
  lastTestedAt?: string;
  lastTestOk?: boolean;
  lastTestSummary?: string;
}

export interface AnswerEntry {
  id: string;
  questionKey: string;
  question: string;
  answer: string;
  fieldType: FormFieldType;
  source: 'user' | 'manual_linkedin' | 'ai';
  updatedAt: string;
}

export interface PendingQuestion {
  id: string;
  questionKey: string;
  question: string;
  fieldType: FormFieldType;
  options: string[];
  jobId: string;
  jobTitle: string;
  company: string;
  reason: string;
  askedAt: string;
}

export interface RunSettings {
  maxJobs: number;
  simulateOnly: boolean;
  unfollowCompany: boolean;
  acceptedWorkModes: WorkMode[];
  pauseAfterSubmitSec: number;
  pauseAfterSkipSec: number;
}

export type JobOutcomeKind =
  | 'applied'
  | 'simulated'
  | 'needs_answer'
  | 'skipped_already_applied'
  | 'skipped_no_easy_apply'
  | 'skipped_work_mode'
  | 'failed';

export interface BatchJobItem {
  jobId: string;
  title: string;
  company: string;
  outcome: JobOutcomeKind;
  detail: string;
  at: string;
}

export interface BatchRunState {
  status: 'idle' | 'running' | 'paused' | 'stopping' | 'finished';
  startedAt?: string;
  finishedAt?: string;
  finishReason?: string;
  currentJob?: {
    jobId: string;
    title: string;
    company: string;
    stepInfo?: string;
  };
  counts: {
    opened: number;
    applied: number;
    simulated: number;
    needsAnswer: number;
    skipped: number;
    failed: number;
  };
  aiStats: {
    calls: number;
    questionsSent: number;
    answered: number;
    unknown: number;
    errors: number;
    lastModel?: string;
    lastError?: string;
    /** Quanto a última chamada à IA levou, em milissegundos. */
    lastMs?: number;
  };
  jobs: BatchJobItem[];
  diary: string[];
}

export interface FormOption {
  id: string;
  label: string;
}

export interface FormFieldSnapshot {
  fieldId: string;
  questionKey: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  currentValue: string;
  checked?: boolean;
  options: FormOption[];
  placeholder?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  errorText?: string;
  isFollowCompany?: boolean;
}

export interface FormStepSnapshot {
  modalOpen: boolean;
  signature: string;
  stepTitle: string;
  progressText: string;
  buttonKind: 'next' | 'review' | 'submit' | 'none';
  buttonLabel: string;
  hasResumeCards: boolean;
  resumeSelected: boolean;
  pageErrors: string[];
  fields: FormFieldSnapshot[];
  /** Só quando nenhum botão de avanço foi reconhecido: o que o diálogo mostra (cabeçalho e botões), para o diário. */
  diag?: string;
  /** O cabeçalho do diálogo ("Candidate-se à empresa X"), para o diário mostrar de que empresa é o formulário aberto. */
  modalTitle?: string;
}

export interface FieldFillInstruction {
  fieldId: string;
  value: string;
  checked?: boolean;
  optionLabel?: string;
}

export interface ListedJobCard {
  jobId: string;
  title: string;
  company: string;
  locationText: string;
  alreadyAppliedOnCard: boolean;
  /** Modalidade escrita no próprio cartão ("(Remoto)", "(Híbrido)", "(Presencial)"), quando há. */
  workMode?: WorkMode | null;
}

export interface OpenJobSnapshot {
  jobId: string | null;
  title: string;
  company: string;
  workMode: WorkMode | null;
  alreadyApplied: boolean;
  hasEasyApply: boolean;
  /** A vaga mostra um botão de candidatura em site externo ("Candidatar-se"). */
  hasExternalApply?: boolean;
  descriptionSnippet: string;
}

export interface AppState {
  resume: ResumeData | null;
  knowledge: KnowledgeBase;
  ai: AiConfig;
  answers: AnswerEntry[];
  pending: PendingQuestion[];
  settings: RunSettings;
  run: BatchRunState;
}
