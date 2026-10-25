'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/executor-api.js'), 'utf8');
let window;
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: jest.fn().mockResolvedValue(data) });
beforeEach(() => {
    window = { location: { assign: jest.fn() }, fetch: jest.fn(), executorCsrfToken: 'csrf-test' };
    vm.runInNewContext(source, { window, Headers });
});
test('uses the CSRF and JSON accept headers for mutations without modifying caller headers', () => {
    const headers = { 'Content-Type': 'application/json' };
    window.executorApiFetch('/api/test', { method: 'POST', headers });
    const options = window.fetch.mock.calls[0][1];
    expect(options.headers.get('x-csrf-token')).toBe('csrf-test');
    expect(options.headers.get('Accept')).toBe('application/json');
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
});
test('redirects MFA errors to enrollment and rejects the action', async () => {
    await expect(window.readExecutorApiResponse(response({ success: false, code: 'MFA_ENROLLMENT_REQUIRED' }, 403))).rejects.toThrow();
    expect(window.location.assign).toHaveBeenCalledWith('/security/mfa-enroll');
});
test('does not accept a login HTML redirect as successful completion', async () => {
    const html = response(null);
    html.json.mockRejectedValue(new SyntaxError('Unexpected token <'));
    await expect(window.readExecutorApiResponse(html)).rejects.toThrow('استجابة الخادم غير صالحة');
});
test('401 still redirects when its body cannot be parsed', async () => {
    const denied = response(null, 401);
    denied.json.mockRejectedValue(new Error('no JSON'));
    await expect(window.readExecutorApiResponse(denied)).rejects.toThrow('انتهت جلسة الدخول');
    expect(window.location.assign).toHaveBeenCalledWith('/login');
});
test('preserves legitimate successful API data and validation failures', async () => {
    const payload = { success: true, tasks: [] };
    expect(await window.readExecutorApiResponse(response(payload))).toBe(payload);
    await expect(window.readExecutorApiResponse(response({ success: false, error: 'سبب الإلغاء مطلوب.' }, 400))).rejects.toThrow('سبب الإلغاء مطلوب.');
});
