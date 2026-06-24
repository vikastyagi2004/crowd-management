import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { nanoid } from 'nanoid';

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Data store
const adapter = new JSONFile('./data.json');
const db = new Low(adapter, { tickets: [], active: {}, alerts: [], config: { maxPerSlot: 150, slotMinutes: 60 } });
await db.read();
db.data ||= { tickets: [], active: {}, alerts: [], config: { maxPerSlot: 150, slotMinutes: 60 } };

function broadcast(){
  io.emit('stats', { inCount: Object.keys(db.data.active).length, ticketsCount: db.data.tickets.length, alertsCount: db.data.alerts.length });
}

// Slots
app.get('/api/config', (req,res)=>{ res.json(db.data.config); });
app.get('/api/slots/:day', (req,res)=>{
  const { slotMinutes } = db.data.config;
  const startH=6,endH=20;
  const slots=[];
  for(let h=startH;h<endH;h++){
    const start=new Date(req.params.day+'T'+String(h).padStart(2,'0')+':00:00');
    slots.push(start.toISOString());
  }
  res.json({ slots });
});

// Tickets
app.post('/api/tickets', async (req,res)=>{
  const { name, phone, entryGate, exitGate, slot } = req.body||{};
  if(!name||!phone||!entryGate||!exitGate||!slot) return res.status(400).json({ error: 'missing fields' });
  const cap = db.data.config.maxPerSlot;
  const count = db.data.tickets.filter(t=>t.slot===slot).length;
  if(count>=cap) return res.status(409).json({ error: 'slot full' });
  const ticket = { id: 'T'+nanoid(8).toUpperCase(), name, phone, entryGate, exitGate, slot, createdAt: Date.now(), status: 'booked' };
  db.data.tickets.push(ticket);
  await db.write();
  broadcast();
  res.json(ticket);
});

app.get('/api/tickets/:id', (req,res)=>{
  const t = db.data.tickets.find(x=>x.id===req.params.id);
  if(!t) return res.status(404).end();
  res.json(t);
});

// Entry / Exit
app.post('/api/entry', async (req,res)=>{
  const { id } = req.body||{}; const t = db.data.tickets.find(x=>x.id===id);
  if(!t) return res.status(404).json({ error:'not found' });
  if(db.data.active[id]) return res.status(409).json({ error:'already in' });
  db.data.active[id]={ enteredAt: Date.now(), lastLocation:null };
  await db.write();
  broadcast();
  res.json({ ok:true });
});

app.post('/api/exit', async (req,res)=>{
  const { id } = req.body||{};
  if(!db.data.active[id]) return res.status(404).json({ error:'not inside' });
  delete db.data.active[id];
  await db.write();
  broadcast();
  res.json({ ok:true });
});

// Location & Alerts
app.post('/api/location', async (req,res)=>{
  const { id, lat, lon } = req.body||{};
  if(db.data.active[id]){ db.data.active[id].lastLocation=[lat,lon]; await db.write(); io.emit('heatPoint',{lat,lon}); }
  res.json({ ok:true });
});
app.post('/api/alerts', async (req,res)=>{
  const { message } = req.body||{};
  db.data.alerts.push({ id:'A'+Date.now(), ts:Date.now(), message });
  await db.write();
  io.emit('alert',{ message });
  broadcast();
  res.json({ ok:true });
});

const PORT = process.env.PORT || 5055;
httpServer.listen(PORT, ()=> console.log('Server running on http://localhost:'+PORT));


