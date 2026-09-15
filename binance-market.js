'use strict';
// Public market data only: no API keys, account endpoints or order methods.
const ORIGIN='https://fapi.binance.com';
const MOODS=['frustration','concern','doubt','neutral','optimism','content','euphoria'];
const mood=score=>MOODS[[20,35,45,60,70,85].filter(x=>score>=x).length];
const numeric=x=>x!==null && x!==undefined && x!=='' && Number.isFinite(Number(x));
function candleMetrics(rows,now) {
  if(!Array.isArray(rows))throw Error('Invalid candle response');
  const closed=rows.filter(r=>Array.isArray(r)&&Number(r[6])<now).slice(-8);
  if(closed.length!==8)throw Error('Eight closed 15m candles required');
  for(let i=0;i<8;i++){
    const r=closed[i];
    if(![0,1,4,6,7].every(k=>numeric(r[k])) || Number(r[1])<=0 || Number(r[4])<=0 || Number(r[7])<0 || Number(r[6])-Number(r[0])!==899999 || (i && Number(r[0])-Number(closed[i-1][0])!==900000))throw Error('Invalid or non-contiguous candles');
  }
  const last=closed[7];if(now-Number(last[6])>960000)throw Error('Stale candles');
  const prev=closed.slice(0,4).reduce((s,r)=>s+Number(r[7]),0),current=closed.slice(4).reduce((s,r)=>s+Number(r[7]),0);
  return {change1h:(Number(last[4])/Number(closed[4][1])-1)*100,relativeVolume:prev>0?current/prev:null,closedAt:Number(last[6])};
}
function summarize(coins,{btcMomentumThreshold=1,confluenceMin=3,minSignalsRequired=2}={}) {
  const btc=coins.find(c=>c.symbol==='BTCUSDT');
  if(!btc || coins.length<10)throw Error('Insufficient Binance coverage (BTC and at least 10 contracts required)');
  const rising=coins.filter(c=>c.change24h>0).length;
  const breadth=rising/coins.length;
  const score=Math.round(breadth*100); // Participation score, not the global WojakMeter index.
  const participation=score>=65?'LONG':score<=35?'SHORT':null;
  const btcSignal=btc.change1h>=btcMomentumThreshold && btc.change24h>0?'LONG':btc.change1h<=-btcMomentumThreshold && btc.change24h<0?'SHORT':null;
  const longs=coins.filter(c=>c.change1h>=btcMomentumThreshold && c.change24h>0 && c.relativeVolume!==null && c.relativeVolume>=1.2);
  const shorts=coins.filter(c=>c.change1h<=-btcMomentumThreshold && c.change24h<0 && c.relativeVolume!==null && c.relativeVolume>=1.2);
  const scannerConflict=longs.length>=confluenceMin && shorts.length>=confluenceMin;
  const confluenceSignal=scannerConflict?null:longs.length>=confluenceMin?'LONG':shorts.length>=confluenceMin?'SHORT':null;
  const votes=[participation,btcSignal,confluenceSignal],l=votes.filter(v=>v==='LONG').length,s=votes.filter(v=>v==='SHORT').length;
  const conflict=scannerConflict || (l>0&&s>0),alignedCount=Math.max(l,s);
  const required=Math.max(2,Math.min(3,Number(minSignalsRequired)||2));
  const direction=!conflict&&alignedCount>=required?(l>s?'LONG':'SHORT'):null;
  return {source:'Binance USD-M perpetuals',strategy:'hybrid-v1',strategyScore:score,globalScore:null,
    marketMood:mood(score),breadth,coverage:coins.length,btcChange1h:btc.change1h,globalSignal:participation,btcSignal,confluenceSignal,
    confluenceCount:Math.max(longs.length,shorts.length),alignedCount,conflict,direction,
    confidence:direction?(alignedCount===3?'high':'medium'):'none',
    details:[`Binance participation: ${rising}/${coins.length} contracts rising over 24h (${score}/100); not the global index.`,
      `BTC closed-candle 1h momentum: ${btc.change1h.toFixed(2)}%.`,
      `Momentum + volume: ${longs.length} LONG / ${shorts.length} SHORT; volume threshold 1.2× previous hour.`,
      conflict?'Opposing signals — no entry.':'Alignment measures agreement, not probability of profit.'],coins};
}
function createBinanceMarket({fetcher=global.fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const cached=new Map(),pending=new Map();let tail=Promise.resolve(),blocked=0,last=0,snapshot=null,snapshotPending=null;
  async function get(path,ttl) {
    const hit=cached.get(path);if(hit&&now()-hit.ts<ttl)return hit.data;
    if(pending.has(path))return pending.get(path);
    const job=tail.then(async()=>{
      if(now()<blocked)throw Error('Binance public data cooling down until '+new Date(blocked).toISOString());
      if(now()-last<150)await sleep(150-(now()-last));last=now();
      const res=await fetcher(ORIGIN+path,{signal:AbortSignal.timeout(10000)});
      if(res.status===429||res.status===418){const raw=res.headers.get('retry-after');const seconds=Number(raw);const advised=raw&&Number.isFinite(seconds)?now()+seconds*1000:Date.parse(raw);blocked=Math.max(now()+(res.status===418?900000:60000),Number.isFinite(advised)?advised:0);}
      if(!res.ok)throw Error(`Binance public ${path.split('?')[0]}: HTTP ${res.status}`);
      const data=await res.json();cached.set(path,{ts:now(),data});return data;
    });
    tail=job.catch(()=>{});pending.set(path,job);
    try{return await job;}finally{pending.delete(path);}
  }
  async function tickers(){
    const [info,rows]=await Promise.all([get('/fapi/v1/exchangeInfo',3600000),get('/fapi/v1/ticker/24hr',30000)]);
    if(!Array.isArray(info?.symbols)||!Array.isArray(rows))throw Error('Invalid Binance public feed');
    const allowed=new Set(info.symbols.filter(s=>s.status==='TRADING'&&s.quoteAsset==='USDT'&&s.contractType==='PERPETUAL').map(s=>s.symbol));
    return rows.filter(r=>allowed.has(r.symbol)&&['lastPrice','priceChangePercent','quoteVolume','closeTime'].every(k=>numeric(r[k]))&&Number(r.lastPrice)>0&&Number(r.quoteVolume)>0&&now()-Number(r.closeTime)<90000&&Number(r.closeTime)<now()+60000);
  }
  async function read(config){
    if(snapshot&&now()-snapshot.ts<60000)return summarize(snapshot.coins,config);
    if(snapshotPending)return snapshotPending.then(x=>summarize(x.coins,config));
    snapshotPending=(async()=>{
      const rows=(await tickers()).sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume));
      const selected=rows.slice(0,20);const btc=rows.find(r=>r.symbol==='BTCUSDT');
      if(btc&&!selected.some(r=>r.symbol==='BTCUSDT'))selected[selected.length-1]=btc;
      const coins=[];
      for(const row of selected){
        const candles=await get('/fapi/v1/klines?symbol='+encodeURIComponent(row.symbol)+'&interval=15m&limit=10',60000);
        coins.push({symbol:row.symbol,price:Number(row.lastPrice),change24h:Number(row.priceChangePercent),quoteVolume:Number(row.quoteVolume),...candleMetrics(candles,now())});
      }
      summarize(coins,config); // Reject incomplete snapshots, do not substitute stale state.
      snapshot={ts:now(),coins};return snapshot;
    })();
    try{return summarize((await snapshotPending).coins,config);}finally{snapshotPending=null;}
  }
  return {read,tickers};
}
const shared=createBinanceMarket();module.exports={createBinanceMarket,candleMetrics,summarize,mood,read:shared.read,tickers:shared.tickers};
