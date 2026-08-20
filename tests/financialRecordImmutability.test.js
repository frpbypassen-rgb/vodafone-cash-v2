'use strict';

const {
    assertFinancialRecordMutationAllowed,
    immutableRecordError
} = require('../utils/financialRecordImmutability');
const Ledger = require('../models/Ledger');
const AgencyJournal = require('../models/AgencyJournal');

describe('append-only financial record policy', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
    });

    test('blocks ledger mutation in production', () => {
        process.env.NODE_ENV = 'production';

        expect(() => assertFinancialRecordMutationAllowed('ledger')).toThrow('LEDGER_IMMUTABLE');
        try {
            assertFinancialRecordMutationAllowed('ledger');
        } catch (error) {
            expect(error).toMatchObject({
                code: 'FINANCIAL_RECORD_IMMUTABLE',
                statusCode: 409
            });
        }
    });

    test('allows legacy cleanup only outside production', () => {
        process.env.NODE_ENV = 'test';
        expect(() => assertFinancialRecordMutationAllowed('ledger')).not.toThrow();
    });

    test('installs production delete guards on ledger and agency journal models', async () => {
        process.env.NODE_ENV = 'production';

        await expect(Ledger.deleteMany({ transactionId: 'ATT-TEST' }))
            .rejects.toMatchObject({ code: 'FINANCIAL_RECORD_IMMUTABLE' });
        await expect(AgencyJournal.deleteMany({ transactionId: 'ATT-TEST' }))
            .rejects.toMatchObject({ code: 'FINANCIAL_RECORD_IMMUTABLE' });
    });

    test('builds a stable immutable-record error', () => {
        expect(immutableRecordError('agency_journal')).toMatchObject({
            message: 'AGENCY_JOURNAL_IMMUTABLE',
            code: 'FINANCIAL_RECORD_IMMUTABLE',
            statusCode: 409
        });
    });
});
