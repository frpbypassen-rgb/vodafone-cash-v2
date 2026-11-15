'use strict';
jest.mock('../models/ExecutorGroup', () => ({ findOne: jest.fn() }));
jest.mock('../models/Transaction', () => ({ updateOne: jest.fn() }));
jest.mock('../models/KenanWebhookEvent', () => ({ updateOne: jest.fn() }));
const express = require('express'), request = require('supertest'), crypto = require('crypto');
const Group = require('../models/ExecutorGroup'), Transaction = require('../models/Transaction'), Event = require('../models/KenanWebhookEvent');
const app = express(); app.use('/webhooks/kenan', require('../routes/kenanWebhook'));
const id = '123456789012345678901234', secret = 'fixture-kenan-signing-key';
const body = JSON.stringify({ reference: '0000014', phone: '01000000000', amount_minor: 10000, status: 'success' });
const signature = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
const send = (value = body, signed = signature(body)) => request(app).post('/webhooks/kenan/' + id).set('Content-Type','application/json').set('X-Kenan-Signature', signed).send(value);
beforeEach(() => { jest.clearAllMocks(); Group.findOne.mockReturnValue({ select: async () => ({ _id: id, kenanWebhookSecret: secret }) }); Event.updateOne.mockResolvedValue({}); Transaction.updateOne.mockResolvedValue({}); });
test.each(['', '00'.repeat(32), 'not-hex'])('rejects invalid signature before saving %s', async signature => {
    expect((await send(body, signature)).status).toBe(401); expect(Event.updateOne).not.toHaveBeenCalled(); expect(Transaction.updateOne).not.toHaveBeenCalled();
});
test('signs original bytes, persists before ack and only wakes GET polling', async () => {
    expect((await send()).status).toBe(204);
    expect(Event.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: expect.stringContaining(id + ':') }), expect.anything(), expect.objectContaining({ writeConcern: { w: 'majority' } }));
    expect(Transaction.updateOne.mock.calls[0][1]).toEqual({ $set: { 'apiResultData.kenanNextPollAt': new Date(0) } });
    expect((await send(body + ' ')).status).toBe(401);
});
test('a storage failure returns non-2xx so Kenan can retry', async () => {
    Event.updateOne.mockRejectedValue(new Error('storage failed'));
    expect((await send()).status).toBe(503); expect(Transaction.updateOne).not.toHaveBeenCalled();
});
test('duplicate delivery uses the same persistent event ID', async () => {
    await send(); await send();
    expect(Event.updateOne.mock.calls[0][0]).toEqual(Event.updateOne.mock.calls[1][0]);
});
test('a signed malformed order cannot wake another transaction', async () => {
    const invalid = JSON.stringify({ reference: '0000014', status: 'success' });
    expect((await send(invalid, signature(invalid))).status).toBe(400); expect(Event.updateOne).not.toHaveBeenCalled();
});
