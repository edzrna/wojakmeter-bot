const {test}=require('node:test');const assert=require('node:assert/strict');
const {candleMetrics,summarize,createBinanceMarket}=require('../binance-market');
const NOW=900000*100;
const candles=()=>Array.from({length:10},(_,i)=>[(90+i)*900000,'100','110','90',i>=4?'102':'100','1',(91+i)*900000-1,i>=4?'200':'100']);
const coins=()=>Array.from({length:20},(_,i)=>({symbol:i?'ASSET'+i+'USDT':'BTCUSDT',change24h:3,change1h:2,relativeVolume:1.5}));
test('closed candle metrics exclude unfinished candle',()=>{
 const rows=candles();rows.push([NOW,'1','999','1','999','1',NOW+899999,'999999']);
 const m=candleMetrics(rows,NOW);assert.ok(Math.abs(m.change1h-2)<1e-8);assert.equal(m.closedAt,NOW-1);
});
test('stale, missing and discontinuous candles fail',()=>{
 assert.throws(()=>candleMetrics(candles().slice(0,4),NOW));
 assert.throws(()=>candleMetrics(candles(),NOW+1000000));
 const bad=candles();bad[6][0]+=1;assert.throws(()=>candleMetrics(bad,NOW));
});
test('hybrid works without a global score and identifies its source',()=>{
 const s=summarize(coins());assert.equal(s.direction,'LONG');assert.equal(s.alignedCount,3);assert.equal(s.globalScore,null);assert.equal(s.strategyScore,100);assert.equal(s.source,'Binance USD-M perpetuals');
});
test('opposing volume confirmations force no entry',()=>{
 const c=coins();for(let i=0;i<5;i++){c[i].change1h=-2;c[i].change24h=-3;}
 const s=summarize(c);assert.equal(s.conflict,true);assert.equal(s.direction,null);
});
test('missing BTC or thin coverage never produces an entry',()=>{
 assert.throws(()=>summarize(coins().slice(1)));assert.throws(()=>summarize(coins().slice(0,5)));
});
test('20-contract snapshot uses only public Binance GETs and reuses cache',async()=>{
 let calls=0;
 const list=coins().map(c=>({symbol:c.symbol,lastPrice:'100',priceChangePercent:'3',quoteVolume:'1000000',closeTime:NOW}));
 const client=createBinanceMarket({now:()=>NOW,sleep:async()=>{},fetcher:async(url,options)=>{
 calls++;assert.ok(url.startsWith('https://fapi.binance.com/fapi/v1/'));assert.equal(options.headers,undefined);
 const data=url.includes('exchangeInfo')?{symbols:list.map(c=>({...c,status:'TRADING',quoteAsset:'USDT',contractType:'PERPETUAL'}))}:url.includes('ticker/24hr')?list:candles();
 return {ok:true,status:200,json:async()=>data};
 }});
 const [a,b]=await Promise.all([client.read(),client.read()]);assert.equal(a.coverage,20);assert.equal(b.coverage,20);assert.equal(calls,22);
 await client.read();assert.equal(calls,22);
});
test('CoinGecko disabled mode makes no network requests',async()=>{
 const {createMarketClient}=require('../market-http');
 const previous=process.env.COINGECKO_LEGACY_ENABLED;delete process.env.COINGECKO_LEGACY_ENABLED;
 let calls=0;const client=createMarketClient({fetcher:async()=>calls++});
 await assert.rejects(client.get('https://api.coingecko.com/api/v3/global'),/disabled/);assert.equal(calls,0);
 if(previous!==undefined)process.env.COINGECKO_LEGACY_ENABLED=previous;
});
test('new strategy does not inherit automatic permission without explicit hybrid opt-in',()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require.resolve('../index'),'utf8');
 const literal=source.slice(source.indexOf('const SMART_AT = {'),source.indexOf('let smartAtState ='));
 const run=env=>vm.runInNewContext(literal+'\nSMART_AT.autoExecuteOnTriple',{AUTO_TRADE_CONFIRM:false,process:{env}});
 assert.equal(run({}),false);assert.equal(run({HYBRID_AUTO_EXECUTION:'true'}),true);
});
test('emotion windows stay unavailable until full history is collected',()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync(require.resolve('../emotion-trader'),'utf8');
 const body=source.slice(source.indexOf('function calcPct('),source.indexOf('function getRecentLiquidations('));
 const map=new Map([['BTCUSDT',[{ts:NOW-2000,price:100},{ts:NOW,price:101}]]]);
 const ctx={Date:{now:()=>NOW},priceBuffer:map};vm.createContext(ctx);vm.runInContext(body,ctx);
 assert.equal(ctx.calcPct('BTCUSDT',900000),null);
 map.get('BTCUSDT').unshift({ts:NOW-900000,price:100});assert.equal(ctx.calcPct('BTCUSDT',900000),1);
});
