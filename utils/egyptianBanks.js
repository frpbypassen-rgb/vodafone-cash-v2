'use strict';

// Active Egyptian banks that can receive a customer transfer (account or IBAN).
// The Central Bank of Egypt is intentionally absent: it is not a customer destination.
// Codes are stable storage keys. Display names are Arabic.

const BANK_REQUIRED_ERROR = 'اختر البنك قبل إرسال التحويل البنكي.';
const BANK_INVALID_ERROR = 'البنك المختار غير مدرج ضمن البنوك المصرية المعتمدة.';

const EGYPTIAN_BANKS = Object.freeze([
    Object.freeze({ code: 'nbe', nameAr: 'البنك الأهلي المصري', aliases: Object.freeze(['nbe', 'الاهلي المصري']) }),
    Object.freeze({ code: 'bmisr', nameAr: 'بنك مصر', aliases: Object.freeze(['banque misr']) }),
    Object.freeze({ code: 'cib', nameAr: 'البنك التجاري الدولي CIB', aliases: Object.freeze(['cib', 'التجاري الدولي']) }),
    Object.freeze({ code: 'qnb', nameAr: 'بنك قطر الوطني الأهلي QNB', aliases: Object.freeze(['qnb', 'qnb الاهلي']) }),
    Object.freeze({ code: 'bdc', nameAr: 'بنك القاهرة', aliases: Object.freeze(['banque du caire']) }),
    Object.freeze({ code: 'aaib', nameAr: 'البنك العربي الأفريقي الدولي', aliases: Object.freeze(['aaib']) }),
    Object.freeze({ code: 'adib', nameAr: 'مصرف أبوظبي الإسلامي ADIB', aliases: Object.freeze(['adib', 'ابو ظبي الاسلامي', 'بنك ابو ظبي الاسلامي مصر']) }),
    Object.freeze({ code: 'faisal', nameAr: 'بنك فيصل الإسلامي المصري', aliases: Object.freeze(['faisal']) }),
    Object.freeze({ code: 'saib', nameAr: 'بنك الشركة المصرفية العربية الدولية saib', aliases: Object.freeze(['saib', 'بنك الشركه المصرفيه العربيه الدوليه SAIB']) }),
    Object.freeze({ code: 'hsbc', nameAr: 'بنك HSBC مصر', aliases: Object.freeze(['hsbc']) }),
    Object.freeze({ code: 'alexbank', nameAr: 'بنك الإسكندرية', aliases: Object.freeze(['alexbank', 'بنك الاسكندريه']) }),
    Object.freeze({ code: 'aub', nameAr: 'البنك الأهلي المتحد مصر', aliases: Object.freeze(['aub', 'الاهلي المتحد']) }),
    Object.freeze({ code: 'aib', nameAr: 'المصرف العربي الدولي', aliases: Object.freeze(['arab international bank']) }),
    Object.freeze({ code: 'abc', nameAr: 'بنك المؤسسة العربية المصرفية ABC', aliases: Object.freeze(['abc']) }),
    Object.freeze({ code: 'blom', nameAr: 'بنك بلوم مصر', aliases: Object.freeze(['blom']) }),
    Object.freeze({ code: 'enbd', nameAr: 'بنك الإمارات دبي الوطني مصر', aliases: Object.freeze(['enbd', 'الامارات دبي الوطني']) }),
    Object.freeze({ code: 'adcb', nameAr: 'بنك أبوظبي التجاري ADCB', aliases: Object.freeze(['adcb', 'ابوظبي التجاري', 'بنك ابو ظبي التجاري مصر']) }),
    Object.freeze({ code: 'mashreq', nameAr: 'بنك المشرق', aliases: Object.freeze(['mashreq', 'بنك المشرق مصر']) }),
    Object.freeze({ code: 'audi', nameAr: 'بنك عوده مصر', aliases: Object.freeze(['audi', 'عوده']) }),
    Object.freeze({ code: 'nbk', nameAr: 'بنك الكويت الوطني مصر', aliases: Object.freeze(['nbk', 'الكويت الوطني']) }),
    Object.freeze({ code: 'awb', nameAr: 'التجاري وفا بنك إيجيبت', aliases: Object.freeze(['attijariwafa', 'التجاري وفا']) }),
    Object.freeze({ code: 'idb', nameAr: 'بنك التنمية الصناعية', aliases: Object.freeze(['idb', 'التنميه الصناعيه']) }),
    Object.freeze({ code: 'hdb', nameAr: 'بنك التعمير والإسكان', aliases: Object.freeze(['hdb', 'التعمير والاسكان']) }),
    Object.freeze({ code: 'ealbank', nameAr: 'البنك العقاري المصري العربي', aliases: Object.freeze(['ealbank', 'العقاري المصري']) }),
    Object.freeze({ code: 'abe', nameAr: 'البنك الزراعي المصري', aliases: Object.freeze(['abe', 'الزراعي المصري']) }),
    Object.freeze({ code: 'ub', nameAr: 'المصرف المتحد', aliases: Object.freeze(['the united bank']) }),
    Object.freeze({ code: 'albaraka', nameAr: 'بنك البركة مصر', aliases: Object.freeze(['albaraka', 'البركه']) }),
    Object.freeze({ code: 'scbank', nameAr: 'بنك قناة السويس', aliases: Object.freeze(['suez canal bank']) }),
    Object.freeze({ code: 'arabbank', nameAr: 'البنك العربي', aliases: Object.freeze(['arab bank']) }),
    Object.freeze({ code: 'cae', nameAr: 'بنك كريدي أجريكول مصر', aliases: Object.freeze(['credit agricole', 'كريدي اجريكول']) }),
    Object.freeze({ code: 'abk', nameAr: 'البنك الأهلي الكويتي مصر', aliases: Object.freeze(['abk', 'الاهلي الكويتي']) }),
    Object.freeze({ code: 'aibk', nameAr: 'بنك الاستثمار العربي', aliases: Object.freeze(['arab investment bank']) }),
    Object.freeze({ code: 'citi', nameAr: 'سيتي بنك مصر', aliases: Object.freeze(['citibank', 'citi']) }),
    Object.freeze({ code: 'egbank', nameAr: 'البنك المصري الخليجي EGBANK', aliases: Object.freeze(['egbank']) }),
    Object.freeze({ code: 'ebe', nameAr: 'البنك المصري لتنمية الصادرات', aliases: Object.freeze(['edbe', 'تنميه الصادرات']) }),
    Object.freeze({ code: 'fab', nameAr: 'بنك أبوظبي الأول مصر FAB', aliases: Object.freeze(['fab', 'ابو ظبي الاول']) }),
    Object.freeze({ code: 'next', nameAr: 'بنك نكست', aliases: Object.freeze(['next bank', 'نكست']) })
]);

