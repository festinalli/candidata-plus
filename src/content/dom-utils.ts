import { collapseWhitespace, normalizeText } from '../shared/normalize.ts';

export const OWN_UI_ATTR = 'data-cplus2-ui';
export type BrowserWin = Window & typeof globalThis;

// Cache leve por passagem de varredura para nunca travar a aba do LinkedIn com milhares de getComputedStyle repetidos!
let styleCache = new WeakMap<Element, CSSStyleDeclaration>();
let visCache = new WeakMap<Element, boolean>();

export function resetDomScanCache(): void {
  styleCache = new WeakMap<Element, CSSStyleDeclaration>();
  visCache = new WeakMap<Element, boolean>();
}

function cachedStyle(el: Element, win: Window): CSSStyleDeclaration | null {
  const hit = styleCache.get(el);
  if (hit) return hit;
  try {
    const computed = win.getComputedStyle(el);
    styleCache.set(el, computed);
    return computed;
  } catch {
    return null;
  }
}

export function isOwnUi(el: Element | null): boolean {
  return el !== null && el.closest(`[${OWN_UI_ATTR}]`) !== null;
}

/**
 * Busca elementos atravessando também Shadow DOM aberto (até 5 níveis).
 */
export function queryAllDeep(root: Document | Element | ShadowRoot, selector: string): Element[] {
  const out: Element[] = [];
  const walkScope = (scope: Document | Element | ShadowRoot, depth: number) => {
    if (depth > 5) return;
    for (const m of Array.from(scope.querySelectorAll(selector))) {
      out.push(m);
    }
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      if (el.shadowRoot) {
        walkScope(el.shadowRoot, depth + 1);
      }
    }
  };
  walkScope(root, 0);
  return out;
}

export function isSrOnly(el: Element, win: Window): boolean {
  const cls = (el.getAttribute('class') ?? '').toLowerCase();
  if (cls.includes('visually-hidden') || cls.includes('sr-only') || cls.includes('a11y-text')) {
    return true;
  }
  const style = cachedStyle(el, win);
  if (!style) return false;
  if (style.position !== 'absolute' && style.position !== 'fixed') return false;
  if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)' || style.clipPath === 'inset(100%)') {
    return true;
  }
  const w = Number.parseFloat(style.width);
  const h = Number.parseFloat(style.height);
  return style.overflow === 'hidden' && w <= 2 && h <= 2;
}

export function isVisible(el: Element, win: Window): boolean {
  if (!el.isConnected) return false;
  const cached = visCache.get(el);
  if (cached !== undefined) return cached;

  // Caminho ultrarrápido nativo em C++ do Chrome 120+ (evita caminhar ancestrais em JS!)
  const maybeCheckVis = (el as Element & { checkVisibility?: (opts?: Record<string, boolean>) => boolean }).checkVisibility;
  if (typeof maybeCheckVis === 'function') {
    let ok = maybeCheckVis.call(el, { checkVisibilityCSS: true });
    if (ok) {
      // Confere apenas aria-hidden ancestral
      if (el.closest('[aria-hidden="true"], [hidden]')) ok = false;
    }
    visCache.set(el, ok);
    return ok;
  }

  // Fallback para ambientes de teste simulados (jsdom)
  let ok = true;
  for (let cur: Element | null = el; cur !== null; cur = cur.parentElement) {
    if (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true') {
      ok = false;
      break;
    }
    if (cur.localName === 'dialog' && !cur.hasAttribute('open') && cur.getAttribute('aria-modal') !== 'true') {
      const st = cachedStyle(cur, win);
      if (!st || st.display === 'none') {
        ok = false;
        break;
      }
    }
    const style = cachedStyle(cur, win);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      ok = false;
      break;
    }
  }
  visCache.set(el, ok);
  return ok;
}

/**
 * Texto visível de um contêiner, ignorando cópias ocultas (aria-hidden / sr-only).
 */
