'use strict';
function normalizePositions(rows, tracked) {
  if (!Array.isArray(rows)) throw Error('Invalid Binance positions response');
  const result=[];
  for (const p of rows) {
    const qty=Number(p.positionAmt);
    if (p.positionAmt == null || !Number.isFinite(qty)) throw Error('Invalid Binance position amount');
    if (!qty) continue;
    const number = key => {const v=Number(p[key]);if(p[key]==null || p[key]==='' || !Number.isFinite(v))throw Error('Invalid position '+key);return v;};
    const side=qty>0?'BUY':'SELL';
    const managed=Boolean(tracked && tracked.symbol===p.symbol && tracked.side===side &&
      Math.abs(Number(tracked.qty)-Math.abs(qty))<1e-8 && (!p.positionSide || p.positionSide==='BOTH'));
    result.push({id:p.symbol+':'+(p.positionSide||'BOTH'),symbol:p.symbol,side,positionSide:p.positionSide||'BOTH',qty:Math.abs(qty),
      entryPrice:number('entryPrice'),markPrice:number('markPrice'),livePnl:number('unRealizedProfit'),
      leverage:Number(p.leverage)||null,riskUsd:managed?tracked.riskUsd:null,managed,canClose:managed,
      openedAt:managed?tracked.ts:null});
  }
  return result;
}
module.exports={normalizePositions};
