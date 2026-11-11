/**
 * Normalização de texto, chaves de pergunta, extração numérica e comparação de opções.
 */

export function normalizeText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+#.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function cleanQuestionLabel(raw: string): string {
  let out = collapseWhitespace(raw).replace(/\s*\*+$/, '').trim();
  // Remove duplicação acessível ("Nome Nome" -> "Nome")
  const words = out.split(' ');
  if (words.length >= 2 && words.length % 2 === 0) {
    const half = words.length / 2;
    const first = words.slice(0, half).join(' ');
    const second = words.slice(half).join(' ');
    if (normalizeText(first) === normalizeText(second)) {
      out = first;
    }
  }
  if (out.length >= 4 && out.length % 2 === 0) {
    const half = out.length / 2;
    if (normalizeText(out.slice(0, half)) === normalizeText(out.slice(half))) {
      out = out.slice(0, half);
    }
  }
  return out;
}

export function makeQuestionKey(label: string, fieldType?: string): string {
  const base = normalizeText(cleanQuestionLabel(label))
    .replace(/\b(obrigatorio|required|opcional|optional)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const kind = fieldType === 'radio' || fieldType === 'select' ? 'choice' : fieldType === 'checkbox' ? 'check' : 'text';
  return `${kind}:${base.slice(0, 140)}`;
}

/**
 * Calcula similaridade por palavras (Jaccard) entre duas perguntas.
 */
export function questionSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeText(a).split(' ').filter((w) => w.length >= 2));
  const wordsB = new Set(normalizeText(b).split(' ').filter((w) => w.length >= 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection += 1;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Detecta se uma pergunta do LinkedIn exige resposta numérica pura (mesmo que o <input> seja type="text").
 */
export function expectsNumericAnswer(label: string, fieldType: string, errorText?: string): { numeric: boolean; integerOnly: boolean } {
  if (fieldType === 'number') {
    return { numeric: true, integerOnly: false };
  }
  const norm = normalizeText(label);
  const errNorm = normalizeText(errorText ?? '');

  if (
    errNorm.includes('numero inteiro') ||
    errNorm.includes('whole number') ||
    errNorm.includes('enter a valid number') ||
    errNorm.includes('insira um numero') ||
    errNorm.includes('valor invalido')
  ) {
    const asksYears = /\b(quantos anos|anos de experiencia|ha quantos anos|how many years|years of work|years of experience)\b/.test(norm);
    return { numeric: true, integerOnly: asksYears || errNorm.includes('inteiro') || errNorm.includes('whole') };
  }

  if (/\b(ha quantos anos|quantos anos|anos de experiencia|how many years|years of experience|years do you have)\b/.test(norm)) {
    return { numeric: true, integerOnly: true };
  }

  if (fieldType === 'text' && salaryQuestionKind(label) !== null) {
    return { numeric: true, integerOnly: true };
  }

  return { numeric: false, integerOnly: false };
}

/**
 * Extrai número puro para campos numéricos do LinkedIn (ex.: "R$ 8.500,00" -> "8500", "3,5 anos" -> "4" se integerOnly).
 */
export function toPureNumberString(raw: string, integerOnly = false): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Caso brasileiro com milhar e centavos: "8.500,00" ou "R$ 10.000"
  let cleaned = trimmed.replace(/[R$US€£\s]/gi, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+(,\d+)$/.test(cleaned)) {
    cleaned = cleaned.replace(',', '.');
  } else {
    const match = /-?\d+(?:[.,]\d+)?/.exec(cleaned);
    if (!match) return null;
    cleaned = match[0].replace(',', '.');
  }

  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return null;
  if (integerOnly) return String(Math.round(num));
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 10) / 10);
}

/**
 * Casa o texto de uma resposta com uma lista de opções disponíveis (ex.: Sim/Não, níveis de idioma, estados).
 */
