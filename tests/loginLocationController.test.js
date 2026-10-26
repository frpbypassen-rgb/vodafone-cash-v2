'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/login-location.js'), 'utf8');

function fixture(required = true, mfa = false) {
    const elements = {};
    const element = (id) => elements[id] = {
        value: '', hidden: true, disabled: false, innerHTML: 'دخول',
        listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
        focus: jest.fn()
    };
    ['locationStatus', 'locationRetryButton', 'latitudeInput', 'longitudeInput', 'locationAccuracyInput', 'submitBtn'].forEach(element);
    const form = element('loginForm');
    form.dataset = { locationRequired: String(required) };
    form.querySelector = () => mfa ? elements.code : null;
    const submit = jest.fn();
    const requests = [];
    const context = {
        document: { getElementById: id => elements[id] },
        window: { isSecureContext: true },
        navigator: { geolocation: { getCurrentPosition: (success, error, options) => requests.push({ success, error, options }) } },
        HTMLFormElement: { prototype: { submit } }, setTimeout, clearTimeout
    };
    vm.runInNewContext(source, context);
    return { elements, form, submit, requests, context,
        send: () => form.listeners.submit({ preventDefault: jest.fn() }),
        success: (index = requests.length - 1, latitude = 32.9, longitude = 13.2) => requests[index].success({ coords: { latitude, longitude, accuracy: 30 } })
    };
}

describe('login location controller', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('waits for slow GPS beyond the former 3.5-second limit and prevents duplicate submission', async () => {
        const f = fixture();
        await Promise.resolve();
        const pending = f.send();
        await f.send();
        await jest.advanceTimersByTimeAsync(4500);
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.requests).toHaveLength(1);
        f.success();
        await pending;
        expect(f.submit).toHaveBeenCalledTimes(1);
        expect(f.elements.latitudeInput.value).toBe(32.9);
    });

    test.each([1, 2, 3])('blocks required login on GPS error %s and supports successful retry', async code => {
        const f = fixture();
        await Promise.resolve();
        const pending = f.send();
        f.requests[0].error({ code });
        await pending;
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.elements.submitBtn.disabled).toBe(false);
        expect(f.elements.locationRetryButton.hidden).toBe(false);
        f.elements.locationRetryButton.listeners.click();
        await Promise.resolve();
        f.success();
        await f.send();
        expect(f.submit).toHaveBeenCalledTimes(1);
    });

    test('times out without clearing input values, then accepts zero coordinates', async () => {
        const f = fixture();
        f.form.value = 'existing credentials';
        const pending = f.send();
        await jest.advanceTimersByTimeAsync(20250);
        await pending;
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.form.value).toBe('existing credentials');
        const retry = f.send();
        await Promise.resolve();
        f.success(1, 0, 0);
        await retry;
        expect(f.submit).toHaveBeenCalledTimes(1);
    });

    test('optional policy permits submission after bounded GPS timeout', async () => {
        const f = fixture(false);
        const pending = f.send();
        await jest.advanceTimersByTimeAsync(3750);
        await pending;
        expect(f.submit).toHaveBeenCalledTimes(1);
    });

    test('an outdated request cannot overwrite a retry position', async () => {
        const f = fixture();
        await jest.advanceTimersByTimeAsync(20250);
        const retry = f.context.window.loginLocation.ensure();
        await Promise.resolve();
        f.success(1, 30, 20);
        await retry;
        f.success(0, 1, 2);
        expect(f.elements.latitudeInput.value).toBe(30);
    });
});
