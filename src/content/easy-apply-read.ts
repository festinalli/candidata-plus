import type { FormFieldSnapshot, FormFieldType, FormOption, FormStepSnapshot } from '../shared/types.ts';
import { cleanQuestionLabel, collapseWhitespace, makeQuestionKey, normalizeText } from '../shared/normalize.ts';
import { cssEscapeId, isOwnUi, isSrOnly, isVisible, ownOptionBlockText, resetDomScanCache, visibleTextOf } from './dom-utils.ts';

/**
 * Registro em memória dos elementos vivos da etapa atual para escrita segura em easy-apply-act.ts.
 */
export interface LiveFieldHandle {
  fieldId: string;
  type: FormFieldType;
  primaryEl: Element;
  optionEls?: Array<{ id: string; label: string; el: Element }>;
}

const liveHandles = new Map<string, LiveFieldHandle>();
let resumeRadioCandidates: HTMLInputElement[] = [];

export function getLiveFieldHandle(fieldId: string): LiveFieldHandle | undefined {
  return liveHandles.get(fieldId);
}

export function getUncheckedResumeRadios(): HTMLInputElement[] {
  return resumeRadioCandidates;
}

function isDiscardDialogText(text: string): boolean {
  const norm = normalizeText(text);
  return norm.includes('salvar esta candidatura') || norm.includes('save this application') || norm.includes('descartar candidatura');
}

function isPostApplyDialogText(text: string): boolean {
  const norm = normalizeText(text);
  return (
    norm.includes('candidatura enviada') ||
    norm.includes('sua candidatura foi enviada') ||
    norm.includes('application sent') ||
    norm.includes('application submitted')
  );
}

/**
 * Encontra o modal ativo do formulário Easy Apply (tanto o <dialog data-testid="dialog"> da busca nova quanto o .jobs-easy-apply-modal clássico).
 */
export function findEasyApplyModal(doc: Document, win: Window): Element | null {
  const dialogs = Array.from(doc.querySelectorAll('dialog[open], dialog[data-testid="dialog"], [role="dialog"], .jobs-easy-apply-modal')).filter(
    (el) => !isOwnUi(el) && isVisible(el, win),
  );

  for (const dlg of dialogs) {
    const labelledBy = dlg.getAttribute('aria-labelledby') ?? '';
    const headerEl = labelledBy ? doc.getElementById(labelledBy) : dlg.querySelector('header, h1, h2');
    const headerText = headerEl ? visibleTextOf(headerEl, win) : (dlg.getAttribute('aria-label') ?? '');
    const sampleText = visibleTextOf(dlg, win).slice(0, 500);

    if (isDiscardDialogText(headerText) || isDiscardDialogText(sampleText)) continue;
    if (isPostApplyDialogText(headerText) || isPostApplyDialogText(sampleText)) continue;

    const normHeader = normalizeText(headerText);
    if (
      dlg.classList.contains('jobs-easy-apply-modal') ||
      normHeader.includes('candidate se') ||
      normHeader.includes('candidatar se') ||
      normHeader.includes('apply to') ||
      normHeader.includes('solicitar') ||
      dlg.querySelector('footer button') !== null
    ) {
      // Ignora compositor de mensagens
      if (normHeader.startsWith('mensagens') || normHeader.startsWith('nova mensagem') || normHeader.startsWith('messaging')) {
        continue;
      }
      return dlg;
    }
  }
  return null;
}

function isNoticeSection(el: Element, modal: Element): boolean {
  const section = el.closest('section');
  if (!section || section === modal || !modal.contains(section)) return false;
  if (section.querySelector('[data-testid="toasts-title"]')) return true;
  return section.querySelector('input, select, textarea, button, [role="button"]') === null;
}

