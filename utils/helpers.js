// utils/helpers.js
const ExecutorBot = require('../models/ExecutorBot');
const Transaction = require('../models/Transaction');

const syncBotBalance = async (botId) => {
    const bot = await ExecutorBot.findById(botId);
    if (!bot) return 0;
    
    let queryFilter = {};
    if (bot.isManagerBot) {
        queryFilter = { 
            $or: [
                { managerBotId: bot._id, status: 'completed' }, 
                { executorBotId: bot._id, status: { $in: ['deposit', 'deduction'] } } 
            ]
        };
    } else {
        queryFilter = { 
            executorBotId: bot._id, 
            status: { $in: ['completed', 'deposit', 'deduction'] } 
        };
    }

    const txs = await Transaction.find(queryFilter);
    let computedBalance = 0;
    txs.forEach(t => {
        if (t.status === 'completed') computedBalance -= t.amount; 
        else if (t.status === 'deposit') computedBalance += t.amount; 
        else if (t.status === 'deduction') computedBalance -= Math.abs(t.amount); 
    });

    bot.balance = computedBalance;
    await bot.save();
    return computedBalance;
};

module.exports = { syncBotBalance };