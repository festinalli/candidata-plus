import type { AnswerEntry, FormStepSnapshot, KnowledgeBase } from '../shared/types.ts';
import type { TestAiQuestionResult } from '../shared/messages.ts';
import { makeQuestionKey } from '../shared/normalize.ts';
import { solveFormStep } from './solver.ts';

/**
 * Roda 4 perguntas reais típicas do LinkedIn contra a Ficha + Currículo + Chave do Google AI Studio
 * para provar toda a cadeia fora do LinkedIn.
 */
export async function runLiveAiSelfTest(params: {
  knowledge: KnowledgeBase;
  resumeText: string;
  answers: readonly AnswerEntry[];
  apiKey: string;
  preferredModel?: string;
  userPickedModel?: boolean;
  discoveredModels?: readonly string[];
  todayIso: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  ok: boolean;
  modelUsed?: string;
  errorPtBr?: string;
  /** Quanto a IA levou para responder as perguntas do teste. */
  elapsedMs?: number;
  results: TestAiQuestionResult[];
}> {
  const firstSkill = params.knowledge.skills[0]?.name || 'sua principal ferramenta de trabalho';
  const sampleQuestions = [
    {
      fieldId: 't1',
      label: `Há quantos anos você já trabalha na área ou usa ${firstSkill}?`,
      type: 'text' as const,
      options: [],
    },
    {
      fieldId: 't2',
      label: 'Você trabalharia em um modelo híbrido?',
      type: 'radio' as const,
      options: [
        { id: 'sim', label: 'Sim' },
        { id: 'nao', label: 'Não' },
      ],
    },
    {
      fieldId: 't3',
      label: 'Qual o seu nível de inglês?',
      type: 'select' as const,
      options: [
        { id: 'basico', label: 'Básico' },
        { id: 'intermediario', label: 'Intermediário' },
        { id: 'avancado', label: 'Avançado' },
        { id: 'fluente', label: 'Fluente' },
      ],
    },
    {
      fieldId: 't4',
      label: 'Conte brevemente sua experiência principal para esta vaga.',
      type: 'textarea' as const,
      options: [],
    },
  ];

  const fakeStep: FormStepSnapshot = {
    modalOpen: true,
    signature: 'self-test',
    stepTitle: 'Teste da IA',
    progressText: '1 de 1',
    buttonKind: 'review',
    buttonLabel: 'Avaliar',
    hasResumeCards: false,
    resumeSelected: true,
    pageErrors: [],
    fields: sampleQuestions.map((q) => ({
      fieldId: q.fieldId,
      questionKey: makeQuestionKey(q.label, q.type),
      label: q.label,
      type: q.type,
      required: true,
      currentValue: '',
      options: q.options,
    })),
  };

  // Forçamos ao menos as perguntas de IA passando banco vazio apenas nas que queremos exercitar na IA
  const outcome = await solveFormStep({
    step: fakeStep,
    knowledge: params.knowledge,
    resumeText: params.resumeText,
    answers: params.answers,
    apiKey: params.apiKey,
    preferredModel: params.preferredModel,
    userPickedModel: params.userPickedModel,
    discoveredModels: params.discoveredModels,
    unfollowCompany: true,
    todayIso: params.todayIso,
    fetchImpl: params.fetchImpl,
  });

  if (outcome.aiError) {
    return {
      ok: false,
      errorPtBr: outcome.aiAttempts ? `${outcome.aiError} [${outcome.aiAttempts}]` : outcome.aiError,
      elapsedMs: outcome.aiElapsedMs,
      results: [],
    };
  }

  const results: TestAiQuestionResult[] = sampleQuestions.map((q) => {
    const inst = outcome.instructions.find((i) => i.fieldId === q.fieldId);
    const trace = outcome.traces.find((t) => t.fieldId === q.fieldId);
    const missing = outcome.missingRequired.find((m) => m.question === q.label);
    if (inst) {
      const sourceLabel =
        trace?.source === 'knowledge'
          ? 'Ficha de Conhecimento'
          : trace?.source === 'bank'
            ? 'Resposta guardada'
            : `IA (${outcome.aiModelUsed ?? 'Gemini'})`;
      return {
        question: q.label,
        answer: inst.optionLabel ?? inst.value,
        status: 'answered',
        reason: `Respondida via ${sourceLabel}`,
      };
    }
    return {
      question: q.label,
      answer: 'Não encontrada no currículo (ficaria em "Responda 1 vez")',
      status: 'unknown',
      reason: missing?.reason ?? 'Fato ausente na ficha/currículo',
    };
  });

  return {
    ok: true,
    modelUsed: outcome.aiModelUsed,
    elapsedMs: outcome.aiElapsedMs,
    results,
  };
}
