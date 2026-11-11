import type {
  AiConfig,
  FieldFillInstruction,
  FormFieldType,
  FormStepSnapshot,
  KnowledgeBase,
  ListedJobCard,
  OpenJobSnapshot,
  RunSettings,
} from './types.ts';

export type PanelToBgMessage =
  | { type: 'SAVE_RESUME'; fileName: string; text: string; pdfBase64?: string }
  | { type: 'BUILD_KNOWLEDGE_FROM_AI' }
  | { type: 'SAVE_KNOWLEDGE'; knowledge: KnowledgeBase }
  | { type: 'SAVE_AND_TEST_AI'; apiKey: string; preferredModel: string }
  | { type: 'TEST_AI_WITH_RESUME' }
  | { type: 'SAVE_SETTINGS'; settings: RunSettings }
  | { type: 'ANSWER_PENDING'; pendingId: string; answer: string }
  | { type: 'DELETE_PENDING'; pendingId: string }
  | { type: 'SAVE_BANK_ANSWER'; question: string; answer: string; fieldType?: FormFieldType }
  | { type: 'DELETE_BANK_ANSWER'; answerId: string }
  | { type: 'OPEN_LINKEDIN_SEARCH' }
  | { type: 'START_BATCH'; preferredTabId?: number }
  | { type: 'PAUSE_BATCH' }
  | { type: 'RESUME_BATCH' }
  | { type: 'STOP_BATCH' }
  | { type: 'CLEAR_DIARY' };

export type ContentToBgMessage =
  | { type: 'OPEN_SIDE_PANEL' }
  | { type: 'MANUAL_FIELD_LEARNED'; question: string; answer: string; fieldType: FormFieldType };

export type BgToContentMessage =
  | { type: 'PING' }
  | { type: 'LIST_CARDS' }
  | { type: 'OPEN_CARD'; jobId: string }
  | { type: 'READ_OPEN_JOB'; expectedJobId: string }
  | { type: 'CLICK_EASY_APPLY'; jobId: string }
  | { type: 'READ_FORM_STEP' }
  | { type: 'APPLY_FIELDS'; instructions: FieldFillInstruction[] }
  | { type: 'CLICK_STEP_BUTTON'; kind: 'next' | 'review' | 'submit'; fromSignature: string }
  | { type: 'DISMISS_ALL_DIALOGS'; mode: 'discard' | 'post_apply' }
  | { type: 'SCROLL_NEXT_CARDS' }
  | { type: 'GO_NEXT_RESULTS_PAGE' };

export interface TestAiQuestionResult {
  question: string;
  answer: string;
  status: 'answered' | 'unknown';
  reason: string;
}

export interface BgResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type ContentRpcResponses = {
  PING: { url: string; ready: boolean };
  LIST_CARDS: {
    cards: ListedJobCard[];
    isSearchPage: boolean;
    /** 'list' = lista de vagas; 'job' = página de uma vaga só; 'other' = fora da área de vagas (feed, perfil...). */
    pageKind?: 'list' | 'job' | 'other';
    url: string;
    diag: string;
  };
  OPEN_CARD: { clicked: boolean; openJob: OpenJobSnapshot };
  READ_OPEN_JOB: { openJob: OpenJobSnapshot };
  CLICK_EASY_APPLY: { outcome: 'opened' | 'already_open' | 'no_easy_apply' | 'already_applied' | 'not_linked' | 'timeout' | 'blocked_by_dialog' };
  READ_FORM_STEP: { step: FormStepSnapshot };
  APPLY_FIELDS: { appliedCount: number; errors: Array<{ fieldId: string; error: string }> };
  CLICK_STEP_BUTTON: { outcome: 'advanced' | 'submitted' | 'validation_error' | 'blocked'; pageErrors: string[]; step: FormStepSnapshot };
  DISMISS_ALL_DIALOGS: { closed: boolean };
  SCROLL_NEXT_CARDS: { countAfterScroll: number };
  GO_NEXT_RESULTS_PAGE: { navigated: boolean };
};

export type { AiConfig };
