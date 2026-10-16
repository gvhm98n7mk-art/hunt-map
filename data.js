// Live data loaders. All public services, all CORS-open (verified 2026-09-19).
const SVC = {
  gmu: "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/HOReferenceService/MapServer/0",
  dnr: "https://gis.dnr.wa.gov/site3/rest/services/Public_Boundaries/WADNR_PUBLIC_Cadastre_OpenData/MapServer/6",
  pad: "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Name_PADUS/FeatureServer/0",
  nlcd: "https://www.mrlc.gov/geoserver/mrlc_download/wms",
  facts: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TimberHarvest_01/MapServer/",
  fpa: "https://gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/Forest_Practices_Applications_offline/FeatureServer/6",
  dnrRoads: "https://gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/WADNR_PUBLIC_FP_Trans/FeatureServer/2",
  overpass: ["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter","https://overpass.private.coffee/api/interpreter"],
  dem: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
};
const Geo = {
  centroid(g){ const ring=g.type==='Polygon'?g.coordinates[0]:g.coordinates[0][0]; let x=0,y=0; for(const p of ring){x+=p[0];y+=p[1];} return [ring.length?x/ring.length:0, ring.length?y/ring.length:0]; },
  pipRing(x,y,r){ let inside=false; for(let i=0,j=r.length-1;i<r.length;j=i++){ const xi=r[i][0],yi=r[i][1],xj=r[j][0],yj=r[j][1]; if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside; } return inside; },
  pip(x,y,g){ const polys=g.type==='Polygon'?[g.coordinates]:g.coordinates; return polys.some(rs=>this.pipRing(x,y,rs[0]) && !rs.slice(1).some(h=>this.pipRing(x,y,h))); },
  bbox(g){ let W=180,S=90,E=-180,N=-90; const walk=c=>{ if(typeof c[0]==='number'){ if(c[0]<W)W=c[0]; if(c[0]>E)E=c[0]; if(c[1]<S)S=c[1]; if(c[1]>N)N=c[1]; } else c.forEach(walk); }; walk(g.coordinates); return [W,S,E,N]; },
  // Does this polygon actually overlap the unit? The old test used the polygon's centroid, which
  // threw away every large or concave shape whose middle falls outside the GMU. That silently
  // deleted most of Olympic National Forest from GMU 621 (49% public instead of the real 74%).
  overlapsUnit(g, gmu){
    const b=this.bbox(g), gb=gmu.bbox||this.bbox(gmu.geometry);
    if(b[2]<gb[0]||b[0]>gb[2]||b[3]<gb[1]||b[1]>gb[3]) return false;
    const ring=g.type==='Polygon'?g.coordinates[0]:g.coordinates[0][0];
    const st=Math.max(1,Math.floor(ring.length/48));
    for(let i=0;i<ring.length;i+=st) if(this.pip(ring[i][0],ring[i][1],gmu.geometry)) return true;
    const c=this.centroid(g); if(this.pip(c[0],c[1],gmu.geometry)) return true;
    const gr=gmu.geometry.type==='Polygon'?gmu.geometry.coordinates[0]:gmu.geometry.coordinates[0][0];
    const st2=Math.max(1,Math.floor(gr.length/48));
    for(let i=0;i<gr.length;i+=st2) if(this.pip(gr[i][0],gr[i][1],g)) return true;
    return false;
  },
  splitMulti(f){ if(f.geometry.type!=='MultiPolygon') return [f]; return f.geometry.coordinates.map(c=>({type:'Feature',properties:f.properties,geometry:{type:'Polygon',coordinates:c}})); },
  km(a,b){ const dy=(a[1]-b[1])*111.32, dx=(a[0]-b[0])*111.32*Math.cos((a[1]+b[1])/2*Math.PI/180); return Math.hypot(dx,dy); }
};
async function arcAll(base, where, bbox, outFields, extra=''){
  const env=`geometry=${bbox.join(',')}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outSR=4326`;
  let feats=[], off=0;
  for(let i=0;i<30;i++){
    const u=`${base}/query?where=${encodeURIComponent(where)}&${env}&outFields=${outFields}&f=geojson&maxAllowableOffset=0.0002&resultOffset=${off}&resultRecordCount=1000${extra}`;
    const j=await (await fetch(u)).json(); if(j.error) throw new Error(j.error.message);
    feats=feats.concat(j.features||[]);
    if(!(j.exceededTransferLimit||j.properties?.exceededTransferLimit)||!(j.features||[]).length) break; off+=j.features.length;
  }
  return feats;
}
async function arcAllParallel(base, where, bbox, outFields, offset='0.0001'){
  const env=`geometry=${bbox.join(',')}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outSR=4326`;
  const c=await (await fetch(`${base}/query?where=${encodeURIComponent(where)}&${env}&returnCountOnly=true&f=json`)).json();
  const n=c.count||0, pages=Math.ceil(n/1000); let feats=[];
  for(let p=0;p<pages;p+=4){
    const batch=[]; for(let q=p;q<Math.min(pages,p+4);q++) batch.push(fetch(`${base}/query?where=${encodeURIComponent(where)}&${env}&outFields=${outFields}&f=geojson&maxAllowableOffset=${offset}&resultOffset=${q*1000}&resultRecordCount=1000&orderByFields=OBJECTID`).then(r=>r.json()));
    for(const j of await Promise.all(batch)) feats=feats.concat(j.features||[]);
  }
  return feats;
}
// DNR road status/access/control -> pressure class
function dnrRoadClass(a){
  const st=a.ROAD_STATUS_LBL||'', acc=a.ROAD_PUBLIC_ACCESS_LBL||'', ctl=a.ROAD_CONTROL_LBL||'', cls=a.ROAD_DNR_CLASS_LBL||'', usgs=a.ROAD_USGS_CLASS_LBL||'';
  if(/Planned/.test(st)) return null;
  if(/Abandon|Decommission|Orphan|Closed/.test(st) || /Not Driveable/.test(acc)) return 'closed';
  if(/Primary|Secondary/.test(usgs)) return 'hwy';
  if(/DOT|County|City/.test(ctl)) return 'county';
  if(/Gated|Management/.test(acc) || /Private/.test(ctl)) return 'gated';
  if(!/DNR|BPA|Parks/.test(ctl) && !/Year-Round/.test(acc)) return 'unknown'; // private timber road DNR only has as a line; resolved by land owner in Model.build
  if(/Mainline/.test(cls)) return 'mainline';
  return 'spur';
}
const Data = {
  async gmu(num){
    const j=await (await fetch(`${SVC.gmu}/query?where=GMU_Num%3D${num}&outFields=GMU_Num,GMU_Name,EastWest_Ind&returnGeometry=true&outSR=4326&f=geojson&maxAllowableOffset=0.0003`)).json();
    if(!j.features?.length) throw new Error('GMU '+num+' not found'); const f=j.features[0]; f.bbox=Geo.bbox(f.geometry); return f;
  },
  async dnr(gmu){
    const f=await arcAll(SVC.dnr,"SURFACE_RIGHTS_FLG='Y'",gmu.bbox,"SURFACE_TRUST_CD");
    return f.flatMap(Geo.splitMulti).filter(x=>Geo.overlapsUnit(x.geometry,gmu)).map(x=>(x.properties.owner='DNR state trust',x.properties.access='open',x));
  },
  async pad(gmu){
    const f=await arcAll(SVC.pad,"Mang_Type<>'PVT' AND Mang_Type<>'SDNR' AND Pub_Access IN ('OA','RA') AND GIS_Acres>10",gmu.bbox,"Unit_Nm,Mang_Name,Mang_Type,Pub_Access,GIS_Acres");
    return f.flatMap(Geo.splitMulti).filter(x=>Geo.overlapsUnit(x.geometry,gmu)).map(x=>(x.properties.owner=x.properties.Mang_Name||x.properties.Mang_Type,x.properties.access=x.properties.Pub_Access==='OA'?'open':'restricted',x));
  },
  async cuts(gmu){
    const f=await arcAll(SVC.fpa,"TIMHARV_FP_TY_LABEL_NM LIKE 'Even%' AND DECISION IN ('Approved','Expired','Renewed','Closed') AND EFFECTIVE_DT > DATE '2004-01-01'",gmu.bbox,"FP_ID,EFFECTIVE_DT,TIMHARV_RPT_AREA,TIMHARV_FP_TY_LABEL_NM,DECISION");
    return f.flatMap(Geo.splitMulti).filter(x=>Geo.overlapsUnit(x.geometry,gmu)).map(x=>(x.properties.year=new Date(x.properties.EFFECTIVE_DT).getUTCFullYear(),x));
  },
  async dnrRoads(gmu){
    const f=await arcAllParallel(SVC.dnrRoads,"ROAD_STATUS_LBL<>'Planned'",gmu.bbox,"ROAD_NM,ROAD_NO,ROAD_STATUS_LBL,ROAD_PUBLIC_ACCESS_LBL,ROAD_CONTROL_LBL,ROAD_DNR_CLASS_LBL,ROAD_USGS_CLASS_LBL,ROAD_SURFACE_LBL");
    const out=[];
    for(const x of f){ const a=x.properties, cls=dnrRoadClass(a); if(!cls||!x.geometry) continue;
      const lines=x.geometry.type==='LineString'?[x.geometry.coordinates]:x.geometry.type==='MultiLineString'?x.geometry.coordinates:[];
      for(const c of lines) out.push({ll:c.map(p=>[p[1],p[0]]),cls,src:'DNR',name:a.ROAD_NM||a.ROAD_NO||'',surface:a.ROAD_SURFACE_LBL||'',access:a.ROAD_PUBLIC_ACCESS_LBL||'',control:a.ROAD_CONTROL_LBL||'',status:a.ROAD_STATUS_LBL||'',hasGate:/Gated/.test(a.ROAD_PUBLIC_ACCESS_LBL||'')}); }
    return out;
  },
  // NLCD land cover, read at the model grid's own resolution. The harvest layers only know where
  // somebody filed paperwork. This sees the ground itself, so avalanche chutes, meadows, river
  // brush, burns, blowdown and regrowing cuts all count, on any ownership. On the west side
  // Shrub/Scrub is almost always forest coming back after disturbance: prime blacktail cover AND feed.
  async landcover(grid, onProgress){
    const {W,H,x0,y0,n}=grid; const out=new Uint8Array(W*H);
    const world=40075016.686, shift=world/2, res=world/(256*n);
    const PAL={11:[70,107,159],12:[209,222,248],21:[222,197,197],22:[217,146,130],23:[235,0,0],24:[171,0,0],31:[179,172,159],41:[104,171,95],42:[28,95,44],43:[181,197,143],52:[204,184,121],71:[223,223,194],81:[220,217,57],82:[171,108,40],90:[184,217,235],95:[108,159,184]};
    const codes=Object.keys(PAL).map(Number), cache=new Map();
    const cls=(r,g,b)=>{ const k=(r<<16)|(g<<8)|b; let v=cache.get(k); if(v!==undefined) return v;
      let best=0,bd=1e9; for(const c of codes){ const q=PAL[c]; const d=(q[0]-r)**2+(q[1]-g)**2+(q[2]-b)**2; if(d<bd){bd=d;best=c;} }
      if(bd>1200) best=0; cache.set(k,best); return best; };
    const TS=1024, cv=document.createElement('canvas'), ctx=cv.getContext('2d',{willReadFrequently:true});
    const jobs=[]; for(let ty=0;ty<H;ty+=TS) for(let tx=0;tx<W;tx+=TS) jobs.push([tx,ty]);
    let done=0;
    const run=async([tx,ty])=>{
      const w=Math.min(TS,W-tx), h=Math.min(TS,H-ty);
      const gx=x0*256+tx, gy=y0*256+ty;
      const minX=gx*res-shift, maxX=(gx+w)*res-shift, maxY=shift-gy*res, minY=shift-(gy+h)*res;
      const u=`${SVC.nlcd}?service=WMS&version=1.1.1&request=GetMap&layers=NLCD_2021_Land_Cover_L48&styles=&bbox=${minX},${minY},${maxX},${maxY}&width=${w}&height=${h}&srs=EPSG:3857&format=image/png`;
      const img=await new Promise((ok,bad)=>{const i=new Image();i.crossOrigin='anonymous';i.onload=()=>ok(i);i.onerror=()=>bad(new Error('NLCD tile'));i.src=u;});
      cv.width=w; cv.height=h; ctx.drawImage(img,0,0); const d=ctx.getImageData(0,0,w,h).data;
      for(let j=0;j<h;j++){ const row=(ty+j)*W+tx; for(let i=0;i<w;i++){ const o=(j*w+i)*4; out[row+i]=d[o+3]<128?0:cls(d[o],d[o+1],d[o+2]); } }
      onProgress&&onProgress(++done,jobs.length);
    };
    for(let i=0;i<jobs.length;i+=4) await Promise.all(jobs.slice(i,i+4).map(run));
    return out;
  },
  // Federal timber harvest (USFS FACTS). Federal logging is not permitted through the state Forest
  // Practices system, so without this every national forest reads as untouched mature timber and
  // scores near zero for forage. The "All Years" layer errors out; the decade layers work.
  // On the west side most federal activity is commercial thinning, not clearcutting, so the
  // treatment type is carried through and the model treats the two differently.
  async fedCuts(gmu){
    const B=SVC.facts, out=[];
    await Promise.all([11,0,1,2].map(async L=>{
      try{ const f=await arcAll(B+L,"fy_completed >= 1985",gmu.bbox,"fy_completed,treatment_type,gis_acres");
        out.push(...f);
      }catch(e){ console.warn('FACTS layer '+L,e.message); }
    }));
    return out.flatMap(Geo.splitMulti).filter(x=>Geo.overlapsUnit(x.geometry,gmu)).map(x=>{
      const p=x.properties, t=(p.treatment_type||'').toLowerCase();
      p.year=p.fy_completed||0;
      p.thin=/thin|sanitation|salvage|improvement/.test(t);
      p.TIMHARV_FP_TY_LABEL_NM=(p.treatment_type||'Federal harvest')+(p.thin?' (thin)':'');
      p.TIMHARV_RPT_AREA=p.gis_acres; p.src='USFS';
      return x; }).filter(x=>x.properties.year>=1985);
  },
  // Roads classified for pressure. Returns {roads:[{ll,cls,tags}], gates:[[lat,lon]], rivers:[ll]}
  async osm(gmu){
    const [W,S,E,N]=gmu.bbox; const bb=`${S},${W},${N},${E}`;
    const q=`[out:json][timeout:150];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|track|path)$"](${bb});node["barrier"~"^(gate|lift_gate|swing_gate|bollard|block|debris)$"](${bb});way["waterway"="river"](${bb}););out body geom qt;`;
    let j=null,err='';
    for(const u of SVC.overpass){ try{ const r=await fetch(u,{method:'POST',body:'data='+encodeURIComponent(q)}); if(r.ok){ j=await r.json(); break; } err='Overpass '+r.status; }catch(e){ err=e.message; } }
    if(!j) throw new Error(err||'Overpass unavailable'); const gateIds=new Set(), gates=[], roads=[], rivers=[];
    for(const e of j.elements) if(e.type==='node'){ gateIds.add(e.id); gates.push([e.lat,e.lon]); }
    for(const e of j.elements){ if(e.type!=='way') continue; const t=e.tags||{}; const ll=e.geometry.map(p=>[p.lat,p.lon]);
      if(t.waterway){ rivers.push(ll); continue; }
      const hasGate=(e.nodes||[]).some(id=>gateIds.has(id)); const acc=t.access||t.motor_vehicle||'';
      let cls;
      if(/motorway|trunk|primary|secondary/.test(t.highway)) cls='hwy';
      else if(t.highway==='path') cls='trail';
      else if(/private|no/.test(acc)) cls='closed';
      else if(hasGate||acc==='forestry'||acc==='permissive'&&t.highway==='track') cls='gated';
      else if(t.highway==='tertiary'||t.highway==='residential') cls='county';
      else if(t.highway==='unclassified') cls='mainline';
      else cls='spur';
      roads.push({ll,cls,src:'OSM',name:t.name||t.ref||'',surface:t.surface||'',hasGate});
    }
    return {roads,gates,rivers};
  }
};
// Road pressure weights (0..1): how much human traffic a road class carries in season.
const ROAD_W={hwy:1,county:.85,mainline:.7,spur:.45,gated:.15,closed:.1,trail:.12};
