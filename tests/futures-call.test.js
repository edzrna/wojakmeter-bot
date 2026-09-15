const {test}=require('node:test');const assert=require('node:assert/strict');
const {callFutures,createDecisionRunner}=require('../futures-call');
const {createRuntime}=require('../desk-runtime');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('promise-only Futures response settles without a callback',async()=>{
 assert.deepEqual(await callFutures(async()=>({leverage:2})),{leverage:2});
 await assert.rejects(callFutures(async()=>({code:-2015,msg:'Denied'})),/Denied/);
 await assert.rejects(callFutures(()=>{throw Error('sync');}),/sync/);
});
test('timeout reports uncertain outcome once, never retries or accepts late success',async()=>{
 let calls=0,timeouts=0,finish;
 await assert.rejects(callFutures(()=>{calls++;return new Promise(r=>finish=r);},{timeoutMs:10,onTimeout:()=>timeouts++}),/timed out/);
 finish({orderId:9});await wait(1);assert.equal(calls,1);assert.equal(timeouts,1);
});
test('stalled decision cannot block fresh evaluations or spawn overlapping decisions',async()=>{
 let finish,stalls=0,decisions=0;const r=createRuntime();
 const d=createDecisionRunner({timeoutMs:10,onStall:()=>stalls++});
 const cycle=()=>{decisions++;return new Promise(resolve=>finish=resolve);};
 await r.tick(()=>{d.run(cycle);});
 assert.equal(await r.tick(()=>d.run(cycle)),true);
 await wait(20);assert.equal(stalls,1);assert.equal(decisions,1);assert.equal(d.busy,true);
 finish();await wait(1);assert.equal(d.busy,false);
});
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
test('protection uses conditional API and cancellation preserves algo IDs',async()=>{
 const requests=[];const ctx={SL_PCT:1,TP_PCT:2,atGetExchangeInfo:async()=>({}),atGetTickSize:()=>.1,atRoundPrice:x=>x,
 futuresCall:task=>callFutures(task),signedBinanceFuturesRequest:async(path,params,timeout,method)=>{requests.push({path,params,method});return {algoId:requests.length};},console};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function atPlaceSlTpOrders('),source.indexOf('async function atCancelAllOrders(')),ctx);
 const orders=await ctx.atPlaceSlTpOrders('BTCUSDT','BUY',.01,100);
 assert.equal(orders.slOrderId,'algo:1');assert.equal(orders.tpOrderId,'algo:2');
 assert.equal(requests[0].path,'/fapi/v1/algoOrder');assert.equal(requests[0].method,'POST');
 assert.equal(requests[0].params.type,'STOP_MARKET');assert.equal(requests[0].params.triggerPrice,'99');assert.equal(requests[0].params.reduceOnly,'true');assert.equal(requests[0].params.side,'SELL');
 assert.equal(requests[1].params.type,'TAKE_PROFIT_MARKET');
 await ctx.atCancelOrder('BTCUSDT',orders.slOrderId);assert.equal(requests[2].method,'DELETE');assert.equal(requests[2].params.algoId,'1');
});
test('invalid protection acknowledgement cannot be reported as protected',async()=>{
 const ctx={SL_PCT:1,TP_PCT:2,atGetExchangeInfo:async()=>({}),atGetTickSize:()=>.1,atRoundPrice:x=>x,futuresCall:task=>callFutures(task),signedBinanceFuturesRequest:async()=>({}),console};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function atPlaceSlTpOrders('),source.indexOf('async function atCancelOrder(')),ctx);
 await assert.rejects(ctx.atPlaceSlTpOrders('BTCUSDT','BUY',.01,100),/algoId/);
});
