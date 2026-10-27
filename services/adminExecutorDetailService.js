'use strict';
const { systemDateKey, systemDateRange } = require('../config/systemTime');
const { getExecutorPrimaryServiceKey, EXECUTOR_SERVICE_KEYS } = require('../utils/executorServiceCatalog');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tabs = ['ledger', 'operations', 'staff', 'settings'];
const statuses = ['completed','deposit','deduction','deposit_pending','pending','processing','accepted','rejected','cancelled_by_admin'];

function normalizeExecutorDetailQuery(query = {}, now = new Date()) {
    const defaultTab = query.employeePolicyUpdated || query.employeePolicyError ? 'staff' : ['manualPolicyError','manualPolicyUpdated','servicesUpdated','serviceError','receiptPrefixUpdated','receiptPrefixError'].some(key=>query[key]) ? 'settings' : 'ledger';
    const tab = tabs.includes(query.tab) ? query.tab : defaultTab;
    const period = ['today','week','month'].includes(query.period) ? query.period : '';
    let from = String(query.from || '').slice(0,10), to = String(query.to || '').slice(0,10);
    if (period) {
        to = systemDateKey(now);
        from = period === 'today' ? to : period === 'month' ? to.slice(0,8)+'01' : systemDateKey(new Date(now.getTime()-6*86400000));
    }
    const valid = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
    const error = !valid(from) || !valid(to) || from && to && from > to ? 'يرجى اختيار فترة صحيحة.' : '';
    return {tab, period, from, to, error, q:String(query.q || '').trim().slice(0,120),
        status:statuses.includes(query.status) ? query.status : '', service:EXECUTOR_SERVICE_KEYS.includes(query.service) ? query.service : '',
        page:Math.max(1, Math.min(100000, Number.parseInt(query.page,10)||1))};
}

function buildExecutorHistoryPipeline(bot, filters) {
    const ledger = filters.tab === 'ledger';
    const owner = bot.isManagerBot && ledger ? {$or:[
        {executorGroupId:bot._id,status:{$in:['deposit','deduction']}},
        {managerGroupId:bot._id,status:'completed'}
    ]} : {[bot.isManagerBot ? 'managerGroupId' : 'executorGroupId']:bot._id};
    const primary = getExecutorPrimaryServiceKey(bot);
    const normalizeKey = field => ({$switch:{branches:[
        {case:{$in:[field,['cash','vodafone']]},then:'vodafone'},
        {case:{$in:[field,['postal','post_account','post_card']]},then:'postal'},
        ...['bank_account','sefa_niger','bankak_sudan'].map(key=>({case:{$eq:[field,key]},then:key}))
    ],default:null}});
    const pipeline = [{$match:ledger ? {$and:[owner,{status:{$in:['completed','deposit','deduction']},transferType:{$ne:'external_balance'}}]} : owner},
        {$project:{customId:1,amount:1,status:1,transferType:1,canonicalServiceKey:1,createdAt:1,updatedAt:1,completedAt:1,vodafoneNumber:1,accountNumber:1,accountName:1,employeeName:1,executorName:1,notes:1}},
        {$set:{service:{$ifNull:[normalizeKey('$canonicalServiceKey'),{$ifNull:[normalizeKey('$transferType'),primary]}]},
            at:ledger ? {$ifNull:['$completedAt',{$ifNull:['$updatedAt','$createdAt']}]} : '$createdAt',
            movement:{$cond:[{$eq:['$status','deposit']},'$amount',{$multiply:[-1,{$abs:'$amount'}]}]}}}];
    // Calculate balances before filtering: changing dates/search never resets the opening balance.
    if (ledger) pipeline.push({$setWindowFields:{partitionBy:'$service',sortBy:{at:1,_id:1},output:{balanceAfter:{$sum:'$movement',window:{documents:['unbounded','current']}}}}},
        {$set:{balanceBefore:{$subtract:['$balanceAfter','$movement']}}});
    const match = {};
    if (filters.error) match._id = null;
    if (filters.q) { const term = new RegExp(escapeRegex(filters.q),'i'); match.$or=['customId','vodafoneNumber','accountNumber','accountName','employeeName','executorName'].map(key=>({[key]:term})); }
    if (filters.status) match.status = filters.status;
    if (filters.service) match.service = filters.service;
    if (!filters.error && (filters.from || filters.to)) match.at = systemDateRange(filters.from, filters.to);
    pipeline.push({$match:match},{$facet:{rows:[{$sort:{at:-1,_id:-1}},{$skip:(filters.page-1)*20},{$limit:20}],count:[{$count:'total'}]}});
    return pipeline;
}

async function loadExecutorHistory(Transaction, bot, query) {
    const filters = normalizeExecutorDetailQuery(query);
    if (filters.error || !['ledger','operations'].includes(filters.tab)) return {filters,rows:[],total:0,page:1,totalPages:1};
    let [result] = await Transaction.aggregate(buildExecutorHistoryPipeline(bot,filters)).allowDiskUse(true);
    const total = result?.count?.[0]?.total || 0;
    const totalPages = Math.max(1,Math.ceil(total/20));
    if(filters.page>totalPages) { filters.page=totalPages; [result]=await Transaction.aggregate(buildExecutorHistoryPipeline(bot,filters)).allowDiskUse(true); }
    return {filters,rows:result?.rows || [],total,page:filters.page,totalPages};
}
module.exports = {normalizeExecutorDetailQuery,buildExecutorHistoryPipeline,loadExecutorHistory};
