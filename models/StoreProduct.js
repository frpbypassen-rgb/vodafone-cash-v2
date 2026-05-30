const mongoose = require('mongoose');

const storeProductSchema = new mongoose.Schema({
    categoryName: { type: String, required: true },
    name: { type: String, required: true },
    image: { type: String, default: '' }
});

module.exports = mongoose.model('StoreProduct', storeProductSchema);