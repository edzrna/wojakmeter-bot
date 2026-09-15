process.env.COINGECKO_LEGACY_ENABLED="true";
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createMarketClient}=require('../market-http');
const root='https://api.coingecko.com/api/v3';
const response=(status,data={},retry=null)=>({status,ok:status===200,headers:{get:()=>retry},json:async()=>data});
test('simultaneous duplicate reads share one request and cache',async()=>{
 let calls=0,t=0;const c=createMarketClient({spacing:0,now:()=>t,fetcher:async()=>{calls++;return response(200,[{symbol:'btc'}]);}});
 await Promise.all([c.get(root+'/coins/markets'),c.get(root+'/coins/markets')]);assert.equal(calls,1);
 await c.get(root+'/coins/markets');assert.equal(calls,1);t=21600001;await c.get(root+'/coins/markets');assert.equal(calls,2);
});
test('429 respects Retry-After and blocks other endpoints without requests',async()=>{
 let calls=0,t=0;const c=createMarketClient({spacing:0,now:()=>t,fetcher:async()=>{calls++;return response(429,{},'300');}});
 await assert.rejects(c.get(root+'/global'),e=>e.retryAt===300000);
 await assert.rejects(c.get(root+'/search/trending'));assert.equal(calls,1);
 t=299999;await assert.rejects(c.get(root+'/global'));assert.equal(calls,1);
});
test('success after cooldown restores access',async()=>{
 let calls=0,t=0;const c=createMarketClient({spacing:0,now:()=>t,fetcher:async()=>++calls===1?response(429):response(200,{data:{market_cap_change_percentage_24h_usd:1}})});
 await assert.rejects(c.get(root+'/global'));t=60001;const data=await c.get(root+'/global');assert.equal(data.data.market_cap_change_percentage_24h_usd,1);
});
test('expired data is not returned when source fails',async()=>{
 let t=0,fail=false;const c=createMarketClient({spacing:0,now:()=>t,fetcher:async()=>response(fail?429:200,[{symbol:'btc'}])});
 await c.get(root+'/coins/markets');t=21600001;fail=true;await assert.rejects(c.get(root+'/coins/markets'));
});
test('invalid data is never cached',async()=>{
 let calls=0;const c=createMarketClient({spacing:0,fetcher:async()=>{calls++;return response(200,[]);}});
 await assert.rejects(c.get(root+'/coins/markets'));await assert.rejects(c.get(root+'/coins/markets'));assert.equal(calls,2);
});
test('HTTP date Retry-After is supported',async()=>{
 const c=createMarketClient({spacing:0,now:()=>0,fetcher:async()=>response(429,{},new Date(600000).toUTCString())});
 await assert.rejects(c.get(root+'/global'),e=>e.retryAt===600000);
});
