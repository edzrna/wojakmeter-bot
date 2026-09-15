'use strict';
// node-binance-api 0.13 Futures methods return promises, not callbacks.
function callFutures(task, {timeoutMs=15000,onTimeout=()=>{}}={}) {
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(value);};
  const timer=setTimeout(()=>{
   const err=new Error('Futures request timed out; exchange outcome must be reconciled before retrying');
   err.code='FUTURES_TIMEOUT';
   try{onTimeout(err);}finally{finish(err);}
  },timeoutMs);
  Promise.resolve().then(task).then(value=>{
   if(value && Number(value.code)<0)throw new Error(`Binance ${value.code}: ${value.msg||'Request rejected'}`);
   finish(null,value);
  }).catch(err=>finish(err instanceof Error?err:new Error(err?.body||err?.message||String(err))));
 });
}
function createDecisionRunner({onError=()=>{},onStall=()=>{},timeoutMs=45000}={}) {
 let busy=false;
 return {
  get busy(){return busy;},
  run(task){
   if(busy)return false;
   busy=true;
   const timer=setTimeout(()=>onStall(new Error('Trade decision still pending; further entries paused')),timeoutMs);
   Promise.resolve().then(task).catch(onError).finally(()=>{clearTimeout(timer);busy=false;});
   return true;
  }
 };
}
module.exports={callFutures,createDecisionRunner};
