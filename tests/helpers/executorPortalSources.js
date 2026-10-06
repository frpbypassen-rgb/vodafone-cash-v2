const fs = require('fs');
const path = require('path');
const { parsers } = require('prettier/plugins/html');

const root = path.join(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function portalAssets(template) {
    const masked = template.replace(/<%[\s\S]*?%>/g, (match) => match.replace(/[^\r\n]/g, ' '));
    const assets = [];
    function visit(node) {
        for (const attribute of node.attrs || []) {
            if (!['src', 'href'].includes(attribute.name)) continue;
            const url = attribute.value.split('?')[0];
            if (url.startsWith('/js/executor/') || url.startsWith('/css/executor/pages/')) {
                assets.push(`public${url}`);
            }
        }
        node.children?.forEach(visit);
    }
    visit(parsers.html.parse(masked, {}));
    return assets;
}

function readPortalView(page) {
    const template = read(`views/executor/${page}.ejs`);
    return [template, ...portalAssets(template).map(read)].join('\n');
}

function readDashboardHandlers() {
    const directory = path.join(root, 'controllers/executor/dashboard');
    return fs
        .readdirSync(directory)
        .filter((file) => file.endsWith('Controller.js'))
        .map((file) => read(`controllers/executor/dashboard/${file}`))
        .join('\n');
}

module.exports = { portalAssets, readPortalView, readDashboardHandlers };
