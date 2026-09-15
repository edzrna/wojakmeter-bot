const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAccountReader,createRecovery}=require('../desk-account');
const account=n=>({totalWalletBalance:String(n),availableBalance:String(n),totalMarginBalance:String(n),totalUnrealizedProfit:'0'});
test('wallet refresh follows changed exchange balance and coalesces callers',async()=>{
 let now=0,calls=0,balance=27;
 const read=createAccountReader(async()=>{calls++;return account(balance);},()=>now);
 const [a,b]=await Promise.all([read(),read()]);assert.equal(a.walletBalance,27);assert.equal(b.walletBalance,27);assert.equal(calls,1);
 balance=22;now=30001;assert.equal((await read()).walletBalance,22);assert.equal(calls,2);
});
test('account failure never becomes zero balance',async()=>{
 const read=createAccountReader(async()=>{throw Error('401');});const a=await read();assert.equal(a.ok,false);assert.equal(a.walletBalance,undefined);
});
const flush=()=>new Promise(r=>setImmediate(r));
test('recovery clears old startup error only on success and stays paused',async()=>{
 const state={ready:false,bootError:'401'};let paused=false;let applied=0;
 const r=createRecovery({state,pause:()=>paused=true,isBusy:()=>false,read:async()=>({}),apply:()=>applied++});
 assert.equal(r.start(),true);assert.equal(r.start(),false);assert.equal(paused,true);await flush();
 assert.equal(state.ready,true);assert.equal(state.bootError,null);assert.equal(applied,1);assert.equal(paused,true);
});
test('failed recovery preserves startup gate and reports failing request',async()=>{
 const state={ready:false,bootError:'401'};let applied=false;
 const r=createRecovery({state,pause(){},isBusy:()=>false,read:async()=>{throw Error('Income history: 401');},apply:()=>applied=true});
 r.start();await flush();assert.equal(state.ready,false);assert.equal(state.recoveryError,'Income history: 401');assert.equal(applied,false);
});
