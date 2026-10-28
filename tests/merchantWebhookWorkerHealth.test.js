'use strict';
jest.mock('../services/merchantWebhookOutboxService',()=>({drain:jest.fn(),queueStats:jest.fn()}));
jest.mock('../models/MerchantWebhookDelivery',()=>({find:jest.fn(()=>({sort:()=>({limit:()=>({select:()=>({lean:async()=>[]})})})}))}));
jest.mock('../utils/logger',()=>({warn:jest.fn(),error:jest.fn(),info:jest.fn()}));
const outbox=require('../services/merchantWebhookOutboxService');
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
