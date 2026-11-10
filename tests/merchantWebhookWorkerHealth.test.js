'use strict';
jest.mock('../services/merchantRateWebhookService',()=>({stageMerchantRateWebhooks:jest.fn(async()=>({staged:0,failed:0}))}));
jest.mock('../services/merchantWebhookOutboxService',()=>({drain:jest.fn(),queueStats:jest.fn()}));
jest.mock('../models/MerchantWebhookDelivery',()=>({find:jest.fn(()=>({sort:()=>({limit:()=>({select:()=>({lean:async()=>[]})})})}))}));
jest.mock('../utils/logger',()=>({warn:jest.fn(),error:jest.fn(),info:jest.fn()}));
const outbox=require('../services/merchantWebhookOutboxService');
const Delivery=require('../models/MerchantWebhookDelivery');
const logger=require('../utils/logger');
const {runMerchantWebhookTick}=require('../services/merchantWebhookService');
const previous=process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;
afterAll(()=>{if(previous===undefined)delete process.env.MERCHANT_WEBHOOK_WORKER_ENABLED;else process.env.MERCHANT_WEBHOOK_WORKER_ENABLED=previous;});
test('overlapping ticks are coalesced and lag warnings contain only aggregate counts',async()=>{
 process.env.MERCHANT_WEBHOOK_WORKER_ENABLED='true';let release;
 outbox.drain.mockReturnValueOnce(new Promise(resolve=>{release=resolve;}));
 outbox.queueStats.mockResolvedValue({available:true,pendingEvents:5,pendingDeliveries:2,oldestAgeSeconds:180,delayed:true});
 const first=runMerchantWebhookTick();
 expect(await runMerchantWebhookTick()).toEqual({skipped:true});
 release({ready:true,staged:1,failed:0});await first;
 expect(outbox.drain).toHaveBeenCalledTimes(1);
 expect(logger.warn).toHaveBeenCalledWith('Merchant webhook queue delayed',{pendingEvents:5,pendingDeliveries:2,oldestAgeSeconds:180});
 outbox.drain.mockResolvedValue({ready:true,staged:0,failed:0});await runMerchantWebhookTick();
 expect(logger.warn).toHaveBeenCalledTimes(1);
});
test('a disabled worker does not inspect or process queued financial documents',async()=>{
 process.env.MERCHANT_WEBHOOK_WORKER_ENABLED='false';outbox.drain.mockClear();outbox.queueStats.mockClear();
 expect(await runMerchantWebhookTick()).toEqual({skipped:true});expect(outbox.drain).not.toHaveBeenCalled();expect(outbox.queueStats).not.toHaveBeenCalled();
});
test('an outbox scan failure does not stop dispatch of already queued webhooks', async () => {
    process.env.MERCHANT_WEBHOOK_WORKER_ENABLED = 'true';
    Delivery.find.mockClear();
    outbox.drain.mockRejectedValueOnce(new Error('outbox query failed'));
    const stats = { available: true, delayed: false, pendingDeliveries: 0 };
    outbox.queueStats.mockResolvedValueOnce(stats);

    await expect(runMerchantWebhookTick()).resolves.toEqual(stats);
    expect(Delivery.find).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Merchant webhook outbox scan failed', { error: 'outbox query failed' });
});