export function matchBestOption<T extends { label: string; id?: string }>(options: readonly T[], wantedRaw: string): T | null {
  const wanted = normalizeText(wantedRaw);
  if (wanted === '' || options.length === 0) return null;

  // 1. Igualdade exata normalizada
  for (const opt of options) {
    if (normalizeText(opt.label) === wanted) return opt;
    if (opt.id !== undefined && normalizeText(opt.id) === wanted) return opt;
  }

  // 2. Equivalências Sim / Não (pt / en / es / zh / fr / de / it)
  const yesSet = new Set(['sim', 'yes', 'si', 'claro', 'true', 'com certeza', 'possuo', 'tenho', '是', '愿意', '可以', 'oui', 'ja', 'sì']);
  const noSet = new Set(['nao', 'no', 'false', 'nenhum', 'nao possuo', 'nao tenho', '否', '不', '不愿意', '不可以', 'non', 'nein']);
  if (yesSet.has(wanted)) {
    const hit = options.find((o) => yesSet.has(normalizeText(o.label)));
    if (hit) return hit;
  }
  if (noSet.has(wanted)) {
    const hit = options.find((o) => noSet.has(normalizeText(o.label)));
    if (hit) return hit;
  }

  // 3. Contenção única (uma opção contém o termo ou vice-versa)
  const containing = options.filter((opt) => {
    const normOpt = normalizeText(opt.label);
    return normOpt !== '' && (normOpt.includes(wanted) || wanted.includes(normOpt));
  });
  if (containing.length === 1) return containing[0] ?? null;

  return null;
}

/**
 * Modalidade de trabalho escrita num texto curto (cartão da vaga, topo da vaga): "(Remoto)", "(Híbrido)", "(Presencial)".
 */
export function detectWorkModeFromText(raw: string): 'remote' | 'hybrid' | 'onsite' | null {
  const norm = normalizeText(raw);
  const hasRemote = /\b(remoto|remote|teletrabalho)\b/.test(norm);
  const hasHybrid = /\b(hibrido|hybrid)\b/.test(norm);
  const hasOnsite = /\b(presencial|on site|onsite)\b/.test(norm);

  if (hasHybrid) return 'hybrid';
  if (hasRemote && !hasOnsite) return 'remote';
  if (hasOnsite && !hasRemote) return 'onsite';
  return null;
}

/**
 * A pergunta pede um valor de salário? 'expectation' = quanto a pessoa quer; 'current' = quanto ganha hoje ou ganhou por
 * último. Salário nunca vai para a IA: quem responde é a Ficha, e na falta dela a pergunta vai para "Responda 1 vez".
 */
export function salaryQuestionKind(label: string): 'expectation' | 'current' | null {
  const norm = normalizeText(label);
  const aboutPay =
    /\b(salario|salarios|salarial|remuneracao|pretensao|salary|compensation|compensacao|sueldo|wage|ctc|honorarios)\b/.test(norm) ||
    /\b(valor|taxa|rate)\b.*\b(hora|hour|hourly|dia|daily|mes|mensal|monthly)\b/.test(norm) ||
    /\b(hourly|daily|monthly) rate\b/.test(norm) ||
    /\bexpectativa de (ganho|ganhos|renda)\b/.test(norm);
  if (!aboutPay) return null;
  const wants = /\b(pretensao|pretendid[oa]|expectativa|desejad[oa]|desired|expected|expectation|expectations|esperad[oa])\b/.test(norm);
  const current = /\b(atual|atualmente|ultim[oa]|current|currently|last|hoje)\b/.test(norm);
  return current && !wants ? 'current' : 'expectation';
}

const FILLER_WORDS = new Set(
  (
    'a o as os um uma uns umas de do da dos das e ou em no na nos nas para por com que se voce seu sua seus suas qual quais ' +
    'the an of in on at to for your you do does is are what which please and or ' +
    'el la los las un una unos unas del en y su sus tu usted cual cuales favor'
  ).split(' '),
);

/**
 * As duas perguntas são a mesma, a menos de palavras de ligação e pontuação? Uma palavra de conteúdo diferente
 * (o nome de uma ferramenta, de uma cidade) já faz delas perguntas diferentes: "anos de Java" não é "anos de Python".
 */
export function sameQuestionIgnoringFillers(a: string, b: string): boolean {
  const content = (raw: string): Set<string> =>
    new Set(
      normalizeText(cleanQuestionLabel(raw))
        .split(' ')
        .filter((w) => w !== '' && !FILLER_WORDS.has(w)),
    );
  const wordsA = content(a);
  const wordsB = content(b);
  if (wordsA.size === 0 || wordsA.size !== wordsB.size) return false;
  for (const w of wordsA) if (!wordsB.has(w)) return false;
  return true;
}
