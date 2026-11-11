'use strict';
const { MongoClient, BSON } = require('mongodb');

test('installed Mongo driver resolves complete handshake metadata in the test runtime', async () => {
    const client = new MongoClient('mongodb://127.0.0.1:1');
    const metadata = await client.options.metadata;
    const serialized = BSON.deserialize(BSON.serialize(metadata));
    expect(serialized.driver.name).toContain('nodejs');
    expect(serialized.os.type).toBeTruthy();
    await client.close();
});
