// Habitat model. Security > food > water, with pressure that pushes animals away from traffic.
const SPECIES = {
  elk:{ name:'Roosevelt / Rocky Mtn elk', color:'#4a6b3a',
    ageFit:{0:.6,1:.8,2:.95,3:1,4:1,5:1,6:.95,7:.9,8:.8,9:.65,10:.5,11:.4,12:.3,13:.25,14:.2,15:.15},
    slopeIdeal:[25,45], roadFull:800, foodR:1200, waterR:600, wSec:1, wFood:.32, wWater:.14,
    rut:{peak:'09-28',width:12} },
  deer:{ name:'Black-tailed / white-tailed / mule deer', color:'#8a5a2b',
    ageFit:{0:.3,1:.5,2:.75,3:.95,4:1,5:1,6:1,7:1,8:.95,9:.9,10:.8,11:.7,12:.6,13:.5,14:.45,15:.35},
    slopeIdeal:[12,38], roadFull:450, foodR:700, waterR:500, wSec:.9, wFood:.6, wWater:.1,
    coverFirst:true, edgeM:130,
    rut:{peak:'11-15',width:13} }
};
// Cover quality from stand age. For elk the hide is mature timber. For deer it is 5-20 yr replant,
// which is a wall you cannot see fifteen feet into; old growth is open underneath and poor security.
// A commercial thin is not a clearcut. The overstory stays, so cover stays good, while the opened
// canopy pushes salal, huckleberry and forbs for roughly a decade. On westside federal ground this
// is the dominant treatment, so it is modelled separately instead of being lumped with clearcuts.
// What the ground itself says, independent of any harvest record.
// Westside Shrub/Scrub is disturbed forest coming back: the thick stuff deer bed in and feed on.
const LC_FORAGE={52:.9,71:1,81:.9,82:.7,95:.8,90:.7,41:.6,43:.5,31:.15};
const LC_COVER ={52:1,90:.9,43:.85,41:.8,71:.25,81:.2,95:.2,31:.05};
function thinForage(a){ return a<=1?.25 : a<=3?.5 : a<=15?.7 : a<=25?.5 : .3; }
function coverFit(a, sp){
  if(!sp.coverFirst) return a===255?1:Math.min(1,a/15);
  if(a===255) return .55;
  if(a<=2) return .2; if(a<=4) return .55;
  if(a<=20) return 1; if(a<=30) return .8; return .65;
}
// Rough snow line by date (ft). Deer drop out of the high country as it fills in.
const SNOWLINE=[['11-25',2800],['11-10',3500],['10-25',4300],['10-10',5200]];
function snowCeilFt(date){ const md=date.slice(5); if(md<'04-01') return 2800;
  for(const [d,ft] of SNOWLINE) if(md>=d) return ft; return 99999; }
