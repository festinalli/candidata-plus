/**
 * Extração local de texto do PDF no navegador usando pdf.js empacotado em /vendor/,
 * além de conversão para base64 caso o PDF seja escaneado (imagem) e precise ser lido direto pela IA.
 */

interface PdfJsLike {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(params: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean; transform?: number[] }> }>;
      }>;
    }>;
    destroy(): Promise<void>;
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function readResumeFile(file: File): Promise<{ text: string; pdfBase64?: string }> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.txt') || name.endsWith('.md')) {
    const text = await file.text();
    return { text: text.trim() };
  }

  const buffer = await file.arrayBuffer();
  const pdfBase64 = buffer.byteLength <= 2_500_000 ? arrayBufferToBase64(buffer) : undefined;

  try {
    const vendorPath = '../vendor/pdf.min.mjs';
    const pdfjs = (await import(/* @vite-ignore */ vendorPath)) as unknown as PdfJsLike;
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');

    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useWasm: false,
      useSystemFonts: false,
      disableFontFace: true,
      cMapUrl: chrome.runtime.getURL('vendor/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('vendor/standard_fonts/'),
      verbosity: 0,
    });

    const doc = await task.promise;
    const pages: string[] = [];
    const maxPages = Math.min(doc.numPages, 25);

    for (let p = 1; p <= maxPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let pageText = '';
      let lastY: number | null = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = Array.isArray(item.transform) && typeof item.transform[5] === 'number' ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 1.5 && pageText !== '' && !pageText.endsWith('\n')) {
          pageText += '\n';
        }
        pageText += item.str;
        if (item.hasEOL && !pageText.endsWith('\n')) pageText += '\n';
        if (y !== null) lastY = y;
      }
      pages.push(pageText);
    }

    await task.destroy().catch(() => undefined);
    const fullText = pages
      .join('\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .trim();

    return { text: fullText, pdfBase64 };
  } catch {
    return { text: '', pdfBase64 };
  }
}
