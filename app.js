// UI wiring
const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
const S={gmu:null,gmuNum:null,layers:null,grid:null,elev:null,terr:null,model:null,spots:[],pins:[],hunts:[],settings:{},wx:null,pinKind:null,cache:{}};
const say=m=>$('#status').innerHTML=m;
const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
// ---- map ----
const map=L.map('map',{zoomControl:true}).setView([46.67,-123.5],10);
const BASES={"USGS Topo":L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',{maxZoom:16,attribution:'USGS'}),
 "Satellite":L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Esri'}),
 "OpenTopo":L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{maxZoom:17,attribution:'OpenTopoMap'})};
let curBase=null; function setBase(n){ if(curBase)map.removeLayer(curBase); curBase=BASES[n].addTo(map); curBase.bringToBack(); $$('#basemaps .chip').forEach(c=>c.setAttribute('aria-pressed',c.dataset.b===n)); }
Object.keys(BASES).forEach(n=>{const b=document.createElement('button');b.className='chip';b.dataset.b=n;b.textContent=n;b.onclick=()=>setBase(n);$('#basemaps').appendChild(b);}); setBase('USGS Topo');
['land','heat','cuts','lines','pins'].forEach((p,i)=>{map.createPane(p);map.getPane(p).style.zIndex=340+i*20;});
const OV={hill:L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}',{opacity:.45,maxZoom:16}),
 contour:L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',{opacity:.55,maxZoom:16}),
 gmu:L.layerGroup(),public:L.layerGroup(),roads:L.layerGroup(),gates:L.layerGroup(),rivers:L.layerGroup(),cuts:L.layerGroup(),pins:L.layerGroup()};
const planLayer=L.layerGroup().addTo(map); let heatLayer=null; let heatKind='score';
Object.entries(OV).forEach(([k,l])=>{const cb=$('#ov-'+k); if(cb.checked)l.addTo(map); cb.onchange=()=>cb.checked?l.addTo(map):map.removeLayer(l);});
[['score','Combined score'],['sec','Security'],['pressure','Pressure'],['food','Food'],['none','Off']].forEach(([k,n])=>{const b=document.createElement('button');b.className='chip';b.dataset.h=k;b.textContent=n;b.setAttribute('aria-pressed',k===heatKind);b.onclick=()=>{heatKind=k;$$('#heats .chip').forEach(c=>c.setAttribute('aria-pressed',c.dataset.h===k));drawHeat();};$('#heats').appendChild(b);});
const ROAD_COL={hwy:'#7a1f0c',county:'#7a1f0c',mainline:'#2b6cb0',spur:'#6aa0d8',gated:'#c98a1a',closed:'#8a8a8a',trail:'#6b5b95'};
// ---- header ----
function fillGMUs(){ const sel=$('#gmuSel'); const mine=CONFIG.MY_GMUS; const og1=document.createElement('optgroup');og1.label='My units'; mine.forEach(n=>{const o=new Option(`${n} ${GMUS[n]?.name||''}`,n);og1.appendChild(o);}); sel.appendChild(og1);
  const og2=document.createElement('optgroup');og2.label='All units'; Object.keys(GMUS).map(Number).sort((a,b)=>a-b).filter(n=>!mine.includes(n)).forEach(n=>og2.appendChild(new Option(`${n} ${GMUS[n].name}`,n))); sel.appendChild(og2);
  sel.value=localStorage.getItem('huntmap:gmu')||CONFIG.DEFAULT_GMU; }
