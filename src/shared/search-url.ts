import type { WorkMode } from './types.ts';

/**
 * Endereço da busca de vagas do LinkedIn já com o filtro "Candidatura simplificada" e o cargo da Ficha.
 * A busca nova do LinkedIn descarta o filtro de modalidade do endereço; por isso a modalidade também é
 * conferida vaga a vaga durante o envio.
 */
export function buildLinkedInSearchUrl(keywords: string, modes: readonly WorkMode[]): string {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  url.searchParams.set('f_AL', 'true');
  if (keywords.trim()) {
    url.searchParams.set('keywords', keywords.trim());
  }
  const wtCodes: string[] = [];
  if (modes.includes('onsite')) wtCodes.push('1');
  if (modes.includes('remote')) wtCodes.push('2');
  if (modes.includes('hybrid')) wtCodes.push('3');
  if (wtCodes.length > 0 && wtCodes.length < 3) {
    url.searchParams.set('f_WT', wtCodes.join(','));
  }
  return url.href;
}
