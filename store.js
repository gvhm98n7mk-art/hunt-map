// Pins, hunt log, settings. Supabase when configured; browser storage otherwise.
const Store = {
  sb:null, user:null,
  async init(){
    if(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY && window.supabase){
      this.sb=window.supabase.createClient(CONFIG.SUPABASE_URL,CONFIG.SUPABASE_ANON_KEY);
      const {data}=await this.sb.auth.getSession(); this.user=data.session?.user||null;
      this.sb.auth.onAuthStateChange((_e,s)=>{ this.user=s?.user||null; document.dispatchEvent(new Event('auth')); });
    }
    return this;
  },
  mode(){ return this.sb?(this.user?'cloud':'signed-out'):'local'; },
  async signIn(email){ const {error}=await this.sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.href.split('#')[0]}}); if(error) throw error; },
  async signOut(){ await this.sb.auth.signOut(); },
  _lk(t){ return 'huntmap:'+t; },
  _local(t){ try{ return JSON.parse(localStorage.getItem(this._lk(t))||'[]'); }catch(e){ return []; } },
  _saveLocal(t,rows){ try{ localStorage.setItem(this._lk(t),JSON.stringify(rows)); }catch(e){} },
  async list(t, gmu){
    if(this.sb&&this.user){ let q=this.sb.from(t).select('*').order('created_at',{ascending:false}); if(gmu&&t!=='settings') q=q.eq('gmu',gmu); const {data,error}=await q; if(error) throw error; return data; }
    return this._local(t).filter(r=>!gmu||t==='settings'||r.gmu===gmu);
  },
  async add(t,row){
    row.created_at=row.created_at||new Date().toISOString();
    if(this.sb&&this.user){ row.user_id=this.user.id; const {data,error}=await this.sb.from(t).insert(row).select().single(); if(error) throw error; return data; }
    row.id=row.id||crypto.randomUUID(); const rows=this._local(t); rows.unshift(row); this._saveLocal(t,rows); return row;
  },
  async remove(t,id){
    if(this.sb&&this.user){ const {error}=await this.sb.from(t).delete().eq('id',id); if(error) throw error; return; }
    this._saveLocal(t,this._local(t).filter(r=>r.id!==id));
  },
  async settings(){ const rows=await this.list('settings'); return rows[0]||{}; },
  async saveSettings(s){
    if(this.sb&&this.user){ s.user_id=this.user.id; const {error}=await this.sb.from('settings').upsert(s,{onConflict:'user_id'}); if(error) throw error; return; }
    this._saveLocal('settings',[s]);
  },
  exportAll(){ return {pins:this._local('pins'),hunts:this._local('hunts'),settings:this._local('settings')}; }
};
