import { MAX_DAILY_REWARD } from "./store";

/** Self-contained admin page. No external assets, so no CDN dependency. */
export function adminPage(who: string, assetCode: string, assetIssuer: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>xLMNR Reward Instances</title>
<style>
 :root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;
       --accent:#3b82f6;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);
   font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
 header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;
   justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
 h1{font-size:18px;margin:0} .who{color:var(--dim);font-size:12px}
 main{padding:20px;max-width:1200px;margin:0 auto;display:grid;gap:20px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
 .card h2{font-size:14px;margin:0 0 12px;text-transform:uppercase;
   letter-spacing:.06em;color:var(--dim)}
 table{width:100%;border-collapse:collapse;font-size:13px}
 th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
 th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase}
 code{background:#0b0f14;padding:2px 6px;border-radius:4px;font-size:12px;color:#79c0ff}
 input,select{background:#0b0f14;border:1px solid var(--line);color:var(--fg);
   border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;width:100%}
 input[type=checkbox]{width:auto}
 button{background:var(--accent);color:#fff;border:0;border-radius:6px;
   padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
 button.ghost{background:transparent;border:1px solid var(--line);color:var(--fg)}
 button:disabled{opacity:.5;cursor:not-allowed}
 .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 .muted{color:var(--dim)} .ok{color:var(--ok)} .warn{color:var(--warn)} .bad{color:var(--bad)}
 .banner{padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:13px}
 .banner.warn{background:#33270a;border:1px solid #9e6a03}
 .banner.bad{background:#3d1418;border:1px solid #a02b31}
 .banner.ok{background:#0f2e18;border:1px solid #238636}
 .num{width:110px} .memo{width:150px} .name{width:130px}
 .preview{font-size:12px;max-height:320px;overflow:auto}
 .preview td{padding:4px 8px}
</style></head><body>
<header>
  <div><h1>xLMNR Reward Instances</h1>
  <div class="who">signed in as ${who} &middot; reward asset <code>${assetCode}</code></div></div>
  <div class="row">
    <button class="ghost" onclick="preview()">Preview payouts</button>
    <button id="save" onclick="save()">Save config</button>
  </div>
</header>
<main>
  <div id="msg"></div>

  <div class="card">
    <h2>Reward distribution curve</h2>
    <div class="muted" style="margin-bottom:10px">
      Applies to <b>every</b> pool. Changes how a holder's LP share becomes a reward.
    </div>
    <div class="row" style="gap:16px;align-items:flex-start">
      <label class="row" style="gap:8px;align-items:flex-start;flex:1;min-width:260px">
        <input type="radio" name="wm" value="linear" onchange="setMode('linear')">
        <span><b>Proportional</b><br>
          <span class="muted">Strictly pro-rata. A holder with 54% of the pool
          earns 54% of the rewards.</span></span>
      </label>
      <label class="row" style="gap:8px;align-items:flex-start;flex:1;min-width:260px">
        <input type="radio" name="wm" value="sqrt" onchange="setMode('sqrt')">
        <span><b>Square root (compressed)</b><br>
          <span class="muted">Weights by &radic;share. Larger holders still earn
          more &mdash; so adding liquidity always helps &mdash; but the gap between
          biggest and smallest narrows a lot.</span></span>
      </label>
    </div>
    <div id="wmMsg" class="muted" style="margin-top:8px"></div>
  </div>

  <div class="card" id="walletCard">
    <h2>Disbursement wallet</h2>
    <div id="wallet" class="muted">loading&hellip;</div>
  </div>

  <div class="card">
    <h2>Active reward instances</h2>
    <div class="muted" style="margin-bottom:10px">
      One row = one pool paying one asset. A pool can appear more than once to pay
      multiple assets. Daily amount is capped at ${MAX_DAILY_REWARD.toLocaleString()} per pool.
    </div>
    <table id="instances"><thead><tr>
      <th style="width:40px">On</th><th>Pool</th><th>Pool ID</th><th>Reward asset</th>
      <th>Daily amount</th><th>Min payment</th><th>Memo</th><th></th>
    </tr></thead><tbody></tbody></table>
  </div>

  <div class="card">
    <h2>On-chain pools containing ${assetCode}</h2>
    <div class="muted" style="margin-bottom:10px">
      Read live from Horizon &mdash; tick one to add it as a reward instance.
    </div>
    <table id="discovered"><thead><tr>
      <th style="width:40px"></th><th>Pair</th><th>Pool ID</th><th>LP holders</th><th>Total shares</th>
    </tr></thead><tbody><tr><td colspan="5" class="muted">loading&hellip;</td></tr></tbody></table>
  </div>

  <div class="card">
    <h2>Payout preview</h2>
    <div class="muted" style="margin-bottom:10px">
      Exactly what the next run would pay. Nothing is sent.
    </div>
    <div id="previewOut" class="preview muted">Press &ldquo;Preview payouts&rdquo;.</div>
  </div>
</main>
<script>
const ASSET={code:${JSON.stringify(assetCode)},issuer:${JSON.stringify(assetIssuer)}};
let instances=[], discovered=[];

function msg(kind,text){document.getElementById('msg').innerHTML=
  '<div class="banner '+kind+'">'+text+'</div>';}

async function load(){
  const [c,d,st]=await Promise.all([
    fetch('/api/config').then(r=>r.json()),
    fetch('/api/pools').then(r=>r.json()),
    fetch('/api/settings').then(r=>r.json())
  ]);
  const wm=(st.settings&&st.settings.weightMode)||'linear';
  const el=document.querySelector('input[name=wm][value="'+wm+'"]');
  if(el) el.checked=true;
  instances=c.instances||[]; discovered=d.pools||[];
  renderInstances(); renderDiscovered(); loadWallet();
}

async function loadWallet(){
  const el=document.getElementById('wallet');
  try{
    const w=await(await fetch('/api/wallet')).json();
    if(!w.ok){el.innerHTML='<span class="bad">'+esc(w.reason||'error')+'</span>';return;}
    const cls=(d)=>d===null?'muted':(d<3?'bad':(d<10?'warn':'ok'));
    const days=(d)=>d===null?'&mdash;':(d<1?(d*24).toFixed(1)+' hours':d.toFixed(1)+' days');
    el.innerHTML=
      '<div class="row" style="margin-bottom:10px">'+
        '<code id="addr" style="font-size:13px">'+esc(w.address)+'</code>'+
        '<button class="ghost" onclick="copyAddr()">Copy</button>'+
      '</div>'+
      '<div class="muted" style="margin-bottom:10px">Send '+ASSET.code+' (and XLM for fees) here to top up.</div>'+
      '<table><thead><tr><th>Asset</th><th>Balance</th><th>Burn / day</th><th>Runway</th></tr></thead><tbody>'+
      '<tr><td>'+ASSET.code+'</td><td>'+esc(w.reward.balance)+'</td><td>'+esc(w.reward.perDay)+'</td>'+
        '<td class="'+cls(w.reward.days)+'">'+days(w.reward.days)+'</td></tr>'+
      '<tr><td>XLM (fees)</td><td>'+esc(w.xlm.balance)+' <span class="muted">('+esc(w.xlm.reserved)+' reserved)</span></td>'+
        '<td>'+esc(w.xlm.perDay)+'</td><td class="'+cls(w.xlm.days)+'">'+days(w.xlm.days)+'</td></tr>'+
      '</tbody></table>'+
      (w.warnings.length?'<div class="banner warn" style="margin-top:10px">'+w.warnings.map(esc).join('<br>')+'</div>':'')+
      (w.suggestedTopUp?'<div style="margin-top:10px">Suggested top-up for 30 days: <b>'+esc(w.suggestedTopUp)+' '+ASSET.code+'</b></div>':'');
  }catch(e){el.innerHTML='<span class="bad">'+e.message+'</span>';}
}

function copyAddr(){
  const t=document.getElementById('addr').textContent;
  navigator.clipboard.writeText(t).then(()=>msg('ok','Address copied.'),()=>{});
}

function renderInstances(){
  const tb=document.querySelector('#instances tbody'); tb.innerHTML='';
  if(!instances.length){tb.innerHTML='<tr><td colspan="8" class="muted">No instances yet &mdash; tick a pool below.</td></tr>';return;}
  instances.forEach((it,i)=>{
    const tr=document.createElement('tr');
    tr.innerHTML=
      '<td><input type="checkbox" '+(it.enabled?'checked':'')+' onchange="upd('+i+',\\'enabled\\',this.checked)"></td>'+
      '<td><input class="name" value="'+esc(it.poolName)+'" onchange="upd('+i+',\\'poolName\\',this.value)"></td>'+
      '<td><code title="'+esc(it.poolId)+'">'+it.poolId.slice(0,6)+'&hellip;'+it.poolId.slice(-4)+'</code></td>'+
      '<td>'+(it.rewardAssetCode||'XLM')+'</td>'+
      '<td><input class="num" type="number" min="0" max="'+${MAX_DAILY_REWARD}+'" step="any" value="'+esc(it.dailyAmount)+'" onchange="upd('+i+',\\'dailyAmount\\',this.value)"></td>'+
      '<td><input class="num" type="number" min="0" step="any" value="'+esc(it.minPayment)+'" onchange="upd('+i+',\\'minPayment\\',this.value)"></td>'+
      '<td><input class="memo" maxlength="28" value="'+esc(it.memo||'')+'" onchange="upd('+i+',\\'memo\\',this.value)"></td>'+
      '<td><button class="ghost" onclick="rm('+i+')">Remove</button></td>';
    tb.appendChild(tr);
  });
}

function renderDiscovered(){
  const tb=document.querySelector('#discovered tbody'); tb.innerHTML='';
  discovered.forEach(p=>{
    const on=instances.some(i=>i.poolId===p.poolId);
    const tr=document.createElement('tr');
    tr.innerHTML=
      '<td><input type="checkbox" '+(on?'checked':'')+' onchange="toggle(\\''+p.poolId+'\\',this.checked)"></td>'+
      '<td>'+esc(p.name)+'</td>'+
      '<td><code>'+p.poolId.slice(0,6)+'&hellip;'+p.poolId.slice(-4)+'</code></td>'+
      '<td>'+p.holders+'</td><td class="muted">'+esc(p.totalShares)+'</td>';
    tb.appendChild(tr);
  });
}

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function upd(i,k,v){instances[i][k]=v;}
function rm(i){instances.splice(i,1);renderInstances();renderDiscovered();}
function toggle(poolId,on){
  if(on){
    const p=discovered.find(x=>x.poolId===poolId);
    instances.push({poolId,poolName:p?p.name:poolId.slice(0,8),
      rewardAssetCode:ASSET.code,rewardAssetIssuer:ASSET.issuer,
      dailyAmount:"0",minPayment:"0.001",memo:"",enabled:false});
    msg('warn','Added <b>'+esc(p?p.name:poolId)+'</b> with amount 0 and disabled. Set the amount, tick On, then Save.');
  }else{
    instances=instances.filter(i=>i.poolId!==poolId);
  }
  renderInstances();renderDiscovered();
}

async function setMode(mode){
  const out=document.getElementById('wmMsg');
  out.textContent='Saving…';
  try{
    const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({weightMode:mode})});
    const j=await r.json();
    out.innerHTML = j.ok
      ? '<span class="ok">Saved &mdash; applies from the next run. Press &ldquo;Preview payouts&rdquo; to see the effect.</span>'
      : '<span class="bad">'+esc(j.reason||'failed')+'</span>';
  }catch(e){out.innerHTML='<span class="bad">'+e.message+'</span>';}
}

async function save(){
  const btn=document.getElementById('save'); btn.disabled=true;
  try{
    const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({instances})});
    const j=await r.json();
    if(j.ok){msg('ok','Saved. '+j.count+' instance(s), '+j.enabled+' enabled. Total '+j.totalDaily+' '+ASSET.code+'/day.');load();}
    else{msg('bad','<b>Not saved.</b><br>'+(j.errors||[j.reason||'error']).join('<br>'));}
  }catch(e){msg('bad','Save failed: '+e.message);}
  btn.disabled=false;
}

async function preview(){
  const out=document.getElementById('previewOut'); out.textContent='Running…';
  try{
    const j=await(await fetch('/api/preview')).json();
    if(!j.ok){out.innerHTML='<span class="bad">'+(j.reason||'error')+'</span>';return;}
    if(!j.results.length){out.innerHTML='<span class="muted">No enabled instances.</span>';return;}
    out.innerHTML=j.results.map(r=>{
      const rows=(r.payouts||[]).map(p=>'<tr><td><code>'+p.address.slice(0,8)+'…'+p.address.slice(-4)+'</code></td><td>'+p.share+'</td><td>'+p.amount+'</td></tr>').join('');
      return '<div style="margin-bottom:14px"><b>'+esc(r.poolName)+'</b> <span class="muted">'+r.status+
        '</span><br><span class="muted">'+r.recipients+' recipient(s), '+r.paid+' '+ASSET.code+' per run'+
        (r.noTrustline?' &middot; <span class="warn">'+r.noTrustline+' lack a trustline</span>':'')+'</span>'+
        (rows?'<table><thead><tr><th>Recipient</th><th>LP share</th><th>Amount</th></tr></thead><tbody>'+rows+'</tbody></table>':'')+'</div>';
    }).join('');
  }catch(e){out.innerHTML='<span class="bad">'+e.message+'</span>';}
}
load();
</script></body></html>`;
}
