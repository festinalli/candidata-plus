import type { BgToContentMessage, ContentToBgMessage } from '../shared/messages.ts';
import type { FormFieldType } from '../shared/types.ts';
import { cleanQuestionLabel, normalizeText } from '../shared/normalize.ts';
import { OWN_UI_ATTR, cssEscapeId, resetDomScanCache, visibleTextOf } from './dom-utils.ts';
import {
  diagnosePageDom,
  goToNextSearchPage,
  jobsPageKind,
  listJobCards,
  openJobCardAndWait,
  readOpenJobSnapshot,
  scrollJobListForMore,
} from './job-search.ts';
import { findEasyApplyModal, getLiveFieldHandle, readEasyApplyStep, readEasyApplyStepWhenReady } from './easy-apply-read.ts';
import {
  applyFieldInstructions,
  clickEasyApplyForJob,
  clickStepNavigationButton,
  dismissAllOpenDialogs,
  isExtensionWriting,
  wasWrittenByExtension,
} from './easy-apply-act.ts';

function sendToBg(msg: ContentToBgMessage): void {
  try {
    void chrome.runtime.sendMessage(msg);
  } catch {
    // contexto recarregado
  }
}

/**
 * Botão discreto no canto inferior direito das páginas de vagas do LinkedIn para abrir a Candidata+ 2 com 1 clique.
 */
function mountFloatingLauncher(): void {
  const existing = document.getElementById('candidata-plus-v2-fab');
  const onJobsPage = window.location.pathname.startsWith('/jobs');

  if (!onJobsPage) {
    existing?.remove();
    return;
  }
  if (existing) return;

  const btn = document.createElement('button');
  btn.id = 'candidata-plus-v2-fab';
  btn.type = 'button';
  btn.setAttribute(OWN_UI_ATTR, 'true');
  btn.textContent = 'Candidata+ 2';
  btn.title = 'Abrir painel lateral da Candidata+ 2';
  btn.addEventListener('click', () => {
    sendToBg({ type: 'OPEN_SIDE_PANEL' });
  });
  document.body.appendChild(btn);
}

/**
 * Aprende respostas que a própria pessoa preenche manualmente dentro do modal do LinkedIn Easy Apply!
 */
function setupManualAnswerLearner(): void {
  document.addEventListener(
    'change',
    (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLElement)) return;
      // Só aprende o que a PESSOA mudou: aviso de mudança disparado por código (o da própria extensão ao preencher)
      // não é confiável, e durante o preenchimento automático nada é aprendido.
      if (!ev.isTrusted || isExtensionWriting()) return;
      const modal = findEasyApplyModal(document, window);
      if (!modal || !modal.contains(target)) return;

      if (target instanceof HTMLInputElement) {
        if (['hidden', 'file', 'password', 'checkbox'].includes(target.type)) return;
        if (target.type === 'radio') {
          if (!target.checked || wasWrittenByExtension(target, target.value)) return;
          if (target.name.toLowerCase().includes('resume')) return;
          const step = readEasyApplyStep(document, window);
          // O grupo de opções a que pertence o rádio clicado (antes pegava o primeiro grupo respondido da etapa).
          const matchedField = step.fields.find(
            (f) => f.type === 'radio' && (getLiveFieldHandle(f.fieldId)?.optionEls ?? []).some((o) => o.el === target),
          );
          if (matchedField && matchedField.currentValue) {
            sendToBg({
              type: 'MANUAL_FIELD_LEARNED',
              question: matchedField.label,
              answer: matchedField.currentValue,
              fieldType: 'radio',
            });
          }
          return;
        }

        const val = target.value.trim();
        if (!val || wasWrittenByExtension(target, val)) return;
        const lbl =
          (target.id ? visibleTextOf(document.querySelector(`label[for="${cssEscapeId(target.id)}"]`) ?? target, window) : '') ||
          (target.getAttribute('aria-label') ?? '');
        const clean = cleanQuestionLabel(lbl);
        if (!clean) return;
        // Não sobrepõe dados fixos de contato do LinkedIn
        const norm = normalizeText(clean);
        if (/\b(e mail|email|celular|telefone|codigo do pais)\b/.test(norm)) return;

        const fType: FormFieldType = target.type === 'number' ? 'number' : 'text';
        sendToBg({ type: 'MANUAL_FIELD_LEARNED', question: clean, answer: val, fieldType: fType });
      } else if (target instanceof HTMLSelectElement) {
        const val = target.selectedOptions[0]?.textContent?.trim() ?? '';
        if (!val || wasWrittenByExtension(target, target.value)) return;
        const lbl = cleanQuestionLabel(target.getAttribute('aria-label') ?? '');
        if (!lbl || /\b(e mail|email|codigo do pais)\b/.test(normalizeText(lbl))) return;
        sendToBg({ type: 'MANUAL_FIELD_LEARNED', question: lbl, answer: val, fieldType: 'select' });
      } else if (target instanceof HTMLTextAreaElement) {
        const val = target.value.trim();
        if (!val || wasWrittenByExtension(target, val)) return;
        const lbl = cleanQuestionLabel(target.getAttribute('aria-label') ?? '');
        if (!lbl) return;
        sendToBg({ type: 'MANUAL_FIELD_LEARNED', question: lbl, answer: val, fieldType: 'textarea' });
      }
    },
    true,
  );
}

