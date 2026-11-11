import type {
  AnswerEntry,
  FieldFillInstruction,
  FormFieldSnapshot,
  FormStepSnapshot,
  KnowledgeBase,
  PendingQuestion,
} from '../shared/types.ts';
import {
  expectsNumericAnswer,
  makeQuestionKey,
  matchBestOption,
  normalizeText,
  salaryQuestionKind,
  sameQuestionIgnoringFillers,
  toPureNumberString,
} from '../shared/normalize.ts';
import { callGeminiJson, describeAttempts } from './gemini.ts';
import { redactContact } from './redact.ts';

export interface SolvedFieldTrace {
  fieldId: string;
  label: string;
  source: 'prefilled' | 'bank' | 'knowledge' | 'ai' | 'skipped_optional' | 'missing';
  valueSummary: string;
}

export interface SolveStepOutcome {
  instructions: FieldFillInstruction[];
  missingRequired: Array<Omit<PendingQuestion, 'id' | 'jobId' | 'jobTitle' | 'company' | 'askedAt'>>;
  learnedFromAi: Array<{ questionKey: string; question: string; answer: string; fieldType: FormFieldSnapshot['type'] }>;
  traces: SolvedFieldTrace[];
  aiCallMade: boolean;
  aiQuestionsSent: number;
  aiAnswered: number;
  aiUnknown: number;
  aiModelUsed?: string;
  aiError?: string;
  /** Quanto a chamada à IA levou, somando as tentativas. */
  aiElapsedMs?: number;
  /** As tentativas, modelo a modelo, em uma linha (para o diário). */
  aiAttempts?: string;
}

/** Tipos de campo em que a resposta de uma pergunta de salário é o próprio valor (e não um "sim ou não"). */
function takesSalaryValue(field: FormFieldSnapshot): boolean {
  return field.type === 'text' || field.type === 'number' || field.type === 'textarea' || field.type === 'combobox';
}

function isAlreadySatisfied(field: FormFieldSnapshot): boolean {
  if (field.errorText && field.errorText.trim() !== '') return false;
  if (field.type === 'checkbox') return field.checked === true;
  return field.currentValue.trim() !== '';
}

/**
 * Detecta se a pergunta é sobre modalidade de trabalho (presencial, híbrido, ir ao escritório, deslocamento diário)
 * em português, inglês, espanhol ou chinês — para nunca reaproveitar uma resposta antiga quando o filtro mudar!
 */
export function isWorkModeOrCommuteQuestion(rawLabel: string): boolean {
  const norm = normalizeText(rawLabel);
  if (
    /\b(modelo hibrido|modelo presencial|modelo remoto|home office|trabalharia.*hibrido|trabalharia.*presencial|trabalharia.*remoto|disponibilidade.*presencial|disponibilidade.*hibrido|ir ao escritorio|comparecer ao escritorio|deslocamento.*escritorio|commute|commuting|work on site|work onsite|on site work|hybrid work|hybrid model|office location)\b/.test(
      norm,
    )
  ) {
    return true;
  }
  // Chinês / Mandarim (ex.: 您是否愿意到此工作地点上班？ / 现场办公 / 到岗 / 混合办公)
  if (/(工作地点上班|到岗|现场办公|坐班|线下办公|混合办公|远程办公)/.test(rawLabel)) {
    return true;
  }
  return false;
}

/**
 * Tenta responder pelo Banco de Respostas ("Responda uma vez" + respostas aprendidas).
 */
function matchFromAnswerBank(field: FormFieldSnapshot, bank: readonly AnswerEntry[]): string | null {
  const key = field.questionKey || makeQuestionKey(field.label, field.type);
  const isWorkModeQ = isWorkModeOrCommuteQuestion(field.label);

  // 1. Chave exata (mas se for pergunta de modalidade/presencial, ignora resposta antiga da IA para respeitar o filtro atual!)
  const exact = bank.find(
    (entry) => entry.questionKey === key && entry.answer.trim() !== '' && !(isWorkModeQ && entry.source === 'ai'),
  );
  if (exact) return exact.answer;

  // 2. A MESMA pergunta respondida pela própria pessoa ('user' ou 'manual_linkedin'), escrita com outras palavras de ligação.
  // Antes bastava ser "parecida" (82% das palavras): a resposta de "anos de Arquitetura de informação" servia para
  // "anos de Arquitetura de software". Uma palavra de conteúdo diferente já é outra pergunta.
  for (const entry of bank) {
    if (entry.source === 'ai') continue;
    if (entry.answer.trim() === '') continue;
    if (sameQuestionIgnoringFillers(field.label, entry.question)) return entry.answer;
  }
  return null;
}

