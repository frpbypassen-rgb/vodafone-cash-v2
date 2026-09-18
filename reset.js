require('dotenv').config();
const mongoose = require('mongoose');

const connectDB = require('./config/database');
const { assertFinancialResetAllowed } = require('./utils/financialResetGuard');

const Transaction = require('./models/Transaction');
const ExecutorBot = require('./models/ExecutorBot');
const ClientBot = require('./models/ClientBot');
const User = require('./models/User');

const resetSystem = async () => {
    try {
        await connectDB();
        const dbName = mongoose.connection.name;
        const { dryRun } = assertFinancialResetAllowed({
            dbName,
            scriptName: 'reset.js'
        });

        console.log(`✅ Connected to database "${dbName}"`);
        if (dryRun) {
            console.log('🧪 DRY RUN — no financial records will be changed.');
        }

        const txCount = await Transaction.countDocuments({});
        const execCount = await ExecutorBot.countDocuments({});
        const clientCount = await ClientBot.countDocuments({});
        const userCount = await User.countDocuments({});
        console.log(`Would wipe ${txCount} transactions and zero ${execCount} executor, ${clientCount} client, ${userCount} user balances.`);

        if (dryRun) {
            console.log('Dry-run complete. Re-run without DRY_RUN=true to apply.');
            process.exit(0);
        }

        const deletedTxs = await Transaction.deleteMany({});
        console.log(`🗑️ Transactions deleted: ${deletedTxs.deletedCount}`);

        const execUpdate = await ExecutorBot.updateMany({}, { $set: { balance: 0 } });
        console.log(`🔄 Executor balances zeroed: ${execUpdate.modifiedCount}`);

        const clientUpdate = await ClientBot.updateMany({}, { $set: { balance: 0 } });
        console.log(`🔄 Client balances zeroed: ${clientUpdate.modifiedCount}`);

        const userUpdate = await User.updateMany({}, { $set: { balance: 0 } });
        console.log(`🔄 User balances zeroed: ${userUpdate.modifiedCount}`);

        console.log('\nFinancial reset applied to the confirmed non-production database.');
        process.exit(0);
    } catch (error) {
        console.error('❌ Financial reset refused or failed:', error.message);
        process.exit(1);
    }
};

resetSystem();
