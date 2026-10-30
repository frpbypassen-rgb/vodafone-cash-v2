'use strict';
const service = require('../services/customerAccountDocuments');
const mongoose = require('mongoose'),
    fs = require('fs/promises');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User');
test('admin review renders an explicit decision and escapes rejection reasons', async () => {
    const ejs = require('ejs'), path = require('path');
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/customer_document_review.ejs'), {
        accountType:'user',csrfToken:'csrf',account:{_id:'owner',documentRevision:2,verificationDocuments:[{_id:'doc',kind:'identity',reviewStatus:'pending',reviewReason:'<script>bad</script>'}]},
    });
    expect(html).toContain('document-review');
    expect(html).toContain('اختر نتيجة المراجعة');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
});
jest.setTimeout(120000);
test('verification needs an approved identity, never just an uploaded document', () => {
    expect(service.verificationState([])).toBe('not_submitted');
    expect(service.verificationState([{ kind: 'identity' }])).toBe('pending');
    expect(service.verificationState([{ kind: 'identity', reviewStatus: 'approved' }])).toBe('verified');
    expect(service.verificationState([{ kind: 'identity', reviewStatus: 'rejected' }])).toBe('rejected');
    expect(service.verificationState([{ kind: 'tax_card', reviewStatus: 'approved' }])).toBe('incomplete');
});
test('content signatures, supported types and size are enforced before writing', () => {
    expect(() =>
        service.inspectFile({ buffer: Buffer.from('<script>bad</script>'), mimetype: 'image/png' })
    ).toThrow();
    expect(() =>
        service.inspectFile({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimetype: 'application/pdf' })
    ).toThrow();
    expect(service.inspectFile({ buffer: Buffer.from('%PDF-1.7\n'), mimetype: 'application/pdf' })).toBe(
        '.pdf'
    );
});
test('download paths reject traversal, external references and arbitrary private files', () => {
    for (const value of [
        '../../.env',
        'https://example.com/a.pdf',
        '/private/account-documents/../../.env',
        '/uploads/account-documents/.env',
    ]) {
        expect(() => service.filePath(value)).toThrow();
    }
});

