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
const {
    ManualExecutionNumberError,
    maskManualExecutionNumber,
    tripoliDateTimeParts,
    generateManualExecutorReceiptBase64
} = require('../utils/manualExecutorReceipt');
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
            expect.objectContaining({ upsert: true, new: true })
        );
    });
});
