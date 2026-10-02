const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

describe('executor support group chat UI', () => {
    const viewPath = path.join(__dirname, '../views/executor/support.ejs');
    const cssPath = path.join(__dirname, '../public/css/executor-support-chat.css');

    test('renders a shared conversation alongside existing tickets', () => {
        const view = fs.readFileSync(viewPath, 'utf8');
        expect(() => ejs.compile(view, { filename: viewPath })).not.toThrow();
        expect(view).toContain('/css/executor-support-chat.css?v=20261002-group-chat');
        expect(view).toContain('data-support-mode="group"');
        expect(view).toContain('data-support-mode="tickets"');
        expect(view).toContain('/executor-portal/api/support/group-chat/replies');
        expect(view).toContain('escapeHtml(message.senderName');
    });

    test('keeps the conversation and composer compact on phones', () => {
        const css = fs.readFileSync(cssPath, 'utf8');
        expect(css).toContain('@media (max-width: 767.98px)');
        expect(css).toContain('.group-message-list { padding: 8px; gap: 6px; }');
        expect(css).toContain('.group-chat[hidden], #ticketWorkspacePage[hidden] { display: none !important; }');
    });
});