/**
 * Roteador de comandos vindos do Service Worker (orquestrador do envio automático).
 */
chrome.runtime.onMessage.addListener((rawMsg: unknown, _sender, sendResponse) => {
  const msg = rawMsg as BgToContentMessage | undefined;
  if (!msg || typeof msg.type !== 'string') return false;

  void (async () => {
    try {
      resetDomScanCache();
      switch (msg.type) {
        case 'PING': {
          sendResponse({ ok: true, data: { url: window.location.href, ready: true } });
          return;
        }
        case 'LIST_CARDS': {
          const pageKind = jobsPageKind(document, window);
          const cards = pageKind === 'other' ? [] : listJobCards(document, window);
          const diag = diagnosePageDom(document, window);
          sendResponse({ ok: true, data: { cards, isSearchPage: pageKind !== 'other', pageKind, url: window.location.href, diag } });
          return;
        }
        case 'OPEN_CARD': {
          const result = await openJobCardAndWait(document, window, msg.jobId);
          sendResponse({ ok: true, data: result });
          return;
        }
        case 'READ_OPEN_JOB': {
          const openJob = readOpenJobSnapshot(document, window);
          sendResponse({ ok: true, data: { openJob } });
          return;
        }
        case 'CLICK_EASY_APPLY': {
          const outcome = await clickEasyApplyForJob(document, window, msg.jobId);
          sendResponse({ ok: true, data: { outcome } });
          return;
        }
        case 'READ_FORM_STEP': {
          const step = await readEasyApplyStepWhenReady(document, window);
          sendResponse({ ok: true, data: { step } });
          return;
        }
        case 'APPLY_FIELDS': {
          const applied = await applyFieldInstructions(document, window, msg.instructions);
          sendResponse({ ok: true, data: applied });
          return;
        }
        case 'CLICK_STEP_BUTTON': {
          const res = await clickStepNavigationButton(document, window, msg.kind, msg.fromSignature);
          sendResponse({ ok: true, data: res });
          return;
        }
        case 'DISMISS_ALL_DIALOGS': {
          const closed = await dismissAllOpenDialogs(document, window, msg.mode);
          sendResponse({ ok: true, data: { closed } });
          return;
        }
        case 'SCROLL_NEXT_CARDS': {
          const countAfterScroll = await scrollJobListForMore(document, window);
          sendResponse({ ok: true, data: { countAfterScroll } });
          return;
        }
        case 'GO_NEXT_RESULTS_PAGE': {
          const navigated = await goToNextSearchPage(document, window);
          sendResponse({ ok: true, data: { navigated } });
          return;
        }
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro na página do LinkedIn' });
    }
  })();

  return true;
});

mountFloatingLauncher();
setupManualAnswerLearner();
setInterval(mountFloatingLauncher, 2000);
