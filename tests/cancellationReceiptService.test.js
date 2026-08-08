'use strict';

jest.mock('../services/proofStorageService', () => {
    const path = require('path');
    return {
        proofFilePath: (fileName) => path.join(process.cwd(), 'test-artifacts', 'jest-proofs', fileName)
    };
});

const fs = require('fs');
const path = require('path');
const { createCancellationReceiptProof } = require('../services/cancellationReceiptService');

describe('cancellationReceiptService', () => {
    test('generates the Arabic red cancellation receipt as a JPEG proof', () => {
        const proofId = createCancellationReceiptProof({
            tx: {
                _id: 'tx-1',
                customId: 'ATT-2608-0001',
                status: 'cancelled_by_admin',
                vodafoneNumber: '01012345678',
                accountName: 'عميل تجريبي',
                transferType: 'vodafone',
                amount: 500
            },
            reason: 'طلب العميل إلغاء العملية',
            cancellationNumber: 'CAN-2608-00001',
            performedBy: 'الإدارة',
            cancelledAt: new Date('2026-08-03T10:00:00Z')
        });

        const receiptPath = path.join(process.cwd(), 'test-artifacts', 'jest-proofs', path.basename(proofId));
        const receipt = fs.readFileSync(receiptPath);

        expect(proofId).toBe('proofs/CAN-2608-00001_cancellation_receipt.jpg');
        expect(receipt.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        expect(receipt.length).toBeGreaterThan(1000);
    });
});
