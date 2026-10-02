const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const asyncRoute = require('../utils/asyncRoute');

function registerPageRoutes(app, baseDir, options = {}) {
    function resolveVendor(...parts) {
        const roots = [
            process.env.YUKONG_VENDOR_DIR,
            'vendor',
            'node_modules',
        ].filter(Boolean);
        for (const root of roots) {
            const candidate = path.isAbsolute(root)
                ? path.join(root, ...parts)
                : path.join(baseDir, root, ...parts);
            if (fs.existsSync(candidate)) return candidate;
        }
        return path.join(baseDir, 'vendor', ...parts);
    }

    // 离线运行所需的第三方前端资源全部从安装包内提供，不依赖 CDN。
    const fontAwesomeRoot = resolveVendor('@fortawesome', 'fontawesome-free');
    app.use('/vendor/fontawesome', express.static(fontAwesomeRoot, {
        dotfiles: 'deny',
        index: false,
        maxAge: '30d',
    }));
    app.get('/vendor/xlsx.full.min.js', (req, res, next) => {
        res.sendFile(resolveVendor('xlsx', 'dist', 'xlsx.full.min.js'), (error) => {
            if (error) next(error);
        });
    });
    app.get('/api/qr-code', asyncRoute(async (req, res) => {
        const data = String(req.query.data || '');
        if (!data || data.length > 2000) {
            const error = new Error('二维码内容为空或过长');
            error.status = 400;
            error.code = 'INVALID_QR_DATA';
            throw error;
        }
        const size = Math.min(512, Math.max(64, Number(req.query.size) || 160));
        const png = await QRCode.toBuffer(data, {
            type: 'png',
            width: size,
            margin: 1,
            errorCorrectionLevel: 'M',
        });
        res.setHeader('Cache-Control', 'no-store');
        res.type('png').send(png);
    }));

    // 只开放页面运行所需的静态资源，避免把 server.js、数据库和 node_modules 暴露出去。
    app.use('/assets', express.static(path.join(baseDir, 'assets'), {
        dotfiles: 'deny',
        index: false,
    }));
    app.get('/v5-pages.css', (req, res) => {
        res.sendFile(path.join(baseDir, 'v5-pages.css'));
    });
    app.get('/v5-pages.js', (req, res) => {
        res.sendFile(path.join(baseDir, 'v5-pages.js'));
    });
    app.get(['/', '/index.html'], (req, res) => {
        res.sendFile(path.join(baseDir, 'index.html'));
    });
    app.get('/login.html', (req, res) => {
        res.sendFile(path.join(baseDir, 'login.html'));
    });
    if (options.registerFallback !== false) {
        registerFallback(app);
    }
};

function registerFallback(app) {
    app.use((req, res) => {
        if (req.path.startsWith('/api/')) {
            return res.status(404).json({ error: '接口不存在', code: 'API_NOT_FOUND' });
        }
        res.status(404).send('页面不存在');
    });
}

module.exports = registerPageRoutes;
registerPageRoutes.fallback = registerFallback;
