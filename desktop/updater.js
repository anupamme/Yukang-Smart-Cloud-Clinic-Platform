#! /usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UPDATE_PROTOCOL = 'yukang-update-v1';

function versionParts(value) {
    const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return null;
    return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    if (!a || !b) return 0;
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
}

function canonicalPayload(release) {
    return Buffer.from([
        UPDATE_PROTOCOL,
        String(release.version || ''),
        String(release.downloadUrl || ''),
        String(release.sha256 || '').toLowerCase(),
    ].join('\n'), 'utf8');
}

function verifyRelease(release, publicKey) {
    if (!release || typeof release !== 'object') throw new Error('更新清单不是合法对象');
    if (!versionParts(release.version)) throw new Error(`更新版本号无效: ${release.version || '(empty)'}`);
    if (!/^https:\/\//i.test(String(release.downloadUrl || ''))) throw new Error('更新下载地址必须使用 HTTPS');
    if (!/^[a-f0-9]{64}$/i.test(String(release.sha256 || ''))) throw new Error('更新包 SHA-256 无效');
    if (!release.signature) throw new Error('更新清单缺少 Ed25519 签名');
    if (!publicKey) throw new Error('更新通道缺少签名公钥');
    const valid = crypto.verify(
        null,
        canonicalPayload(release),
        publicKey,
        Buffer.from(String(release.signature), 'base64')
    );
    if (!valid) throw new Error('更新清单签名验证失败');
    return true;
}

function withTimeout(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15000));
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function fetchRelease(config, options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;
    if (!config || !config.channelUrl) throw new Error('未配置更新通道地址');
    if (!config.publicKey) throw new Error('未配置更新签名公钥');
    if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 HTTPS 更新检查');
    const timeout = withTimeout(options.timeoutMs || config.timeoutMs);
    try {
        const response = await fetchImpl(config.channelUrl, {
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
            signal: timeout.signal,
        });
        if (!response.ok) throw new Error(`更新通道返回 HTTP ${response.status}`);
        const release = await response.json();
        verifyRelease(release, config.publicKey);
        return release;
    } finally {
        timeout.clear();
    }
}

async function checkForUpdates(config, currentVersion, options = {}) {
    if (!config || !config.channelUrl) return { status: 'not-configured' };
    const release = await fetchRelease(config, options);
    const comparison = compareVersions(release.version, currentVersion);
    if (comparison <= 0) return { status: 'up-to-date', release, currentVersion };
    return { status: 'available', release, currentVersion };
}

async function downloadRelease(release, targetDir, options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 HTTPS 更新下载');
    fs.mkdirSync(targetDir, { recursive: true });
    const timeout = withTimeout(options.timeoutMs || 120000);
    try {
        const response = await fetchImpl(release.downloadUrl, { signal: timeout.signal });
        if (!response.ok) throw new Error(`更新包下载失败: HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        const actual = crypto.createHash('sha256').update(body).digest('hex');
        if (actual.toLowerCase() !== String(release.sha256).toLowerCase()) {
            throw new Error('更新包 SHA-256 校验失败');
        }
        const safeName = `YuKangClinic-${String(release.version).replace(/[^0-9A-Za-z._-]/g, '_')}-win-x64.exe`;
        const destination = path.join(targetDir, safeName);
        fs.writeFileSync(destination, body, { mode: 0o600 });
        return { path: destination, size: body.length, sha256: actual };
    } finally {
        timeout.clear();
    }
}

function verifyAuthenticode(installerPath) {
    if (process.platform !== 'win32') return { status: 'NotApplicable' };
    const { spawnSync } = require('child_process');
    const command = "$s=Get-AuthenticodeSignature -LiteralPath $env:YUKANG_VERIFY_PATH; [ordered]@{ status=[string]$s.Status; message=[string]$s.StatusMessage; subject=if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' } } | ConvertTo-Json -Compress";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, YUKANG_VERIFY_PATH: installerPath },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('无法验证安装包 Authenticode 签名: ' + String(result.stderr || '').trim());
    const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
    try {
        return JSON.parse(line);
    } catch (_) {
        throw new Error('Authenticode 校验输出无效: ' + (line || '(empty)'));
    }
}

function launchInstaller(installerPath, options = {}) {
    if (process.platform === 'win32') {
        const signature = verifyAuthenticode(installerPath);
        if (signature.status !== 'Valid') {
            throw new Error('拒绝启动未通过 Authenticode 校验的更新包: ' + (signature.status || 'Unknown'));
        }
    }
    const { spawn } = require('child_process');
    const child = spawn(installerPath, ['--updated'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: path.dirname(installerPath),
        ...options,
    });
    child.unref();
    return child;
}

module.exports = {
    UPDATE_PROTOCOL,
    compareVersions,
    canonicalPayload,
    verifyRelease,
    fetchRelease,
    checkForUpdates,
    downloadRelease,
    verifyAuthenticode,
    launchInstaller,
};
