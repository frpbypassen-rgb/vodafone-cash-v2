'use strict';

const crypto = require('crypto');
const Ledger = require('../models/Ledger');
const { updateBalanceWithLedger } = require('./walletService');

const buildReference = () => {
    const stamp = new Date();
    const ymd = `${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}`;
    return `CORP-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const findExistingLedger = async (transactionId) => {
    if (!transactionId) return null;
    const query = Ledger.findOne({ transactionId });
    return typeof query.lean === 'function' ? query.lean() : query;
};

/**
 * Execute a corporate payout against the company wallet using the existing
 * double-entry wallet service. Safe to retry: a matching ledger row wins.
 */
const executeCompanyDebit = async ({
    company,
    amount,
    reference,
    description,
    tenantId,
    minBalance
}) => {
    const transactionId = reference || buildReference();
    const existing = await findExistingLedger(transactionId);
    if (existing) {
        return {
            idempotent: true,
            transactionId,
            balanceBefore: existing.balanceBefore,
            balanceAfter: existing.balanceAfter
        };
    }

    const result = await updateBalanceWithLedger(
        'ClientCompany',
        company._id,
        -Math.abs(Number(amount)),
        'TRANSFER',
        transactionId,
        description || `تحويل شركات ${transactionId}`,
        {
            minBalance: Number.isFinite(Number(minBalance)) ? Number(minBalance) : -(Number(company.creditLimit) || 0),
            tenantId
        }
    );

    return {
        idempotent: false,
        transactionId,
        balanceBefore: result.balanceBefore,
        balanceAfter: result.balanceAfter
    };
};

module.exports = {
    buildReference,
    findExistingLedger,
    executeCompanyDebit
};
