#! /usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const desktopRoot = path.resolve(__dirname, '..');
const artifactRoot = path.resolve(process.env.YUKANG_SMOKE_APP_DIR || path.join(desktopRoot, 'artifacts', 'win-unpacked'));
const clinicDir = path.join(artifactRoot, 'resources', 'clinic_system');
const executable = path.join(artifactRoot, process.platform === 'win32' ? 'YuKangClinic.exe' : 'YuKangClinic');
const requestedPort = Number(process.env.YUKANG_SMOKE_PORT) || 32121;
const defaultDataDir = process.platform === 'win32'
    ? path.join('D:\\CodexCache', 'yukang-smoke-runtime')
    : path.join(desktopRoot, 'artifacts', 'yukang-smoke-runtime');
const dataDir = path.resolve(process.env.YUKANG_SMOKE_DATA_DIR || defaultDataDir);
const baseUrl = `http://127.0.0.1:${requestedPort}`;

if (!fs.existsSync(executable)) throw new Error(`未找到待测试桌面程序: ${executable}`);
if (!fs.existsSync(path.join(clinicDir, 'server.js'))) throw new Error(`未找到打包运行时: ${clinicDir}`);
fs.mkdirSync(dataDir, { recursive: true });

const child = spawn(executable, ['server.js'], {
    cwd: clinicDir,
    env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(requestedPort),
        DATA_DIR: dataDir,
        NO_OPEN_BROWSER: '1',
        NODE_PATH: path.join(clinicDir, 'vendor'),
        YUKONG_APP_DIR: clinicDir,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk.toString('utf8'); });
child.stderr.on('data', (chunk) => { logs += chunk.toString('utf8'); });

async function waitForServer() {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`服务提前退出 code=${child.exitCode}\n${logs}`);
        try {
            const response = await fetch(`${baseUrl}/api/server-info`, { signal: AbortSignal.timeout(1500) });
            if (response.ok) {
                const data = await response.json();
                if (data && data.success) return data;
            }
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`服务未在 60 秒内就绪\n${logs}`);
}

async function fetchCheck(name, url, expectedType) {
    const response = await fetch(url);
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`${name} 返回 HTTP ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '');
    if (expectedType && !contentType.includes(expectedType)) throw new Error(`${name} Content-Type 不正确: ${contentType}`);
    return { status: response.status, contentType, bytes: body.length, buffer: body };
}

async function main() {
    const serverInfo = await waitForServer();
    if (serverInfo.app !== 'yukang-clinic') throw new Error(`server-info.app 不正确: ${serverInfo.app}`);
    if (serverInfo.version !== require(path.join(desktopRoot, 'package.json')).version) {
        throw new Error(`server-info.version 不正确: ${serverInfo.version}`);
    }

    const login = await fetchCheck('login.html', `${baseUrl}/login.html`, 'text/html');
    const xlsx = await fetchCheck('xlsx', `${baseUrl}/vendor/xlsx.full.min.js`, 'javascript');
    const fontAwesome = await fetchCheck('fontawesome', `${baseUrl}/vendor/fontawesome/css/all.min.css`, 'text/css');
    const qr = await fetchCheck('qr-code', `${baseUrl}/api/qr-code?size=160&data=yukang-smoke`, 'image/png');
    const pngSignature = qr.buffer.subarray(0, 8).toString('hex');
    if (pngSignature !== '89504e470d0a1a0a') throw new Error(`二维码图片签名不正确: ${pngSignature}`);

    console.log(JSON.stringify({
        dataDir,
        serverInfo,
        checks: {
            login: { status: login.status, bytes: login.bytes },
            xlsx: { status: xlsx.status, bytes: xlsx.bytes },
            fontAwesome: { status: fontAwesome.status, bytes: fontAwesome.bytes },
            qrCode: { status: qr.status, bytes: qr.bytes, pngSignature },
        },
    }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}).finally(() => {
    if (child.exitCode === null) child.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 500);
});