// ---- load a GMU ----
async function loadGMU(num){
  num=+num; S.gmuNum=num; localStorage.setItem('huntmap:gmu',num); planLayer.clearLayers(); if(heatLayer){map.removeLayer(heatLayer);heatLayer=null;} $('#results').innerHTML=''; $('#gpx').disabled=true;
  try{
    if(S.cache[num]){ Object.assign(S,S.cache[num]); drawLayers(); map.fitBounds(L.geoJSON(S.gmu).getBounds()); renderAll(); say(`<b>${num} ${GMUS[num].name}</b> ready`); return; }
    say(`Loading GMU ${num} boundary…`); const gmu=await Data.gmu(num); S.gmu=gmu; map.fitBounds(L.geoJSON(gmu).getBounds());
    say('Loading public land, harvest units, roads…');
    const [dnr,pad,cuts,osm]=await Promise.all([Data.dnr(gmu),Data.pad(gmu),Data.cuts(gmu),Data.osm(gmu)]);
    S.layers={public:[...dnr,...pad.filter(f=>f.properties.access==='open')],dnr,pad,cuts,...osm};
    drawLayers(); renderRegs(); renderDays();
    const grid=Grid.forBbox(gmu.bbox,CONFIG.DEM_ZOOM); S.grid=grid;
    say(`Loading terrain (${grid.W/256}×${grid.H/256} tiles)…`); S.elev=await Terrain.load(grid,(d,n)=>say(`Terrain ${d}/${n}`)); S.layers.elev=S.elev;
    say('Computing slope, aspect, benches…'); await tick(); S.terr=Terrain.derive(grid,S.elev);
    say('Building pressure and habitat rasters…'); await tick(); S.model=new Model(grid,S.terr,S.layers);
    S.cache[num]={gmu:S.gmu,layers:S.layers,grid:S.grid,elev:S.elev,terr:S.terr,model:S.model};
    say(`<b>${num} ${GMUS[num].name}</b> ready · ${cuts.length} harvest units · ${dnr.length} DNR parcels · ${osm.gates.length} gates`);
    renderAll();
  }catch(e){ say(`<b style="color:var(--bad)">Error:</b> ${e.message}`); console.error(e); }
}
const tick=()=>new Promise(r=>setTimeout(r,30));
function drawLayers(){
  Object.values(OV).forEach(l=>{ if(l instanceof L.LayerGroup) l.clearLayers(); });
  const Ly=S.layers; L.geoJSON(S.gmu,{pane:'lines',style:{color:'#111',weight:2.5,fill:false,dashArray:'6 4'},interactive:false}).addTo(OV.gmu);
  L.geoJSON({type:'FeatureCollection',features:Ly.dnr},{pane:'land',style:{color:'#2f7d4f',weight:.7,fillColor:'#2f7d4f',fillOpacity:.25},onEachFeature:(f,l)=>l.bindPopup('<b>DNR state trust land</b><br>Open walk-in. Discover Pass at developed sites.')}).addTo(OV.public);
  L.geoJSON({type:'FeatureCollection',features:Ly.pad},{pane:'land',style:f=>({color:'#3a7ca5',weight:.7,fillColor:'#3a7ca5',fillOpacity:f.properties.access==='open'?.25:.1}),onEachFeature:(f,l)=>l.bindPopup(`<b>${f.properties.Unit_Nm||'Public land'}</b><br>${f.properties.owner} · ${f.properties.access}`)}).addTo(OV.public);
  for(const r of Ly.roads) L.polyline(r.ll,{pane:'lines',color:ROAD_COL[r.cls],weight:/hwy|county|mainline/.test(r.cls)?2.2:1.5,opacity:.9}).bindPopup(`<b>${r.name||r.cls}</b><br>class: ${r.cls} (traffic weight ${ROAD_W[r.cls]})${r.surface?' · '+r.surface:''}${r.hasGate?' · gate on this segment':''}`).addTo(OV.roads);
  for(const g of Ly.gates) L.marker(g,{pane:'lines',icon:L.divIcon({className:'',html:'<div class="gate"></div>',iconSize:[10,10]})}).bindPopup('<b>Gate</b><br>Walk-in beyond here unless posted otherwise').addTo(OV.gates);
  for(const ll of Ly.rivers) L.polyline(ll,{pane:'lines',color:'#3b82c4',weight:2,opacity:.8,interactive:false}).addTo(OV.rivers);
  const yr=+$('#date').value.slice(0,4);
  L.geoJSON({type:'FeatureCollection',features:Ly.cuts},{pane:'cuts',style:f=>{const a=yr-f.properties.year;const c=a<3?'#f7d774':a<10?'#e6a23c':a<16?'#b7791f':'#8f8f8f';return{color:c,weight:.5,fillColor:c,fillOpacity:.35}},onEachFeature:(f,l)=>l.bindPopup(`<b>Harvest unit</b> ${f.properties.TIMHARV_FP_TY_LABEL_NM}<br>Approved ${f.properties.year} → ~${yr-f.properties.year} yrs · ${Math.round(f.properties.TIMHARV_RPT_AREA||0)} ac`)}).addTo(OV.cuts);
  drawPins();
}
// ---- plan ----
function planOpts(){ const date=$('#date').value; const species=$('#species').value; const p=$('#pressure').value; const pd=p==='auto'?Regs.pressureDay(S.gmuNum,date):+p;
  return {species,date,tmaxF:S.wx?.tmax??58,rain:(S.wx?.rain??0)>.1,pressureDay:pd}; }
