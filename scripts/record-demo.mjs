// Grava o vídeo "como usar" da Candidata+ 2 e tira as imagens do tutorial.
//
// Tudo acontece num Chromium separado, com uma PÁGINA DE DEMONSTRAÇÃO (scripts/demo-page.html) no lugar do site de
// vagas e com respostas simuladas no lugar do Google AI Studio: nada vai para a internet, nenhuma conta é usada,
// nenhuma candidatura de verdade é enviada. A extensão em si é a de verdade (a pasta dist/).
//
// Uso: npm run record   (precisa do ffmpeg no PATH ou em FFMPEG_PATH; na 1ª vez: npx playwright install chromium)
// Saída: recording/candidata-plus-como-usar.mp4, docs/img/*.png e docs/img/demo.gif
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'recording');
const IMG = path.join(ROOT, 'docs', 'img');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const W = 1600;
const H = 900;
const PANEL_W = 420;
const STATE_KEY = 'candidata_plus_v2_state';
const REPO = 'github.com/festinalli/candidata-plus';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(IMG, { recursive: true });

// ---------------------------------------------------------------------------------------------------------
// 1. Cópia da extensão só para a gravação: igual à de verdade, mas o painel pode aparecer dentro da página de
//    demonstração (no Chrome de verdade ele abre como painel lateral, que a gravação automática não alcança).
const EXT = path.join(OUT, 'demo-ext');
fs.cpSync(DIST, EXT, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.web_accessible_resources = [{ resources: ['panel/*', 'vendor/*', 'assets/*'], matches: ['https://www.linkedin.com/*'] }];
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ---------------------------------------------------------------------------------------------------------
// 2. Respostas simuladas do Google AI Studio (a pessoa de exemplo é a "Ana Exemplo", que não existe).
const DEMO_KNOWLEDGE = {
  fullName: 'Ana Exemplo',
  email: 'ana.exemplo@email.com',
  phone: '11900000000',
  city: 'São Paulo',
  state: 'SP',
  country: 'Brasil',
  linkedinUrl: '',
  portfolioUrl: '',
  targetRole: 'Analista de Dados',
  seniority: 'Sênior',
  totalYearsExperience: 8,
  skills: [
    { name: 'SQL', years: 8 },
    { name: 'Python', years: 6 },
    { name: 'Power BI', years: 5 },
    { name: 'Excel', years: 8 },
    { name: 'ETL', years: 4 },
    { name: 'Estatística', years: 6 },
  ],
  experiences: [
    { role: 'Analista de Dados Sênior', company: 'Empresa Sol', period: '2020-03 a Atual', years: 6, summary: 'Painéis em Power BI e análises em Python e SQL.' },
    { role: 'Analista de BI', company: 'Empresa Lua', period: '2018-01 a 2020-02', years: 2, summary: 'Relatórios, ETL e modelagem de dados.' },
  ],
  languages: [
    { language: 'Português', level: 'Nativo' },
    { language: 'Inglês', level: 'Avançado' },
  ],
  education: [{ degree: 'Graduação', field: 'Estatística', institution: 'Universidade Exemplo', status: 'Concluído' }],
  certifications: ['Power BI Data Analyst'],
  summary: 'Analista de dados com 8 anos de experiência em BI, SQL e Python, focada em transformar dados em decisões de negócio.',
};

function demoAnswer(q, index) {
  const text = String(q.question ?? '').toLowerCase();
  const options = Array.isArray(q.options) ? q.options : [];
  const pick = (wanted) => options.find((o) => o.toLowerCase() === wanted.toLowerCase()) ?? options[0];
  if (/cnh/.test(text)) return { index, status: 'unknown', value: '', reason: 'CNH não aparece no currículo' };
  if (options.length > 0) {
    if (/ingl[eê]s|english/.test(text)) return { index, status: 'answered', value: pick('Avançado') };
    if (/h[ií]brido/.test(text)) return { index, status: 'answered', value: pick('Não') };
    return { index, status: 'answered', value: pick('Sim') };
  }
  if (q.formatRequired) return { index, status: 'answered', value: /sql/.test(text) ? '8' : '6' };
  if (q.fieldType === 'textarea' || /conte|por que/.test(text)) {
    return {
      index,
      status: 'answered',
      value:
        'Trabalho há 8 anos com dados, criando painéis em Power BI e análises em Python e SQL que apoiam decisões de negócio. A vaga combina com a minha experiência em BI e com o trabalho remoto.',
    };
  }
  return { index, status: 'answered', value: 'Sim' };
}

async function fakeGoogle(route) {
  const req = route.request();
  await wait(req.method() === 'GET' ? 400 : 900 + Math.round(Math.random() * 500));
  if (req.method() === 'GET') {
    const names = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.6-flash'];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: names.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }) });
  }
  const body = JSON.parse(req.postData() ?? '{}');
  const text = (body.contents?.[0]?.parts ?? []).map((p) => p.text ?? '').join('\n');
  let data;
  if (text.includes('Ficha de Conhecimento')) data = DEMO_KNOWLEDGE;
  else {
    const prompt = JSON.parse(text);
    data = { answers: (prompt.questionsToAnswer ?? []).map((q) => demoAnswer(q, q.index)) };
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] }) });
}

