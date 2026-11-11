// Correções tiradas dos diários REAIS de 2026-11-10/11 (lidos de um teste real):
//  - a IA levava 28 a 82 s por etapa (fila de modelos lentos, com raciocínio longo);
//  - "Lendo Etapa 1: 0 campo(s), botão none": o diálogo foi lido antes de receber o conteúdo, e a vaga foi descartada;
//  - o envio parou calado no meio (serviço da extensão desligado) e a tela ficou em "Rodando";
//  - "Nenhum cartão de vaga encontrado" duas vezes seguidas, com a aba fora da lista de vagas;
//  - respostas escritas pela IA guardadas como "digitadas pela pessoa", e reaproveitadas em pergunta parecida.
// São testes simulados: provam a lógica, não provam o LinkedIn de verdade.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  buildCandidateModelChain,
  callGeminiJson,
  describeAttempts,
  fastThinkingConfigFor,
  resetGeminiModelMemory,
} from '../src/core/gemini.ts';
import { solveFormStep } from '../src/core/solver.ts';
import { salaryQuestionKind, sameQuestionIgnoringFillers } from '../src/shared/normalize.ts';
import { isRedactedPlaceholder, redactContact } from '../src/core/redact.ts';
import { generateKnowledgeBaseFromResume } from '../src/core/knowledge.ts';
import { RESUME_PDF_KEY, STORAGE_KEY, defaultAppState, emptyKnowledgeBase, loadResumePdf, loadState, updateState } from '../src/shared/storage.ts';
import { makeQuestionKey } from '../src/shared/normalize.ts';
import type { AnswerEntry, AppState, FormFieldSnapshot, FormStepSnapshot } from '../src/shared/types.ts';
import { findEasyApplyButton, jobsPageKind, listJobCards, readOpenJobSnapshot } from '../src/content/job-search.ts';
import { readEasyApplyStep, readEasyApplyStepWhenReady } from '../src/content/easy-apply-read.ts';
import {
  applyFieldInstructions,
  clickEasyApplyForJob,
  clickStepNavigationButton,
  dismissAllOpenDialogs,
  isExtensionWriting,
  wasWrittenByExtension,
} from '../src/content/easy-apply-act.ts';
import { isStillOnList, recoverInterruptedRun, startBatchRunner, stopBatchRunner } from '../src/background/runner.ts';

// ---------------------------------------------------------------------------------------------------------
// Apoio

/** Uma lista de modelos guardada num teste real em 2026-11-11, na ordem em que estava (os lentos na frente). */
const STORED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-4-argon',
  'gemini-4-carbon',
  'gemini-3.5-transcribe',
  'gemini-2.5-pro',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-omni-1.1-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-nano-banana-2.1',
];

const okBody = (data: unknown): string => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] });
const modelOf = (url: unknown): string => /models\/([^:]+):generateContent/.exec(String(url))?.[1] ?? '';

function field(label: string, type: FormFieldSnapshot['type'], extra: Partial<FormFieldSnapshot> = {}): FormFieldSnapshot {
  return { fieldId: `f_${label.length}_${type}`, questionKey: makeQuestionKey(label, type), label, type, required: true, currentValue: '', options: [], ...extra };
}

function stepOf(fields: FormFieldSnapshot[]): FormStepSnapshot {
  return {
    modalOpen: true,
    signature: 's',
    stepTitle: 'Perguntas adicionais',
    progressText: '4 de 5 páginas',
    buttonKind: 'review',
    buttonLabel: 'Avaliar',
    hasResumeCards: false,
    resumeSelected: true,
    pageErrors: [],
    fields,
  };
}

