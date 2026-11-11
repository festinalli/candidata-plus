import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { goToNextSearchPage, listJobCards, readOpenJobSnapshot } from '../src/content/job-search.ts';
import { readEasyApplyStep } from '../src/content/easy-apply-read.ts';
import { applyFieldInstructions, dismissAllOpenDialogs } from '../src/content/easy-apply-act.ts';

function makeDom(html: string, url = 'https://www.linkedin.com/jobs/search-results/?currentJobId=3900000002') {
  const dom = new JSDOM(html, { url });
  return { doc: dom.window.document, win: dom.window as unknown as Window };
}

test('Busca nova (/jobs/search-results/): lê cartões sem link, respeita painel vazio na transição e ignora botão de outra extensão', () => {
  // Painel vazio durante os ~2s de troca (mesmo com currentJobId já trocado na URL!)
  const emptyPanelHtml = `<!doctype html><html><body>
    <div role="button" componentkey="job-card-component-ref-3900000001">
      <div>Analista Financeiro</div><div>Analista Financeiro</div><div>Empresa Alfa</div><div>São Paulo (Híbrido)</div>
    </div>
    <div role="button" componentkey="job-card-component-ref-3900000002">
      <div>Coordenador Comercial</div><div>Empresa Beta</div><div>Remoto</div>
    </div>
    <main><div id="right-panel"></div></main>
  </body></html>`;

  const envEmpty = makeDom(emptyPanelHtml);
  const cards = listJobCards(envEmpty.doc, envEmpty.win);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]?.jobId, '3900000001');
  assert.equal(cards[0]?.title, 'Analista Financeiro');
  assert.equal(cards[0]?.company, 'Empresa Alfa');
  assert.equal(cards[1]?.jobId, '3900000002');

  // Com o painel vazio na busca nova, jobId DEVE ser null (não cair no currentJobId da URL!)
  const snapEmpty = readOpenJobSnapshot(envEmpty.doc, envEmpty.win);
  assert.equal(snapEmpty.jobId, null);

  // Agora o painel carregou a vaga 3900000002 + outra extensão injetou um div[role=button][data-job-id]
  const loadedPanelHtml = `<!doctype html><html><body>
    <div role="button" componentkey="job-card-component-ref-3900000001">
      <div>Analista Financeiro</div><div>Empresa Alfa</div>
    </div>
    <div role="button" componentkey="job-card-component-ref-3900000002">
      <div>Coordenador Comercial</div><div>Empresa Beta</div>
    </div>
    <main>
      <div class="top-card">
        <div role="button" data-job-id="3900000002">Botão de outra extensão</div>
        <p><a href="/jobs/view/3900000002/">Coordenador Comercial</a></p>
        <a href="/company/empresa-beta/">Empresa Beta</a>
        <span>Remoto</span>
        <button type="button" aria-label="Usar a candidatura simplificada para esta vaga">Candidatura simplificada</button>
      </div>
    </main>
  </body></html>`;

  const envLoaded = makeDom(loadedPanelHtml);
  const snapLoaded = readOpenJobSnapshot(envLoaded.doc, envLoaded.win);
  assert.equal(snapLoaded.jobId, '3900000002');
  assert.equal(snapLoaded.title, 'Coordenador Comercial');
  assert.equal(snapLoaded.company, 'Empresa Beta');
  assert.equal(snapLoaded.workMode, 'remote');
  assert.equal(snapLoaded.hasEasyApply, true);
});

