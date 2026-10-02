#! /usr/bin/env node
'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const packageJson = require('./package.json');
const updater = require('./updater');

const DEFAULT_PORT = 3002;
const PORT_SCAN_LIMIT = 20;
const RESOURCE_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'runtime');
const CLINIC_DIR = process.env.YUKANG_DESKTOP_CLINIC_DIR || path.join(RESOURCE_ROOT, 'clinic_system');
const DATA_DIR = process.env.YUKANG_DESKTOP_DATA_DIR || path.join(app.getPath('userData'), 'clinic_database');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const SERVER_LOG = path.join(LOG_DIR, 'clinic-server.log');
const DESKTOP_LOG = path.join(LOG_DIR, 'desktop.log');

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverRestartTimer = null;
let serverRestartAttempts = 0;
let updateTimer = null;
let updateCheckRunning = false;
let fatalDialogShown = false;
let isQuitting = false;
let selectedPort = DEFAULT_PORT;
let localUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
let loginUrl = `${localUrl}/login.html`;
let desktopConfig = {};
let updateConfig = {};

function configPath() {
    return path.join(app.getPath('userData'), 'desktop-config.json');
}

function updateConfigPath() {
    return path.join(app.getPath('userData'), 'update-config.json');
}

function readJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        appendLog(`读取配置失败 ${filePath}: ${error.message}`);
        return null;
    }
}

function writeJsonFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function appendLog(message) {
    const line = `[${new Date().toISOString()}] ${String(message)}\n`;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(DESKTOP_LOG, line, 'utf8');
    } catch (_) {}
    try { console.log(line.trim()); } catch (_) {}
}

function showFatal(error) {
    if (fatalDialogShown) return;
    fatalDialogShown = true;
    isQuitting = true;
    const message = error && error.stack ? error.stack : String(error || '未知错误');
    appendLog(`启动失败: ${message}`);
    try {
        if (app.isReady()) dialog.showErrorBox('愈康云诊所启动失败', `本地服务无法启动。\n\n${message}`);
    } catch (_) {}
    app.exit(1);
}

process.on('uncaughtException', showFatal);
process.on('unhandledRejection', showFatal);

function requestServerInfo(port, timeoutMs = 900) {
    return new Promise((resolve) => {
        const request = http.get(`http://127.0.0.1:${port}/api/server-info`, { timeout: timeoutMs }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const isYukang = data && data.success === true && (!data.app || data.app === 'yukang-clinic');
                    resolve(isYukang ? data : null);
                } catch (_) {
                    resolve(null);
                }
            });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(null));
    });
}

function canBindPort(port) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.unref();
        probe.once('error', () => resolve(false));
        probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
    });
}

async function choosePort() {
    const preferred = Math.max(1, Number(process.env.YUKANG_DESKTOP_PORT) || Number(desktopConfig.port) || DEFAULT_PORT);
    const candidates = [];
    if (Number.isFinite(preferred)) candidates.push(preferred);
    for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) candidates.push(DEFAULT_PORT + offset);
    const unique = [...new Set(candidates)].filter(port => port > 0 && port <= 65535);
    for (const port of unique) {
        const existing = await requestServerInfo(port);
        if (existing) return { port, reused: true, info: existing };
        if (await canBindPort(port)) return { port, reused: false, info: null };
    }
    throw new Error(`没有找到可用本地端口，已检查 ${unique.join(', ')}`);
}

function edgeEnvironment(config) {
    const result = {};
    if (!config) return result;
    const mapping = {
        controlUrl: 'YUKONG_CONTROL_URL',
        edgeId: 'YUKONG_EDGE_ID',
        edgeToken: 'YUKONG_EDGE_TOKEN',
        clinicId: 'YUKONG_CLINIC_ID',
        certPath: 'YUKONG_EDGE_CERT_PATH',
        keyPath: 'YUKONG_EDGE_KEY_PATH',
        caPath: 'YUKONG_EDGE_CA_PATH',
    };
    for (const [source, target] of Object.entries(mapping)) {
        if (config[source]) result[target] = String(config[source]);
    }
    return result;
}

