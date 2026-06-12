const mongoose = require('mongoose');

mongoose.connect('mongodb://127.0.0.1:27017/vodafone_cash_system')
    .then(async () => {
        const txs = await mongoose.connection.db.collection('transactions').find({status: 'completed'}).sort({_id: -1}).limit(5).toArray();
        console.log(JSON.stringify(txs, null, 2));
        process.exit(0);
    });
