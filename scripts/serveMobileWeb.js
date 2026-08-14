'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', 'mobile_app', 'build', 'web');
const port = Number(process.env.MOBILE_WEB_PORT || 3001);
const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ttf': 'font/ttf',
    '.webp': 'image/webp',
    '.wasm': 'application/wasm'
};

const resolveAsset = (requestUrl) => {
    const pathname = new URL(requestUrl, 'http://localhost').pathname;
    const relativePath = pathname === '/'
        ? 'index.html'
        : decodeURIComponent(pathname).replace(/^[/\\]+/, '');
    const assetPath = path.resolve(root, relativePath);
    return assetPath.startsWith(`${root}${path.sep}`) ? assetPath : null;
};

http.createServer((req, res) => {
    const assetPath = resolveAsset(req.url);
    if (!assetPath) {
        res.writeHead(403).end();
        return;
    }

    fs.readFile(assetPath, (error, data) => {
        if (error) {
            res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
            return;
        }
        res.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Type': mimeTypes[path.extname(assetPath)] || 'application/octet-stream'
        });
        res.end(data);
    });
}).listen(port, '127.0.0.1', () => {
    console.log(`Mobile web preview available at http://127.0.0.1:${port}`);
});