function serverEnvironment() {
    const vendorDir = path.join(CLINIC_DIR, 'vendor');
    const nodePath = [vendorDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    return {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(selectedPort),
        DATA_DIR,
        NO_OPEN_BROWSER: '1',
        YUKONG_APP_DIR: CLINIC_DIR,
        YUKONG_APP_VERSION: packageJson.version,
        NODE_PATH: nodePath,
        ...edgeEnvironment(updateConfig),
    };
}

function spawnServer() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFd = fs.openSync(SERVER_LOG, 'a');
    const child = spawn(process.execPath, [path.join(CLINIC_DIR, 'server.js')], {
        cwd: CLINIC_DIR,
        env: serverEnvironment(),
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd);
    child.on('error', (error) => appendLog(`服务进程启动错误: ${error.stack || error.message}`));
    child.on('exit', (code, signal) => {
        if (serverProcess === child) serverProcess = null;
        appendLog(`本地服务退出: code=${code} signal=${signal || ''}`);
        if (!isQuitting && app.isReady()) scheduleServerRestart();
    });
    appendLog(`本地服务已启动: pid=${child.pid} port=${selectedPort}`);
    return child;
}

async function waitForServer(port, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await requestServerInfo(port, 700)) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
}

async function ensureServer() {
    const existing = await requestServerInfo(selectedPort);
    if (existing) {
        appendLog(`检测到已有愈康服务，复用 ${localUrl}`);
        return existing;
    }
    if (!(await canBindPort(selectedPort))) {
        throw new Error(`端口 ${selectedPort} 已被其他程序占用`);
    }
    serverProcess = spawnServer();
    if (!(await waitForServer(selectedPort))) {
        throw new Error(`本地服务在 60 秒内未就绪。数据目录: ${DATA_DIR}`);
    }
    serverRestartAttempts = 0;
    return null;
}

function scheduleServerRestart() {
    if (isQuitting || serverRestartTimer) return;
    serverRestartAttempts += 1;
    const delayMs = Math.min(30000, 1000 * Math.pow(2, Math.min(serverRestartAttempts - 1, 5)));
    appendLog(`准备自动重启本地服务，第 ${serverRestartAttempts} 次，等待 ${delayMs}ms`);
    serverRestartTimer = setTimeout(async () => {
        serverRestartTimer = null;
        if (isQuitting) return;
        try {
            await ensureServer();
            serverRestartAttempts = 0;
            appendLog('本地服务自动重启成功');
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(loginUrl).catch(() => {});
        } catch (error) {
            appendLog(`本地服务自动重启失败: ${error.message}`);
            if (serverRestartAttempts >= 6) {
                if (Notification.isSupported()) new Notification({ title: '愈康云诊所服务异常', body: '自动重启多次失败，请查看日志或重启应用。' }).show();
            }
            scheduleServerRestart();
        }
    }, delayMs);
}

async function restartServer() {
    if (serverRestartTimer) {
        clearTimeout(serverRestartTimer);
        serverRestartTimer = null;
    }
    serverRestartAttempts = 0;
    if (serverProcess && !serverProcess.killed) {
        serverProcess.removeAllListeners('exit');
        serverProcess.kill();
        serverProcess = null;
    }
    await ensureServer();
}

function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        return;
    }
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#f3f7f6',
        title: `愈康云诊所 v${packageJson.version}`,
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', (event) => {
        if (!isQuitting && tray) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith(localUrl)) return { action: 'allow' };
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(localUrl)) {
            event.preventDefault();
            if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        }
    });
    mainWindow.loadURL(loginUrl).catch(showFatal);
}

function openFolder(folderPath) {
    fs.mkdirSync(folderPath, { recursive: true });
    shell.openPath(folderPath).catch((error) => appendLog(`打开目录失败: ${error.message}`));
}

function setAutoStart(enabled) {
    desktopConfig.autoStart = Boolean(enabled);
    writeJsonFile(configPath(), desktopConfig);
    if (process.platform === 'win32' || process.platform === 'darwin') {
        const settings = { openAtLogin: Boolean(enabled) };
        if (process.platform === 'win32') {
            settings.path = process.execPath;
            settings.args = app.isPackaged ? [] : [__dirname];
        }
        app.setLoginItemSettings(settings);
    }
    refreshTrayMenu();
}

