'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEXT_EXTENSIONS = new Set(['.ejs', '.html', '.js', '.ts', '.css']);
const JQUERY_PATTERNS = [
    /(?:^|[/@.-])jquery(?:\.min)?\.js\b/i,
    /code\.jquery\.com/i,
    /require\s*\(\s*['"]jquery['"]\s*\)/i,
    /from\s+['"]jquery['"]/i,
    /\bwindow\.jQuery\b/i
];

const walk = (directory, ignored = new Set()) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (ignored.has(entry.name)) return [];
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(absolute, ignored) : [absolute];
    });
};

const findJqueryReferences = () => walk(path.join(ROOT, 'views'))
    .concat(walk(path.join(ROOT, 'public'), new Set(['vendor'])))
    .filter((file) => TEXT_EXTENSIONS.has(path.extname(file)))
    .filter((file) => JQUERY_PATTERNS.some((pattern) => pattern.test(fs.readFileSync(file, 'utf8'))));

const findJavaScriptInTypedSource = () => walk(path.join(ROOT, 'src'))
    .filter((file) => ['.js', '.jsx', '.mjs', '.cjs'].includes(path.extname(file)));

const checkArchitecturePolicy = () => {
    const violations = [];
    const jqueryFiles = findJqueryReferences();
    const sourceJavaScript = findJavaScriptInTypedSource();
    if (jqueryFiles.length) violations.push(`jQuery references: ${jqueryFiles.map((file) => path.relative(ROOT, file)).join(', ')}`);
    if (sourceJavaScript.length) violations.push(`JavaScript inside typed src/: ${sourceJavaScript.map((file) => path.relative(ROOT, file)).join(', ')}`);
    return violations;
};

if (require.main === module) {
    const violations = checkArchitecturePolicy();
    if (violations.length) {
        console.error(`Architecture policy failed:\n- ${violations.join('\n- ')}`);
        process.exitCode = 1;
    } else {
        console.log('Architecture policy passed: typed src/ boundary and zero jQuery dependencies.');
    }
}

module.exports = { checkArchitecturePolicy, findJavaScriptInTypedSource, findJqueryReferences };