export function visibleTextOf(root: Element, win: Window): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const txt = node.textContent ?? '';
      if (txt.trim() !== '') parts.push(txt);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (isOwnUi(el)) return;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return;
    if (isSrOnly(el, win)) return;
    const st = cachedStyle(el, win);
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return;
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  walk(root);
  return collapseWhitespace(parts.join(' '));
}

export function ownOptionBlockText(item: Element, groupItems: readonly Element[], win: Window): string {
  let block: Element = item;
  while (block.parentElement !== null) {
    const parent = block.parentElement;
    const containsOther = groupItems.some((other) => other !== item && parent.contains(other));
    if (containsOther) break;
    block = parent;
  }
  return visibleTextOf(block, win);
}

export function cssEscapeId(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id);
  }
  return id.replace(/(["\\#.:[\]()>+~*^$|=])/g, '\\$1');
}

export function setNativeControlValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  win: Window,
): void {
  const g = win as BrowserWin;
  el.focus();
  const proto =
    el.localName === 'textarea'
      ? g.HTMLTextAreaElement.prototype
      : el.localName === 'select'
        ? g.HTMLSelectElement.prototype
        : g.HTMLInputElement.prototype;

  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }

  el.dispatchEvent(new g.Event('input', { bubbles: true }));
  el.dispatchEvent(new g.Event('change', { bubbles: true }));
  el.blur();
}

export function clickElement(el: Element, win: Window): boolean {
  const g = win as BrowserWin;
  if (!el.isConnected || (el as HTMLButtonElement).disabled) return false;
  if (typeof (el as HTMLElement).click === 'function') {
    (el as HTMLElement).click();
    return true;
  }
  el.dispatchEvent(new g.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil<T>(fn: () => T | null | false, timeoutMs: number, intervalMs = 80): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    resetDomScanCache();
    const res = fn();
    if (res !== null && res !== false) return res;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * Extrai o ID numérico da vaga em QUALQUER formato de URL do LinkedIn:
 * - /jobs/view/4100300001/
 * - /jobs/view/analista-senior-remoto-at-empresa-4100300001/ (com slug!)
 * - /comm/jobs/view/...
 * - ?currentJobId=4100300001 ou ?jobId=4100300001
 */
export function extractJobIdFromUrl(href: string, ignoreQuery = false): string | null {
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    if (!ignoreQuery) {
      const cur = u.searchParams.get('currentJobId') ?? u.searchParams.get('jobId');
      if (cur && /^\d{6,20}$/.test(cur.trim())) return cur.trim();
    }
    const segments = u.pathname.split('/').filter(Boolean);
    const cleanSegs = segments[0]?.toLowerCase() === 'comm' ? segments.slice(1) : segments;
    if (cleanSegs[0]?.toLowerCase() === 'jobs' && cleanSegs[1]?.toLowerCase() === 'view' && cleanSegs[2]) {
      const seg = cleanSegs[2];
      if (/^\d{6,20}$/.test(seg)) return seg;
      const slugMatch = /-(\d{6,20})$/.exec(seg);
      if (slugMatch?.[1]) return slugMatch[1];
    }
  } catch {
    // fallback regex direto
  }
  const directMatch = /\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,20})(?:[/?#]|$)/i.exec(href);
  return directMatch?.[1] ?? null;
}

export function isEasyApplyLabel(raw: string): boolean {
  const norm = normalizeText(raw);
  return (
    norm.includes('candidatura simplificada') ||
    norm.includes('easy apply') ||
    norm.includes('solicitud sencilla')
  );
}

export function isExternalApplyLabel(raw: string): boolean {
  const norm = normalizeText(raw);
  if (isEasyApplyLabel(raw)) return false;
  return (
    norm === 'candidatar se' ||
    norm.startsWith('candidatar se ') ||
    norm === 'apply' ||
    norm.startsWith('apply on ') ||
    norm === 'solicitar'
  );
}
