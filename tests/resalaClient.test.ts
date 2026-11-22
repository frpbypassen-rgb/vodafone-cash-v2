import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import {
    listResalaSent, sendResalaPin, sendResalaTemplate, ResalaError,
} from '../src/Infrastructure/ResalaClient';

const phone = '218910001234';
const timestamp = '2026-09-16T12:00:00Z';
const apiKey = 'rsl_' + 'fixture-only';
const pinFixture = {
    id: 'pin-fixture', pin: '048293', code: '218', region: 'LY', number: '910001234',
    content: 'رمز التحقق: 048293', hit_count: 0, created_at: timestamp, updated_at: timestamp,
    sender_name: 'CarrierDefault',
};
const templateFixture = {
    is_prod: false, total_messages: 1, total_free_messages: 0, total_sent_free_messages: 0, total_cost: 0.05,
    succeeded: 1, failed: 0, failed_numbers: [], invalid_numbers: ['999'],
    sender_names: { libyana: 'MyBrand', almadar: 'CarrierDefault', international: 'Resala' },
    sms_template_version: { id: 'template-version', version_number: 3, body: 'أهلاً بك يا $1', status: 'APPROVED' },
};
const sentFixture = {
    data: [{
        id: 'message-fixture', code: '218', region: 'LY', number: '910001234', content: 'نص الرسالة',
        source: 'message', status: 'delivered', pages: 1, env: 'production',
        created_at: timestamp, updated_at: timestamp,
    }],
    meta: { total: 21, per_page: 20, current_page: 2, last_page: 2 },
};

const originalKey = process.env.RESALA_API_KEY;
let transport: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
    process.env.RESALA_API_KEY = apiKey;
    transport = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected HTTP request'));
});

afterEach(() => {
    transport.mockRestore();
    if (originalKey === undefined) delete process.env.RESALA_API_KEY;
    else process.env.RESALA_API_KEY = originalKey;
});

const respond = (status: number, body: object) => transport.mockResolvedValueOnce(Response.json(body, { status }));

test('sends an internationalized Libyan PIN number and preserves the actual sender', async () => {
    respond(201, pinFixture);
    const result = await sendResalaPin('0910001234', {
        service_name: 'My App', test: true, len: 6, autofill: 'App+Signature', sender: 'MyBrand',
    });
    expect(result).toEqual(pinFixture);
    const [url, init] = transport.mock.calls[0];
    expect(String(url)).toBe(
        'https://dev.resala.ly/api/v1/pins?service_name=My%20App&test=&len=6&autofill=App%2BSignature&sender=MyBrand',
    );
    expect(init).toMatchObject({
        method: 'POST', redirect: 'manual', body: JSON.stringify({ phone }),
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    });
});

test.each(['0900001234', '218950001234', '+12025550123'])('rejects unsupported PIN recipient %s locally', async invalid => {
    await expect(sendResalaPin(invalid)).rejects.toMatchObject({ type: 'InputValidation', status: 422, errors: { phone: expect.any(Array) } });
    expect(transport).not.toHaveBeenCalled();
});

test('passes template variables, invalid rows, and both schedules through unchanged', async () => {
    respond(201, templateFixture);
    const records = [
        { phone, $1: 'أحمد علي', scheduled_at: '2026-10-20 09:00' },
        { phone: '999', $1: 'سارة' },
    ];
    const result = await sendResalaTemplate('template-id', records, {
        scheduled_at: '2026-10-20T08:00:00+02:00', sender: 'MyBrand', test: false,
    });
    expect(result).toEqual(templateFixture);
    const [url, init] = transport.mock.calls[0];
    expect(String(url)).toBe(
        'https://dev.resala.ly/api/v1/messages/send-template?sms_template_id=template-id&sender=MyBrand&scheduled_at=2026-10-20T08%3A00%3A00%2B02%3A00',
    );
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ records }) });
});

test('returns a queued template response with its batch ID', async () => {
    const queued = { queued: true, batch_id: 'batch-fixture', scheduled_at: '2026-10-20 09:00' };
    respond(202, queued);
    await expect(sendResalaTemplate('template-id', [{ phone }], { scheduled_at: queued.scheduled_at })).resolves.toEqual(queued);
});

test('reads history and pagination via a GET with no request body', async () => {
    respond(200, sentFixture);
    await expect(listResalaSent({ filters: 'source:message|pin', q: 'أحمد علي', sorts: '-created_at', page: 2, paginate: 20 }))
        .resolves.toEqual(sentFixture);
    const [input, init] = transport.mock.calls[0];
    const url = new URL(String(input));
    expect(url.pathname).toBe('/api/v1/sent-view');
    expect(Object.fromEntries(url.searchParams)).toEqual({
        filters: 'source:message|pin', q: 'أحمد علي', sorts: '-created_at', page: '2', paginate: '20',
    });
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
});

test.each([
    [400, 'AccountExpired'], [400, 'InsufficientCredit'], [400, 'BadRequest'],
    [401, 'Unauthorized'], [401, 'TokenExpired'], [403, 'Forbidden'], [404, 'NotFound'],
] as const)('classifies HTTP %i by Resala type %s with a single send attempt', async (status, type) => {
    respond(status, { type, message: 'رسالة مترجمة', request_id: 'fixture-request' });
    await expect(sendResalaTemplate('template-id', [{ phone: '999' }])).rejects.toMatchObject({
        name: 'ResalaError', type, status, requestId: 'fixture-request',
    });
    expect(transport).toHaveBeenCalledTimes(1);
});

test('keeps per-field messages from InputValidation', async () => {
    respond(422, { type: 'InputValidation', message: 'translated error', errors: {
        'records.0.$1': ['القيمة مطلوبة'], scheduled_at: 'موعد غير صالح',
    } });
    await expect(sendResalaTemplate('template-id', [{ phone }])).rejects.toMatchObject({
        type: 'InputValidation', status: 422,
        errors: { 'records.0.$1': ['القيمة مطلوبة'], scheduled_at: ['موعد غير صالح'] },
    });
});

test('surfaces a transport failure without retrying or exposing the raw exception', async () => {
    transport.mockRejectedValueOnce(new Error('raw transport exception'));
    await expect(sendResalaPin(phone)).rejects.toMatchObject({
        type: 'TransportError', status: null, message: 'Resala: TransportError',
    });
    expect(transport).toHaveBeenCalledTimes(1);
});

test('rejects invalid success bodies and unknown provider error types', async () => {
    respond(201, { pin: 482913 });
    await expect(sendResalaPin(phone)).rejects.toMatchObject({ type: 'UnexpectedResponse', status: 201 });
    respond(401, { type: 'OtherError', message: 'Unauthorized' });
    await expect(listResalaSent()).rejects.toMatchObject({ type: 'UnexpectedResponse', status: 401 });
});

test('requires a server API key before making an HTTP request', async () => {
    delete process.env.RESALA_API_KEY;
    await expect(listResalaSent()).rejects.toBeInstanceOf(ResalaError);
    await expect(listResalaSent()).rejects.toMatchObject({ type: 'ConfigurationError', status: null });
    expect(transport).not.toHaveBeenCalled();
});
