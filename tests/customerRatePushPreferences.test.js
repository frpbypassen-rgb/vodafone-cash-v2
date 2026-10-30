'use strict';
jest.mock('../models/WebPushSubscription',()=>({find:jest.fn(),updateOne:jest.fn().mockResolvedValue({})}));
jest.mock('../models/CustomerNotificationPreference',()=>({find:jest.fn()}));
jest.mock('web-push',()=>({setVapidDetails:jest.fn(),sendNotification:jest.fn().mockResolvedValue()}));
const Push=require('../models/WebPushSubscription'),Pref=require('../models/CustomerNotificationPreference'),webpush=require('web-push'),service=require('../services/rateAlerts/webPushService');
test('price preference suppresses actual push delivery only for the matching customer',async()=>{
 const previous={...process.env};process.env.WEB_PUSH_PUBLIC_KEY='test';process.env.WEB_PUSH_PRIVATE_KEY='test';
 try{
 const opted='111111111111111111111111',other='222222222222222222222222';
 Push.find.mockReturnValue({lean:async()=>[{_id:'a',userId:opted,accountType:'user',subscription:{endpoint:'opted'}},{_id:'b',userId:other,accountType:'user',subscription:{endpoint:'other'}}]});
 Pref.find.mockReturnValue({select:()=>({lean:async()=>[{ownerId:opted,ownerModel:'User'}]})});
 await service.sendRateAlertWebPush({payload:{campaignReference:'test',rateChangesText:'test'}});
 expect(webpush.sendNotification).toHaveBeenCalledTimes(1);expect(webpush.sendNotification.mock.calls[0][0].endpoint).toBe('other');
 }finally{for(const key of ['WEB_PUSH_PUBLIC_KEY','WEB_PUSH_PRIVATE_KEY']){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});