test('Formulário real da busca nova: lê rádios cuja aria-label é a pergunta, detecta "Valor inválido" sem confundir com "0/20", lê botão Avaliar e currículo', async () => {
  const formHtml = `<!doctype html><html lang="pt"><body>
    <dialog data-testid="dialog" aria-labelledby="dialog-header" open>
      <button type="button" aria-label="Fechar">Fechar</button>
      <div>
        <header id="dialog-header"><h2>Candidate-se à empresa Acme</h2></header>
        <div>
          <p>4 de 5 páginas</p>
          <p>Perguntas adicionais</p>
          <div>
            <p>Há quantos anos você já usa Python no trabalho?*</p>
            <div>
              <input required id="q1" aria-describedby="q1h" aria-label="Há quantos anos você já usa Python no trabalho?" type="text" value="">
              <div id="q1h"><p><span>0/20</span><span>0 de 20 caracteres</span></p></div>
            </div>
          </div>
          <div componentkey="g">
            <p>Você trabalharia em um modelo híbrido?*</p>
            <fieldset role="radiogroup">
              <div componentkey="o"><div componentkey="o2"><div><input id="h1" aria-label="Você trabalharia em um modelo híbrido?" type="radio" name="hibrido"><label for="h1"></label></div><div><p>Sim</p></div></div></div>
              <div componentkey="o"><div componentkey="o2"><div><input id="h2" aria-label="Você trabalharia em um modelo híbrido?" type="radio" name="hibrido"><label for="h2"></label></div><div><p>Não</p></div></div></div>
            </fieldset>
          </div>
          <div>
            <p>Qual a sua pretensão salarial para essa oportunidade?*</p>
            <div>
              <input required id="q4" aria-describedby="q4h" aria-label="Qual a sua pretensão salarial para essa oportunidade?" type="text" value="R$ 8000">
              <div id="q4h"><p>Valor inválido</p><div><p><span>7/20</span><span>7 de 20 caracteres</span></p></div></div>
            </div>
          </div>
          <footer><button type="button">Voltar</button><button type="button"><span><span>Avaliar</span></span></button></footer>
        </div>
      </div>
      <section><h2 data-testid="toasts-title">0 notificação</h2></section>
    </dialog>
  </body></html>`;

  const { doc, win } = makeDom(formHtml);
  const step = readEasyApplyStep(doc, win);

  assert.equal(step.modalOpen, true);
  assert.equal(step.progressText, '4 de 5 páginas');
  assert.equal(step.buttonKind, 'review');
  assert.equal(step.buttonLabel, 'Avaliar');
  assert.equal(step.fields.length, 3);

  // q1 não tem erro (o contador "0/20" foi ignorado!)
  assert.equal(step.fields[0]?.errorText, undefined);

  // Rádio extraiu a pergunta do grupo E os rótulos "Sim" e "Não" dos blocos vizinhos!
  const radioField = step.fields[1]!;
  assert.equal(radioField.type, 'radio');
  assert.equal(radioField.label, 'Você trabalharia em um modelo híbrido?');
  assert.deepEqual(
    radioField.options.map((o) => o.label),
    ['Sim', 'Não'],
  );

  // q4 detectou "Valor inválido" dentro de aria-describedby!
  const salaryField = step.fields[2]!;
  assert.equal(salaryField.errorText, 'Valor inválido');

  // Escrita nos campos funciona e marca o rádio certo + escreve número puro
  await applyFieldInstructions(doc, win, [
    { fieldId: step.fields[0]!.fieldId, value: '5' },
    { fieldId: radioField.fieldId, value: radioField.options[0]!.id, optionLabel: 'Sim' },
    { fieldId: salaryField.fieldId, value: '8000' },
  ]);

  assert.equal((doc.getElementById('q1') as HTMLInputElement).value, '5');
  assert.equal((doc.getElementById('h1') as HTMLInputElement).checked, true);
  assert.equal((doc.getElementById('q4') as HTMLInputElement).value, '8000');
});

test('dismissAllOpenDialogs clica em Fechar e depois SEMPRE em Descartar (nunca em Salvar)', async () => {
  const html = `<!doctype html><html><body>
    <dialog id="discard-dlg" open>
      <h2>Salvar esta candidatura?</h2>
      <button id="btn-discard" type="button">Descartar</button>
      <button id="btn-save" type="button">Salvar</button>
    </dialog>
  </body></html>`;

  const { doc, win } = makeDom(html);
  let savedClicked = false;
  let discardClicked = false;

  doc.getElementById('btn-save')!.addEventListener('click', () => {
    savedClicked = true;
  });
  doc.getElementById('btn-discard')!.addEventListener('click', () => {
    discardClicked = true;
    doc.getElementById('discard-dlg')!.remove();
  });

  const closed = await dismissAllOpenDialogs(doc, win, 'discard');
  assert.equal(closed, true);
  assert.equal(discardClicked, true);
  assert.equal(savedClicked, false);
});

