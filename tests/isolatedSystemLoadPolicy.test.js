'use strict';
const { localUri, localRedisUri } = require('../scripts/runIsolatedSystemLoad.cjs');
test('load runner accepts only its generated disposable loopback database identity', () => {
    expect(localUri('mongodb://127.0.0.1:40001/ahram_audit_abcdef1234?replicaSet=test')).toBe(true);
    for (const uri of [
        'mongodb://127.0.0.1:27017/vodafone-cash-v2?replicaSet=rs0',
        'mongodb://example.test:27017/ahram_audit_abcdef?replicaSet=rs0',
        'mongodb://127.0.0.1:27017,example.test:27017/ahram_audit_abcdef?replicaSet=rs0',
        'mongodb+srv://example.test/ahram_audit_abcdef',
        'mongodb://user:password@127.0.0.1:27017/ahram_audit_abcdef?replicaSet=rs0'
    ]) expect(localUri(uri)).toBe(false);
});
test('Redis endpoints require a unique generated authentication secret on loopback', () => {
    expect(localRedisUri('redis://:' + 'a'.repeat(64) + '@127.0.0.1:40002')).toBe(true);
    expect(localRedisUri('redis://127.0.0.1:6379')).toBe(false);
    expect(localRedisUri('redis://:' + 'a'.repeat(64) + '@example.test:6379')).toBe(false);
});
