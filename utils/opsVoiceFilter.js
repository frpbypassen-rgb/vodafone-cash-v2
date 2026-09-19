'use strict';

const parseVoiceFilter = (transcript) => {
    const text = String(transcript || '').toLowerCase();
    const result = {};
    if (/فشل|فاشل|failed|rejected/.test(text)) result.status = 'failed';
    else if (/معلق|pending/.test(text)) result.status = 'pending';
    else if (/نجاح|ناجح|مكتمل|success/.test(text)) result.status = 'success';
    else if (/ملغ|cancel/.test(text)) result.status = 'cancelled';
    if (/آخر ساعة|last hour/.test(text) || /ساعة/.test(text)) result.range = '1h';
    else if (/اليوم|today|24|يوم/.test(text)) result.range = '24h';
    if (/فودافون|vodafone/.test(text)) result.type = 'vodafone';
    else if (/بريد|post/.test(text)) result.type = 'post_account';
    else if (/بنك|bank/.test(text)) result.type = 'bank_account';
    const amount = text.match(/(\d{3,})/);
    if (/أكبر|أكثر|above|greater|>/.test(text) && amount) result.minAmount = amount[1];
    else if (/مبلغ كبير|large/.test(text)) result.minAmount = '10000';
    return result;
};

module.exports = { parseVoiceFilter };