async function runPlan(){
  if(!S.model){ say('Unit still loading'); return; } const btn=$('#run'); btn.disabled=true;
  const c=Geo.centroid(S.gmu.geometry); S.wx=$('#useWx').checked?await Weather.forecast(c[1],c[0],$('#date').value):null;
  $('#wx').textContent=S.wx?`Forecast ${$('#date').value}: ${Math.round(S.wx.tmin)}–${Math.round(S.wx.tmax)}°F, ${S.wx.rain}" rain, wind ${Math.round(S.wx.wind)} mph. Sunrise ${S.wx.sunrise}, sunset ${S.wx.sunset}.`:'No forecast (date beyond 16 days or weather off): using mild, dry defaults.';
  say('Scoring…'); await tick(); const o=planOpts(); S.model.score(o);
  S.spots=S.model.hotspots(12,{walkMaxKm:+$('#walk').value*1.609}); drawHeat(); drawSpots(); renderResults(o); $('#gpx').disabled=!S.spots.length; btn.disabled=false;
  say(`<b>${S.gmuNum}</b> plan: pressure ${Math.round(o.pressureDay*100)}%, rut ${Math.round(S.model.last.rut*100)}%`);
}
function drawHeat(){ if(heatLayer){map.removeLayer(heatLayer);heatLayer=null;} if(!S.model?.last||heatKind==='none') return; const cv=S.model.paint(heatKind); heatLayer=L.imageOverlay(cv.toDataURL(),S.grid.bounds(),{opacity:.75,pane:'heat',interactive:false}).addTo(map); }
function drawSpots(){ planLayer.clearLayers(); for(const s of S.spots){ L.marker(s.bed,{icon:L.divIcon({className:'',html:`<div class="numIcon">${s.rank}</div>`,iconSize:[22,22],iconAnchor:[11,11]}),pane:'pins'}).on('click',()=>selectSpot(s)).addTo(planLayer); } }
function renderResults(o){ const el=$('#results'); const open=Regs.open(S.gmuNum,o.date,o.species,$('#weapon').value);
  el.innerHTML=`<h2>Top spots for ${SPECIES[o.species].name.split(' /')[0]} · ${o.date}</h2>`+(open.length?'':`<div class="note bad">No ${o.species} general season open in ${S.gmuNum} on ${o.date}${$('#weapon').value?' for '+$('#weapon').value:''}. Scouting plan only.</div>`)+
   S.spots.map(s=>`<div class="spot" data-r="${s.rank}"><span class="rk">${s.rank}</span><span>${s.slope}° ${s.aspect} face${s.bench?' · bench':''} · ${s.elev} ft</span><span class="sc">${s.score}</span><span class="meta">security ${s.sec} · pressure ${s.pressure} · ${(s.roadKm*.621).toFixed(1)} mi off drivable road · ${(s.walkKm*.621).toFixed(1)} mi walk-in${s.foodFit?` · feed ${s.foodFit}`:''}</span><span class="bar"><i style="width:${s.score}%"></i></span></div>`).join('')+`<div id="detail"></div>`;
  $$('#results .spot').forEach(d=>d.onclick=()=>selectSpot(S.spots[+d.dataset.r-1])); }
