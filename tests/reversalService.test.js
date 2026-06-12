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
        mockSession = {
            startTransaction: jest.fn(),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            abortTransaction: jest.fn().mockResolvedValue(undefined),
            endSession: jest.fn()
        };
        mongoose.startSession = jest.fn().mockResolvedValue(mockSession);
    });

    test('Should reverse transaction and refund user balances correctly', async () => {
        const result = await reversalService.reverseTransaction('tx-id-123', 'Customer request', 'Admin-Ali');

        expect(result.success).toBe(true);
        expect(result.message).toBe('تم إلغاء العملية واسترداد الرصيد بنجاح');

        expect(Transaction.findById).toHaveBeenCalledWith('tx-id-123');
        expect(User.findOne).toHaveBeenCalledWith({ phone: 'user-phone-123' });
        expect(mockUser.balances.EGP).toBe(1150); // 1000 + 150 cost
        expect(mockTx.status).toBe('rejected');
        expect(mockLedgerSave).toHaveBeenCalled();
        expect(mockEventSave).toHaveBeenCalled();
        expect(eventBus.publish).toHaveBeenCalledWith('transfer:cancelled', expect.any(Object));
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
