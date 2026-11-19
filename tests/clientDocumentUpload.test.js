'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('node:fs/promises');
const path = require('node:path');
const upload = require('../middlewares/clientDocumentUpload');
const directory = path.join(__dirname, '../uploads');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lpEAAAAASUVORK5CYII=', 'base64');

describe('client identity image upload boundary', () => {
    let handled;
    const app = express();
    app.post('/transfer', upload.single('idCardImage'), async (req, res) => {
        handled++;
        if (!req.file) return res.json({ attached: false, note: req.body.note });
        const content = await fs.readFile(req.file.path);
        await fs.unlink(req.file.path);
        return res.json({ attached: true, name: req.file.filename, matches: content.equals(png) });
    });
    app.post('/transfer-denied', upload.single('idCardImage'), (_req, res) => res.sendStatus(403));
    app.post('/transfer-attached', upload.single('idCardImage'), (req, res) => {
        req.clientDocumentAttached = true;
        return res.json({ name: req.file.filename });
    });
    app.use((error, _req, res, _next) => res.status(error.statusCode || 422).json({ code: error.code || error.message }));
    beforeAll(() => fs.mkdir(directory, { recursive: true }));
    beforeEach(() => { handled = 0; });
    afterEach(() => jest.restoreAllMocks());

    test('rejects HTML disguised as a PNG before the transfer handler', async () => {
        const remove = jest.spyOn(fs, 'unlink');
        const response = await request(app).post('/transfer')
            .attach('idCardImage', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'identity.png', contentType: 'image/png' });
        expect(response.status).toBe(422);
        expect(handled).toBe(0);
        expect(remove).toHaveBeenCalledTimes(1);
        await expect(fs.access(remove.mock.calls[0][0])).rejects.toThrow();
        remove.mockRestore();
    });
    test('rejects a valid image whose declared MIME type differs', async () => {
        const response = await request(app).post('/transfer')
            .attach('idCardImage', png, { filename: 'identity.jpg', contentType: 'image/jpeg' });
        expect(response.status).toBe(422);
        expect(handled).toBe(0);
    });
    test('rejects excessive image dimensions before the transfer handler', async () => {
        const huge = Buffer.from(png);
        huge.writeUInt32BE(50000, 16);
        const response = await request(app).post('/transfer')
            .attach('idCardImage', huge, { filename: 'identity.png', contentType: 'image/png' });
        expect(response.status).toBe(422);
        expect(handled).toBe(0);
    });
    test('retains valid image bytes with a server-generated filename', async () => {
        const response = await request(app).post('/transfer')
            .attach('idCardImage', png, { filename: '../../identity.png', contentType: 'image/png' });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ attached: true, matches: true });
        expect(response.body.name).toMatch(/^client-document-[a-f0-9-]+\.png$/);
    });
    test('preserves optional uploads and multipart text fields', async () => {
        const response = await request(app).post('/transfer').field('note', 'مراجعة');
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ attached: false, note: 'مراجعة' });
    });
    test('rejects oversized uploads and unexpected fields', async () => {
        const large = await request(app).post('/transfer')
            .attach('idCardImage', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' });
        expect(large.status).toBe(413);
        const unexpected = await request(app).post('/transfer')
            .attach('otherImage', png, { filename: 'image.png', contentType: 'image/png' });
        expect(unexpected.status).toBe(400);
        expect(handled).toBe(0);
    });
    test('unsupported MIME is a 415 client error without invoking the handler', async () => {
        const response = await request(app).post('/transfer')
            .attach('idCardImage', Buffer.from('<svg/>'), { filename: 'image.svg', contentType: 'image/svg+xml' });
        expect(response.status).toBe(415);
        expect(handled).toBe(0);
    });
    test('removes a valid image when a later authorization step rejects the request', async () => {
        const remove = jest.spyOn(fs, 'unlink');
        try {
            const response = await request(app).post('/transfer-denied')
                .attach('idCardImage', png, { filename: 'identity.png', contentType: 'image/png' });
            expect(response.status).toBe(403);
            expect(remove).toHaveBeenCalledTimes(1);
            await remove.mock.results[0].value;
            await expect(fs.access(remove.mock.calls[0][0])).rejects.toThrow();
        } finally { remove.mockRestore(); }
    });
    test('retains an image explicitly attached to a durable record', async () => {
        const remove = jest.spyOn(fs, 'unlink');
        const response = await request(app).post('/transfer-attached')
            .attach('idCardImage', png, { filename: 'identity.png', contentType: 'image/png' });
        const filePath = path.join(directory, response.body.name);
        try {
            expect(response.status).toBe(200);
            expect(response.body.name).toMatch(/^client-document-[a-f0-9-]+\.png$/);
            expect(remove).not.toHaveBeenCalled();
            await expect(fs.access(filePath)).resolves.toBeUndefined();
        } finally { remove.mockRestore(); await fs.unlink(filePath); }
    });
    test('fails closed when invalid-content cleanup cannot complete', async () => {
        const remove = jest.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('storage unavailable'));
        let filePath;
        try {
            const response = await request(app).post('/transfer')
                .attach('idCardImage', Buffer.from('<html>not an image</html>'), { filename: 'identity.png', contentType: 'image/png' });
            filePath = remove.mock.calls[0][0];
            expect(response.status).toBe(503);
            expect(handled).toBe(0);
        } finally { remove.mockRestore(); if (filePath) await fs.unlink(filePath); }
    });
});
