'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('portal consumers share one connection without losing independent event subscriptions', () => {
    const callbacks = {}, handlers = {};
    const socket = { on: jest.fn((event, fn) => { (handlers[event] ||= []).push(fn); }), disconnect: jest.fn() };
    const window = { io: jest.fn(() => socket), addEventListener: (name, fn) => { callbacks[name] = fn; } };
    const context = { window };
    vm.runInNewContext(source('public/js/portal-realtime.js'), context);
    const first = window.getPortalRealtimeSocket();
    first.on('rate_change_activated', jest.fn());
    const second = window.getPortalRealtimeSocket();
    second.on('rate_change_activated', jest.fn());
    expect(first).toBe(second);
    expect(window.io).toHaveBeenCalledTimes(1);
    expect(handlers.rate_change_activated).toHaveLength(2);
    vm.runInNewContext(source('public/js/portal-realtime.js'), context);
    expect(window.getPortalRealtimeSocket()).toBe(first);
    expect(window.io).toHaveBeenCalledTimes(1);
    callbacks.pagehide({ persisted: true });
    expect(socket.disconnect).not.toHaveBeenCalled();
    callbacks.pagehide({ persisted: false });
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
});

test('missing realtime library is safe and can become available later', () => {
    const window = { addEventListener: jest.fn() };
    vm.runInNewContext(source('public/js/portal-realtime.js'), { window });
    expect(window.getPortalRealtimeSocket()).toBe(null);
    const socket = {};
    window.io = jest.fn(() => socket);
    expect(window.getPortalRealtimeSocket()).toBe(socket);
    expect(window.io).toHaveBeenCalledTimes(1);
});

test.each(['views/company/partials/head.ejs','views/agent/partials/head.ejs','views/client/partials/workspace_head.ejs','views/client/dashboard.ejs'])('%s loads shared transport before its consumers', file => {
    const text = source(file);
    expect(text.indexOf('/js/portal-realtime.js')).toBeGreaterThan(text.indexOf('/socket.io/socket.io.js'));
    expect(text.indexOf('/js/portal-realtime.js')).toBeLessThan(text.indexOf('/js/rate-alert-overlay.js'));
});

test.each(['public/js/rate-alert-overlay.js','public/js/business-portal/rate-notice.js','public/js/portal-workspace/services.js','public/js/portal-workspace/reports.js'])('%s reuses the shared connection', file => {
    expect(source(file)).toContain('window.getPortalRealtimeSocket()');
});
