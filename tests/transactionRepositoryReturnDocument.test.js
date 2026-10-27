'use strict';
jest.mock('../models/Transaction', () => {
    const Model = jest.fn(function (data) {
        Object.assign(this, data);
        this.save = jest.fn().mockResolvedValue(this);
    });
    Model.findOneAndUpdate = jest.fn();
    return Model;
});
jest.mock('../models/Counter', () => ({ findOneAndUpdate: jest.fn() }));
const Transaction = require('../models/Transaction');
const Counter = require('../models/Counter');
const repository = require('../repositories/transactionRepository');
beforeEach(() => jest.clearAllMocks());
test('invoice allocation retains upsert, session and the incremented counter result', async () => {
    const session = { id: 'session' };
    Counter.findOneAndUpdate.mockResolvedValue({ value: 7 });
    const tx = await repository.create({ amount: 25 }, session);
    const id = tx.customId;
    expect(tx.save).toHaveBeenCalledWith({ session });
    expect(id).toMatch(/^ATT-\d{4}-0007$/);
    expect(Counter.findOneAndUpdate).toHaveBeenCalledWith(
        { name: 'transaction' },
        { $inc: { value: 1 } },
        { upsert: true, returnDocument: 'after', session },
    );
});
test('status update returns the resulting transaction and keeps its session', async () => {
    const session = { id: 'session' },
        updated = { _id: 'tx', status: 'completed' };
    Transaction.findOneAndUpdate.mockResolvedValue(updated);
    await expect(
        repository.updateStatus(
            'tx',
            'completed',
            { executorName: 'operator' },
            session,
        ),
    ).resolves.toBe(updated);
    expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'tx' },
        { $set: { status: 'completed', executorName: 'operator' } },
        { returnDocument: 'after', session },
    );
});
test('task acceptance retains the atomic processing-status ownership guard', async () => {
    Transaction.findOneAndUpdate.mockResolvedValue(null);
    await expect(
        repository.acceptTask('tx', 'operator', 'name'),
    ).resolves.toBeNull();
    expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'tx', status: 'processing' },
        expect.objectContaining({
            $set: expect.objectContaining({
                status: 'accepted',
                operatorId: 'operator',
            }),
        }),
        { returnDocument: 'after' },
    );
});
