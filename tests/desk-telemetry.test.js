const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTelemetry}=require('../desk-telemetry');
const ev=ts=>({ts,coins:Array(20).fill({}),strategyScore:65,btcChange1h:1,alignedCount:2,direction:'LONG'});
const state={ready:true,paused:false,active:true,context:{ts:1000,score:60}};
test('records observations, deduplicates polls and does not invent fills',()=>{
 const t=createTelemetry();t.record(ev(1000),state,1000);t.record(ev(1000),state,1000);t.record(ev(2000),state,2000);
 const r=t.read();assert.equal(r.samples.length,2);assert.equal(r.events.length,1);assert.equal(r.events[0].title,'Signal detected');assert.equal(r.samples[0].global,60);
 r.samples[0].global=0;assert.equal(t.read().samples[0].global,60);
});
test('stale context and failed market evaluation are explicit gaps',()=>{
 const t=createTelemetry();t.record({...ev(2000000),error:'Cooling down'},state,2000000);
 const s=t.read().samples[0];assert.equal(s.global,null);assert.equal(s.participation,null);assert.equal(s.btcMomentum,null);
});
test('account recovery stays distinct from market signal',()=>{
 const t=createTelemetry();t.record(ev(1000),{...state,ready:false},1000);
 assert.equal(t.read().events[0].title,'Account recovery required');assert.equal(t.read().samples[0].participation,65);
});
test('retention is bounded and histories are ordered',()=>{
 const t=createTelemetry();for(let i=1;i<=250;i++)t.record({...ev(i*1000),direction:i%2?'LONG':'SHORT'},state,i*1000);
 const r=t.read();assert.equal(r.samples.length,180);assert.equal(r.events.length,60);assert.equal(r.samples[0].ts,71000);assert.equal(r.events[0].ts,250000);
});