async function selectSpot(s){ $$('#results .spot').forEach(d=>d.classList.toggle('active',+d.dataset.r===s.rank)); map.setView(s.bed,14);
  planLayer.eachLayer(l=>{ if(l._tmp) planLayer.removeLayer(l); });
  const add=l=>{l._tmp=true;l.addTo(planLayer);return l;};
  if(s.food) add(L.circleMarker(s.food,{radius:7,color:'#2f7d4f',fillColor:'#2f7d4f',fillOpacity:.8,pane:'pins'}).bindTooltip('feed'));
  if(s.park) add(L.circleMarker(s.park,{radius:7,color:'#2b6cb0',fillColor:'#fff',fillOpacity:1,pane:'pins'}).bindTooltip('park'));
  const route=[s.park,s.bed].filter(Boolean); if(route.length===2) add(L.polyline(route,{color:'#111',dashArray:'4 6',weight:2,pane:'pins'}));
  if(s.food) add(L.polyline([s.bed,s.food],{color:'#2f7d4f',dashArray:'2 6',weight:2,pane:'pins'}));
  const hrs=$('#hours').value; const th=Thermals.advice(hrs,s,S.wx);
  let drive=''; if(S.settings.home_lat){ const m=await Drive.minutes([S.settings.home_lat,S.settings.home_lng],s.park||s.bed); if(m) drive=`<p><b>Drive from home:</b> ~${Math.floor(m/60)}h ${m%60}m to the parking point.</p>`; }
  $('#detail').innerHTML=`<div class="detail"><p><b>#${s.rank} · score ${s.score}</b> · bed ${s.bed[0].toFixed(5)}, ${s.bed[1].toFixed(5)}</p>
   <p>Bedding: ${s.slope}° slope, ${s.aspect} aspect, ${s.elev} ft${s.bench?', on a bench':''}. Security ${s.sec}/100, pressure ${s.pressure}/100. ${(s.roadKm*.621).toFixed(1)} mi from the nearest drivable road, ${(s.gateKm*.621).toFixed(1)} mi from the nearest gate.</p>
   ${s.food?`<p>Nearest feed: harvest unit ${(Geo.km([s.bed[1],s.bed[0]],[s.food[1],s.food[0]])*.621).toFixed(1)} mi away (fit ${s.foodFit}/100). Expect the bed-to-feed line to cross benches and the timber edge; sign will be on that edge.</p>`:'<p>No aged harvest unit within range; feed is riparian brush or older cuts.</p>'}
   ${th.map(t=>`<p>${t}</p>`).join('')}${drive}</div>`; }