function rutFactor(sp, date){ const d=new Date(date+'T12:00:00Z'); const p=new Date(d.getUTCFullYear()+'-'+SPECIES[sp].rut.peak+'T12:00:00Z'); const days=(d-p)/864e5; return Math.exp(-(days*days)/(2*SPECIES[sp].rut.width**2)); }
// Binary min-heap for the walking-route Dijkstra.
class MinHeap{
  constructor(){ this.k=[]; this.d=[]; }
  get size(){ return this.k.length; }
  push(key,val){ const k=this.k,d=this.d; k.push(key); d.push(val); let i=k.length-1;
    while(i>0){ const p=(i-1)>>1; if(d[p]<=d[i]) break; [k[p],k[i]]=[k[i],k[p]]; [d[p],d[i]]=[d[i],d[p]]; i=p; } }
  pop(){ const k=this.k,d=this.d; const topK=k[0],topD=d[0]; const lk=k.pop(),ld=d.pop();
    if(k.length){ k[0]=lk; d[0]=ld; let i=0; for(;;){ const l=2*i+1,r=l+1; let s=i;
      if(l<d.length&&d[l]<d[s]) s=l; if(r<d.length&&d[r]<d[s]) s=r; if(s===i) break;
      [k[s],k[i]]=[k[i],k[s]]; [d[s],d[i]]=[d[i],d[s]]; i=s; } }
    return [topK,topD]; }
}
class Model {
  constructor(grid, terr, layers){ Object.assign(this,{grid,terr,layers}); this.W=grid.W; this.H=grid.H; this.m=grid.cellM(); this.build(); }
  build(){
    const {W,H,m,grid,layers}=this; const N=W*H;
    // public mask
    this.pub=new Uint8Array(N);
    for(const f of layers.public){ const polys=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates; for(const rs of polys) Raster.fillPolygon(this.pub,W,H,rs.map(r=>r.map(p=>grid.toIJ(p[0],p[1])))); }
    // cuts: age raster (years since approval, 255 = none)
    this.cutYear=new Uint16Array(N); // 0 = no harvest on record
    this.cutThin=new Uint8Array(N);  // 1 = thinned, overstory retained
    for(const f of [...layers.cuts].sort((a,b)=>a.properties.year-b.properties.year)){ const rs=f.geometry.coordinates.map(r=>r.map(p=>grid.toIJ(p[0],p[1])));
      Raster.fillPolygon(this.cutYear,W,H,rs,f.properties.year); Raster.fillPolygon(this.cutThin,W,H,rs,f.properties.thin?1:0); }
    // Unknown-owner roads: open spur if on public land, otherwise private/gated (permit or walk-in)
    for(const r of layers.roads){ if(r.cls!=='unknown') continue; const p=r.ll[Math.floor(r.ll.length/2)]; const [i,j]=grid.toIJ(p[1],p[0]); r.cls=(i>=0&&j>=0&&i<W&&j<H&&this.pub[j*W+i])?'spur':'gated'; if(r.cls==='gated') r.control=r.control&&r.control!=='Unknown'?r.control:'Private (inferred)'; }
    // roads by pressure class, drivable vs walk
    const seeds={}; for(const c of Object.keys(ROAD_W)) seeds[c]=new Uint8Array(N);
    const drivable=new Uint8Array(N), any=new Uint8Array(N);
    for(const r of layers.roads){ const pts=r.ll.map(p=>grid.toIJ(p[1],p[0])); for(let i=1;i<pts.length;i++){ Raster.line(seeds[r.cls],W,H,pts[i-1],pts[i]); Raster.line(any,W,H,pts[i-1],pts[i]); if(!/gated|closed|trail/.test(r.cls)) Raster.line(drivable,W,H,pts[i-1],pts[i]); } }
    this.dDrive=Raster.distance(drivable,W,H); this.dAny=Raster.distance(any,W,H);
    const gateSeed=new Uint8Array(N); for(const g of layers.gates){ const [i,j]=grid.toIJ(g[1],g[0]); if(i>=0&&i<W&&j>=0&&j<H) gateSeed[j*W+i]=1; } this.dGate=Raster.distance(gateSeed,W,H);
    // pressure 0..1 = max over classes of weight * exp(-d/scale)
    const scale={hwy:500,county:500,mainline:600,spur:450,gated:900,closed:400,trail:700};
    this.pressure=new Float32Array(N);
    for(const c of Object.keys(ROAD_W)){ const d=Raster.distance(seeds[c],W,H); const w=ROAD_W[c], s=scale[c]/m; for(let k=0;k<N;k++){ const v=w*Math.exp(-d[k]/s); if(v>this.pressure[k]) this.pressure[k]=v; } }
    // water proxy: rivers + valley bottoms (TPI < -6 m and slope < 15)
    const wseed=new Uint8Array(N); for(const ll of layers.rivers){ const pts=ll.map(p=>grid.toIJ(p[1],p[0])); for(let i=1;i<pts.length;i++) Raster.line(wseed,W,H,pts[i-1],pts[i]); }
    for(let k=0;k<N;k++) if(this.terr.tpi[k]<-6&&this.terr.slope[k]<15) wseed[k]=1; this.dWater=Raster.distance(wseed,W,H);
    this.buildWalk();
  }
  // Walking network: you drive the open roads, then walk gated roads, abandoned grades and trails.
  // Dijkstra outward from every point the drivable system touches, so every walk cell knows its
  // true distance on foot from the nearest place a truck can legally sit.
  buildWalk(){
    const {W,H,m,grid,layers}=this; const N=W*H;
    const COST={gated:1,closed:1.25,trail:1.05}; // closed grades are brushy and slower underfoot
    const isDrive=c=>/^(hwy|county|mainline|spur)$/.test(c);
    const walk=new Uint8Array(N), drive=new Uint8Array(N), wc=new Float32Array(N), rIdx=new Int32Array(N).fill(-1);
    const line=(p0,p1,fn)=>{ let x0=p0[0],y0=p0[1]; const x1=p1[0],y1=p1[1];
      const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1; let err=dx-dy;
      for(let n=0;n<6000;n++){ fn(x0,y0); if(x0===x1&&y0===y1) break; const e2=2*err; if(e2>-dy){err-=dy;x0+=sx;} if(e2<dx){err+=dx;y0+=sy;} } };
    for(let ri=0;ri<layers.roads.length;ri++){ const r=layers.roads[ri]; const c=COST[r.cls]; const dr=isDrive(r.cls);
      if(!c&&!dr) continue; const pts=r.ll.map(p=>grid.toIJ(p[1],p[0]));
      for(let s2=1;s2<pts.length;s2++) line(pts[s2-1],pts[s2],(x,y)=>{ if(x<0||y<0||x>=W||y>=H) return; const k=y*W+x;
        if(dr){ drive[k]=1; } else { walk[k]=1; if(!wc[k]||c<wc[k]) wc[k]=c; if(rIdx[k]<0) rIdx[k]=ri; } }); }
    const dist=new Float32Array(N).fill(Infinity), prev=new Int32Array(N).fill(-1), heap=new MinHeap();
    for(let j=0;j<H;j++) for(let i=0;i<W;i++){ const k=j*W+i; if(!walk[k]) continue;
      let touch=false;
      for(let dj=-1;dj<=1&&!touch;dj++) for(let di=-1;di<=1;di++){ const x=i+di,y=j+dj; if(x<0||y<0||x>=W||y>=H) continue; if(drive[y*W+x]){touch=true;break;} }
      if(touch){ dist[k]=0; prev[k]=-2; heap.push(k,0); } }
    const diag=m*Math.SQRT2;
    while(heap.size){ const [k,d]=heap.pop(); if(d>dist[k]) continue; const i=k%W, j=(k-i)/W;
      for(let dj=-1;dj<=1;dj++) for(let di=-1;di<=1;di++){ if(!di&&!dj) continue; const x=i+di,y=j+dj; if(x<0||y<0||x>=W||y>=H) continue;
        const k2=y*W+x; if(!walk[k2]) continue; const nd=d+(di&&dj?diag:m)*(wc[k2]||1);
        if(nd<dist[k2]){ dist[k2]=nd; prev[k2]=k; heap.push(k2,dist[k2]); } } } // push the stored float32, not the double, or the pop guard discards it
    this.walk={mask:walk,drive,dist,prev,rIdx};
  }
  // Route from a bedding cell back to the truck: cross-country to the nearest reachable walk road,
  // then down that road to the parking point. Cross-country is costed at 2.2x to keep the
  // bushwhack short, but both legs are reported at true distance.
  routeTo(i,j,maxOffM=1000){
    const {W,H,m,grid,layers}=this; const wk=this.walk; if(!wk) return null;
    const R=Math.ceil(maxOffM/m); let best=null;
    for(let dj=-R;dj<=R;dj++){ const y=j+dj; if(y<0||y>=H) continue;
      for(let di=-R;di<=R;di++){ const x=i+di; if(x<0||x>=W) continue; const k=y*W+x; if(!wk.mask[k]) continue;
        const d=wk.dist[k]; if(!isFinite(d)) continue; const off=Math.hypot(di,dj)*m; if(off>maxOffM) continue;
        const eff=d+off*2.2; if(!best||eff<best.eff) best={eff,k,off,roadM:d}; } }
    if(!best) return null;
    const cells=[]; let k=best.k, guard=0;
    while(k>=0&&guard++<120000){ cells.push(k); const p=wk.prev[k]; if(p===-2||p<0) break; k=p; }
    cells.reverse();
    const path=cells.map(c=>{ const x=c%W; const ll=grid.toLL(x,(c-x)/W); return [ll[1],ll[0]]; });
    const names=new Map(), classes=new Map();
    for(const c of cells){ const ri=wk.rIdx[c]; if(ri<0) continue; const r=layers.roads[ri];
      const nm=r.name||r.no||''; if(nm) names.set(nm,(names.get(nm)||0)+1);
      classes.set(r.cls,(classes.get(r.cls)||0)+1); }
    const top=mp=>[...mp.entries()].sort((a,b)=>b[1]-a[1]).map(e=>e[0]);
    const bll=grid.toLL(i,j);
    return { park:path[0]||null, path, roadM:best.roadM, offM:best.off, totalM:best.roadM+best.off,
      leave:path[path.length-1]||null, bed:[bll[1],bll[0]], names:top(names).slice(0,2), classes:top(classes) };
  }
  ageAt(k,yr){ const y=this.cutYear[k]; return y?Math.max(0,yr-y):255; }
  score(opts){ // opts: {species, date, tmaxF, rain, pressureDay(0..1), season}
    const {W,H,m,terr}=this; const N=W*H; const sp=SPECIES[opts.species]; const yr=+opts.date.slice(0,4);
    const hot=opts.tmaxF>=65, cold=opts.tmaxF<=40||opts.rain;
    const rut=rutFactor(opts.species,opts.date);
    const food=new Float32Array(N), cover=new Float32Array(N);
    for(let k=0;k<N;k++){ const a=this.ageAt(k,yr), th=this.cutThin[k];
      if(a===255){ food[k]=0; cover[k]=coverFit(255,sp); }
      else if(th){ food[k]=thinForage(a); cover[k]=sp.coverFirst?Math.max(.8,coverFit(a,sp)):Math.min(1,.6+a/20); }
      else { food[k]=sp.ageFit[Math.min(a,15)]??0.1; cover[k]=coverFit(a,sp); } }
    // Land cover overrides upward: a shrub field is feed and cover whether or not anyone logged it.
    const lc=this.layers.lc;
    if(lc) for(let k=0;k<N;k++){ const c=lc[k]; if(!c) continue;
      const lf=LC_FORAGE[c]; if(lf!==undefined&&lf>food[k]) food[k]=lf;
      if(sp.coverFirst){ const lv=LC_COVER[c]; if(lv!==undefined&&lv>cover[k]) cover[k]=lv; }
      if(c===11){ food[k]=0; cover[k]=0; } }
    // Food: elk will use the middle of a cut. Deer feed on the cut edge and bed in the cover behind it,
    // so for deer the forage term is distance to a feed-edge, not distance to a cut.
    let foodNear;
    if(sp.coverFirst){
      const edge=new Uint8Array(N);
      for(let j=1;j<H-1;j++) for(let i=1;i<W-1;i++){ const k=j*W+i; if(food[k]<.55) continue;
        if(food[k-1]<.2||food[k+1]<.2||food[k-W]<.2||food[k+W]<.2) edge[k]=1; }
      const dEdge=Raster.distance(edge,W,H); const es=Math.max(2,sp.edgeM/m);
      foodNear=new Float32Array(N); for(let k=0;k<N;k++) foodNear[k]=Math.exp(-dEdge[k]/es);
      this.dEdge=dEdge;
    } else foodNear=Raster.boxMax(food,W,H,Math.round(sp.foodR/m));
    const sec=new Float32Array(N), out=new Float32Array(N);
    const [s0,s1]=sp.slopeIdeal; const pd=opts.pressureDay??.5;
    const ceil=sp.coverFirst?snowCeilFt(opts.date):99999;
    for(let k=0;k<N;k++){
      const sl=terr.slope[k]; let ws= sl<s0? Math.max(.08,(sl/s0)**1.5) : sl<=s1?1 : Math.max(.4,1-(sl-s1)/40);
      const dr=this.dDrive[k]*m; let wr=Math.min(1,.15+.85*dr/sp.roadFull); if(dr>sp.roadFull*2) wr=1;
      const asp=terr.aspect[k]; const cool=(asp<=135||asp>=315)?1:0; let wa=1; if(hot) wa=cool?1.12:.85; else if(cold) wa=cool?.9:1.08;
      let s;
      if(sp.coverFirst){
        // Deer security is cover density first. A blacktail buck will bed 80 yards off a gated road
        // in thick replant for years, so distance from the road is a modifier, not the driver.
        const wc=.2+.8*cover[k];
        const wrD=.45+.55*wr;
        const wp=1-.5*this.pressure[k]*pd;
        const ft=this.layers.elev[k]*3.281;
        const we=ft>ceil?Math.max(.15,Math.exp(-(ft-ceil)/700)):1;
        s=Math.pow(ws,.5)*wrD*wa*wc*wc*wp*we;
      } else {
        const wc=.35+.65*cover[k];
        const wp=1-.75*this.pressure[k]*pd;
        s=ws*wr*wa*wc*wp;
      }
      if(terr.bench[k]) s*=1.12; sec[k]=Math.min(1,s);
    }
    // Water matters in rut and heat. On the wet side of the state it is everywhere, so it is noise.
    const wetSide=opts.east===false&&sp.coverFirst;
    const wWater=sp.wWater*(1+rut*.8+(hot?.5:0))*(wetSide?.15:1), wFood=sp.wFood*(1-rut*.25);
    const wr=Math.round(sp.waterR/m);
    for(let k=0;k<N;k++){
      const water=Math.exp(-this.dWater[k]/wr);
      if(lc&&lc[k]===11){ out[k]=0; continue; }   // open water is not a bedding site
      const v=Math.pow(sec[k],sp.wSec)*( (1-wFood-wWater) + wFood*foodNear[k] + wWater*water );
      out[k]=this.pub[k]?v:v*.35;
    }
    this.last={sec,food,cover,foodNear,score:out,opts,rut,snowCeilFt:ceil};
    return this.last;
  }
  hotspots(n=12, opts={}){ // ranked bedding blocks on public land, each with a real walk-in route
    const {W,H,m,grid}=this; const L=this.last; const B=Math.max(6,Math.round(350/m)); const bw=Math.ceil(W/B), bh=Math.ceil(H/B);
    const blocks=[]; const walkMaxM=(opts.walkMaxKm||3)*1000; const walkMaxCells=walkMaxM/m;
    const gatedOnly=opts.access==='gated'; const minRoadM=opts.minRoadM??800;
    const freeRoam=opts.access==='cross'; const maxOffM=opts.maxOffM??(freeRoam?1200:600);
    const minWalkM=(opts.minWalkKm||0)*1000;   // how far in you insist on going before you hunt
    for(let bj=0;bj<bh;bj++) for(let bi=0;bi<bw;bi++){ let best=-1,bk=-1,sum=0,cnt=0;
      for(let j=bj*B;j<Math.min(H,(bj+1)*B);j++) for(let i=bi*B;i<Math.min(W,(bi+1)*B);i++){ const k=j*W+i; if(!this.pub[k]) continue; const v=L.score[k]; sum+=v;cnt++; if(v>best){best=v;bk=k;} }
      if(cnt<B*B*.3||bk<0) continue; if(this.dAny[bk]>walkMaxCells) continue; blocks.push({k:bk,v:best*.6+ (sum/cnt)*.4}); }
    blocks.sort((a,b)=>b.v-a.v); const picked=[]; const sup=Math.round(900/m);
    for(const b of blocks){ const i=b.k%W,j=(b.k-i)/W; if(picked.some(p=>Math.hypot(p.i-i,p.j-j)<sup)) continue; picked.push({i,j,k:b.k,v:b.v}); if(picked.length>=(minWalkM?900:Math.max(300,n*25))) break; }
    const sp=SPECIES[L.opts.species]; const fr=Math.round(sp.foodR/m); const out=[];
    // Route every candidate first, then rank on habitat AND how you get in. A great bed you reach by
    // fighting a mile of blowdown is worth less than a good bed at the end of a gated road.
    const cands=[];
    for(const p of picked){
      const rt=this.routeTo(p.i,p.j,Math.min(maxOffM,walkMaxM));
      if(!rt||rt.totalM>walkMaxM) continue;                       // no legal walk-in inside the cap
      if(rt.totalM<minWalkM) continue;                            // too close to the truck to be worth it
      if(gatedOnly&&(rt.roadM<minRoadM||!/gated|closed/.test(rt.classes[0]||''))) continue;
      const accessFit=freeRoam?1:Math.exp(-rt.offM/450);
      cands.push({p,rt,rank:p.v*(.35+.65*accessFit),accessFit});
    }
    cands.sort((a,b)=>b.rank-a.rank);
    for(const c of cands.slice(0,n)){
      const p=c.p, rt=c.rt;
      let fbest=0,fk=-1; for(let j=Math.max(0,p.j-fr);j<Math.min(H,p.j+fr);j+=2) for(let i=Math.max(0,p.i-fr);i<Math.min(W,p.i+fr);i+=2){ const k=j*W+i; if(L.food[k]>fbest){fbest=L.food[k];fk=k;} }
      const ll=grid.toLL(p.i,p.j); const fll=fk>=0?grid.toLL(fk%W,(fk-fk%W)/W):null;
      out.push({ rank:out.length+1, score:Math.round(p.v*100), bed:[ll[1],ll[0]], food:fll?[fll[1],fll[0]]:null, foodFit:Math.round(fbest*100),
        slope:Math.round(this.terr.slope[p.k]), aspect:this.aspectName(this.terr.aspect[p.k]), bench:!!this.terr.bench[p.k], elev:Math.round(this.layers.elev[p.k]*3.281),
        roadKm:+(this.dDrive[p.k]*m/1000).toFixed(2), gateKm:+(this.dGate[p.k]*m/1000).toFixed(2),
        pressure:Math.round(this.pressure[p.k]*100), sec:Math.round(L.sec[p.k]*100),
        park:rt.park, route:rt.path, leave:rt.leave,
        walkKm:+(rt.totalM/1000).toFixed(2), roadWalkKm:+(rt.roadM/1000).toFixed(2), offM:Math.round(rt.offM),
        access:rt.classes[0]||'road', accessName:rt.names[0]||'', accessFit:Math.round(c.accessFit*100) });
    }
    return out;
  }
  nearestSeedLL(i,j,dist){ // walk downhill on the distance raster to reach a seed (d==0)
    const {W,H,grid}=this; let ci=i,cj=j; for(let n=0;n<4000;n++){ const k=cj*W+ci; if(dist[k]===0) break; let bi=ci,bj=cj,bv=dist[k];
      for(let dj=-1;dj<=1;dj++) for(let di=-1;di<=1;di++){ const x=ci+di,y=cj+dj; if(x<0||y<0||x>=W||y>=H) continue; const v=dist[y*W+x]; if(v<bv){bv=v;bi=x;bj=y;} } if(bi===ci&&bj===cj) break; ci=bi;cj=bj; }
    const ll=grid.toLL(ci,cj); return [ll[1],ll[0]]; }
  aspectName(a){ return ['N','NE','E','SE','S','SW','W','NW'][Math.round(a/45)%8]; }
  paint(which){ // returns canvas for score|sec|pressure|food
    const {W,H}=this; const cv=document.createElement('canvas'); cv.width=W; cv.height=H; const ctx=cv.getContext('2d'); const img=ctx.createImageData(W,H); const d=img.data; const L=this.last;
    const src= which==='sec'?L.sec: which==='pressure'?this.pressure: which==='food'?L.foodNear: L.score;
    for(let k=0;k<W*H;k++){ let v=src[k]; const o=k*4; if(which==='pressure'){ d[o]=200;d[o+1]=30;d[o+2]=30;d[o+3]=Math.min(200,v*230); continue; }
      if(which==='score'&&!this.pub[k]) v*=.5;
      // ramp: transparent → yellow → orange → deep red
      if(v<.25){ d[o+3]=0; continue; } const t=(v-.25)/.75; const r=[240,230,193,122], g=[232,162,68,31], b=[176,60,14,12]; const x=t*3, i=Math.min(2,Math.floor(x)), f=x-i;
      d[o]=r[i]+(r[i+1]-r[i])*f; d[o+1]=g[i]+(g[i+1]-g[i])*f; d[o+2]=b[i]+(b[i+1]-b[i])*f; d[o+3]=60+t*160; }
    ctx.putImageData(img,0,0); return cv;
  }
}