describe('persistent owner-scoped document lifecycle', () => {
    let mongo;
    const createdPaths = [];
    beforeAll(async () => {
        mongo = await MongoMemoryServer.create({
            binary: { version: '7.0.24' },
            instance: { launchTimeout: 60000 },
        });
        await mongoose.connect(mongo.getUri());
    });
    afterAll(async () => {
        for (const filename of createdPaths) await fs.unlink(filename).catch(() => {});
        await mongoose.disconnect();
        await mongo?.stop();
    });
    test('upload stays pending, review synchronizes, stale forms and foreign downloads fail', async () => {
        const owner = await User.create({
            name: 'Test',
            webUsername: 'document-owner',
            webPassword: 'test-password',
            balance: 420,
            role: 'user',
        });
        const foreign = await User.create({
            name: 'Foreign',
            webUsername: 'document-foreign',
            webPassword: 'test-password',
            balance: 900,
            role: 'user',
        });
        const ctx = { actor: owner, Model: User };
        const file = {
            buffer: Buffer.from('%PDF-1.7\n%%EOF'),
            mimetype: 'application/pdf',
            originalname: 'identity.pdf',
        };
        const uploaded = await service.upload(ctx, { kind: 'identity', revision: 0 }, file);
        const pending = await User.findById(owner._id);
        createdPaths.push(service.filePath(pending.verificationDocuments[0].fileUrl));
        expect(service.status(pending).verification).toBe('pending');
        expect(pending.balance).toBe(420);
        expect(service.status(pending).documents[0]).not.toHaveProperty('fileUrl');
        await expect(service.download(foreign, uploaded.id, {})).rejects.toMatchObject({ statusCode: 404 });
        await expect(
            service.review({ Model: User, actor: foreign, id: uploaded.id, revision: 0, result: 'approved' })
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
            service.upload({ actor: pending, Model: User }, { kind: 'identity', revision: 1 }, file)
        ).rejects.toMatchObject({ statusCode: 409 });
        await expect(
            service.review({
                Model: User,
                actor: pending,
                id: uploaded.id,
                revision: 1,
                result: 'rejected',
                reason: '',
            })
        ).rejects.toMatchObject({ statusCode: 400 });
        await service.review({
            Model: User,
            actor: pending,
            id: uploaded.id,
            revision: 1,
            result: 'rejected',
            reason: 'الصورة غير واضحة',
        });
        const rejected = await User.findById(owner._id);
        expect(service.status(rejected).verification).toBe('rejected');
        expect(service.status(rejected).documents[0].reason).toBe('الصورة غير واضحة');
        await expect(
            service.upload({ actor: rejected, Model: User }, { kind: 'identity', revision: 1 }, file)
        ).rejects.toMatchObject({ statusCode: 409 });
        const replacement = await service.upload(
            { actor: rejected, Model: User },
            { kind: 'identity', revision: 2 },
            file
        );
        const submitted = await User.findById(owner._id);
        createdPaths.push(service.filePath(submitted.verificationDocuments[0].fileUrl));
        expect(submitted.verificationDocuments).toHaveLength(1);
        expect(service.status(submitted).verification).toBe('pending');
        await service.review({
            Model: User,
            actor: submitted,
            id: replacement.id,
            revision: 3,
            result: 'approved',
        });
        const verified = await User.findById(owner._id);
        expect(service.status(verified).verification).toBe('verified');
        expect(verified.balance).toBe(420);
        expect(verified.status).toBe('active');
        const response = { set: jest.fn(), download: jest.fn() };
        await service.download(verified, replacement.id, response);
        expect(response.set).toHaveBeenCalledWith(
            expect.objectContaining({
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff',
            })
        );
        expect(response.download).toHaveBeenCalledWith(createdPaths[1], 'document.pdf');
    });
    test('HTTP uploads require CSRF and never trust a submitted owner identifier', async () => {
        const express = require('express'),
            request = require('supertest');
        const owner = await User.create({
            name: 'HTTP owner',
            webUsername: 'doc-http-owner',
            webPassword: 'test-password',
            role: 'user',
        });
        const foreign = await User.create({
            name: 'HTTP foreign',
            webUsername: 'doc-http-foreign',
            webPassword: 'test-password',
            role: 'user',
        });
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = {
                isClientLoggedIn: true,
                clientId: String(owner._id),
                accountType: 'user',
                clientSessionVersion: 0,
                csrfToken: 'test-csrf',
            };
            next();
        });
        app.use(require('../middlewares/csrfProtection'));
        app.use('/client', require('../routes/customerAccountDocuments'));
        await request(app)
            .post('/client/api/account-documents')
            .field('kind', 'identity')
            .attach('document', Buffer.from('%PDF-1.7\n%%EOF'), 'test.pdf')
            .expect(403);
        const response = await request(app)
            .post('/client/api/account-documents')
            .set('x-csrf-token', 'test-csrf')
            .field('kind', 'identity')
            .field('revision', '0')
            .attach('document', Buffer.from('%PDF-1.7\n%%EOF'), 'test.pdf');
        expect(response.status).toBe(200);
        const stored = await User.findById(owner._id);
        createdPaths.push(service.filePath(stored.verificationDocuments[0].fileUrl));
        const list = await request(app)
            .get('/client/api/account-documents?ownerId=' + foreign._id)
            .expect(200);
        expect(list.body.documents).toHaveLength(1);
        expect((await User.findById(foreign._id)).verificationDocuments).toHaveLength(0);
        await request(app)
            .get('/client/api/account-documents/' + new mongoose.Types.ObjectId())
            .expect(404);
    });
});