function setPreferredPort(port) {
    desktopConfig.port = port ? Number(port) : null;
    writeJsonFile(configPath(), desktopConfig);
    appendLog(`端口配置已保存: ${port || '自动选择'}`);
    app.relaunch();
    app.exit(0);
}

function normalizeUpdateConfig(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const edge = source.edge || source.controlPlane || {};
    const updaterConfig = source.updater || {};
    return {
        controlUrl: String(edge.controlUrl || edge.url || source.controlUrl || '').replace(/\/+$/, ''),
        edgeId: String(edge.edgeId || source.edgeId || ''),
        edgeToken: String(edge.edgeToken || source.edgeToken || ''),
        clinicId: String(edge.clinicId || source.clinicId || ''),
        certPath: String(edge.certPath || source.certPath || ''),
        keyPath: String(edge.keyPath || source.keyPath || ''),
        caPath: String(edge.caPath || source.caPath || ''),
        channelUrl: String(updaterConfig.channelUrl || source.channelUrl || '').trim(),
        publicKey: String(updaterConfig.publicKey || source.publicKey || '').trim(),
    };
}

function loadUpdateConfig() {
    const fromFile = readJsonFile(updateConfigPath());
    const fallback = {
        channelUrl: process.env.YUKANG_UPDATE_CHANNEL_URL || '',
        publicKey: process.env.YUKANG_UPDATE_PUBLIC_KEY || '',
    };
    return normalizeUpdateConfig(fromFile || fallback);
}

