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