/**
 * Procura anos de uma habilidade já presente na Ficha de Conhecimento (resposta instantânea em 0ms!).
 */
function matchSkillYearsFromKnowledge(normQuestion: string, kb: KnowledgeBase): string | null {
  const asksSkillYears =
    /\b(ha quantos anos|quantos anos.*experiencia|quantos anos.*usa|quantos anos.*trabalha|how many years.*experience|how many years.*use)\b/.test(
      normQuestion,
    );
  if (!asksSkillYears) return null;

  for (const skill of kb.skills) {
    const normSkill = normalizeText(skill.name);
    if (normSkill.length < 2) continue;
    const paddedQ = ` ${normQuestion} `;
    if (paddedQ.includes(` ${normSkill} `)) {
      return String(Math.round(skill.years));
    }
  }

  // Se pergunta anos totais de experiência profissional (sem citar ferramenta específica)
  if (
    kb.totalYearsExperience > 0 &&
    /\b(experiencia profissional|experiencia na area|total.*anos de experiencia|years of professional experience)\b/.test(normQuestion)
  ) {
    return String(Math.round(kb.totalYearsExperience));
  }

  return null;
}

/**
 * Procura nível de idioma já presente na Ficha de Conhecimento (0ms!).
 */
function matchLanguageFromKnowledge(normQuestion: string, kb: KnowledgeBase): string | null {
  if (kb.languages.length === 0) return null;
  for (const lang of kb.languages) {
    const normLang = normalizeText(lang.language);
    if (!normLang) continue;
    if (
      normQuestion === normLang ||
      (normQuestion.includes(normLang) && /\b(nivel|proficiencia|fluencia|level|proficiency|idioma|fala)\b/.test(normQuestion))
    ) {
      return lang.level;
    }
  }
  return null;
}

/**
 * Regras diretas da Ficha de Conhecimento (instantâneas, 0ms, sem chamada de rede!).
 */