const BANK_TRANSFER_KEYS = new Set(['bank_account', 'bank_transfer']);

const normalizeBankToken = (value) => String(value || '')
    .trim()
    .replace(/\u0640/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const BANK_INDEX = new Map();
EGYPTIAN_BANKS.forEach((bank) => {
    [bank.code, bank.nameAr, ...(bank.aliases || [])].forEach((token) => {
        const key = normalizeBankToken(token);
        if (key && !BANK_INDEX.has(key)) BANK_INDEX.set(key, bank);
    });
});

const isBankTransferService = (...values) => values.some((value) => (
    BANK_TRANSFER_KEYS.has(String(value || '').trim().toLowerCase())
));

const resolveEgyptianBank = (value) => BANK_INDEX.get(normalizeBankToken(value)) || null;

const readBankInput = (source = {}) => String(
    source.bankCode
    || source.bank_code
    || source.bankName
    || source.bank_name
    || source.bank
    || source.serviceDetails?.bankCode
    || source.serviceDetails?.bankName
    || ''
).trim();

const normalizeStoredBank = (source = {}) => {
    const required = isBankTransferService(
        source.transferType,
        source.serviceKey,
        source.canonicalServiceKey
    );
    if (!required) return { required: false, bank: null, error: null, code: null };
    const raw = readBankInput(source);
    const bank = resolveEgyptianBank(raw);
    if (bank) return { required: true, bank, error: null, code: null };
    return {
        required: true,
        bank: null,
        error: raw ? BANK_INVALID_ERROR : BANK_REQUIRED_ERROR,
        code: raw ? 'BANK_INVALID' : 'BANK_REQUIRED'
    };
};

const bankLabelForTransaction = (transaction = {}) => {
    const details = transaction.serviceDetails || {};
    const storedName = String(details.bankName || transaction.bankName || '').trim();
    if (storedName) {
        return resolveEgyptianBank(storedName)?.nameAr || storedName;
    }
    return resolveEgyptianBank(details.bankCode || transaction.bankCode)?.nameAr || '';
};

const formatClientReceiptAccountName = (transaction = {}, displayedName = '') => {
    const name = String(displayedName || '').trim();
    const bank = bankLabelForTransaction(transaction);
    const beneficiary = String(transaction.accountName || '').trim();
    if (!bank || !name || !beneficiary || name !== beneficiary || name.includes(bank)) return name;
    return `${name} — ${bank}`;
};

module.exports = {
    BANK_INVALID_ERROR,
    BANK_REQUIRED_ERROR,
    BANK_TRANSFER_KEYS,
    EGYPTIAN_BANKS,
    bankLabelForTransaction,
    formatClientReceiptAccountName,
    isBankTransferService,
    normalizeBankToken,
    normalizeStoredBank,
    resolveEgyptianBank
};
