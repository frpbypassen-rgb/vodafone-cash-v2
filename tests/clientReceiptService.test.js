'use strict';

const {
    buildClientReceiptImages,
    getClientReceiptProofIds
} = require('../services/clientReceiptService');

describe('clientReceiptService', () => {
    test('deduplicates receipt proofs while preserving their order', () => {
        const transaction = {
            proofImages: ['proofs/first.svg', '', 'proofs/second.jpg'],
            proofImage: 'proofs/first.svg'
        };

        expect(getClientReceiptProofIds(transaction)).toEqual([
            'proofs/first.svg',
            'proofs/second.jpg'
        ]);
    });

    test('builds authenticated client proxy links without exposing proof identifiers', () => {
        const images = buildClientReceiptImages({
            _id: '64f123456789012345678901',
            proofImages: ['telegram-file-id', 'proofs/local-receipt.svg']
        });

        expect(images).toEqual([
            {
                index: 0,
                label: 'صورة الإيصال 1',
                url: '/client/proxy/image/64f123456789012345678901/0'
            },
            {
                index: 1,
                label: 'صورة الإيصال 2',
                url: '/client/proxy/image/64f123456789012345678901/1'
            }
        ]);
        expect(JSON.stringify(images)).not.toContain('telegram-file-id');
        expect(JSON.stringify(images)).not.toContain('local-receipt.svg');
    });

    test('returns no links when a transaction has no receipt', () => {
        expect(buildClientReceiptImages({ _id: '64f123456789012345678901' })).toEqual([]);
        expect(buildClientReceiptImages({ proofImage: 'proofs/receipt.svg' })).toEqual([]);
    });
});
