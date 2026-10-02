#! /usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const desktopRoot = path.resolve(__dirname, '..');
const runtimeRoot = path.resolve(process.env.YUKANG_RUNTIME_DIR || path.join(desktopRoot, 'runtime'));
const appRoot = path.join(runtimeRoot, 'clinic_system');
const allowLite = process.env.YUKANG_ALLOW_LITE_INDEX === '1';
const failures = [];
const checks = [];

function check(name, ok, detail = '') {
    checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function exists(relative) {
    return fs.existsSync(path.join(appRoot, relative));
}

function walk(dir, visitor) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        visitor(full, entry);
        if (entry.isDirectory()) walk(full, visitor);
    }
}

const requiredFiles = [
    'server.js',
    'index.html',
    'login.html',
    'v5-pages.js',
    'v5-pages.css',
    'package.json',
    'data/pharmacopoeia.json',
    'data/formulas.json',
    'data/interactions.json',
    'vendor/express/package.json',
    'vendor/cors/package.json',
    'vendor/qrcode/package.json',
    'vendor/xlsx/package.json',
    'vendor/@fortawesome/fontawesome-free/css/all.min.css',
    'vendor/xlsx/dist/xlsx.full.min.js',
];
for (const relative of requiredFiles) check(`必需文件 ${relative}`, exists(relative));

const sourcePackage = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
const knowledgePath = path.join(appRoot, 'data', 'knowledge_index.db');
if (allowLite && !fs.existsSync(knowledgePath)) {
    checks.push({ name: '知识库索引', ok: true, detail: 'lite 模式：未打包完整索引' });
} else {
    const size = fs.existsSync(knowledgePath) ? fs.statSync(knowledgePath).size : 0;
    check('完整知识库索引', size > 10 * 1024 * 1024, `${size} bytes`);
}
check('版本号一致', sourcePackage.version === desktopPackage.version, `${sourcePackage.version} / ${desktopPackage.version}`);

const htmlFiles = ['index.html', 'login.html', 'v5-pages.js'];
for (const relative of htmlFiles) {
    if (!exists(relative)) continue;
    const source = fs.readFileSync(path.join(appRoot, relative), 'utf8');
    for (const forbidden of ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'api.qrserver.com']) {
        check(`${relative} 不含外部 CDN ${forbidden}`, !source.includes(forbidden));
    }
}

const forbiddenPaths = [
    'clinic_database',
    'clinic_database/device-key.dpapi',
    'node_modules',
    'tests',
    'tools',
    'local_rag_worker',
    'docs',
];
for (const relative of forbiddenPaths) {
    check(`交付包不含 ${relative}`, !exists(relative));
}

let forbiddenFile = '';
walk(appRoot, (full, entry) => {
    if (!entry.isFile()) return;
    const base = path.basename(full);
    if (/\.(log|tmp|zip)$/i.test(base) || base.startsWith('_hybrid_input_') || base === 'pharmacopoeia_texts.jsonl') {
        forbiddenFile = path.relative(appRoot, full);
    }
});
check('交付包不含日志/临时/原始索引输入', !forbiddenFile, forbiddenFile);

const hashes = {};
for (const relative of ['data/knowledge_index.db', 'vendor/xlsx/dist/xlsx.full.min.js', 'vendor/@fortawesome/fontawesome-free/css/all.min.css']) {
    if (!exists(relative)) continue;
    hashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(path.join(appRoot, relative))).digest('hex');
}

const result = {
    runtimeRoot,
    appRoot,
    version: sourcePackage.version,
    lite: allowLite && !fs.existsSync(knowledgePath),
    checks,
    hashes,
    failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