function makeDom(html: string, url = 'https://www.linkedin.com/jobs/search-results/?currentJobId=3900000002') {
  const dom = new JSDOM(html, { url });
  return { doc: dom.window.document, win: dom.window as unknown as Window };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------
// IA rápida

test('fila de modelos: com uma lista guardada de verdade (lentos na frente), os Flash-Lite passam a ser tentados primeiro', () => {
  resetGeminiModelMemory();
  const chain = buildCandidateModelChain({ preferred: 'gemini-3.6-flash', discovered: STORED_MODELS });
  assert.deepEqual(chain.slice(0, 3), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
  assert.ok(chain.indexOf('gemini-3.6-flash') > 2, 'o modelo que estava guardado como preferido não fura a fila');
  for (const notText of ['gemini-3.5-transcribe', 'gemini-omni-1.1-flash', 'gemini-nano-banana-2.1', 'gemini-3.1-pro-preview-customtools']) {
    assert.equal(chain.includes(notText), false, `${notText} não é modelo de texto para formulário`);
  }
  // Para ler o currículo (qualidade), o Flash estável mais novo vai na frente e os rápidos ficam de reserva.
  assert.deepEqual(buildCandidateModelChain({ discovered: STORED_MODELS, prefer: 'quality' }).slice(0, 2), ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  // Quando a pessoa ESCOLHE um modelo na lista, ele vai primeiro.
  assert.equal(buildCandidateModelChain({ preferred: 'gemini-3.8-flash', userPicked: true, discovered: STORED_MODELS })[0], 'gemini-3.8-flash');
});

test('raciocínio curto: cada modelo recebe o menor nível que aceita (documentação do Google de 2026-11-11)', () => {
  assert.deepEqual(fastThinkingConfigFor('gemini-3.5-flash-lite'), { thinkingLevel: 'MINIMAL' });
  assert.deepEqual(fastThinkingConfigFor('gemini-3.6-flash'), { thinkingLevel: 'MINIMAL' });
  assert.deepEqual(fastThinkingConfigFor('gemini-3.8-flash'), { thinkingLevel: 'LOW' });
  assert.deepEqual(fastThinkingConfigFor('gemini-4-argon'), { thinkingLevel: 'LOW' });
  assert.deepEqual(fastThinkingConfigFor('gemini-2.5-flash'), { thinkingBudget: 0 });
  assert.equal(fastThinkingConfigFor('gemini-2.5-flash-lite'), null);
  assert.equal(fastThinkingConfigFor('gemini-flash-latest'), null);
});

test('chamada à IA: modelo que demora é abandonado no teto, o seguinte responde, e na próxima chamada o lento vai para o fim', async () => {
  resetGeminiModelMemory();
  const calls: string[] = [];
  const fakeFetch: typeof fetch = (url, init) => {
    const model = modelOf(url);
    calls.push(model);
    if (model === 'gemini-3.5-flash-lite') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return Promise.resolve(new Response(okBody({ ok: 1 }), { status: 200 }));
  };

  const first = await callGeminiJson<{ ok: number }>({ apiKey: 'k', discoveredModels: STORED_MODELS, prompt: 'p', timeoutMs: 80, fetchImpl: fakeFetch });
  assert.equal(first.ok, true);
  assert.deepEqual(calls, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  assert.deepEqual(first.attempts.map((a) => a.outcome), ['timeout', 'ok']);
  assert.match(describeAttempts(first.attempts), /gemini-3\.5-flash-lite \d+\.\ds demorou demais; gemini-3\.1-flash-lite \d+\.\ds ok/);

  calls.length = 0;
  const second = await callGeminiJson<{ ok: number }>({ apiKey: 'k', discoveredModels: STORED_MODELS, prompt: 'p', timeoutMs: 80, fetchImpl: fakeFetch });
  assert.equal(second.ok, true);
  assert.deepEqual(calls, ['gemini-3.1-flash-lite'], 'vai direto no modelo que respondeu; não paga a espera do lento de novo');
});

test('chamada à IA: respeita o teto total, e se o modelo recusa a configuração de raciocínio tenta o mesmo modelo sem ela', async () => {
  resetGeminiModelMemory();
  const hang: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const started = Date.now();
  const slow = await callGeminiJson({ apiKey: 'k', discoveredModels: STORED_MODELS, prompt: 'p', timeoutMs: 1_000, totalBudgetMs: 2_000, fetchImpl: hang });
  assert.equal(slow.ok, false);
  assert.equal(slow.attempts.length, 1, 'depois da 1ª espera não sobra tempo útil para outra tentativa');
  assert.ok(Date.now() - started < 2_500);

  resetGeminiModelMemory();
  const bodies: Array<Record<string, unknown>> = [];
  const picky: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { generationConfig: Record<string, unknown> };
    bodies.push(body.generationConfig);
    if ('thinkingConfig' in body.generationConfig) return new Response(JSON.stringify({ error: { message: 'Unknown thinking level' } }), { status: 400 });
    return new Response(okBody({ ok: 1 }), { status: 200 });
  };
  const res = await callGeminiJson<{ ok: number }>({ apiKey: 'k', discoveredModels: ['gemini-3.7-flash'], prompt: 'p', fetchImpl: picky });
  assert.equal(res.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal('thinkingConfig' in bodies[1]!, false);
  bodies.length = 0;
  await callGeminiJson({ apiKey: 'k', discoveredModels: ['gemini-3.7-flash'], prompt: 'p', fetchImpl: picky });
  assert.equal(bodies.length, 1, 'na chamada seguinte já não manda a configuração recusada');
});

// ---------------------------------------------------------------------------------------------------------
// Respostas: currículo inteiro, salário fora da IA, pergunta parecida não é a mesma pergunta

test('a IA recebe o currículo inteiro (não só o começo), e o salário não vai para ela nem pela ficha nem pelas respostas guardadas', async () => {
  resetGeminiModelMemory();
  const kb = { ...emptyKnowledgeBase(), generatedByAiAt: '2026-11-11T01:18:38Z', salaryExpectation: '18000', currentSalary: '15000', city: 'São Paulo' };
  const resumeText = `${'x'.repeat(9_000)} Atuei 7 anos com Arquitetura de informação na Empresa Z.`;
  const bank: AnswerEntry[] = [
    { id: 'a', questionKey: 'text:qual sua pretensao salarial', question: 'Qual sua pretensão salarial?', answer: '18000', fieldType: 'text', source: 'user', updatedAt: '' },
    { id: 'b', questionKey: 'choice:possui cnh', question: 'Possui CNH?', answer: 'Sim', fieldType: 'radio', source: 'user', updatedAt: '' },
  ];
  let sent = '';
  let asked = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    sent = String(init?.body);
    return new Response(okBody({ answers: [{ index: 0, status: 'answered', value: '7' }] }), { status: 200 });
  };
  const res = await solveFormStep({
    step: stepOf([field('Há quantos anos você já usa Arquitetura de informação no trabalho?', 'text')]),
    knowledge: kb,
    resumeText,
    answers: bank,
    apiKey: 'k',
    unfollowCompany: true,
    todayIso: '2026-11-11',
    fetchImpl: fakeFetch,
    onAiCall: (count) => {
      asked = count;
    },
  });
  assert.equal(res.instructions[0]?.value, '7');
  assert.equal(asked, 1);
  assert.ok((res.aiElapsedMs ?? -1) >= 0 && (res.aiAttempts ?? '').includes(' ok'));
  const prompt = JSON.parse((JSON.parse(sent) as { contents: Array<{ parts: Array<{ text: string }> }> }).contents[0]!.parts[0]!.text) as {
    knowledgeBase: Record<string, unknown>;
    savedAnswers: Array<{ q: string }>;
    resumeText: string;
  };
  assert.ok(prompt.resumeText.includes('7 anos com Arquitetura de informação'), 'o trecho que está depois das primeiras 3.500 letras foi enviado');
  assert.equal('salaryExpectation' in prompt.knowledgeBase, false);
  assert.equal('currentSalary' in prompt.knowledgeBase, false);
  assert.equal(sent.includes('18000') || sent.includes('15000'), false, 'nenhum valor de salário saiu do navegador');
  assert.deepEqual(prompt.savedAnswers.map((a) => a.q), ['Possui CNH?']);
});

test('dados de contato não vão para a IA: nem na ficha, nem no currículo, nem nas respostas guardadas', async () => {
  resetGeminiModelMemory();
  const kb = { ...emptyKnowledgeBase(), fullName: 'Ana Maria Exemplo', email: 'ana.maria@exemplo.com', phone: '11988887777', linkedinUrl: 'https://www.linkedin.com/in/ana-exemplo', summary: 'Contato: ana.maria@exemplo.com' };
  const resumeText = 'Ana Maria  Exemplo\nana.maria@exemplo.com · (11) 98888-7777 · linkedin.com/in/ana-exemplo · CPF 123.456.789-00\nAnalista de Dados com Python desde 2018.';
  const bank: AnswerEntry[] = [{ id: 'x', questionKey: 'text:telefone recado', question: 'Telefone para recado', answer: '+55 11 97777-6666', fieldType: 'text', source: 'user', updatedAt: '' }];
  let sent = '';
  const fakeFetch: typeof fetch = async (_url, init) => {
    sent = String(init?.body);
    return new Response(okBody({ answers: [{ index: 0, status: 'answered', value: '7' }] }), { status: 200 });
  };
  await solveFormStep({ step: stepOf([field('Há quantos anos você usa Python?', 'text')]), knowledge: kb, resumeText, answers: bank, apiKey: 'k', unfollowCompany: true, todayIso: '2026-11-11', fetchImpl: fakeFetch });
  for (const secret of ['Ana Maria', 'ana.maria@exemplo.com', '98888-7777', '11988887777', 'linkedin.com/in', '123.456.789-00', '97777-6666']) {
    assert.equal(sent.includes(secret), false, `"${secret}" foi para a IA`);
  }
  assert.ok(sent.includes('Analista de Dados com Python desde 2018'), 'o resto do currículo continua indo');
  assert.ok(sent.includes('[telefone]') && sent.includes('[e-mail]') && sent.includes('[nome]'));
  assert.equal(redactContact('Atuei de 2018-2020 e 01/2021 a 03/2024, com 15 pessoas.'), 'Atuei de 2018-2020 e 01/2021 a 03/2024, com 15 pessoas.', 'datas e números comuns não são apagados');
  assert.equal(isRedactedPlaceholder('[e-mail]'), true);
  assert.equal(isRedactedPlaceholder('Ana'), false);

  // Montagem da ficha: o texto vai sem contato, e o contato lido no navegador continua na Ficha.
  let kbPrompt = '';
  const kbFetch: typeof fetch = async (_url, init) => {
    kbPrompt = String(init?.body);
    return new Response(okBody({ fullName: 'Ana Maria Exemplo', email: '[e-mail]', phone: '[telefone]', linkedinUrl: '[link]', targetRole: 'Analista de Dados' }), { status: 200 });
  };
  const built = await generateKnowledgeBaseFromResume({
    apiKey: 'k',
    resumeText,
    existing: { ...emptyKnowledgeBase(), email: 'ana.maria@exemplo.com', phone: '11988887777', linkedinUrl: 'https://linkedin.com/in/ana-exemplo' },
    todayIso: '2026-11-11',
    fetchImpl: kbFetch,
  });
  for (const secret of ['ana.maria@exemplo.com', '98888-7777', 'linkedin.com/in', '123.456.789-00']) assert.equal(kbPrompt.includes(secret), false, `"${secret}" foi para a IA na montagem da ficha`);
  assert.equal(built.ok, true);
  if (built.ok) {
    assert.equal(built.knowledge.email, 'ana.maria@exemplo.com');
    assert.equal(built.knowledge.phone, '11988887777');
    assert.equal(built.knowledge.linkedinUrl, 'https://linkedin.com/in/ana-exemplo');
    assert.equal(built.knowledge.fullName, 'Ana Maria Exemplo');
  }
});

test('pergunta de salário: responde pela Ficha em qualquer jeito de perguntar; sem a Ficha vira "Responda 1 vez" sem chamar a IA', async () => {
  assert.equal(salaryQuestionKind('Qual é a sua expectativa de remuneração mensal (CLT)?'), 'expectation');
  assert.equal(salaryQuestionKind('Qual sua pretensão salarial?'), 'expectation');
  assert.equal(salaryQuestionKind('Informe sua remuneração atual'), 'current');
  assert.equal(salaryQuestionKind('What is your current salary?'), 'current');
  assert.equal(salaryQuestionKind('What are your salary expectations?'), 'expectation');
  assert.equal(salaryQuestionKind('Há quantos anos você usa Excel?'), null);
  assert.equal(salaryQuestionKind('What is your current location?'), null);

  let aiCalls = 0;
  const fakeFetch: typeof fetch = async () => {
    aiCalls += 1;
    return new Response(okBody({ answers: [] }), { status: 200 });
  };
  const step = stepOf([field('Qual é a sua expectativa de remuneração mensal (CLT)?', 'text')]);

  const withSalary = await solveFormStep({ step, knowledge: { ...emptyKnowledgeBase(), salaryExpectation: '18000' }, resumeText: '', answers: [], apiKey: 'k', unfollowCompany: true, todayIso: '2026-11-11', fetchImpl: fakeFetch });
  assert.equal(withSalary.instructions[0]?.value, '18000');

  const without = await solveFormStep({ step, knowledge: emptyKnowledgeBase(), resumeText: '', answers: [], apiKey: 'k', unfollowCompany: true, todayIso: '2026-11-11', fetchImpl: fakeFetch });
  assert.equal(without.missingRequired.length, 1);
  assert.match(without.missingRequired[0]!.reason, /Salário não está na sua Ficha/);
  assert.equal(aiCalls, 0);
});

test('resposta guardada só vale para a MESMA pergunta: "anos de Arquitetura de informação" não responde "anos de Arquitetura de software"', async () => {
  resetGeminiModelMemory();
  assert.equal(sameQuestionIgnoringFillers('Possui CNH categoria B?', 'Você possui CNH, categoria B'), true);
  assert.equal(
    sameQuestionIgnoringFillers('Há quantos anos você já usa Arquitetura de informação no trabalho?', 'Há quantos anos você já usa Arquitetura de software no trabalho?'),
    false,
  );
  const bank: AnswerEntry[] = [
    {
      id: 'm',
      questionKey: makeQuestionKey('Há quantos anos você já usa Arquitetura de informação no trabalho?', 'text'),
      question: 'Há quantos anos você já usa Arquitetura de informação no trabalho?',
      answer: '0',
      fieldType: 'text',
      source: 'manual_linkedin',
      updatedAt: '',
    },
  ];
  let aiCalls = 0;
  const fakeFetch: typeof fetch = async () => {
    aiCalls += 1;
    return new Response(okBody({ answers: [{ index: 0, status: 'answered', value: '12' }] }), { status: 200 });
  };
  const res = await solveFormStep({
    step: stepOf([field('Há quantos anos você já usa Arquitetura de software no trabalho?', 'text')]),
    knowledge: emptyKnowledgeBase(),
    resumeText: 'Arquiteto de software há 12 anos.',
    answers: bank,
    apiKey: 'k',
    unfollowCompany: true,
    todayIso: '2026-11-11',
    fetchImpl: fakeFetch,
  });
  assert.equal(aiCalls, 1, 'a pergunta nova foi para a IA em vez de herdar o "0" da outra');
  assert.equal(res.instructions[0]?.value, '12');
});

// ---------------------------------------------------------------------------------------------------------
// Página: esperar o formulário, não aprender o que a própria extensão escreve, modalidade no cartão

const DIALOG_OPEN = `<dialog data-testid="dialog" aria-labelledby="dialog-header" open>
  <button type="button" aria-label="Fechar">Fechar</button>
  <header id="dialog-header"><h2>Candidate-se à empresa Acme</h2></header>
  <div id="body"></div>
</dialog>`;

test('formulário: o diálogo abre vazio e só depois recebe campos e botão; a leitura espera em vez de dizer "0 campos, nenhum botão"', async () => {
  const { doc, win } = makeDom(`<!doctype html><html lang="pt"><body>${DIALOG_OPEN}</body></html>`);
  const early = readEasyApplyStep(doc, win);
  assert.equal(early.modalOpen, true);
  assert.equal(early.buttonKind, 'none');
  assert.match(early.diag ?? '', /Candidate-se à empresa Acme.*botões: Fechar/);

  setTimeout(() => {
    doc.getElementById('body')!.innerHTML = `<p>1 de 5 páginas</p>
      <label for="tel">Número de celular</label><input id="tel" type="tel" value="11999990000">
      <footer><button type="button">Avançar</button></footer>`;
  }, 300);
  const started = Date.now();
  const ready = await readEasyApplyStepWhenReady(doc, win, 4_000);
  assert.ok(Date.now() - started >= 250, 'esperou o conteúdo chegar');
  assert.equal(ready.buttonKind, 'next');
  assert.equal(ready.progressText, '1 de 5 páginas');
  assert.equal(ready.fields.length, 1);
  assert.equal(ready.diag, undefined);

  // Diálogo que nunca fica pronto: devolve o que há, com a descrição para o diário, quando o tempo acaba.
  const stuck = makeDom(`<!doctype html><html lang="pt"><body>${DIALOG_OPEN}</body></html>`);
  const never = await readEasyApplyStepWhenReady(stuck.doc, stuck.win, 500);
  assert.equal(never.buttonKind, 'none');
  assert.ok((never.diag ?? '').includes('Candidate-se'));

  // Sem diálogo nenhum: não fica os 8 s esperando.
  const closed = makeDom('<!doctype html><html><body><main></main></body></html>');
  const t0 = Date.now();
  const gone = await readEasyApplyStepWhenReady(closed.doc, closed.win, 8_000, 300);
  assert.equal(gone.modalOpen, false);
  assert.ok(Date.now() - t0 < 1_500);
});

test('avançar: o instante em que o diálogo fica vazio na troca de etapa não conta como etapa nova', async () => {
  const { doc, win } = makeDom(`<!doctype html><html lang="pt"><body>${DIALOG_OPEN}</body></html>`);
  const body = doc.getElementById('body')!;
  body.innerHTML = `<p>1 de 2 páginas</p><footer><button id="go" type="button">Avançar</button></footer>`;
  doc.getElementById('go')!.addEventListener('click', () => {
    body.innerHTML = '';
    setTimeout(() => {
      body.innerHTML = `<p>2 de 2 páginas</p>
        <p>Há quantos anos você já usa Python no trabalho?*</p><div><input id="q1" aria-label="Há quantos anos você já usa Python no trabalho?" type="text" value=""></div>
        <footer><button type="button">Voltar</button><button type="button">Avaliar</button></footer>`;
    }, 300);
  });
  const before = readEasyApplyStep(doc, win);
  assert.equal(before.buttonKind, 'next');
  const res = await clickStepNavigationButton(doc, win, 'next', before.signature);
  assert.equal(res.outcome, 'advanced');
  assert.equal(res.step.progressText, '2 de 2 páginas');
  assert.equal(res.step.buttonKind, 'review');
  assert.equal(res.step.fields.length, 1);
});

test('o que a extensão escreve não é "resposta digitada pela pessoa": no aviso de mudança do campo ela já está marcada como autora', async () => {
  const { doc, win } = makeDom(`<!doctype html><html lang="pt"><body>${DIALOG_OPEN}</body></html>`);
  doc.getElementById('body')!.innerHTML = `<p>4 de 5 páginas</p>
    <p>Há quantos anos você já usa Python no trabalho?*</p><div><input id="q1" aria-label="Há quantos anos você já usa Python no trabalho?" type="text" value=""></div>
    <footer><button type="button">Avaliar</button></footer>`;
  const step = readEasyApplyStep(doc, win);
  const seen: Array<{ own: boolean; writing: boolean }> = [];
  doc.addEventListener(
    'change',
    (ev) => {
      const target = ev.target as HTMLInputElement;
      seen.push({ own: wasWrittenByExtension(target, target.value.trim()), writing: isExtensionWriting() });
    },
    true,
  );
  await applyFieldInstructions(doc, win, [{ fieldId: step.fields[0]!.fieldId, value: '12' }]);
  assert.equal((doc.getElementById('q1') as HTMLInputElement).value, '12');
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((s) => s.own && s.writing), JSON.stringify(seen));
});

test('descartar: fecha o formulário mesmo quando o aviso "Salvar esta candidatura?" vem DEPOIS dele na página; nunca clica em Salvar', async () => {
  for (const order of ['depois', 'antes'] as const) {
    const { doc, win } = makeDom(`<!doctype html><html lang="pt"><body>${DIALOG_OPEN}</body></html>`);
    const form = doc.querySelector('dialog')!;
    doc.getElementById('body')!.innerHTML = '<p>1 de 5 páginas</p><footer><button type="button">Avançar</button></footer>';
    let saved = false;
    let closeClicks = 0;
    form.querySelector('[aria-label="Fechar"]')!.addEventListener('click', () => {
      closeClicks += 1;
      if (doc.getElementById('ask')) return;
      setTimeout(() => {
        const ask = doc.createElement('dialog');
        ask.id = 'ask';
        ask.setAttribute('open', '');
        ask.innerHTML = '<h2>Salvar esta candidatura?</h2><button id="no" type="button">Descartar</button><button id="yes" type="button">Salvar</button>';
        if (order === 'depois') form.after(ask);
        else form.before(ask);
        ask.querySelector('#yes')!.addEventListener('click', () => {
          saved = true;
        });
        ask.querySelector('#no')!.addEventListener('click', () => {
          ask.remove();
          form.remove();
        });
      }, 200);
    });
    const closed = await dismissAllOpenDialogs(doc, win, 'discard');
    assert.equal(closed, true, `aviso ${order} do formulário`);
    assert.equal(doc.querySelectorAll('dialog').length, 0);
    assert.equal(saved, false);
    assert.equal(closeClicks, 1, 'o X é clicado uma vez só; depois espera o aviso aparecer');
  }
});

test('formulário que sobrou aberto de outra vaga nunca é aproveitado: ou fecha, ou a vaga é deixada', async () => {
  const { doc, win } = makeDom(`<!doctype html><html lang="pt"><body>
    <div role="button" componentkey="job-card-component-ref-3900000002"><div>Coordenador Comercial</div><div>Empresa Beta</div></div>
    <main><p><a href="/jobs/view/3900000002/">Coordenador Comercial</a></p>
      <button type="button" aria-label="Usar a candidatura simplificada para esta vaga">Candidatura simplificada</button></main>
    <dialog data-testid="dialog" aria-labelledby="dialog-header" open>
      <header id="dialog-header"><h2>Candidate-se à empresa Outra Empresa</h2></header>
      <p>1 de 5 páginas</p><footer><button type="button">Avançar</button></footer>
    </dialog>
  </body></html>`);
  // Este diálogo não tem X nem "Descartar": não dá para fechar. A resposta tem de ser "bloqueado", nunca "já aberto".
  assert.equal(await clickEasyApplyForJob(doc, win, '3900000002'), 'blocked_by_dialog');
});

test('vaga aberta: numa lista, com o painel ainda vazio, a vaga NÃO é lida pelo endereço (em qualquer endereço de busca)', () => {
  const list = `<div role="button" componentkey="job-card-component-ref-3900000001"><div>Analista</div><div>Empresa Alfa</div></div>
    <div role="button" componentkey="job-card-component-ref-3900000002"><div>Coordenador</div><div>Empresa Beta</div></div>`;
  for (const url of [
    'https://www.linkedin.com/jobs/search/?currentJobId=3900000002&f_AL=true',
    'https://www.linkedin.com/jobs/search-results/?currentJobId=3900000002',
    'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3900000002',
  ]) {
    // O endereço já diz 3900000002, mas o painel está vazio.
    const empty = makeDom(`<!doctype html><html><body>${list}<main><div id="detail"></div></main></body></html>`, url);
    assert.equal(readOpenJobSnapshot(empty.doc, empty.win).jobId, null, url);
    // O endereço já diz 3900000002, mas o painel ainda mostra a vaga ANTERIOR, com o botão dela.
    const stale = makeDom(
      `<!doctype html><html><body>${list}<main><p><a href="/jobs/view/3900000001/">Analista</a></p>
        <button type="button" aria-label="Usar a candidatura simplificada para esta vaga">Candidatura simplificada</button></main></body></html>`,
      url,
    );
    assert.equal(readOpenJobSnapshot(stale.doc, stale.win).jobId, '3900000001', url);
    assert.equal(findEasyApplyButton(stale.doc, stale.win, '3900000002'), null, 'o botão da vaga anterior não serve para a vaga pedida');
  }
  // Página de UMA vaga, sem lista: aí o endereço vale.
  const single = makeDom(
    `<!doctype html><html><body><main><h1>Coordenador</h1>
      <button type="button" aria-label="Candidatura simplificada à vaga">Candidatura simplificada</button></main></body></html>`,
    'https://www.linkedin.com/jobs/view/3900000002/',
  );
  const snap = readOpenJobSnapshot(single.doc, single.win);
  assert.equal(snap.jobId, '3900000002');
  assert.equal(snap.hasEasyApply, true);
});

test('tipo de página: fora da área de vagas nada é vaga (um post do feed com link para vaga não é cartão)', () => {
  const feed = makeDom(
    '<!doctype html><html><body><div><p>Fulano compartilhou uma vaga</p><a href="/jobs/view/4100000099/">Empresa X (Remoto) Ver vaga</a></div></body></html>',
    'https://www.linkedin.com/feed/foryou/',
  );
  assert.equal(jobsPageKind(feed.doc, feed.win), 'other');
  const list = makeDom('<!doctype html><html><body><div role="button" componentkey="job-card-component-ref-3900000001"><div>A</div><div>B</div></div></body></html>', 'https://www.linkedin.com/jobs/search-results/?keywords=x');
  assert.equal(jobsPageKind(list.doc, list.win), 'list');
  const single = makeDom('<!doctype html><html><body><main><h1>Vaga</h1></main></body></html>', 'https://www.linkedin.com/jobs/view/3900000002/');
  assert.equal(jobsPageKind(single.doc, single.win), 'job');
});

test('a aba ainda está na lista do envio? página de vaga solta e feed não são a lista; formulário aberto sobre a lista é', () => {
  const listUrl = 'https://www.linkedin.com/jobs/search-results/?keywords=arquiteto&f_AL=true';
  const card = (jobId: string) => ({ jobId, title: 't', company: 'c', locationText: '', alreadyAppliedOnCard: false });
  const seen = new Set(['1', '2']);
  const data = (pageKind: 'list' | 'job' | 'other', url: string, ids: string[]) => ({ cards: ids.map(card), isSearchPage: pageKind !== 'other', pageKind, url, diag: '' });
  assert.equal(isStillOnList(listUrl, data('list', 'https://www.linkedin.com/jobs/search-results/?keywords=arquiteto&currentJobId=3', ['1', '2', '3']), seen), true);
  assert.equal(isStillOnList(listUrl, data('list', 'https://www.linkedin.com/jobs/search/?keywords=arquiteto', ['1', '2', '3']), seen), true, 'busca antiga e nova são a mesma lista');
  assert.equal(isStillOnList(listUrl, data('list', 'https://www.linkedin.com/jobs/search-results/?keywords=outra+coisa', ['7', '8']), seen), false, 'outra busca');
  assert.equal(isStillOnList(listUrl, data('list', 'https://www.linkedin.com/jobs/collections/recommended/', ['7', '8']), seen), false, 'outra lista');
  assert.equal(isStillOnList(listUrl, data('other', 'https://www.linkedin.com/feed/', []), seen), false, 'feed');
  assert.equal(isStillOnList(listUrl, data('job', 'https://www.linkedin.com/jobs/view/9/', ['9']), seen), false, 'página de uma vaga só');
  assert.equal(isStillOnList(listUrl, data('job', 'https://www.linkedin.com/jobs/view/9/', ['9', '10', '11']), seen), false, 'vaga solta com "vagas parecidas" embaixo');
  assert.equal(isStillOnList(listUrl, data('job', 'https://www.linkedin.com/jobs/view/2/', ['1', '2', '3']), seen), true, 'formulário aberto sobre a nossa lista');
});

test('vaga de site externo: o botão "Candidatar-se" é um link, o topo diz "fora do LinkedIn", e a etiqueta "Remoto" não é o título', () => {
  const { doc, win } = makeDom(
    `<!doctype html><html><body>
      <div role="button" componentkey="job-card-component-ref-3900000001"><div>Outra vaga</div><div>Empresa Alfa</div></div>
      <div role="button" componentkey="job-card-component-ref-3900000002"><div>CTO</div><div>Empresa Externa</div></div>
      <main><div>
        <a href="/company/empresa-externa/">Empresa Externa</a>
        <p>CTO (Cyber Security) - Remote Work</p>
        <p>Curitiba e Região · Promovida por quem está contratando · Respostas gerenciadas fora do LinkedIn</p>
        <a href="/jobs/view/3900000002/">Remoto</a>
        <a href="https://externo.example/vaga">Candidatar-se</a><button type="button">Salvar</button>
      </div></main>
    </body></html>`,
    'https://www.linkedin.com/jobs/search-results/?currentJobId=3900000002',
  );
  const snap = readOpenJobSnapshot(doc, win);
  assert.equal(snap.jobId, '3900000002');
  assert.equal(snap.hasEasyApply, false);
  assert.equal(snap.hasExternalApply, true);
  assert.equal(snap.title, '', 'a etiqueta "Remoto" não vira título (o envio usa o título do cartão)');
});

test('cartão da lista: a modalidade escrita entre parênteses na linha do local vai junto; texto solto não conta', () => {
  const { doc, win } = makeDom(`<!doctype html><html><body>
    <div role="button" componentkey="job-card-component-ref-3900000001"><div>Analista Remoto de Dados</div><div>Empresa Alfa</div><div>São Paulo, SP (Híbrido)</div></div>
    <div role="button" componentkey="job-card-component-ref-3900000002"><div>Coordenador Comercial</div><div>Empresa Beta</div><div>Brasil (Remoto)</div></div>
    <div role="button" componentkey="job-card-component-ref-3900000003"><div>Gerente</div><div>Empresa Gama</div><div>Curitiba, PR</div></div>
    <main></main>
  </body></html>`);
  const cards = listJobCards(doc, win);
  assert.deepEqual(cards.map((c) => c.workMode), ['hybrid', 'remote', null]);
});

// ---------------------------------------------------------------------------------------------------------
// Envio: com um Chrome de mentira (armazenamento, abas e a página respondendo às mensagens)

interface FakeTab {
  id: number;
  url: string;
  status: string;
  active: boolean;
  windowId: number;
}

function installFakeChrome(onMessage: (tab: FakeTab, msg: { type: string } & Record<string, unknown>) => unknown) {
  const store = new Map<string, unknown>();
  const tabs = new Map<number, FakeTab>();
  const keysOf = (keys: string | string[]): string[] => (typeof keys === 'string' ? [keys] : keys);
  const fake = {
    storage: {
      local: {
        get: async (keys: string | string[]) => Object.fromEntries(keysOf(keys).filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))])),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) store.set(k, JSON.parse(JSON.stringify(v)));
        },
        remove: async (keys: string | string[]) => {
          for (const k of keysOf(keys)) store.delete(k);
        },
      },
    },
    runtime: { getPlatformInfo: async () => ({}) },
    windows: { update: async () => ({}) },
    scripting: { insertCSS: async () => undefined, executeScript: async () => undefined },
    tabs: {
      get: async (id: number) => tabs.get(id),
      query: async (q: { url?: string[]; active?: boolean }) => [...tabs.values()].filter((t) => (q.url ? t.url.includes('linkedin.com') : q.active ? t.active : true)),
      update: async (id: number, props: Partial<FakeTab>) => Object.assign(tabs.get(id)!, props),
      create: async (props: Partial<FakeTab>) => {
        const tab: FakeTab = { id: 900 + tabs.size, url: props.url ?? '', status: 'complete', active: true, windowId: 1 };
        tabs.set(tab.id, tab);
        return tab;
      },
      sendMessage: async (tabId: number, msg: { type: string } & Record<string, unknown>) => onMessage(tabs.get(tabId)!, msg),
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return { store, tabs };
}

