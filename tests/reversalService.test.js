'use strict';

const mockTx = {
    _id: 'tx-id-123',
    customId: 'ATT-2605-0010',
    userId: 'user-phone-123',
    costLYD: 150,
    status: 'completed',
    notes: '',
    save: jest.fn().mockResolvedValue(true)
};

const mockUser = {
    _id: 'user-id-123',
    balances: {
        EGP: 1000
    },
    save: jest.fn().mockResolvedValue(true)
};

const mockLastEvent = {
    sequenceNumber: 2
};

const mockCounterFindOneAndUpdate = jest.fn().mockResolvedValue({ value: 7 });

// mock dependencies
jest.mock('../src/Domain/Entities/Transaction', () => ({
    findById: jest.fn().mockReturnValue({
        session: jest.fn().mockResolvedValue(mockTx)
    })
}));

jest.mock('../src/Domain/Entities/User', () => ({
    findOne: jest.fn().mockReturnValue({
        session: jest.fn().mockResolvedValue(mockUser)
    })
}));

const mockLedgerSave = jest.fn().mockResolvedValue(true);
jest.mock('../src/Domain/Entities/Ledger', () => {
    const M = jest.fn().mockImplementation(() => ({
        save: mockLedgerSave
    }));
    return M;
});

const mockEventSave = jest.fn().mockResolvedValue(true);
jest.mock('../src/Domain/Entities/JournalEvent', () => {
    const M = jest.fn().mockImplementation(() => ({
        save: mockEventSave
    }));
    M.findOne = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
            session: jest.fn().mockResolvedValue(mockLastEvent)
        })
    });
    return M;
});

jest.mock('../services/eventBus', () => ({
    publish: jest.fn()
}));

jest.mock('../models/Counter', () => ({
    findOneAndUpdate: (...args) => mockCounterFindOneAndUpdate(...args)
}));

const Transaction = require('../src/Domain/Entities/Transaction');
const User = require('../src/Domain/Entities/User');
const Ledger = require('../src/Domain/Entities/Ledger');
const JournalEvent = require('../src/Domain/Entities/JournalEvent');
const eventBus = require('../services/eventBus');
const mongoose = require('mongoose');
const { reversalService } = require('../src/Application/Services/ReversalService');

describe('Reversal Service Tests', () => {
    let mockSession;

    beforeEach(() => {
        jest.clearAllMocks();
        mockTx.status = 'completed';
        mockTx.notes = '';
        mockTx.cancellationNumber = undefined;
        mockTx.cancellationReason = undefined;
        mockTx.cancelledBy = undefined;
        mockTx.cancelledAt = undefined;
        mockUser.balances.EGP = 1000;
        mockCounterFindOneAndUpdate.mockResolvedValue({ value: 7 });
        mockSession = {
            startTransaction: jest.fn(),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            abortTransaction: jest.fn().mockResolvedValue(undefined),
            endSession: jest.fn()
        };
        mongoose.startSession = jest.fn().mockResolvedValue(mockSession);
    });

    test('Should reverse transaction and refund user balances correctly', async () => {
        const now = new Date();
        const expectedPeriod = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
        const expectedCancellationNumber = `CAN-${expectedPeriod}-00007`;
        const result = await reversalService.reverseTransaction('tx-id-123', 'Customer request', 'Admin-Ali');

        expect(result.success).toBe(true);
        expect(result.cancellationNumber).toBe(expectedCancellationNumber);
        expect(result.message).toBe('تم إلغاء العملية واسترداد الرصيد بنجاح');

        expect(Transaction.findById).toHaveBeenCalledWith('tx-id-123');
        expect(User.findOne).toHaveBeenCalledWith({ phone: 'user-phone-123' });
        expect(mockUser.balances.EGP).toBe(1150); // 1000 + 150 cost
        expect(mockTx.status).toBe('cancelled_by_admin');
        expect(mockTx.cancellationNumber).toBe(expectedCancellationNumber);
        expect(mockTx.cancellationReason).toBe('Customer request');
        expect(mockTx.cancelledBy).toBe('Admin-Ali');
        expect(mockTx.cancelledAt).toBeInstanceOf(Date);
        expect(mockCounterFindOneAndUpdate).toHaveBeenCalledWith(
            { name: `cancellation-${expectedPeriod}` },
            { $inc: { value: 1 } },
            { upsert: true, new: true, setDefaultsOnInsert: true, session: mockSession }
        );
        expect(mockLedgerSave).toHaveBeenCalled();
        expect(mockEventSave).toHaveBeenCalled();
        expect(eventBus.publish).toHaveBeenCalledWith(
            'transfer:cancelled',
            expect.objectContaining({ cancellationNumber: expectedCancellationNumber })
        );
    });

    test('Should fail if transaction is not found', async () => {
        Transaction.findById.mockReturnValueOnce({
            session: jest.fn().mockResolvedValue(null)
        });

        const result = await reversalService.reverseTransaction('tx-id-invalid', 'Test reason', 'Admin');
        expect(result.success).toBe(false);
        expect(result.message).toBe('العملية غير موجودة');
    });

    test('Should fail if transaction status is not completed/accepted/pending/processing', async () => {
        const rejectedTx = { ...mockTx, status: 'rejected' };
        Transaction.findById.mockReturnValueOnce({
            session: jest.fn().mockResolvedValue(rejectedTx)
        });

        const result = await reversalService.reverseTransaction('tx-id-123', 'Test reason', 'Admin');
        expect(result.success).toBe(false);
        expect(result.message).toBe('حالة العملية لا تسمح بالإلغاء والاسترجاع');
    });
});
