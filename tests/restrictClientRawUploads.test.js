'use strict';

const restrictClientRawUploads = require('../middlewares/restrictClientRawUploads');
const express = require('express');
const request = require('supertest');

describe('Raw upload access for client sessions', () => {
    test('blocks a client session before static storage is reached', () => {
        const next = jest.fn();
        const send = jest.fn();
        const status = jest.fn(() => ({ send }));
        restrictClientRawUploads({ session: { isClientLoggedIn: true } }, { status }, next);
        expect(status).toHaveBeenCalledWith(403);
        expect(send).toHaveBeenCalledWith('Forbidden');
        expect(next).not.toHaveBeenCalled();
    });

    test('allows non-client sessions to continue to their own access policy', () => {
        const next = jest.fn();
        restrictClientRawUploads({ session: { isLoggedIn: true } }, { status: jest.fn() }, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test.each(['/uploads/proofs/receipt.jpg', '/uploads/support/chat.jpg', '/uploads/profile.jpg'])(
        'blocks a real client request to %s, including mixed login flags', async (url) => {
            const app = express();
            const storage = jest.fn((_req, res) => res.send('private-file'));
            app.use((req, _res, next) => {
                req.session = { isClientLoggedIn: true, isLoggedIn: true, isExecutorLoggedIn: true };
                next();
            });
            app.use('/uploads', restrictClientRawUploads, storage);
            const response = await request(app).get(url);
            expect(response.status).toBe(403);
            expect(storage).not.toHaveBeenCalled();
        }
    );
});
