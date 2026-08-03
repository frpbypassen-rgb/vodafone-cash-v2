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
    test('generates Arabic cancellation receipt without old English labels', () => {
        const proofId = createCancellationReceiptProof({
            tx: {
                _id: 'tx-1',
                customId: 'ATT-2608-0001',
                status: 'cancelled_by_admin',
                vodafoneNumber: '01012345678',
                accountName: 'عميل تجريبي',
                transferType: 'vodafone',
                amount: 500,
                costLYD: 42.5
            },
            reason: 'طلب العميل إلغاء العملية',
            cancellationNumber: 'CAN-2608-00001',
            performedBy: 'الإدارة',
            cancelledAt: new Date('2026-08-03T10:00:00Z')
        });

        const svgPath = path.join(process.cwd(), 'test-artifacts', 'jest-proofs', path.basename(proofId));
        const svg = fs.readFileSync(svgPath, 'utf8');

        expect(proofId).toBe('proofs/CAN-2608-00001_cancellation_receipt.svg');
        expect(svg).toContain('إيصال إلغاء عملية');
        expect(svg).toContain('رقم الإلغاء');
        expect(svg).toContain('المبلغ المرتجع');
        expect(svg).toContain('ملغاة');
        expect(svg).toContain('Power Pay AL-Ahram');
        expect(svg).not.toContain('Cancellation Receipt');
        expect(svg).not.toContain('CANCELLED');
        expect(svg).not.toContain('Refunded:');
    });
});
