'use strict';

jest.mock('../models/Transaction', () => ({
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn()
}));
jest.mock('../models/Ledger', () => ({
    create: jest.fn(),
    updateOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    insertMany: jest.fn()
}));
jest.mock('../models/User', () => ({
    updateOne: jest.fn(),
    findOneAndUpdate: jest.fn()
}));
jest.mock('../models/ClientCompany', () => ({
    updateOne: jest.fn(),
    findByIdAndUpdate: jest.fn()
}));
jest.mock('../models/ExecutorGroup', () => ({
    updateOne: jest.fn(),
    findByIdAndUpdate: jest.fn()
}));
jest.mock('../services/whatsappReceiptDeliveryService', () => ({
    sendSplitPartReceipt: jest.fn()
}));
jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    financial: jest.fn()
}));

const fs = require('fs');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ExecutorGroup = require('../models/ExecutorGroup');
const { sendSplitPartReceipt } = require('../services/whatsappReceiptDeliveryService');
const manualExecutorReceipt = require('../utils/manualExecutorReceipt');
const { completedTransferLedgerInc } = require('../utils/executorServiceLedger');
const { getClientReceiptProofIds } = require('../services/clientReceiptService');
const { preparePersistedSenderEntries } = require('../utils/splitPartProofs');
const {
    issueSplitPartProof,
    issueSplitPartProofs,
    retrySplitPartProof
} = require('../services/splitPartProofService');

const RECIPIENT = '01011112222';
const CONFIRMED_AT = new Date('2026-09-26T12:00:00.000Z');

const proof = (partId, status = 'pending', extra = {}) => ({
    key: `tx-1:${partId}`,
    status,
    imageId: null,
    attempts: 0,
    lastError: '',
    ...extra
});

const entry = (partId, phone, amount, status = 'success', proofStatus = 'pending') => ({
    partId,
    phone,
    amount,
    status,
    confirmedAt: status === 'success' ? CONFIRMED_AT : undefined,
    customerProof: proof(partId, proofStatus)
});

const buildState = (entries) => ({
    _id: 'tx-1',
    customId: 'REF-2500',
    status: 'completed',
    amount: 2500,
    costLYD: 180.5,
    commission: 4.25,
    transferType: 'vodafone',
    vodafoneNumber: RECIPIENT,
    executorSenderEntries: entries,
    proofImages: [],
    proofImage: undefined,
    markModified: jest.fn(),
    save: jest.fn().mockImplementation(function save() { return Promise.resolve(this); })
});

const matchesEntry = (candidate, filter) => {
    if (!candidate) return false;
    if (filter.partId && String(candidate.partId) !== String(filter.partId)) return false;
    if (filter.status && candidate.status !== filter.status) return false;
    if (filter['customerProof.key'] && candidate.customerProof?.key !== filter['customerProof.key']) return false;
    const allowed = filter['customerProof.status']?.$in;
    if (allowed && !allowed.includes(candidate.customerProof?.status)) return false;
    return true;
};

const applyProofUpdate = (candidate, update) => {
    const target = candidate.customerProof;
    Object.entries(update.$set || {}).forEach(([key, value]) => {
        if (!key.includes('customerProof.')) return;
        target[key.split('.').pop()] = value;
    });
    Object.entries(update.$inc || {}).forEach(([key, value]) => {
        if (!key.includes('customerProof.')) return;
        const field = key.split('.').pop();
        target[field] = Number(target[field] || 0) + Number(value);
    });
};

