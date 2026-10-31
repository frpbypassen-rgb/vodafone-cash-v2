'use strict';
// Read-only counters, no application imports, account identifiers or hashes in output.
const classifyPassword = (value) => {
    if (typeof value !== 'string' || !value) return 'missing';
    const match = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(value);
    if (!match || Number(match[1]) < 4 || Number(match[1]) > 31) return 'legacyOrInvalid';
    return Number(match[1]) >= 12 ? 'bcrypt12OrHigher' : 'bcryptBelow12';
};
module.exports = { classifyPassword };

if (require.main === module) {
    const fs = require('node:fs');
    const path = require('node:path');
    const { MongoClient } = require('mongodb');
    const main = async () => {
        const envPath = process.env.DOTENV_CONFIG_PATH || path.join(process.cwd(), '.env');
        const env = { ...require('dotenv').parse(fs.readFileSync(envPath)), ...process.env };
        const client = new MongoClient(env.MONGO_URI, {
            maxPoolSize: 1,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 15000,
            retryWrites: false,
            readPreference: 'secondaryPreferred',
        });
        const counts = {};
        try {
            await client.connect();
            for (const collection of [
                'admins',
                'users',
                'employees',
                'subaccounts',
                'clientemployees',
                'agentemployees',
                'registrationrequests',
            ]) {
                const field = collection === 'registrationrequests' ? 'password' : 'webPassword';
                const result = { missing: 0, legacyOrInvalid: 0, bcryptBelow12: 0, bcrypt12OrHigher: 0 };
                const cursor = client
                    .db()
                    .collection(collection)
                    .find(
                        {},
                        {
                            projection: { _id: 0, [field]: 1 },
                            batchSize: 200,
                        }
                    )
                    .maxTimeMS(10000);
                for await (const row of cursor) result[classifyPassword(row[field])]++;
                counts[collection] = result;
            }
        } finally {
            await client.close();
        }
        console.log(JSON.stringify({ readOnly: true, complete: true, counts }, null, 2));
    };
    main().catch(() => {
        console.error('CREDENTIAL_AUDIT_INCOMPLETE: no credentials printed or changed.');
        process.exitCode = 1;
    });
}