$('#run').onclick=runPlan; $('#clearPlan').onclick=()=>{planLayer.clearLayers();$('#results').innerHTML='';S.spots=[];if(heatLayer){map.removeLayer(heatLayer);heatLayer=null;}$('#gpx').disabled=true;};
$('#gpx').onclick=()=>GPX.download(`GMU${S.gmuNum}_${$('#species').value}_${$('#date').value}`,GPX.build(`GMU ${S.gmuNum} ${$('#species').value} ${$('#date').value}`,S.spots,S.pins.filter(p=>p.gmu===S.gmuNum),null));
// ---- regs & days ----
function renderRegs(){ const g=S.gmuNum, date=$('#date').value; const rows=Regs.forGMU(g).sort((a,b)=>a.sp.localeCompare(b.sp)||a.s.localeCompare(b.s));
  const st=s=>date>=s.s&&date<=s.e?'<span class="pill open">OPEN</span>':(s.s>date&&(new Date(s.s)-new Date(date))/864e5<=21?`<span class="pill soon">in ${Math.ceil((new Date(s.s)-new Date(date))/864e5)} d</span>`:'<span class="pill closed">closed</span>');
  const f=d=>new Date(d+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
  $('#tab-regs').innerHTML=`<h2>GMU ${g} ${GMUS[g].name} · 2026-27 general seasons</h2><div class="hint">Deer and elk from the WDFW pamphlet (eRegulations). Bear: check BMU dates. Cougar: call 1-866-364-4868 for cap status. Special permits not shown.</div>
   <table><tr><th>Species</th><th>Weapon</th><th>Dates</th><th>Legal</th><th></th></tr>${rows.map(s=>`<tr><td>${Regs.label(s.sp)}</td><td>${s.w} ${s.ph}</td><td class="num">${f(s.s)}–${f(s.e)}</td><td>${s.legal}${s.notes.length?`<br><small>${s.notes.join('; ')}</small>`:''}</td><td>${st(s)}</td></tr>`).join('')}</table>`;
  const now=Regs.open(g,date,$('#species').value,$('#weapon').value); $('#openNow').innerHTML=now.length?`<b>Open ${date}:</b> ${now.map(s=>`${Regs.label(s.sp)} ${s.w} (${s.legal})`).join(' · ')}`:`<b>Nothing open</b> for ${$('#species').value}${$('#weapon').value?' / '+$('#weapon').value:''} in ${g} on ${date}.`; $('#openNow').className='note'+(now.length?'':' bad'); }
async function renderDays(){ await Cal.load(); const g=S.gmuNum; const days=Cal.bestDays(g,$('#species').value,$('#weapon').value);
  $('#tab-days').innerHTML=`<h2>Best days · next 75 · GMU ${g}</h2><div class="hint">${Cal.events.length?`${Cal.events.length} calendar events loaded. Shift days score near zero.`:'No calendar loaded yet (data/calendar.json). Days are ranked on season pressure and rut only.'}</div>`+
   (days.length?days.slice(0,25).map(d=>`<div class="day"><span class="d">${d.dow} ${d.date.slice(5)}</span><span>${d.open}</span><span class="sc">${Math.round(d.score*100)}</span><span class="m">pressure ${Math.round(d.pressure*100)}% · rut ${Math.round(d.rut*100)}%${d.shift?' · <b>on shift</b>':''}${d.other.length?' · '+d.other.join(', '):''}</span></div>`).join(''):'<div class="hint">No open seasons in the window.</div>'); }
// ---- pins & log ----
const KINDS=[['sign','#d9631e'],['bed','#7a1f0c'],['wallow','#3b82c4'],['sighting','#2f7d4f'],['kill','#111'],['camp','#6b5b95'],['glass','#b8860b'],['gate','#8a8a8a']];
KINDS.forEach(([k,c])=>{const b=document.createElement('button');b.className='chip';b.dataset.k=k;b.innerHTML=`<span class="sw" style="background:${c};border-radius:50%;width:9px;height:9px"></span> ${k}`;b.onclick=()=>{S.pinKind=S.pinKind===k?null:k;$$('#pinKinds .chip').forEach(x=>x.setAttribute('aria-pressed',x.dataset.k===S.pinKind));map.getContainer().style.cursor=S.pinKind?'crosshair':'';};$('#pinKinds').appendChild(b);});
map.on('click',async e=>{ if(!S.pinKind) return; const note=prompt(`${S.pinKind} note (optional)`)||''; const p=await Store.add('pins',{gmu:S.gmuNum,kind:S.pinKind,note,lat:+e.latlng.lat.toFixed(6),lng:+e.latlng.lng.toFixed(6),date:$('#date').value}); S.pins.unshift(p); drawPins(); renderPins(); });
function drawPins(){ OV.pins.clearLayers(); for(const p of S.pins){ if(p.gmu!==S.gmuNum) continue; const c=Object.fromEntries(KINDS)[p.kind]||'#d9631e'; L.marker([p.lat,p.lng],{pane:'pins',icon:L.divIcon({className:'',html:`<div class="pinIcon" style="background:${c}"></div>`,iconSize:[14,14],iconAnchor:[7,7]})}).bindPopup(`<b>${p.kind}</b> ${p.note||''}<br><small>${(p.date||p.created_at).slice(0,10)}</small>`).addTo(OV.pins); } }
function renderPins(){ const el=$('#pinList'); const mine=S.pins.filter(p=>p.gmu===S.gmuNum); el.innerHTML=mine.length?mine.map(p=>`<div class="item"><span><b>${p.kind}</b> ${p.note||''} <small>${(p.date||p.created_at).slice(0,10)}</small></span><span><button data-go="${p.id}">go</button> <button data-del="${p.id}">✕</button></span></div>`).join(''):'<div class="hint">No pins in this unit yet.</div>';
  $$('#pinList [data-go]').forEach(b=>b.onclick=()=>{const p=S.pins.find(x=>x.id===b.dataset.go);map.setView([p.lat,p.lng],15);}); $$('#pinList [data-del]').forEach(b=>b.onclick=async()=>{await Store.remove('pins',b.dataset.del);S.pins=S.pins.filter(x=>x.id!==b.dataset.del);drawPins();renderPins();}); }
function renderHunts(){ const el=$('#huntList'); el.innerHTML=S.hunts.length?S.hunts.map(h=>`<div class="item"><span><b>${h.date}</b> GMU ${h.gmu} · ${h.species} ${h.weapon} ${h.hours}<br><small>saw: ${h.saw||'—'} · harvest: ${h.harvest||'none'}${h.notes?' · '+h.notes:''}</small></span><button data-del="${h.id}">✕</button></div>`).join(''):'<div class="hint">No hunt days logged.</div>';
  $$('#huntList [data-del]').forEach(b=>b.onclick=async()=>{await Store.remove('hunts',b.dataset.del);S.hunts=S.hunts.filter(x=>x.id!==b.dataset.del);renderHunts();}); }
$('#huntForm').onsubmit=async e=>{ e.preventDefault(); const f=new FormData(e.target); const row=Object.fromEntries(f.entries()); row.gmu=S.gmuNum; if(S.wx) row.weather=`${Math.round(S.wx.tmin)}–${Math.round(S.wx.tmax)}F ${S.wx.rain}in wind ${Math.round(S.wx.wind)}`; const h=await Store.add('hunts',row); S.hunts.unshift(h); renderHunts(); e.target.reset(); e.target.date.value=today(); };
$('#exportLog').onclick=()=>{ const t=S.hunts.map(h=>`${h.date}\tGMU ${h.gmu}\t${h.species}\t${h.weapon}\t${h.hours}\tsaw: ${h.saw||''}\tharvest: ${h.harvest||'none'}\t${h.notes||''}`).join('\n'); navigator.clipboard?.writeText(t); alert('Copied '+S.hunts.length+' hunt days to clipboard.'); };
async function loadUserData(){ try{ S.pins=await Store.list('pins'); S.hunts=await Store.list('hunts'); S.settings=await Store.settings(); }catch(e){ console.warn(e); } drawPins(); renderPins(); renderHunts(); }
// ---- account / settings ----
function acctLabel(){ const m=Store.mode(); $('#acct').textContent=m==='cloud'?(Store.user.email.split('@')[0]+' ▾'):m==='signed-out'?'Sign in':'Local only'; }
$('#acct').onclick=async()=>{ const m=Store.mode(); if(m==='signed-out'){ $('#acctDlg').showModal(); return; } if(m==='cloud'&&confirm('Sign out? (settings dialog: Cancel)')){ await Store.signOut(); return; } $('#homeAddr').value=S.settings.home_addr||''; $('#setDlg').showModal(); };
$('#sendLink').onclick=async e=>{ e.preventDefault(); try{ await Store.signIn($('#email').value); alert('Link sent. Open it on this device.'); $('#acctDlg').close(); }catch(err){ alert(err.message); } };
$('#saveSet').onclick=async e=>{ e.preventDefault(); const q=$('#homeAddr').value.trim(); const ll=q?await Drive.geocode(q):null; if(q&&!ll){ $('#homeHint').textContent='Could not find that address.'; return; } S.settings={...S.settings,home_addr:q,home_lat:ll?.[0]||null,home_lng:ll?.[1]||null}; await Store.saveSettings(S.settings); $('#setDlg').close(); };
document.addEventListener('auth',()=>{acctLabel();loadUserData();});
// ---- tabs & header events ----
$$('nav [role=tab]').forEach(b=>b.onclick=()=>{$$('nav [role=tab]').forEach(x=>x.setAttribute('aria-selected',x===b));$$('.pane').forEach(p=>p.hidden=p.id!=='tab-'+b.dataset.tab);});
function renderAll(){ renderRegs(); renderDays(); }
$('#gmuSel').onchange=e=>loadGMU(e.target.value); $('#date').onchange=()=>{ if(S.gmu) renderAll(); }; $('#species').onchange=$('#weapon').onchange=()=>{ if(S.gmu) renderAll(); };
// ---- boot ----
(async()=>{ fillGMUs(); $('#date').value=today(); $('#huntForm').date.value=today(); await Store.init(); acctLabel(); await loadUserData(); loadGMU($('#gmuSel').value); })();
