'use strict';
const express = require('express');
const request = require('supertest');
test('limits capture and location to this origin without breaking proof and voice attachments', async () => {
    const app = express();
    app.use(require('../middlewares/browserSecurityHeaders'));
    app.get('/', (_req, res) => res.send('ok'));
    const response = await request(app).get('/');
    expect(response.headers['permissions-policy']).toBe(
        'camera=(self), microphone=(self), geolocation=(self)'
    );
});