// ---------------------------------------------------------------------------------------------------------
// 3. Gravador: captura os quadros da aba (mais nítido que a gravação padrão) e monta o vídeo com o ffmpeg.
async function startRecorder(ctx, page, name) {
  const dir = path.join(OUT, `frames-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  const wallStart = Date.now();
  cdp.on('Page.screencastFrame', (ev) => {
    const file = path.join(dir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(ev.data, 'base64'));
    frames.push({ file, t: ev.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  return {
    elapsed: () => (Date.now() - wallStart) / 1000,
    async stop(tail = 1.5) {
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await wait(300);
      const lines = ['ffconcat version 1.0'];
      frames.forEach((f, i) => {
        const next = frames[i + 1];
        lines.push(`file '${path.basename(f.file)}'`, `duration ${(next ? Math.max(0.001, next.t - f.t) : tail).toFixed(4)}`);
      });
      lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
      fs.writeFileSync(path.join(dir, 'list.ffconcat'), lines.join('\n'));
      const mp4 = path.join(OUT, `${name}.mp4`);
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.ffconcat'), '-vf', `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-movflags', '+faststart', mp4]);
      return mp4;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// 4. Cursor visível, legendas e cartões de título, desenhados por cima da página (só DOM, sem innerHTML, para funcionar
//    também na página chrome://extensions).
function installOverlay(opts) {
  if (window.__rec) return;
  const mk = (tag, style) => {
    const el = document.createElement(tag);
    Object.assign(el.style, style);
    return el;
  };
  const layer = mk('div', { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647', fontFamily: "'Segoe UI', system-ui, sans-serif" });
  const cursor = mk('div', {
    position: 'fixed', left: '0px', top: '0px', width: '26px', height: '26px', marginLeft: '-13px', marginTop: '-13px', borderRadius: '50%',
    background: 'rgba(255, 196, 0, 0.55)', border: '3px solid #1d2226', boxShadow: '0 2px 10px rgba(0,0,0,0.35)', opacity: '0',
    transition: 'left 0.7s cubic-bezier(.4,.0,.2,1), top 0.7s cubic-bezier(.4,.0,.2,1), opacity 0.3s',
  });
  const ring = mk('div', { position: 'fixed', width: '26px', height: '26px', marginLeft: '-13px', marginTop: '-13px', borderRadius: '50%', border: '3px solid #ffb400', opacity: '0' });
  const cap = mk('div', {
    position: 'fixed', left: `${opts.capLeft}px`, right: `${opts.capRight}px`, bottom: '26px', display: 'flex', justifyContent: 'center', opacity: '0', transition: 'opacity 0.35s',
  });
  const capBox = mk('div', { background: 'rgba(16, 24, 32, 0.92)', color: '#fff', borderRadius: '14px', padding: '14px 22px', fontSize: '25px', fontWeight: '600', lineHeight: '1.3', maxWidth: '100%', boxShadow: '0 6px 24px rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', gap: '14px' });
  const capStep = mk('span', { background: '#ffb400', color: '#1d2226', borderRadius: '10px', padding: '4px 12px', fontSize: '20px', fontWeight: '800', whiteSpace: 'nowrap' });
  const capText = mk('span', {});
  capBox.append(capStep, capText);
  cap.append(capBox);
  const card = mk('div', { position: 'fixed', inset: '0', background: 'linear-gradient(135deg, #0b3d6e, #0a66c2)', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '18px', textAlign: 'center', padding: '0 120px', opacity: '0', transition: 'opacity 0.6s' });
  const hl = mk('div', { position: 'fixed', border: '4px solid #ffb400', borderRadius: '12px', boxShadow: '0 0 0 6px rgba(255,180,0,0.25)', opacity: '0', transition: 'all 0.4s' });
  layer.append(hl, cap, cursor, ring, card);
  document.documentElement.append(layer);
  window.__rec = {
    move(x, y) {
      cursor.style.opacity = '1';
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    },
    hideCursor() {
      cursor.style.opacity = '0';
    },
    tap() {
      ring.style.left = cursor.style.left;
      ring.style.top = cursor.style.top;
      ring.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 550, easing: 'ease-out' });
      cursor.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.75)' }, { transform: 'scale(1)' }], { duration: 250 });
    },
    caption(step, text) {
      if (!text) {
        cap.style.opacity = '0';
        return;
      }
      capStep.textContent = step || '';
      capStep.style.display = step ? 'inline-block' : 'none';
      capText.textContent = text;
      cap.style.opacity = '1';
    },
    highlight(box) {
      if (!box) {
        hl.style.opacity = '0';
        return;
      }
      Object.assign(hl.style, { left: `${box.x - 8}px`, top: `${box.y - 8}px`, width: `${box.width + 16}px`, height: `${box.height + 16}px`, opacity: '1' });
    },
    card(lines) {
      card.replaceChildren();
      if (!lines) {
        card.style.opacity = '0';
        return;
      }
      for (const [text, size, weight, color] of lines) {
        const line = mk('div', { fontSize: `${size}px`, fontWeight: String(weight), color: color || '#fff', lineHeight: '1.25' });
        line.textContent = text;
        card.append(line);
      }
      card.style.opacity = '1';
    },
  };
}

async function overlay(page, opts) {
  await page.evaluate(installOverlay, opts);
}
const rec = (page, method, ...args) => page.evaluate(([m, a]) => window.__rec[m](...a), [method, args]);

async function pointAt(page, locator, { click = true, scroll = true, after = 400 } = {}) {
  if (scroll) {
    await locator.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' })).catch(() => undefined);
    await wait(650);
  }
  const box = await locator.boundingBox();
  if (!box) throw new Error('elemento sem posição na tela');
  await rec(page, 'move', box.x + box.width / 2, box.y + box.height / 2);
  await wait(800);
  if (click) {
    await rec(page, 'tap');
    await locator.click();
    await wait(after);
  }
  return box;
}

async function untilTrue(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`demorou demais: ${label}`);
    await wait(250);
  }
}

