/** 生成设置弹窗的静态预览页（仅用于开发时目视检查）。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'dist', 'renderer');
let html = readFileSync(join(dir, 'index.html'), 'utf8');

html = html.replace(
  '<div id="settings-modal" class="modal hidden">',
  '<div id="settings-modal" class="modal">',
);
html = html.replace('<script src="./app.js"></script>', '');

// 预览页强制按桌面宽度渲染，便于在窄视口下目视检查
html = html.replace(
  '</head>',
  '<style>html,body{width:1280px!important;min-width:1280px}' +
    '.modal{width:1280px!important;left:0!important;right:auto!important}' +
    '.modal-body{width:720px!important}</style></head>',
);

writeFileSync(join(dir, 'preview-settings.html'), html, 'utf8');
console.log('已生成 dist/renderer/preview-settings.html');
