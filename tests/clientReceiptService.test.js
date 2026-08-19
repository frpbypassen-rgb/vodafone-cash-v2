'use strict';

const {
    buildClientReceiptImages,
    getClientReceiptProofIds
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
            label: 'صورة الإيصال 1',
            url: '/client/proxy/image/64f123456789012345678901/0'
        }]);
        expect(JSON.stringify(images)).not.toContain('telegram-file-id');
        expect(JSON.stringify(images)).not.toContain('local-receipt.svg');
    });

    test('returns no links when a transaction has no receipt', () => {
        expect(buildClientReceiptImages({ _id: '64f123456789012345678901' })).toEqual([]);
        expect(buildClientReceiptImages({ proofImage: 'proofs/receipt.svg' })).toEqual([]);
    });
});
