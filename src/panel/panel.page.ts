import type { BgResponse, PanelToBgMessage, TestAiQuestionResult } from '../shared/messages.ts';
import type { AppState, KnowledgeBase, WorkMode } from '../shared/types.ts';
import { STORAGE_KEY, loadState } from '../shared/storage.ts';
import { readResumeFile } from './pdf-reader.ts';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} não encontrado`);
  return el as T;
}

async function sendBg<T = unknown>(msg: PanelToBgMessage): Promise<BgResponse<T>> {
  return (await chrome.runtime.sendMessage(msg)) as BgResponse<T>;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

let currentState: AppState | null = null;
let kbEditorDirty = false;

// ---------------------------------------------------------------------------
// Navegação entre abas
// ---------------------------------------------------------------------------
function switchTab(tabName: 'start' | 'pending' | 'diary'): void {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))) {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  $('tab-start').classList.toggle('hidden', tabName !== 'start');
  $('tab-pending').classList.toggle('hidden', tabName !== 'pending');
  $('tab-diary').classList.toggle('hidden', tabName !== 'diary');
}

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))) {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tab as 'start' | 'pending' | 'diary';
    if (t) switchTab(t);
  });
}

// ---------------------------------------------------------------------------
// Conversão amigável da Ficha <-> campos de texto simples
// ---------------------------------------------------------------------------
function populateKbForm(st: AppState): void {
  const kb = st.knowledge;
  $<HTMLInputElement>('kb-name').value = kb.fullName;
  $<HTMLInputElement>('kb-email').value = kb.email;
  $<HTMLInputElement>('kb-phone').value = kb.phone;
  $<HTMLInputElement>('kb-city').value = kb.city;
  $<HTMLInputElement>('kb-state').value = kb.state;
  $<HTMLInputElement>('kb-role').value = kb.targetRole;
  $<HTMLInputElement>('kb-years').value = kb.totalYearsExperience ? String(kb.totalYearsExperience) : '';
  $<HTMLInputElement>('kb-salary').value = kb.salaryExpectation;
  $<HTMLInputElement>('kb-current-salary').value = kb.currentSalary;
  $<HTMLInputElement>('kb-notice').value = kb.noticePeriodDays;
  $<HTMLSelectElement>('kb-relocate').value = String(kb.willingToRelocate);
  $<HTMLTextAreaElement>('kb-skills').value = kb.skills.map((s) => `${s.name}: ${s.years}`).join('\n');
  $<HTMLTextAreaElement>('kb-languages').value = kb.languages.map((l) => `${l.language}: ${l.level}`).join('\n');
  $<HTMLTextAreaElement>('kb-summary').value = kb.summary;
  $<HTMLTextAreaElement>('kb-extra').value = kb.extraFacts;
  $<HTMLTextAreaElement>('kb-raw-resume').value = st.resume?.text ?? '';
  kbEditorDirty = false;
}

function readKbForm(base: KnowledgeBase): KnowledgeBase {
  const skills = $<HTMLTextAreaElement>('kb-skills')
    .value.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [namePart, yearsPart] = line.split(':');
      const years = Number((yearsPart ?? '1').replace(',', '.').replace(/[^\d.]/g, ''));
      return {
        name: (namePart ?? line).trim(),
        years: Number.isFinite(years) && years >= 0 ? years : 1,
      };
    });

  const languages = $<HTMLTextAreaElement>('kb-languages')
    .value.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [langPart, levelPart] = line.split(':');
      return {
        language: (langPart ?? line).trim(),
        level: (levelPart ?? 'Intermediário').trim() || 'Intermediário',
      };
    });

  const yearsTotal = Number($<HTMLInputElement>('kb-years').value);

  return {
    ...base,
    fullName: $<HTMLInputElement>('kb-name').value.trim(),
    email: $<HTMLInputElement>('kb-email').value.trim(),
    phone: $<HTMLInputElement>('kb-phone').value.replace(/[^\d+]/g, ''),
    city: $<HTMLInputElement>('kb-city').value.trim(),
    state: $<HTMLInputElement>('kb-state').value.trim(),
    targetRole: $<HTMLInputElement>('kb-role').value.trim(),
    totalYearsExperience: Number.isFinite(yearsTotal) && yearsTotal >= 0 ? yearsTotal : 0,
    salaryExpectation: $<HTMLInputElement>('kb-salary').value.replace(/[^\d]/g, ''),
    currentSalary: $<HTMLInputElement>('kb-current-salary').value.replace(/[^\d]/g, ''),
    noticePeriodDays: $<HTMLInputElement>('kb-notice').value.trim() || 'Imediato',
    willingToRelocate: $<HTMLSelectElement>('kb-relocate').value === 'true',
    skills,
    languages,
    summary: $<HTMLTextAreaElement>('kb-summary').value.trim(),
    extraFacts: $<HTMLTextAreaElement>('kb-extra').value.trim(),
  };
}

for (const el of Array.from(document.querySelectorAll('#kb-editor input, #kb-editor textarea, #kb-editor select'))) {
  el.addEventListener('input', () => {
    kbEditorDirty = true;
  });
}

// ---------------------------------------------------------------------------
// Renderização principal
// ---------------------------------------------------------------------------
function renderState(st: AppState): void {
  currentState = st;

  // Badge de pendências
  const pendBadge = $('pending-badge');
  pendBadge.textContent = String(st.pending.length);
  pendBadge.classList.toggle('hidden', st.pending.length === 0);

  // Banner do envio
  const run = st.run;
  const isActive = run.status === 'running' || run.status === 'paused' || run.status === 'stopping';
  const hasCounts =
    run.counts.opened > 0 || run.counts.applied > 0 || run.counts.simulated > 0 || run.counts.needsAnswer > 0;
  const liveBanner = $('live-run-banner');
  liveBanner.classList.toggle('hidden', !isActive && !hasCounts);

  const pill = $('live-status-pill');
  pill.className = 'pill';
  if (run.status === 'running') {
    pill.classList.add('running');
    pill.textContent = 'Rodando';
  } else if (run.status === 'paused') {
    pill.classList.add('paused');
    pill.textContent = 'Pausado';
  } else if (run.status === 'stopping') {
    pill.classList.add('paused');
    pill.textContent = 'Parando...';
  } else {
    pill.classList.add('finished');
    pill.textContent = 'Concluído';
  }

  $('live-current-job').textContent = run.currentJob
    ? `${run.currentJob.title} — ${run.currentJob.stepInfo ?? ''}`
    : (run.finishReason ?? 'Pronto');
  $('stat-applied').textContent = String(run.counts.applied);
  $('stat-simulated').textContent = String(run.counts.simulated);
  $('stat-needs').textContent = String(run.counts.needsAnswer);
  $('stat-skipped').textContent = String(run.counts.skipped);

  $('live-controls').classList.toggle('hidden', !isActive);
  $('btn-pause-resume').textContent = run.status === 'paused' ? 'Retomar' : 'Pausar';

  // Passo 1: Currículo e Ficha
  const resumeBox = $('resume-status-box');
  if (!st.resume) {
    resumeBox.className = 'status-note muted mt-8';
    resumeBox.textContent = 'Nenhum currículo enviado ainda.';
  } else if (st.knowledge.generatedByAiAt) {
    resumeBox.className = 'status-note ok mt-8';
    resumeBox.textContent = `Currículo "${st.resume.fileName}" lido! Ficha pronta (${st.knowledge.skills.length} habilidades, ${st.knowledge.experiences.length} experiências, cargo: ${st.knowledge.targetRole || 'definido'}).`;
  } else {
    resumeBox.className = 'status-note warn mt-8';
    resumeBox.textContent = `Currículo "${st.resume.fileName}" guardado (${st.resume.text.length} letras extraídas). Cole a chave no Passo 2 ou clique em "Montar ficha com a IA".`;
  }

  if (!kbEditorDirty) {
    populateKbForm(st);
  }

  // Passo 2: Chave e modelos
  const keyInput = $<HTMLInputElement>('ai-key-input');
  if (document.activeElement !== keyInput && st.ai.apiKey) {
    keyInput.value = st.ai.apiKey;
  }

  const modelSel = $<HTMLSelectElement>('ai-model-select');
  const currentSelVal = st.ai.userPickedModel ? st.ai.preferredModel || '' : '';
  modelSel.innerHTML = '';
  const autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = 'Automático (melhor modelo rápido da conta)';
  modelSel.appendChild(autoOpt);
  for (const m of st.ai.discoveredModels) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modelSel.appendChild(opt);
  }
  modelSel.value = st.ai.discoveredModels.includes(currentSelVal) ? currentSelVal : '';

  const aiTestBox = $('ai-test-output');
  if (st.ai.lastTestSummary && aiTestBox.dataset.detailed !== 'true') {
    aiTestBox.classList.remove('hidden');
    aiTestBox.className = `status-note mt-8 ${st.ai.lastTestOk ? 'ok' : 'err'}`;
    aiTestBox.textContent = st.ai.lastTestSummary;
  }

  // Passo 3: Configurações de envio
  const realRadio = $<HTMLInputElement>('mode-real');
  const simRadio = $<HTMLInputElement>('mode-sim');
  if (st.settings.simulateOnly) simRadio.checked = true;
  else realRadio.checked = true;

  const maxJobsInput = $<HTMLInputElement>('set-max-jobs');
  if (document.activeElement !== maxJobsInput) {
    maxJobsInput.value = String(st.settings.maxJobs);
  }

  const paceSelect = $<HTMLSelectElement>('set-pace');
  if (document.activeElement !== paceSelect) {
    const p = String(st.settings.pauseAfterSubmitSec);
    paceSelect.value = ['2', '3', '8'].includes(p) ? p : '3';
  }

  $<HTMLInputElement>('wm-remote').checked = st.settings.acceptedWorkModes.includes('remote');
  $<HTMLInputElement>('wm-hybrid').checked = st.settings.acceptedWorkModes.includes('hybrid');
  $<HTMLInputElement>('wm-onsite').checked = st.settings.acceptedWorkModes.includes('onsite');
  $<HTMLInputElement>('set-unfollow').checked = st.settings.unfollowCompany;

  const quickSalary = $<HTMLInputElement>('quick-salary');
  if (document.activeElement !== quickSalary) quickSalary.value = st.knowledge.salaryExpectation;

  const startBtn = $<HTMLButtonElement>('btn-start-batch');
  startBtn.disabled = isActive;
  startBtn.textContent = isActive
    ? 'Envio em andamento...'
    : st.settings.simulateOnly
      ? 'Começar simulação (sem enviar)'
      : 'Começar envio automático';

  // Aba 2: Perguntas sem resposta ("Responda 1 vez")
  renderPendingTab(st);

  // Aba 3: Diário e vagas
  renderDiaryTab(st);
}

function renderPendingTab(st: AppState): void {
  const pendContainer = $('pending-list');
  pendContainer.innerHTML = '';

  if (st.pending.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-note ok';
    empty.textContent = 'Nenhuma pergunta pendente no momento!';
    pendContainer.appendChild(empty);
  } else {
    for (const p of st.pending) {
      const card = document.createElement('div');
      card.className = 'item-card';

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = p.question;
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'item-meta';
      meta.textContent = `Vaga: ${p.jobTitle} (${p.company || 'LinkedIn'}) · ${p.reason}`;
      card.appendChild(meta);

      const answerInput = document.createElement('input');
      answerInput.type = 'text';
      answerInput.placeholder = p.options.length > 0 ? 'Clique numa opção acima ou digite...' : 'Digite sua resposta...';

      // Se a pergunta tem opções (Sim/Não ou lista), mostra botões clicáveis!
      if (p.options.length > 0) {
        const chips = document.createElement('div');
        chips.className = 'choice-chips';
        for (const optLabel of p.options) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'chip-btn';
          chip.textContent = optLabel;
          chip.addEventListener('click', () => {
            for (const sibling of Array.from(chips.querySelectorAll('.chip-btn'))) {
              sibling.classList.remove('selected');
            }
            chip.classList.add('selected');
            answerInput.value = optLabel;
          });
          chips.appendChild(chip);
        }
        card.appendChild(chips);
      }

      card.appendChild(answerInput);

      const actions = document.createElement('div');
      actions.className = 'row gap-6 mt-8';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn primary small flex-1';
      saveBtn.textContent = 'Salvar resposta';
      saveBtn.addEventListener('click', async () => {
        const res = await sendBg({ type: 'ANSWER_PENDING', pendingId: p.id, answer: answerInput.value });
        if (res.ok) showToast('Resposta guardada! Será usada automaticamente nas próximas vagas.');
        else showToast(res.error ?? 'Digite uma resposta.');
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn secondary small';
      delBtn.textContent = 'Ignorar';
      delBtn.addEventListener('click', async () => {
        await sendBg({ type: 'DELETE_PENDING', pendingId: p.id });
      });

      actions.appendChild(saveBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
      pendContainer.appendChild(card);
    }
  }

  // Banco de respostas
  $('bank-count').textContent = String(st.answers.length);
  const bankContainer = $('bank-list');
  bankContainer.innerHTML = '';

  if (st.answers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-note muted';
    empty.textContent = 'Suas respostas aprendidas aparecerão aqui.';
    bankContainer.appendChild(empty);
  } else {
    for (const entry of st.answers.slice(0, 80)) {
      const card = document.createElement('div');
      card.className = 'item-card';

      const sourceTag =
        entry.source === 'user'
          ? 'Você respondeu'
          : entry.source === 'manual_linkedin'
            ? 'Digitado no LinkedIn'
            : 'Respondido pela IA';

      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = entry.question;
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'item-meta';
      meta.textContent = `Resposta: ${entry.answer} · (${sourceTag})`;
      card.appendChild(meta);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn secondary small';
      delBtn.textContent = 'Apagar';
      delBtn.addEventListener('click', async () => {
        await sendBg({ type: 'DELETE_BANK_ANSWER', answerId: entry.id });
      });
      card.appendChild(delBtn);

      bankContainer.appendChild(card);
    }
  }
}

function renderDiaryTab(st: AppState): void {
  const ai = st.run.aiStats;
  const aiBox = $('ai-run-summary');
  if (ai.calls === 0 && st.run.counts.opened === 0) {
    aiBox.className = 'status-note muted';
    aiBox.textContent = 'Nenhuma rodada executada ainda.';
  } else {
    aiBox.className = `status-note ${ai.errors > 0 ? 'warn' : 'ok'}`;
    aiBox.textContent =
      `Chamadas à IA: ${ai.calls} · Perguntas enviadas: ${ai.questionsSent} · Respondidas: ${ai.answered} · Sem certeza: ${ai.unknown}` +
      (ai.lastModel ? ` · Modelo: ${ai.lastModel}` : '') +
      (ai.lastMs !== undefined ? ` · Última resposta em ${(ai.lastMs / 1000).toFixed(1)} s` : '') +
      (ai.lastError ? ` · Último erro: ${ai.lastError}` : '');
  }

  $('diary-box').textContent =
    st.run.diary.length > 0
      ? st.run.diary.join('\n')
      : 'O diário aparecerá aqui assim que você iniciar uma rodada.';

  const jobsList = $('jobs-history-list');
  jobsList.innerHTML = '';
  if (st.run.jobs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'status-note muted';
    empty.textContent = 'Nenhuma vaga processada nesta rodada.';
    jobsList.appendChild(empty);
  } else {
    for (const j of st.run.jobs) {
      const card = document.createElement('div');
      card.className = 'item-card';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = `${j.title} — ${j.company || 'Empresa'}`;
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      meta.textContent = j.detail;
      card.appendChild(title);
      card.appendChild(meta);
      jobsList.appendChild(card);
    }
  }
}

// ---------------------------------------------------------------------------
// Eventos dos botões
// ---------------------------------------------------------------------------
$('btn-pick-pdf').addEventListener('click', () => {
  $<HTMLInputElement>('resume-file-input').click();
});

$<HTMLInputElement>('resume-file-input').addEventListener('change', async (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const btn = $<HTMLButtonElement>('btn-pick-pdf');
  btn.disabled = true;
  btn.textContent = 'Lendo seu currículo...';

  try {
    const extracted = await readResumeFile(file);
    const res = await sendBg<{ aiQueued: boolean }>({
      type: 'SAVE_RESUME',
      fileName: file.name,
      text: extracted.text,
      pdfBase64: extracted.pdfBase64,
    });

    kbEditorDirty = false;
    const fresh = await loadState();
    renderState(fresh);

    if (res.ok && res.data?.aiQueued) {
      showToast('Currículo salvo! Montando sua Ficha em segundo plano (leva ~3s)...');
    } else {
      showToast('Currículo salvo! Agora cole sua chave no Passo 2.');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Trocar PDF do currículo';
    input.value = '';
  }
});

$('btn-toggle-kb').addEventListener('click', () => {
  $('kb-editor').classList.toggle('hidden');
});

$('btn-rebuild-kb').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-rebuild-kb');
  btn.disabled = true;
  btn.textContent = 'A IA está lendo...';
  try {
    // Se a pessoa colou texto bruto manualmente, salva antes de gerar
    const rawText = $<HTMLTextAreaElement>('kb-raw-resume').value.trim();
    if (rawText && (!currentState?.resume || currentState.resume.text !== rawText)) {
      await sendBg({
        type: 'SAVE_RESUME',
        fileName: currentState?.resume?.fileName ?? 'curriculo-colado.txt',
        text: rawText,
      });
    } else {
      const res = await sendBg<{ modelUsed: string }>({ type: 'BUILD_KNOWLEDGE_FROM_AI' });
      if (!res.ok) {
        showToast(res.error ?? 'Não foi possível montar a ficha.');
        return;
      }
    }
    kbEditorDirty = false;
    renderState(await loadState());
    $('kb-editor').classList.remove('hidden');
    showToast('Ficha de Conhecimento atualizada pela IA!');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Montar ficha com a IA';
  }
});

$('btn-save-kb').addEventListener('click', async () => {
  if (!currentState) return;
  const rawText = $<HTMLTextAreaElement>('kb-raw-resume').value.trim();
  if (rawText && (!currentState.resume || currentState.resume.text !== rawText)) {
    await sendBg({
      type: 'SAVE_RESUME',
      fileName: currentState.resume?.fileName ?? 'curriculo-texto.txt',
      text: rawText,
    });
  }
  const updatedKb = readKbForm(currentState.knowledge);
  await sendBg({ type: 'SAVE_KNOWLEDGE', knowledge: updatedKb });
  kbEditorDirty = false;
  showToast('Ficha de Conhecimento salva!');
});

$('btn-toggle-key-vis').addEventListener('click', () => {
  const inp = $<HTMLInputElement>('ai-key-input');
  const btn = $('btn-toggle-key-vis');
  if (inp.type === 'password') {
    inp.type = 'text';
    btn.textContent = 'Ocultar';
  } else {
    inp.type = 'password';
    btn.textContent = 'Mostrar';
  }
});

$('btn-save-test-ai').addEventListener('click', async () => {
  const apiKey = $<HTMLInputElement>('ai-key-input').value.trim();
  const preferredModel = $<HTMLSelectElement>('ai-model-select').value;
  const btn = $<HTMLButtonElement>('btn-save-test-ai');
  const out = $('ai-test-output');

  btn.disabled = true;
  btn.textContent = 'Testando chave e currículo no Google...';
  out.classList.remove('hidden');
  out.className = 'status-note muted mt-8';
  out.textContent = 'Conectando ao Google AI Studio e testando 4 perguntas reais...';

  try {
    const res = await sendBg<{
      ok: boolean;
      modelUsed?: string;
      results: TestAiQuestionResult[];
    }>({
      type: 'SAVE_AND_TEST_AI',
      apiKey,
      preferredModel,
    });

    if (!res.ok || !res.data) {
      out.dataset.detailed = 'true';
      out.className = 'status-note err mt-8';
      out.textContent = res.error ?? 'Falha ao testar a chave.';
      return;
    }

    out.dataset.detailed = 'true';
    out.className = 'status-note ok mt-8';
    const lines = [
      `Tudo certo! Modelo ativo: ${res.data.modelUsed}`,
      '',
      ...res.data.results.map((r, i) => `${i + 1}. ${r.question}\n   → ${r.answer}`),
    ];
    out.style.whiteSpace = 'pre-line';
    out.textContent = lines.join('\n');
    kbEditorDirty = false;
    renderState(await loadState());
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar e testar IA com meu currículo';
  }
});

async function persistRunSettingsFromUi(): Promise<void> {
  if (!currentState) return;
  const modes: WorkMode[] = [];
  if ($<HTMLInputElement>('wm-remote').checked) modes.push('remote');
  if ($<HTMLInputElement>('wm-hybrid').checked) modes.push('hybrid');
  if ($<HTMLInputElement>('wm-onsite').checked) modes.push('onsite');
  if (modes.length === 0) modes.push('remote', 'hybrid', 'onsite');

  const maxJobs = Math.max(1, Math.min(200, Number($<HTMLInputElement>('set-max-jobs').value) || 20));
  const pauseAfterSubmitSec = Number($<HTMLSelectElement>('set-pace').value) || 3;
  const simulateOnly = $<HTMLInputElement>('mode-sim').checked;
  const unfollowCompany = $<HTMLInputElement>('set-unfollow').checked;

  await sendBg({
    type: 'SAVE_SETTINGS',
    settings: {
      ...currentState.settings,
      maxJobs,
      pauseAfterSubmitSec,
      pauseAfterSkipSec: 0.4,
      simulateOnly,
      unfollowCompany,
      acceptedWorkModes: modes,
    },
  });
}

for (const id of ['mode-real', 'mode-sim', 'set-max-jobs', 'set-pace', 'wm-remote', 'wm-hybrid', 'wm-onsite', 'set-unfollow']) {
  $(id).addEventListener('change', () => {
    void persistRunSettingsFromUi();
  });
}

$('btn-open-li-search').addEventListener('click', async () => {
  await persistRunSettingsFromUi();
  await sendBg({ type: 'OPEN_LINKEDIN_SEARCH' });
  showToast('Abrindo a busca de vagas filtrada no LinkedIn...');
});

// Pretensão salarial direto no Passo 3: é a pergunta que mais trava vaga e não está no currículo.
$<HTMLInputElement>('quick-salary').addEventListener('change', async () => {
  if (!currentState) return;
  const digits = $<HTMLInputElement>('quick-salary').value.replace(/[^\d]/g, '');
  await sendBg({ type: 'SAVE_KNOWLEDGE', knowledge: { ...currentState.knowledge, salaryExpectation: digits } });
  showToast(digits ? 'Pretensão salarial guardada na sua Ficha.' : 'Pretensão salarial apagada da Ficha.');
});

$('btn-start-batch').addEventListener('click', async () => {
  await persistRunSettingsFromUi();
  let preferredTabId: number | undefined;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    preferredTabId = activeTab?.id;
  } catch {
    // ignore
  }
  const res = await sendBg({ type: 'START_BATCH', preferredTabId });
  if (!res.ok) {
    showToast(res.error ?? 'Não foi possível iniciar.');
    return;
  }
  showToast('Rodada iniciada! Acompanhe aqui ou na aba Diário.');
});

$('btn-pause-resume').addEventListener('click', async () => {
  if (currentState?.run.status === 'paused') {
    await sendBg({ type: 'RESUME_BATCH' });
  } else {
    await sendBg({ type: 'PAUSE_BATCH' });
  }
});

$('btn-stop').addEventListener('click', async () => {
  await sendBg({ type: 'STOP_BATCH' });
  showToast('Parando após fechar o diálogo atual...');
});

$('btn-add-bank').addEventListener('click', async () => {
  const q = $<HTMLInputElement>('new-bank-q').value.trim();
  const a = $<HTMLInputElement>('new-bank-a').value.trim();
  const res = await sendBg({ type: 'SAVE_BANK_ANSWER', question: q, answer: a });
  if (res.ok) {
    $<HTMLInputElement>('new-bank-q').value = '';
    $<HTMLInputElement>('new-bank-a').value = '';
    showToast('Resposta adicionada ao banco!');
  } else {
    showToast(res.error ?? 'Preencha pergunta e resposta.');
  }
});

$('btn-copy-diary').addEventListener('click', async () => {
  const text = $('diary-box').textContent ?? '';
  await navigator.clipboard.writeText(text);
  showToast('Diário copiado! Pode colar no chat.');
});

$('btn-clear-diary').addEventListener('click', async () => {
  await sendBg({ type: 'CLEAR_DIARY' });
  showToast('Diário limpo.');
});

// ---------------------------------------------------------------------------
// Inicialização e atualização ao vivo via storage
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    void loadState().then(renderState);
  }
});

void loadState().then(renderState);

// Versão à vista no topo, para dar para conferir que a extensão recarregada é a nova.
try {
  $('app-version').textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  // ignore
}