function matchFromKnowledgeRules(field: FormFieldSnapshot, kb: KnowledgeBase): string | null {
  const norm = normalizeText(field.label);

  // Contato básico
  if (/\b(e mail|email|correio eletronico)\b/.test(norm) && kb.email) return kb.email;
  if (/\b(celular|telefone|whatsapp|phone|mobile)\b/.test(norm) && !norm.includes('pais') && !norm.includes('country') && kb.phone) {
    return kb.phone;
  }
  if (/\b(linkedin)\b/.test(norm) && /\b(url|link|perfil|profile|endereco)\b/.test(norm) && kb.linkedinUrl) {
    return kb.linkedinUrl;
  }
  if (/\b(github|portfolio|portifolio|site pessoal|website)\b/.test(norm) && kb.portfolioUrl) {
    return kb.portfolioUrl;
  }
  if ((norm === 'nome completo' || norm === 'full name' || norm === 'nome') && kb.fullName) {
    return kb.fullName;
  }
  if ((norm === 'primeiro nome' || norm === 'first name') && kb.fullName) {
    return kb.fullName.split(/\s+/)[0] ?? kb.fullName;
  }
  if ((norm === 'sobrenome' || norm === 'last name') && kb.fullName) {
    const parts = kb.fullName.trim().split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(' ') : kb.fullName;
  }
  if ((norm === 'cidade' || norm === 'city' || norm === 'localizacao' || norm === 'cidade onde reside') && kb.city) {
    return kb.state ? `${kb.city}, ${kb.state}` : kb.city;
  }

  // Salário (pretensão ou atual): sempre pela Ficha, e número puro nos campos de texto/número do LinkedIn.
  const salaryKind = takesSalaryValue(field) ? salaryQuestionKind(field.label) : null;
  if (salaryKind !== null) {
    const stored = salaryKind === 'current' ? kb.currentSalary : kb.salaryExpectation;
    if (!stored) return null;
    if (field.type === 'text' || field.type === 'number') {
      return toPureNumberString(stored, true) ?? stored;
    }
    return stored;
  }

  // Disponibilidade / aviso prévio
  if (/\b(disponibilidade para inicio|aviso previo|notice period|when can you start)\b/.test(norm) && kb.noticePeriodDays) {
    return kb.noticePeriodDays;
  }

  // Modelo de trabalho (híbrido / presencial / remoto / ir até o escritório) — pt, en, es e mandarim!
  if (/\b(modelo hibrido|trabalharia.*hibrido|disponibilidade.*hibrido|work.*hybrid|hybrid.*model)\b/.test(norm) || /混合办公/.test(field.label)) {
    return kb.acceptedWorkModes.includes('hybrid') ? 'Sim' : 'Não';
  }
  if (
    /\b(modelo presencial|trabalharia.*presencial|disponibilidade.*presencial|ir ao escritorio|comparecer ao escritorio|deslocamento.*escritorio|comfortable commuting|willing to commute|commute to.*location|work.*on site|work.*onsite)\b/.test(
      norm,
    ) ||
    /(工作地点上班|到岗|现场办公|坐班|线下办公)/.test(field.label)
  ) {
    return kb.acceptedWorkModes.includes('onsite') ? 'Sim' : 'Não';
  }
  if (/\b(modelo remoto|trabalharia.*remoto|home office|work.*remote)\b/.test(norm) || /远程办公/.test(field.label)) {
    return kb.acceptedWorkModes.includes('remote') ? 'Sim' : 'Não';
  }

  // Autorização de trabalho no Brasil / Visto
  if (/\b(autorizacao.*trabalhar.*brasil|legalmente autorizado.*trabalhar|legally authorized to work)\b/.test(norm)) {
    return kb.workAuthorizationBrazil ? 'Sim' : 'Não';
  }
  if (/\b(patrocinio de visto|visa sponsorship|precisara de visto|require sponsorship)\b/.test(norm)) {
    return kb.needsVisaSponsorship ? 'Sim' : 'Não';
  }

  // Mudança de cidade
  if (/\b(mudanca de cidade|disponibilidade para mudanca|willing to relocate|relocate)\b/.test(norm)) {
    return kb.willingToRelocate ? 'Sim' : 'Não';
  }

  // Habilidades com anos já calculados na Ficha (0ms!)
  const skillYears = matchSkillYearsFromKnowledge(norm, kb);
  if (skillYears !== null) return skillYears;

  // Idiomas já mapeados na Ficha (0ms!)
  const langLevel = matchLanguageFromKnowledge(norm, kb);
  if (langLevel !== null) return langLevel;

  return null;
}

/**
 * Converte uma resposta candidata em instrução validada para o campo específico do LinkedIn.
 */
export function buildValidatedInstruction(field: FormFieldSnapshot, rawAnswer: string): FieldFillInstruction | null {
  const trimmed = rawAnswer.trim();
  if (trimmed === '') return null;

  if (field.type === 'radio' || field.type === 'select') {
    if (field.options.length === 0) return null;
    const matched = matchBestOption(field.options, trimmed);
    if (!matched) return null;
    return {
      fieldId: field.fieldId,
      value: matched.id,
      optionLabel: matched.label,
    };
  }

  if (field.type === 'checkbox') {
    const norm = normalizeText(trimmed);
    const yes = ['sim', 'yes', 'si', 'true', '1', 'marcar', 'aceito', 'concordo'].includes(norm);
    const no = ['nao', 'no', 'false', '0', 'desmarcar'].includes(norm);
    if (!yes && !no) return null;
    return {
      fieldId: field.fieldId,
      value: yes ? 'true' : 'false',
      checked: yes,
    };
  }

  const numCheck = expectsNumericAnswer(field.label, field.type, field.errorText);
  if (numCheck.numeric) {
    const pure = toPureNumberString(trimmed, numCheck.integerOnly);
    if (pure === null) return null;
    if (field.min !== undefined && Number(pure) < field.min) return null;
    if (field.max !== undefined && Number(pure) > field.max) return null;
    return { fieldId: field.fieldId, value: pure };
  }

  const maxLen = field.maxLength && field.maxLength > 0 ? field.maxLength : 2000;
  return {
    fieldId: field.fieldId,
    value: trimmed.slice(0, maxLen),
  };
}

interface AiBatchResponse {
  answers?: Array<{
    index?: number;
    status?: 'answered' | 'unknown';
    value?: string | number | boolean;
    reason?: string;
  }>;
}