async function waitForFinished(timeoutMs: number): Promise<AppState> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = await loadState();
    if (st.run.status === 'finished' && st.run.finishedAt) return st;
    if (Date.now() > end) throw new Error(`o envio não terminou: ${st.run.diary.join('\n')}`);
    await sleep(100);
  }
}

test('guardado: o PDF do currículo sai do estado (era regravado a cada passo) e continua disponível na chave dele', async () => {
  const { store } = installFakeChrome(() => undefined);
  const old = { ...defaultAppState(), resume: { fileName: 'cv.pdf', text: 'texto do currículo', pdfBase64: 'QUJD', updatedAt: '2026-11-10' } };
  store.set(STORAGE_KEY, old);
  assert.equal(await loadResumePdf(), 'QUJD', 'antes de qualquer gravação, o PDF é achado no estado antigo');
  await updateState((st) => ({ ...st, settings: { ...st.settings, maxJobs: 7 } }));
  const saved = store.get(STORAGE_KEY) as AppState;
  assert.equal(saved.settings.maxJobs, 7);
  assert.equal(saved.resume?.text, 'texto do currículo');
  assert.equal('pdfBase64' in (saved.resume ?? {}), false);
  assert.equal(store.get(RESUME_PDF_KEY), 'QUJD');
  assert.equal(await loadResumePdf(), 'QUJD');
});