async function importUpdateConfig() {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
        title: '导入更新通道配置',
        properties: ['openFile'],
        filters: [{ name: 'JSON 配置', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return;
    try {
        const raw = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
        const normalized = normalizeUpdateConfig(raw);
        if (!normalized.channelUrl && !normalized.controlUrl) throw new Error('配置中缺少 channelUrl 或 controlUrl');
        if (normalized.channelUrl && !normalized.publicKey) throw new Error('静态更新通道缺少 publicKey');
        updateConfig = normalized;
        writeJsonFile(updateConfigPath(), normalized);
        await restartServer();
        scheduleUpdateCheck();
        await dialog.showMessageBox(mainWindow || undefined, {
            type: 'info',
            title: '更新配置已导入',
            message: '更新通道配置已保存。静态更新通道会在托盘菜单中检查；控制面更新由内置代理连接。',
        });
    } catch (error) {
        dialog.showErrorBox('更新配置导入失败', error.message);
    }
}

async function checkForUpdates(manual = false) {
    if (updateCheckRunning) return;
    if (!updateConfig.channelUrl) {
        if (manual) {
            await dialog.showMessageBox(mainWindow || undefined, {
                type: 'info',
                title: '未配置更新通道',
                message: '当前安装包未导入静态更新通道配置。可从托盘菜单选择“导入更新通道配置”。',
            });
        }
        return;
    }
    updateCheckRunning = true;
    try {
        const result = await updater.checkForUpdates(updateConfig, packageJson.version);
        if (result.status === 'up-to-date') {
            if (manual) await dialog.showMessageBox(mainWindow || undefined, { type: 'info', title: '检查更新', message: `当前已是最新版本 v${packageJson.version}` });
            return;
        }
        if (result.status !== 'available') return;
        const release = result.release;
        const answer = await dialog.showMessageBox(mainWindow || undefined, {
            type: 'question',
            title: '发现新版本',
            message: `发现愈康云诊所 v${release.version}`,
            detail: `${release.notes || '建议更新以获得最新功能和修复。'}\n\n更新包会先验证 Ed25519 签名和 SHA-256，再启动安装程序。`,
            buttons: ['下载并安装', '稍后'],
            defaultId: 0,
            cancelId: 1,
        });
        if (answer.response !== 0) return;
        const updateDir = path.join(app.getPath('userData'), 'updates');
        const downloaded = await updater.downloadRelease(release, updateDir);
        appendLog(`更新包已下载并校验: ${downloaded.path}`);
        updater.launchInstaller(downloaded.path);
        isQuitting = true;
        app.quit();
    } catch (error) {
        appendLog(`检查更新失败: ${error.message}`);
        if (manual) dialog.showErrorBox('检查更新失败', error.message);
    } finally {
        updateCheckRunning = false;
    }
}

function scheduleUpdateCheck() {
    if (updateTimer) clearInterval(updateTimer);
    if (!updateConfig.channelUrl) return;
    updateTimer = setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
    updateTimer.unref();
    setTimeout(() => checkForUpdates(false), 20000).unref();
}

function refreshTrayMenu() {
    if (!tray) return;
    const autoStart = app.getLoginItemSettings().openAtLogin;
    const template = [
        { label: `打开愈康云诊所（端口 ${selectedPort}）`, click: () => createWindow() },
        { type: 'separator' },
        { label: '打开数据目录', click: () => openFolder(DATA_DIR) },
        { label: '打开备份目录', click: () => openFolder(path.join(DATA_DIR, 'backups')) },
        { label: '打开日志目录', click: () => openFolder(LOG_DIR) },
        {
            label: '端口设置',
            submenu: [
                { label: '自动选择（推荐）', type: 'radio', checked: !desktopConfig.port, click: () => setPreferredPort(null) },
                ...[3002, 3003, 3004, 3005].map(port => ({ label: `固定 ${port}`, type: 'radio', checked: Number(desktopConfig.port) === port, click: () => setPreferredPort(port) })),
            ],
        },
        { label: '开机启动', type: 'checkbox', checked: autoStart, click: (item) => setAutoStart(item.checked) },
        { type: 'separator' },
        { label: '检查更新', click: () => checkForUpdates(true) },
        { label: '导入更新通道配置...', click: importUpdateConfig },
        { label: '重启本地服务', click: () => restartServer().catch(showFatal) },
        { type: 'separator' },
        { label: `版本 v${packageJson.version}`, enabled: false },
        { label: '退出', click: () => { isQuitting = true; app.quit(); } },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
    if (tray) return;
    const iconPath = path.join(__dirname, 'build', 'icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip(`愈康云诊所 v${packageJson.version}`);
    tray.on('click', () => createWindow());
    refreshTrayMenu();
}

function closeServer() {
    if (serverRestartTimer) {
        clearTimeout(serverRestartTimer);
        serverRestartTimer = null;
    }
    if (serverProcess && !serverProcess.killed) {
        serverProcess.removeAllListeners('exit');
        serverProcess.kill();
    }
    serverProcess = null;
}

async function bootstrap() {
    desktopConfig = readJsonFile(configPath()) || {};
    updateConfig = loadUpdateConfig();
    if (!fs.existsSync(path.join(CLINIC_DIR, 'server.js'))) {
        throw new Error(`应用运行文件缺失: ${CLINIC_DIR}`);
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const portChoice = await choosePort();
    selectedPort = portChoice.port;
    localUrl = `http://127.0.0.1:${selectedPort}`;
    loginUrl = `${localUrl}/login.html`;
    appendLog(`端口选择完成: ${selectedPort}${portChoice.reused ? '（复用现有服务）' : ''}`);

    if (process.env.YUKANG_DESKTOP_SMOKE === '1') {
        await ensureServer();
        console.log(`YUKANG_DESKTOP_SMOKE_READY data=${DATA_DIR} url=${loginUrl}`);
        setTimeout(() => app.exit(0), 300);
        return;
    }

    await ensureServer();
    createTray();
    createWindow();
    scheduleUpdateCheck();
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        } else if (app.isReady()) {
            createWindow();
        }
    });

    app.on('before-quit', () => {
        isQuitting = true;
        closeServer();
    });

    app.whenReady().then(bootstrap).catch(showFatal);

    app.on('activate', () => {
        if (app.isReady()) createWindow();
    });

    app.on('window-all-closed', () => {
        if (isQuitting && process.platform !== 'darwin') app.quit();
    });
}
