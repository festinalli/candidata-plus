/**
 * Tira dados de contato do texto antes de ele ir para a IA.
 *
 * As regras do plano grátis do Google AI Studio pedem para não enviar dado pessoal: o que chega pode ser lido por
 * revisores e usado para melhorar os produtos do Google. A IA não precisa de e-mail, telefone, links nem do nome para
 * responder "há quantos anos você usa Python?": esses campos do formulário são respondidos pela Ficha, no navegador.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LINK_RE = /\bhttps?:\/\/[^\s)>\]]+|\b(?:www\.)?(?:linkedin|github|gitlab|behance)\.com\/[^\s)>\]]+/gi;
// Telefone brasileiro ou com código de país: (11) 98888-7777, 11 988887777, +55 11 98888 7777...
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g;
// CPF e RG escritos com pontos.
const DOC_RE = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{1,2}\.\d{3}\.\d{3}-[\dXx]\b/g;

function escapeRegex(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** E-mail, links, telefone e documentos viram marcadores. Com `fullName`, o nome completo também. */
export function redactContact(text: string, fullName = ''): string {
  let out = text.replace(EMAIL_RE, '[e-mail]').replace(LINK_RE, '[link]').replace(DOC_RE, '[documento]').replace(PHONE_RE, '[telefone]');
  const name = fullName.trim().replace(/\s+/g, ' ');
  if (name.length >= 5 && name.includes(' ')) {
    const flexible = escapeRegex(name).replace(/ /g, '\\s+');
    out = out.replace(new RegExp(flexible, 'gi'), '[nome]');
  }
  return out;
}

/** O valor veio da IA como um dos marcadores acima (ou vazio)? Então não serve para a Ficha. */
export function isRedactedPlaceholder(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '' || /^\[(e-mail|link|telefone|documento|nome)\]$/i.test(value.trim());
}
