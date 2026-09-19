// Habitat model. Security > food > water, with pressure that pushes animals away from traffic.
const SPECIES = {
  elk:{ name:'Roosevelt / Rocky Mtn elk', color:'#4a6b3a',
    ageFit:{0:.6,1:.8,2:.95,3:1,4:1,5:1,6:.95,7:.9,8:.8,9:.65,10:.5,11:.4,12:.3,13:.25,14:.2,15:.15},
    slopeIdeal:[25,45], roadFull:800, foodR:1200, waterR:600, wSec:1, wFood:.32, wWater:.14,
    rut:{peak:'09-28',width:12} },
  deer:{ name:'Black-tailed / white-tailed / mule deer', color:'#8a5a2b',
    ageFit:{0:.4,1:.55,2:.8,3:1,4:1,5:1,6:1,7:1,8:.95,9:.9,10:.7,11:.55,12:.45,13:.4,14:.35,15:.3},
    slopeIdeal:[15,40], roadFull:450, foodR:500, waterR:500, wSec:.6, wFood:.55, wWater:.1,
    rut:{peak:'11-08',width:14} }
};
function rutFactor(sp, date){ const d=new Date(date+'T12:00:00Z'); const p=new Date(d.getUTCFullYear()+'-'+SPECIES[sp].rut.peak+'T12:00:00Z'); const days=(d-p)/864e5; return Math.exp(-(days*days)/(2*SPECIES[sp].rut.width**2)); }
class Model {
  constructor(grid, terr, layers){ Object.assign(this,{grid,terr,layers}); this.W=grid.W; this.H=grid.H; this.m=grid.cellM(); this.build(); }
  build(){
    const {W,H,m,grid,layers}=this; const N=W*H;
    // public mask
    this.pub=new Uint8Array(N);
    for(const f of layers.public){ const polys=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates; for(const rs of polys) Raster.fillPolygon(this.pub,W,H,rs.map(r=>r.map(p=>grid.toIJ(p[0],p[1])))); }
    // cuts: age raster (years since approval, 255 = none)
    this.cutYear=new Uint16Array(N); // 0 = no even-aged harvest on record
    for(const f of [...layers.cuts].sort((a,b)=>a.properties.year-b.properties.year)){ const rs=f.geometry.coordinates.map(r=>r.map(p=>grid.toIJ(p[0],p[1]))); Raster.fillPolygon(this.cutYear,W,H,rs,f.properties.year); }
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
  }
  ageAt(k,yr){ const y=this.cutYear[k]; return y?Math.max(0,yr-y):255; }
  score(opts){ // opts: {species, date, tmaxF, rain, pressureDay(0..1), season}
    const {W,H,m,terr}=this; const N=W*H; const sp=SPECIES[opts.species]; const yr=+opts.date.slice(0,4);
    const hot=opts.tmaxF>=65, cold=opts.tmaxF<=40||opts.rain;
    const rut=rutFactor(opts.species,opts.date);
    const food=new Float32Array(N), canopy=new Float32Array(N);
    for(let k=0;k<N;k++){ const a=this.ageAt(k,yr); food[k]=a===255?0:(sp.ageFit[Math.min(a,15)]??0.1); canopy[k]=a===255?1:Math.min(1,a/15); }
    const foodNear=Raster.boxMax(food,W,H,Math.round(sp.foodR/m));
    const sec=new Float32Array(N), out=new Float32Array(N);
    const [s0,s1]=sp.slopeIdeal; const pd=opts.pressureDay??.5;
    for(let k=0;k<N;k++){
      const sl=terr.slope[k]; let ws= sl<s0? Math.max(.08,(sl/s0)**1.5) : sl<=s1?1 : Math.max(.4,1-(sl-s1)/40);
      const dr=this.dDrive[k]*m; let wr=Math.min(1,.15+.85*dr/sp.roadFull); if(dr>sp.roadFull*2) wr=1;
      const asp=terr.aspect[k]; const cool=(asp<=135||asp>=315)?1:0; let wa=1; if(hot) wa=cool?1.12:.85; else if(cold) wa=cool?.9:1.08;
      const wc=.35+.65*canopy[k];
      const wp=1-.75*this.pressure[k]*pd;
      let s=ws*wr*wa*wc*wp; if(terr.bench[k]) s*=1.12; sec[k]=Math.min(1,s);
    }
    // travel/bench near bedding matters for elk; water matters more in rut and heat
    const wWater=sp.wWater*(1+rut*.8+(hot?.5:0)), wFood=sp.wFood*(1-rut*.25);
    const wr=Math.round(sp.waterR/m);
    for(let k=0;k<N;k++){
      const water=Math.exp(-this.dWater[k]/wr);
      const v=Math.pow(sec[k],sp.wSec)*( (1-wFood-wWater) + wFood*foodNear[k] + wWater*water );
      out[k]=this.pub[k]?v:v*.35;
    }
    this.last={sec,food,foodNear,score:out,opts,rut};
    return this.last;
  }
  hotspots(n=12, opts={}){ // ranked bedding blocks on public land, with food + access info
    const {W,H,m,grid}=this; const L=this.last; const B=Math.max(6,Math.round(350/m)); const bw=Math.ceil(W/B), bh=Math.ceil(H/B);
    const blocks=[]; const walkMaxCells=(opts.walkMaxKm||3)*1000/m;
    for(let bj=0;bj<bh;bj++) for(let bi=0;bi<bw;bi++){ let best=-1,bk=-1,sum=0,cnt=0;
      for(let j=bj*B;j<Math.min(H,(bj+1)*B);j++) for(let i=bi*B;i<Math.min(W,(bi+1)*B);i++){ const k=j*W+i; if(!this.pub[k]) continue; const v=L.score[k]; sum+=v;cnt++; if(v>best){best=v;bk=k;} }
      if(cnt<B*B*.3||bk<0) continue; if(this.dAny[bk]>walkMaxCells) continue; blocks.push({k:bk,v:best*.6+ (sum/cnt)*.4}); }
    blocks.sort((a,b)=>b.v-a.v); const picked=[]; const sup=Math.round(900/m);
    for(const b of blocks){ const i=b.k%W,j=(b.k-i)/W; if(picked.some(p=>Math.hypot(p.i-i,p.j-j)<sup)) continue; picked.push({i,j,k:b.k,v:b.v}); if(picked.length>=n) break; }
    const sp=SPECIES[L.opts.species]; const fr=Math.round(sp.foodR/m);
    return picked.map((p,idx)=>{ // find best food cell within foodR
      let fbest=0,fk=-1; for(let j=Math.max(0,p.j-fr);j<Math.min(H,p.j+fr);j+=2) for(let i=Math.max(0,p.i-fr);i<Math.min(W,p.i+fr);i+=2){ const k=j*W+i; if(L.food[k]>fbest){fbest=L.food[k];fk=k;} }
      const ll=grid.toLL(p.i,p.j); const fll=fk>=0?grid.toLL(fk%W,(fk-fk%W)/W):null;
      // nearest drivable-road cell = parking; nearest any-road = walk route start
      const park=this.nearestSeedLL(p.i,p.j,this.dDrive); 
      return { rank:idx+1, score:Math.round(p.v*100), bed:[ll[1],ll[0]], food:fll?[fll[1],fll[0]]:null, foodFit:Math.round(fbest*100),
        slope:Math.round(this.terr.slope[p.k]), aspect:this.aspectName(this.terr.aspect[p.k]), bench:!!this.terr.bench[p.k], elev:Math.round(this.layers.elev[p.k]*3.281),
        roadKm:+(this.dDrive[p.k]*m/1000).toFixed(2), walkKm:+(this.dAny[p.k]*m/1000).toFixed(2), gateKm:+(this.dGate[p.k]*m/1000).toFixed(2), pressure:Math.round(this.pressure[p.k]*100), sec:Math.round(L.sec[p.k]*100), park };
    });
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
