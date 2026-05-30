const mongoose = require('mongoose');

const storeCategorySchema = new mongoose.Schema({
    name: { type: String, required: true },
    icon: { type: String, default: 'fa-layer-group' }, 
    color: { type: String, default: '#001a4d' }, 
    image: { type: String, default: '' },
    isCustom: { type: Boolean, default: false }
});

module.exports = mongoose.model('StoreCategory', storeCategorySchema);