function readProgressAndTitle(modal: Element, win: Window): { stepTitle: string; progressText: string } {
  let progressText = '';
  let stepTitle = '';

  const labelledBy = modal.getAttribute('aria-labelledby') ?? '';
  const modalHeader = labelledBy ? modal.ownerDocument.getElementById(labelledBy) : null;

  for (const el of Array.from(modal.querySelectorAll('p, span, div, h2, h3, h4'))) {
    if (isOwnUi(el) || isNoticeSection(el, modal)) continue;
    if (!isVisible(el, win) || isSrOnly(el, win)) continue;

    if (el.children.length === 0) {
      const txt = collapseWhitespace(el.textContent ?? '');
      if (!progressText && txt.length <= 50) {
        if (/^\d+\s+(?:de|of)\s+\d+\s*(?:paginas|páginas|etapas|steps|pages)?$/i.test(txt) || /^(?:etapa|step|pagina|página)\s+\d+\s+(?:de|of)\s+\d+$/i.test(txt)) {
          progressText = txt;
        }
      }
    }

    if (!stepTitle && (el.localName === 'h3' || el.localName === 'p')) {
      if (modalHeader?.contains(el)) continue;
      const txt = collapseWhitespace(el.textContent ?? '');
      if (
        /^(informacoes de contato|informações de contato|curriculo|currículo|perguntas adicionais|revise sua candidatura|experiencia profissional|experiência profissional|contact info|resume|additional questions|review your application|work experience)/i.test(
          txt,
        )
      ) {
        stepTitle = txt.replace(/\*+$/, '').trim();
      }
    }
  }

  if (!progressText) {
    const bar = modal.querySelector('[role="progressbar"][aria-valuenow]');
    const val = bar?.getAttribute('aria-valuenow');
    if (val) progressText = `${val}%`;
  }

  return { stepTitle, progressText };
}

export function classifyModalPrimaryButton(modal: Element, win: Window): {
  kind: 'next' | 'review' | 'submit' | 'none';
  label: string;
  el: HTMLElement | null;
} {
  const buttons = Array.from(modal.querySelectorAll('footer button, button')).filter(
    (b) => !isOwnUi(b) && !isNoticeSection(b, modal) && isVisible(b, win) && !(b as HTMLButtonElement).disabled,
  );

  let submitBtn: { label: string; el: HTMLElement } | null = null;
  let reviewBtn: { label: string; el: HTMLElement } | null = null;
  let nextBtn: { label: string; el: HTMLElement } | null = null;

  for (const btn of buttons) {
    const txt = visibleTextOf(btn, win) || (btn.getAttribute('aria-label') ?? '');
    const norm = normalizeText(txt);
    if (!norm) continue;

    if (/\b(enviar candidatura|submit application|enviar solicitud)\b/.test(norm)) {
      submitBtn = { label: txt, el: btn as HTMLElement };
    } else if (/\b(avaliar|revisar|revisar candidatura|review|review application)\b/.test(norm)) {
      reviewBtn = { label: txt, el: btn as HTMLElement };
    } else if (/\b(avancar|proximo|continuar|next|continue)\b/.test(norm)) {
      nextBtn = { label: txt, el: btn as HTMLElement };
    }
  }

  if (submitBtn) return { kind: 'submit', ...submitBtn };
  if (reviewBtn) return { kind: 'review', ...reviewBtn };
  if (nextBtn) return { kind: 'next', ...nextBtn };
  return { kind: 'none', label: '', el: null };
}

const CHAR_COUNTER_RE = /^\d+\s*(?:\/|de|of)\s*\d+(?:\s*(?:caracteres|characters|chars))?$/i;
const ERROR_HINT_RE =
  /\b(valor invalido|invalido|obrigatorio|insira|digite|selecione|escolha|numero inteiro|erro|invalid|required|enter a|please enter|please select|must be|whole number)\b/;

/**
 * Extrai mensagem de erro real associada a um campo (ignorando o contador "0/20" que mora no mesmo aria-describedby!).
 */
