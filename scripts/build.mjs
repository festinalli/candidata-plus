import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
// `npm run deliver` copia a extensão montada para esta pasta (a que se carrega em chrome://extensions).
// Troque com a variável CANDIDATA_DELIVER_DIR.
const DELIVER_DIR = process.env.CANDIDATA_DELIVER_DIR || path.join(os.homedir(), 'Downloads', 'candidata-plus-v2');
const shouldDeliver = process.argv.includes('--deliver');

function cleanAndEnsure(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

async function main() {
  cleanAndEnsure(DIST);

  // 1. Copy static files
  fs.copyFileSync(path.join(SRC, 'manifest.json'), path.join(DIST, 'manifest.json'));
  copyDir(path.join(SRC, 'assets'), path.join(DIST, 'assets'));

  fs.mkdirSync(path.join(DIST, 'panel'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'panel', 'panel.html'), path.join(DIST, 'panel', 'panel.html'));
  fs.copyFileSync(path.join(SRC, 'panel', 'panel.css'), path.join(DIST, 'panel', 'panel.css'));

  fs.mkdirSync(path.join(DIST, 'content'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'content', 'linkedin.css'), path.join(DIST, 'content', 'linkedin.css'));

  // 2. Copy pdf.js vendor files for local offline PDF extraction
  const pdfBase = path.join(ROOT, 'node_modules', 'pdfjs-dist');
  const vendorDir = path.join(DIST, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  const pdfBuildDir = fs.existsSync(path.join(pdfBase, 'legacy', 'build', 'pdf.min.mjs'))
    ? path.join(pdfBase, 'legacy', 'build')
    : path.join(pdfBase, 'build');
  const pdfMain = fs.existsSync(path.join(pdfBuildDir, 'pdf.min.mjs')) ? 'pdf.min.mjs' : 'pdf.mjs';
  const pdfWorker = fs.existsSync(path.join(pdfBuildDir, 'pdf.worker.min.mjs')) ? 'pdf.worker.min.mjs' : 'pdf.worker.mjs';
  fs.copyFileSync(path.join(pdfBuildDir, pdfMain), path.join(vendorDir, 'pdf.min.mjs'));
  fs.copyFileSync(path.join(pdfBuildDir, pdfWorker), path.join(vendorDir, 'pdf.worker.min.mjs'));
  if (fs.existsSync(path.join(pdfBase, 'cmaps'))) {
    copyDir(path.join(pdfBase, 'cmaps'), path.join(vendorDir, 'cmaps'));
  }
  if (fs.existsSync(path.join(pdfBase, 'standard_fonts'))) {
    copyDir(path.join(pdfBase, 'standard_fonts'), path.join(vendorDir, 'standard_fonts'));
  }

  // 3. Bundle Service Worker & Panel (ESM)
  await build({
    entryPoints: {
      'background/service-worker': path.join(SRC, 'background', 'service-worker.ts'),
      'panel/panel': path.join(SRC, 'panel', 'panel.page.ts'),
    },
    outdir: DIST,
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    sourcemap: true,
    external: ['../vendor/pdf.min.mjs', './vendor/pdf.min.mjs'],
    logLevel: 'info',
  });

  // 4. Bundle Content Script (IIFE for classic MV3 content_scripts)
  await build({
    entryPoints: {
      'content/linkedin': path.join(SRC, 'content', 'linkedin.content.ts'),
    },
    outdir: DIST,
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    sourcemap: true,
    logLevel: 'info',
  });

  if (shouldDeliver) {
    cleanAndEnsure(DELIVER_DIR);
    copyDir(DIST, DELIVER_DIR);
    console.log(`Entregue com sucesso em: ${DELIVER_DIR}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
