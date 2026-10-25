'use strict';
const { redirectWithMessage } = require('../controllers/portalWorkspace/common');
test.each([
    'https://evil.invalid',
    '//evil.invalid',
    '/\\evil.invalid',
    '/client/../../admin',
    '/client/../..//evil.invalid',
    '/other',
    null,
    {},
])('rejects unsafe portal return path %p', (path) => {
    const res = { redirect: jest.fn() };
    redirectWithMessage(res, path, 'settingsSuccess', 'theme');
    expect(res.redirect).toHaveBeenCalledWith('/client/settings?settingsSuccess=theme');
});
test('preserves portal filters and fragments while replacing feedback parameters', () => {
    const res = { redirect: jest.fn() };
    redirectWithMessage(
        res,
        '/agent-portal/settings?tab=theme&settingsSuccess=old#appearance',
        'settingsSuccess',
        'theme'
    );
    expect(res.redirect).toHaveBeenCalledWith(
        '/agent-portal/settings?tab=theme&settingsSuccess=theme#appearance'
    );
});