test('envio interrompido: ao acordar com um envio marcado como "rodando" e nenhum em andamento, fecha com o motivo escrito', async () => {
  const { store } = installFakeChrome(() => undefined);
  const base = defaultAppState();
  store.set(STORAGE_KEY, { ...base, run: { ...base.run, status: 'running', startedAt: '2026-11-11T01:17:31Z', diary: ['[+179.6s] Lendo Additional Questions'] } });
  await recoverInterruptedRun();
  const st = await loadState();
  assert.equal(st.run.status, 'finished');
  assert.match(st.run.finishReason ?? '', /Interrompido: o Chrome desligou a extensão/);
  assert.match(st.run.diary[st.run.diary.length - 1] ?? '', /^\[fim\] Interrompido/);
  assert.ok(st.run.finishedAt);

  // Envio já terminado não é tocado; e "Parar" sem envio em andamento fecha com data e motivo.
  await recoverInterruptedRun();
  assert.equal((await loadState()).run.diary.length, 2);
  store.set(STORAGE_KEY, { ...base, run: { ...base.run, status: 'running' } });
  await stopBatchRunner();
  const stopped = await loadState();
  assert.equal(stopped.run.status, 'finished');
  assert.equal(stopped.run.finishReason, 'Parado a seu pedido.');
});

