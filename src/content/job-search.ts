import type { ListedJobCard, OpenJobSnapshot, WorkMode } from '../shared/types.ts';
import { collapseWhitespace, detectWorkModeFromText, normalizeText } from '../shared/normalize.ts';
import {
  clickElement,
  extractJobIdFromUrl,
  isEasyApplyLabel,
  isExternalApplyLabel,
  isOwnUi,
  isSrOnly,
  isVisible,
  pollUntil,
  queryAllDeep,
  resetDomScanCache,
  sleep,
  visibleTextOf,
} from './dom-utils.ts';

const CARD_MAX_CHARS = 1600;
const DETAIL_PANEL_SELECTOR =
  '.jobs-search__job-details, .scaffold-layout__detail, [data-sdui-screen*="JobDetails"], .jobs-details';

interface InternalCard {
  el: Element;
  card: ListedJobCard;
}

function ownDirectText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) out += node.textContent ?? '';
  }
  return collapseWhitespace(out);
}

function insideInnerButton(el: Element, cardRoot: Element): boolean {
  for (let cur: Element | null = el; cur !== null && cur !== cardRoot; cur = cur.parentElement) {
    if (cur.localName === 'button') return true;
  }
  return false;
}

function insideDetailPanel(el: Element): boolean {
  return el.closest(DETAIL_PANEL_SELECTOR) !== null;
}

function detectAlreadyAppliedText(raw: string): boolean {
  const norm = normalizeText(raw);
  return /\b(candidatura enviada|candidatou se|ja se candidatou|applied|solicitado)\b/.test(norm);
}

export { detectWorkModeFromText };

/**
 * Modalidade escrita no cartão da lista. Só vale a linha do local, que termina em "(Remoto)", "(Híbrido)" ou
 * "(Presencial)"; texto solto do cartão (um título com "remoto", um selo) não conta.
 */
function workModeOfCardLines(lines: readonly string[]): WorkMode | null {
  for (const line of lines.slice(1)) {
    const inParens = /\(([^()]{3,30})\)\s*$/.exec(line)?.[1];
    if (!inParens) continue;
    const mode = detectWorkModeFromText(inParens);
    if (mode) return mode;
  }
  return null;
}

function extractLinesFromCard(cardEl: Element, win: Window): string[] {
  const lines: string[] = [];
  for (const child of Array.from(cardEl.querySelectorAll('*'))) {
    const txt = ownDirectText(child);
    if (!txt || insideInnerButton(child, cardEl) || isOwnUi(child) || isSrOnly(child, win)) continue;
    if (lines[lines.length - 1] === txt) continue;
    lines.push(txt);
  }
  return lines;
}

function extractDigitsFromAttr(raw: string | null): string | null {
  if (!raw) return null;
  const m = /(\d{7,20})(?:\D|$)/.exec(raw);
  return m?.[1] ?? null;
}

