'use strict';

const express = require('express');
const request = require('supertest');
const ExecutorGroup = require('../models/ExecutorGroup');
const router = require('../routes/executors');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.session = { isLoggedIn: req.get('x-test-role') !== 'guest', adminRole: req.get('x-test-role') };
    next();
});
app.use(router);

describe('executor provider tests require master authorization', () => {
    for (const endpoint of ['test-api', 'test-transfer']) {
        test(`${endpoint} refuses unauthenticated and read-only administrators before provider access`, async () => {
            const url = `/executor/example/${endpoint}`;
            const guest = await request(app).post(url).set('accept', 'application/json').set('x-test-role', 'guest').send({});
            const accountant = await request(app).post(url).set('accept', 'application/json').set('x-test-role', 'accountant').send({});
            const admin = await request(app).post(url).set('accept', 'application/json').set('x-test-role', 'admin').send({});
            expect(guest.status).toBe(401);
            expect(accountant.status).toBe(403);
            expect(admin.status).toBe(403);
        });

        test(`${endpoint} allows master to reach the handler`, async () => {
            const lookup = jest.spyOn(ExecutorGroup, 'findById').mockResolvedValue(null);
            try {
                const response = await request(app).post(`/executor/example/${endpoint}`)
                    .set('accept', 'application/json').set('x-test-role', 'master').send({});
                expect(response.status).toBe(404);
                expect(lookup).toHaveBeenCalledWith('example');
            } finally {
                lookup.mockRestore();
            }
        });
    }
});
