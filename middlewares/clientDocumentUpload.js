'use strict';
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('node:fs/promises');
const { parseExecutorImageDataUrl } = require('../utils/executorImageValidation');
const receive = multer({
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

// MIME is supplied by the browser. Validate the actual bytes and dimensions
// before a file can be attached to a financial request. Multer removes partial
// files on its own errors; content failures must remove the complete file too.
module.exports = {
    single(field) {
        const parse = receive.single(field);
        return (req, res, next) => parse(req, res, async (error) => {
            if (error || !req.file) return next(error);
            try {
                const buffer = await fs.readFile(req.file.path);
                parseExecutorImageDataUrl(`data:${req.file.mimetype};base64,${buffer.toString('base64')}`, {
                    maxBytes: 5 * 1024 * 1024,
                    errorCode: 'INVALID_DOCUMENT_CONTENT'
                });
            } catch (_error) {
                const filePath = req.file.path;
                delete req.file;
                try { await fs.unlink(filePath); } catch (_cleanupError) {
                    // Do not accept the transfer if temporary storage is unhealthy.
                    return next(Object.assign(new Error('DOCUMENT_STORAGE_UNAVAILABLE'), { statusCode: 503 }));
                }
                return next(Object.assign(new Error('INVALID_DOCUMENT_CONTENT'), { statusCode: 422 }));
            }
            const filePath = req.file.path;
            res.once('finish', () => {
                // PIN/permission middleware can end the request before the
                // transfer controller runs. Only a committed attachment survives.
                if (!req.clientDocumentAttached) fs.unlink(filePath).catch(() => {});
            });
            return next();
        });
    }
};
