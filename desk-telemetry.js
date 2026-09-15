'use strict';
const finite=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
function createTelemetry(){
 const samples=[],events=[];let previous='',lastTs=0;
 return {
  record(ev,state,now=Date.now()){
   if(!ev || !Number.isFinite(ev.ts) || ev.ts<=lastTs)return;
   lastTs=ev.ts;
   const valid=!ev.error && Array.isArray(ev.coins) && ev.coins.length>=10;
   const global=state.context && now-state.context.ts<=1800000 ? finite(state.context.score):null;
   samples.push({ts:ev.ts,participation:valid?finite(ev.strategyScore):null,global,btcMomentum:valid?finite(ev.btcChange1h):null,aligned:valid?finite(ev.alignedCount):null});
   if(samples.length>180)samples.shift();
   const reason=!state.ready?'Account recovery required':state.paused?'Entries paused':!state.active?'AutoTrade off':state.position?'Position tracked':state.pending?'Confirmation pending':ev.error?'Market data unavailable':ev.conflict?'Opposing signals':ev.direction?'Signal detected':'Waiting for alignment';
   const signature=JSON.stringify([reason,ev.direction,ev.alignedCount,Boolean(ev.error)]);
   if(signature!==previous){
    previous=signature;
    events.unshift({ts:ev.ts,type:ev.error?'data-error':ev.conflict?'conflict':ev.direction?'signal':'state',title:reason,
      detail:ev.error || `${ev.direction || 'No direction'} · ${ev.alignedCount ?? '—'}/3 aligned. ${state.paused?'Entries remain paused.':''}`});
    if(events.length>60)events.pop();
   }
  },
  read(){return {samples:samples.map(x=>({...x})),events:events.map(x=>({...x})),scope:'Current bot process · evaluation observations, not a trade ledger'};}
 };
}
module.exports={createTelemetry};