// ---------------------------------------------------------------------------------------------------------
// 5. A gravação.
const ctx = await chromium.launchPersistentContext('', {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  headless: false,
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  locale: 'pt-BR',
  args: ['--headless=new', '--lang=pt-BR', '--hide-scrollbars', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let finalMp4 = '';
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10_000 });
  const extId = sw.url().split('/')[2];
  const panelUrl = `chrome-extension://${extId}/panel/panel.html`;
  const demoPage = fs.readFileSync(path.join(ROOT, 'scripts', 'demo-page.html'), 'utf8').replace('__PANEL_URL__', panelUrl);
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: demoPage }));
  await ctx.route(/^https:\/\/generativelanguage\.googleapis\.com\//, fakeGoogle);

  // Currículo de exemplo em PDF (pessoa fictícia).
  const pdfPath = path.join(OUT, 'curriculo-ana-exemplo.pdf');
  const pdfPage = await ctx.newPage();
  await pdfPage.setContent(`<html><body style="font-family:Arial;padding:40px;line-height:1.5">
    <h1>Ana Exemplo</h1><p>Analista de Dados Sênior · São Paulo, SP · ana.exemplo@email.com · (11) 90000-0000</p>
    <h2>Resumo</h2><p>Analista de dados com 8 anos de experiência em BI, SQL e Python. Painéis em Power BI e automações de relatórios.</p>
    <h2>Experiência</h2>
    <p><b>Analista de Dados Sênior</b> — Empresa Sol (03/2020 – atual): painéis em Power BI, análises em Python e SQL, modelos estatísticos.</p>
    <p><b>Analista de BI</b> — Empresa Lua (01/2018 – 02/2020): relatórios, ETL e modelagem de dados em SQL e Excel.</p>
    <h2>Formação</h2><p>Graduação em Estatística — Universidade Exemplo (concluído)</p>
    <h2>Idiomas</h2><p>Português (nativo) · Inglês (avançado)</p>
    <h2>Certificações</h2><p>Power BI Data Analyst</p></body></html>`);
  await pdfPage.pdf({ path: pdfPath, format: 'A4' });
  await pdfPage.close();

  // ---- Parte 1: instalar (página chrome://extensions)
  const ext = await ctx.newPage();
  await ext.goto('chrome://extensions/');
  await wait(1200);
  await overlay(ext, { capLeft: 60, capRight: 60 });
  const rec1 = await startRecorder(ctx, ext, 'parte1');
  await rec(ext, 'card', [
    ['Candidata+ 2', 74, 800],
    ['Candidaturas simplificadas no LinkedIn, no automático,', 34, 500],
    ['com a IA grátis do Google respondendo pelo seu currículo', 34, 500],
    ['Grátis · código aberto · seus dados ficam no seu navegador', 24, 600, '#ffd666'],
  ]);
  await wait(4200);
  await rec(ext, 'card', null);
  await wait(700);
  await rec(ext, 'caption', 'Instalar', 'Baixe o ZIP na página do projeto (Releases) e extraia a pasta');
  await wait(3200);
  await rec(ext, 'caption', 'Instalar', 'No Chrome, abra chrome://extensions e ligue o "Modo do desenvolvedor"');
  await wait(1400);
  await pointAt(ext, ext.locator('#devMode'), { scroll: false, after: 1200 });
  await rec(ext, 'caption', 'Instalar', 'Clique em "Carregar sem compactação" e escolha a pasta que você extraiu');
  const loadBtn = await pointAt(ext, ext.locator('#loadUnpacked'), { click: false, scroll: false });
  await rec(ext, 'highlight', loadBtn);
  await wait(3400);
  await rec(ext, 'highlight', null);
  const cardBox = await ext.locator('extensions-item').first().boundingBox();
  await rec(ext, 'hideCursor');
  await rec(ext, 'caption', 'Pronto', 'A Candidata+ 2 aparece aqui. Fixe o ícone na barra do Chrome (peça de quebra-cabeça → alfinete)');
  await rec(ext, 'highlight', cardBox);
  await wait(3800);
  await rec(ext, 'highlight', null);
  await rec(ext, 'caption', '', '');
  await wait(800);
  await ext.screenshot({ path: path.join(IMG, 'instalar.png') });
  const part1 = await rec1.stop(0.4);
  await ext.close();

  // ---- Parte 2: usar
  const stage = await ctx.newPage();
  await stage.goto('https://www.linkedin.com/jobs/search-results/?keywords=analista%20de%20dados&f_AL=true');
  const panel = stage.frameLocator('#cplus-panel');
  await panel.locator('#btn-start-batch').waitFor();
  await wait(900);
  const panelFrame = () => stage.frames().find((f) => f.url().startsWith('chrome-extension://'));
  const readState = () => panelFrame().evaluate((key) => chrome.storage.local.get(key).then((r) => r[key]), STATE_KEY);
  const panelShot = async (name) => {
    await rec(stage, 'hideCursor');
    await wait(350);
    await stage.locator('#cplus-panel').screenshot({ path: path.join(IMG, name) });
  };
  await overlay(stage, { capLeft: 24, capRight: PANEL_W + 24 });
  const rec2 = await startRecorder(ctx, stage, 'parte2');

  await rec(stage, 'caption', 'Abrir', 'Numa busca de vagas, clique no ícone da Candidata+ 2: o painel abre do lado direito');
  await rec(stage, 'highlight', { x: W - PANEL_W + 6, y: 6, width: PANEL_W - 14, height: 54 });
  await wait(3600);
  await rec(stage, 'highlight', null);

  // Passo 1
  await rec(stage, 'caption', 'Passo 1', 'Envie o PDF do seu currículo (uma vez só)');
  await pointAt(stage, panel.locator('#btn-pick-pdf'), { click: false });
  await rec(stage, 'tap');
  await panel.locator('#resume-file-input').setInputFiles(pdfPath);
  await untilTrue(async () => ((await panel.locator('#resume-status-box').textContent()) ?? '').includes('curriculo-ana-exemplo'), 15_000, 'currículo guardado');
  await wait(2200);

  // Passo 2
  await rec(stage, 'caption', 'Passo 2', 'Pegue a chave grátis em aistudio.google.com/apikey e cole aqui');
  await pointAt(stage, panel.locator('#ai-key-input'), { after: 300 });
  await panel.locator('#ai-key-input').pressSequentially('AIzaSyD-chave-de-exemplo-0000000000', { delay: 35 });
  await wait(500);
  await rec(stage, 'caption', 'Passo 2', 'Clique em "Salvar e testar": a IA responde 4 perguntas usando o seu currículo');
  await pointAt(stage, panel.locator('#btn-save-test-ai'), { after: 300 });
  await untilTrue(async () => ((await panel.locator('#ai-test-output').textContent()) ?? '').includes('Tudo certo'), 30_000, 'teste da IA');
  await panel.locator('#ai-test-output').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await wait(3400);
  await panelShot('passo2-chave.png');

  await rec(stage, 'caption', 'Passo 2', 'A IA lê o currículo e monta a sua ficha. Dá para revisar e corrigir');
  await untilTrue(async () => Boolean((await readState())?.knowledge?.generatedByAiAt), 30_000, 'ficha pronta');
  await panelFrame().evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(1500);
  await panelShot('passo1-curriculo.png');
  await pointAt(stage, panel.locator('#btn-toggle-kb'), { after: 900 });
  await panel.locator('#kb-skills').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await wait(2600);
  await panelShot('ficha.png');
  await pointAt(stage, panel.locator('#btn-toggle-kb'), { after: 600 });

  // Passo 3
  await rec(stage, 'caption', 'Passo 3', 'Marque as modalidades que você aceita e a sua pretensão salarial');
  await pointAt(stage, panel.locator('#wm-hybrid'), { after: 350 });
  await pointAt(stage, panel.locator('#wm-onsite'), { after: 350, scroll: false });
  await pointAt(stage, panel.locator('#quick-salary'), { after: 250 });
  await panel.locator('#quick-salary').pressSequentially('9000', { delay: 90 });
  await panel.locator('#quick-salary').press('Tab');
  await wait(700);
  await pointAt(stage, panel.locator('#set-max-jobs'), { click: false, scroll: false });
  await panel.locator('#set-max-jobs').fill('2');
  await panel.locator('#set-max-jobs').dispatchEvent('change');
  await rec(stage, 'caption', 'Dica', 'Na primeira vez, use "Só simular": preenche tudo e descarta sem enviar');
  const simBox = await panel.locator('#mode-sim').locator('xpath=..').boundingBox();
  await rec(stage, 'highlight', simBox);
  await wait(3200);
  await rec(stage, 'highlight', null);
  await panel.locator('#btn-start-batch').evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  await wait(900);
  await panelShot('passo3-envio.png');

  // Envio
  await rec(stage, 'caption', 'Começar', 'Clique em "Começar envio automático" e deixe a extensão trabalhar');
  await pointAt(stage, panel.locator('#btn-start-batch'), { scroll: false, after: 500 });
  const runMark = rec2.elapsed();
  await rec(stage, 'hideCursor');
  // Mostra o placar ao vivo no alto do painel enquanto o envio roda.
  await panelFrame().evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  const said = new Set();
  let shotTaken = false;
  await untilTrue(
    async () => {
      const st = await readState();
      const diary = (st?.run?.diary ?? []).join('\n');
      const say = async (key, step, text) => {
        if (said.has(key)) return;
        said.add(key);
        await rec(stage, 'caption', step, text);
      };
      if (/pulando sem abrir/.test(diary)) await say('skip', 'Filtro', 'Vaga híbrida? Pulada sem abrir: você marcou só Remoto');
      if (/Formulário aberto/.test(diary)) await say('open', 'Preenchendo', 'Abre a vaga e preenche cada página com a sua ficha');
      if (/IA respondeu/.test(diary)) await say('ai', 'IA', 'O que não está na ficha, a IA responde pelo seu currículo');
      if (!shotTaken && (await stage.evaluate(() => (document.querySelector('#q-why')?.value ?? '').length > 20))) {
        shotTaken = true;
        await stage.screenshot({ path: path.join(IMG, 'envio.png') });
      }
      if (/CANDIDATURA ENVIADA/.test(diary)) await say('sent', 'Enviada', 'Candidatura enviada! E já vai para a próxima vaga');
      if (/Faltou resposta/.test(diary)) await say('miss', 'Responda 1 vez', 'O que nem a IA sabe vira uma pergunta para você, e a vaga fica para depois');
      return st?.run?.status === 'finished' && Boolean(st.run.finishedAt);
    },
    180_000,
    'fim do envio',
  );
  const runEndMark = rec2.elapsed();
  const counts = (await readState()).run.counts;
  await rec(stage, 'caption', 'Resultado', `Fim: ${counts.applied} candidatura(s) enviada(s), ${counts.needsAnswer} pergunta(s) para você responder`);
  await panelFrame().evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(3200);

  // Responda 1 vez
  await rec(stage, 'caption', 'Passo 4', 'Responda uma vez o que faltou: fica guardado para as próximas vagas');
  await pointAt(stage, panel.locator('.tab[data-tab="pending"]'), { scroll: false, after: 900 });
  await panelShot('responda.png');
  await pointAt(stage, panel.locator('.chip-btn', { hasText: 'Sim' }).first(), { after: 500 });
  await pointAt(stage, panel.locator('button', { hasText: 'Salvar resposta' }).first(), { after: 1600 });

  // Diário
  await rec(stage, 'caption', 'Diário', 'Tudo o que aconteceu fica no Diário, passo a passo');
  await pointAt(stage, panel.locator('.tab[data-tab="diary"]'), { scroll: false, after: 900 });
  await panel.locator('#diary-box').evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  await wait(1200);
  await panelShot('diario.png');
  await panel.locator('#diary-box').evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  await wait(2600);

  await rec(stage, 'caption', '', '');
  await rec(stage, 'card', [
    ['Candidata+ 2', 70, 800],
    ['Grátis e de código aberto', 36, 600],
    [REPO, 38, 700, '#ffd666'],
    ['Seus dados ficam no seu navegador · a IA usa a SUA chave do Google', 24, 500],
    ['Use com responsabilidade e revise o que é enviado', 24, 500],
    ['Vídeo de demonstração com página e respostas simuladas', 18, 400, '#c9dcf0'],
    ['#OpenToWork', 30, 700],
  ]);
  await wait(5500);
  const part2 = await rec2.stop(0.5);

  // Junta as partes.
  const list = path.join(OUT, 'partes.txt');
  fs.writeFileSync(list, [part1, part2].map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  finalMp4 = path.join(OUT, 'candidata-plus-como-usar.mp4');
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', finalMp4]);

  // GIF curto do envio rodando, para o README.
  const gif = path.join(IMG, 'demo.gif');
  const start = Math.max(0, runMark - 0.5);
  const length = Math.min(30, runEndMark - runMark + 2);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', start.toFixed(2), '-t', length.toFixed(2), '-i', part2, '-vf', 'fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif]);

  const info = (file) => `${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`;
  console.log(JSON.stringify({ video: info(finalMp4), gif: info(gif), runMark, runEndMark, parte1: info(part1), parte2: info(part2) }, null, 2));
} finally {
  await ctx.close();
}
