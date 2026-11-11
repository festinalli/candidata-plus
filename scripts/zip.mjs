// Empacota a extensão montada (dist/) num ZIP pronto para quem não programa: baixar, extrair e carregar no Chrome.
// Uso: npm run zip  ->  release/candidata-plus-v<versão>.zip
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'release');
const { version } = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const folderName = `candidata-plus-v${version}`;
const zipPath = path.join(OUT_DIR, `${folderName}.zip`);

// Copia sem os mapas de código (.map), que só servem para quem desenvolve.
const stage = path.join(OUT_DIR, folderName);
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(DIST, stage, { recursive: true, filter: (src) => !src.endsWith('.map') });

if (process.platform === 'win32') {
  // O tar do próprio Windows grava os caminhos com "/" (o Compress-Archive grava "\", e o ZIP quebra no Mac e no Linux).
  const tar = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', OUT_DIR, folderName], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', zipPath, folderName], { cwd: OUT_DIR, stdio: 'inherit' });
}
fs.rmSync(stage, { recursive: true, force: true });
console.log(`ZIP pronto: ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
