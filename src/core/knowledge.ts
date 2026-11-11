import type { KnowledgeBase } from '../shared/types.ts';
import { toPureNumberString } from '../shared/normalize.ts';
import { callGeminiJson } from './gemini.ts';
import { isRedactedPlaceholder, redactContact } from './redact.ts';

/**
 * Extrai dados básicos localmente por regex (instantâneo, mesmo antes da IA).
 */
export function extractLocalResumeFacts(text: string, current: KnowledgeBase): KnowledgeBase {
  const next: KnowledgeBase = { ...current };
  const emailMatch = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.exec(text);
  if (emailMatch && !next.email) {
    next.email = emailMatch[0];
  }

  const phoneMatch = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-\s]?\d{4}/.exec(text);
  if (phoneMatch && !next.phone) {
    next.phone = phoneMatch[0].replace(/[^\d+]/g, '');
  }

  const linkedinMatch = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s/)>,]+/i.exec(text) ?? /linkedin\.com\/in\/[^\s/)>,]+/i.exec(text);
  if (linkedinMatch && !next.linkedinUrl) {
    const raw = linkedinMatch[0];
    next.linkedinUrl = raw.startsWith('http') ? raw : `https://${raw}`;
  }

  const githubMatch = /https?:\/\/(?:www\.)?github\.com\/[^\s/)>,]+/i.exec(text) ?? /github\.com\/[^\s/)>,]+/i.exec(text);
  if (githubMatch && !next.portfolioUrl) {
    const raw = githubMatch[0];
    next.portfolioUrl = raw.startsWith('http') ? raw : `https://${raw}`;
  }

  if (!next.fullName) {
    const firstNonEmpty = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length >= 4 && l.length <= 60 && !l.includes('@') && !/\d{4}/.test(l));
    if (firstNonEmpty) next.fullName = firstNonEmpty;
  }

  return next;
}

interface RawAiKnowledge {
  fullName?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  country?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  targetRole?: string;
  seniority?: string;
  totalYearsExperience?: number;
  salaryExpectation?: string;
  currentSalary?: string;
  noticePeriodDays?: string;
  skills?: Array<{ name?: string; years?: number }>;
  experiences?: Array<{ role?: string; company?: string; period?: string; years?: number; summary?: string }>;
  languages?: Array<{ language?: string; level?: string }>;
  education?: Array<{ degree?: string; field?: string; institution?: string; status?: string }>;
  certifications?: string[];
  summary?: string;
  extractedResumeText?: string;
}

