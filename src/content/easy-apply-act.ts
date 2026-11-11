import type { FieldFillInstruction, FormStepSnapshot } from '../shared/types.ts';
import { matchBestOption, normalizeText } from '../shared/normalize.ts';
import {
  type BrowserWin,
  clickElement,
  cssEscapeId,
  isOwnUi,
  isVisible,
  pollUntil,
  resetDomScanCache,
  setNativeControlValue,
  sleep,
  visibleTextOf,
} from './dom-utils.ts';
import {
  classifyModalPrimaryButton,
  findEasyApplyModal,
  getLiveFieldHandle,
  getUncheckedResumeRadios,
  isStepReady,
  readEasyApplyStep,
} from './easy-apply-read.ts';
import { findEasyApplyButton, readOpenJobSnapshot } from './job-search.ts';

/**
 * Registra os valores que a própria extensão escreveu, para sabermos diferenciar o que a pessoa digitou à mão!
 */
const extensionWrittenValues = new WeakMap<Element, string>();

export function wasWrittenByExtension(el: Element, currentValue: string): boolean {
  return extensionWrittenValues.get(el) === currentValue;
}

/**
 * Enquanto a extensão está escrevendo (e um instante depois), nenhuma mudança de campo é "a pessoa digitando".
 * Sem isso, o que a IA escrevia era guardado como resposta dada pela pessoa (a anotação acima só era feita DEPOIS do
 * aviso de mudança do campo), e passava a valer como verdade para outras vagas.
 */
let extensionWritingUntil = 0;

export function markExtensionWriting(ms = 1500): void {
  extensionWritingUntil = Math.max(extensionWritingUntil, Date.now() + ms);
}

export function isExtensionWriting(): boolean {
  return Date.now() < extensionWritingUntil;
}

export async function clickEasyApplyForJob(
  doc: Document,
  win: Window,
  jobId: string,
): Promise<'opened' | 'already_open' | 'no_easy_apply' | 'already_applied' | 'not_linked' | 'timeout' | 'blocked_by_dialog'> {
  // Um formulário já aberto antes do clique é de OUTRA vaga (sobrou de um descarte que não fechou). Aproveitá-lo
  // seria preencher e enviar a candidatura da vaga errada: tenta fechar e, se não fechar, desiste desta vaga.
  if (findEasyApplyModal(doc, win)) {
    await dismissAllOpenDialogs(doc, win, 'discard');
    if (findEasyApplyModal(doc, win)) return 'blocked_by_dialog';
  }

  const openSnap = readOpenJobSnapshot(doc, win);
  if (openSnap.jobId !== jobId) {
    return 'not_linked';
  }
  if (openSnap.alreadyApplied) {
    return 'already_applied';
  }

    const btn = await pollUntil(() => findEasyApplyButton(doc, win, jobId), 1500, 80);
  if (!btn) {
    const recheck = readOpenJobSnapshot(doc, win);
    return recheck.alreadyApplied ? 'already_applied' : 'no_easy_apply';
  }

  clickElement(btn, win);

  const openedModal = await pollUntil(() => findEasyApplyModal(doc, win), 6000, 80);
  return openedModal ? 'opened' : 'timeout';
}

