'use strict';

const {
    checkArchitecturePolicy,
    findJavaScriptInTypedSource,
    findJqueryReferences
} = require('../scripts/checkArchitecturePolicy');

describe('architecture modernization policy', () => {
    test('keeps jQuery out of the application frontend', () => {
        expect(findJqueryReferences()).toEqual([]);
    });

    test('keeps the typed application and domain boundary TypeScript-only', () => {
        expect(findJavaScriptInTypedSource()).toEqual([]);
        expect(checkArchitecturePolicy()).toEqual([]);
    });
});