export async function generateKnowledgeBaseFromResume(params: {
  apiKey: string;
  preferredModel?: string;
  userPickedModel?: boolean;
  discoveredModels?: readonly string[];
  resumeText: string;
  pdfBase64?: string;
  existing: KnowledgeBase;
  todayIso: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; knowledge: KnowledgeBase; modelUsed: string; extractedText?: string } | { ok: false; errorPtBr: string }> {
  const hasText = params.resumeText.trim().length >= 40;
  if (!hasText && !params.pdfBase64) {
    return { ok: false, errorPtBr: 'Envie o PDF do seu currículo ou cole o texto dele no Passo 1 primeiro.' };
  }

  const systemInstruction = [
    'Você é um especialista em leitura de currículos para candidaturas de emprego.',
    `A data de hoje é ${params.todayIso}. Use esta data para calcular a duração das experiências "até o momento / atual" em anos.`,
    'Extraia APENAS fatos reais presentes no currículo. NÃO invente tecnologias, empresas, idiomas nem salários que não estejam no documento.',
    'Em "skills", liste TODAS as tecnologias, ferramentas, metodologias e áreas de atuação citadas no currículo (até 60), não só as principais.',
    'Para cada uma, estime os anos de prática somando a duração das experiências onde ela foi usada (ou 1 ano se só listada nas habilidades sem período explícito).',
    'Devolva estritamente um objeto JSON válido com a estrutura pedida.',
  ].join(' ');

  const prompt = [
    'Monte a Ficha de Conhecimento estruturada deste currículo no seguinte formato JSON:',
    JSON.stringify(
      {
        fullName: 'string',
        email: 'string',
        phone: 'apenas dígitos com DDD, ex: 11999999999',
        city: 'string',
        state: 'string',
        country: 'Brasil (ou país do currículo)',
        linkedinUrl: 'string',
        portfolioUrl: 'string',
        targetRole: 'cargo principal da pessoa',
        seniority: 'Júnior | Pleno | Sênior | Especialista | Liderança | Estágio',
        totalYearsExperience: 0,
        skills: [{ name: 'Nome da habilidade/ferramenta', years: 0 }],
        experiences: [{ role: 'Cargo', company: 'Empresa', period: 'AAAA-MM a AAAA-MM ou Atual', years: 0, summary: 'Resumo curto' }],
        languages: [{ language: 'Idioma', level: 'Básico | Intermediário | Avançado | Fluente | Nativo' }],
        education: [{ degree: 'Graduação/Pós/Técnico', field: 'Curso', institution: 'Instituição', status: 'Concluído | Cursando' }],
        certifications: ['string'],
        summary: 'Resumo profissional objetivo em 2 frases',
        ...(hasText ? {} : { extractedResumeText: 'texto completo lido do PDF' }),
      },
      null,
      2,
    ),
    // E-mail, telefone, links e documentos ficam fora do texto enviado: a extensão já os leu do currículo aqui no navegador.
    hasText ? `\nTEXTO DO CURRÍCULO:\n"""\n${redactContact(params.resumeText).slice(0, 28_000)}\n"""` : '\nLeia o arquivo PDF anexado e preencha todos os campos acima.',
  ].join('\n');

  const res = await callGeminiJson<RawAiKnowledge>({
    apiKey: params.apiKey,
    preferredModel: params.preferredModel,
    userPickedModel: params.userPickedModel,
    discoveredModels: params.discoveredModels,
    systemInstruction,
    prompt,
    // Só envia o PDF binário se a extração local não achou texto (ex.: PDF escaneado)
    pdfBase64: hasText ? undefined : params.pdfBase64,
    // Ler o currículo inteiro pede cuidado: o Flash mais novo vai primeiro e, se ele falhar, entram os rápidos.
    // Cada tentativa tem de caber em menos de 30 s, senão o Chrome derruba o serviço da extensão.
    prefer: 'quality',
    timeoutMs: 28_000,
    totalBudgetMs: 80_000,
    maxAttempts: 3,
    fetchImpl: params.fetchImpl,
  });

  if (!res.ok) {
    return { ok: false, errorPtBr: res.errorPtBr };
  }

  const raw = res.data;
  const cur = params.existing;
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback);
  // Contato: o que a extensão leu do currículo no navegador vale mais (a IA recebeu o texto sem esses dados).
  const contact = (fromAi: unknown, local: string): string => (local.trim() !== '' ? local : isRedactedPlaceholder(fromAi) ? '' : str(fromAi));
  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : fallback);

  const knowledge: KnowledgeBase = {
    ...cur,
    fullName: isRedactedPlaceholder(raw.fullName) ? cur.fullName : str(raw.fullName, cur.fullName),
    email: contact(raw.email, cur.email),
    phone: contact(raw.phone, cur.phone),
    city: str(raw.city, cur.city),
    state: str(raw.state, cur.state),
    country: str(raw.country, cur.country || 'Brasil'),
    linkedinUrl: contact(raw.linkedinUrl, cur.linkedinUrl),
    portfolioUrl: contact(raw.portfolioUrl, cur.portfolioUrl),
    targetRole: str(raw.targetRole, cur.targetRole),
    seniority: str(raw.seniority, cur.seniority),
    totalYearsExperience: num(raw.totalYearsExperience, cur.totalYearsExperience),
    // Preserva pretensão salarial, salário atual, aviso prévio e observações já preenchidos pela pessoa
    salaryExpectation: cur.salaryExpectation || (raw.salaryExpectation ? (toPureNumberString(raw.salaryExpectation, true) ?? '') : ''),
    currentSalary: cur.currentSalary || (raw.currentSalary ? (toPureNumberString(raw.currentSalary, true) ?? '') : ''),
    noticePeriodDays: cur.noticePeriodDays || str(raw.noticePeriodDays, 'Imediato'),
    skills: Array.isArray(raw.skills)
      ? raw.skills
          .filter((s) => typeof s?.name === 'string' && s.name.trim() !== '')
          .map((s) => ({ name: s.name!.trim(), years: num(s.years, 0) }))
          .slice(0, 60)
      : cur.skills,
    experiences: Array.isArray(raw.experiences)
      ? raw.experiences
          .filter((e) => typeof e?.role === 'string' && e.role.trim() !== '')
          .map((e) => ({
            role: str(e.role),
            company: str(e.company),
            period: str(e.period),
            years: num(e.years, 0),
            summary: str(e.summary),
          }))
          .slice(0, 20)
      : cur.experiences,
    languages: Array.isArray(raw.languages)
      ? raw.languages
          .filter((l) => typeof l?.language === 'string' && l.language.trim() !== '')
          .map((l) => ({ language: str(l.language), level: str(l.level, 'Intermediário') }))
          .slice(0, 12)
      : cur.languages,
    education: Array.isArray(raw.education)
      ? raw.education
          .filter((ed) => typeof ed?.degree === 'string' || typeof ed?.field === 'string')
          .map((ed) => ({
            degree: str(ed.degree),
            field: str(ed.field),
            institution: str(ed.institution),
            status: str(ed.status, 'Concluído'),
          }))
          .slice(0, 12)
      : cur.education,
    certifications: Array.isArray(raw.certifications)
      ? raw.certifications.filter((c): c is string => typeof c === 'string' && c.trim() !== '').slice(0, 25)
      : cur.certifications,
    summary: str(raw.summary, cur.summary),
    generatedByAiAt: new Date().toISOString(),
  };

  return {
    ok: true,
    knowledge,
    modelUsed: res.modelUsed,
    extractedText: typeof raw.extractedResumeText === 'string' && raw.extractedResumeText.trim() !== '' ? raw.extractedResumeText.trim() : undefined,
  };
}
