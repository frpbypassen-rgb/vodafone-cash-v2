'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const attack = '<img src="/xss-image" onerror="window.__executorXssHits += 1"><script>window.__executorXssHits += 1</script>';
const voiceBreakout = 'data:audio/wav"; onfocus="alert(1)" x="';

const loadReports = () => {
    const context = {
        isPersonalExecutorReport: false,
        formatEgp: (value) => String(value),
        bootstrap: { Modal: class { show() {} } },
        executorApiFetch: jest.fn(),
        setupVoiceRecorder: () => {},
        Swal: { fire: jest.fn() },
        window: { location: { origin: 'https://portal.example' }, downloadImages: jest.fn() },
        console
    };
    context.window.executorXssHits = 0;
    const elements = new Map();
    const makeElement = (id) => {
        const element = {
            id,
            innerHTML: '',
            textContent: '',
            style: {},
            dataset: {},
            classList: { add() {}, remove() {} },
            querySelectorAll: () => [],
            parentElement: { classList: { add() {} } }
        };
        if (id) elements.set(id, element);
        return element;
    };
    context.document = {
        getElementById: (id) => elements.get(id) || makeElement(id),
        createElement: () => makeElement()
    };
    vm.createContext(context);
    vm.runInContext(
        [
            fs.readFileSync(path.join(__dirname, '../public/js/executor/reports/rendering.js'), 'utf8'),
            fs.readFileSync(path.join(__dirname, '../public/js/executor/reports/operation-detail.js'), 'utf8')
        ].join('\n'),
        context
    );
    return { context, elements };
};

describe('executor report HTML escaping', () => {
    test('operation detail and table rows keep hostile transaction text as text', () => {
        const { context, elements } = loadReports();
        const tx = {
            id: 'tx-1',
            customId: attack,
            status: 'completed',
            amount: 250,
            transferTypeLabel: attack,
            createdAt: '2026-10-06T10:00:00.000Z',
            completedAt: '2026-10-06T10:05:00.000Z',
            executorName: attack,
            recipientNumber: attack,
            recipientName: attack,
            notes: attack,
            executorRatingNote: attack,
            voiceNote: voiceBreakout,
            receiptUrl: 'javascript:alert(1)',
            executorProofImageUrls: ['javascript:alert(1)'],
            executorSenderEntries: [{
                phone: attack,
                amount: 10,
                partId: attack,
                status: attack,
                customerProofStatus: attack,
                customerProofUrl: voiceBreakout,
                proofImageUrl: 'data:text/html,<script>alert(1)</script>'
            }]
        };

        context.openOperationDetail(tx);
        const detail = elements.get('detailModalBody').innerHTML;
        expect(detail).not.toContain('<img src="/xss-image"');
        expect(detail).not.toContain('<script>');
        expect(detail).not.toContain('javascript:');
        expect(detail).not.toContain('onfocus=');
        expect(detail).toContain('&lt;img');
        expect(elements.get('detailModalBody').querySelectorAll).toBeDefined();

        const row = context.buildRow(tx, 0);
        expect(row.innerHTML).not.toContain('<img src="/xss-image"');
        expect(row.innerHTML).toContain('&lt;img');
        const card = context.buildMobileCard(tx);
        expect(card.innerHTML).not.toContain('<script>');
        expect(card.innerHTML).toContain('&lt;img');
    });

    test('still renders a safe relative receipt and a valid voice note', () => {
        const { context, elements } = loadReports();
        const voice = 'data:audio/webm;base64,AAEC';
        context.openOperationDetail({
            id: 'tx-2',
            customId: 'C-2',
            status: 'accepted',
            amount: 100,
            createdAt: '2026-10-06T10:00:00.000Z',
            receiptUrl: '/executor-portal/proxy/image/tx-2/0',
            voiceNote: voice
        });
        const detail = elements.get('detailModalBody').innerHTML;
        expect(detail).toContain('href="/executor-portal/proxy/image/tx-2/0"');
        expect(detail).toContain(`src="${voice}"`);
    });
});
