import assert from 'node:assert/strict';
import test from 'node:test';
import { callGeminiJson, rankGeminiModels, resetGeminiModelMemory } from '../src/core/gemini.ts';
import { generateKnowledgeBaseFromResume } from '../src/core/knowledge.ts';
import { solveFormStep } from '../src/core/solver.ts';
import { emptyKnowledgeBase } from '../src/shared/storage.ts';
import { makeQuestionKey } from '../src/shared/normalize.ts';
import type { FormStepSnapshot } from '../src/shared/types.ts';

test('rankGeminiModels prioriza Flash-Lite em 1º lugar para máxima velocidade e ignora modelos de imagem/áudio', () => {
  const ranked = rankGeminiModels([
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/imagen-3.0-generate', supportedGenerationMethods: ['generateContent'] },
  ]);

  assert.equal(ranked[0], 'gemini-2.5-flash-lite');
  assert.equal(ranked[1], 'gemini-2.5-flash');
  assert.equal(ranked[2], 'gemini-2.0-flash');
  assert.equal(ranked.length, 3);
});

test('callGeminiJson desliga thinkingBudget no gemini-2.5-flash e faz fallback automático em 404/429', async () => {
  resetGeminiModelMemory();
  const calls: Array<{ model: string; body: Record<string, unknown> }> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    const m = /models\/([^:]+):generateContent/.exec(u)?.[1] ?? '';
    const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ model: m, body: parsedBody });
    if (m === 'gemini-inexistente') {
      return new Response(JSON.stringify({ error: { message: 'Model not found' } }), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '```json\n{"okTest": true}\n```' }] } }],
      }),
      { status: 200 },
    );
  };

  const res = await callGeminiJson<{ okTest: boolean }>({
    apiKey: 'AIzaFakeKey123',
    preferredModel: 'gemini-inexistente',
    // Modelo escolhido pela pessoa na lista: é tentado primeiro, e o seguinte entra quando ele falha.
    userPickedModel: true,
    discoveredModels: ['gemini-2.5-flash'],
    prompt: 'teste',
    fetchImpl: fakeFetch,
  });

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.modelUsed, 'gemini-2.5-flash');
    assert.equal(res.data.okTest, true);
  }
  assert.equal(calls.length, 2);
  const genCfg = calls[1]?.body.generationConfig as { thinkingConfig?: { thinkingBudget?: number } };
  assert.equal(genCfg?.thinkingConfig?.thinkingBudget, 0);
});

test('generateKnowledgeBaseFromResume monta a ficha preservando pretensão salarial já definida pela pessoa', async () => {
  const base = emptyKnowledgeBase();
  base.salaryExpectation = '9500';

  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    fullName: 'Ana Exemplo',
                    email: 'ana@exemplo.com',
                    phone: '11988887777',
                    city: 'São Paulo',
                    state: 'SP',
                    targetRole: 'Analista de Dados',
                    seniority: 'Pleno',
                    totalYearsExperience: 5,
                    skills: [
                      { name: 'Python', years: 5 },
                      { name: 'SQL', years: 4 },
                    ],
                    experiences: [
                      {
                        role: 'Analista de Dados',
                        company: 'Empresa X',
                        period: '2021-11 a Atual',
                        years: 5,
                        summary: 'Dashboards e automação',
                      },
                    ],
                    languages: [{ language: 'Inglês', level: 'Avançado' }],
                    summary: 'Analista de dados com 5 anos de experiência.',
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );

  const out = await generateKnowledgeBaseFromResume({
    apiKey: 'AIzaFake',
    resumeText: 'Currículo completo de Ana Exemplo com mais de quarenta caracteres para leitura.',
    existing: base,
    todayIso: '2026-11-10',
    fetchImpl: fakeFetch,
  });

  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.knowledge.fullName, 'Ana Exemplo');
    assert.equal(out.knowledge.salaryExpectation, '9500');
    assert.equal(out.knowledge.skills[0]?.name, 'Python');
    assert.equal(out.knowledge.skills[0]?.years, 5);
  }
});

