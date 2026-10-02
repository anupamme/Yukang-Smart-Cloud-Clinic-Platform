#! /usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error(`无法识别参数: ${token}`);
        const key = token.slice(2);
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`参数 ${token} 缺少值`);
        result[key] = value;
        index += 1;
    }
    return result;
}

function required(args, key) {
    if (!args[key]) throw new Error(`缺少参数 --${key}`);
    return args[key];
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function versionParts(value) {
    const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) throw new Error(`版本号必须为 x.y.z: ${value || '(empty)'}`);
    return match[0];
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const installer = path.resolve(required(args, 'installer'));
    const version = versionParts(required(args, 'version'));
    const downloadUrl = required(args, 'download-url');
    const manifestUrl = required(args, 'manifest-url');
    const privateKeyPath = path.resolve(required(args, 'private-key'));
    const outputManifest = path.resolve(args['output-manifest'] || path.join(path.dirname(installer), 'update-manifest.json'));
    const outputConfig = args['output-config'] ? path.resolve(args['output-config']) : '';

    if (!/^https:\/\//i.test(downloadUrl)) throw new Error('下载地址必须使用 HTTPS');
    if (!/^https:\/\//i.test(manifestUrl)) throw new Error('更新清单地址必须使用 HTTPS');
    if (!fs.existsSync(installer)) throw new Error(`安装包不存在: ${installer}`);
    if (!fs.existsSync(privateKeyPath)) throw new Error(`Ed25519 私钥不存在: ${privateKeyPath}`);

    const release = {
        version,
        downloadUrl,
        sha256: sha256(installer),
        notes: String(args.notes || `愈康云诊所 v${version} 更新`),
    };
    const payload = [
        'yukang-update-v1',
        version,
        downloadUrl,
        release.sha256,
    ].join('\n');
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    release.signature = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');

    fs.mkdirSync(path.dirname(outputManifest), { recursive: true });
    fs.writeFileSync(outputManifest, `${JSON.stringify(release, null, 2)}\n`, 'utf8');

    if (outputConfig) {
        const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
        const config = {
            updater: {
                channelUrl: manifestUrl,
                publicKey: String(publicKey).trim(),
            },
        };
        fs.mkdirSync(path.dirname(outputConfig), { recursive: true });
        fs.writeFileSync(outputConfig, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    }

    console.log(JSON.stringify({
        installer,
        version,
        sha256: release.sha256,
        manifest: outputManifest,
        config: outputConfig || null,
    }, null, 2));
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}