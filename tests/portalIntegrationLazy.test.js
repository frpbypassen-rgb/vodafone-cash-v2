'use strict';
const fs = require('fs'),
    vm = require('vm'),
    path = require('path');
for (const file of [
    'company-mobile/report-email.js',
    'agent-portal/report-email.js',
    'company-mobile/telegram-settings.js',
    'agent-portal/telegram-settings.js',
])
    test(`${file} defers initialization and network traffic until its panel opens`, () => {
        const listeners = {};
        const register = (name, fn) => (listeners[name] ||= []).push(fn);
        const element = () => ({
            hidden: true,
            value: '',
            checked: false,
            elements: {
                email: { value: '' },
                code: { value: '' },
                name: { value: '' },
            },
            classList: { toggle: jest.fn() },
            addEventListener: jest.fn(),
            setAttribute: jest.fn(),
            querySelectorAll: () => [],
        });
        const nodes = new Map();
        const root = {
            closest: () => ({ id: 'notifications' }),
            querySelector: (s) => {
                if (!nodes.has(s)) nodes.set(s, element());
                return nodes.get(s);
            },
            querySelectorAll: () => [],
            addEventListener: jest.fn(),
        };
        const fetch = jest.fn(() => new Promise(() => {}));
        const window = {
            location: { hash: '#integrations' },
            addEventListener: register,
            businessPortal: { csrfToken: 'test' },
            agentPortal: { csrfToken: 'test' },
            setInterval: jest.fn(),
        };
        const context = {
            window,
            document: {
                hidden: false,
                visibilityState: 'visible',
                querySelector: () => root,
                addEventListener: register,
            },
            fetch,
            setInterval: jest.fn(),
            setTimeout: jest.fn(),
            clearTimeout: jest.fn(),
            navigator: {},
        };
        vm.runInNewContext(
            fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'),
            context,
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(nodes.size).toBe(0);
        window.location.hash = '#notifications';
        for (const fn of [...listeners.hashchange]) fn();
        expect(fetch).toHaveBeenCalledTimes(1);
        window.location.hash = '#integrations';
        for (const fn of [...listeners.hashchange]) fn();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
