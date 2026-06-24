/* Temple Crowd Management - Frontend Simulation (no backend) */
(function(){
  const API_BASE = window.location.search.includes('api=local') ? 'http://localhost:5055' : (window.API_BASE||'');
  let ioSocket = null; try{ if(window.io){ ioSocket = io(API_BASE||undefined, { autoConnect: !!API_BASE }); } }catch{}
  const MAX_PER_SLOT = 150; // adjustable per temple policy
  const SLOT_MINUTES = 60;
  const STORAGE_KEYS = {
    tickets: 'tcm_tickets', // array of ticket objects
    activeVisitors: 'tcm_active_visitors', // map ticketId -> visitor state
    alerts: 'tcm_alerts'
  };

  const byId = (id)=>document.getElementById(id);
  const $year = byId('year');
  if($year) $year.textContent = new Date().getFullYear();

  // ---------- Slot Setup ----------
  const timeSlotSelect = byId('timeSlot');
  function generateSlots(){
    const slots=[]; // between 6:00 and 20:00
    for(let h=6;h<20;h++){
      const start = new Date(); start.setHours(h,0,0,0);
      const end = new Date(start.getTime() + SLOT_MINUTES*60*1000);
      const label = formatTime(start)+" – "+formatTime(end);
      const value = start.toISOString();
      slots.push({label,value});
    }
    return slots;
  }
  function formatTime(d){
    const h = d.getHours();
    const m = d.getMinutes().toString().padStart(2,'0');
    const ampm = h>=12?'PM':'AM';
    const hh = ((h+11)%12)+1;
    return `${hh}:${m} ${ampm}`;
  }
  function restore(name){
    try{ return JSON.parse(localStorage.getItem(name)||'null'); }catch{ return null }
  }
  function persist(name,val){ localStorage.setItem(name,JSON.stringify(val)); }
  function getTickets(){ return restore(STORAGE_KEYS.tickets)||[]; }
  function saveTickets(list){ persist(STORAGE_KEYS.tickets,list); }
  function getActive(){ return restore(STORAGE_KEYS.activeVisitors)||{}; }
  function saveActive(map){ persist(STORAGE_KEYS.activeVisitors,map); }
  function getAlerts(){ return restore(STORAGE_KEYS.alerts)||[]; }
  function saveAlerts(list){ persist(STORAGE_KEYS.alerts,list); }

  function refreshSlotsUI(){
    if(!timeSlotSelect) return;
    timeSlotSelect.innerHTML='';
    const slots = generateSlots();
    const tickets = getTickets();
    const slotInfo = byId('slotInfo');
    slots.forEach(s=>{
      const count = tickets.filter(t=>t.slot===s.value).length;
      const left = Math.max(0, MAX_PER_SLOT - count);
      const opt=document.createElement('option');
      opt.value=s.value; opt.textContent=`${s.label} (शेष ${left})`;
      opt.disabled = left===0;
      timeSlotSelect.appendChild(opt);
    });
    if(slotInfo) slotInfo.textContent = `प्रति स्लॉट क्षमता: ${MAX_PER_SLOT}`;
    updateDashboard();
  }

  // ---------- Booking + QR ----------
  const bookingForm = byId('bookingForm');
  const qrSection = byId('qrSection');
  const qrcodeEl = byId('qrcode');
  const downloadQR = byId('downloadQR');
  let qrCodeInstance = null;

  async function createTicket(data){
    const id = 'T'+Math.random().toString(36).slice(2,10).toUpperCase();
    const ticket = { id, ...data, createdAt: Date.now(), status:'booked' };
    if(API_BASE){
      const resp = await fetch(API_BASE+'/api/tickets',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
      if(!resp.ok){ const j=await resp.json().catch(()=>({})); throw new Error(j.error||'बुकिंग विफल'); }
      return await resp.json();
    } else {
      const list = getTickets();
      const count = list.filter(t=>t.slot===ticket.slot).length;
      if(count>=MAX_PER_SLOT){ throw new Error('स्लॉट फुल'); }
      list.push(ticket); saveTickets(list); return ticket;
    }
  }
  function showQR(ticket){
    if(!qrcodeEl) return;
    if(qrCodeInstance) qrcodeEl.innerHTML='';
    qrCodeInstance = new QRCode(qrcodeEl, {
      text: JSON.stringify(ticket), width: 180, height: 180
    });
    qrSection?.classList.remove('hidden');
  }
  downloadQR?.addEventListener('click',()=>{
    const img = qrcodeEl?.querySelector('img');
    if(!img) return;
    const a=document.createElement('a');
    a.href=img.src; a.download='temple-ticket-'+Date.now()+'.png'; a.click();
  });
  bookingForm?.addEventListener('submit',(e)=>{
    e.preventDefault();
    const payload={
      name: byId('name').value.trim(),
      phone: byId('phone').value.trim(),
      entryGate: byId('entryGate').value,
      exitGate: byId('exitGate').value,
      slot: byId('timeSlot').value
    };
    (async()=>{
      try{ const ticket=await createTicket(payload); showQR(ticket); refreshSlotsUI(); }
      catch(err){ alert(err.message||'बुकिंग विफल'); }
    })();
  });

  // ---------- Tabs ----------
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(btn.dataset.tab);
      pane?.classList.add('active');
    });
  });

  // ---------- QR Scan (Entry / Exit) ----------
  function validForNow(slotISO){
    const start = new Date(slotISO);
    const end = new Date(start.getTime()+SLOT_MINUTES*60*1000);
    const now = new Date();
    return now>=start && now<=end;
  }
  function startScan(elementId, onResult){
    const el = byId(elementId); if(!el) return null;
    const scanner = new Html5Qrcode(elementId);
    const config={fps:10, qrbox:250, formatsToSupport:[Html5QrcodeSupportedFormats.QR_CODE]};
    scanner.start({ facingMode: 'environment' }, config, (decoded)=>{
      try{ onResult(JSON.parse(decoded)); }catch{ onResult(null); }
    }, (err)=>{});
    return scanner;
  }
  let entryScanner=null, exitScanner=null;
  async function handleEntry(ticket, statusEl){
    if(!ticket?.id) return statusEl.textContent='अमान्य QR';
    let found=null;
    if(API_BASE){
      const resp = await fetch(API_BASE+'/api/tickets/'+ticket.id);
      if(resp.ok) found = await resp.json();
    } else {
      const tickets = getTickets();
      found = tickets.find(t=>t.id===ticket.id);
    }
    if(!found) return statusEl.textContent='टिकट नहीं मिला';
    if(!validForNow(found.slot)) return statusEl.textContent='टाइम स्लॉट मान्य नहीं';
    if(API_BASE){
      const resp = await fetch(API_BASE+'/api/entry',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:found.id})});
      if(!resp.ok){ const j=await resp.json().catch(()=>({})); statusEl.textContent = j.error||'एंट्री विफल'; return; }
    } else {
      const active = getActive();
      if(active[found.id]) return statusEl.textContent='पहले से अंदर दर्ज है';
      active[found.id]={ enteredAt: Date.now(), lastLocation:null };
      saveActive(active);
    }
    updateDashboard();
    statusEl.textContent='एंट्री सफल';
    // optional: start geolocation tracking
    if('geolocation' in navigator){
      navigator.geolocation.getCurrentPosition(pos=>{
        if(API_BASE){ fetch(API_BASE+'/api/location',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: found.id, lat: pos.coords.latitude, lon: pos.coords.longitude })}); }
        else { const active = getActive(); active[found.id].lastLocation=[pos.coords.latitude,pos.coords.longitude]; saveActive(active); }
        updateHeat([pos.coords.latitude,pos.coords.longitude]);
      });
    }
  }
  async function handleExit(ticket, statusEl){
    if(!ticket?.id) return statusEl.textContent='अमान्य QR';
    if(API_BASE){
      const resp = await fetch(API_BASE+'/api/exit',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:ticket.id})});
      if(!resp.ok){ const j=await resp.json().catch(()=>({})); statusEl.textContent=j.error||'एग्ज़िट विफल'; return; }
    } else {
      const active = getActive();
      if(!active[ticket.id]) return statusEl.textContent='एंट्री रिकॉर्ड नहीं';
      delete active[ticket.id]; saveActive(active);
    }
    updateDashboard();
    statusEl.textContent='एग्ज़िट सफल';
  }
  window.addEventListener('load',()=>{
    refreshSlotsUI();
    entryScanner = startScan('entry-reader',(data)=> handleEntry(data, byId('entryStatus')));
    exitScanner = startScan('exit-reader',(data)=> handleExit(data, byId('exitStatus')));
  });

  // ---------- Map, Heatmap and Gates ----------
  let map, heat, markers=[];
  function initMap(){
    map = L.map('mapView').setView([26.85, 80.95], 16); // default coords
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    // Gates & POIs
    const pois = [
      {name:'Entry North Gate', type:'gate', lat:26.851, lon:80.951},
      {name:'Exit South Gate', type:'gate', lat:26.849, lon:80.949},
      {name:'मुख्य दर्शन', type:'darshan', lat:26.85, lon:80.95},
      {name:'प्रसाद काउंटर', type:'counter', lat:26.8506, lon:80.9511},
      {name:'शौचालय', type:'toilet', lat:26.8498, lon:80.9503},
      {name:'पार्किंग', type:'parking', lat:26.852, lon:80.948}
    ];
    pois.forEach(p=>{
      const m=L.marker([p.lat,p.lon]).addTo(map).bindPopup(p.name);
      markers.push(m);
    });
    heat = L.heatLayer([], { radius: 25, blur: 15, maxZoom: 17, minOpacity: 0.3 }).addTo(map);
    simulateCrowd();
    if(ioSocket){
      ioSocket.on('heatPoint', ({lat,lon})=> updateHeat([lat,lon]));
      ioSocket.on('stats', s=>{ byId('inCount').textContent=s.inCount; byId('ticketsCount').textContent=s.ticketsCount; byId('alertsCount').textContent=s.alertsCount; });
      ioSocket.on('alert', ({message})=>{ const list=getAlerts(); list.push({id:'R'+Date.now(), ts:Date.now(), message}); saveAlerts(list); renderAlerts(); });
    }
  }
  function updateHeat(point){
    const data = heat._latlngs ? [...heat._latlngs] : [];
    if(point) data.push(point);
    // also add from active visitors
    const active = getActive();
    Object.values(active).forEach(v=>{ if(v.lastLocation) data.push(v.lastLocation); });
    heat.setLatLngs(data);
    evaluateCongestion(data);
  }
  function simulateCrowd(){
    // simple random walkers around center for demo
    setInterval(()=>{
      const base=[26.85,80.95];
      const swarm = Array.from({length: Math.floor(10+Math.random()*20)},()=>[
        base[0] + (Math.random()-0.5)*0.004,
        base[1] + (Math.random()-0.5)*0.004
      ]);
      heat.setLatLngs(swarm);
      evaluateCongestion(swarm);
    }, 5000);
  }
  function evaluateCongestion(points){
    // naive density alert
    const density = points.length;
    const alerts = getAlerts();
    if(density>25){
      alerts.push({ id:'A'+Date.now(), message:'मुख्य क्षेत्र में भीड़ अधिक', ts:Date.now()});
      saveAlerts(alerts);
    }
    renderAlerts();
  }
  function suggestAlternateRoute(){
    alert('वैकल्पिक मार्ग: East Gate होकर प्रसाद काउंटर की ओर जाएँ');
  }
  byId('suggestRoute')?.addEventListener('click', suggestAlternateRoute);

  // ---------- Dashboard ----------
  function updateDashboard(){
    const inCount = Object.keys(getActive()).length;
    const ticketsCount = getTickets().length;
    byId('inCount').textContent = inCount;
    byId('ticketsCount').textContent = ticketsCount;
  }
  function renderAlerts(){
    const list = getAlerts();
    byId('alertsCount').textContent = list.length;
    const wrap = byId('alerts'); wrap.innerHTML='';
    list.slice(-5).reverse().forEach(a=>{
      const div=document.createElement('div');
      div.className='alert';
      const t=new Date(a.ts).toLocaleTimeString();
      div.textContent = `${t} • ${a.message}`;
      wrap.appendChild(div);
    });
  }

  // ---------- SOS ----------
  byId('sosBtn')?.addEventListener('click',()=>{
    const alerts = getAlerts();
    const push = (msg)=>{ alerts.push({id:'S'+Date.now(), message:msg, ts:Date.now()}); saveAlerts(alerts); renderAlerts(); };
    if('geolocation' in navigator){
      navigator.geolocation.getCurrentPosition(pos=>{
        const msg = `SOS प्राप्त • स्थान: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
        push(msg);
        if(API_BASE){ fetch(API_BASE+'/api/alerts',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: msg })}); }
        byId('sosStatus').textContent='SOS भेजा गया। टीम संपर्क करेगी।';
      },()=>{ push('SOS प्राप्त (लोकेशन अनुपलब्ध)'); });
    } else { push('SOS प्राप्त (लोकेशन सपोर्ट नहीं)'); }
  });

  // ---------- Privacy & Time Expiry ----------
  function enforceTimeLimits(){
    const active = getActive();
    const tickets = getTickets();
    const now = Date.now();
    let changed=false;
    for(const id of Object.keys(active)){
      const t=tickets.find(x=>x.id===id); if(!t) continue;
      const start = new Date(t.slot).getTime();
      const end = start + SLOT_MINUTES*60*1000;
      if(now>end){
        delete active[id];
        changed=true;
        const alerts=getAlerts();
        alerts.push({id:'E'+Date.now(), message:`समय समाप्त • टिकट ${id}`, ts:Date.now()});
        saveAlerts(alerts);
      }
    }
    if(changed){ saveActive(active); renderAlerts(); updateDashboard(); }
  }
  setInterval(enforceTimeLimits, 15000);

  // ---------- Live Darshan (HLS placeholder) ----------
  function initDarshan(){
    const video = byId('darshanPlayer');
    if(!video) return;
    const src = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'; // demo HLS
    if(video.canPlayType('application/vnd.apple.mpegurl')){ video.src=src; }
    else if(window.Hls&&Hls.isSupported()){
      const hls = new Hls(); hls.loadSource(src); hls.attachMedia(video);
    }
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded',()=>{
    initMap(); initDarshan(); renderAlerts(); updateDashboard();
  });
})();


