// Planning helpers: seasons, weather, thermals, driving, calendar, GPX.
const Regs = {
  forGMU(g){ return SEASONS.filter(s=>s.gmus.includes(g)); },
  open(g, date, species, weapon){ // species 'elk'|'deer' ; deer covers btd/wtd/mule
    const sps= species==='deer'?['btd','wtd','mule']:['elk'];
    return this.forGMU(g).filter(s=>sps.includes(s.sp)&&(!weapon||s.w===weapon)&&date>=s.s&&date<=s.e);
  },
  label(sp){ return {elk:'Elk',btd:'Black-tailed deer',wtd:'White-tailed deer',mule:'Mule deer'}[sp]; },
  // season-pressure estimate 0..1 for a date in a GMU: modern firearm openers are the peak
  pressureDay(g,date){
    const d=new Date(date+'T12:00:00Z'); const dow=d.getUTCDay(); let p=.15;
    for(const s of this.forGMU(g)){ if(date<s.s||date>s.e) continue; const day=Math.round((d-new Date(s.s+'T12:00:00Z'))/864e5);
      const base=s.w==='modern'?1:s.w==='muzzleloader'?.5:.35; const decay=day<=1?1:day<=3?.8:Math.max(.35,1-day*.06); p=Math.max(p,base*decay); }
    if(dow===0||dow===6) p=Math.min(1,p*1.35); return +p.toFixed(2);
  }
};
const Weather = {
  async forecast(lat,lon,date){
    try{ const u=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FLos_Angeles&start_date=${date}&end_date=${date}`;
      const j=await (await fetch(u)).json(); const d=j.daily; if(!d||!d.time?.length) return null;
      return {tmax:d.temperature_2m_max[0],tmin:d.temperature_2m_min[0],rain:d.precipitation_sum[0],wind:d.wind_speed_10m_max[0],windDir:d.wind_direction_10m_dominant[0],sunrise:d.sunrise[0].slice(11),sunset:d.sunset[0].slice(11)};
    }catch(e){ return null; }
  }
};
const Thermals = {
  advice(hours, spot, wx){ // hours: 'am'|'pm'|'all'
    const asp=spot.aspect; const lines=[];
    if(hours!=='pm') lines.push(`Morning: thermals fall downhill until about 2 hrs after sunrise${wx?` (${wx.sunrise})`:''}. Come in from BELOW the bed (${asp}-facing slope), climbing into the falling air. Be in position before gray light.`);
    if(hours!=='am') lines.push(`Evening: air rises uphill from mid-morning until sunset${wx?` (${wx.sunset})`:''}. Come in from ABOVE or along the ridge and let the rising thermals carry scent over the bed. Feeding starts on the cut edge in the last 90 min of light.`);
    if(wx&&wx.wind>=12) lines.push(`Forecast wind ${wx.wind} mph from ${['N','NE','E','SE','S','SW','W','NW'][Math.round(wx.windDir/45)%8]} will override thermals in the open. Keep it in your face on the final approach.`);
    if(spot.bench) lines.push('This is a bench in steep ground: expect a trail along it. Still-hunt the bench edge, do not walk down the middle.');
    return lines;
  }
};
const Drive = {
  async minutes(from,to){ // [lat,lon] pairs; OSRM public demo server
    try{ const u=`https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}?overview=false`; const j=await (await fetch(u)).json(); return j.routes?Math.round(j.routes[0].duration/60):null; }catch(e){ return null; }
  },
  async geocode(q){ try{ const j=await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`)).json(); return j[0]?[+j[0].lat,+j[0].lon]:null; }catch(e){ return null; } }
};
const Cal = {
  events:[], async load(){ try{ this.events=await (await fetch(CONFIG.CALENDAR_JSON+'?t='+Date.now())).json(); }catch(e){ this.events=[]; } return this.events; },
  busy(date){ return this.events.filter(e=>e.date===date); },
  // best days for the next N days in a GMU for a species/weapon
  bestDays(g, species, weapon, n=75){
    const out=[]; const t0=new Date(); 
    for(let i=0;i<n;i++){ const d=new Date(t0.getTime()+i*864e5); const date=d.toISOString().slice(0,10);
      const open=Regs.open(g,date,species,weapon); if(!open.length) continue;
      const busy=this.busy(date); const shift=busy.some(e=>/shift|duty|work|[ABCD]-?shift|24/i.test(e.summary)); const other=busy.filter(e=>!/shift|duty|work/i.test(e.summary));
      const pd=Regs.pressureDay(g,date); const rut=rutFactor(species,date);
      let score=(1-pd)*.5+rut*.35+.15; if(shift) score*=.05; else if(other.length) score*=.6;
      out.push({date,dow:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()],open:open.map(s=>`${s.w} ${s.ph} · ${s.legal}`).join('; '),pressure:pd,rut:+rut.toFixed(2),shift,other:other.map(e=>e.summary),score:+score.toFixed(2)});
    }
    return out.sort((a,b)=>b.score-a.score);
  }
};
const GPX = {
  build(name, spots, pins, route){
    const esc=s=>String(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    let x=`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="HuntMap" xmlns="http://www.topografix.com/GPX/1/1">\n<metadata><name>${esc(name)}</name></metadata>\n`;
    for(const s of spots){ x+=`<wpt lat="${s.bed[0]}" lon="${s.bed[1]}"><name>#${s.rank} bed ${s.score}</name><desc>${esc(`security ${s.sec}, slope ${s.slope}°, ${s.aspect}, ${s.elev} ft, ${s.roadKm} km off drivable road`)}</desc><sym>Flag, Red</sym></wpt>\n`;
      if(s.food) x+=`<wpt lat="${s.food[0]}" lon="${s.food[1]}"><name>#${s.rank} feed</name><sym>Flag, Green</sym></wpt>\n`;
      if(s.park) x+=`<wpt lat="${s.park[0]}" lon="${s.park[1]}"><name>#${s.rank} park</name><sym>Car</sym></wpt>\n`; }
    for(const p of pins) x+=`<wpt lat="${p.lat}" lon="${p.lng}"><name>${esc(p.kind)}: ${esc(p.note)}</name><time>${p.created_at}</time></wpt>\n`;
    if(route&&route.length) x+=`<rte><name>${esc(name)} approach</name>${route.map(p=>`<rtept lat="${p[0]}" lon="${p[1]}"/>`).join('')}</rte>\n`;
    return x+'</gpx>';
  },
  download(name, text){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type:'application/gpx+xml'})); a.download=name.replace(/[^a-z0-9]+/gi,'_')+'.gpx'; document.body.appendChild(a); a.click(); a.remove(); }
};