function readFieldValidationError(el: Element, doc: Document, win: Window): string | undefined {
  const ids = `${el.getAttribute('aria-errormessage') ?? ''} ${el.getAttribute('aria-describedby') ?? ''}`
    .split(/\s+/)
    .filter(Boolean);

  // Se o controle está dentro de um fieldset com aria-describedby (ex.: grupo de rádios na busca nova)
  const fieldset = el.closest('fieldset');
  if (fieldset) {
    for (const fid of (fieldset.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
      if (!ids.includes(fid)) ids.push(fid);
    }
  }

  const messages: string[] = [];
  for (const id of ids) {
    const target = doc.getElementById(id);
    if (!target || !isVisible(target, win)) continue;

    // Olha cada parágrafo/bloco folha para separar "Valor inválido" do contador "0/20"
    const blocks = target.querySelectorAll('p, span, div');
    const candidates = blocks.length > 0 ? Array.from(blocks) : [target];
    for (const b of candidates) {
      if (b.children.length > 0 && b.querySelector('p, div')) continue;
      if (isSrOnly(b, win)) continue;
      const txt = collapseWhitespace(b.textContent ?? '');
      if (!txt || CHAR_COUNTER_RE.test(txt)) continue;
      const norm = normalizeText(txt);
      if (
        el.getAttribute('aria-invalid') === 'true' ||
        b.getAttribute('role') === 'alert' ||
        b.closest('.artdeco-inline-feedback--error') !== null ||
        ERROR_HINT_RE.test(norm)
      ) {
        if (!messages.includes(txt)) messages.push(txt);
      }
    }
  }

  return messages.length > 0 ? messages.join(' | ') : undefined;
}

function readAllModalErrors(modal: Element, win: Window, fieldErrors: readonly string[]): string[] {
  const out = [...fieldErrors];
  for (const el of Array.from(modal.querySelectorAll('[role="alert"], .artdeco-inline-feedback--error, p'))) {
    if (isOwnUi(el) || isNoticeSection(el, modal) || !isVisible(el, win) || isSrOnly(el, win)) continue;
    if (el.localName === 'p' && el.children.length > 0) continue;
    const txt = collapseWhitespace(el.textContent ?? '');
    if (!txt || txt.length > 180 || CHAR_COUNTER_RE.test(txt)) continue;
    const norm = normalizeText(txt);
    if (
      el.getAttribute('role') === 'alert' ||
      el.classList.contains('artdeco-inline-feedback--error') ||
      /^(valor invalido|este campo e obrigatorio|selecione uma opcao|insira um numero.*|please enter a valid.*|this field is required)$/i.test(norm)
    ) {
      if (!out.includes(txt)) out.push(txt);
    }
  }
  return out.slice(0, 6);
}

function isResumeRadio(el: HTMLInputElement, win: Window): boolean {
  if (el.name.toLowerCase().includes('resume')) return true;
  if (el.closest('.jobs-document-upload-redesign-card__container')) return true;
  const aria = el.getAttribute('aria-label') ?? '';
  if (/\.(pdf|docx?|rtf|txt)$/i.test(aria.trim())) return true;
  const label = visibleTextOf(el.parentElement ?? el, win);
  return /\.(pdf|docx?)\b/i.test(label);
}

function resolveQuestionTextForSingleControl(el: Element, doc: Document, win: Window): { label: string; rawWithAsterisk: string } {
  const rawParts: string[] = [];

  // 1. <label for="id">
  if (el.id) {
    for (const lbl of Array.from(doc.querySelectorAll(`label[for="${cssEscapeId(el.id)}"]`))) {
      const t = visibleTextOf(lbl, win) || collapseWhitespace(lbl.textContent ?? '');
      if (t) rawParts.push(t);
    }
  }

  // 2. aria-labelledby
  for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
    const target = doc.getElementById(id);
    if (target) rawParts.push(visibleTextOf(target, win) || collapseWhitespace(target.textContent ?? ''));
  }

  // 3. <label> ancestral
  const parentLabel = el.closest('label');
  if (parentLabel) {
    const t = visibleTextOf(parentLabel, win);
    if (t) rawParts.push(t);
  }

  // 4. Na busca nova do LinkedIn, a pergunta é um <p> logo antes do bloco do input, e o input repete em aria-label sem asterisco!
  let precedingParagraph = '';
  for (let cur: Element | null = el.parentElement; cur !== null && cur.localName !== 'dialog'; cur = cur.parentElement) {
    const prev = cur.previousElementSibling;
    if (prev && (prev.localName === 'p' || prev.localName === 'label' || prev.localName === 'h3' || prev.localName === 'h4')) {
      const txt = visibleTextOf(prev, win);
      if (txt && txt.length <= 300) {
        precedingParagraph = txt;
        break;
      }
    }
    // Se subiu demais (um contêiner com vários inputs), para!
    if (cur.querySelectorAll('input, select, textarea').length > 1) break;
  }
  if (precedingParagraph) rawParts.push(precedingParagraph);

  // 5. aria-label direto no controle
  const aria = collapseWhitespace(el.getAttribute('aria-label') ?? '');
  if (aria) rawParts.push(aria);

  const chosen = rawParts.find((p) => cleanQuestionLabel(p) !== '') ?? (el.getAttribute('placeholder') ?? '');
  return {
    label: cleanQuestionLabel(chosen),
    rawWithAsterisk: rawParts.join(' '),
  };
}

