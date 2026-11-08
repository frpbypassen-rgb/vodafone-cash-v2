'use strict';

const inlineExecutorProof = (value) => /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(value);
const partFile = /^(?:\/?uploads\/)?(?:proofs\/)?[\w.-]+\.(?:jpe?g|png|webp)$/i;

const getExecutorProofIds = (tx, official = []) => {
    const uploads = Array.isArray(tx.executorProofImages) ? tx.executorProofImages : [];
    const entries = Array.isArray(tx.executorSenderEntries) ? tx.executorSenderEntries : [];
    const reference = String(tx.customId || tx._id || '');
    const prefixes = [
        reference.replace(/[^\w.-]/g, '_'),
        String(tx.customId || reference.slice(-6)).replace(/[^\w-]/g, '')
    ].filter(Boolean);
    // Older mobile rows can contain an inline upload. Only accept stored part
    // filenames issued for this transaction, never a submitted remote URL.
    const parts = entries
        .map(entry => entry?.proofImage)
        .filter(value => typeof value === 'string' && (inlineExecutorProof(value) || (
            partFile.test(value) && prefixes.some(prefix => {
                const name = value.split('/').pop();
                return name.startsWith(prefix + '_') && name.includes('_sender_');
            })
        )));
    return [...new Set([...uploads, ...parts])]
        .filter(value => typeof value === 'string' && value && !official.includes(value));
};

module.exports = { getExecutorProofIds, inlineExecutorProof };