for (const start of [
  { name: 'no feed', url: 'https://www.linkedin.com/feed/', why: /Esta aba não mostra uma lista de vagas .*Abrindo a busca de vagas/ },
  { name: 'na página de uma vaga só (de site externo)', url: 'https://www.linkedin.com/jobs/view/4100000099/?trackingId=x', why: /Esta aba mostra uma vaga só, não uma lista\. Abrindo a busca de vagas/ },
])
test(`envio de ponta a ponta, com a aba ${start.name}: abre a busca sozinho, pula pelo cartão a modalidade não aceita, volta para a lista se a página sair dela (simulação)`, async () => {
  const messages: string[] = [];
  let formStep = 0;
  const cards = [
    { jobId: '3900000001', title: 'Analista Financeiro', company: 'Empresa Alfa', locationText: 'São Paulo, SP (Híbrido)', alreadyAppliedOnCard: false, workMode: 'hybrid' },
    { jobId: '3900000002', title: 'Coordenador Comercial', company: 'Empresa Beta', locationText: 'Brasil (Remoto)', alreadyAppliedOnCard: false, workMode: 'remote' },
    { jobId: '3900000003', title: 'Gerente Comercial', company: 'Empresa Gama', locationText: 'Brasil (Remoto)', alreadyAppliedOnCard: false, workMode: 'remote' },
  ];
  let discards = 0;
  const salaryStep = { ...stepOf([field('Qual a sua pretensão salarial?', 'text')]), signature: 'p4' };
  const reviewStep = { ...stepOf([]), signature: 'p5', stepTitle: 'Revise sua candidatura', progressText: '5 de 5 páginas', buttonKind: 'submit' as const, buttonLabel: 'Enviar candidatura' };

  const { store, tabs } = installFakeChrome((tab, msg) => {
    messages.push(msg.type);
    const onSearch = tab.url.includes('/jobs/search');
    switch (msg.type) {
      case 'LIST_CARDS': {
        // Na página de uma vaga só, a página devolve um "cartão" (a própria vaga); no feed, nada.
        const onJob = tab.url.includes('/jobs/view/');
        const single = { jobId: '4100000099', title: 'Remoto', company: 'Empresa Externa', locationText: '', alreadyAppliedOnCard: false, workMode: null };
        return {
          ok: true,
          data: {
            cards: onSearch ? cards : onJob ? [single] : [],
            isSearchPage: onSearch || onJob,
            pageKind: onSearch ? 'list' : onJob ? 'job' : 'other',
            url: tab.url,
            diag: `url=${new URL(tab.url).pathname}`,
          },
        };
      }
      case 'DISMISS_ALL_DIALOGS':
        // Como no LinkedIn real em 2026-11-11: ao descartar o formulário (aqui, o fim da 1ª simulação), a aba volta para o feed.
        if (formStep === 1) {
          discards += 1;
          formStep = 0;
          if (discards === 1) tab.url = 'https://www.linkedin.com/feed/';
        }
        return { ok: true, data: { closed: true } };
      case 'OPEN_CARD':
        if (!onSearch) throw new Error('fora da lista de vagas nenhuma vaga pode ser aberta');
        return { ok: true, data: { clicked: true, openJob: { jobId: msg.jobId, title: cards.find((c) => c.jobId === msg.jobId)!.title, company: 'Empresa', workMode: 'remote', alreadyApplied: false, hasEasyApply: true, descriptionSnippet: '' } } };
      case 'CLICK_EASY_APPLY':
        return { ok: true, data: { outcome: 'opened' } };
      case 'READ_FORM_STEP':
        return { ok: true, data: { step: formStep === 0 ? salaryStep : reviewStep } };
      case 'APPLY_FIELDS':
        return { ok: true, data: { appliedCount: (msg.instructions as unknown[]).length, errors: [] } };
      case 'CLICK_STEP_BUTTON':
        if (msg.kind === 'submit') throw new Error('em simulação nunca se clica em Enviar candidatura');
        formStep = 1;
        return { ok: true, data: { outcome: 'advanced', pageErrors: [], step: reviewStep } };
      default:
        return { ok: true, data: {} };
    }
  });
  tabs.set(7, { id: 7, url: start.url, status: 'complete', active: true, windowId: 1 });
  const base = defaultAppState();
  store.set(STORAGE_KEY, {
    ...base,
    knowledge: { ...base.knowledge, targetRole: 'Arquiteto de Soluções', salaryExpectation: '18000' },
    settings: { ...base.settings, maxJobs: 2, simulateOnly: true, acceptedWorkModes: ['remote'], pauseAfterSubmitSec: 0, pauseAfterSkipSec: 0 },
  });

  assert.deepEqual(startBatchRunner(7), { started: true });
  const st = await waitForFinished(20_000);
  const diary = st.run.diary.join('\n');

  assert.match(tabs.get(7)!.url, /^https:\/\/www\.linkedin\.com\/jobs\/search\/\?f_AL=true&keywords=Arquiteto/);
  assert.match(diary, start.why);
  assert.equal(diary.includes('Abrindo vaga 4100000099'), false, 'a vaga solta em que a aba estava não foi tratada como lista');
  assert.match(diary, /Cartão "Analista Financeiro" é Híbrido \(fora do seu filtro\) — pulando sem abrir/);
  assert.match(diary, /Campo "Qual a sua pretensão salarial\?" -> \[knowledge\] 18000/);
  assert.match(diary, /Modo simulação/);
  assert.match(diary, /A página saiu da lista de vagas \(url=\/feed\/\)\. Voltando para a lista para continuar/);
  assert.match(diary, /Abrindo vaga 3900000003: "Gerente Comercial"/);
  assert.match(diary, /FIM DA RODADA/);
  assert.equal(st.run.counts.simulated, 2, 'depois de voltar para a lista, a vaga seguinte foi feita');
  assert.equal(st.run.counts.skipped, 1);
  assert.equal(st.run.counts.opened, 2, 'a vaga híbrida não chegou a ser aberta');
  assert.equal(messages.filter((m) => m === 'OPEN_CARD').length, 2);
  assert.match(tabs.get(7)!.url, /\/jobs\/search\//, 'a aba terminou na lista de vagas');
});
