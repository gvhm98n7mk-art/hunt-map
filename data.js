// Live data loaders. All public services, all CORS-open (verified 2026-09-19).
const SVC = {
  gmu: "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/MapServices/HOReferenceService/MapServer/0",
  dnr: "https://gis.dnr.wa.gov/site3/rest/services/Public_Boundaries/WADNR_PUBLIC_Cadastre_OpenData/MapServer/6",
  pad: "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Name_PADUS/FeatureServer/0",
  fpa: "https://gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/Forest_Practices_Applications_offline/FeatureServer/6",
  overpass: "https://overpass-api.de/api/interpreter",
  dem: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
};
const Geo = {
  centroid(g){ const ring=g.type==='Polygon'?g.coordinates[0]:g.coordinates[0][0]; let x=0,y=0; for(const p of ring){x+=p[0];y+=p[1];} return [ring.length?x/ring.length:0, ring.length?y/ring.length:0]; },
  pipRing(x,y,r){ let inside=false; for(let i=0,j=r.length-1;i<r.length;j=i++){ const xi=r[i][0],yi=r[i][1],xj=r[j][0],yj=r[j][1]; if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside; } return inside; },
  pip(x,y,g){ const polys=g.type==='Polygon'?[g.coordinates]:g.coordinates; return polys.some(rs=>this.pipRing(x,y,rs[0]) && !rs.slice(1).some(h=>this.pipRing(x,y,h))); },
  bbox(g){ let W=180,S=90,E=-180,N=-90; const walk=c=>{ if(typeof c[0]==='number'){ if(c[0]<W)W=c[0]; if(c[0]>E)E=c[0]; if(c[1]<S)S=c[1]; if(c[1]>N)N=c[1]; } else c.forEach(walk); }; walk(g.coordinates); return [W,S,E,N]; },
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
const Data = {
  async gmu(num){
    const j=await (await fetch(`${SVC.gmu}/query?where=GMU_Num%3D${num}&outFields=GMU_Num,GMU_Name,EastWest_Ind&returnGeometry=true&outSR=4326&f=geojson&maxAllowableOffset=0.0003`)).json();
    if(!j.features?.length) throw new Error('GMU '+num+' not found'); const f=j.features[0]; f.bbox=Geo.bbox(f.geometry); return f;
  },
  async dnr(gmu){
    const f=await arcAll(SVC.dnr,"SURFACE_RIGHTS_FLG='Y'",gmu.bbox,"SURFACE_TRUST_CD");
    return f.flatMap(Geo.splitMulti).filter(x=>{const c=Geo.centroid(x.geometry);return Geo.pip(c[0],c[1],gmu.geometry)}).map(x=>(x.properties.owner='DNR state trust',x.properties.access='open',x));
  },
  async pad(gmu){
    const f=await arcAll(SVC.pad,"Mang_Type<>'PVT' AND Mang_Type<>'SDNR' AND Pub_Access IN ('OA','RA') AND GIS_Acres>10",gmu.bbox,"Unit_Nm,Mang_Name,Mang_Type,Pub_Access,GIS_Acres");
    return f.flatMap(Geo.splitMulti).filter(x=>{const c=Geo.centroid(x.geometry);return Geo.pip(c[0],c[1],gmu.geometry)}).map(x=>(x.properties.owner=x.properties.Mang_Name||x.properties.Mang_Type,x.properties.access=x.properties.Pub_Access==='OA'?'open':'restricted',x));
  },
  async cuts(gmu){
    const f=await arcAll(SVC.fpa,"TIMHARV_FP_TY_LABEL_NM LIKE 'Even%' AND DECISION IN ('Approved','Expired','Renewed','Closed') AND EFFECTIVE_DT > DATE '2004-01-01'",gmu.bbox,"FP_ID,EFFECTIVE_DT,TIMHARV_RPT_AREA,TIMHARV_FP_TY_LABEL_NM,DECISION");
    return f.flatMap(Geo.splitMulti).filter(x=>{const c=Geo.centroid(x.geometry);return Geo.pip(c[0],c[1],gmu.geometry)}).map(x=>(x.properties.year=new Date(x.properties.EFFECTIVE_DT).getUTCFullYear(),x));
  },
  // Roads classified for pressure. Returns {roads:[{ll,cls,tags}], gates:[[lat,lon]], rivers:[ll]}
  async osm(gmu){
    const [W,S,E,N]=gmu.bbox; const bb=`${S},${W},${N},${E}`;
    const q=`[out:json][timeout:150];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|track|path)$"](${bb});node["barrier"~"^(gate|lift_gate|swing_gate|bollard|block|debris)$"](${bb});way["waterway"="river"](${bb}););out body geom qt;`;
    const r=await fetch(SVC.overpass,{method:'POST',body:'data='+encodeURIComponent(q)}); if(!r.ok) throw new Error('Overpass '+r.status);
    const j=await r.json(); const gateIds=new Set(), gates=[], roads=[], rivers=[];
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
      roads.push({ll,cls,name:t.name||t.ref||'',surface:t.surface||'',hasGate});
    }
    return {roads,gates,rivers};
  }
};
// Road pressure weights (0..1): how much human traffic a road class carries in season.
const ROAD_W={hwy:1,county:.85,mainline:.7,spur:.45,gated:.15,closed:.1,trail:.12};
