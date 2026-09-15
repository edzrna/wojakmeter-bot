'use strict';
function createMarketClient({fetcher=global.fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),spacing=1500}={}) {
  const cache=new Map(),pending=new Map();
  let tail=Promise.resolve(),next=0,blockedUntil=0,strikes=0;
  const error=(path,status,until=0)=>Object.assign(new Error(`CoinGecko ${path}: HTTP ${status}${until ? ' — retry after '+new Date(until).toISOString() : ''}`),{status,retryAt:until});
  function get(url,{timeoutMs=15000}={}) {
    const u=new URL(url);
    if(u.origin!=='https://api.coingecko.com')return Promise.reject(Error('Unsupported market data origin'));
    const ttl=u.pathname.endsWith('/search/trending')?300000:120000;
    const hit=cache.get(url);
    if(hit && now()-hit.ts<ttl)return Promise.resolve(hit.data);
    if(pending.has(url))return pending.get(url);
    const job=tail.then(async()=>{
      if(now()<blockedUntil)throw error(u.pathname,429,blockedUntil);
      const wait=next-now();if(wait>0)await sleep(wait);
      if(now()<blockedUntil)throw error(u.pathname,429,blockedUntil);
      next=now()+spacing;
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        const headers={Accept:'application/json','User-Agent':'WojakMeterBot/1.0'};
        if(process.env.COINGECKO_API_KEY)headers['x-cg-demo-api-key']=process.env.COINGECKO_API_KEY;
        const res=await fetcher(url,{headers,signal:controller.signal});
        if(res.status===429){
          strikes++;
          const raw=res.headers.get('retry-after');
          const seconds=raw!==null && raw.trim()!=='' ? Number(raw) : NaN;
          const advised=Number.isFinite(seconds)?now()+Math.max(0,seconds)*1000:Date.parse(raw);
          const backoff=Math.min(900000,60000*2**Math.min(strikes-1,4));
          blockedUntil=Math.max(now()+backoff,Number.isFinite(advised)?advised:0);
          await res.body?.cancel?.();
          throw error(u.pathname,429,blockedUntil);
        }
        if(!res.ok){await res.body?.cancel?.();throw error(u.pathname,res.status);}
        const data=await res.json();
        if(u.pathname.endsWith('/global') && !Number.isFinite(data?.data?.market_cap_change_percentage_24h_usd))throw Error('CoinGecko /global: invalid data');
        if(u.pathname.endsWith('/coins/markets') && (!Array.isArray(data)||!data.length))throw Error('CoinGecko /coins/markets: invalid data');
        cache.set(url,{ts:now(),data});strikes=0;
        return data;
      }finally{clearTimeout(timer);}
    });
    tail=job.catch(()=>{});
    pending.set(url,job);
    job.then(()=>pending.delete(url),()=>pending.delete(url));
    return job;
  }
  return {get};
}
const shared=createMarketClient();
module.exports={createMarketClient,getMarketJSON:shared.get};