async function fillComboboxTypeahead(input: HTMLInputElement, text: string, doc: Document, win: Window): Promise<boolean> {
  setNativeControlValue(input, text, win);
  input.focus();
  await sleep(550);

  // Procura opções visíveis de autocomplete ([role="option"])
  const options = Array.from(doc.querySelectorAll('[role="listbox"] [role="option"], [role="option"]')).filter((el) =>
    isVisible(el, win),
  );

  if (options.length > 0) {
    const mapped = options.map((el) => ({ el, label: visibleTextOf(el, win) }));
    const best = matchBestOption(mapped, text) ?? mapped[0];
    if (best) {
      clickElement(best.el, win);
      await sleep(200);
      return true;
    }
  }

  // Fallback teclado (ArrowDown + Enter)
  const g = win as BrowserWin;
  input.dispatchEvent(new g.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await sleep(150);
  input.dispatchEvent(new g.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.blur();
  return true;
}

export async function applyFieldInstructions(
  doc: Document,
  win: Window,
  instructions: readonly FieldFillInstruction[],
): Promise<{ appliedCount: number; errors: Array<{ fieldId: string; error: string }> }> {
  let appliedCount = 0;
  const errors: Array<{ fieldId: string; error: string }> = [];
  markExtensionWriting(2500 + instructions.length * 900);

  // Se a etapa tem cartões de currículo e nenhum está selecionado, marca o primeiro automaticamente!
  const resumes = getUncheckedResumeRadios();
  if (resumes.length > 0 && !resumes.some((r) => r.checked)) {
    const firstResume = resumes[0]!;
    extensionWrittenValues.set(firstResume, 'checked');
    clickElement(firstResume, win);
  }

  for (const inst of instructions) {
    const handle = getLiveFieldHandle(inst.fieldId);
    if (!handle || !handle.primaryEl.isConnected) {
      errors.push({ fieldId: inst.fieldId, error: 'campo não encontrado na página' });
      continue;
    }

    try {
      if (handle.type === 'radio') {
        const opts = handle.optionEls ?? [];
        const target =
          opts.find((o) => o.id === inst.value) ??
          (inst.optionLabel ? matchBestOption(opts, inst.optionLabel) : null) ??
          matchBestOption(opts, inst.value);
        if (!target) {
          errors.push({ fieldId: inst.fieldId, error: 'opção não encontrada no rádio' });
          continue;
        }
        const radioEl = target.el as HTMLInputElement;
        extensionWrittenValues.set(radioEl, radioEl.value);
        if (!radioEl.checked) {
          clickElement(radioEl, win);
          // Caso o LinkedIn ouça o clique no label/bloco em vez do input oculto
          if (!radioEl.checked && radioEl.id) {
            const lbl = doc.querySelector(`label[for="${cssEscapeId(radioEl.id)}"]`);
            if (lbl) clickElement(lbl, win);
          }
        }
        appliedCount += 1;
        continue;
      }

      if (handle.type === 'select') {
        const sel = handle.primaryEl as HTMLSelectElement;
        const opts = Array.from(sel.options)
          .filter((o) => o.value.trim() !== '')
          .map((o) => ({ id: o.value, label: (o.textContent ?? '').trim(), opt: o }));
        const target =
          opts.find((o) => o.id === inst.value) ??
          (inst.optionLabel ? matchBestOption(opts, inst.optionLabel) : null) ??
          matchBestOption(opts, inst.value);
        if (!target) {
          errors.push({ fieldId: inst.fieldId, error: 'opção não encontrada na lista' });
          continue;
        }
        extensionWrittenValues.set(sel, target.id);
        setNativeControlValue(sel, target.id, win);
        appliedCount += 1;
        continue;
      }

      if (handle.type === 'checkbox') {
        const cb = handle.primaryEl as HTMLInputElement;
        const want = inst.checked ?? inst.value === 'true';
        extensionWrittenValues.set(cb, String(want));
        if (cb.checked !== want) {
          clickElement(cb, win);
          if (cb.checked !== want && cb.id) {
            const lbl = doc.querySelector(`label[for="${cssEscapeId(cb.id)}"]`);
            if (lbl) clickElement(lbl, win);
          }
        }
        extensionWrittenValues.set(cb, String(want));
        appliedCount += 1;
        continue;
      }

      if (handle.type === 'combobox') {
        const input = handle.primaryEl as HTMLInputElement;
        extensionWrittenValues.set(input, inst.value);
        await fillComboboxTypeahead(input, inst.value, doc, win);
        extensionWrittenValues.set(input, input.value);
        appliedCount += 1;
        continue;
      }

      // text, number, textarea
      const input = handle.primaryEl as HTMLInputElement | HTMLTextAreaElement;
      extensionWrittenValues.set(input, inst.value);
      setNativeControlValue(input, inst.value, win);
      extensionWrittenValues.set(input, input.value);
      appliedCount += 1;
    } catch {
      errors.push({ fieldId: inst.fieldId, error: 'falha ao preencher controle' });
    }
  }

  if (appliedCount > 0) await sleep(60);
  markExtensionWriting(1200);
  return { appliedCount, errors };
}

export async function clickStepNavigationButton(
  doc: Document,
  win: Window,
  wantedKind: 'next' | 'review' | 'submit',
  fromSignature: string,
): Promise<{
  outcome: 'advanced' | 'submitted' | 'validation_error' | 'blocked';
  pageErrors: string[];
  step: FormStepSnapshot;
}> {
  const modal = findEasyApplyModal(doc, win);
  if (!modal) {
    return { outcome: 'blocked', pageErrors: ['Modal fechou inesperadamente'], step: readEasyApplyStep(doc, win) };
  }

  const nav = classifyModalPrimaryButton(modal, win);
  if (!nav.el || nav.kind === 'none') {
    const snap = readEasyApplyStep(doc, win);
    return { outcome: 'blocked', pageErrors: snap.pageErrors, step: snap };
  }

  // Proteção: NUNCA clica em "Enviar candidatura" se o orquestrador pediu 'next' ou 'review' (modo simulação!)
  if (nav.kind === 'submit' && wantedKind !== 'submit') {
    const snap = readEasyApplyStep(doc, win);
    return { outcome: 'blocked', pageErrors: ['Parado antes de enviar (modo simulação)'], step: snap };
  }

  clickElement(nav.el, win);

  if (wantedKind === 'submit') {
    // Espera o modal do formulário fechar ou aparecer a confirmação de envio (até 7s)
    const finished = await pollUntil(() => {
      const stillForm = findEasyApplyModal(doc, win);
      if (!stillForm) return 'closed';
      const snap = readEasyApplyStep(doc, win);
      if (snap.pageErrors.length > 0) return 'error';
      return null;
    }, 6500, 80);

    const afterStep = readEasyApplyStep(doc, win);
    if (finished === 'closed' || !afterStep.modalOpen) {
      return { outcome: 'submitted', pageErrors: [], step: afterStep };
    }
    return {
      outcome: afterStep.pageErrors.length > 0 ? 'validation_error' : 'blocked',
      pageErrors: afterStep.pageErrors,
      step: afterStep,
    };
  }

  // Avançar / Avaliar: espera a etapa NOVA ficar pronta (assinatura diferente e botão do rodapé já na tela).
  // Na troca de etapa o diálogo passa um instante vazio; contar esse vazio como "etapa nova" fazia a leitura seguinte
  // encontrar 0 campos e nenhum botão.
  const changed = await pollUntil(() => {
    const m = findEasyApplyModal(doc, win);
    if (!m) return 'closed';
    const snap = readEasyApplyStep(doc, win);
    if (snap.signature !== fromSignature && isStepReady(snap)) return 'changed';
    if (snap.pageErrors.length > 0) return 'error';
    return null;
  }, 8000, 80);

  const afterStep = readEasyApplyStep(doc, win);
  if (changed === 'changed' || !afterStep.modalOpen) {
    return { outcome: 'advanced', pageErrors: [], step: afterStep };
  }
  if (afterStep.pageErrors.length > 0) {
    return { outcome: 'validation_error', pageErrors: afterStep.pageErrors, step: afterStep };
  }
  return { outcome: 'blocked', pageErrors: afterStep.pageErrors, step: afterStep };
}

/**
 * Fecha qualquer diálogo aberto (seja pós-envio "Concluído", seja fechar o formulário e clicar em "Descartar" no aviso "Salvar esta candidatura?").
 * NUNCA clica em "Salvar".
 */
export async function dismissAllOpenDialogs(doc: Document, win: Window, mode: 'discard' | 'post_apply'): Promise<boolean> {
  const openDialogs = (): Element[] =>
    Array.from(doc.querySelectorAll('dialog[open], dialog[data-testid="dialog"], [role="dialog"], .jobs-easy-apply-modal')).filter(
      (d) => !isOwnUi(d) && isVisible(d, win),
    );
  const buttonsOf = (dlg: Element): Element[] =>
    Array.from(dlg.querySelectorAll('button')).filter((b) => !isOwnUi(b) && isVisible(b, win) && !(b as HTMLButtonElement).disabled);
  const nameOf = (b: Element): string => normalizeText(visibleTextOf(b, win) || (b.getAttribute('aria-label') ?? ''));
  const findInAny = (dialogs: readonly Element[], accept: (name: string) => boolean): Element | null => {
    for (const dlg of dialogs) {
      const hit = buttonsOf(dlg).find((b) => accept(nameOf(b)));
      if (hit) return hit;
    }
    return null;
  };
  const isDiscard = (name: string): boolean => name === 'descartar' || name === 'discard';

  for (let attempt = 0; attempt < 6; attempt += 1) {
    resetDomScanCache();
    const dialogs = openDialogs();
    if (dialogs.length === 0) return true;

    // 1. O aviso "Salvar esta candidatura?" pode estar antes ou depois do formulário na página: procura o "Descartar"
    //    em TODOS os diálogos antes de qualquer outra coisa. Antes, o X do formulário era clicado de novo a cada volta
    //    e o "Descartar" nunca era alcançado quando o aviso vinha depois; o formulário ficava aberto para a vaga seguinte.
    const discardBtn = findInAny(dialogs, isDiscard);
    if (discardBtn) {
      clickElement(discardBtn, win);
      await pollUntil(() => openDialogs().length < dialogs.length, 1500, 80);
      continue;
    }

    // 2. Confirmação pós-envio -> "Concluído" / "Done"
    if (mode === 'post_apply') {
      const doneBtn = findInAny(dialogs, (name) => name === 'concluido' || name === 'done' || name === 'fechar' || name === 'dismiss');
      if (doneBtn) {
        clickElement(doneBtn, win);
        await pollUntil(() => openDialogs().length < dialogs.length, 1500, 80);
        continue;
      }
    }

    // 3. O X ("Fechar" / "Dismiss") do diálogo de cima (o último da página). Depois espera o aviso com "Descartar"
    //    aparecer ou tudo fechar. NUNCA clica em "Salvar".
    let closeBtn: Element | null = null;
    for (const dlg of [...dialogs].reverse()) {
      closeBtn =
        buttonsOf(dlg).find((b) => {
          const aria = normalizeText(b.getAttribute('aria-label') ?? '');
          const txt = normalizeText(visibleTextOf(b, win));
          return aria === 'fechar' || aria === 'dismiss' || aria.startsWith('fechar ') || txt === 'fechar';
        }) ?? null;
      if (closeBtn) break;
    }
    if (!closeBtn) break;
    clickElement(closeBtn, win);
    await pollUntil(() => {
      const now = openDialogs();
      return now.length === 0 || now.length !== dialogs.length || findInAny(now, isDiscard) !== null;
    }, 1500, 80);
  }

  resetDomScanCache();
  return openDialogs().length === 0;
}
