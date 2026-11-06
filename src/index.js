import 'dotenv/config';
import express from 'express';
import swagger from 'swagger-ui-express';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {PortalClient,PortalError} from './client.js';
import {rows,reading} from './parser.js';
import {createInventory} from './inventory.js';

const spec = JSON.parse(readFileSync(new URL('../openapi.json',import.meta.url),'utf8'));
const email = process.env.PORTAL_EMAIL || 'operator@urja.local';
const password = process.env.PORTAL_PASSWORD;
if (!password) throw new Error('Set PORTAL_PASSWORD from the assignment PDF in .env.');
const client = new PortalClient({baseUrl:'https://urja-ops.flockenergy.tech',email,password,
  timeoutMs:15000});
const app = express();
app.disable('x-powered-by');
app.get('/openapi.json',(_req,res)=>res.json(spec));
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
app.use('/assets',express.static(publicDir));
app.get(['/', '/docs', '/docs/'],(_req,res)=>res.sendFile(publicDir+'index.html'));
app.use('/api-docs',swagger.serve,swagger.setup(spec));
app.get('/health',(_req,res)=>res.json({status:'ok'}));

const meters = createInventory(client);
function missing(resource) {return new PortalError('NOT_FOUND',resource+' not found.',404);}
async function byId(id) {
  const record=(await meters()).find(m=>m.id===id);
  if (!record) throw missing('Meter');
  return record;
}
function list(data,req,res) {
  const page=Number(req.query.page ?? 1);
  const size=Number(req.query.limit ?? 20);
  if (!Number.isSafeInteger(page)||page<1||!Number.isInteger(size)||size<1||size>100)
    throw new PortalError('INVALID_INPUT','Use a positive page and a limit between 1 and 100.',400);
  res.json({data:data.slice((page-1)*size,page*size),total:data.length,page,limit:size});
}
app.get('/meters',async(req,res)=>{
  const q=req.query.q ?? '';
  if (typeof q!=='string') throw new PortalError('INVALID_INPUT','q must be a string.',400);
  const term=q.trim().toLowerCase();
  list((await meters()).filter(m=>[m.id,m.serial].some(v=>String(v).toLowerCase().includes(term))),req,res);
});
app.get('/meters/:id',async(req,res)=>res.json(await byId(req.params.id)));
app.get('/meters/:id/readings',async(req,res)=>{
  const m=await byId(req.params.id);
  res.json({meter_id:m.id,data:rows(await client.readings(m.id)).map(reading)});
});
app.get('/transformers/:id/meters',async(req,res)=>{
  const matches=(await meters()).filter(m=>m.transformer_id===req.params.id);
  if (!matches.length) {
    for (let page=1;;page++) {
      const result=await client.transformers(page);
      if (rows(result).some(dt=>dt.code===req.params.id)) break;
      if (!Number.isSafeInteger(result.total)||!(result.pageSize>0)) throw new PortalError('INVALID_DATA','Invalid transformer page.');
      if (!result.data.length||page*result.pageSize>=result.total) throw missing('Transformer');
    }
  }
  list(matches,req,res);
});
app.use((_req,_res,next)=>next(missing('Route')));
app.use((err,_req,res,_next)=>{
  const known=err instanceof PortalError;
  res.status(known?err.status:500).json({error:{code:known?err.code:'INTERNAL_ERROR',message:known?err.message:'Unexpected server error.'}});
});
app.listen(Number(process.env.PORT || 3000),process.env.HOST || '127.0.0.1',()=>console.log('Urja API ready on localhost.'));
