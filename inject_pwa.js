const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'views');

const tagsToInject = `
    <!-- PWA Setup -->
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#001a4d">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="Al-Ahram">
    <!-- End PWA Setup -->
`;

function processDir(directory) {
    const files = fs.readdirSync(directory);
    for (const file of files) {
        const fullPath = path.join(directory, file);
        if (fs.statSync(fullPath).isDirectory()) {
            processDir(fullPath);
        } else if (fullPath.endsWith('.ejs')) {
            let content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes('</head>') && !content.includes('/manifest.json')) {
                content = content.replace('</head>', tagsToInject + '</head>');
                fs.writeFileSync(fullPath, content, 'utf8');
                console.log(`Injected PWA tags into ${fullPath}`);
            }
        }
    }
}

processDir(viewsDir);
console.log('Done injecting PWA tags.');
