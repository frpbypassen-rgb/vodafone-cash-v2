const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

describe('executor support group chat UI', () => {
    const viewPath = path.join(__dirname, '../views/executor/support.ejs');
    const cssPath = path.join(__dirname, '../public/css/executor-support-chat.css');

    test('renders only the shared conversation without ticket forms', () => {
        const view = fs.readFileSync(viewPath, 'utf8');
        expect(() => ejs.compile(view, { filename: viewPath })).not.toThrow();
        expect(view).toContain('/css/executor-support-chat.css?v=20261002-chat-only');
        expect(view).toContain('id="groupMessageList"');
        expect(view).toContain('escapeHtml(message.senderName');
        expect(view).toContain('/executor-portal/api/support/group-chat/replies');
        expect(view).not.toContain('ticketWorkspacePage');
        expect(view).not.toContain('newTicketForm');
        expect(view).not.toContain('/executor-portal/api/support/tickets');
    });

    test('keeps the conversation and composer compact on phones', () => {
        const css = fs.readFileSync(cssPath, 'utf8');
        expect(css).toContain('@media (max-width: 767.98px)');
        expect(css).toContain('.group-message-list { padding: 8px; gap: 6px; }');
        expect(css).toContain('height: calc(100dvh - 132px - env(safe-area-inset-bottom))');
    });
});
