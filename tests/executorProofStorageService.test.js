'use strict';

jest.mock('../utils/manualExecutorReceipt', () => ({
    generateManualExecutorReceiptBase64: jest.fn()
}));

const fs = require('fs');
const path = require('path');
const { generateManualExecutorReceiptBase64 } = require('../utils/manualExecutorReceipt');
const {
    MAX_PROOF_IMAGES,
    getProofImages,
    saveProofImageBase64,
    generateManualExecutorReceiptProof,
    saveProviderReceiptProof
} = require('../services/executorProofStorageService');
const PNG_DATA_URL = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'instapay_logo.png')).toString('base64')}`;
const JPEG_DATA_URL = `data:image/jpeg;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'login-otp-logo.jpg')).toString('base64')}`;

describe('Executor proof storage boundaries', () => {
    beforeEach(() => {
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    });

    afterEach(() => jest.restoreAllMocks());

    test.each([
        ['jpeg', JPEG_DATA_URL, 'jpg'],
        ['jpg', JPEG_DATA_URL.replace('image/jpeg', 'image/jpg'), 'jpg'],
        ['png', PNG_DATA_URL, 'png']
    ])('accepts bounded %s uploads', (_mime, dataUrl, extension) => {
        const [proof] = getProofImages({ imageBase64: dataUrl });
        expect(proof.buffer.length).toBeGreaterThan(0);
        expect(proof.extension).toBe(extension);
    });

    test.each(['data:image/svg+xml;base64,AAEC', 'data:image/png;base64,', 'data:image/png;base64,!!!!', {}, null])(
        'rejects invalid data without writing a file: %p', (value) => {
            expect(() => getProofImages({ imagesBase64: [value] })).toThrow('INVALID_PROOF_IMAGE');
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        }
    );

    test('rejects more than five uploads before decoding', () => {
        const decode = jest.spyOn(Buffer, 'from');
        expect(() => getProofImages({ imagesBase64: Array(MAX_PROOF_IMAGES + 1).fill('invalid') })).toThrow('TOO_MANY_PROOFS');
        expect(decode).not.toHaveBeenCalled();
    });

    test('rejects excessive encoded input before allocating its decoded buffer', () => {
        const encoded = 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 4);
        const decode = jest.spyOn(Buffer, 'from');
        expect(() => getProofImages({ imageBase64: `data:image/png;base64,${encoded}` })).toThrow('INVALID_PROOF_IMAGE');
        expect(decode).not.toHaveBeenCalled();
    });

    test('rejects malformed content even when it is within the byte boundary', () => {
        const valid = Buffer.alloc(8 * 1024 * 1024).toString('base64');
        expect(() => getProofImages({ imageBase64: `data:image/png;base64,${valid}` })).toThrow('INVALID_PROOF_IMAGE');
        const oversized = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
        expect(() => getProofImages({ imageBase64: `data:image/png;base64,${oversized}` })).toThrow('INVALID_PROOF_IMAGE');
    });

    test('rejects a large malformed payload without regex stack overflow or decoding', () => {
        const encoded = 'A'.repeat(8 * 1024 * 1024) + '!';
        const decode = jest.spyOn(Buffer, 'from');
        expect(() => getProofImages({ imageBase64: `data:image/png;base64,${encoded}` })).toThrow('INVALID_PROOF_IMAGE');
        expect(decode).not.toHaveBeenCalled();
    });

    test('does not allow a transaction identifier to escape the proofs directory', () => {
        const proofsDir = path.resolve('uploads', 'proofs');
        const savedPaths = [];
        const fileName = saveProofImageBase64({
            tx: { customId: '../../outside', _id: 'tx-1' }, proofsDir, savedPaths,
            imageBase64: PNG_DATA_URL, suffix: 'sender_1'
        });
        expect(path.dirname(savedPaths[0])).toBe(proofsDir);
        expect(fileName).not.toMatch(/[\/\\]/);
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    });

    test('rejects an invalid generated receipt before saving a proof', async () => {
        generateManualExecutorReceiptBase64.mockResolvedValueOnce('data:image/jpeg;base64,');
        await expect(generateManualExecutorReceiptProof({
            tx: { _id: 'tx-1', amount: 100 }, proofsDir: path.resolve('uploads', 'proofs'), savedPaths: []
        })).rejects.toThrow('AUTO_RECEIPT_GENERATION_FAILED');
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('rejects an invalid provider receipt before creating a local settlement proof', () => {
        expect(() => saveProviderReceiptProof({ tx: { _id: 'tx-1' }, receiptBase64: '' })).toThrow('INVALID_PROOF_IMAGE');
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
});
