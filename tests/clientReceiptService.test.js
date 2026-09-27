'use strict';

const {
    buildClientReceiptImages,
    getClientReceiptProofIds,
    presentClientPortalTransaction,
    presentClientVisibleReceipts
} = require('../services/clientReceiptService');

describe('clientReceiptService', () => {
    test('returns only the official system receipt and excludes executor attachments', () => {
        const transaction = {
            proofImages: ['proofs/first.svg', '', 'proofs/second.jpg'],
            proofImage: 'proofs/official.svg',
            executorProofImages: ['proofs/executor-private.jpg']
        };

        expect(getClientReceiptProofIds(transaction)).toEqual([
            'proofs/official.svg'
        ]);
    });

    test('sends the attached bank-transfer proof and keeps extra executor images private', () => {
        const transaction = {
            _id: '64f123456789012345678901',
            transferType: 'bank_account',
            proofImage: 'proofs/bank-proof.jpg',
            proofImages: ['proofs/bank-proof.jpg'],
            executorProofImages: ['proofs/extra-bank-page.jpg']
        };

        expect(getClientReceiptProofIds(transaction)).toEqual(['proofs/bank-proof.jpg']);
        expect(buildClientReceiptImages(transaction)).toEqual([{
            index: 0,
            label: 'إثبات التحويل البنكي',
            url: '/client/proxy/image/64f123456789012345678901/0'
        }]);
        expect(JSON.stringify(buildClientReceiptImages(transaction))).not.toContain('extra-bank-page');
    });

    test('builds authenticated client proxy links without exposing proof identifiers', () => {
        const images = buildClientReceiptImages({
            _id: '64f123456789012345678901',
            proofImages: ['telegram-file-id', 'proofs/local-receipt.svg']
        });

        expect(images).toEqual([{
            index: 0,
            label: 'صورة الإثبات 1',
            url: '/client/proxy/image/64f123456789012345678901/0'
        }]);
        expect(JSON.stringify(images)).not.toContain('telegram-file-id');
        expect(JSON.stringify(images)).not.toContain('local-receipt.svg');
    });

    test('returns no links when a transaction has no receipt', () => {
        expect(buildClientReceiptImages({ _id: '64f123456789012345678901' })).toEqual([]);
        expect(buildClientReceiptImages({ proofImage: 'proofs/receipt.svg' })).toEqual([]);
    });

    test('serves the cancellation receipt for a cancelled operation even when an older success image remains', () => {
        expect(getClientReceiptProofIds({
            status: 'cancelled_by_admin',
            proofImage: 'proofs/ATT-1.jpg',
            proofImages: ['proofs/ATT-1.jpg', 'proofs/CAN-1_cancellation_receipt.jpg']
        })).toEqual(['proofs/CAN-1_cancellation_receipt.jpg']);
    });

    test('does not treat the protected placeholder as a stored proof id', () => {
        expect(getClientReceiptProofIds({ proofImage: 'protected', proofImages: ['protected'] })).toEqual([]);
        expect(presentClientVisibleReceipts({
            _id: '64f123456789012345678901',
            proofImage: 'protected'
        })).toEqual({
            hasProof: false,
            receiptImages: [],
            proofImage: '',
            proofImages: []
        });
    });

    test('lists each successful split-part proof and no combined total image', () => {
        const transaction = {
            _id: '64f123456789012345678901',
            customId: 'REF-2500',
            amount: 2500,
            vodafoneNumber: '01011112222',
            proofImage: 'proofs/should-not-be-a-total.jpg',
            proofImages: ['proofs/should-not-be-a-total.jpg'],
            executorSenderEntries: [
                {
                    partId: '1',
                    phone: '01108172258',
                    amount: 1000,
                    status: 'success',
                    customerProof: { key: 'tx:1', status: 'sent', imageId: 'proofs/part-1000.jpg' }
                },
                {
                    partId: '2',
                    phone: '01000926306',
                    amount: 1500,
                    status: 'failed',
                    customerProof: { key: 'tx:2', status: 'pending', imageId: null }
                },
                {
                    partId: '3',
                    phone: '01000926306',
                    amount: 1500,
                    status: 'success',
                    customerProof: { key: 'tx:3', status: 'sent', imageId: 'proofs/part-1500.jpg' }
                }
            ]
        };

        expect(getClientReceiptProofIds(transaction)).toEqual([
            'proofs/part-1000.jpg',
            'proofs/part-1500.jpg'
        ]);
        expect(buildClientReceiptImages(transaction).map((image) => image.label)).toEqual([
            'إثبات الجزء 1 — 1000 من 01108172258',
            'إثبات الجزء 3 — 1500 من 01000926306'
        ]);
        expect(JSON.stringify(buildClientReceiptImages(transaction))).not.toContain('should-not-be-a-total');
    });

    test('presents portal transactions with proxy URLs and without storage paths', () => {
        const presented = presentClientPortalTransaction({
            _id: '64f123456789012345678901',
            customId: 'OP-1001',
            proofImage: 'proofs/official.svg',
            proofImages: ['proofs/official.svg', 'proofs/extra.jpg'],
            executorProofImages: ['proofs/executor-private.jpg'],
            executorName: 'منفذ سري'
        });

        expect(presented.hasProof).toBe(true);
        expect(presented.proofImage).toBe('protected');
        expect(presented.receiptImages[0].url).toBe('/client/proxy/image/64f123456789012345678901/0');
        expect(presented.executorProofImages).toBeUndefined();
        expect(presented.executorName).toBeUndefined();
        expect(JSON.stringify(presented)).not.toContain('proofs/official.svg');
    });
});
