'use strict';

jest.mock('../src/Infrastructure/ResalaClient.ts', () => ({
    sendResalaTemplate: jest.fn(),
    sendResalaPin: jest.fn(),
}));

const { sendResalaPin, sendResalaTemplate } = require('../src/Infrastructure/ResalaClient.ts');
const { sendPin } = require('../services/smsLoginTransport');
const phone = '218940001234';
const approved = {
    is_prod: true,
    succeeded: 1,
    failed: 0,
    failed_numbers: [],
    invalid_numbers: [],
    sms_template_version: { status: 'APPROVED', body: 'أهرام باي | رمز الدخول\n$1' },
};
const originalTemplate = process.env.RESALA_SMS_TEMPLATE_ID;
const originalSender = process.env.RESALA_SMS_SENDER;

beforeEach(() => {
    jest.resetAllMocks();
    process.env.RESALA_SMS_TEMPLATE_ID = 'configured-otp-template';
    process.env.RESALA_SMS_SENDER = 'TestBrand';
});

afterEach(() => {
    if (originalTemplate === undefined) delete process.env.RESALA_SMS_TEMPLATE_ID;
    else process.env.RESALA_SMS_TEMPLATE_ID = originalTemplate;
    if (originalSender === undefined) delete process.env.RESALA_SMS_SENDER;
    else process.env.RESALA_SMS_SENDER = originalSender;
});

test('the configured Resala template receives the exact login PIN in $1 for the registered recipient', async () => {
    sendResalaTemplate.mockResolvedValue(approved);
    const pin = await sendPin('0940001234');
    expect(pin).toMatch(/^[0-9]{6}$/);
    expect(sendResalaTemplate).toHaveBeenCalledTimes(1);
    expect(sendResalaTemplate).toHaveBeenCalledWith(
        'configured-otp-template', [{ phone, $1: pin }], { sender: 'TestBrand', test: false }
    );
    expect(sendResalaPin).not.toHaveBeenCalled();
});

test('test mode exercises the same template with no production send', async () => {
    sendResalaTemplate.mockResolvedValue({ ...approved, is_prod: false });
    const pin = await sendPin(phone, { test: true });
    expect(sendResalaTemplate).toHaveBeenCalledTimes(1);
    expect(sendResalaTemplate).toHaveBeenCalledWith(
        'configured-otp-template', [{ phone, $1: pin }], { sender: 'TestBrand', test: true }
    );
});

test.each([
    { queued: true },
    { is_prod: false },
    { succeeded: 0 },
    { failed: 1 },
    { invalid_numbers: [phone] },
    { sms_template_version: { status: 'PENDING' } },
])('a nonaccepted or nonproduction template send fails closed without fallback (%j)', async (override) => {
    sendResalaTemplate.mockResolvedValue({ ...approved, ...override });
    await expect(sendPin(phone)).rejects.toThrow('SMS_TEMPLATE_NOT_ACCEPTED');
    expect(sendResalaTemplate).toHaveBeenCalledTimes(1);
    expect(sendResalaPin).not.toHaveBeenCalled();
});

test('a transport error is propagated without sending a second message', async () => {
    sendResalaTemplate.mockRejectedValue(new Error('TransportError'));
    await expect(sendPin(phone)).rejects.toThrow('TransportError');
    expect(sendResalaTemplate).toHaveBeenCalledTimes(1);
    expect(sendResalaPin).not.toHaveBeenCalled();
});

test('a template without the agreed code placeholder cannot create a login challenge', async () => {
    sendResalaTemplate.mockResolvedValue({ ...approved, sms_template_version: { status: 'APPROVED', body: 'رمز الدخول' } });
    await expect(sendPin(phone)).rejects.toThrow('SMS_TEMPLATE_CODE_SLOT_INVALID');
    expect(sendResalaPin).not.toHaveBeenCalled();
});

test('the built-in Resala PIN remains available when no template is configured', async () => {
    delete process.env.RESALA_SMS_TEMPLATE_ID;
    sendResalaPin.mockResolvedValue({ pin: '023401' });
    await expect(sendPin(phone)).resolves.toBe('023401');
    expect(sendResalaPin).toHaveBeenCalledTimes(1);
    expect(sendResalaPin).toHaveBeenCalledWith(
        phone, { service_name: 'Ahram Pay', len: 6, sender: 'TestBrand', test: false }
    );
    expect(sendResalaTemplate).not.toHaveBeenCalled();
});
