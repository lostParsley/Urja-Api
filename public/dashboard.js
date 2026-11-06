'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {meters:[], filtered:[], page:1, size:8, selected:null, readings:[], series:'kwh', view:'overview', generation:0, selection:0};
const number = value => Number.isFinite(value) ? new Intl.NumberFormat('en-IN',{maximumFractionDigits:2}).format(value) : '—';
let inventoryController, readingController;
function banner(message, error=false) {
  $('#banner').hidden = !message;
  $('#banner').textContent = message;
  $('#banner').classList.toggle('error',error);
}
async function get(path, signal) {
  const response = await fetch(path,{signal,headers:{Accept:'application/json'}});
  const body = await response.json().catch(()=>null);
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status}).`);
  if (!body) throw new Error('The API returned an unreadable response.');
  return body;
}
function renderSummary() {
  const statuses = ['Installed','Faulty','Decommissioned'];
  const colors = ['#799e60','#dda96e','#dce2d3'];
  const counts = statuses.map(status => state.meters.filter(m=>m.status===status).length);
  const other = state.meters.length - counts.reduce((a,b)=>a+b,0);
  if (other) {statuses.push('Other');colors.push('#91aaa1');counts.push(other);}
  $('#total').textContent = number(state.meters.length);
  $('#installed').textContent = number(counts[0]);
  $('#faulty').textContent = number(counts[1]);
  $('#donutTotal').textContent = number(state.meters.length);
  const ids = [...new Set(state.meters.map(m=>m.transformer_id).filter(Boolean))].sort();
  $('#transformerCount').textContent = number(ids.length);
  const previous = $('#transformer').value;
  $('#transformer').innerHTML = '<option value="">All transformers</option>' + ids.map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join('');
  if (ids.includes(previous)) $('#transformer').value = previous;
  let start = 0;
  const gradient = counts.map((count,i)=>{const end=start+count/Math.max(state.meters.length,1)*100;const part=`${colors[i]} ${start}% ${end}%`;start=end;return part;});
  $('#donut').style.background = state.meters.length ? `conic-gradient(${gradient.join(',')})` : '#e8ece5';
  $('#legend').innerHTML = statuses.map((status,i)=>`<div><span><i style="background:${colors[i]}"></i>${esc(status)}</span><strong>${number(counts[i])}<small>${state.meters.length ? Math.round(counts[i]/state.meters.length*100) : 0}%</small></strong></div>`).join('');
}
function renderTable() {
  const term = $('#search').value.trim().toLowerCase();
  const status = $('#status').value, transformer = $('#transformer').value;
  state.filtered = state.meters.filter(m=>(!term || [m.id,m.serial].some(v=>String(v??'').toLowerCase().includes(term))) && (!status || m.status===status) && (!transformer || m.transformer_id===transformer));
  const pages = Math.max(1,Math.ceil(state.filtered.length/state.size));
  state.page = Math.min(state.page,pages);
  const start = (state.page-1)*state.size;
  $('#listCount').textContent = number(state.filtered.length);
  $('#rows').innerHTML = state.filtered.slice(start,start+state.size).map(m=>`<tr class="${state.selected?.id===m.id?'selected':''}"><td><button class="meter-link" data-meter="${esc(m.id)}"><span class="device-icon">▥</span><span>${esc(m.id)}<small>${esc(m.serial)}</small></span></button></td><td>${esc(m.make)}</td><td><span class="status ${['Installed','Faulty','Decommissioned'].includes(m.status)?m.status.toLowerCase():''}">${esc(m.status)}</span></td><td>${esc(m.phase)}</td><td><button class="dt-link" data-transformer="${esc(m.transformer_id||'')}">${esc(m.transformer_id)}</button></td><td><button class="text-button" data-profile="${esc(m.id)}" aria-label="Details for ${esc(m.id)}">↗</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No meters match these filters. Try another search or reset the filters.</td></tr>';
  $('#paginationText').textContent = state.filtered.length ? `Showing ${start+1}–${Math.min(start+state.size,state.filtered.length)} of ${number(state.filtered.length)} meters` : '0 meters';
  $('#pageNumber').textContent = `${state.page} / ${pages}`;
  $('#previous').disabled = state.page<=1;
  $('#next').disabled = state.page>=pages;
  $('#export').disabled = !state.filtered.length;
}
function renderChart() {
  const field = state.series, unit = {kwh:'kWh',kvah:'kVAh',voltage_r:'V'}[field];
  const valid = state.readings.map((r,i)=>({i,y:r[field],time:r.timestamp})).filter(p=>Number.isFinite(p.y));
  $('.chart-card h2').textContent = field==='voltage_r' ? 'Voltage profile' : 'Cumulative energy';
  $('.chart-stat > span').textContent = `${unit} · last recorded value`;
  $('#latestReading').textContent = valid.length ? number(valid.at(-1).y) : '—';
  if (!valid.length) {
    $('#chart').innerHTML='<div class="empty">No readings available for this metric.</div>';
    $('#range').textContent='Historical readings · portal time';
    return;
  }
  const width=820,height=190,left=67,right=15,top=12,bottom=28;
  const min=Math.min(...valid.map(p=>p.y)), max=Math.max(...valid.map(p=>p.y));
  const pad=(max-min)*0.12 || Math.max(Math.abs(max)*0.01,1), low=min-pad, high=max+pad;
  const x=i=>left+i/Math.max(state.readings.length-1,1)*(width-left-right);
  const y=v=>top+(high-v)/(high-low)*(height-top-bottom);
  // Split at missing values so the chart never implies measurements across a gap.
  const segments=[];let segment=[];
  state.readings.forEach((r,i)=>{if(Number.isFinite(r[field]))segment.push([x(i),y(r[field])]);else if(segment.length){segments.push(segment);segment=[];}});
  if(segment.length)segments.push(segment);
  const paths=segments.map(points=>{const line=points.map(([px,py],i)=>`${i?'L':'M'}${px.toFixed(2)},${py.toFixed(2)}`).join(' ');return `<path d="${line} L${points.at(-1)[0]},${height-bottom} L${points[0][0]},${height-bottom} Z" fill="url(#area)"/><path d="${line}" fill="none" stroke="#6b9352" stroke-width="2.5" stroke-linejoin="round"/>`;}).join('');
  const grid=Array.from({length:4},(_,i)=>{const value=low+(high-low)*i/3,py=y(value);return `<line x1="${left}" y1="${py}" x2="${width-right}" y2="${py}" stroke="#e9ede6" stroke-dasharray="3 5"/><text x="${left-12}" y="${py+4}" text-anchor="end" fill="#8a948a" font-size="11">${esc(number(value))}</text>`;}).join('');
  const points=valid.map(p=>`<circle cx="${x(p.i)}" cy="${y(p.y)}" r="5" fill="transparent" stroke="transparent"><title>${esc(p.time)} · ${esc(number(p.y))} ${unit}</title></circle>`).join('');
  const first=state.readings[0].timestamp, last=state.readings.at(-1).timestamp;
  $('#chart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(unit)} readings for ${esc(state.selected.id)}; ${valid.length} recorded values, latest ${esc(number(valid.at(-1).y))}." style="width:100%;height:100%"><defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#c5dda9" stop-opacity=".55"/><stop offset="100%" stop-color="#c5dda9" stop-opacity=".03"/></linearGradient></defs>${grid}${paths}${points}<text x="${left}" y="${height-3}" fill="#8a948a" font-size="11">${esc(first)}</text><text x="${width-right}" y="${height-3}" text-anchor="end" fill="#8a948a" font-size="11">${esc(last)}</text></svg>`;
  $('#range').textContent = `${valid.length} readings · ${first} – ${last} · portal time`;
}
function renderMeterProfile() {
  const m=state.selected;
  $('#meterProfile').hidden=!m;
  if(!m)return;
  $('#profileTitle').textContent=`Meter ${m.id}`;
  const fields=[['Meter ID',m.id],['Serial number',m.serial],['Make',m.make],['Phase type',m.phase],['Installation status',m.status],['Installation type',m.installation_type]];
  $('#nameplate').innerHTML=fields.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('');
  $('#meterLocation').textContent=`Latitude: ${m.location?.latitude ?? 'Not supplied'} / Longitude: ${m.location?.longitude ?? 'Not supplied'}`;
  $('#meterHierarchy').textContent=Object.values(m.hierarchy||{}).filter(Boolean).map(p=>[p.name,p.code].filter(Boolean).join(' / ')).filter(Boolean).join(' > ')||'Network hierarchy not supplied';
}
function renderReadings(message) {
  $('#readingStatus').textContent=message || (state.readings.length?`${state.readings.length} readings | Latest: ${state.readings.at(-1).timestamp} | Portal time`:'No readings available');
  $('#readingRows').innerHTML=message || !state.readings.length
    ? `<tr><td colspan="4" class="empty">${esc(message||'No readings available for this meter.')}</td></tr>`
    : state.readings.map(r=>`<tr><td>${esc(r.timestamp)}</td><td>${esc(r.kwh)}</td><td>${esc(r.kvah)}</td><td>${esc(r.voltage_r)}</td></tr>`).join('');
}
function showDetails() {
  const m=state.selected;if(!m)return;
  const fields=[['Serial number',m.serial],['Manufacturer',m.make],['Status',m.status],['Phase',m.phase],['Installation type',m.installation_type],['Transformer',m.transformer_id],['Latitude',m.location?.latitude],['Longitude',m.location?.longitude]];
  const hierarchy=Object.values(m.hierarchy||{}).filter(Boolean).map(p=>[p.name,p.code].filter(Boolean).join(' · ')).filter(Boolean);
  $('#detailContent').innerHTML=`<h2>${esc(m.id)}</h2><p class="muted">Device identity & installation details</p><dl>${fields.map(([key,value])=>`<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><h3>Network hierarchy</h3><p class="hierarchy">${hierarchy.map(esc).join(' <span>›</span> ')||'Not supplied by the portal'}</p><a class="button" href="/meters/${encodeURIComponent(m.id)}" target="_blank" rel="noopener">Open JSON ↗</a>`;
  if(!$('#detail').open)$('#detail').showModal();
}
async function selectMeter(id, showProfile=false) {
  const selection=++state.selection;
  readingController?.abort();readingController=new AbortController();
  state.selected=state.meters.find(m=>m.id===id);state.readings=[];
  renderMeterProfile();renderReadings('Loading historical readings...');
  $('#selectedBadge').textContent=id;$('#latestReading').textContent='—';
  $('#range').textContent='Loading historical readings…';
  $('#chart').innerHTML='<div class="empty loading">Fetching readings from the portal…</div>';
  $('#detailButton').disabled=!state.selected;
  renderTable();if(showProfile)showDetails();
  try {
    const readings=await get(`/meters/${encodeURIComponent(id)}/readings`,readingController.signal);
    if(selection!==state.selection)return;
    state.readings=readings.data;
    renderChart();renderReadings();if($('#detail').open)showDetails();
  }catch(error){if(error.name==='AbortError'||selection!==state.selection)return;$('#chart').innerHTML=`<div class="empty">${esc(error.message)}<br>Select the meter again to retry.</div>`;$('#range').textContent='Readings unavailable';renderReadings(`${error.message} Select the meter again to retry.`);}
}
async function loadInventory() {
  const generation=++state.generation;
  inventoryController?.abort();inventoryController=new AbortController();
  readingController?.abort();state.selection++;
  $('#refresh').disabled=true;$('#refresh').classList.add('loading');
  banner('Syncing the meter inventory with the portal…');
  try {
    const health=await get('/health',inventoryController.signal);
    $('#health').textContent=health.status==='ok'?'API online':'API responding';
    $('#health').classList.add('online');
    const first=await get('/meters?limit=100&page=1',inventoryController.signal);
    const meters=[...first.data];
    for(let page=2;page<=Math.ceil(first.total/100);page++) {
      banner(`Syncing inventory · ${meters.length} of ${first.total} meters`);
      const result=await get(`/meters?limit=100&page=${page}`,inventoryController.signal);
      meters.push(...result.data);
    }
    if(generation!==state.generation)return;
    if(meters.length!==first.total || new Set(meters.map(m=>m.id)).size!==first.total)throw new Error('Inventory changed while loading. Refresh to try again.');
    state.meters=meters;renderSummary();renderTable();banner('');
    $('#updated').textContent=`Inventory fetched ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;
    const id=meters.find(m=>m.id===state.selected?.id)?.id||meters.find(m=>m.status==='Installed')?.id||meters[0]?.id;
    if(id)selectMeter(id);
    else {state.selected=null;state.readings=[];renderMeterProfile();renderReadings();$('#detailButton').disabled=true;$('#selectedBadge').textContent='No meters';renderChart();}
  }catch(error){if(error.name==='AbortError')return;banner(`${error.message} Use Refresh data to retry.${state.meters.length?' Previously fetched inventory is still displayed.':''}`,true);if(!state.meters.length){$('#rows').innerHTML='<tr><td colspan="6" class="empty">Inventory unavailable. Check the portal connection and retry.</td></tr>';$('#paginationText').textContent='Data unavailable';}}
  finally{if(generation===state.generation){$('#refresh').disabled=false;$('#refresh').classList.remove('loading');}}
}
function setView(view) {
  state.view=view;
  const labels={overview:['Overview','Your network, in focus.','A clearer view of every meter, connection and reading.'],meters:['Meter inventory','Every meter. One place.','Search, filter and inspect your connected devices.'],transformers:['Transformers','Follow the connections.','Choose a transformer to explore its attached meters.']};
  const [label,title,subtitle]=labels[view];
  $('#crumb').textContent=label;$('#title').textContent=title;$('#subtitle').textContent=subtitle;
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  $('#insights').hidden=view!=='overview';
  $('#listDescription').textContent=view==='transformers'?'Filter by transformer code to see connected devices.':'Explore devices across your distribution network.';
  if(view==='transformers')$('#transformer').focus();
}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
document.querySelectorAll('[data-series]').forEach(b=>b.addEventListener('click',()=>{state.series=b.dataset.series;document.querySelectorAll('[data-series]').forEach(t=>t.classList.toggle('active',t===b));renderChart();}));
['search','status','transformer'].forEach(id=>$('#'+id).addEventListener(id==='search'?'input':'change',()=>{state.page=1;renderTable();}));
$('#clearFilters').addEventListener('click',()=>{['search','status','transformer'].forEach(id=>$('#'+id).value='');state.page=1;renderTable();});
$('#previous').addEventListener('click',()=>{state.page--;renderTable();});
$('#next').addEventListener('click',()=>{state.page++;renderTable();});
$('#rows').addEventListener('click',e=>{const meter=e.target.closest('[data-meter]'),dt=e.target.closest('[data-transformer]'),profile=e.target.closest('[data-profile]');if(meter){setView('overview');selectMeter(meter.dataset.meter);$('#meterProfile').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}if(dt){setView('transformers');$('#transformer').value=dt.dataset.transformer;state.page=1;renderTable();}if(profile)selectMeter(profile.dataset.profile,true);});
$('#detailButton').addEventListener('click',showDetails);
$('#closeDetail').addEventListener('click',()=>$('#detail').close());
$('#detail').addEventListener('click',e=>{if(e.target===$('#detail')){const r=$('#detail').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#detail').close();}});
$('#refresh').addEventListener('click',loadInventory);
$('#export').addEventListener('click',()=>{
  const fields=['id','serial','make','status','phase','transformer_id'];
  const cell=value=>{let s=String(value??'');if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
  const csv=[fields,...state.filtered.map(m=>fields.map(f=>m[f]))].map(row=>row.map(cell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='urja-meter-inventory.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
loadInventory();