function scanJobCards(doc: Document, win: Window): InternalCard[] {
  resetDomScanCache();
  const found: InternalCard[] = [];
  const seenJobIds = new Set<string>();

  // ESTRATÉGIA 1: Busca nova SDUI (/jobs/search-results/) — qualquer [componentkey] com "job-card" + ID numérico
  for (const rawEl of queryAllDeep(doc, '[componentkey*="job-card" i]')) {
    if (isOwnUi(rawEl) || insideDetailPanel(rawEl)) continue;
    const jobId = extractDigitsFromAttr(rawEl.getAttribute('componentkey'));
    if (!jobId || seenJobIds.has(jobId)) continue;

    const clickable = rawEl.closest('[role="button"]') ?? rawEl;
    if (!isVisible(clickable, win)) continue;

    const lines = extractLinesFromCard(clickable, win);
    const title = lines[0] ?? '';
    if (!title) continue;
    const company = lines[1] ?? '';
    const restText = lines.slice(2).join(' · ');

    seenJobIds.add(jobId);
    found.push({
      el: clickable,
      card: {
        jobId,
        title,
        company,
        locationText: restText,
        alreadyAppliedOnCard: detectAlreadyAppliedText(lines.join(' ')),
        workMode: workModeOfCardLines(lines),
      },
    });
  }

  if (found.length > 0) return found;

  // ESTRATÉGIA 2: Cartões por atributos de dados (data-occludable-job-id / data-job-id / data-entity-urn)
  for (const el of queryAllDeep(doc, '[data-occludable-job-id], [data-job-id], [data-entity-urn*="jobPosting"]')) {
    if (isOwnUi(el) || insideDetailPanel(el) || !isVisible(el, win)) continue;
    // Ignora elementos injetados por extensões concorrentes
    if (el.hasAttribute('data-outra-extensao') || el.closest('[data-outra-extensao]')) continue;

    const rawId =
      el.getAttribute('data-occludable-job-id') ??
      el.getAttribute('data-job-id') ??
      el.getAttribute('data-entity-urn');
    const jobId = extractDigitsFromAttr(rawId);
    if (!jobId || seenJobIds.has(jobId)) continue;

    const fullText = collapseWhitespace(el.textContent ?? '');
    if (fullText.length < 6 || fullText.length > CARD_MAX_CHARS) continue;

    const link = el.querySelector('a[href*="/jobs/view/"]');
    const lines = extractLinesFromCard(el, win);
    const title = (link ? visibleTextOf(link, win) : '') || lines[0] || '';
    if (!title) continue;
    const company = lines.find((l) => l !== title) ?? '';

    seenJobIds.add(jobId);
    found.push({
      el,
      card: {
        jobId,
        title,
        company,
        locationText: lines.slice(2).join(' · '),
        alreadyAppliedOnCard: detectAlreadyAppliedText(fullText),
        workMode: workModeOfCardLines(lines),
      },
    });
  }

  if (found.length > 0) return found;

  // ESTRATÉGIA 3: Links /jobs/view/<id ou slug-id>/ (busca clássica, coleções, recomendações, /jobs/)
  for (const link of queryAllDeep(doc, 'a[href*="/jobs/view/"]')) {
    if (isOwnUi(link) || insideDetailPanel(link) || !isVisible(link, win)) continue;
    const jobId = extractJobIdFromUrl(link.getAttribute('href') ?? '', true);
    if (!jobId || seenJobIds.has(jobId)) continue;

    const container =
      link.closest('[data-occludable-job-id], [data-job-id], li, [role="listitem"], [role="button"]') ??
      link.parentElement?.parentElement ??
      link.parentElement;
    if (!container || insideDetailPanel(container)) continue;

    const fullText = collapseWhitespace(container.textContent ?? '');
    if (fullText.length > CARD_MAX_CHARS) continue;

    const title = visibleTextOf(link, win) || collapseWhitespace(link.textContent ?? '');
    if (!title) continue;

    const lines = extractLinesFromCard(container, win);
    const company =
      lines.find((l) => normalizeText(l) !== normalizeText(title)) ?? '';

    seenJobIds.add(jobId);
    found.push({
      el: container,
      card: {
        jobId,
        title,
        company,
        locationText: fullText.slice(0, 200),
        alreadyAppliedOnCard: detectAlreadyAppliedText(fullText),
        workMode: workModeOfCardLines(lines),
      },
    });
  }

  return found;
}

export function listJobCards(doc: Document, win: Window): ListedJobCard[] {
  const cards = scanJobCards(doc, win).map((item) => item.card);
  if (cards.length > 0) return cards;

  // ESTRATÉGIA 4: Pessoa abriu uma vaga individual (/jobs/view/<id>/) sem coluna lateral -> permite candidatar nessa vaga!
  if (/\/jobs\/view\//i.test(win.location.pathname)) {
    const snap = readOpenJobSnapshot(doc, win);
    if (snap.jobId && snap.title) {
      return [
        {
          jobId: snap.jobId,
          title: snap.title,
          company: snap.company,
          locationText: snap.descriptionSnippet.slice(0, 100),
          alreadyAppliedOnCard: snap.alreadyApplied,
        },
      ];
    }
  }

  return [];
}

/**
 * Em que tipo de página a aba está. Fora da área de vagas (o feed, um perfil) NADA é vaga: um post do feed com link
 * para uma vaga era lido como cartão, e o clique nele levava a aba embora.
 */
