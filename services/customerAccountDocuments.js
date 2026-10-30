'use strict';
const fs = require('fs/promises'),
    path = require('path'),
    crypto = require('crypto');
const mongoose = require('mongoose');
const { context } = require('./businessLoginSecurityContext');
const kinds = { identity: 'الهوية أو جواز السفر', tax_card: 'البطاقة الضريبية', business_license: 'الترخيص' };
const root = () => path.resolve(__dirname, '../private/account-documents');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const ownContext = async (req) => {
    const ctx = await context(req);
    if (ctx.kind !== 'customer') throw fail('غير متاح لهذا الحساب.', 403);
    return ctx;
};
const verificationState = (documents) => {
    const rows = documents.filter((d) => d.kind !== 'profile_photo');
    if (!rows.length) return 'not_submitted';
    if (rows.some((d) => d.reviewStatus === 'rejected')) return 'rejected';
    if (rows.some((d) => d.reviewStatus !== 'approved')) return 'pending';
    return rows.some((d) => d.kind === 'identity') ? 'verified' : 'incomplete';
};
const status = (actor) => {
    const rows = (actor.verificationDocuments || []).filter((d) => kinds[d.kind]);
    return {
        revision: actor.documentRevision || 0,
        verification: verificationState(rows),
        documents: rows.map((d) => ({
            id: String(d._id),
            kind: d.kind,
            title: kinds[d.kind],
            name: d.originalName || kinds[d.kind],
            uploadedAt: d.uploadedAt || null,
            reviewStatus: d.reviewStatus || 'pending',
            reason: d.reviewReason || '',
            reviewedAt: d.reviewedAt || null,
            url: '/client/api/account-documents/' + d._id,
        })),
    };
};
const inspectFile = (file) => {
    const b = file?.buffer;
    if (!Buffer.isBuffer(b) || !b.length || b.length > 5 * 1024 * 1024)
        throw fail('اختر ملفًا لا يتجاوز 5 ميجابايت.');
    if (file.mimetype === 'application/pdf' && b.subarray(0, 5).toString() === '%PDF-') return '.pdf';
    if (file.mimetype === 'image/jpeg' && b[0] === 255 && b[1] === 216 && b[2] === 255) return '.jpg';
    if (
        file.mimetype === 'image/png' &&
        b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
        return '.png';
    if (
        file.mimetype === 'image/webp' &&
        b.subarray(0, 4).toString() === 'RIFF' &&
        b.subarray(8, 12).toString() === 'WEBP'
    )
        return '.webp';
    throw fail('محتوى الملف أو نوعه غير مدعوم. استخدم PDF أو JPG أو PNG أو WEBP.', 422);
};
const revisionFilter = (revision) => {
    if (!Number.isSafeInteger(revision) || revision < 0) throw fail('حدّث الصفحة قبل المتابعة.', 409);
    return revision === 0
        ? { $or: [{ documentRevision: 0 }, { documentRevision: { $exists: false } }] }
        : { documentRevision: revision };
};
const upload = async (ctx, body, file) => {
    const extension = inspectFile(file),
        kind = String(body.kind || ''),
        revision = Number(body.revision);
    if (!kinds[kind]) throw fail('اختر نوع الوثيقة.');
    const filter = revisionFilter(revision);
    const rows = ctx.actor.verificationDocuments.map((d) => (d.toObject ? d.toObject() : d));
    const previous = rows.find((d) => d.kind === kind);
    if (previous && previous.reviewStatus !== 'rejected')
        throw fail('هذه الوثيقة محفوظة بالفعل. انتظر المراجعة أو تواصل مع الدعم.', 409);
    const filename = crypto.randomUUID() + extension,
        id = new mongoose.Types.ObjectId();
    await fs.mkdir(root(), { recursive: true });
    const fullPath = path.join(root(), filename);
    await fs.writeFile(fullPath, file.buffer, { flag: 'wx', mode: 0o600 });
    try {
        const next = [
            ...rows.filter((d) => d.kind !== kind),
            {
                _id: id,
                kind,
                fileUrl: '/private/account-documents/' + filename,
                originalName: path
                    .basename(String(file.originalname || kinds[kind]))
                    .replace(/[\x00-\x1f\x7f]/g, '')
                    .slice(0, 180),
                uploadedAt: new Date(),
                reviewStatus: 'pending',
                reviewReason: '',
                reviewedAt: null,
            },
        ];
        const result = await ctx.Model.updateOne(
            { _id: ctx.actor._id, tenantId: ctx.actor.tenantId || null, ...filter },
            { $set: { verificationDocuments: next }, $inc: { documentRevision: 1 } }
        );
        if (!result.modifiedCount) throw fail('تغيّرت الوثائق. حدّث الصفحة قبل إعادة المحاولة.', 409);
    } catch (error) {
        await fs.unlink(fullPath).catch(() => {});
        throw error;
    }
    return { id: String(id), kind };
};
const filePath = (url) => {
    const privateMatch = /^\/private\/account-documents\/([a-f0-9-]{36}\.(?:jpg|png|webp|pdf))$/.exec(
        url || ''
    );
    if (privateMatch) return path.join(root(), privateMatch[1]);
    const legacy =
        /^\/uploads\/account-documents\/(account-document-[a-f0-9-]{36}\.(?:jpg|png|webp|pdf))$/.exec(
            url || ''
        );
    if (legacy) return path.resolve(__dirname, '../uploads', legacy[1]);
    throw fail('الوثيقة غير متاحة للتحميل. تواصل مع الدعم.', 404);
};
const download = async (actor, id, res) => {
    const doc = actor.verificationDocuments.find((d) => String(d._id) === String(id) && kinds[d.kind]);
    if (!doc) throw fail('الوثيقة غير موجودة.', 404);
    const target = filePath(doc.fileUrl);
    const info = await fs.lstat(target).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw fail('الوثيقة غير متاحة.', 404);
    res.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
    });
    return res.download(target, 'document' + path.extname(target));
};
const review = async ({ Model, actor, id, revision, result, reason }) => {
    if (!['approved', 'rejected'].includes(result)) throw fail('حالة مراجعة غير صالحة.');
    const explanation = String(reason || '').trim();
    if (explanation.length > 500 || (result === 'rejected' && !explanation))
        throw fail('أدخل سببًا واضحًا بحد أقصى 500 حرف.');
    const changed = await Model.updateOne(
        {
            _id: actor._id,
            ...revisionFilter(Number(revision)),
            verificationDocuments: { $elemMatch: { _id: id, kind: { $in: Object.keys(kinds) } } },
        },
        {
            $set: {
                'verificationDocuments.$.reviewStatus': result,
                'verificationDocuments.$.reviewReason': result === 'rejected' ? explanation : '',
                'verificationDocuments.$.reviewedAt': new Date(),
            },
            $inc: { documentRevision: 1 },
        }
    );
    if (!changed.modifiedCount) throw fail('تغيّرت الوثائق. حدّث الصفحة ثم راجعها من جديد.', 409);
};
module.exports = {
    kinds,
    ownContext,
    verificationState,
    status,
    inspectFile,
    filePath,
    upload,
    download,
    review,
};