export async function solveFormStep(params: {
  step: FormStepSnapshot;
  knowledge: KnowledgeBase;
  resumeText: string;
  answers: readonly AnswerEntry[];
  apiKey: string;
  preferredModel?: string;
  userPickedModel?: boolean;
  discoveredModels?: readonly string[];
  unfollowCompany: boolean;
  todayIso: string;
  forceAiForAllUnfilled?: boolean;
  fetchImpl?: typeof fetch;
  /** Chamado logo antes de a IA ser consultada, com quantas perguntas vão para ela. */
  onAiCall?: (questionCount: number) => void | Promise<void>;
}): Promise<SolveStepOutcome> {
  const instructions: FieldFillInstruction[] = [];
  const traces: SolvedFieldTrace[] = [];
  const missingRequired: SolveStepOutcome['missingRequired'] = [];
  const learnedFromAi: SolveStepOutcome['learnedFromAi'] = [];
  const needsAiFields: FormFieldSnapshot[] = [];

  for (const field of params.step.fields) {
    // 1. Caixa "Siga a empresa..." na revisão
    if (field.isFollowCompany) {
      if (params.unfollowCompany && field.checked !== false) {
        instructions.push({ fieldId: field.fieldId, value: 'false', checked: false });
        traces.push({ fieldId: field.fieldId, label: field.label, source: 'knowledge', valueSummary: 'desmarcado' });
      } else {
        traces.push({ fieldId: field.fieldId, label: field.label, source: 'prefilled', valueSummary: 'mantido' });
      }
      continue;
    }

    // 2. Campo já preenchido pelo próprio LinkedIn (sem erro de validação) -> manter!
    if (isAlreadySatisfied(field)) {
      traces.push({ fieldId: field.fieldId, label: field.label, source: 'prefilled', valueSummary: 'já preenchido na página' });
      continue;
    }

    // 3. Campo opcional sem resposta imediata -> deixa em branco sem perder tempo chamando IA!
    if (!field.required && field.type === 'checkbox') {
      traces.push({ fieldId: field.fieldId, label: field.label, source: 'skipped_optional', valueSummary: 'opcional deixado em branco' });
      continue;
    }

    // 4. Banco de respostas + Regras diretas da Ficha (0ms!)
    if (!field.errorText && !params.forceAiForAllUnfilled) {
      const fromBank = matchFromAnswerBank(field, params.answers);
      if (fromBank !== null) {
        const inst = buildValidatedInstruction(field, fromBank);
        if (inst) {
          instructions.push(inst);
          traces.push({
            fieldId: field.fieldId,
            label: field.label,
            source: 'bank',
            valueSummary: inst.optionLabel ?? inst.value,
          });
          continue;
        }
      }

      const fromKb = matchFromKnowledgeRules(field, params.knowledge);
      if (fromKb !== null) {
        const inst = buildValidatedInstruction(field, fromKb);
        if (inst) {
          instructions.push(inst);
          traces.push({
            fieldId: field.fieldId,
            label: field.label,
            source: 'knowledge',
            valueSummary: inst.optionLabel ?? inst.value,
          });
          continue;
        }
      }
    }

    // Campos opcionais que não casaram nas regras locais ficam em branco para não atrasar o envio com chamadas desnecessárias!
    if (!field.required && !params.forceAiForAllUnfilled) {
      traces.push({ fieldId: field.fieldId, label: field.label, source: 'skipped_optional', valueSummary: 'opcional deixado em branco' });
      continue;
    }

    // Valor de salário nunca vai para a IA: se a Ficha não tem (ou o LinkedIn recusou o que ela tinha), a pessoa responde uma vez.
    if (takesSalaryValue(field) && salaryQuestionKind(field.label) !== null) {
      missingRequired.push({
        questionKey: field.questionKey || makeQuestionKey(field.label, field.type),
        question: field.label,
        fieldType: field.type,
        options: [],
        reason: field.errorText
          ? `O LinkedIn recusou o valor da Ficha (${field.errorText}). Responda só com números.`
          : 'Salário não está na sua Ficha. Responda uma vez (só números) e fica guardado.',
      });
      traces.push({ fieldId: field.fieldId, label: field.label, source: 'missing', valueSummary: 'salário fora da Ficha (não vai para a IA)' });
      continue;
    }

    needsAiFields.push(field);
  }

  if (needsAiFields.length === 0) {
    return {
      instructions,
      missingRequired,
      learnedFromAi,
      traces,
      aiCallMade: false,
      aiQuestionsSent: 0,
      aiAnswered: 0,
      aiUnknown: 0,
    };
  }

  // Sem chave da IA configurada: registra obrigatórias em falta
  if (!params.apiKey.trim()) {
    for (const field of needsAiFields) {
      missingRequired.push({
        questionKey: field.questionKey || makeQuestionKey(field.label, field.type),
        question: field.label,
        fieldType: field.type,
        options: field.options.map((o) => o.label),
        reason: 'Sem chave da IA configurada no Passo 2',
      });
      traces.push({ fieldId: field.fieldId, label: field.label, source: 'missing', valueSummary: 'sem chave da IA' });
    }
    return {
      instructions,
      missingRequired,
      learnedFromAi,
      traces,
      aiCallMade: false,
      aiQuestionsSent: 0,
      aiAnswered: 0,
      aiUnknown: 0,
      aiError: 'Chave da IA não configurada.',
    };
  }

  const questionsPayload = needsAiFields.map((f, index) => {
    const numRule = expectsNumericAnswer(f.label, f.type, f.errorText);
    return {
      index,
      question: f.label,
      fieldType: f.type,
      ...(f.options.length > 0 ? { options: f.options.map((o) => o.label) } : {}),
      ...(numRule.numeric
        ? { formatRequired: numRule.integerOnly ? 'INTEIRO_PURO_SEM_TEXTO (ex: "0", "2", "5")' : 'NUMERO_PURO_SEM_MOEDA_NEM_TEXTO (ex: "8000")' }
        : {}),
      ...(f.maxLength ? { maxLength: f.maxLength } : {}),
      ...(f.errorText ? { previousValueRejected: f.currentValue, linkedinValidationError: f.errorText } : {}),
    };
  });

  // O currículo vai inteiro (até 24 mil letras). Antes ia só o começo (3.500 letras) quando a ficha já existia, e a IA
  // respondia "0 anos" para o que estava mais adiante no currículo. O texto a mais custa cerca de 1 s no modelo rápido.
  const resumeCap = 24_000;
  // Salário e dados de contato não vão para o Google: saem da ficha, do currículo e das respostas guardadas enviadas.
  // (Os campos de contato do formulário são respondidos pela Ficha, aqui no navegador.)
  const {
    salaryExpectation: _salaryExpectation,
    currentSalary: _currentSalary,
    fullName: _fullName,
    email: _email,
    phone: _phone,
    linkedinUrl: _linkedinUrl,
    portfolioUrl: _portfolioUrl,
    ...knowledgeRest
  } = params.knowledge;
  const hide = (text: string): string => redactContact(text, params.knowledge.fullName);
  const knowledgeForAi = { ...knowledgeRest, summary: hide(knowledgeRest.summary), extraFacts: hide(knowledgeRest.extraFacts) };
  const savedBankFacts = params.answers
    .filter((a) => salaryQuestionKind(a.question) === null)
    .slice(0, 30)
    .map((a) => ({ q: a.question, a: hide(a.answer) }));

  const allowedModes = params.knowledge.acceptedWorkModes;
  const acceptsOnsite = allowedModes.includes('onsite');
  const acceptsHybrid = allowedModes.includes('hybrid');
  const acceptsRemote = allowedModes.includes('remote');

  const systemInstruction = [
    'Você preenche formulários de Candidatura Simplificada do LinkedIn usando APENAS a Ficha, Respostas Guardadas e Currículo.',
    `Hoje: ${params.todayIso}.`,
    'REGRAS:',
    '1. Anos de experiência: procure a tecnologia, ferramenta ou área na ficha E no texto inteiro do currículo (`resumeText`). Se aparece, some os anos das experiências em que foi usada e devolva o inteiro; uma área ampla (ex.: "arquitetura de soluções", "gestão de projetos") conta pelos cargos e atividades ligados a ela. Só responda "0" se ela não aparece em lugar nenhum.',
    '2. Com `options`, `value` DEVE ser exatamente uma das opções.',
    '3. Com `formatRequired` numérico, devolva SÓ dígitos ("5", "8000").',
    `4. MODALIDADE DE TRABALHO ESTRITA DA PESSOA: Remoto=${acceptsRemote ? 'ACEITA' : 'NÃO ACEITA'}, Híbrido=${acceptsHybrid ? 'ACEITA' : 'NÃO ACEITA'}, Presencial/Ir ao escritório/Deslocar-se ao local de trabalho=${acceptsOnsite ? 'ACEITA' : 'NÃO ACEITA'}. Em qualquer idioma (português, inglês, espanhol, chinês/mandarim etc.), se a pergunta questionar se a pessoa aceita trabalhar presencialmente, ir ao escritório, deslocar-se até o local (commute / 到此工作地点上班 / on-site) e Presencial for NÃO ACEITA, responda NÃO (na opção equivalente do idioma, ex.: "Não", "No", "否"). Mesma regra para Híbrido!`,
    '5. Salário, documento pessoal (CPF/RG) ou dado ausente -> `status: "unknown"`.',
    '6. Formato JSON: { "answers": [ { "index": 0, "status": "answered" | "unknown", "value": "...", "reason": "curto" } ] }.',
  ].join('\n');

  const prompt = JSON.stringify({
    knowledgeBase: knowledgeForAi,
    savedAnswers: savedBankFacts,
    resumeText: hide(params.resumeText).slice(0, resumeCap),
    questionsToAnswer: questionsPayload,
  });

  if (params.onAiCall) await params.onAiCall(needsAiFields.length);

  const aiRes = await callGeminiJson<AiBatchResponse>({
    apiKey: params.apiKey,
    preferredModel: params.preferredModel,
    userPickedModel: params.userPickedModel,
    discoveredModels: params.discoveredModels,
    systemInstruction,
    prompt,
    timeoutMs: 12_000,
    totalBudgetMs: 26_000,
    maxAttempts: 3,
    fetchImpl: params.fetchImpl,
  });
  const aiTiming = { aiElapsedMs: aiRes.elapsedMs, aiAttempts: describeAttempts(aiRes.attempts) };

  if (!aiRes.ok) {
    for (const field of needsAiFields) {
      missingRequired.push({
        questionKey: field.questionKey || makeQuestionKey(field.label, field.type),
        question: field.label,
        fieldType: field.type,
        options: field.options.map((o) => o.label),
        reason: `Erro na IA: ${aiRes.errorPtBr}`,
      });
      traces.push({ fieldId: field.fieldId, label: field.label, source: 'missing', valueSummary: `erro na IA (${aiRes.errorPtBr})` });
    }
    return {
      instructions,
      missingRequired,
      learnedFromAi,
      traces,
      aiCallMade: true,
      aiQuestionsSent: needsAiFields.length,
      aiAnswered: 0,
      aiUnknown: needsAiFields.length,
      aiError: aiRes.errorPtBr,
      ...aiTiming,
    };
  }

  const byIndex = new Map<number, { status?: string; value?: string | number | boolean; reason?: string }>();
  for (const item of aiRes.data.answers ?? []) {
    if (typeof item?.index === 'number') byIndex.set(item.index, item);
  }

  let aiAnswered = 0;
  let aiUnknown = 0;

  for (const [idx, field] of needsAiFields.entries()) {
    const item = byIndex.get(idx);
    const rawVal = item?.value !== undefined && item?.value !== null ? String(item.value) : '';
    const validated = item?.status === 'answered' && rawVal !== '' ? buildValidatedInstruction(field, rawVal) : null;

    if (validated) {
      aiAnswered += 1;
      instructions.push(validated);
      const displayAnswer = validated.optionLabel ?? validated.value;
      traces.push({
        fieldId: field.fieldId,
        label: field.label,
        source: 'ai',
        valueSummary: displayAnswer,
      });
      learnedFromAi.push({
        questionKey: field.questionKey || makeQuestionKey(field.label, field.type),
        question: field.label,
        answer: displayAnswer,
        fieldType: field.type,
      });
    } else {
      aiUnknown += 1;
      missingRequired.push({
        questionKey: field.questionKey || makeQuestionKey(field.label, field.type),
        question: field.label,
        fieldType: field.type,
        options: field.options.map((o) => o.label),
        reason: item?.reason ? `IA não tinha certeza: ${item.reason}` : 'Informação não encontrada na ficha/currículo',
      });
      traces.push({ fieldId: field.fieldId, label: field.label, source: 'missing', valueSummary: 'IA não soube responder' });
    }
  }

  return {
    instructions,
    missingRequired,
    learnedFromAi,
    traces,
    aiCallMade: true,
    aiQuestionsSent: needsAiFields.length,
    aiAnswered,
    aiUnknown,
    aiModelUsed: aiRes.modelUsed,
    ...aiTiming,
  };
}
