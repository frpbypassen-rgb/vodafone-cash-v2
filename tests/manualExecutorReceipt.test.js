'use strict';

jest.mock('../models/Counter', () => ({
    findOneAndUpdate: jest.fn()
}));
jest.mock('../models/ExecutorGroup', () => ({
    exists: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findById: jest.fn()
}));

const Counter = require('../models/Counter');
const ExecutorGroup = require('../models/ExecutorGroup');
const { createCanvas } = require('canvas');
const {
    ManualExecutionNumberError,
    maskManualExecutionNumber,
    tripoliDateTimeParts,
    generateManualExecutorReceiptBase64
} = require('../utils/manualExecutorReceipt');
const { generateReceiptBase64 } = require('../utils/receiptGenerator');
const {
    reserveManualExecutorReceiptPrefix,
    reserveManualExecutorReceiptReference
} = require('../services/manualExecutorReceiptReferenceService');

describe('Manual executor receipt data', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test.each([
        ['01108172258', '011****2258'],
        ['899', '01******899'],
        ['2258', '01*****2258']
    ])('masks execution number %s as %s', (input, expected) => {
        expect(maskManualExecutionNumber(input)).toBe(expected);
    });

    test('rejects unsupported execution number formats', () => {
        expect(() => maskManualExecutionNumber('12345')).toThrow(ManualExecutionNumberError);
    });

    test('formats receipt date and time in Libya time', () => {
        expect(tripoliDateTimeParts(new Date('2026-08-08T12:32:55.000Z'))).toEqual({
            date: '2026/08/08',
            time: '02:32:55 م'
        });
    });

    test('generates a JPEG receipt with the supplied client and execution details', async () => {
        const image = await generateManualExecutorReceiptBase64({
            customerPhone: '01108172258',
            executionNumber: '011****2258',
            amount: 1600,
            customId: 'ATT-2608-0142',
            executorReference: '999001',
            completedAt: new Date('2026-08-08T12:32:55.000Z')
        });

        expect(image).toMatch(/^data:image\/jpeg;base64,/);
        expect(Buffer.from(image.split(',')[1], 'base64').length).toBeGreaterThan(1000);
    });

    test('prints the official support phone in the footer and the part wallet in its own field', async () => {
        const previousDisplay = process.env.BRAND_PHONE_DISPLAY;
        const previousTel = process.env.BRAND_PHONE_TEL;
        delete process.env.BRAND_PHONE_DISPLAY;
        delete process.env.BRAND_PHONE_TEL;
        const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d'));
        const original = proto.fillText;
        const drawn = [];
        proto.fillText = function fillText(text, ...rest) {
            drawn.push(String(text));
            return original.call(this, text, ...rest);
        };
        try {
            const partWallet = '01108172258';
            const image = await generateManualExecutorReceiptBase64({
                customerPhone: '01055550099',
                executionNumber: partWallet,
                executionNumberLabel: 'المحفظة المرسلة',
                amount: 1000,
                customId: 'TEST-REF-2500',
                executorReference: 'TEST-REF-2500:1',
                executionReferenceLabel: 'المرجع والجزء',
                completedAt: new Date('2026-09-26T09:15:00.000Z'),
                status: 'completed'
            });
            const legacy = await generateReceiptBase64({
                walletNumber: '01055550099',
                amount: 1000,
                customId: 'TEST-REF-2500',
                referenceNumber: 'TEST-REF-2500:1',
                date: '2026/09/26'
            });

            const supportAt = drawn.indexOf('الدعم الفني واتساب فقط');
            expect(supportAt).toBeGreaterThan(-1);
            expect(drawn[supportAt + 1]).toBe('0913731533');
            expect(drawn).toContain(partWallet);
            expect(drawn.filter((text) => text === '0913731533').length).toBeGreaterThanOrEqual(2);
            expect(partWallet).not.toBe('0913731533');
            expect(image).toMatch(/^data:image\/jpeg;base64,/);
            expect(legacy).toMatch(/^data:image\/jpeg;base64,/);
        } finally {
            proto.fillText = original;
            if (previousDisplay === undefined) delete process.env.BRAND_PHONE_DISPLAY;
            else process.env.BRAND_PHONE_DISPLAY = previousDisplay;
            if (previousTel === undefined) delete process.env.BRAND_PHONE_TEL;
            else process.env.BRAND_PHONE_TEL = previousTel;
        }
    });

    test('generates the same receipt layout for a cancelled operation', async () => {
        const image = await generateManualExecutorReceiptBase64({
            status: 'cancelled',
            customerPhone: '01108172258',
            amount: 1600,
            customId: 'ATT-2608-0142',
            cancellationNumber: 'CAN-2608-00001',
            cancellationReason: 'الرقم غير صحيح',
            cancelledAt: new Date('2026-08-08T12:32:55.000Z')
        });

        expect(image).toMatch(/^data:image\/jpeg;base64,/);
        expect(Buffer.from(image.split(',')[1], 'base64').length).toBeGreaterThan(1000);
    });
});

describe('Manual executor receipt references', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('allocates an unused three-digit prefix for a new manual executor', async () => {
        Counter.findOneAndUpdate.mockResolvedValue({ value: 1 });
        ExecutorGroup.exists.mockResolvedValue(false);

        await expect(reserveManualExecutorReceiptPrefix()).resolves.toBe('100');
    });

    test('uses the executor prefix and an atomic counter for sequential references', async () => {
        Counter.findOneAndUpdate
            .mockResolvedValueOnce({ value: 1 })
            .mockResolvedValueOnce({ value: 2 });
        const group = { _id: 'group-1', manualReceiptPrefix: '999' };

        await expect(reserveManualExecutorReceiptReference({ group })).resolves.toMatchObject({ reference: '999001' });
        await expect(reserveManualExecutorReceiptReference({ group })).resolves.toMatchObject({ reference: '999002' });
        expect(Counter.findOneAndUpdate).toHaveBeenLastCalledWith(
            { name: 'manual-executor-receipt-sequence:group-1' },
            { $inc: { value: 1 } },
            expect.objectContaining({ upsert: true, returnDocument: 'after' })
        );
    });
});
