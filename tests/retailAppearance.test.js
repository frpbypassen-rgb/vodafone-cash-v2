'use strict';
const vm = require('vm'),
    fs = require('fs'),
    path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/retail-appearance.js'), 'utf8');
const fixture = () => {
    const events = {},
        elements = {},
        storage = { current: 'day' };
    const element = () => ({
        dataset: {},
        listeners: {},
        addEventListener(name, fn) {
            this.listeners[name] = fn;
        },
    });
    const radios = ['day', 'night', 'system'].map((value) => ({ ...element(), value }));
    [
        '[data-ra-form]',
        '[data-ra-preview]',
        '[data-ra-preview-label]',
        '[data-ra-description]',
        '[data-ra-save]',
        '[data-ra-status]',
    ].forEach((key) => {
        elements[key] = element();
    });
    elements['[data-ra-form]'].querySelectorAll = () => radios;
    const save = jest.fn((mode) => {
        storage.current = mode;
    });
    const window = {
        addEventListener: (name, fn) => {
            events[name] = fn;
        },
        confirm: jest.fn(() => false),
        matchMedia: () => ({ addEventListener() {} }),
        customerAppearance: {
            current: () => storage.current,
            resolve: (mode) => (mode === 'system' ? 'night' : mode),
            save,
        },
    };
    vm.runInNewContext(source, {
        window,
        document: {
            querySelector: () => ({ querySelector: (key) => elements[key] }),
            addEventListener: (name, fn) => {
                events['document:' + name] = fn;
            },
        },
    });
    events.DOMContentLoaded();
    return {
        elements,
        radios,
        events,
        window,
        save,
        choose: (mode) => radios.find((r) => r.value === mode).listeners.change(),
        submit: () => elements['[data-ra-form]'].listeners.submit({ preventDefault() {} }),
    };
};
test('preview changes without persistence; explicit save commits the browser preference', () => {
    const f = fixture();
    f.choose('system');
    expect(f.elements['[data-ra-preview]'].dataset.raPreview).toBe('night');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.elements['[data-ra-save]'].disabled).toBe(false);
    f.submit();
    expect(f.save).toHaveBeenCalledWith('system');
    expect(f.elements['[data-ra-save]'].disabled).toBe(true);
});
test('cancelled navigation retains unsaved choice; saved choice does not block unloading', () => {
    const f = fixture();
    f.choose('night');
    const preventDefault = jest.fn();
    f.events['document:click']({
        target: { closest: () => ({ getAttribute: () => '/client/settings' }) },
        button: 0,
        preventDefault,
    });
    expect(preventDefault).toHaveBeenCalled();
    const event = { preventDefault: jest.fn() };
    f.events.beforeunload(event);
    expect(event.preventDefault).toHaveBeenCalled();
    f.submit();
    const clean = { preventDefault: jest.fn() };
    f.events.beforeunload(clean);
    expect(clean.preventDefault).not.toHaveBeenCalled();
});
test('failed storage keeps the draft unsaved and explains the failure', () => {
    const f = fixture();
    f.choose('night');
    f.save.mockImplementation(() => {
        throw new Error('storage blocked');
    });
    f.submit();
    expect(f.elements['[data-ra-save]'].disabled).toBe(false);
    expect(f.elements['[data-ra-status]'].textContent).toContain('تعذر حفظ');
});

const themeFixture = (mode = 'system') => {
    const attributes = { 'data-portal': 'customer', 'data-theme': 'day' },
        listeners = {};
    const values = new Map([['ahram_customer_appearance', mode]]);
    const media = {
        matches: true,
        addEventListener: (_, fn) => {
            listeners.media = fn;
        },
    };
    const node = {
        getAttribute: (key) => attributes[key],
        setAttribute: (key, value) => {
            attributes[key] = value;
        },
        classList: { contains: () => false, add() {}, remove() {} },
    };
    const window = {
        matchMedia: () => media,
        dispatchEvent() {},
        addEventListener: (name, fn) => {
            listeners[name] = fn;
        },
    };
    const localStorage = {
        getItem: (key) => values.get(key),
        setItem: (key, value) => values.set(key, value),
    };
    const shared = fs.readFileSync(path.join(__dirname, '../public/js/client-portal.js'), 'utf8');
    vm.runInNewContext(shared.slice(0, shared.indexOf('    const enableArt')) + '\n})();', {
        window,
        localStorage,
        CustomEvent: function () {},
        document: {
            documentElement: node,
            body: node,
            querySelector: () => null,
            querySelectorAll: () => [],
        },
        fetch: jest.fn(() => Promise.resolve()),
    });
    return { window, media, listeners, attributes, localStorage };
};
test('system appearance follows device changes; a fixed mode ignores them', () => {
    const f = themeFixture();
    expect(f.attributes['data-theme']).toBe('night');
    f.media.matches = false;
    f.listeners.media();
    expect(f.attributes['data-theme']).toBe('day');
    f.window.customerAppearance.save('night');
    f.listeners.media();
    expect(f.attributes['data-theme']).toBe('night');
    expect(f.window.customerAppearance.current()).toBe('night');
});
test('storage failure does not apply an unsaved global theme', () => {
    const f = themeFixture('day');
    f.localStorage.setItem = () => {
        throw new Error('storage blocked');
    };
    expect(() => f.window.customerAppearance.save('night')).toThrow();
    expect(f.attributes['data-theme']).toBe('day');
});
