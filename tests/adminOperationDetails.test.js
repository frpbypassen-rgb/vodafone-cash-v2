'use strict';

const details = require('../public/js/admin-operation-details');

const pendingCash = {
    _id: 'tx1',
    customId: 'ATT-DEMO-0002',
    status: 'pending',
    transferType: 'vodafone',
    companyName: 'شركة النور للصرافة (تجريبي)',
    employeeName: 'المدير الأساسي',
    amount: 1610,
    costLYD: 264.72,
    exchangeRate: 6.08,
    vodafoneNumber: '01049285278',
    executorName: '---',
    createdAt: '2026-09-19T14:42:51.000Z'
};

const inProgress = {
    ...pendingCash,
    status: 'accepted',
    executorName: 'أحمد المنفذ',
    assignedExecutorName: 'أحمد المنفذ',
    assignedExecutorAt: '2026-09-19T14:50:00.000Z',
    updatedAt: '2026-09-19T14:50:00.000Z'
};

const completed = {
    ...inProgress,
    status: 'completed',
    proofImage: 'proofs/official.png',
    executorProofImages: ['proofs/exec.png'],
    completedAt: '2026-09-19T15:10:00.000Z',
    updatedAt: '2026-09-19T15:10:00.000Z',
    customerNotes: 'الرقم المرجعي REF-99'
};

describe('admin comprehensive operation details', () => {
    test('replaces silent dashes with Arabic empty labels', () => {
        expect(details.displayValue('---')).toBe('لا يوجد');
        expect(details.displayValue('', 'unassigned')).toBe('لم يُعيَّن بعد');
        expect(details.displayValue('---', 'unassigned')).toBe('لم يُعيَّن بعد');
        expect(details.executorDisplayName(pendingCash)).toBe('لم يُعيَّن بعد');
        expect(details.displayValue('شركة النور')).toBe('شركة النور');
    });

    test('builds a short Arabic summary and pending missing-step chips', () => {
        const summary = details.humanSummary(pendingCash);
        expect(summary).toContain('فودافون كاش');
        expect(details.typeLabel({
            transferType: 'bank_account',
            accountNumber: 'EG380019000500000000263180002',
            vodafoneNumber: '01000000000'
        })).toBe('تحويل بنكي');
        const bankModel = details.buildViewModel({
            ...pendingCash,
            transferType: 'bank_account',
            vodafoneNumber: '',
            accountNumber: 'EG380019000500000000263180002'
        }, { noteView: { customerText: '', systemText: '' } });
        expect(details.renderSummaryPane(bankModel)).toContain('تحويل بنكي');
        expect(details.renderSummaryPane(bankModel)).toContain('EG380019000500000000263180002');
        expect(summary).toContain('شركة النور للصرافة (تجريبي)');
        expect(summary).toContain('بانتظار التنفيذ');
        expect(summary).not.toContain('---');

        const missing = details.missingItems(pendingCash, []);
        expect(missing.map((item) => item.label)).toEqual(['تعيين منفّذ', 'قبول', 'إثبات']);
        expect(details.missingItems(completed, details.collectProofs(completed))).toEqual([]);
    });

    test('emphasizes proofs for successful ops and executor for in-progress ops', () => {
        const pendingModel = details.buildViewModel(pendingCash, { noteView: { customerText: '', systemText: '' } });
        expect(pendingModel.tone).toBe('pending');
        expect(pendingModel.defaultTab).toBe('summary');
        expect(pendingModel.missingItems.length).toBeGreaterThan(0);

        const progressModel = details.buildViewModel(inProgress, { noteView: { customerText: '', systemText: '' } });
        expect(progressModel.tone).toBe('progress');
        expect(progressModel.executor).toBe('أحمد المنفذ');
        expect(progressModel.emphasis).toContain('أحمد المنفذ');

        const doneModel = details.buildViewModel(completed, { noteView: { customerText: completed.customerNotes, systemText: '' } });
        expect(doneModel.tone).toBe('success');
        expect(doneModel.defaultTab).toBe('proofs');
        expect(doneModel.proofs).toHaveLength(2);
        expect(doneModel.proofs[0].url).toBe('/proxy/image/tx1/0');
        expect(doneModel.proofs[1].url).toBe('/proxy/image/tx1/1');
        expect(details.renderProofsPane(doneModel)).toContain('data-od-lightbox');
        expect(doneModel.notes.reference).toBe('REF-99');
        expect(details.renderProofsPane(pendingModel)).toContain('لم يتم إرفاق إثبات تنفيذ بعد');
        expect(details.renderHeaderMeta(pendingModel)).not.toContain('---');
    });

    test('timeline includes actors, timestamps, and wait duration when computable', () => {
        const events = details.buildTimeline(completed, (value) => String(value));
        expect(events[0].title).toBe('إنشاء الطلب');
        expect(events.some((event) => event.title === 'الإكمال النهائي')).toBe(true);
        const completedEvent = events.find((event) => event.key === 'completed');
        expect(completedEvent.actor).toBe('أحمد المنفذ');
        expect(completedEvent.waitFromPrevious).toMatch(/د|س|ي|أقل من دقيقة/);

        const pendingEvents = details.buildTimeline(pendingCash, (value) => String(value));
        expect(pendingEvents.some((event) => event.key === 'waiting')).toBe(true);
        expect(pendingEvents[pendingEvents.length - 1].waitFromPrevious).toBeTruthy();
        expect(JSON.stringify(pendingEvents)).not.toContain('---');
    });

    test('finance rows use green/red semantics from existing amount and cost fields', () => {
        const rows = details.financeRows(pendingCash, [{ type: 'خصم', description: 'تكلفة العملية', amount: -264.72 }]);
        expect(rows[0]).toMatchObject({ label: 'المبلغ', tone: 'pos' });
        expect(rows.find((row) => row.label === 'التكلفة').tone).toBe('neg');
        expect(rows.find((row) => row.label.includes('خصم')).tone).toBe('neg');
    });
});
