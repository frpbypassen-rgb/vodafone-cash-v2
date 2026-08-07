'use strict';

const mongoose = require('mongoose');
const AgencyJournal = require('../models/AgencyJournal');

const baseEntry = () => ({
    eventId: `TEST-${Date.now()}`,
    ownerType: 'agent',
    ownerId: new mongoose.Types.ObjectId(),
    customerId: new mongoose.Types.ObjectId(),
    transactionId: 'ATT-TEST-1',
    eventType: 'TRANSFER_RESERVED',
    status: 'reserved'
});

describe('AgencyJournal validation', () => {
    test('uses the event id as the idempotency key when none is provided', async () => {
        const entry = new AgencyJournal({
            ...baseEntry(),
            lines: [
                { accountCode: 'CUSTOMER_BALANCE', side: 'debit', amount: 10 },
                { accountCode: 'COMPANY_WALLET', side: 'credit', amount: 10 }
            ]
        });

        await entry.validate();

        expect(entry.idempotencyKey).toBe(entry.eventId);
    });

    test('accepts a balanced agency transfer entry', async () => {
        const entry = new AgencyJournal({
            ...baseEntry(),
            lines: [
                { accountCode: 'CUSTOMER_BALANCE', side: 'debit', amount: 168.067 },
                { accountCode: 'COMPANY_WALLET', side: 'credit', amount: 167.224 },
                { accountCode: 'AGENCY_MARGIN_REVENUE', side: 'credit', amount: 0.843 }
            ]
        });

        await expect(entry.validate()).resolves.toBeUndefined();
        expect(entry.debitTotal).toBe(168.067);
        expect(entry.creditTotal).toBe(168.067);
    });

    test('rejects an unbalanced journal entry', async () => {
        const entry = new AgencyJournal({
            ...baseEntry(),
            lines: [
                { accountCode: 'CUSTOMER_BALANCE', side: 'debit', amount: 100 },
                { accountCode: 'COMPANY_WALLET', side: 'credit', amount: 90 }
            ]
        });

        await expect(entry.validate()).rejects.toMatchObject({
            errors: {
                lines: expect.objectContaining({ message: expect.stringContaining('not balanced') })
            }
        });
    });
});
