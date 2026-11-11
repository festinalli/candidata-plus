// Roda a extensão DE VERDADE (serviço, painel e script da página) num Chromium de verdade, contra uma página de mentira
// que imita o LinkedIn (scripts/fake-linkedin.html). Nada sai para o LinkedIn: todo endereço linkedin.com é respondido
// daqui mesmo. Prova que as peças funcionam juntas no navegador; NÃO prova o LinkedIn real.
//
// Uso: npm run e2e   (na primeira vez: npx playwright install chromium)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pathToExtension = path.join(ROOT, 'dist');
const fakePage = fs.readFileSync(path.join(ROOT, 'scripts', 'fake-linkedin.html'), 'utf8');
const STATE_KEY = 'candidata_plus_v2_state';

const failures = [];
const check = (ok, text) => {
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${text}`);
  if (!ok) failures.push(text);
};

const ctx = await chromium.launchPersistentContext('', {
  // O Chromium que vem com o Playwright (o Chrome comum não aceita carregar extensão por linha de comando).
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: false,
  viewport: { width: 1200, height: 860 },
  args: ['--headless=new', `--disable-extensions-except=${pathToExtension}`, `--load-extension=${pathToExtension}`],
});

try {
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fakePage }));

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10_000 });
  const extId = sw.url().split('/')[2];

  const errors = [];
  const li = await ctx.newPage();
  li.on('pageerror', (e) => errors.push(`página: ${e.message}`));
  // A aba começa na página de UMA vaga de site externo (caso visto num teste real), não numa lista.
  await li.goto('https://www.linkedin.com/jobs/view/4100000099/');

  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => errors.push(`painel: ${e.message}`));
  panel.on('console', (m) => {
    if (m.type() === 'error') errors.push(`painel console: ${m.text()}`);
  });
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await panel.waitForSelector('#btn-start-batch');

  const readState = () => panel.evaluate((key) => chrome.storage.local.get(key).then((r) => r[key]), STATE_KEY);

  // Ficha de teste (sem chave da IA: o que não der para responder pela Ficha tem de virar "Responda 1 vez").
  await panel.evaluate(
    ([key]) =>
      chrome.storage.local.set({
        [key]: {
          knowledge: {
            fullName: 'Pessoa de Teste',
            targetRole: 'Arquiteto de Soluções',
            skills: [{ name: 'Python', years: 8 }],
            languages: [{ language: 'Inglês', level: 'Avançado' }],
            acceptedWorkModes: ['remote'],
          },
          settings: { maxJobs: 2, simulateOnly: false, unfollowCompany: true, acceptedWorkModes: ['remote'], pauseAfterSubmitSec: 2, pauseAfterSkipSec: 0.4 },
        },
      }),
    [STATE_KEY],
  );
  await panel.waitForFunction(() => document.getElementById('set-max-jobs').value === '2');

  check((await panel.textContent('#app-version')) === 'v2.3.0', 'o painel mostra a versão v2.3.0');

  // Pretensão salarial pelo campo novo do Passo 3.
  await panel.fill('#quick-salary', '18000');
  await panel.dispatchEvent('#quick-salary', 'change');
  await panel.waitForFunction((key) => chrome.storage.local.get(key).then((r) => r[key]?.knowledge?.salaryExpectation === '18000'), STATE_KEY);
  check(true, 'a pretensão salarial digitada no Passo 3 foi guardada na Ficha');

  const started = Date.now();
  await panel.click('#btn-start-batch');

  let state;
  for (;;) {
    state = await readState();
    if (state?.run?.status === 'finished' && state.run.finishedAt) break;
    if (Date.now() - started > 120_000) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const run = state?.run ?? { counts: {}, diary: [] };
  const diary = (run.diary ?? []).join('\n');
  console.log('\n--- diário do envio no Chromium ---\n' + diary + '\n-----------------------------------\n');

  const page = await li.evaluate(() => ({ submitted: window.__submitted, filled: window.__filled, saved: window.__savedDraft, headers: window.__headers, url: location.href, dialogs: document.querySelectorAll('dialog').length }));

  check(run.status === 'finished' && Boolean(run.finishedAt), `o envio terminou sozinho (${seconds} s)`);
  check(/Esta aba mostra uma vaga só, não uma lista\. Abrindo a busca de vagas/.test(diary) && page.url.includes('/jobs/search/'), 'a aba estava na página de uma vaga só (de site externo) e a extensão abriu a busca de vagas sozinha');
  check(!/Abrindo vaga 4100000099/.test(diary), 'a vaga solta não foi tratada como lista de vagas');
  check(/Cartão "Analista Financeiro" é Híbrido .* pulando sem abrir/.test(diary), 'a vaga híbrida foi pulada pelo cartão, sem abrir');
  check(JSON.stringify(page.submitted) === JSON.stringify(['4100000002', '4100000004']), `candidaturas enviadas na página de mentira: ${JSON.stringify(page.submitted)}`);
  check(run.counts.applied === 2 && run.counts.needsAnswer === 1 && run.counts.skipped === 1 && run.counts.failed === 0, `contadores: ${JSON.stringify(run.counts)}`);
  const f2 = page.filled['4100000002'] ?? {};
  check(f2.salary === '18000' && f2.hybrid === 'Não' && f2.python === '8' && f2.follow === false, `vaga 2 preenchida pela Ficha: ${JSON.stringify(f2)}`);
  const f4 = page.filled['4100000004'] ?? {};
  check(f4.salary === '18000' && f4.english === 'Avançado' && f4.follow === false, `vaga 4 (salário perguntado de outro jeito, lista de idioma): ${JSON.stringify(f4)}`);
  check(!/0 campo\(s\), botão "none"/.test(diary) && !/Nenhum botão de avanço/.test(diary), 'nenhuma etapa foi lida vazia (o diálogo abre vazio e é preenchido 0,9 s depois)');
  check(page.saved === false && page.dialogs === 0, 'o rascunho da vaga sem resposta foi DESCARTADO (nunca salvo) e nenhum diálogo ficou aberto');
  check(/A página saiu da lista de vagas .*Voltando para a lista/.test(diary), 'ao descartar, a aba foi parar no feed; a extensão voltou para a lista e continuou');
  check(!/4489000000/.test(diary), 'o post do feed com link de vaga não foi tratado como vaga');
  check(/Cabeçalho do formulário: "Candidate-se à empresa Empresa Delta"/.test(diary), 'depois do descarte, a vaga seguinte abriu o formulário DELA');
  const pending = state?.pending ?? [];
  check(pending.length === 1 && pending[0].question === 'Você possui CNH categoria B?' && JSON.stringify(pending[0].options) === JSON.stringify(['Sim', 'Não']), `"Responda 1 vez": ${JSON.stringify(pending.map((p) => [p.question, p.options]))}`);
  const manual = (state?.answers ?? []).filter((a) => a.source === 'manual_linkedin');
  check(manual.length === 0, `o que a extensão escreveu não foi guardado como "digitado pela pessoa" (${manual.length} entrada(s))`);
  check(errors.length === 0, `sem erros de página ou de painel: ${JSON.stringify(errors)}`);

  // O serviço da extensão é desligado com um envio marcado como "rodando": ao acordar, tem de fechar com o motivo.
  try {
    await panel.evaluate(([key]) => chrome.storage.local.get(key).then((r) => chrome.storage.local.set({ [key]: { ...r[key], run: { ...r[key].run, status: 'running', finishedAt: undefined, finishReason: undefined } } })), [STATE_KEY]);
    const cdp = await ctx.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CLEAR_NOTHING' }).catch(() => undefined));
    let after;
    for (let i = 0; i < 20; i += 1) {
      after = await readState();
      if (after?.run?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    check(after?.run?.status === 'finished' && /Interrompido: o Chrome desligou a extensão/.test(after.run.finishReason ?? ''), `serviço desligado no meio: ao acordar, o envio foi fechado com o motivo ("${after?.run?.finishReason ?? ''}")`);
  } catch (err) {
    console.log(`(não deu para desligar o serviço por aqui: ${err.message}; esta parte fica sem prova no navegador)`);
  }
} finally {
  await ctx.close();
}

console.log(failures.length === 0 ? '\nTUDO CERTO no Chromium com a página de mentira.' : `\n${failures.length} FALHA(S).`);
process.exit(failures.length === 0 ? 0 : 1);
