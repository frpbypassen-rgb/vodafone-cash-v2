const fs = require('fs');
let code = fs.readFileSync('routes/executorPortal.js', 'utf8');

code = code.replace(/const { Telegram } = require\('telegraf'\);/g, `
class Telegram {
    constructor() {}
    async sendMessage() { return { message_id: 1 }; }
    async sendPhoto() { return { message_id: 1, photo: [{ file_id: 'dummy' }] }; }
    async sendMediaGroup() { return [{ message_id: 1, photo: [{ file_id: 'dummy' }] }]; }
    async editMessageText() { return true; }
    async editMessageCaption() { return true; }
    async callApi() { return true; }
    async getFileLink() { return { href: 'http://localhost/dummy' }; }
}
`);
code = code.replace(/ExecutorBot/g, 'ExecutorGroup');
code = code.replace(/ClientBot/g, 'ClientCompany');
code = code.replace(/botId/g, 'groupId');

fs.writeFileSync('routes/executorPortal.js', code);
console.log('Done refactoring executorPortal.js');
