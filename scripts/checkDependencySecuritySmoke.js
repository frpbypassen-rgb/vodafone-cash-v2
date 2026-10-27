'use strict';
// Local-only compatibility and regression checks for dependency security updates.
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const request = require('supertest');
const { loadPuppeteer } = require('../utils/puppeteerLoader');

async function main() {
    const app = express();
    app.use(express.json({ limit: '32kb' }));
    app.post('/json', (req, res) => res.json({ received: req.body.value }));
    app.post(
        '/upload',
        multer({
            storage: multer.memoryStorage(),
            limits: { fileSize: 1024 },
            fileFilter: (_req, _file, callback) => setTimeout(() => callback(null, true), 30),
        }).single('proof'),
        (req, res) => res.json({ size: req.file.size })
    );
    app.use((error, _req, res, _next) =>
        res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ rejected: true })
    );
    assert.equal((await request(app).post('/json').send({ value: 'ok' })).body.received, 'ok');
    assert.equal(
        (await request(app).post('/upload').attach('proof', Buffer.from('test'), 'proof.bin')).body.size,
        4
    );
    assert.equal(
        (await request(app).post('/upload').attach('proof', Buffer.alloc(2048), 'proof.bin')).status,
        413
    );

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const compressed = Buffer.concat([
            zlib.gzipSync(Buffer.from('{"value":"ok"}')),
            Buffer.from('invalid trailing bytes'),
        ]);
        const status = await new Promise((resolve, reject) => {
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port: server.address().port,
                    path: '/json',
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'content-encoding': 'gzip',
                        'content-length': compressed.length,
                    },
                },
                (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode));
                }
            );
            req.on('error', reject);
            req.end(compressed);
        });
        assert.equal(status, 400, 'Malformed compressed input must be rejected without crashing the server');
        const boundary = 'security-smoke-boundary';
        await new Promise((resolve) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: server.address().port,
                path: '/upload',
                method: 'POST',
                headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
            });
            req.on('error', () => {});
            req.write(
                '--' +
                    boundary +
                    '\r\nContent-Disposition: form-data; name="proof"; filename="proof.bin"\r\nContent-Type: application/octet-stream\r\n\r\ntest'
            );
            setTimeout(() => {
                req.destroy();
                setTimeout(resolve, 80);
            }, 10);
        });
        assert.equal((await request(app).post('/json').send({ value: 'alive' })).body.received, 'alive');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const mail = await transport.sendMail({
        from: 'noreply@example.test',
        to: 'owner@example.test',
        subject: 'كشف حساب تجريبي',
        text: 'اختبار محلي دون إرسال خارجي.',
        attachments: [
            {
                filename: 'statement.pdf',
                content: Buffer.from('%PDF-1.4\n%%EOF'),
                contentType: 'application/pdf',
            },
        ],
    });
    assert.deepEqual(mail.envelope.to, ['owner@example.test']);
    assert(mail.message.toString().includes('application/pdf'));
    const browser = await (
        await loadPuppeteer()
    ).launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 390, height: 844 });
        await page.setContent('<html lang="ar" dir="rtl"><h1>كشف حساب تجريبي</h1></html>');
        const pdf = await page.pdf({ format: 'A4' });
        assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
    } finally {
        await browser.close();
    }
    console.log(
        JSON.stringify({
            passed: true,
            malformedCompressedBody: true,
            uploadAndSizeLimit: true,
            abortedAsyncFileFilter: true,
            mailAndAttachment: true,
            browserAndPdf: true,
            externalDelivery: false,
        })
    );
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
