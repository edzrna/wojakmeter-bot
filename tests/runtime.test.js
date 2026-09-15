const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {createRuntime, normalizeContext, mood} = require('../desk-runtime');
test('canonical emotion boundaries', () => {
  assert.deepEqual([0,19,20,34,35,44,45,59,60,69,70,84,85,100].map(mood), ['frustration','frustration','concern','concern','doubt','doubt','neutral','neutral','optimism','optimism','content','content','euphoria','euphoria']);
});
test('reject invalid or stale index instead of manufacturing neutral', () => {
  const now=2e9;
  assert.throws(()=>normalizeContext({ok:true,score:null,ts:now},now));
  assert.throws(()=>normalizeContext({ok:true,score:60,ts:now-1800001},now));
  assert.equal(normalizeContext({ok:true,score:60,ts:now},now).mood,'optimism');
});
test('overlapping scheduler cycles are skipped', async () => {
  const r=createRuntime(); let finish; let calls=0;
  const first=r.tick(()=>new Promise(resolve=>{calls++;finish=resolve;}));
  assert.equal(await r.tick(()=>calls++),false); assert.equal(calls,1);
  finish();await first;assert.equal(r.state.evaluating,false);
});
test('entry lock covers asynchronous order work and releases on error', async () => {
  const r=createRuntime();let finish;let orders=0;
  const first=r.exclusive(()=>true,()=>new Promise(resolve=>{orders++;finish=resolve;}));
  assert.equal(await r.exclusive(()=>true,()=>orders++),false);
  finish();await first;
  await assert.rejects(r.exclusive(()=>true,()=>{throw Error('exchange');}));
  assert.equal(r.state.executionBusy,false);assert.equal(orders,1);
  assert.equal(await r.exclusive(()=>false,()=>orders++),false);
});
test('failed refresh clears previous market context',async()=>{
  const r=createRuntime({fetcher:async()=>{throw Error('offline');}});
  r.state.context={score:60};await r.refreshContext();
  assert.equal(r.state.context,null);assert.equal(r.state.contextError,'offline');
});
const source=fs.readFileSync(require.resolve('../index.js'),'utf8');
function engineContext(extra={}) {
  const ctx={console:{log(){},error(){}},Date,autoTradeActive:true,canOpenTrade:()=>true,smartAtState:{paused:false,lastExecutionTs:0,totalAutoTrades:0},SMART_AT:{cooldownMs:0,autoExecuteOnTriple:false,autoOnMedium:false,autoOnLow:false},pendingConfirm:null,sendPrivate:async()=>{},sendPrivateError:async()=>{},...extra};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('async function smartEvaluateAndTrade('), source.indexOf('async function executeAutoInternal(')),ctx);
  return ctx;
}
test('high alignment with confirmation enabled stages once; never auto-executes',async()=>{
  let staged=0;let orders=0;const ctx=engineContext({atExecuteTrade:async()=>{staged++;},smartExecuteAuto:async()=>{orders++;}});
  await ctx.smartEvaluateAndTrade({ts:Date.now(),direction:'LONG',confidence:'high',alignedCount:3,globalScore:70,details:[]});
  assert.equal(staged,1);assert.equal(orders,0);
});
test('explicit auto mode executes high alignment and records only success',async()=>{
  let orders=0;const ctx=engineContext({SMART_AT:{cooldownMs:0,autoExecuteOnTriple:true},smartExecuteAuto:async()=>{orders++;return true;}});
  await ctx.smartEvaluateAndTrade({ts:Date.now(),direction:'LONG',confidence:'high',alignedCount:3});
  assert.equal(orders,1);assert.equal(ctx.smartAtState.totalAutoTrades,1);
});
test('invalid evaluation and paused engine never execute',async()=>{
  let orders=0;const ctx=engineContext({smartExecuteAuto:async()=>{orders++;}});
  await ctx.smartEvaluateAndTrade({error:'missing input',direction:'LONG',confidence:'high'});
  ctx.smartAtState.paused=true;
  await ctx.smartEvaluateAndTrade({ts:Date.now(),direction:'LONG',confidence:'high'});assert.equal(orders,0);
});
test('protection failure retains the actual entry and pauses further entries',async()=>{
  const ctx={console:{log(){},error(){}},Date,AT_LEVERAGE:2,PERSONAL_PLAN:{riskPerTrade:2},SL_PCT:1,TP_PCT:2,
    entryAllowed:()=>true,atSetLeverage:async()=>{},atGetMarkPrice:async()=>100,atGetExchangeInfo:async()=>({}),calculateQtyByRisk:()=>({qty:1}),
    sendPrivate:async()=>{},sendPrivateError:async()=>{},atPlaceMarketOrder:async()=>({orderId:1,avgPrice:'100'}),sleep:async()=>{},
    atPlaceSlTpOrders:async()=>{throw Error('protection rejected');},openPosition:null,lastTradeSignalTs:0,personalTradingState:{tradesToday:0},smartAtState:{},escapeHTML:x=>x,formatUsd:x=>x};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('async function executeAutoInternal('),source.indexOf('function recordSmartTradeResult(')),ctx);
  assert.equal(await ctx.executeAutoInternal('BTCUSDT','BUY',70,{}),false);
  assert.equal(ctx.openPosition.entryPrice,100);
  assert.equal(ctx.openPosition.protectionPending,true);
  assert.equal(ctx.personalTradingState.tradesToday,1);
  assert.equal(ctx.smartAtState.paused,true);
});
test('startup gate, cross-engine positions and daily limit block new entries',()=>{
  const ctx={runtime:{state:{ready:false}},resetPersonalStateIfNewDay(){},smartAtState:{paused:false},autoTradeActive:true,openPosition:null,pendingConfirm:null,emotionTrader:{getEmoPosition:()=>null,getPending:()=>null},personalTradingState:{coolingDown:false,tradesToday:0,pnlToday:0},PERSONAL_PLAN:{maxTradesPerDay:5,maxDailyLoss:10,dailyProfitLock:20}};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function entryAllowed('),source.indexOf('function entryTask(')),ctx);
  assert.equal(ctx.entryAllowed('smart'),false);
  ctx.runtime.state.ready=true;assert.equal(ctx.entryAllowed('smart'),true);
  ctx.emotionTrader.getEmoPosition=()=>({symbol:'ETHUSDT'});assert.equal(ctx.entryAllowed('smart'),false);
  ctx.emotionTrader.getEmoPosition=()=>null;ctx.personalTradingState.tradesToday=5;assert.equal(ctx.entryAllowed('smart'),false);
});
test('two aligned signals execute only when enabled, and conflict/stale signals never execute',async()=>{
 let orders=0;const ctx=engineContext({SMART_AT:{cooldownMs:0,autoExecuteOnTriple:true,autoOnMedium:true},smartExecuteAuto:async()=>{orders++;return true;}});
 const ev={ts:Date.now(),direction:'SHORT',confidence:'medium',alignedCount:2};
 await ctx.smartEvaluateAndTrade(ev);assert.equal(orders,1);
 await ctx.smartEvaluateAndTrade({...ev,conflict:true});
 await ctx.smartEvaluateAndTrade({...ev,ts:Date.now()-121000});
 await ctx.smartEvaluateAndTrade({...ev,alignedCount:1});assert.equal(orders,1);
});
