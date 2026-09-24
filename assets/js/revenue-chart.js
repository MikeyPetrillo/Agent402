  (function(){
    var SLOTS={base:1,algorand:2,solana:3,polygon:4,stellar:5,arbitrum:6,celo:7};
    var NAMES={1:"Base",2:"Algorand",3:"Solana",4:"Polygon",5:"Stellar",6:"Arbitrum",7:"Celo",8:"Other",free:"Free tier (PoW)",tempo:"Tempo",newbuyers:"New buyers",retbuyers:"Returning buyers",cumbuyers:"Distinct buyers to date"};
    // Draw order. "free" and "tempo" are lanes, not chains - free calls settle
    // nowhere, and Tempo is never x402-settleable (excluded from RAILS on
    // purpose), so its revenue lives in a separate table the on-chain scan
    // never reads. Neither ever takes a chain colour or folds into "Other".
    var CHAIN_ORDER=[1,2,3,4,5,6,7,8,"free","tempo"];
    // Buyers are people, not chains: a distinct-buyer count cannot be split by
    // rail without double counting anyone who paid on two. So the buyers view
    // swaps the whole lane set rather than adding to it.
    function ORDERS(){
      if(state.metric!=="buyers")return CHAIN_ORDER;
      return state.mode==="cum"?["cumbuyers"]:["newbuyers","retbuyers"];
    }
    var state={mode:"cum",metric:"usd",scope:"ext",wire:"all",traffic:"paid",settle:"all",rows:[],free:[],freeSince:null,tempo:[],tempoSince:null,buyers:[],buyersWeekly:[],buyersMonthly:[],conc:null,ret:null};
    // Monday (UTC) of the ISO week holding a YYYY-MM-DD day. Weekly bars are
    // keyed on it; the label reads "week of <Monday>".
    function weekOf(day){var d=new Date(day+"T00:00:00Z");d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10)}
    function monthOf(day){return day.slice(0,7)+"-01"}
    var css=function(n){return getComputedStyle(document.getElementById("rvz")).getPropertyValue("--s"+n).trim()};
    function slotOf(chain){return SLOTS[chain]||8}
    function chainName(c){return c==="robinhood"?"Robinhood":c.charAt(0).toUpperCase()+c.slice(1)}
    // Wire filter: MPP and x402 settle identically on-chain, so the MPP subset
    // is joined in by tx hash server-side. x402 is the remainder, never a
    // separate count - that keeps All === x402 + MPP exactly.
    function val(r){
      var usd=state.metric==="usd";
      var e=usd?r.extUsd:r.extTx, i=usd?r.intUsd:r.intTx;
      var em=(usd?r.extMppUsd:r.extMppTx)||0, im=(usd?r.intMppUsd:r.intMppTx)||0;
      if(state.wire==="mpp"){e=em;i=im}
      else if(state.wire==="x402"){e=Math.max(0,e-em);i=Math.max(0,i-im)}
      // Settled-to lane: SOR is the subset received by the spending wallet;
      // Direct is the remainder, never a separate count - All === SOR + Direct
      // exactly. Only meaningful at wire="all" (the seg handlers enforce that).
      var es=(usd?r.extSorUsd:r.extSorTx)||0, is2=(usd?r.intSorUsd:r.intSorTx)||0;
      if(state.settle==="sor"){e=es;i=is2}
      else if(state.settle==="direct"){e=Math.max(0,e-es);i=Math.max(0,i-is2)}
      return state.scope==="ext"?e:state.scope==="int"?i:e+i}
    function setSeg(id,v){var el=document.getElementById(id);
      [].slice.call(el.querySelectorAll("button")).forEach(function(b){b.classList.toggle("on",b.dataset.v===v)})}
    function seg(id,cb){var el=document.getElementById(id);el.addEventListener("click",function(ev){var b=ev.target.closest("button");if(!b)return;
      [].slice.call(el.querySelectorAll("button")).forEach(function(x){x.classList.toggle("on",x===b)});cb(b.dataset.v);render();})}
    function build(){
      var days={};
      function dayOf(k){return days[k]||(days[k]={day:k,slots:{}})}
      if(state.metric==="buyers"){
        // Weekly buyers come from the SERVER'S weekly series, never a fold of
        // the daily rows: a week's distinct count is the union of its days,
        // and a buyer paying Monday and Wednesday is one buyer, not two.
        if(state.mode==="weekly"){
          return (state.buyersWeekly||[]).map(function(r){
            return {day:r.week,week:true,partial:!!r.partial,slots:{newbuyers:r.newBuyers,retbuyers:r.returningBuyers}}})}
        // Monthly buyers: the server's monthly union, for the same reason. A
        // buyer paying on the 3rd and the 20th is ONE monthly buyer; folding
        // the daily or weekly rows here would report two.
        if(state.mode==="monthly"){
          return (state.buyersMonthly||[]).map(function(r){
            return {day:r.month,month:true,partial:!!r.partial,slots:{newbuyers:r.newBuyers,retbuyers:r.returningBuyers}}})}
        // Cumulative uses the server's running UNION, never an accumulation of
        // the daily counts: summing distinct counts double counts every
        // returning buyer and would draw a rising line over a flat reality.
        return (state.buyers||[]).map(function(r){
          return state.mode==="cum"
            ? {day:r.day,slots:{cumbuyers:r.cumulative}}
            : {day:r.day,slots:{newbuyers:r.newBuyers,retbuyers:r.returningBuyers}};
        });
      }
      if(state.traffic!=="free"){
        state.rows.forEach(function(r){var d=dayOf(r.day);
          var s=slotOf(r.chain); d.slots[s]=(d.slots[s]||0)+val(r);
          // Chains folded into "Other" keep their identity in a per-day
          // breakdown - the fold is a palette constraint (8 validated hues),
          // not a licence to hide which rails the money arrived on.
          if(s===8){var v8=val(r);if(v8>0){d.oth=d.oth||{};d.oth[r.chain]=(d.oth[r.chain]||0)+v8}}})}
      // Tempo settlements: real dollars, from a SEPARATE table (never the
      // on-chain scan - Tempo isn't in RAILS, so that scan never sees it).
      // Never x402 (drops out under that wire filter) and has no SOR/Direct
      // concept yet (no self-funding spending wallet for it), so it only
      // participates in the settle="all" lane.
      if(state.traffic!=="free"&&state.wire!=="x402"&&state.settle==="all"){
        state.tempo.forEach(function(r){var d=dayOf(r.day);
          var usd=state.metric==="usd";
          var e=usd?r.extUsd:r.extTx, i=usd?r.intUsd:r.intTx;
          var v=state.scope==="ext"?e:state.scope==="int"?i:e+i;
          d.slots.tempo=(d.slots.tempo||0)+v})}
      // Free calls are counts, never dollars - a free call earns $0 by
      // definition, so the lane is absent under the Revenue $ metric rather
      // than drawn as a bar pretending call count is revenue. The metric/
      // traffic handlers already keep those two from being selected together;
      // this is defence in depth for any future caller that sets state directly.
      if(state.traffic!=="paid"&&state.metric==="tx"&&state.wire==="all"&&state.scope!=="int"){
        state.free.forEach(function(r){var d=dayOf(r.day);d.slots.free=(d.slots.free||0)+(r.pow||0)})}
      var list=Object.keys(days).sort().map(function(k){return days[k]});
      // Weekly: dollars and transaction counts are additive, so a week is the
      // plain sum of its days, per lane and per folded "Other" chain. (Buyers
      // are not additive and never reach this branch - see above.)
      if(state.mode==="weekly"){var wk={};list.forEach(function(d){var k=weekOf(d.day);var w=wk[k]||(wk[k]={day:k,week:true,slots:{},oth:{}});
        for(var s in d.slots)w.slots[s]=(w.slots[s]||0)+d.slots[s];
        if(d.oth)for(var c in d.oth)w.oth[c]=(w.oth[c]||0)+d.oth[c]});
        list=Object.keys(wk).sort().map(function(k){return wk[k]})}
      // Monthly: same additivity argument as weekly - dollars and transaction
      // counts sum, buyers never reach this branch.
      if(state.mode==="monthly"){var mo={};list.forEach(function(d){var k=monthOf(d.day);var m=mo[k]||(mo[k]={day:k,month:true,slots:{},oth:{}});
        for(var s in d.slots)m.slots[s]=(m.slots[s]||0)+d.slots[s];
        if(d.oth)for(var c in d.oth)m.oth[c]=(m.oth[c]||0)+d.oth[c]});
        list=Object.keys(mo).sort().map(function(k){return mo[k]})}
      if(state.mode==="cum"){var acc={},accO={};list.forEach(function(d){var O=ORDERS();for(var k=0;k<O.length;k++){var s=O[k];
        acc[s]=(acc[s]||0)+(d.slots[s]||0);d.slots[s]=acc[s]}
        if(d.oth){for(var c in d.oth)accO[c]=(accO[c]||0)+d.oth[c]}
        d.oth={};for(var c2 in accO)d.oth[c2]=accO[c2]})}
      return list;
    }
    function fmt(v){return state.metric==="usd"?(v>=1?"$"+v.toFixed(2):"$"+v.toFixed(4)):String(Math.round(v))}
    function render(){
      var data=build(), svg=document.getElementById("rvzSvg"), tip=document.getElementById("rvzTip");
      if(!data.length){svg.outerHTML="";document.querySelector(".rvz-wrap").innerHTML='<div class="rvz-empty">ledger backfilling - the series appears as settlements sync</div>';return}
      var W=940,H=300,L=52,R=8,T=10,B=26,pw=W-L-R,ph=H-T-B;
      var ORD=ORDERS();
      var max=0;data.forEach(function(d){var t=0;for(var k=0;k<ORD.length;k++)t+=d.slots[ORD[k]]||0;if(t>max)max=t});
      max=max||1;
      var n=data.length, bw=Math.max(2,Math.min(34,pw/n-2));
      var x=function(i){return L+(pw/n)*i+(pw/n-bw)/2}, y=function(v){return T+ph-(v/max)*ph};
      var out=[];
      for(var g=0;g<=3;g++){var gv=max*g/3,gy=y(gv);
        out.push('<line x1="'+L+'" y1="'+gy+'" x2="'+(W-R)+'" y2="'+gy+'" stroke="var(--dash)" stroke-width="1"/>');
        out.push('<text x="'+(L-6)+'" y="'+(gy+4)+'" text-anchor="end" font-size="10" fill="var(--faint)" font-family="var(--font-mono)">'+fmt(gv)+"</text>")}
      var step=Math.ceil(n/8);
      data.forEach(function(d,i){
        if(i%step===0)out.push('<text x="'+(x(i)+bw/2)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="var(--faint)" font-family="var(--font-mono)">'+d.day.slice(5)+"</text>");
        var y0=T+ph;
        for(var k=0;k<ORD.length;k++){var s=ORD[k];var v=d.slots[s]||0;if(v<=0)continue;var h=(v/max)*ph;y0-=h;
          if(state.mode==="cum"){out.push('<rect x="'+x(i)+'" y="'+y0+'" width="'+bw+'" height="'+Math.max(h,0.5)+'" fill="'+css(s)+'" opacity="0.9"/>')}
          else{out.push('<rect x="'+x(i)+'" y="'+y0+'" width="'+bw+'" height="'+Math.max(h-1,0.5)+'" fill="'+css(s)+'" stroke="var(--vsurf)" stroke-width="1" rx="1"/>')}}
        out.push('<rect x="'+(L+(pw/n)*i)+'" y="'+T+'" width="'+(pw/n)+'" height="'+ph+'" fill="transparent" data-i="'+i+'"/>')});
      svg.innerHTML=out.join("");
      svg.onmousemove=function(ev){var t=ev.target.closest("rect[data-i]");if(!t){tip.style.display="none";return}
        var d=data[+t.dataset.i],rows="",tot=0;
        for(var k=ORD.length-1;k>=0;k--){var s=ORD[k];var v=d.slots[s]||0;if(v<=0)continue;tot+=v;
          rows+='<div><i style="display:inline-block;width:8px;height:8px;background:'+css(s)+';margin-right:5px"></i>'+NAMES[s]+" "+fmt(v)+"</div>";
          if(s===8&&d.oth){Object.keys(d.oth).sort().forEach(function(c){if(d.oth[c]>0)
            rows+='<div style="padding-left:13px;color:var(--muted)">'+chainName(c)+" "+fmt(d.oth[c])+"</div>"})}}
        tip.innerHTML="<b>"+(d.week?"week of "+d.day+(d.partial?" (in progress)":""):d.month?d.day.slice(0,7)+(d.partial?" (in progress)":""):d.day)+"</b>"+rows+"<div style='border-top:1px dashed var(--dark-border2);margin-top:3px'>total "+fmt(tot)+"</div>";
        var wr=document.querySelector(".rvz-wrap").getBoundingClientRect();
        tip.style.display="block";tip.style.left=Math.min(ev.clientX-wr.left+14,wr.width-270)+"px";tip.style.top=(ev.clientY-wr.top+10)+"px"};
      svg.onmouseleave=function(){tip.style.display="none"};
      var lg="",present={},othChains={};data.forEach(function(d){for(var k=0;k<ORD.length;k++)if(d.slots[ORD[k]])present[ORD[k]]=1;
        if(d.oth)Object.keys(d.oth).forEach(function(c){if(d.oth[c]>0)othChains[c]=1})});
      Object.keys(present).forEach(function(s){
        var label=NAMES[s];
        // Name what "Other" holds - the fold is visual, never informational.
        if(String(s)==="8"&&Object.keys(othChains).length)label+=" ("+Object.keys(othChains).sort().map(chainName).join(", ")+")";
        lg+='<span><i style="background:'+css(s)+'"></i>'+label+"</span>"});
      // An empty series under a wire filter is a real answer, not a broken
      // chart - say which filter emptied it rather than showing a blank grid.
      if(!Object.keys(present).length){
        lg='<span>no '+(state.metric==="buyers"?"buyers":state.traffic==="free"?"free-tier calls":
          (state.wire==="all"?"":state.wire==="mpp"?"MPP-wire ":"x402-wire ")+
          (state.scope==="ext"?"external":state.scope==="int"?"internal":"")+" settlements")+' in this window</span>'}
      document.getElementById("rvzLegend").innerHTML=lg;
      // The chart defaults to External, which is right - the canary is our own
      // money recycling and must never inflate revenue. But that makes "no
      // canary today" and "canary hidden by the current filter" look identical,
      // and someone reading the default view reasonably concluded the canary
      // had stopped running when it had settled on 11 of 12 rails that day.
      //
      // So when internal settlements EXIST in the window and are filtered out,
      // say so and name the control that shows them. The number on the chart
      // does not change; only the reader's ability to tell absence from
      // concealment does.
      (function(){
        var el=document.getElementById("rvzScopeNote");
        if(!el)return;
        if(state.scope!=="ext"){el.style.display="none";return}
        var days={},chains={};
        state.rows.forEach(function(r){
          if((r.intTx||0)>0){days[r.day]=1;chains[r.chain]=1}
        });
        var nd=Object.keys(days).length, nc=Object.keys(chains).length;
        if(!nd){el.style.display="none";return}
        el.style.display="";
        el.textContent="Showing external settlements only. "+nc+" chain"+(nc===1?"":"s")+
          " also settled internal (canary) transactions on "+nd+" day"+(nd===1?"":"s")+
          " in this window - select \u201cInternal (canary)\u201d or \u201cBoth\u201d to see them. "+
          "They are excluded from revenue on purpose: the canary buys from us with our own wallet.";
      })();
      // "Other" gets one muted sub-column per folded chain (a subset of the
      // Other column, so they never add to the row total).
      var othList=Object.keys(othChains).sort();
      var tb='<table><tr><th>'+(state.mode==="weekly"?"week of":state.mode==="monthly"?"month":"day")+'</th>';Object.keys(present).forEach(function(s){tb+="<th>"+NAMES[s]+"</th>";
        if(String(s)==="8")othList.forEach(function(c){tb+='<th style="color:var(--muted)">· '+chainName(c)+"</th>"})});tb+="<th>total</th></tr>";
      data.forEach(function(d){var tot=0;tb+="<tr><td>"+d.day+"</td>";Object.keys(present).forEach(function(s){var v=d.slots[s]||0;tot+=v;tb+="<td>"+fmt(v)+"</td>";
        if(String(s)==="8")othList.forEach(function(c){tb+='<td style="color:var(--muted)">'+fmt((d.oth||{})[c]||0)+"</td>"})});tb+="<td>"+fmt(tot)+"</td></tr>"});
      document.getElementById("rvzTable").innerHTML=tb+"</table>";
    }
    function buyersTrend(){
      // Rolling recent-vs-prior comparison (last 14 days vs the 14 before
      // that), not a lifetime first-half/second-half split - stays
      // meaningful as history grows, rather than diluting toward flat as
      // more old days accumulate. Needs 28 days of real data to say
      // anything; thin history omits the line entirely rather than
      // asserting a trend from a handful of points (found in an internal
      // audit, 2026-08-16: buyer diversity fell 45% over 60 days,
      // independent of any single wallet - this makes that visible without
      // eyeballing the chart).
      var rows=(state.buyers||[]).slice().sort(function(a,b){return a.day<b.day?-1:1});
      if(rows.length<28)return null;
      var recent=rows.slice(-14),prior=rows.slice(-28,-14);
      var avg=function(xs){return xs.reduce(function(s,r){return s+(r.buyers||0)},0)/xs.length};
      var ra=avg(recent),pa=avg(prior);
      if(pa<=0)return null;
      var pct=((ra-pa)/pa)*100;
      return {recent:ra,prior:pa,pct:pct};
    }
    function buyersNote(){
      var el=document.getElementById("rvzBuyersNote");
      if(state.metric!=="buyers"){el.style.display="none";return}
      el.style.display="block";
      var c=state.conc;
      var t=buyersTrend();
      var trendTxt="";
      if(t){
        var dir=t.pct<=-5?"down":t.pct>=5?"up":"flat";
        var arrow=dir==="down"?"↓":dir==="up"?"↑":"→";
        trendTxt=" "+arrow+" Last 14 days averaged "+t.recent.toFixed(1)+" distinct buyers/day, "+
          (dir==="flat"?"about the same as":dir+" "+Math.abs(t.pct).toFixed(0)+"% from")+
          " the 14 days before that ("+t.prior.toFixed(1)+"/day).";
      }
      // Retention is ALL-TIME and counted in DAYS, not payments: a buyer who
      // made forty calls in one afternoon and never came back evaluated us
      // once, and counting payments would score that session as loyalty. It is
      // the number that says whether any of the rest is a business.
      var r=state.ret,retTxt="";
      if(r&&r.buyers){
        retTxt=" Of "+r.buyers+" buyers all time, "+r.returned+" ("+r.returnedPct+"%) came back on another day and "+
          r.oneDay+" ("+r.oneDayPct+"%) never did"+
          (r.oneDayOneCall?", "+r.oneDayOneCall+" of those after a single call":"")+".";
      }
      el.textContent="Distinct external wallets that settled a payment. Someone paying on two chains in one day is one buyer, and the cumulative line is a running union rather than a sum."+
        (c&&c.buyers?" Over this window: "+c.buyers+" buyers, "+c.payments+" payments, biggest single wallet "+c.topSharePct+"% of them and the top five "+c.top5SharePct+"%.":"")+
        retTxt+trendTxt;
    }
    function settleNote(){
      var el=document.getElementById("rvzSettleNote");
      el.style.display=state.settle==="all"?"none":"block";
    }
    function freeNote(){
      var el=document.getElementById("rvzFreeNote");
      if(state.traffic==="paid"){el.style.display="none";return}
      el.style.display="block";
      el.textContent="Free calls are served via proof-of-work and settle nowhere, so they earn $0 and appear only under Transactions."+
        (state.freeSince?" Per-day recording of the free tier began "+state.freeSince+
          " - earlier days have no per-day record, which is not the same as no free traffic.":
          " Per-day recording of the free tier has not started yet.")+
        " Internal heartbeat probes are excluded.";
    }
    seg("rvzMode",function(v){state.mode=v});
    seg("rvzMetric",function(v){state.metric=v;
      // Revenue $ is paid-only: a free call has no dollar value to chart.
      if(v!=="tx"&&state.traffic!=="paid"){state.traffic="paid";setSeg("rvzTraffic","paid")}
      // Buyers counts settled external wallets, so the internal/canary scope,
      // the wire split, and the settled-to lane do not apply to it.
      if(v==="buyers"){if(state.scope!=="ext"){state.scope="ext";setSeg("rvzScope","ext")}
        if(state.wire!=="all"){state.wire="all";setSeg("rvzWire","all")}
        if(state.settle!=="all"){state.settle="all";setSeg("rvzSettle","all");settleNote()}}
      freeNote();buyersNote()});
    seg("rvzScope",function(v){state.scope=v;
      if(state.metric==="buyers"){state.metric="tx";setSeg("rvzMetric","tx");buyersNote()}
      // Free calls are external only; an internal-only view cannot include them.
      if(v==="int"&&state.traffic!=="paid"){state.traffic="paid";setSeg("rvzTraffic","paid");freeNote()}});
    seg("rvzTraffic",function(v){state.traffic=v;
      if(v!=="paid"&&state.metric!=="tx"){state.metric="tx";setSeg("rvzMetric","tx")}
      if(v!=="paid"&&state.settle!=="all"){state.settle="all";setSeg("rvzSettle","all");settleNote()}
      // Free calls have no wire and are always external.
      if(v!=="paid"&&state.wire!=="all"){state.wire="all";setSeg("rvzWire","all");document.getElementById("rvzWireNote").style.display="none"}
      if(v!=="paid"&&state.scope==="int"){state.scope="ext";setSeg("rvzScope","ext")}
      freeNote();buyersNote()});
    seg("rvzWire",function(v){state.wire=v;
      // The MPP subset and the SOR subset are not tracked as an intersection -
      // composing them would fabricate numbers, so they are mutually exclusive.
      if(v!=="all"&&state.settle!=="all"){state.settle="all";setSeg("rvzSettle","all");settleNote()}
      // Buyers is not split by wire: leave it rather than show the all-wire count under an x402/MPP label.
      if(v!=="all"&&state.metric==="buyers"){state.metric="tx";setSeg("rvzMetric","tx");buyersNote()}
      if(v!=="all"&&state.traffic!=="paid"){state.traffic="paid";setSeg("rvzTraffic","paid");freeNote()}
      document.getElementById("rvzWireNote").style.display=v==="all"?"none":"block"});
    seg("rvzSettle",function(v){state.settle=v;
      if(v!=="all"){
        if(state.wire!=="all"){state.wire="all";setSeg("rvzWire","all");document.getElementById("rvzWireNote").style.display="none"}
        // The SOR lane is settled revenue - the free tier settles nowhere.
        if(state.traffic!=="paid"){state.traffic="paid";setSeg("rvzTraffic","paid");freeNote()}
        if(state.metric==="buyers"){state.metric="tx";setSeg("rvzMetric","tx");buyersNote()}
      }
      settleNote()});
    // The free-tier and Tempo series are each a separate endpoint (free calls
    // never touch the settlement ledger; Tempo never touches the on-chain
    // scan). A failure in either must not blank the revenue chart, so each
    // degrades to an empty lane rather than rejecting the whole set.
    Promise.all([
      fetch("/api/revenue/daily").then(function(r){return r.json()}),
      fetch("/api/calls/daily").then(function(r){return r.json()}).catch(function(){return{days:[],recordingSince:null}}),
      fetch("/api/revenue/tempo-daily").then(function(r){return r.json()}).catch(function(){return{days:[],recordingSince:null}})
    ]).then(function(res){
      state.rows=res[0].days||[];
      state.free=res[1].days||[];
      state.freeSince=res[1].recordingSince||null;
      state.tempo=res[2].days||[];
      state.tempoSince=res[2].recordingSince||null;
      state.buyers=res[0].buyers||[];
      state.buyersWeekly=res[0].buyersWeekly||[];
      state.buyersMonthly=res[0].buyersMonthly||[];
      state.conc=res[0].concentration||null;
      state.ret=res[0].retention||null;
      render();
    }).catch(function(){document.querySelector(".rvz-wrap").innerHTML='<div class="rvz-empty">series unavailable</div>'});
  })();
