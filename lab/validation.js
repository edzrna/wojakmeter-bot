"use strict";
const crypto = require('node:crypto');
const {holm} = require('./stats');
const POLICY = 'fixed-90d-v1';
const WINDOW_MS = 90 * 86400000;
function digest(series) {
 const hash=crypto.createHash('sha256');
 for(const s of series)hash.update(JSON.stringify([s.ts,s.coverage,s.universeN,s.breadth,s.btcClose,s.actRaw,s.rvMed,s.btcC1,s.btcC24])+'\n');
 return hash.digest('hex');
}
function quality(comparison, status, fresh) {
 if(!fresh)return 'Latest snapshot is stale';
 if(status.backfill.state!=='done')return 'History rebuild is incomplete';
 if(!comparison.compared)return 'Waiting for the first live/rebuilt audit';
 if(comparison.mismatches)return 'Live/rebuilt audit has mismatches';
 if(comparison.coverageDiffs)return 'Live/rebuilt coverage differs; review incomplete snapshots';
 if(status.audit.lastError)return 'The latest audit failed';
 return null;
}
// One terminal look at a preregistered 90-day window. No rolling p<0.05 decisions.
// Fixed family: 42 directed transitions x 3 horizons + 4 hypotheses x 3 horizons.
// Three model families share alpha equally. This is research, never an execution gate.
function applyValidation(report, protocol, now, blocked) {
 const cells=[...report.screen.rows,...report.hypotheses.list].flatMap(row=>['h1','h4','h24'].map(h=>row[h]));
 const eligible=cells.filter(c=>['pending','confirmed','failed'].includes(c.verdict));
 const terminal=protocol&&now>=protocol.end;
 const adjusted=holm([...eligible.map(c=>Number.isFinite(c.live.pOne)?c.live.pOne:1),...Array(Math.max(0,138-eligible.length)).fill(1)]);
 eligible.forEach((c,i)=>{
  const original=c.verdict;
  c.live.pHolm=adjusted[i];
  if(blocked||!protocol||!terminal){c.verdict='pending';c.reason=(blocked||(!protocol?'Validation window not registered':`Collecting fixed window until ${new Date(protocol.end).toISOString()}`))+' — '+c.reason;}
  else if(original==='pending'){c.verdict='insufficient';c.reason='Fixed validation window ended without enough observations — '+c.reason;}
  else if(original==='confirmed'&&adjusted[i]<0.05/3){c.verdict='confirmed';c.reason='Fixed-window research confirmation; live Holm p='+adjusted[i].toPrecision(3)+' — '+c.reason;}
  else {c.verdict='failed';c.reason='Did not pass fixed-window joint correction — '+c.reason;}
 });
 report.validation={policy:POLICY,startedAt:protocol?.start??null,endsAt:protocol?.end??null,blocked:blocked||null,status:blocked?'blocked':!protocol?'waiting':terminal?'finished':'collecting',alphaPerModel:0.05/3,familySize:138,tradingAuthorized:false};
 report.notes.push('Confirmation uses one fixed 90-day window, Holm over transitions and hypotheses together, and alpha/3 across the three models. It is not trading authorization.');
 return report;
}
module.exports={POLICY,WINDOW_MS,digest,quality,applyValidation};