function resolveGroupQuestion(radios: readonly HTMLInputElement[], doc: Document, win: Window): { label: string; rawWithAsterisk: string } {
  const first = radios[0]!;
  const rawParts: string[] = [];

  const group = first.closest('fieldset, [role="radiogroup"]');
  if (group) {
    const legend = group.querySelector('legend');
    if (legend) rawParts.push(visibleTextOf(legend, win) || collapseWhitespace(legend.textContent ?? ''));

    for (const id of (group.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
      const target = doc.getElementById(id);
      if (target) rawParts.push(visibleTextOf(target, win));
    }

    // Busca nova: <div componentkey="g"><p>Você trabalharia em um modelo híbrido?*</p><fieldset>...
    const prev = group.previousElementSibling;
    if (prev) rawParts.push(visibleTextOf(prev, win));

    const groupAria = group.getAttribute('aria-label') ?? '';
    if (groupAria) rawParts.push(groupAria);
  }

  // Na busca nova cada <input type="radio"> também repete a PERGUNTA em aria-label!
  const firstAria = collapseWhitespace(first.getAttribute('aria-label') ?? '');
  if (radios.length > 1 && firstAria) {
    const allSameAria = radios.every((r) => normalizeText(r.getAttribute('aria-label') ?? '') === normalizeText(firstAria));
    if (allSameAria) rawParts.push(firstAria);
  }

  const chosen = rawParts.find((p) => cleanQuestionLabel(p) !== '') ?? '';
  return {
    label: cleanQuestionLabel(chosen),
    rawWithAsterisk: rawParts.join(' '),
  };
}

export function readEasyApplyStep(doc: Document, win: Window): FormStepSnapshot {
  liveHandles.clear();
  resumeRadioCandidates = [];

  const modal = findEasyApplyModal(doc, win);
  if (!modal) {
    return {
      modalOpen: false,
      signature: '',
      stepTitle: '',
      progressText: '',
      buttonKind: 'none',
      buttonLabel: '',
      hasResumeCards: false,
      resumeSelected: false,
      pageErrors: [],
      fields: [],
    };
  }

  const { stepTitle, progressText } = readProgressAndTitle(modal, win);
  const nav = classifyModalPrimaryButton(modal, win);
  const labelledBy = modal.getAttribute('aria-labelledby') ?? '';
  const headerEl = labelledBy ? doc.getElementById(labelledBy) : modal.querySelector('header, h1, h2');
  const modalTitle = (headerEl ? visibleTextOf(headerEl, win) : (modal.getAttribute('aria-label') ?? '')).slice(0, 120);

  const rawControls = Array.from(modal.querySelectorAll('input, select, textarea')).filter((el) => {
    if (isOwnUi(el) || isNoticeSection(el, modal)) return false;
    if (el.localName === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (['hidden', 'button', 'submit', 'reset', 'file', 'password', 'image'].includes(t)) return false;
    }
    if ((el as HTMLInputElement).disabled) return false;
    // Rádios/caixas estilizados pelo LinkedIn podem ter 1px mas o bloco pai é visível
    const checkTarget =
      el.localName === 'input' && ['radio', 'checkbox'].includes((el.getAttribute('type') ?? '').toLowerCase())
        ? (el.parentElement ?? el)
        : el;
    return isVisible(checkTarget, win);
  });

  // Separa rádios de currículo dos campos reais de pergunta
  const controls: Element[] = [];
  let hasResumeCards = false;
  let resumeSelected = false;

  for (const el of rawControls) {
    if (el.localName === 'input' && (el as HTMLInputElement).type === 'radio' && isResumeRadio(el as HTMLInputElement, win)) {
      hasResumeCards = true;
      const radio = el as HTMLInputElement;
      if (radio.checked) resumeSelected = true;
      resumeRadioCandidates.push(radio);
      continue;
    }
    controls.push(el);
  }

  // Na tela de revisão ("Revise sua candidatura" / botão Enviar candidatura), ignora controles das seções resumidas exceto "Siga a empresa"
  const isReviewScreen = nav.kind === 'submit' || /\b(revise|review)\b/i.test(stepTitle);

  const processedRadios = new Set<Element>();
  const fields: FormFieldSnapshot[] = [];
  const fieldErrors: string[] = [];
  let seq = 0;

  for (const el of controls) {
    if (processedRadios.has(el)) continue;

    // GRUPO DE RÁDIOS
    if (el.localName === 'input' && (el as HTMLInputElement).type === 'radio') {
      if (isReviewScreen) continue;
      const radio = el as HTMLInputElement;
      const groupRoot = radio.closest('fieldset, [role="radiogroup"]');
      const groupMembers = controls.filter((c): c is HTMLInputElement => {
        if (c.localName !== 'input' || (c as HTMLInputElement).type !== 'radio') return false;
        if (radio.name && (c as HTMLInputElement).name === radio.name) return true;
        return groupRoot !== null && groupRoot.contains(c);
      });
      for (const m of groupMembers) processedRadios.add(m);

      const q = resolveGroupQuestion(groupMembers, doc, win);
      if (!q.label) continue;

      const ownLabels = groupMembers.map((m) => {
        if (m.id) {
          const lbl = doc.querySelector(`label[for="${cssEscapeId(m.id)}"]`);
          const txt = lbl ? visibleTextOf(lbl, win) : '';
          if (txt) return cleanQuestionLabel(txt);
        }
        return '';
      });
      const repeatedOrEmpty =
        ownLabels.some((l) => l === '' || normalizeText(l) === normalizeText(q.label)) ||
        new Set(ownLabels.map((l) => normalizeText(l))).size < ownLabels.length;

      const optionEls = groupMembers.map((m, idx) => {
        let optLabel = ownLabels[idx] ?? '';
        if (repeatedOrEmpty || !optLabel) {
          const blockTxt = cleanQuestionLabel(ownOptionBlockText(m, groupMembers, win));
          if (blockTxt) optLabel = blockTxt;
        }
        if (!optLabel) optLabel = m.value || `Opção ${idx + 1}`;
        const optId = m.value && m.value !== 'on' ? m.value : `${idx}:${normalizeText(optLabel)}`;
        return { id: optId, label: optLabel, el: m };
      });

      const checkedMember = optionEls.find((o) => (o.el as HTMLInputElement).checked);
      const errText = readFieldValidationError(radio, doc, win);
      if (errText) fieldErrors.push(`${q.label}: ${errText}`);

      const required =
        groupMembers.some((m) => m.required || m.getAttribute('aria-required') === 'true') ||
        /\*/.test(q.rawWithAsterisk);

      const fieldId = `f_${++seq}`;
      liveHandles.set(fieldId, {
        fieldId,
        type: 'radio',
        primaryEl: radio,
        optionEls,
      });

      fields.push({
        fieldId,
        questionKey: makeQuestionKey(q.label, 'radio'),
        label: q.label,
        type: 'radio',
        required,
        currentValue: checkedMember?.label ?? '',
        options: optionEls.map((o): FormOption => ({ id: o.id, label: o.label })),
        errorText: errText,
      });
      continue;
    }

    // SELECT NATIVO
    if (el.localName === 'select') {
      if (isReviewScreen) continue;
      const sel = el as HTMLSelectElement;
      const q = resolveQuestionTextForSingleControl(sel, doc, win);
      if (!q.label) continue;

      const options: FormOption[] = [];
      let currentLabel = '';
      for (const opt of Array.from(sel.options)) {
        const val = opt.value.trim();
        const lbl = collapseWhitespace(opt.textContent ?? '');
        if (!val || !lbl || /^(selecione|select an option|choose|--)/i.test(lbl)) continue;
        options.push({ id: val, label: lbl });
        if (opt.selected) currentLabel = lbl;
      }

      const errText = readFieldValidationError(sel, doc, win);
      if (errText) fieldErrors.push(`${q.label}: ${errText}`);

      const required = sel.required || sel.getAttribute('aria-required') === 'true' || /\*/.test(q.rawWithAsterisk);
      const fieldId = `f_${++seq}`;
      liveHandles.set(fieldId, { fieldId, type: 'select', primaryEl: sel });

      fields.push({
        fieldId,
        questionKey: makeQuestionKey(q.label, 'select'),
        label: q.label,
        type: 'select',
        required,
        currentValue: currentLabel,
        options,
        errorText: errText,
      });
      continue;
    }

    // CHECKBOX
    if (el.localName === 'input' && (el as HTMLInputElement).type === 'checkbox') {
      const cb = el as HTMLInputElement;
      const q = resolveQuestionTextForSingleControl(cb, doc, win);
      const label = q.label || cleanQuestionLabel(ownOptionBlockText(cb, [cb], win));
      if (!label) continue;

      const isFollow = /\b(siga a empresa|seguir a empresa|follow .* to stay up to date|follow company)\b/i.test(normalizeText(label));
      if (isReviewScreen && !isFollow) continue;

      const errText = readFieldValidationError(cb, doc, win);
      if (errText) fieldErrors.push(`${label}: ${errText}`);

      const required = cb.required || cb.getAttribute('aria-required') === 'true' || /\*/.test(q.rawWithAsterisk);
      const fieldId = `f_${++seq}`;
      liveHandles.set(fieldId, { fieldId, type: 'checkbox', primaryEl: cb });

      fields.push({
        fieldId,
        questionKey: makeQuestionKey(label, 'checkbox'),
        label,
        type: 'checkbox',
        required,
        currentValue: cb.checked ? 'true' : '',
        checked: cb.checked,
        options: [],
        errorText: errText,
        isFollowCompany: isFollow,
      });
      continue;
    }

    // INPUT TEXTO / NÚMERO / COMBOBOX / TEXTAREA
    if (isReviewScreen) continue;
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const q = resolveQuestionTextForSingleControl(input, doc, win);
    if (!q.label) continue;

    const role = (input.getAttribute('role') ?? '').toLowerCase();
    const auto = (input.getAttribute('aria-autocomplete') ?? '').toLowerCase();
    const inputType = el.localName === 'textarea' ? 'textarea' : (input.getAttribute('type') ?? 'text').toLowerCase();

    let fieldType: FormFieldType = 'text';
    if (el.localName === 'textarea') fieldType = 'textarea';
    else if (role === 'combobox' || auto === 'list' || auto === 'both') fieldType = 'combobox';
    else if (inputType === 'number') fieldType = 'number';

    const errText = readFieldValidationError(input, doc, win);
    if (errText) fieldErrors.push(`${q.label}: ${errText}`);

    const required = input.required || input.getAttribute('aria-required') === 'true' || /\*/.test(q.rawWithAsterisk);
    const maxLenRaw = Number(input.getAttribute('maxlength') ?? '');
    const minRaw = Number(input.getAttribute('min') ?? '');
    const maxRaw = Number(input.getAttribute('max') ?? '');

    const fieldId = `f_${++seq}`;
    liveHandles.set(fieldId, { fieldId, type: fieldType, primaryEl: input });

    fields.push({
      fieldId,
      questionKey: makeQuestionKey(q.label, fieldType),
      label: q.label,
      type: fieldType,
      required,
      currentValue: input.value.trim(),
      options: [],
      placeholder: input.getAttribute('placeholder') ?? undefined,
      maxLength: Number.isFinite(maxLenRaw) && maxLenRaw > 0 ? maxLenRaw : undefined,
      min: input.hasAttribute('min') && Number.isFinite(minRaw) ? minRaw : undefined,
      max: input.hasAttribute('max') && Number.isFinite(maxRaw) ? maxRaw : undefined,
      errorText: errText,
    });
  }

  const pageErrors = readAllModalErrors(modal, win, fieldErrors);
  const signature = `${progressText}|${stepTitle}|${nav.kind}|${fields.map((f) => f.questionKey).join(',')}`;

  return {
    modalOpen: true,
    signature,
    stepTitle,
    progressText,
    buttonKind: nav.kind,
    buttonLabel: nav.label,
    hasResumeCards,
    resumeSelected,
    pageErrors,
    fields,
    ...(modalTitle ? { modalTitle } : {}),
    ...(nav.kind === 'none' ? { diag: describeModalForDiary(modal, win) } : {}),
  };
}

/**
 * O que o diálogo mostra quando nenhum botão de avanço foi reconhecido: o começo do texto e os rótulos dos botões.
 * Vai para o diário, para a causa aparecer em vez de só "botão não reconhecido".
 */
function describeModalForDiary(modal: Element, win: Window): string {
  const text = visibleTextOf(modal, win).slice(0, 140);
  const buttons = Array.from(modal.querySelectorAll('button, a[role="button"]'))
    .filter((b) => !isOwnUi(b) && isVisible(b, win))
    .map((b) => {
      const label = visibleTextOf(b, win) || (b.getAttribute('aria-label') ?? '');
      return `${collapseWhitespace(label).slice(0, 40)}${(b as HTMLButtonElement).disabled ? ' (desligado)' : ''}`;
    })
    .filter((label) => label !== '')
    .slice(0, 8);
  return `texto: "${text}" | botões: ${buttons.length > 0 ? buttons.join(' / ') : 'nenhum'}`;
}

/** A etapa já pode ser lida? O diálogo abre vazio e só depois (0,3 a 2 s) recebe os campos e o botão do rodapé. */
export function isStepReady(step: FormStepSnapshot): boolean {
  return step.modalOpen && step.buttonKind !== 'none';
}

/**
 * Lê a etapa esperando ela ficar pronta. No LinkedIn real o diálogo aparece primeiro sem nada dentro; ler nesse instante
 * dava "0 campos, nenhum botão" e a vaga era descartada. Espera até `timeoutMs` pelo botão do rodapé; se o diálogo
 * não existe, espera só `closedGraceMs` (ele pode estar acabando de abrir) antes de dizer que fechou.
 */
export async function readEasyApplyStepWhenReady(
  doc: Document,
  win: Window,
  timeoutMs = 8000,
  closedGraceMs = 1500,
): Promise<FormStepSnapshot> {
  const started = Date.now();
  for (;;) {
    resetDomScanCache();
    const step = readEasyApplyStep(doc, win);
    if (isStepReady(step)) return step;
    const waited = Date.now() - started;
    if (!step.modalOpen && waited >= closedGraceMs) return step;
    if (waited >= timeoutMs) return step;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
