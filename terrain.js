// DEM grid from Terrarium tiles (AWS open data). Web-Mercator aligned so a canvas overlay lines up exactly.
class Grid {
  constructor(z,x0,y0,x1,y1){ this.z=z;this.x0=x0;this.y0=y0;this.W=(x1-x0+1)*256;this.H=(y1-y0+1)*256;this.n=2**z; }
  static forBbox(bbox,z){ const [W,S,E,N]=bbox; const t=(lon,lat)=>{const n=2**z;const x=(lon+180)/360*n;const la=lat*Math.PI/180;const y=(1-Math.log(Math.tan(la)+1/Math.cos(la))/Math.PI)/2*n;return[x,y]}; const a=t(W,N),b=t(E,S); return new Grid(z,Math.floor(a[0]),Math.floor(a[1]),Math.floor(b[0]),Math.floor(b[1])); }
  toIJ(lon,lat){ const la=lat*Math.PI/180; const x=((lon+180)/360*this.n-this.x0)*256; const y=((1-Math.log(Math.tan(la)+1/Math.cos(la))/Math.PI)/2*this.n-this.y0)*256; return [Math.round(x),Math.round(y)]; }
  toLL(i,j){ const x=(i/256+this.x0)/this.n, y=(j/256+this.y0)/this.n; const lon=x*360-180; const lat=Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI; return [lon,lat]; }
  bounds(){ const a=this.toLL(0,0), b=this.toLL(this.W,this.H); return [[b[1],a[0]],[a[1],b[0]]]; } // leaflet [[S,W],[N,E]]
  cellM(){ const c=this.toLL(this.W/2,this.H/2); return 40075016.686*Math.cos(c[1]*Math.PI/180)/(256*this.n); }
}
const Terrain = {
  async load(grid, onProgress){
    const {z,x0,y0,W,H}=grid; const elev=new Float32Array(W*H); const tx=W/256, ty=H/256; let done=0;
    const cv=document.createElement('canvas'); cv.width=256; cv.height=256; const ctx=cv.getContext('2d',{willReadFrequently:true});
    const jobs=[]; for(let a=0;a<tx;a++) for(let b=0;b<ty;b++) jobs.push([a,b]);
    const run=async([a,b])=>{ const img=new Image(); img.crossOrigin='anonymous';
      await new Promise((res,rej)=>{img.onload=res;img.onerror=()=>rej(new Error('DEM tile'));img.src=SVC.dem.replace('{z}',z).replace('{x}',x0+a).replace('{y}',y0+b);});
      ctx.drawImage(img,0,0); const d=ctx.getImageData(0,0,256,256).data;
      for(let j=0;j<256;j++) for(let i=0;i<256;i++){ const k=(j*256+i)*4; elev[(b*256+j)*W+a*256+i]=(d[k]*256+d[k+1]+d[k+2]/256)-32768; }
      onProgress&&onProgress(++done,jobs.length); };
    for(let i=0;i<jobs.length;i+=6) await Promise.all(jobs.slice(i,i+6).map(run));
    return elev;
  },
  derive(grid, elev){
    const {W,H}=grid; const m=grid.cellM(); const slope=new Float32Array(W*H), aspect=new Float32Array(W*H), tpi=new Float32Array(W*H);
    const at=(i,j)=>elev[Math.min(H-1,Math.max(0,j))*W+Math.min(W-1,Math.max(0,i))];
    for(let j=0;j<H;j++) for(let i=0;i<W;i++){ const dx=(at(i+1,j)-at(i-1,j))/(2*m), dy=(at(i,j+1)-at(i,j-1))/(2*m);
      slope[j*W+i]=Math.atan(Math.hypot(dx,dy))*180/Math.PI; aspect[j*W+i]=(Math.atan2(dy,-dx)*180/Math.PI+360)%360; /* 0=N,90=E */ }
    // TPI: elevation minus mean within radius R cells (box approx via summed-area table)
    const R=Math.max(3,Math.round(300/m)); const sat=new Float64Array((W+1)*(H+1));
    for(let j=1;j<=H;j++){ let row=0; for(let i=1;i<=W;i++){ row+=elev[(j-1)*W+i-1]; sat[j*(W+1)+i]=sat[(j-1)*(W+1)+i]+row; } }
    const box=(i0,j0,i1,j1)=>sat[j1*(W+1)+i1]-sat[j0*(W+1)+i1]-sat[j1*(W+1)+i0]+sat[j0*(W+1)+i0];
    for(let j=0;j<H;j++) for(let i=0;i<W;i++){ const i0=Math.max(0,i-R),j0=Math.max(0,j-R),i1=Math.min(W,i+R+1),j1=Math.min(H,j+R+1); tpi[j*W+i]=elev[j*W+i]-box(i0,j0,i1,j1)/((i1-i0)*(j1-j0)); }
    // bench: locally gentle (<12°) inside steep surroundings (mean slope within ~150 m > 22°)
    const R2=Math.max(2,Math.round(150/m)); const sat2=new Float64Array((W+1)*(H+1));
    for(let j=1;j<=H;j++){ let row=0; for(let i=1;i<=W;i++){ row+=slope[(j-1)*W+i-1]; sat2[j*(W+1)+i]=sat2[(j-1)*(W+1)+i]+row; } }
    const box2=(i0,j0,i1,j1)=>sat2[j1*(W+1)+i1]-sat2[j0*(W+1)+i1]-sat2[j1*(W+1)+i0]+sat2[j0*(W+1)+i0];
    const bench=new Uint8Array(W*H);
    for(let j=0;j<H;j++) for(let i=0;i<W;i++){ const i0=Math.max(0,i-R2),j0=Math.max(0,j-R2),i1=Math.min(W,i+R2+1),j1=Math.min(H,j+R2+1); const ms=box2(i0,j0,i1,j1)/((i1-i0)*(j1-j0)); if(slope[j*W+i]<12&&ms>22) bench[j*W+i]=1; }
    return {slope,aspect,tpi,bench};
  }
};
// Rasterization helpers
const Raster = {
  // Euclidean-ish distance (in cells) from any seed cell, 2-pass chamfer 3-4
  distance(seed,W,H){ const INF=1e9; const d=new Float32Array(W*H); for(let k=0;k<W*H;k++) d[k]=seed[k]?0:INF;
    for(let j=0;j<H;j++) for(let i=0;i<W;i++){ const k=j*W+i; if(d[k]===0) continue; let v=d[k];
      if(i>0) v=Math.min(v,d[k-1]+1); if(j>0){ v=Math.min(v,d[k-W]+1); if(i>0) v=Math.min(v,d[k-W-1]+1.414); if(i<W-1) v=Math.min(v,d[k-W+1]+1.414);} d[k]=v; }
    for(let j=H-1;j>=0;j--) for(let i=W-1;i>=0;i--){ const k=j*W+i; let v=d[k];
      if(i<W-1) v=Math.min(v,d[k+1]+1); if(j<H-1){ v=Math.min(v,d[k+W]+1); if(i<W-1) v=Math.min(v,d[k+W+1]+1.414); if(i>0) v=Math.min(v,d[k+W-1]+1.414);} d[k]=v; }
    return d; },
  line(seed,W,H,a,b,val=1){ let [x0,y0]=a,[x1,y1]=b; const dx=Math.abs(x1-x0),dy=-Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1; let err=dx+dy;
    for(let n=0;n<100000;n++){ if(x0>=0&&x0<W&&y0>=0&&y0<H) seed[y0*W+x0]=val; if(x0===x1&&y0===y1) break; const e2=2*err; if(e2>=dy){err+=dy;x0+=sx;} if(e2<=dx){err+=dx;y0+=sy;} } },
  fillPolygon(mask,W,H,rings,val=1){ // rings in grid coords [[x,y],...]; even-odd scanline
    let ymin=H,ymax=-1; rings.forEach(r=>r.forEach(p=>{ymin=Math.min(ymin,p[1]);ymax=Math.max(ymax,p[1]);})); ymin=Math.max(0,Math.floor(ymin)); ymax=Math.min(H-1,Math.ceil(ymax));
    for(let y=ymin;y<=ymax;y++){ const xs=[]; const yc=y+0.5;
      rings.forEach(r=>{ for(let i=0,j=r.length-1;i<r.length;j=i++){ const [xi,yi]=r[i],[xj,yj]=r[j]; if((yi>yc)!==(yj>yc)) xs.push(xi+(yc-yi)*(xj-xi)/(yj-yi)); } });
      xs.sort((a,b)=>a-b); for(let k=0;k+1<xs.length;k+=2){ const a=Math.max(0,Math.ceil(xs[k])),b=Math.min(W-1,Math.floor(xs[k+1])); for(let x=a;x<=b;x++) mask[y*W+x]=val; } } },
  // mean of a 0..1 raster within radius r cells (box), via summed area table
  boxMean(src,W,H,r){ const sat=new Float64Array((W+1)*(H+1)); for(let j=1;j<=H;j++){ let row=0; for(let i=1;i<=W;i++){ row+=src[(j-1)*W+i-1]; sat[j*(W+1)+i]=sat[(j-1)*(W+1)+i]+row; } }
    const out=new Float32Array(W*H); for(let j=0;j<H;j++) for(let i=0;i<W;i++){ const i0=Math.max(0,i-r),j0=Math.max(0,j-r),i1=Math.min(W,i+r+1),j1=Math.min(H,j+r+1); out[j*W+i]=(sat[j1*(W+1)+i1]-sat[j0*(W+1)+i1]-sat[j1*(W+1)+i0]+sat[j0*(W+1)+i0])/((i1-i0)*(j1-j0)); } return out; },
  boxMax(src,W,H,r){ // separable max filter
    const tmp=new Float32Array(W*H), out=new Float32Array(W*H);
    for(let j=0;j<H;j++) for(let i=0;i<W;i++){ let m=0; for(let k=Math.max(0,i-r);k<=Math.min(W-1,i+r);k++) if(src[j*W+k]>m) m=src[j*W+k]; tmp[j*W+i]=m; }
    for(let j=0;j<H;j++) for(let i=0;i<W;i++){ let m=0; for(let k=Math.max(0,j-r);k<=Math.min(H-1,j+r);k++) if(tmp[k*W+i]>m) m=tmp[k*W+i]; out[j*W+i]=m; }
    return out; }
};
