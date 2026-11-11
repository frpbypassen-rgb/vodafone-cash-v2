'use strict';
process.env.JWT_SECRET ||= 'audit-jwt-secret-at-least-thirty-two-characters';
process.env.JWT_REFRESH_SECRET ||= 'audit-refresh-secret-at-least-thirty-two-characters';
jest.mock('../models/ClientEmployee', () => ({ findById: jest.fn() }));
jest.mock('../models/ClientCompany', () => ({ findById: jest.fn() }));
jest.mock('../models/MobileDeviceSession', () => ({ exists: jest.fn() }));
jest.mock('../services/securityControlService', () => ({ getState: jest.fn(async () => ({ accountDeviceEnforcementEnabled: false })) }));
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const Employee = require('../models/ClientEmployee');
const Company = require('../models/ClientCompany');
const Sessions = require('../models/MobileDeviceSession');
const { authenticateJWT } = require('../middlewares/jwtAuth');
const app = express();
app.use((req, _res, next) => { req.tenant = { _id: 'audit-tenant' }; next(); });
app.get('/protected', authenticateJWT, (_req, res) => res.json({ success: true }));
const query = result => ({ select: jest.fn(async () => result) });
const token = () => jwt.sign({
    userId: 'audit-employee', companyId: 'audit-company', tenantId: 'audit-tenant',
    accountType: 'client_company', sessionVersion: 3, sessionId: 'audit-session'
}, process.env.JWT_SECRET);
beforeEach(() => {
    jest.clearAllMocks();
    Employee.findById.mockReturnValue(query({ status: 'active', sessionVersion: 3, companyId: 'audit-company', tenantId: 'audit-tenant' }));
    Company.findById.mockReturnValue(query({ status: 'active', tenantId: 'audit-tenant' }));
    Sessions.exists.mockResolvedValue(true);
});
const get = () => request(app).get('/protected').set('Authorization', 'Bearer ' + token());
test('accepts an active company employee with current account and device sessions', async () => {
    expect((await get()).status).toBe(200);
    expect(Sessions.exists).toHaveBeenCalledWith(expect.objectContaining({ accountType: 'client_company' }));
});
test.each([
    { status: 'banned', sessionVersion: 3, companyId: 'audit-company' },
    { status: 'active', sessionVersion: 4, companyId: 'audit-company' },
    { status: 'active', sessionVersion: 3, companyId: 'another-company' }
])('rejects suspended, revoked or moved employees %j', async employee => {
    Employee.findById.mockReturnValue(query(employee));
    expect((await get()).status).toBe(401);
});
test('rejects an inactive company and an individually revoked mobile session', async () => {
    Company.findById.mockReturnValueOnce(query({ status: 'banned' }));
    expect((await get()).status).toBe(401);
    Sessions.exists.mockResolvedValueOnce(false);
    expect((await get()).status).toBe(401);
});
