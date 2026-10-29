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
        navigator: { geolocation: {
            getCurrentPosition: (success, error, options) => requests.push({ success, error, options }),
            watchPosition: (success, error, options) => { requests.push({ success, error, options }); return 42; },
            clearWatch: jest.fn()
        } },
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
        if (code === 1) expect(f.requests).toHaveLength(1);
        if (code !== 1) {
            await Promise.resolve();
            f.requests.at(-1).error({ code: 1 });
        }
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
        await jest.advanceTimersByTimeAsync(33500);
        await pending;
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.form.value).toBe('existing credentials');
        const retry = f.send();
        await Promise.resolve();
        f.success(f.requests.length - 1, 0, 0);
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
        await jest.advanceTimersByTimeAsync(33500);
        const retry = f.context.window.loginLocation.ensure();
        await Promise.resolve();
        f.success(f.requests.length - 1, 30, 20);
        await retry;
        f.success(0, 1, 2);
        expect(f.elements.latitudeInput.value).toBe(30);
    });

    test('a network-position timeout falls back to GPS without submitting or asking again', async () => {
        const f = fixture();
        await Promise.resolve();
        const pending = f.send();
        f.requests[0].error({ code: 3 });
        expect(f.requests).toHaveLength(2);
        expect(f.requests[1].options.enableHighAccuracy).toBe(true);
        expect(f.submit).not.toHaveBeenCalled();
        f.success(1);
        await pending;
        expect(f.submit).toHaveBeenCalledTimes(1);
        expect(f.context.navigator.geolocation.clearWatch).toHaveBeenCalledWith(42);
    });

    test('a late coarse response cannot overwrite the GPS result or revive a failed attempt', async () => {
        const f = fixture();
        await Promise.resolve();
        f.requests[0].error({ code: 2 });
        f.success(1, 31, 12);
        await f.context.window.loginLocation.ready;
        f.success(0, 1, 2);
        expect(f.elements.latitudeInput.value).toBe(31);
        expect(f.elements.longitudeInput.value).toBe(12);
    });

    test('accepts a valid coarse result while the precise fallback is still waiting', async () => {
        const f = fixture();
        await jest.advanceTimersByTimeAsync(8250);
        const pending = f.send();
        f.success(0, 32, 13);
        await pending;
        expect(f.submit).toHaveBeenCalledTimes(1);
        expect(f.context.navigator.geolocation.clearWatch).toHaveBeenCalledWith(42);
    });

    test('a transient watch error can recover before the bounded deadline', async () => {
        const f = fixture();
        await Promise.resolve();
        f.requests[0].error({ code: 3 });
        const pending = f.send();
        f.requests[1].error({ code: 2 });
        expect(f.submit).not.toHaveBeenCalled();
        f.success(1);
        await pending;
        expect(f.submit).toHaveBeenCalledTimes(1);
    });

    test('supports browsers without watchPosition without bypassing location policy', async () => {
        const f = fixture();
        delete f.context.navigator.geolocation.watchPosition;
        await Promise.resolve();
        f.requests[0].error({ code: 3 });
        const pending = f.send();
        expect(f.requests[1].options.enableHighAccuracy).toBe(true);
        f.requests[1].error({ code: 2 });
        await pending;
        expect(f.submit).not.toHaveBeenCalled();
    });
});
