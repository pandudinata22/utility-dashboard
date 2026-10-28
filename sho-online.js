/* KOBE SHO - penyimpanan online satu sumber: public.sho_issues / public.sho_reviews.
 * SW37 fix: machine_stopped diteruskan ke Supabase dan diverifikasi saat simpan.
 * Tidak menggunakan tabel sho_live_issues maupun import localStorage.
 */
(function(){
  'use strict';
  const TABLE={issues:'sho_issues',reviews:'sho_reviews'};
  const FIELDS={
    issues:['id','tanggal','shift','gedung','line','mesin','sku','tl','category','problem','action','pic','priority','status','time_start','time_end','duration_minutes','machine_stopped','downtime_minutes','occurred_at','updated_at'],
    reviews:['id','tanggal','shift','gedung','line','mesin','tl_serah','tl_terima','issues_count','open_count','downtime_total','oee_actual','oee_target','review_notes','reviewed_at']
  };
  const order={issues:'occurred_at.desc',reviews:'reviewed_at.desc'};
  let busySync=null;
  const status=document.getElementById('sho-connection');
  function politeStatus(message,ok){
    state.online=ok;
    if(status){
      status.className='pill '+(ok?'online':'warn');
      status.textContent=message;
      status.title=ok?'Semua data disimpan di database Supabase.':'Tidak ada penyimpanan lokal otomatis. Periksa koneksi / izin database.';
    }
    const last=document.getElementById('last-sync');
    if(last && ok)last.textContent='Sinkron terakhir: '+new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }
  async function errorText(res){
    let msg='';
    try{const body=await res.json();msg=body.message||body.hint||body.error||JSON.stringify(body)}catch{msg=res.statusText}
    if(res.status===404 || /PGRST205|Could not find the table|schema cache/i.test(msg))return 'Tabel SHO belum tersedia. Periksa public.sho_issues di Supabase.';
    if(/machine_stopped|PGRST204/i.test(msg))return 'Kolom machine_stopped belum tersedia di sho_issues. Jalankan SQL pada paket revisi. '+String(msg).slice(0,130);
    if(res.status===401 || res.status===403)return 'Akses Supabase ditolak ('+res.status+'). Periksa publishable key dan izin RLS tabel SHO. '+String(msg).slice(0,140);
    return 'Supabase HTTP '+res.status+': '+String(msg).slice(0,230);
  }
  async function request(path,{method='GET',body,extraHeaders={}}={}){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try{
      const res=await fetch(BASE+'/rest/v1/'+path,{
        method,signal:controller.signal,
        headers:{apikey:KEY,Accept:'application/json','Content-Type':'application/json',...extraHeaders},
        ...(body===undefined?{}:{body:JSON.stringify(body)})
      });
      if(!res.ok)throw new Error(await errorText(res));
      if(res.status===204)return [];
      return await res.json();
    }catch(err){
      if(err.name==='AbortError')throw new Error('Koneksi Supabase melewati 15 detik. Coba lagi.');
      throw err;
    }finally{clearTimeout(timeout)}
  }
  async function readAll(kind){
    const table=TABLE[kind],items=[],perPage=1000;
    for(let offset=0;offset<50000;offset+=perPage){
      const batch=await request(table+'?select=*&order='+order[kind]+'&limit='+perPage+'&offset='+offset);
      if(!Array.isArray(batch))throw Error('Respons data '+table+' bukan daftar.');
      items.push(...batch);
      if(batch.length<perPage)return items;
    }
    throw Error('Data SHO melebihi 50.000 catatan. Hubungi admin untuk pembatasan periode.');
  }
  async function sync(force=false){
    if(busySync){
      if(!force)return busySync;
      try{await busySync}catch{}
    }
    const task=(async()=>{
      try{
        const [issues,reviews]=await Promise.all([readAll('issues'),readAll('reviews')]);
        state.issues=issues;
        state.reviews=reviews;
        state.checkins=[];
        politeStatus('Supabase Online',true);
        document.dispatchEvent(new Event('sho-data-updated'));
        return {issues:issues.length,reviews:reviews.length};
      }catch(e){
        politeStatus('Supabase tidak terhubung',false);
        throw e;
      }
    })();
    busySync=task;
    try{return await task}finally{if(busySync===task)busySync=null}
  }
  function cleanPayload(kind,row){
    const out={};
    for(const key of FIELDS[kind])if(row[key]!==undefined)out[key]=row[key];
    if(kind==='issues' && typeof out.machine_stopped!=='boolean'){
      // Catatan historis boleh NULL di DB, tetapi TL harus memilih pada input baru/edit.
      throw Error('Pilih Mesin Berhenti: Ya atau Tidak sebelum menyimpan.');
    }
    return out;
  }
  async function save(kind,row,update=false,skipSync=false){
    if(!TABLE[kind])throw Error('Tabel penyimpanan tidak dikenal: '+kind);
    if(!state.online)await sync(true);
    const path=TABLE[kind]+'?on_conflict='+encodeURIComponent(kind==='issues'?'id':'tanggal,shift,gedung,mesin');
    const body=cleanPayload(kind,row);
    let result;
    try{
      result=await request(path,{method:'POST',body,extraHeaders:{Prefer:'resolution=merge-duplicates,return=representation'}});
      if(!Array.isArray(result)||result.length!==1)throw Error('Server tidak mengonfirmasi data yang tersimpan.');
      if(kind==='issues' && result[0].machine_stopped!==body.machine_stopped){
        throw Error('Pilihan Mesin Berhenti belum terkonfirmasi di Supabase. Periksa kolom machine_stopped dan koneksi.');
      }
      if(kind==='issues' && (result[0].id!==body.id || Number(result[0].downtime_minutes)!==Number(body.downtime_minutes))){
        throw Error('Data downtime yang dikembalikan Supabase tidak sesuai input. Periksa constraint dan SQL.');
      }
    }catch(err){politeStatus('Simpan belum terkonfirmasi',false);throw err}
    if(!skipSync){
      try{await sync(true)}catch(e){console.warn('Data tersimpan, tetapi sinkronisasi ulang gagal:',e)}
    }
    return result[0];
  }
  window.SHO_API={sync,save};
  sync(true).catch(e=>{
    console.warn('SHO Supabase connection:',e.message);
    if(typeof notify==='function')notify('SHO belum dapat mengambil data online: '+e.message,true)
  });
  setInterval(()=>{if(!document.hidden)sync().catch(e=>console.warn('SHO background sync:',e.message))},15000);
  window.addEventListener('pageshow',()=>sync().catch(()=>{}));
  window.addEventListener('online',()=>sync(true).catch(()=>{}));
})();