test('solveFormStep responde em 0ms habilidades/idiomas/salário/híbrido pela Ficha e só envia à IA o que realmente falta', async () => {
  const kb = emptyKnowledgeBase();
  kb.salaryExpectation = 'R$ 8.500,00';
  kb.acceptedWorkModes = ['remote', 'hybrid'];
  kb.skills = [{ name: 'Python', years: 5 }];
  kb.languages = [{ language: 'Inglês', level: 'Avançado' }];

  const step: FormStepSnapshot = {
    modalOpen: true,
    signature: 'step-4',
    stepTitle: 'Perguntas adicionais',
    progressText: '4 de 5 páginas',
    buttonKind: 'review',
    buttonLabel: 'Avaliar',
    hasResumeCards: false,
    resumeSelected: true,
    pageErrors: [],
    fields: [
      {
        fieldId: 'f1',
        questionKey: makeQuestionKey('Qual a sua pretensão salarial para essa oportunidade?', 'text'),
        label: 'Qual a sua pretensão salarial para essa oportunidade?',
        type: 'text',
        required: true,
        currentValue: '',
        options: [],
      },
      {
        fieldId: 'f2',
        questionKey: makeQuestionKey('Você trabalharia em um modelo híbrido?', 'radio'),
        label: 'Você trabalharia em um modelo híbrido?',
        type: 'radio',
        required: true,
        currentValue: '',
        options: [
          { id: '0:sim', label: 'Sim' },
          { id: '1:nao', label: 'Não' },
        ],
      },
      {
        fieldId: 'f3',
        questionKey: makeQuestionKey('Há quantos anos você já usa Python no trabalho?', 'text'),
        label: 'Há quantos anos você já usa Python no trabalho?',
        type: 'text',
        required: true,
        currentValue: '',
        options: [],
      },
      {
        fieldId: 'f4',
        questionKey: makeQuestionKey('Qual seu nível de Inglês?', 'select'),
        label: 'Qual seu nível de Inglês?',
        type: 'select',
        required: true,
        currentValue: '',
        options: [
          { id: 'basico', label: 'Básico' },
          { id: 'avancado', label: 'Avançado' },
        ],
      },
      {
        fieldId: 'f5',
        questionKey: makeQuestionKey('Você possui certificação CPA-20 ativa?', 'radio'),
        label: 'Você possui certificação CPA-20 ativa?',
        type: 'radio',
        required: true,
        currentValue: '',
        options: [
          { id: '0:sim', label: 'Sim' },
          { id: '1:nao', label: 'Não' },
        ],
      },
    ],
  };

  let questionsSentToGemini = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const promptObj = JSON.parse(body.contents[0].parts[0].text);
    questionsSentToGemini = promptObj.questionsToAnswer.length;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    answers: [
                      { index: 0, status: 'unknown', value: '', reason: 'Certificação CPA-20 não mencionada no currículo' },
                    ],
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  };

  const res = await solveFormStep({
    step,
    knowledge: kb,
    resumeText: 'Experiência de 5 anos com Python.',
    answers: [],
    apiKey: 'AIzaFake',
    unfollowCompany: true,
    todayIso: '2026-11-10',
    fetchImpl: fakeFetch,
  });

  // f1, f2, f3 e f4 foram respondidas localmente em 0ms sem ir para a IA! Só f5 foi enviada!
  assert.equal(questionsSentToGemini, 1);
  assert.equal(res.instructions.find((i) => i.fieldId === 'f1')?.value, '8500');
  assert.equal(res.instructions.find((i) => i.fieldId === 'f2')?.optionLabel, 'Sim');
  assert.equal(res.instructions.find((i) => i.fieldId === 'f3')?.value, '5');
  assert.equal(res.instructions.find((i) => i.fieldId === 'f4')?.optionLabel, 'Avançado');
  assert.equal(res.missingRequired.length, 1);
  assert.equal(res.missingRequired[0]?.question, 'Você possui certificação CPA-20 ativa?');
  assert.deepEqual(res.missingRequired[0]?.options, ['Sim', 'Não']);
});

test('Quando só Remoto está marcado, perguntas de ir ao escritório (em pt, en ou chinês) respondem Não/No/否 mesmo se a IA já tinha guardado Sim antes', async () => {
  const kb = emptyKnowledgeBase();
  kb.acceptedWorkModes = ['remote']; // Só Remoto!

  const chineseQ = '您是否愿意到此工作地点上班？';
  const englishQ = 'Are you comfortable commuting to this job\'s location?';
  const ptHybridQ = 'Você trabalharia em um modelo híbrido?';

  const step: FormStepSnapshot = {
    modalOpen: true,
    signature: 'step-commute',
    stepTitle: 'Perguntas adicionais',
    progressText: '3 de 4 páginas',
    buttonKind: 'review',
    buttonLabel: 'Avaliar',
    hasResumeCards: false,
    resumeSelected: true,
    pageErrors: [],
    fields: [
      {
        fieldId: 'c1',
        questionKey: makeQuestionKey(chineseQ, 'radio'),
        label: chineseQ,
        type: 'radio',
        required: true,
        currentValue: '',
        options: [
          { id: 'yes_zh', label: '是' },
          { id: 'no_zh', label: '否' },
        ],
      },
      {
        fieldId: 'c2',
        questionKey: makeQuestionKey(englishQ, 'radio'),
        label: englishQ,
        type: 'radio',
        required: true,
        currentValue: '',
        options: [
          { id: 'yes_en', label: 'Yes' },
          { id: 'no_en', label: 'No' },
        ],
      },
      {
        fieldId: 'c3',
        questionKey: makeQuestionKey(ptHybridQ, 'radio'),
        label: ptHybridQ,
        type: 'radio',
        required: true,
        currentValue: '',
        options: [
          { id: 'yes_pt', label: 'Sim' },
          { id: 'no_pt', label: 'Não' },
        ],
      },
    ],
  };

  // Mesmo existindo no banco a resposta antiga da IA ("是"), ela é ignorada porque o filtro atual é só Remoto!
  const oldAiBank = [
    {
      id: 'old_1',
      questionKey: makeQuestionKey(chineseQ, 'radio'),
      question: chineseQ,
      answer: '是',
      fieldType: 'radio' as const,
      source: 'ai' as const,
      updatedAt: '2026-11-11T09:00:00Z',
    },
  ];

  const res = await solveFormStep({
    step,
    knowledge: kb,
    resumeText: 'Arquiteto de Soluções Sênior.',
    answers: oldAiBank,
    apiKey: 'AIzaFake',
    unfollowCompany: true,
    todayIso: '2026-11-11',
  });

  assert.equal(res.aiCallMade, false);
  assert.equal(res.instructions.find((i) => i.fieldId === 'c1')?.optionLabel, '否');
  assert.equal(res.instructions.find((i) => i.fieldId === 'c2')?.optionLabel, 'No');
  assert.equal(res.instructions.find((i) => i.fieldId === 'c3')?.optionLabel, 'Não');
});
