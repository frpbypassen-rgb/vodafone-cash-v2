'use strict';
const { normalizeFilters } = require('../services/retailReportsService');
const service = require('../services/retailReportsService'),
    mongoose = require('mongoose'),
    Transaction = require('../models/Transaction');
const { MongoMemoryServer } = require('mongodb-memory-server');
jest.setTimeout(120000);
test('default month and day boundaries follow Libya time independently of host timezone', () => {
    const now = new Date('2026-10-31T23:15:00Z');
    const month = normalizeFilters({}, now);
    expect(month.filters.dateValue).toBe('2026-11');
    expect(month.start.toISOString()).toBe('2026-10-31T22:00:00.000Z');
    const day = normalizeFilters({ dateType: 'day' }, now);
    expect(day.filters.dateValue).toBe('2026-11-01');
});
test('rejects invalid dates, excessive ranges and unknown filter values', () => {
    for (const q of [
        { dateType: 'day', dateValue: '2026-02-30' },
        { dateType: 'range', dateFrom: '2024-01-01', dateTo: '2026-01-01' },
        { status: '$ne' },
        { service: 'unknown' },
    ])
        expect(() => normalizeFilters(q)).toThrow();
});
describe('scoped summaries and bounded pagination', () => {
    let mongo, ctx, child, tenant;
    const now = new Date('2026-10-31T15:00:00Z');
    beforeAll(async () => {
        mongo = await MongoMemoryServer.create({
            binary: { version: '7.0.24' },
            instance: { launchTimeout: 60000 },
        });
        await mongoose.connect(mongo.getUri());
        tenant = new mongoose.Types.ObjectId();
        ctx = {
            actorModel: 'User',
            actor: { _id: new mongoose.Types.ObjectId(), phone: '0911222333', tenantId: tenant },
        };
        child = { actorModel: 'SubAccount', actor: { _id: new mongoose.Types.ObjectId(), tenantId: tenant } };
        const rows = Array.from({ length: 25 }, (_, i) => ({
            customId: 'REPORT-' + String(i).padStart(2, '0'),
            userId: ctx.actor.phone,
            tenantId: tenant,
            status: i === 0 ? 'pending' : 'completed',
            transferType: i % 2 ? 'bank_account' : 'vodafone',
            amount: 100,
            costLYD: 10,
            createdAt: new Date('2026-10-20T12:00:00Z'),
            accountNumber: '0012345',
            vodafoneNumber: i % 2 ? '' : '01012345678',
            apiResultData: { secret: 'NO_LEAK' },
        }));
        rows.push({
            customId: 'OTHER-TENANT',
            userId: ctx.actor.phone,
            tenantId: new mongoose.Types.ObjectId(),
            status: 'completed',
            transferType: 'vodafone',
            amount: 9999,
            costLYD: 9999,
            createdAt: now,
        });
        rows.push({
            customId: 'OTHER-OWNER',
            userId: 'another-user',
            tenantId: tenant,
            status: 'completed',
            transferType: 'vodafone',
            amount: 9999,
            costLYD: 9999,
            createdAt: now,
        });
        rows.push({
            customId: 'CHILD',
            subAccountId: child.actor._id,
            tenantId: tenant,
            status: 'completed',
            transferType: 'vodafone',
            amount: 100,
            costLYD: 10,
            agencyPricing: { customerChargeLYD: 30 },
            createdAt: now,
        });
        await Transaction.collection.insertMany(rows);
    });
    afterAll(async () => {
        await mongoose.disconnect();
        await mongo?.stop();
    });
    test('summary covers all matched rows while pages remain capped and deterministic', async () => {
        const first = await service.list(ctx, { dateType: 'month', dateValue: '2026-10' }, now);
        expect(first.summary).toEqual({
            count: 25,
            amounts: [{ currency: 'EGP', amount: 2500 }],
            completedCostLYD: 240,
        });
        expect(first.rows).toHaveLength(20);
        expect(first.nextCursor).toBeTruthy();
        expect(JSON.stringify(first)).not.toContain('NO_LEAK');
        await Transaction.collection.insertOne({
            customId: 'NEW-AFTER-SNAPSHOT',
            userId: ctx.actor.phone,
            tenantId: tenant,
            status: 'completed',
            transferType: 'vodafone',
            amount: 50,
            costLYD: 5,
            createdAt: new Date(now.getTime() + 1000),
        });
        const next = await service.list(
            ctx,
            { dateType: 'month', dateValue: '2026-10', cursor: first.nextCursor, asOf: first.asOf },
            new Date(now.getTime() + 2000)
        );
        expect(next.rows).toHaveLength(5);
        expect(next.nextCursor).toBeNull();
        expect(next.summary.count).toBe(25);
        expect(new Set([...first.rows, ...next.rows].map((x) => x.id)).size).toBe(25);
    });
    test('filters change summary and search treats regex characters literally', async () => {
        const result = await service.list(
            ctx,
            { dateType: 'month', dateValue: '2026-10', service: 'bank_account', status: 'completed' },
            now
        );
        expect(result.summary.count).toBe(12);
        expect(result.summary.completedCostLYD).toBe(120);
        expect(result.rows[0].recipient).toBe('0012345');
        const literal = await service.list(
            ctx,
            { dateType: 'month', dateValue: '2026-10', search: '.*' },
            now
        );
        expect(literal.summary.count).toBe(0);
    });
    test('subordinate summaries use customer charges and cannot include parent rows', async () => {
        const result = await service.list(child, { dateType: 'month', dateValue: '2026-10' }, now);
        expect(result.summary.count).toBe(1);
        expect(result.summary.completedCostLYD).toBe(30);
        expect(result.rows[0].costLYD).toBe(30);
    });
});
