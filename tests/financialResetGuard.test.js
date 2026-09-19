'use strict';

const { assertFinancialResetAllowed, extractDbName } = require('../utils/financialResetGuard');

describe('financial reset guards', () => {
    test('extracts the database name from a Mongo URI', () => {
        expect(extractDbName('mongodb://127.0.0.1:27017/vodafone_cash_system?replicaSet=rs0'))
            .toBe('vodafone_cash_system');
    });

    test('refuses production unconditionally', () => {
        expect(() => assertFinancialResetAllowed({
            env: {
                NODE_ENV: 'production',
                ALLOW_FINANCIAL_RESET: 'true',
                CONFIRM_DB_NAME: 'vodafone_cash_system'
            },
            dbName: 'vodafone_cash_system'
        })).toThrow(/never allowed in production/);
    });

    test('requires ALLOW_FINANCIAL_RESET and a matching CONFIRM_DB_NAME', () => {
        expect(() => assertFinancialResetAllowed({
            env: { NODE_ENV: 'development', CONFIRM_DB_NAME: 'demo' },
            dbName: 'demo'
        })).toThrow(/ALLOW_FINANCIAL_RESET/);

        expect(() => assertFinancialResetAllowed({
            env: {
                NODE_ENV: 'development',
                ALLOW_FINANCIAL_RESET: 'true',
                CONFIRM_DB_NAME: 'demo'
            },
            dbName: 'production-copy'
        })).toThrow(/does not match/);
    });

    test('allows a confirmed non-production dry-run', () => {
        const result = assertFinancialResetAllowed({
            env: {
                NODE_ENV: 'development',
                ALLOW_FINANCIAL_RESET: 'true',
                CONFIRM_DB_NAME: 'local_demo',
                DRY_RUN: 'true'
            },
            dbName: 'local_demo'
        });
        expect(result).toEqual({ dryRun: true, dbName: 'local_demo' });
    });
});
