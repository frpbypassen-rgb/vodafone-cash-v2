'use strict';
const { formatOperation, mount } = require('../public/js/admin-operation-copy');
test('copies sender names, destination and requested amount without financial internals', () => {
    const text = formatOperation({
        companyName: 'شركة النور',
        employeeName: 'أحمد',
        vodafoneNumber: '01001234567',
        amount: 1250,
        costLYD: 99,
        apiToken: 'secret',
    });
    expect(text).toBe(
        'الجهة المرسلة: شركة النور — أحمد\nرقم الحساب / الهاتف: 01001234567\nالمبلغ: 1,250.00 EGP'
    );
    expect(text).not.toContain('99');
    expect(text).not.toContain('secret');
});
test('bank destinations take priority over legacy phone fields and names are deduplicated', () => {
    const text = formatOperation({
        companyName: 'أحمد',
        employeeName: 'أحمد',
        transferType: 'bank_account',
        accountNumber: '001234567',
        vodafoneNumber: '01000000000',
        amount: 50,
    });
    expect(text).toContain('رقم الحساب / الهاتف: 001234567');
    expect(text.match(/أحمد/g)).toHaveLength(1);
});
test('internal balances use LYD precision and missing data is explicit', () => {
    expect(
        formatOperation({ transferType: 'balance_transfer', accountNumber: '10482', amount: 12.345 })
    ).toContain('12.345 LYD');
    expect(formatOperation({})).toContain('المبلغ: غير مسجل');
});
test('delegated copy reads the latest row snapshot after live refresh', async () => {
    jest.useFakeTimers();
    let onClick,
        rows = { one: { companyName: 'الأولى', amount: 10, accountNumber: '0001' } };
    const notice = { setAttribute: jest.fn() };
    const doc = {
        createElement: () => notice,
        body: { append: jest.fn() },
        addEventListener: (_name, fn) => {
            onClick = fn;
        },
        getElementById: () => ({ textContent: JSON.stringify(rows) }),
    };
    const clipboard = { writeText: jest.fn().mockResolvedValue() };
    mount(doc, { clipboard });
    const button = { dataset: { copyOperation: 'one' }, disabled: false };
    const event = {
        target: { closest: () => button },
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
    };
    await onClick(event);
    rows = { one: { companyName: 'المحدثة', amount: 20, accountNumber: '0002' } };
    await onClick(event);
    expect(clipboard.writeText.mock.calls[1][0]).toContain('المحدثة');
    expect(clipboard.writeText.mock.calls[1][0]).toContain('0002');
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
});
