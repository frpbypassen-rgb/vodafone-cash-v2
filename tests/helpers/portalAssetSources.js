'use strict';

const fs = require('fs');
const path = require('path');
const espree = require('espree');
const projectRoot = path.join(__dirname, '../..');

// Assertions inspect the effective local asset, including compatibility aliases
// and native ES-module dependencies, rather than only the thin entry file.
const readPortalAsset = (input, seen = new Set()) => {
    const file = path.resolve(input);
    if (!file.startsWith(projectRoot + path.sep) || seen.has(file)) return '';
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const references = [];
    if (file.endsWith('.css')) {
        for (const match of source.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) {
            const target = match[1].split('?')[0];
            if (target.startsWith('/css/')) references.push(path.join(projectRoot, 'public', target));
            else if (!/^[a-z]+:/i.test(target)) references.push(path.resolve(path.dirname(file), target));
        }
    } else if (file.endsWith('.ejs')) {
        for (const match of source.matchAll(
            /['"]((?:\.\.\/|\.\/)?(?:partials|pages|\.\.\/portal)\/[A-Za-z0-9_/-]+)['"]/g
        )) {
            const target = path.resolve(path.dirname(file), match[1] + '.ejs');
            if (fs.existsSync(target)) references.push(target);
        }
        for (const match of source.matchAll(/include\(\s*['"]([^'"]+)['"]/g)) {
            const target = path.resolve(path.dirname(file), match[1] + '.ejs');
            if (fs.existsSync(target)) references.push(target);
        }
    } else if (file.endsWith('.js')) {
        const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        const visit = (node) => {
            if (!node || typeof node !== 'object') return;
            const name =
                node.type === 'ImportDeclaration' || node.type === 'ImportExpression'
                    ? node.source?.value
                    : null;
            if (typeof name === 'string' && name.startsWith('.'))
                references.push(path.resolve(path.dirname(file), name.split('?')[0]));
            for (const value of Object.values(node)) {
                if (Array.isArray(value)) value.forEach(visit);
                else if (value && typeof value === 'object') visit(value);
            }
        };
        visit(ast);
    }
    return source + '\n' + references.map((target) => readPortalAsset(target, seen)).join('\n');
};

module.exports = { readPortalAsset };
