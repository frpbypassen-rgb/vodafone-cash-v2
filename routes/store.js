// routes/store.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const Card = require('../models/Card');
const StoreCategory = require('../models/StoreCategory');
const StoreProduct = require('../models/StoreProduct');
const { requireAuth } = require('../middlewares/auth');

// 🛡️ حماية رفع الملفات (الحد الأقصى 5 ميجا بايت)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } 
});

router.use(requireAuth);

router.get('/', async (req, res) => {
    try {
        const inventoryStats = await Card.aggregate([
            { $group: { _id: { category: "$category", name: "$name" }, total: { $sum: 1 }, unsold: { $sum: { $cond: [{ $eq: ["$sold", false] }, 1, 0] } }, price_1: { $first: "$price_1" } } },
            { $sort: { "_id.category": 1, "_id.name": 1 } }
        ]);
        const categoriesMeta = await StoreCategory.find({});
        const productsMeta = await StoreProduct.find({});
        res.render('store_manager', { inventoryStats: inventoryStats || [], categoriesMeta: categoriesMeta || [], productsMeta: productsMeta || [], adminName: req.session.adminName });
    } catch (e) { res.redirect('/'); }
});

router.get('/product/excel-template', async (req, res) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Cards');
    worksheet.columns = [
        { header: 'category', key: 'category', width: 15 }, { header: 'subcategory', key: 'subcategory', width: 15 }, { header: 'name', key: 'name', width: 25 },
        { header: 'price_1', key: 'price_1', width: 10 }, { header: 'price_2', key: 'price_2', width: 10 }, { header: 'price_3', key: 'price_3', width: 10 },
        { header: 'code', key: 'code', width: 15 }, { header: 'serial', key: 'serial', width: 20 }, { header: 'pin', key: 'pin', width: 20 }, { header: 'op_code', key: 'op_code', width: 15 }
    ];
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002060' } };
    worksheet.addRow({ category: 'ALAHRAM', subcategory: '5', name: 'ALAHRAM 5L.Y', price_1: 4.375, price_2: 4.375, price_3: 4.375, code: '5403103', serial: '225581000', pin: '166223', op_code: '42302' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Cards_Inventory_Template.xlsx"');
    await workbook.xlsx.write(res); res.end();
});

router.post('/product/import-excel', upload.single('excelFile'), async (req, res) => {
    try {
        if (!req.file) return res.redirect('/store-manager?error=nofile');
        
        // 🛡️ التحقق من أن الملف إكسيل فعلاً
        if (!req.file.originalname.match(/\.(xlsx|xls)$/)) {
            return res.redirect('/store-manager?error=invalid_file');
        }

        const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(req.file.buffer);
        const worksheet = workbook.worksheets[0];
        let cardsToInsert = []; let categoriesSet = new Set(); let productsMap = new Map();

        for (let i = 2; i <= worksheet.rowCount; i++) {
            const row = worksheet.getRow(i);
            const category = row.getCell(1).value?.toString().trim() || '';
            const name = row.getCell(3).value?.toString().trim() || '';
            if (category && name) {
                cardsToInsert.push({
                    category: category, subcategory: row.getCell(2).value?.toString().trim() || '', name: name,
                    price_1: parseFloat(row.getCell(4).value) || 0, price_2: parseFloat(row.getCell(5).value) || 0, price_3: parseFloat(row.getCell(6).value) || 0,
                    code: row.getCell(7).value?.toString().trim() || '', serial: row.getCell(8).value?.toString().trim() || '', pin: row.getCell(9).value?.toString().trim() || '', op_code: row.getCell(10).value?.toString().trim() || '', sold: false
                });
                categoriesSet.add(category); productsMap.set(`${category}|||${name}`, { categoryName: category, name: name });
            }
        }
        if (cardsToInsert.length > 0) {
            await Card.insertMany(cardsToInsert);
            for (const cat of categoriesSet) await StoreCategory.updateOne({ name: cat }, { $setOnInsert: { name: cat, icon: 'fa-layer-group', color: '#001a4d', image: '' } }, { upsert: true });
            for (const [key, val] of productsMap.entries()) await StoreProduct.updateOne({ categoryName: val.categoryName, name: val.name }, { $setOnInsert: { categoryName: val.categoryName, name: val.name, image: '' } }, { upsert: true });
        }
        res.redirect(`/store-manager?success=imported&count=${cardsToInsert.length}`);
    } catch (e) { res.redirect('/store-manager?error=import_failed'); }
});

router.post('/delete-group', async (req, res) => {
    try { await Card.deleteMany({ category: req.body.category, name: req.body.name, sold: false }); res.redirect('/store-manager'); } catch(e) { res.redirect('/store-manager'); }
});

router.post('/category/:id/update', async (req, res) => {
    try {
        const { icon, color, imageBase64 } = req.body; let updateData = { icon, color };
        if (imageBase64) updateData.image = imageBase64;
        await StoreCategory.findByIdAndUpdate(req.params.id, updateData); res.redirect('/store-manager');
    } catch (e) { res.redirect('/store-manager'); }
});

router.post('/product/:id/update', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (imageBase64) await StoreProduct.findByIdAndUpdate(req.params.id, { image: imageBase64 });
        res.redirect('/store-manager');
    } catch (e) { res.redirect('/store-manager'); }
});

module.exports = router;