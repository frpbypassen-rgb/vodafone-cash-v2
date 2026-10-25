'use strict';
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
module.exports = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, callback) => callback(null, path.join(__dirname, '../uploads')),
        filename: (_req, file, callback) => {
            const extension =
                file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
            callback(null, `client-document-${crypto.randomUUID()}${extension}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fieldArrayIndexLimit: 16 },
    fileFilter: (_req, file, callback) => {
        const allowed = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
        if (!allowed.has(file.mimetype)) return callback(new Error('INVALID_DOCUMENT_TYPE'));
        return callback(null, true);
    },
});
