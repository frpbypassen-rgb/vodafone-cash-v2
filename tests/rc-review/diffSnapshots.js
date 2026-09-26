'use strict';

const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    Object.keys(value).sort().forEach((key) => {
        out[key] = stable(value[key]);
    });
    return out;
};

const diffValues = (left, right, pathName, diffs) => {
    const a = stable(left);
    const b = stable(right);
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (Array.isArray(a) || Array.isArray(b) || !a || !b || typeof a !== 'object' || typeof b !== 'object') {
        diffs.push({ path: pathName, main: a === undefined ? null : a, rc: b === undefined ? null : b });
        return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    keys.forEach((key) => diffValues(a[key], b[key], pathName ? `${pathName}.${key}` : key, diffs));
};

const diffSnapshots = (mainSnap, rcSnap) => {
    const diffs = [];
    diffValues(mainSnap, rcSnap, '', diffs);
    return diffs.map((item) => ({ ...item, path: item.path.replace(/^\./, '') }));
};

module.exports = { diffSnapshots };
