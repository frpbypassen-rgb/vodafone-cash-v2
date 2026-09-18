'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));
jest.mock('../models/OpsInternalNote');
jest.mock('../models/OpsWatchTask', () => ({
    colorFor: jest.fn().mockReturnValue('#2563eb'),
    find: jest.fn(),
    findOne: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn()
}));
jest.mock('../models/Admin');
jest.mock('../models/Transaction');
jest.mock('../services/auditService', () => ({
    logAction: jest.fn().mockResolvedValue(undefined)
}));

const mongoose = require('mongoose');
const OpsInternalNote = require('../models/OpsInternalNote');
const OpsWatchTask = require('../models/OpsWatchTask');
const Admin = require('../models/Admin');
const Transaction = require('../models/Transaction');
const { logAction } = require('../services/auditService');
const {
    addNote,
    assignTask,
    listNotes,
    resolveTask
} = require('../services/opsCollaborationService');

const TX_ID = '64b0000000000000000000bb';
const TASK_ID = '64b0000000000000000000cc';
const req = () => ({
    session: { adminId: '64b0000000000000000000aa', adminName: 'مشرف العمليات' },
    tenantId: null
});

describe('ops collaboration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Transaction.findOne.mockReturnValue({
            select: () => ({
                lean: () => Promise.resolve({ _id: TX_ID, customId: 'ATT-9', tenantId: null })
            })
        });
    });

    test('rejects an empty note and caps stored body length', async () => {
        await expect(addNote(req(), TX_ID, '   ')).rejects.toMatchObject({ status: 400 });
        expect(OpsInternalNote.create).not.toHaveBeenCalled();

        OpsInternalNote.create.mockResolvedValue({
            _id: 'note-1',
            body: 'x'.repeat(1000),
            authorName: 'مشرف العمليات',
            createdAt: new Date()
        });
        await addNote(req(), TX_ID, `${'x'.repeat(1200)}extra`);
        expect(OpsInternalNote.create).toHaveBeenCalledWith(expect.objectContaining({
            body: 'x'.repeat(1000),
            authorName: 'مشرف العمليات',
            transactionId: TX_ID
        }));
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'OPS_INTERNAL_NOTE',
            metadata: expect.objectContaining({ reference: 'ATT-9' })
        }));
    });

    test('returns null notes when the transaction is outside tenant scope', async () => {
        Transaction.findOne.mockReturnValue({
            select: () => ({ lean: () => Promise.resolve(null) })
        });
        await expect(listNotes(req(), TX_ID)).resolves.toBeNull();
        await expect(addNote(req(), 'not-an-id', 'hello')).resolves.toBeNull();
    });

    test('assigns a watch task, closes previous open tasks, and records the actor', async () => {
        OpsWatchTask.updateMany.mockResolvedValue({ modifiedCount: 1 });
        OpsWatchTask.colorFor = jest.fn().mockReturnValue('#2563eb');
        OpsWatchTask.create.mockResolvedValue({
            _id: TASK_ID,
            assigneeName: 'مشرف العمليات',
            status: 'open'
        });
        Admin.findOne.mockReturnValue({
            select: () => ({ lean: () => Promise.resolve(null) })
        });

        const task = await assignTask(req(), TX_ID, { reason: 'burst' });
        expect(OpsWatchTask.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ transactionId: TX_ID, status: 'open' }),
            expect.objectContaining({ $set: expect.objectContaining({ status: 'resolved' }) })
        );
        expect(OpsWatchTask.create).toHaveBeenCalledWith(expect.objectContaining({
            status: 'open',
            reason: 'burst',
            assigneeName: 'مشرف العمليات',
            createdByName: 'مشرف العمليات'
        }));
        expect(task.status).toBe('open');
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'OPS_WATCH_TASK_ASSIGNED'
        }));
    });

    test('resolves an open task with who/when audit fields', async () => {
        const task = {
            _id: TASK_ID,
            transactionId: TX_ID,
            status: 'open',
            save: jest.fn().mockResolvedValue(undefined)
        };
        OpsWatchTask.findOne.mockResolvedValue(task);

        const resolved = await resolveTask(req(), TASK_ID);
        expect(resolved.status).toBe('resolved');
        expect(resolved.resolvedByName).toBe('مشرف العمليات');
        expect(resolved.resolvedAt).toBeInstanceOf(Date);
        expect(task.save).toHaveBeenCalled();
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'OPS_WATCH_TASK_RESOLVED'
        }));
    });

    test('ignores invalid task ids', async () => {
        await expect(resolveTask(req(), 'nope')).resolves.toBeNull();
        expect(OpsWatchTask.findOne).not.toHaveBeenCalled();
        expect(mongoose.isValidObjectId(TX_ID)).toBe(true);
    });
});