export function jobsPageKind(doc: Document, win: Window): 'list' | 'job' | 'other' {
  const path = win.location.pathname;
  // Endereço de uma vaga só. (Com o formulário aberto sobre uma lista o endereço também fica assim; quem sabe se a
  // lista continua na tela é o envio, que compara os cartões com os que já percorreu.)
  if (/^\/(?:comm\/)?jobs\/view\//i.test(path)) return 'job';
  if (/^\/jobs(?:\/|$)/i.test(path)) return 'list';
  return 'other';
}

export function diagnosePageDom(doc: Document, win: Window): string {
  const sdui = queryAllDeep(doc, '[componentkey]').length;
  const sduiJob = queryAllDeep(doc, '[componentkey*="job" i]').length;
  const links = queryAllDeep(doc, 'a[href*="/jobs/view/"]').length;
  const dataIds = queryAllDeep(doc, '[data-job-id], [data-occludable-job-id]').length;
  return `url=${win.location.pathname}${win.location.search.slice(0, 60)} | componentkey=${sdui} (job=${sduiJob}) | linksView=${links} | dataJobId=${dataIds}`;
}

export function isNewSearchUrl(win: Window): boolean {
  return /^\/jobs\/search-results\/?/i.test(win.location.pathname);
}

/**
 * O número da vaga pelo endereço só vale na página de UMA vaga (/jobs/view/<id>/). Numa lista, o endereço troca para a
 * vaga clicada na hora, enquanto o painel ainda mostra a vaga anterior e depois fica vazio por uns 2 s: confiar no
 * endereço fazia a extensão dizer "vaga aberta, sem botão" (e pular como "site externo") ou usar o botão da vaga errada.
 */
function jobIdFromJobPageUrl(win: Window): string | null {
  return /^\/(?:comm\/)?jobs\/view\//i.test(win.location.pathname) ? extractJobIdFromUrl(win.location.href, true) : null;
}

/**
 * Acha o link/cabeçalho do título da vaga aberta no painel (fora de todos os cartões da lista).
 */
function findPanelTitleLink(doc: Document, win: Window, cardEls: readonly Element[]): { link: Element; jobId: string; title: string } | null {
  // Clássico / página individual: h1 no painel de detalhes
  const classicH1 = doc.querySelector(
    '.job-details-jobs-unified-top-card__job-title h1, .jobs-unified-top-card__job-title h1, .top-card-layout__title, main h1',
  );
  if (classicH1 && isVisible(classicH1, win) && !cardEls.some((c) => c.contains(classicH1))) {
    const innerLink = classicH1.querySelector('a[href*="/jobs/view/"]') ?? classicH1.closest('a[href*="/jobs/view/"]');
    const jobId = innerLink ? extractJobIdFromUrl(innerLink.getAttribute('href') ?? '', true) : jobIdFromJobPageUrl(win);
    const title = visibleTextOf(classicH1, win);
    if (jobId && title) return { link: innerLink ?? classicH1, jobId, title };
  }

  // Busca nova: primeiro link /jobs/view/<id ou slug-id>/ fora dos cartões
  for (const a of queryAllDeep(doc, 'a[href*="/jobs/view/"]')) {
    if (isOwnUi(a) || !isVisible(a, win)) continue;
    if (cardEls.some((c) => c.contains(a))) continue;
    const jobId = extractJobIdFromUrl(a.getAttribute('href') ?? '', true);
    if (!jobId) continue;
    const title = visibleTextOf(a, win);
    if (title) return { link: a, jobId, title };
  }

  return null;
}

function findTopCardContainer(titleLink: Element, cardEls: readonly Element[]): Element {
  let best: Element = titleLink.parentElement ?? titleLink;
  for (let cur: Element | null = titleLink.parentElement; cur !== null; cur = cur.parentElement) {
    if (cardEls.some((c) => cur.contains(c))) break;
    const len = collapseWhitespace(cur.textContent ?? '').length;
    if (len > CARD_MAX_CHARS) break;
    best = cur;
  }
  return best;
}

export function findEasyApplyButton(doc: Document, win: Window, expectedJobId: string | null): HTMLButtonElement | HTMLElement | null {
  const cardEls = scanJobCards(doc, win).map((c) => c.el);
  const panelTitle = findPanelTitleLink(doc, win, cardEls);

  if (expectedJobId && panelTitle && panelTitle.jobId !== expectedJobId) {
    return null;
  }
  // Sem título no painel não dá para saber de que vaga é o botão: não devolve botão nenhum.
  if (expectedJobId && !panelTitle) {
    return null;
  }

  const candidates = queryAllDeep(doc, 'button, a[role="button"]').filter((el) => {
    if (isOwnUi(el) || !isVisible(el, win)) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    if (cardEls.some((c) => c.contains(el))) return false;
    if (el.localName !== 'button' && !el.classList.contains('jobs-apply-button')) return false;

    const aria = el.getAttribute('aria-label') ?? '';
    const txt = visibleTextOf(el, win);
    return isEasyApplyLabel(aria) || isEasyApplyLabel(txt);
  });

  if (candidates.length === 0) return null;

  if (panelTitle) {
    const topCard = findTopCardContainer(panelTitle.link, cardEls);
    const inTopCard = candidates.find((btn) => topCard.contains(btn));
    if (inTopCard) return inTopCard as HTMLElement;
  }

  if (expectedJobId) {
    const matchingData = candidates.find((btn) => {
      const holder = btn.closest('[data-job-id]');
      const raw = holder?.getAttribute('data-job-id') ?? '';
      const idMatch = /(\d{6,20})\s*$/.exec(raw)?.[1];
      return !idMatch || idMatch === expectedJobId;
    });
    if (matchingData) return matchingData as HTMLElement;
  }

  return (candidates[0] as HTMLElement) ?? null;
}

function hasExternalApplyInTopCard(topCard: Element, win: Window): boolean {
  for (const btn of Array.from(topCard.querySelectorAll('button, a'))) {
    if (isOwnUi(btn) || !isVisible(btn, win)) continue;
    const txt = visibleTextOf(btn, win);
    const aria = btn.getAttribute('aria-label') ?? '';
    if (isExternalApplyLabel(txt) || isExternalApplyLabel(aria)) return true;
  }
  const norm = normalizeText(visibleTextOf(topCard, win).slice(0, 600));
  return /\b(fora do linkedin|off linkedin|no site da empresa|on company website)\b/.test(norm);
}

/** Etiquetas do topo da vaga ("Remoto", "Tempo integral") que são links para a própria vaga, mas não são o título. */
function isPillText(raw: string): boolean {
  const norm = normalizeText(raw);
  return (
    norm.length <= 20 &&
    /^(remoto|hibrido|presencial|remote|hybrid|on site|onsite|tempo integral|meio periodo|contrato|temporario|estagio|voluntario|full time|part time|contract|temporary|internship|volunteer)$/.test(
      norm,
    )
  );
}

export function readOpenJobSnapshot(doc: Document, win: Window): OpenJobSnapshot & { hasExternalApply?: boolean } {
  resetDomScanCache();
  const cardEls = scanJobCards(doc, win).map((c) => c.el);
  const panelTitle = findPanelTitleLink(doc, win, cardEls);

  if (!panelTitle) {
    // Painel sem título: numa lista, a vaga ainda não carregou (jobId null). Só a página de uma vaga só usa o endereço.
    const fallbackJobId = cardEls.length === 0 ? jobIdFromJobPageUrl(win) : null;
    return {
      jobId: fallbackJobId,
      title: '',
      company: '',
      workMode: null,
      alreadyApplied: false,
      hasEasyApply: false,
      descriptionSnippet: '',
    };
  }

  const topCard = findTopCardContainer(panelTitle.link, cardEls);
  const topCardText = visibleTextOf(topCard, win);

  let company = '';
  const compLink = Array.from(topCard.querySelectorAll('a[href]')).find(
    (a) => /\/company\/[^/?#]+/i.test(a.getAttribute('href') ?? '') && visibleTextOf(a, win) !== '',
  );
  if (compLink) {
    company = visibleTextOf(compLink, win);
  } else {
    const classicComp = doc.querySelector('.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name');
    if (classicComp) company = visibleTextOf(classicComp, win);
  }

  const easyBtn = findEasyApplyButton(doc, win, panelTitle.jobId);
  const alreadyApplied = !easyBtn && detectAlreadyAppliedText(topCardText);
  const hasExternalApply = !easyBtn && hasExternalApplyInTopCard(topCard, win);
  const workMode = detectWorkModeFromText(topCardText);

  return {
    jobId: panelTitle.jobId,
    // Em algumas vagas o único link para a vaga no topo é a etiqueta "Remoto": ela dá o número da vaga, não o título.
    title: isPillText(panelTitle.title) ? '' : panelTitle.title,
    company,
    workMode,
    alreadyApplied,
    hasEasyApply: easyBtn !== null,
    hasExternalApply,
    descriptionSnippet: topCardText.slice(0, 400),
  };
}

/**
 * Clica no cartão da vaga e aguarda a transição real do painel sem desperdiçar tempo!
 */
export async function openJobCardAndWait(doc: Document, win: Window, jobId: string): Promise<{ clicked: boolean; openJob: OpenJobSnapshot }> {
  const current = readOpenJobSnapshot(doc, win);
  if (current.jobId === jobId && (current.hasEasyApply || current.alreadyApplied || current.hasExternalApply)) {
    return { clicked: true, openJob: current };
  }

  const target = scanJobCards(doc, win).find((c) => c.card.jobId === jobId);
  if (!target) {
    return { clicked: /\/jobs\/view\//i.test(win.location.pathname), openJob: current };
  }

  try {
    target.el.scrollIntoView({ block: 'nearest' });
  } catch {
    // ignore
  }

  const clickTarget = target.el.matches('[role="button"]')
    ? target.el
    : (target.el.querySelector('a[href*="/jobs/view/"]') ?? target.el);

  clickElement(clickTarget, win);

  // 1º: espera o título do painel mudar para a vaga pedida (consulta a cada 80ms; termina no instante em que aparece!)
  const panelMatched = await pollUntil(() => {
    const snap = readOpenJobSnapshot(doc, win);
    return snap.jobId === jobId ? snap : null;
  }, 5500, 80);

  if (!panelMatched) {
    return { clicked: true, openJob: readOpenJobSnapshot(doc, win) };
  }

  // Se o botão (simplificada, externa ou já candidatado) já apareceu junto com o título, sai na hora em 0ms!
  if (panelMatched.hasEasyApply || panelMatched.alreadyApplied || panelMatched.hasExternalApply) {
    return { clicked: true, openJob: panelMatched };
  }

  // 2º: espera curta (1.2s) caso o botão de Candidatura simplificada chegue um instante depois do título
  const withButton = await pollUntil(() => {
    const snap = readOpenJobSnapshot(doc, win);
    if (snap.jobId !== jobId) return null;
    if (snap.hasEasyApply || snap.alreadyApplied || snap.hasExternalApply) return snap;
    return null;
  }, 1200, 80);

  return {
    clicked: true,
    openJob: withButton ?? readOpenJobSnapshot(doc, win),
  };
}

export async function scrollJobListForMore(doc: Document, win: Window): Promise<number> {
  const cards = scanJobCards(doc, win);
  const last = cards[cards.length - 1];
  if (last) {
    try {
      last.el.scrollIntoView({ block: 'end', behavior: 'instant' as ScrollBehavior });
    } catch {
      // ignore
    }
    for (let cur: Element | null = last.el.parentElement; cur !== null; cur = cur.parentElement) {
      if (cur.scrollHeight > cur.clientHeight + 40) {
        cur.scrollTop = cur.scrollHeight;
        break;
      }
    }
    await sleep(900);
  }
  return scanJobCards(doc, win).length;
}

export async function goToNextSearchPage(doc: Document, win: Window): Promise<boolean> {
  const allButtons = queryAllDeep(doc, 'button').filter(
    (btn) => !btn.closest('dialog, [role="dialog"]') && !isOwnUi(btn) && isVisible(btn, win) && !(btn as HTMLButtonElement).disabled,
  );

  const nextBtn = allButtons.find((btn) => {
    const testId = (btn.getAttribute('data-testid') ?? '').toLowerCase();
    if (testId.includes('pagination-controls-next')) return true;
    if (btn.classList.contains('jobs-search-pagination__button--next') || btn.classList.contains('artdeco-pagination__button--next')) {
      return true;
    }
    const aria = normalizeText(btn.getAttribute('aria-label') ?? '');
    const txt = normalizeText(visibleTextOf(btn, win));
    return (
      aria === 'proxima' ||
      aria === 'avancar' ||
      aria === 'next' ||
      aria.startsWith('proxima ') ||
      aria.startsWith('ir para a proxima') ||
      txt === 'proxima' ||
      txt === 'seguinte' ||
      txt === 'next'
    );
  });

  if (nextBtn) {
    clickElement(nextBtn, win);
    await sleep(1800);
    return true;
  }
  return false;
}