test('Páginas de Currículo e Revisão: ignora rádios de PDF como pergunta, seleciona currículo se desmarcado e desmarca Seguir empresa na revisão', async () => {
  const resumeHtml = `<!doctype html><html lang="pt"><body>
    <dialog data-testid="dialog" aria-labelledby="dialog-header" open>
      <header id="dialog-header"><h2>Candidate-se à empresa Acme</h2></header>
      <p>2 de 5 páginas</p>
      <p>Currículo*</p>
      <fieldset role="radiogroup">
        <input id="r1" aria-label="curriculo-ana.pdf" type="radio" name="resume">
        <input id="r2" aria-label="curriculo-antigo.pdf" type="radio" name="resume">
      </fieldset>
      <footer><button type="button">Voltar</button><button type="button">Avançar</button></footer>
    </dialog>
  </body></html>`;

  const envResume = makeDom(resumeHtml);
  const stepResume = readEasyApplyStep(envResume.doc, envResume.win);
  assert.equal(stepResume.fields.length, 0);
  assert.equal(stepResume.hasResumeCards, true);
  assert.equal(stepResume.resumeSelected, false);
  assert.equal(stepResume.buttonKind, 'next');

  await applyFieldInstructions(envResume.doc, envResume.win, []);
  assert.equal((envResume.doc.getElementById('r1') as HTMLInputElement).checked, true);

  const reviewHtml = `<!doctype html><html lang="pt"><body>
    <dialog data-testid="dialog" aria-labelledby="dialog-header" open>
      <header id="dialog-header"><h2>Candidate-se à empresa Acme</h2></header>
      <p>5 de 5 páginas</p>
      <h3>Revise sua candidatura</h3>
      <div><input id="rv1" type="checkbox" aria-label="Marcar vaga como preferencial"><label for="rv1"></label></div>
      <div><input id="rv2" type="checkbox" checked aria-label="Siga a empresa Acme para ficar por dentro das novidades"><label for="rv2"></label></div>
      <footer><button type="button"><span><span>Enviar candidatura</span></span></button></footer>
    </dialog>
  </body></html>`;

  const envRev = makeDom(reviewHtml);
  const stepRev = readEasyApplyStep(envRev.doc, envRev.win);
  assert.equal(stepRev.buttonKind, 'submit');
  assert.equal(stepRev.fields.length, 1);
  assert.equal(stepRev.fields[0]?.isFollowCompany, true);

  await applyFieldInstructions(envRev.doc, envRev.win, [
    { fieldId: stepRev.fields[0]!.fieldId, value: 'false', checked: false },
  ]);
  assert.equal((envRev.doc.getElementById('rv2') as HTMLInputElement).checked, false);
});

test('Lê cartões com URLs de slug (/jobs/view/cargo-empresa-4198765432/), SDUI aninhado, página individual e botão Próxima', async () => {
  // 1. Página com links de slug (/jobs/collections/recommended/ ou /jobs/search/)
  const slugHtml = `<!doctype html><html><body>
    <ul>
      <li>
        <a href="/jobs/view/desenvolvedor-full-stack-remoto-at-empresa-x-4198765432/?refId=abc">Desenvolvedor Full Stack Remoto</a>
        <div>Empresa X</div>
        <div>Brasil (Remoto)</div>
      </li>
      <li>
        <a href="/comm/jobs/view/analista-de-dados-senior-4198765433/">Analista de Dados Sênior</a>
        <div>Empresa Y</div>
      </li>
    </ul>
    <button type="button" data-testid="pagination-controls-next-button-visible">Próxima</button>
  </body></html>`;

  const envSlug = makeDom(slugHtml, 'https://www.linkedin.com/jobs/collections/recommended/');
  const slugCards = listJobCards(envSlug.doc, envSlug.win);
  assert.equal(slugCards.length, 2);
  assert.equal(slugCards[0]?.jobId, '4198765432');
  assert.equal(slugCards[0]?.title, 'Desenvolvedor Full Stack Remoto');
  assert.equal(slugCards[1]?.jobId, '4198765433');

  let nextClicked = false;
  envSlug.doc.querySelector('[data-testid="pagination-controls-next-button-visible"]')!.addEventListener('click', () => {
    nextClicked = true;
  });
  const navOk = await goToNextSearchPage(envSlug.doc, envSlug.win);
  assert.equal(navOk, true);
  assert.equal(nextClicked, true);

  // 2. SDUI onde o role="button" está no pai e o componentkey está num div filho
  const nestedSduiHtml = `<!doctype html><html><body>
    <div role="button" tabindex="0">
      <div componentkey="sdui-job-card-ref-4200111222">
        <p>Engenheiro de Dados</p>
        <p>Tech Brasil</p>
        <p>Remoto</p>
      </div>
    </div>
  </body></html>`;
  const envNested = makeDom(nestedSduiHtml, 'https://www.linkedin.com/jobs/search-results/?f_AL=true');
  const nestedCards = listJobCards(envNested.doc, envNested.win);
  assert.equal(nestedCards.length, 1);
  assert.equal(nestedCards[0]?.jobId, '4200111222');
  assert.equal(nestedCards[0]?.title, 'Engenheiro de Dados');
});