describe('split part customer proofs', () => {
    let state;

    beforeEach(() => {
        jest.clearAllMocks();
        state = buildState([
            entry('1', '01108172258', 1000),
            entry('2', '01000926306', 1500)
        ]);
        state.save.mockImplementation(function save() { return Promise.resolve(this); });
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        jest.spyOn(manualExecutorReceipt, 'generateManualExecutorReceiptBase64').mockResolvedValue('data:image/jpeg;base64,QQ==');
        sendSplitPartReceipt.mockResolvedValue({ success: true, messageId: 'msg-part' });
        Transaction.findById.mockImplementation(async () => state);
        Transaction.updateOne.mockImplementation(async (_filter, update) => {
            if (Array.isArray(update)) {
                state.proofImages = state.executorSenderEntries
                    .filter((candidate) => candidate.status === 'success' && candidate.customerProof?.imageId)
                    .map((candidate) => candidate.customerProof.imageId);
                state.proofImage = state.proofImages[0];
            }
            return { acknowledged: true };
        });
        Transaction.findOneAndUpdate.mockImplementation(async (filter, update) => {
            if (filter.status && state.status !== filter.status) return null;
            const elem = filter.executorSenderEntries?.$elemMatch;
            const partId = elem?.partId || filter['executorSenderEntries.partId'];
            const index = state.executorSenderEntries.findIndex((candidate) => (
                elem ? matchesEntry(candidate, elem) : String(candidate.partId) === String(partId)
            ));
            if (index < 0) return null;
            applyProofUpdate(state.executorSenderEntries[index], update);
            return state;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('creates one image per successful part with that part amount, wallet, and the same recipient', async () => {
        const ledgerBefore = completedTransferLedgerInc(
            { balance: 9000, serviceBalances: { vodafone: 9000 } },
            state,
            -state.amount
        );
        const financialBefore = {
            amount: state.amount,
            costLYD: state.costLYD,
            commission: state.commission
        };

        const result = await issueSplitPartProofs(state._id);

        expect(result.parts).toHaveLength(2);
        expect(result.parts.every((part) => part.ok && part.proofStatus === 'sent')).toBe(true);
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).toHaveBeenCalledTimes(2);
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).toHaveBeenNthCalledWith(1, expect.objectContaining({
            amount: 1000,
            executionNumber: '01108172258',
            executionNumberLabel: 'المحفظة المرسلة',
            customerPhone: RECIPIENT,
            customId: 'REF-2500',
            executorReference: 'REF-2500:1',
            status: 'completed',
            completedAt: CONFIRMED_AT
        }));
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).toHaveBeenNthCalledWith(2, expect.objectContaining({
            amount: 1500,
            executionNumber: '01000926306',
            customerPhone: RECIPIENT,
            customId: 'REF-2500',
            executorReference: 'REF-2500:2'
        }));
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).not.toHaveBeenCalledWith(
            expect.objectContaining({ amount: 2500 })
        );
        expect(sendSplitPartReceipt).toHaveBeenCalledTimes(2);
        expect(sendSplitPartReceipt).toHaveBeenNthCalledWith(1, expect.objectContaining({
            partId: '1',
            partKey: 'tx-1:1',
            amount: 1000,
            reference: 'REF-2500:1'
        }));
        expect(sendSplitPartReceipt).toHaveBeenNthCalledWith(2, expect.objectContaining({
            partId: '2',
            partKey: 'tx-1:2',
            amount: 1500,
            reference: 'REF-2500:2'
        }));
        expect(state.proofImages).toEqual(['proofs/REF-2500_part_1.jpg', 'proofs/REF-2500_part_2.jpg']);
        expect(getClientReceiptProofIds(state)).toEqual(state.proofImages);
        expect(state.amount).toBe(financialBefore.amount);
        expect(state.costLYD).toBe(financialBefore.costLYD);
        expect(state.commission).toBe(financialBefore.commission);
        expect(state.status).toBe('completed');
        expect(Ledger.create).not.toHaveBeenCalled();
        expect(Ledger.updateOne).not.toHaveBeenCalled();
        expect(Ledger.findOneAndUpdate).not.toHaveBeenCalled();
        expect(User.updateOne).not.toHaveBeenCalled();
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(ClientCompany.updateOne).not.toHaveBeenCalled();
        expect(ClientCompany.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(ExecutorGroup.updateOne).not.toHaveBeenCalled();
        expect(ExecutorGroup.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(completedTransferLedgerInc(
            { balance: 9000, serviceBalances: { vodafone: 9000 } },
            state,
            -state.amount
        )).toEqual(ledgerBefore);
    });

    test('sends a proof only for the successful part when another part is pending or failed', async () => {
        state.executorSenderEntries[1] = entry('2', '01000926306', 1500, 'pending');

        const pendingResult = await issueSplitPartProofs(state._id);

        expect(pendingResult.parts.map((part) => part.code)).toEqual(['PART_PROOF_SENT', 'PART_NOT_SUCCESSFUL']);
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).toHaveBeenCalledTimes(1);
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).toHaveBeenCalledWith(
            expect.objectContaining({ amount: 1000, executionNumber: '01108172258' })
        );
        expect(sendSplitPartReceipt).toHaveBeenCalledTimes(1);

        jest.clearAllMocks();
        state = buildState([
            entry('1', '01108172258', 1000, 'failed'),
            entry('2', '01000926306', 1500, 'success')
        ]);
        sendSplitPartReceipt.mockResolvedValue({ success: true });
        jest.spyOn(manualExecutorReceipt, 'generateManualExecutorReceiptBase64').mockResolvedValue('data:image/jpeg;base64,QQ==');

        const failedResult = await issueSplitPartProofs(state._id);
        expect(failedResult.parts.map((part) => part.code)).toEqual(['PART_NOT_SUCCESSFUL', 'PART_PROOF_SENT']);
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).toHaveBeenCalledTimes(1);
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).toHaveBeenCalledWith(
            expect.objectContaining({ amount: 1500, executionNumber: '01000926306', customerPhone: RECIPIENT })
        );
    });

    test('does not send a second proof for repeated or overlapping success events', async () => {
        await issueSplitPartProofs(state._id);
        await issueSplitPartProofs(state._id);
        const concurrent = await Promise.all([
            issueSplitPartProof('tx-1', '1'),
            issueSplitPartProof('tx-1', '1')
        ]);

        expect(sendSplitPartReceipt).toHaveBeenCalledTimes(2);
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).toHaveBeenCalledTimes(2);
        expect(concurrent.every((result) => result.duplicate)).toBe(true);
        expect(state.executorSenderEntries[0].customerProof.attempts).toBe(1);
        expect(state.executorSenderEntries[1].customerProof.attempts).toBe(1);
    });

    test('keeps the completed transfer unchanged when image generation or sending fails, then retries the proof only', async () => {
        manualExecutorReceipt.generateManualExecutorReceiptBase64
            .mockRejectedValueOnce(new Error('canvas failed token=secret'))
            .mockResolvedValue('data:image/jpeg;base64,QQ==');

        const failed = await issueSplitPartProof('tx-1', '1');
        expect(failed).toMatchObject({ ok: false, code: 'PART_PROOF_GENERATION_FAILED', proofStatus: 'failed' });
        expect(state.status).toBe('completed');
        expect(state.amount).toBe(2500);
        expect(state.costLYD).toBe(180.5);
        expect(state.commission).toBe(4.25);
        expect(state.executorSenderEntries[0].customerProof.status).toBe('failed');
        expect(state.executorSenderEntries[0].customerProof.lastError).toBe('PART_PROOF_FAILED');
        expect(sendSplitPartReceipt).not.toHaveBeenCalled();
        expect(Ledger.create).not.toHaveBeenCalled();
        expect(Transaction.create).toBeUndefined();

        sendSplitPartReceipt.mockResolvedValueOnce({ success: false, code: 'WHATCHIMP_DISABLED', message: 'disabled bearer token' });
        const sendFailed = await retrySplitPartProof('tx-1', '1');
        expect(sendFailed.proofStatus).toBe('failed');
        expect(state.amount).toBe(2500);
        expect(ExecutorGroup.findByIdAndUpdate).not.toHaveBeenCalled();

        const retried = await retrySplitPartProof('tx-1', '1');
        expect(retried).toMatchObject({ ok: true, proofStatus: 'sent', partId: '1' });
        expect(state.status).toBe('completed');
        expect(state.amount).toBe(2500);
        expect(state.costLYD).toBe(180.5);
        expect(sendSplitPartReceipt).toHaveBeenCalledTimes(2);
        expect(Ledger.insertMany).not.toHaveBeenCalled();
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('does not fabricate a wallet or amount when part execution data is missing', async () => {
        state.executorSenderEntries[0].phone = '';
        state.executorSenderPhone = '01000926306';

        const result = await issueSplitPartProof('tx-1', '1');

        expect(result).toMatchObject({ ok: false, code: 'PART_PROOF_UNAVAILABLE' });
        expect(state.executorSenderEntries[0].customerProof.status).toBe('unavailable');
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).not.toHaveBeenCalled();
        expect(sendSplitPartReceipt).not.toHaveBeenCalled();
    });

    test('does not issue proofs for a legacy split that has no part identity', async () => {
        state.executorSenderEntries = [
            { phone: '01108172258', amount: 1000 },
            { phone: '01000926306', amount: 1500 }
        ];

        const result = await issueSplitPartProofs(state._id);

        expect(result).toEqual({ ok: true, skipped: true, parts: [] });
        expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
        expect(manualExecutorReceipt.generateManualExecutorReceiptBase64).not.toHaveBeenCalled();
    });

    test('keeps a non-split transfer on the single existing receipt', () => {
        const single = preparePersistedSenderEntries({
            transactionId: 'tx-1',
            completedAt: CONFIRMED_AT,
            entries: [{ phone: '01108172258', amount: 2500, proofImage: null }]
        });
        expect(single).toEqual([{ phone: '01108172258', amount: 2500, proofImage: null }]);
        expect(getClientReceiptProofIds({
            proofImage: 'proofs/official.jpg',
            proofImages: ['proofs/official.jpg', 'proofs/extra.jpg'],
            executorSenderEntries: single
        })).toEqual(['proofs/official.jpg']);

        const stamped = preparePersistedSenderEntries({
            transactionId: 'tx-1',
            completedAt: CONFIRMED_AT,
            requestedEntries: [{ status: 'success' }, { status: 'failed' }],
            entries: [
                { phone: '01108172258', amount: 1000, proofImage: null },
                { phone: '01000926306', amount: 1500, proofImage: null }
            ]
        });
        expect(stamped[0]).toMatchObject({ partId: '1', status: 'success', phone: '01108172258', amount: 1000 });
        expect(stamped[1]).toMatchObject({ partId: '2', status: 'failed', phone: '01000926306', amount: 1500 });
        expect(stamped[1].confirmedAt).toBeUndefined();
        expect(stamped[0].confirmedAt).toEqual(CONFIRMED_AT);
    });
});
