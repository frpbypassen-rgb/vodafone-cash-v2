'use strict';
const vm = require('vm'),
    fs = require('fs'),
    path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../public/js/retail-documents.js'), 'utf8');
const setup = async () => {
    const elements = {},
        events = {},
        nodes = () => ({
            dataset: {},
            listeners: {},
            addEventListener(name, fn) {
                this.listeners[name] = fn;
            },
            removeAttribute() {},
            append() {},
            replaceChildren() {},
            className: '',
            textContent: '',
        });
    const find = (selector) => (elements[selector] ||= nodes());
    const fileInput = { ...nodes(), value: '', files: [] };
    find('[data-rd-form]').elements = { document: fileInput, kind: { value: 'identity' } };
    const fetch = jest
        .fn()
        .mockResolvedValue({
            ok: true,
            json: async () => ({ revision: 0, verification: 'not_submitted', documents: [] }),
        });
    const window = {
        addEventListener: (name, fn) => {
            events[name] = fn;
        },
        confirm: jest.fn(() => false),
    };
    vm.runInNewContext(source, {
        document: {
            querySelector: () => ({ querySelector: find }),
            createElement: nodes,
            addEventListener: (name, fn) => {
                events['document:' + name] = fn;
            },
        },
        window,
        fetch,
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        navigator: {},
        FormData: class {
            append() {}
        },
    });
    await new Promise(setImmediate);
    const choose = () => {
        fileInput.files = [{ name: 'test.png', size: 100, type: 'image/png' }];
        fileInput.listeners.change();
    };
    return { find, events, fetch, choose };
};
test('selected file blocks accidental exit; clearing removes the navigation warning', async () => {
    const f = await setup();
    f.choose();
    const event = { preventDefault: jest.fn() };
    f.events.beforeunload(event);
    expect(event.preventDefault).toHaveBeenCalled();
    const link = { target: '', getAttribute: () => '/client/settings' };
    const click = { target: { closest: () => link }, button: 0, preventDefault: jest.fn() };
    f.events['document:click'](click);
    expect(click.preventDefault).toHaveBeenCalled();
    f.find('[data-rd-clear]').listeners.click();
    const clean = { preventDefault: jest.fn() };
    f.events.beforeunload(clean);
    expect(clean.preventDefault).not.toHaveBeenCalled();
});
test('failed upload retains the selected file and the unsaved-exit protection', async () => {
    const f = await setup();
    f.choose();
    f.fetch.mockRejectedValueOnce(new Error('Network unavailable'));
    await f.find('[data-rd-form]').listeners.submit({ preventDefault() {} });
    expect(f.find('[data-rd-preview]').hidden).toBe(false);
    const event = { preventDefault: jest.fn() };
    f.events.beforeunload(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(f.find('[data-rd-submit]').disabled).toBe(false);
});
