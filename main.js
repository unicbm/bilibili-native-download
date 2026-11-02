'use strict';
const { createDownloadTag, createSafeFileTarget, saveError } = require('./safe-target.js');

function startBiliDownloader({ win, doc, network, media, core, range, pickDirectory, getValue, setValue, menu } = {}) {
  const C=core;
  const MiB=1024*1024;
  const ICON='<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 3v12m-4.5-4.5L12 15l4.5-4.5M4 15.5v3A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let meta=null, manifest=null, selectedKey='', audioKey='', preparation=null, prepared=null;
  let analysisController=null, activeJob=null, disposed=false, sessionSerial=0, prepareSerial=0;
  let blobURL=null, lastHref=win.location.href, tickTimer=null, mountTimer=null;
  let analysisIdentity='', prepStatus='', savedStatus='', failMessage='';
  let concurrency=4;
  try { const n=Number(getValue?.('bnd.concurrent',4)); if([1,2,4,6,8].includes(n))concurrency=n; } catch { /* defaults */ }
  const host=doc.createElement('div');host.id='bnd-panel-host';host.hidden=true;
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>
    /* Inherit Bilibili's page theme, including themes supplied by other scripts. */
    :host{display:block;min-width:0;margin:0 0 16px;font:inherit;color:var(--text1,#18191c);--bnd-bg:var(--bg1,#fff);--bnd-text:var(--text1,#18191c);--bnd-muted:var(--text2,#61666d);--bnd-dim:var(--text3,#9499a0);--bnd-line:var(--line_regular,#e3e5e7);--bnd-soft:var(--graph_bg_thin,var(--bg2,#f6f7f8));--bnd-blue:var(--brand_blue,#00aeec);--bnd-selected:var(--brand_blue_thin,#dff6fd)}
    :host([hidden]){display:none!important}
    *{box-sizing:border-box}button,input,select{font:inherit}button,select,summary{cursor:pointer}button:disabled,select:disabled,input:disabled{cursor:default;opacity:.5}[hidden]{display:none!important}
    .panel{position:static;width:100%;min-width:0;padding:16px 0;border-bottom:1px solid var(--line_light,var(--bnd-line));background:transparent;color:var(--bnd-text);font-size:14px;line-height:1.5;overflow-wrap:anywhere}
    .head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:6px}.heading{display:flex;align-items:center;gap:8px;min-width:0}.heading h2{font-size:16px;line-height:24px;font-weight:500;margin:0}.format{border:1px solid var(--bnd-line);border-radius:3px;color:var(--bnd-dim);font-size:11px;line-height:16px;padding:0 4px}.collapse{display:inline-flex;align-items:center;gap:4px;border:0;padding:4px 0 4px 8px;background:transparent;color:var(--bnd-muted);font-size:12px;white-space:nowrap}.collapse:hover{color:var(--bnd-blue)}.collapse svg{width:14px;height:14px}
    .title{color:var(--bnd-dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0 0 12px}
    .table-wrap{max-height:224px;overflow:auto;border:1px solid var(--bnd-line);border-radius:6px;overscroll-behavior:contain;scrollbar-width:thin}table{border-collapse:collapse;width:100%;font-size:13px}thead{position:sticky;top:0;background:var(--bnd-soft);z-index:1}th{text-align:left;font-weight:400;color:var(--bnd-muted);padding:7px 12px}td{padding:8px 12px;border-top:1px solid var(--bnd-line);white-space:nowrap}th:first-child,td:first-child{width:34px;padding-right:0}tr.chosen{background:var(--bnd-selected)}tbody tr:hover{background:var(--bnd-soft)}tbody tr.chosen:hover{background:var(--bnd-selected)}input[type=radio]{accent-color:var(--bnd-blue);margin:0;cursor:pointer}.resolution{font-weight:500}.dims{color:var(--bnd-dim);font-size:11px;margin-left:8px}.codec{color:var(--bnd-muted);font-size:12px}.size{text-align:right;font-variant-numeric:tabular-nums}
    .hint{font-size:12px;color:var(--bnd-dim);margin:7px 0 0}.note{color:var(--bnd-muted);font-size:12px;line-height:1.6}.settings{margin-top:12px;border-top:1px solid var(--line_light,var(--bnd-line))}.settings>summary{padding:10px 0;color:var(--bnd-muted);font-size:12px;width:fit-content}.settings>summary:hover{color:var(--bnd-blue)}.settings>summary span{color:var(--bnd-dim);margin-left:8px}
    .fields{display:grid;grid-template-columns:1fr .65fr 1.5fr;gap:12px;padding:2px 0 12px}.field{display:flex;flex-direction:column;gap:5px;min-width:0;color:var(--bnd-muted);font-size:12px}select{min-width:0;width:100%;height:32px;border:1px solid var(--bnd-line);border-radius:4px;background:var(--bnd-bg);color:var(--bnd-text);padding:0 8px;outline-offset:2px}.linebox{background:var(--bnd-soft);border-radius:4px;padding:10px 12px;margin-bottom:12px}.line-title{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--bnd-muted)}.text-button{border:0;background:transparent;color:var(--bnd-blue);padding:2px;font-size:12px}.routes{font-size:12px;color:var(--bnd-dim);margin:5px 0 0;overflow-wrap:anywhere;line-height:1.7}
    .foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:4px}.summary{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}.total{font-weight:500;font-variant-numeric:tabular-nums}.actions{display:flex;gap:8px;flex-shrink:0}.primary,.secondary{min-height:32px;border-radius:4px;padding:5px 14px;font-size:13px;line-height:20px}.primary{background:var(--bnd-blue);border:1px solid var(--bnd-blue);color:var(--text_white,#fff)}.primary:hover:enabled{background:var(--Lb5,#40c5f1);border-color:var(--Lb5,#40c5f1)}.secondary{background:var(--bnd-bg);color:var(--bnd-muted);border:1px solid var(--bnd-line)}.secondary:hover:enabled{color:var(--bnd-blue);border-color:var(--bnd-blue)}
    .status{margin-top:10px;font-size:12px;color:var(--bnd-muted);overflow-wrap:anywhere}.status:empty{display:none}.success{color:var(--brand_green,#2ac864)}.error{color:var(--stress_red,#f85a54);font-size:12px;margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere}.bar{height:4px;border-radius:2px;overflow:hidden;background:var(--bnd-line);margin:8px 0}.bar>div{height:100%;width:0;background:var(--bnd-blue);transition:width .15s}.metrics{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--bnd-dim);font-variant-numeric:tabular-nums}.empty{padding:22px 8px;color:var(--bnd-muted);text-align:center}
    button:focus-visible,select:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--bnd-blue);outline-offset:3px}
    @container bnd-panel (max-width:600px){.dims{display:block;margin-left:0}.fields{grid-template-columns:1fr 1fr}.save-field{grid-column:1/-1}.foot{flex-wrap:wrap}.summary{width:100%}.settings>summary span{display:none}th,td{padding-left:8px;padding-right:8px}.metrics{flex-wrap:wrap}}
    :host{container-type:inline-size;container-name:bnd-panel}
  </style>
  <section class="panel" role="region" aria-labelledby="bnd-heading">
    <div class="head"><div class="heading"><h2 id="bnd-heading">下载视频</h2><span class="format">MP4</span></div><button class="collapse" data-id="close" aria-label="收起下载面板">收起<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <p class="title" data-id="title">正在读取当前视频…</p>
    <div class="table-wrap"><table aria-label="可下载的画质"><thead><tr><th scope="col" aria-label="选择"></th><th scope="col">清晰度</th><th scope="col">编码</th><th scope="col">帧率</th><th scope="col" class="size">音视频体积</th></tr></thead><tbody data-id="rows"></tbody></table><div class="empty" data-id="empty">解析中…</div></div>
    <p class="hint" data-id="quality-hint">≈ 为估算体积，选中后读取准确大小。</p>
    <details class="settings"><summary>下载设置<span>音轨、并发与保存方式</span></summary>
      <div class="fields">
        <label class="field">音轨<select data-id="audio" aria-label="音轨"></select></label>
        <label class="field">下载并发<select data-id="concurrency" aria-label="下载并发"><option value="1">1 路</option><option value="2">2 路</option><option value="4">4 路 · 默认</option><option value="6">6 路</option><option value="8">8 路</option></select></label>
        <label class="field save-field">保存方式<select data-id="save-mode" aria-label="保存方式"><option value="disk">直接写入磁盘 · 另存新文件</option><option value="memory">内存下载 · 最大 256 MiB</option></select></label>
      </div>
      <div class="linebox"><div class="line-title"><span>CDN 自动选线</span><button class="text-button" data-id="reprobe">重新测速</button></div><div class="routes" data-id="routes">从可用地址中选择速度更快的线路。</div></div>
    </details>
    <div class="foot"><div class="summary"><span class="note">音视频体积</span><span class="total" data-id="total">—</span></div><div class="actions"><button class="secondary" data-id="refresh">重新解析</button><button class="secondary" data-id="cancel" hidden>取消</button><button class="primary" data-id="save-blob" hidden>保存 MP4</button><button class="primary" data-id="download" disabled>下载 MP4</button></div></div>
    <div class="status" data-id="status" role="status" aria-live="polite"></div>
    <div data-id="progress" hidden><div class="bar"><div data-id="bar"></div></div><div class="metrics"><span data-id="metrics-left"></span><span data-id="metrics-right"></span></div></div>
    <div class="error" data-id="error" role="alert" hidden></div>
  </section>`;
  const el=id=>shadow.querySelector(`[data-id="${id}"]`);
  const entry=doc.createElement('button');entry.id='bnd-download-entry';entry.type='button';entry.setAttribute('aria-expanded','false');entry.setAttribute('aria-controls',host.id);entry.setAttribute('aria-label','下载视频');
  entry.innerHTML=`${ICON}<span>下载</span>`;
  const entryStyle=doc.createElement('style');entryStyle.textContent=`#bnd-download-entry{display:inline-flex;align-items:center;justify-content:center;gap:7px;margin:0 0 0 24px;padding:0;border:0;background:transparent;color:var(--text2,#61666d);font:inherit;font-size:14px;line-height:28px;white-space:nowrap;cursor:pointer;vertical-align:middle;flex-shrink:0}#bnd-download-entry:hover,#bnd-download-entry[data-busy="true"],#bnd-download-entry[aria-expanded="true"]{color:var(--brand_blue,#00aeec)}#bnd-download-entry:focus-visible{outline:2px solid var(--brand_blue,#00aeec);outline-offset:4px;border-radius:3px}#bnd-download-entry svg{width:27px;height:27px} @media(max-width:1100px){#bnd-download-entry{margin-left:16px;gap:5px}}`;
  (doc.head||doc.documentElement).append(entryStyle);
  el('concurrency').value=String(concurrency);
  if(typeof pickDirectory!=='function') { el('save-mode').value='memory';el('save-mode').options[0].disabled=true; }

  const currentVideo=()=>manifest?.videos.find(v=>v.key===selectedKey);
  const currentAudio=()=>manifest?.audios.find(a=>a.key===audioKey)||null;
  function revokeBlob(){if(blobURL){win.URL.revokeObjectURL(blobURL);blobURL=null;}el('save-blob').hidden=true;}
  function setError(message=''){failMessage=message;el('error').textContent=message;el('error').hidden=!message;}
  function clearPrepared(){prepared?.video?.dispose();prepared?.audio?.dispose();prepared=null;}
  function cancelPreparation(){preparation?.abort();preparation=null;prepareSerial++;clearPrepared();}
  function updateControls(){
    const busy=!!activeJob;
    for(const id of ['audio','concurrency','save-mode','refresh','reprobe'])el(id).disabled=busy||!!analysisController;
    shadow.querySelectorAll('input[type=radio]').forEach(x=>x.disabled=busy);
    el('download').disabled=busy||!prepared||!!preparation||!!analysisController;
    el('download').hidden=!!blobURL;
    el('cancel').hidden=!busy;
    entry.dataset.busy=String(busy);entry.querySelector('span').textContent=busy?'下载中':'下载';
    el('status').textContent=activeJob?.label||prepStatus||savedStatus;
    el('status').classList.toggle('success',!!savedStatus&&!busy&&!prepStatus);
  }
  function renderRows(){
    const body=el('rows');body.replaceChildren();
    if(!manifest){el('empty').hidden=false;return;}
    el('empty').hidden=true;
    for(const v of manifest.videos){
      const tr=doc.createElement('tr');tr.classList.toggle('chosen',v.key===selectedKey);
      const cell=doc.createElement('td'),radio=doc.createElement('input');radio.type='radio';radio.name='bnd-quality';radio.value=v.key;radio.checked=v.key===selectedKey;radio.setAttribute('aria-label',`${v.label} ${v.codec}`);cell.append(radio);tr.append(cell);
      const quality=doc.createElement('td'),label=doc.createElement('span'),dims=doc.createElement('span');label.className='resolution';label.textContent=v.label;dims.className='dims';dims.textContent=`${v.width||'—'} × ${v.height||'—'}`;quality.append(label,dims);tr.append(quality);
      const cc=doc.createElement('td'),badge=doc.createElement('span');badge.className='codec';badge.textContent=v.codec;cc.append(badge);tr.append(cc);
      const frame=doc.createElement('td');const fps=String(v.frameRate??v.frame_rate??'—');if(fps.includes('/')){const [a,b]=fps.split('/').map(Number);frame.textContent=b?(a/b).toFixed(0):'—';}else frame.textContent=fps;tr.append(frame);
      const size=doc.createElement('td');size.className='size';size.dataset.sizeFor=v.key;
      size.textContent=`≈ ${C.bytes(v.estimate+(currentAudio()?.estimate||0))}`;tr.append(size);
      const choose=()=>{if(activeJob||selectedKey===v.key)return;selectedKey=v.key;revokeBlob();savedStatus='';renderRows();void prepareSelection();};
      radio.addEventListener('change',choose);tr.addEventListener('click',e=>{if(!activeJob&&e.target!==radio){radio.checked=true;choose();}});
      body.append(tr);
    }
    updateExactSize();updateControls();
  }
  function updateExactSize(){
    const v=currentVideo();
    if(!v)return;
    const exact=prepared?.selection===`${selectedKey}|${audioKey}`;
    const n=exact?prepared.video.size+(prepared.audio?.size||0):v.estimate+(currentAudio()?.estimate||0);
    el('total').textContent=`${exact?'':'≈ '}${C.bytes(n)}${exact?' · 已校验':''}`;
    const cell=[...shadow.querySelectorAll('[data-size-for]')].find(x=>x.dataset.sizeFor===selectedKey);
    if(cell&&exact)cell.textContent=C.bytes(n);
  }
  function routeSummary(){
    if(!prepared)return;
    const texts=[];
    for(const [source,label] of [[prepared.video,'视频'],[prepared.audio,'音频']]){
      if(!source)continue;
      const good=source.routes.filter(x=>!x.quarantined).sort((a,b)=>b.speed-a.speed);
      const best=good[0];if(best)texts.push(`${label}：${best.hostname} · 探测 ${C.bytes(best.speed)}/s · ${good.length} 条可用线路`);
    }
    el('routes').textContent=texts.join('\n');el('routes').style.whiteSpace='pre-line';
  }
  async function prepareSelection({refresh=false}={}){
    if(disposed||activeJob||!manifest||!meta)return;
    cancelPreparation();setError();savedStatus='';
    const controller=new AbortController();preparation=controller;const serial=++prepareSerial;
    const v=currentVideo(),a=currentAudio();if(!v){preparation=null;return;}
    prepStatus='正在校验文件大小和测试 CDN 线路…';updateControls();updateExactSize();
    let video=null,audio=null;
    try{
      if(refresh){
        const fresh=C.normalizePlay(await network.getPlay(meta,{signal:controller.signal,qn:v.id}));
        const freshV=fresh.videos.find(x=>x.key===v.key),freshA=a?fresh.audios.find(x=>x.key===a.key):null;
        if(!freshV||(a&&!freshA))throw new Error('播放接口返回的画质或音轨已变化，请重新解析后选择。');
        Object.assign(v,freshV);if(a)Object.assign(a,freshA);
      }
      const limiter=range.createLimiter(concurrency);
      // Sequential initialization avoids leaving one source alive after its peer fails.
      video=await range.buildSource({urls:v.urls,concurrency,limiter,signal:controller.signal,onRoute:r=>{if(activeJob)activeJob.route=`视频：${r.hostname}${r.reason==='failover'?'（已切换备用）':''}`;}});
      if(a)audio=await range.buildSource({urls:a.urls,concurrency,limiter,signal:controller.signal,onRoute:r=>{if(activeJob)activeJob.audioRoute=`音频：${r.hostname}`;}});
      if(controller.signal.aborted||serial!==prepareSerial)throw new DOMException('操作已取消','AbortError');
      prepared={video,audio,controller,selection:`${selectedKey}|${audioKey}`,time:Date.now()};
      prepStatus=manifest.silent?'已就绪 · 原视频没有音轨':'已就绪 · 下载后自动合成带声音的 MP4';routeSummary();updateExactSize();
    }catch(error){video?.dispose();audio?.dispose();if(!controller.signal.aborted&&serial===prepareSerial){prepStatus='';setError(C.safeError(error));}}
    finally{if(serial===prepareSerial){preparation=null;updateControls();}}
  }
  async function analyze(){
    if(disposed||activeJob)return;
    const serial=++sessionSerial;analysisController?.abort();cancelPreparation();revokeBlob();
    const controller=new AbortController();analysisController=controller;manifest=null;meta=null;setError();savedStatus='';prepStatus='正在解析当前视频…';
    el('empty').textContent='正在读取视频信息和可用清晰度…';el('progress').hidden=true;el('total').textContent='—';renderRows();updateControls();
    try{
      const href=win.location.href;analysisIdentity=C.pageIdentity(href).key;
      const resolved=await network.getMeta(href,controller.signal);
      const parsed=C.normalizePlay(await network.getPlay(resolved,{signal:controller.signal}));
      if(controller.signal.aborted||serial!==sessionSerial)return;
      if(C.pageIdentity(win.location.href).key!==resolved.identity)throw new Error('页面已切换，请点击“重新解析”。');
      meta=resolved;manifest=parsed;selectedKey=parsed.videos[0].key;audioKey=parsed.audios[0]?.key||'';
      el('title').textContent=`${meta.title}${meta.pageCount>1?` · P${meta.page} ${meta.part}`:''}`;el('title').title=el('title').textContent;
      el('audio').replaceChildren();
      for(const a of parsed.audios){const o=doc.createElement('option');o.value=a.key;o.textContent=`AAC · ${Math.round(a.bandwidth/1000)} kbps`;el('audio').append(o);}
      if(!parsed.audios.length){const o=doc.createElement('option');o.value='';o.textContent='原视频无音轨';el('audio').append(o);}
      el('audio').value=audioKey;
      const restrictions=parsed.advertised.length?` 接口未提供：${parsed.advertised.join('、')}。`:'';
      const unsupported=parsed.unsupported?.length?` ${parsed.unsupported.join('；')}。`:'';
      el('quality-hint').textContent='≈ 为码率估算；选中后校验准确体积。'+restrictions+unsupported;
      analysisController=null;renderRows();await prepareSelection();
    }catch(error){if(!controller.signal.aborted&&serial===sessionSerial){prepStatus='';el('empty').textContent='视频解析未完成';setError(C.safeError(error));}}
    finally{if(serial===sessionSerial){analysisController=null;updateControls();}}
  }
  async function download(){
    if(disposed||activeJob||!prepared||!meta)return;
    const pack=prepared,v=currentVideo(),fileMeta=meta,memory=el('save-mode').value==='memory';
    const newName=()=>C.filename(fileMeta,v,createDownloadTag({crypto:win.crypto}));
    let name='';
    const total=pack.video.size+(pack.audio?.size||0);
    if(Date.now()-pack.time>180000){prepStatus='地址已刷新，请完成测速后再点击下载。';void prepareSelection({refresh:true});return;}
    if(memory&&total>248*MiB){setError('选定音视频超过内存下载上限，请选择“直接写入磁盘”。');return;}
    setError();savedStatus='';prepStatus='';revokeBlob();el('progress').hidden=true;
    const controller=new AbortController();let target=null,engineOwnsTarget=false,stopSource=null,keepPrepared=false,phase=memory?'memory':'picker';const job={controller,label:memory?'准备下载…':'请选择保存文件夹…',route:'',audioRoute:'',started:Date.now(),lastBytes:0,lastTime:Date.now(),speed:0,output:0,percent:0};
    activeJob=job;updateControls();
    try{
      // This call MUST precede every await: the browser needs the click's activation.
      const picked=memory?null:pickDirectory({id:'bnd-downloads',mode:'readwrite'});
      if(memory){name=newName();target=C.memoryTarget();}
      else{
        const directory=await picked;phase='target';
        if(controller.signal.aborted)throw new DOMException('操作已取消','AbortError');
        target=await createSafeFileTarget(directory,newName,{signal:controller.signal});name=target.name;
      }
      if(controller.signal.aborted)throw new DOMException('操作已取消','AbortError');
      stopSource=()=>pack.controller.abort();controller.signal.addEventListener('abort',stopSource,{once:true});
      job.label='下载并合成 MP4…';job.started=Date.now();job.lastTime=Date.now();job.lastBytes=pack.video.stats.downloadedBytes+(pack.audio?.stats.downloadedBytes||0);
      el('progress').hidden=false;el('bar').style.width='0%';updateControls();
      tickTimer=win.setInterval(()=>{
        if(activeJob!==job)return;
        const now=Date.now(),count=pack.video.stats.downloadedBytes+(pack.audio?.stats.downloadedBytes||0),dt=(now-job.lastTime)/1000;
        if(dt>0){const speed=(count-job.lastBytes)/dt;job.speed=job.speed*.5+speed*.5;job.lastBytes=count;job.lastTime=now;}
        el('metrics-left').textContent=`${C.bytes(job.speed)}/s · 已写入 ${C.bytes(job.output)}`;
        el('metrics-right').textContent=`${job.percent}% · ${Math.floor((now-job.started)/1000)} 秒`;
        if(job.route)el('routes').textContent=[job.route,job.audioRoute].filter(Boolean).join('\n');
      },500);
      engineOwnsTarget=true;phase='mux';
      const result=await media.muxToTarget({videoSource:pack.video,audioSource:pack.audio,target,signal:controller.signal,onProgress:p=>{
        job.output=p.outputBytes||0;job.percent=p.stage==='done'?100:Math.min(99,Math.max(job.percent,Math.floor((p.seconds||0)/(p.duration||manifest.duration||1)*100)));
        job.label=p.stage==='finalizing'?'正在写入 MP4 索引…':p.stage==='inspecting'?'正在检查音视频轨道…':'下载并合成 MP4…';
        el('bar').style.width=`${job.percent}%`;el('status').textContent=job.label;
      }});
      if((controller.signal.aborted&&!target.committed)||disposed)throw new DOMException('操作已取消','AbortError');
      el('bar').style.width='100%';el('metrics-left').textContent=`文件大小 ${C.bytes(result.outputBytes)}`;el('metrics-right').textContent=`完成 · ${Math.floor((Date.now()-job.started)/1000)} 秒`;
      if(memory){const blob=target.getBlob();if(!blob)throw new Error('内存文件生成失败。');blobURL=win.URL.createObjectURL(blob);el('save-blob').hidden=false;el('save-blob').onclick=()=>{const link=doc.createElement('a');link.href=blobURL;link.download=name;doc.body.append(link);link.click();link.remove();};savedStatus='下载完成，点击“保存 MP4”保存文件。';}
      else savedStatus=`已保存：${name}`;
    }catch(error){if(!engineOwnsTarget&&target){try{await target.abort(error);}catch{}}
      const cancelled=controller.signal.aborted||(phase==='picker'&&error?.name==='AbortError');
      if(cancelled)savedStatus='下载已取消。';
      else{
        setError(C.safeError(!memory&&phase!=='mux'?saveError(error):error));
        // A failed directory/target setup has not consumed the media. A fresh
        // click may choose another directory without reparsing or re-probing.
        keepPrepared=!engineOwnsTarget&&!disposed&&!pack.controller.signal.aborted;
        prepStatus=keepPrepared?'未开始下载。请再次点击“下载 MP4”重试。':'下载未完成，请点击“重新解析”后重试。';
      }
    }finally{
      if(stopSource)controller.signal.removeEventListener('abort',stopSource);
      if(tickTimer)win.clearInterval(tickTimer);tickTimer=null;
      if(!keepPrepared){clearPrepared();pack.controller.abort();}activeJob=null;updateControls();
      // A new click is required before another network operation or file save.
      if(!blobURL)el('download').textContent='下载 MP4';
    }
  }
  function open(){
    if(disposed)return;
    mount();host.hidden=false;entry.setAttribute('aria-expanded','true');
    if(activeJob){updateControls();return;}
    let pageKey='';try{pageKey=C.pageIdentity(win.location.href).key;}catch{}
    if(analysisController&&!analysisController.signal.aborted&&analysisIdentity===pageKey)return;
    const same=meta?.identity===pageKey;
    // Keep completed/cancelled status visible when the user unfolds the panel.
    if(!same||!manifest)void analyze();else if(!prepared&&!blobURL&&!savedStatus&&(!preparation||preparation.signal.aborted))void prepareSelection({refresh:true});
  }
  function close(){host.hidden=true;entry.setAttribute('aria-expanded','false');}
  entry.addEventListener('click',()=>host.hidden?open():close());
  el('close').addEventListener('click',()=>{close();entry.focus();});
  el('refresh').addEventListener('click',()=>void analyze());el('reprobe').addEventListener('click',()=>void prepareSelection({refresh:true}));
  el('audio').addEventListener('change',()=>{audioKey=el('audio').value;revokeBlob();renderRows();void prepareSelection();});
  el('concurrency').addEventListener('change',()=>{concurrency=Number(el('concurrency').value);try{setValue?.('bnd.concurrent',concurrency);}catch{}void prepareSelection();});
  el('download').addEventListener('click',()=>void download());el('cancel').addEventListener('click',()=>{if(activeJob){activeJob.label='正在取消…';activeJob.controller.abort();updateControls();}});
  let mountedToolbar=null,mountedAfter=null;
  function isMounted(){return entry.isConnected&&host.isConnected&&mountedAfter?.isConnected&&entry.parentElement===mountedToolbar&&mountedAfter.nextElementSibling===host;}
  function mount(){
    if(disposed)return;
    const toolbar=doc.querySelector('.video-toolbar-left-main')||doc.querySelector('.video-toolbar-left')||doc.querySelector('.video-toolbar-container');
    if(!toolbar)return;
    // The toolbar can exist in server-rendered HTML before Bilibili's Vue app
    // hydrates it. Adding children then invalidates hydration and mounts the
    // site's header twice, leaving its container empty. Vue removes this marker
    // synchronously during hydration; the observer below runs after it finishes.
    if(toolbar.closest('[data-server-rendered]'))return;
    const anchor=toolbar.closest('.video-toolbar-container')||toolbar.closest('.video-toolbar-left')||toolbar;
    if(entry.parentElement!==toolbar)toolbar.append(entry);
    if(anchor.parentElement&&(host.parentElement!==anchor.parentElement||anchor.nextElementSibling!==host))anchor.after(host);
    mountedToolbar=toolbar;mountedAfter=anchor;
  }
  const observer=new win.MutationObserver(()=>{if(!isMounted()&&!mountTimer)mountTimer=win.setTimeout(()=>{mountTimer=null;mount();},100);});
  observer.observe(doc.body||doc.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-server-rendered']});mount();
  const routeTimer=win.setInterval(()=>{if(lastHref!==win.location.href){lastHref=win.location.href;if(!activeJob&&!host.hidden)void analyze();else if(!activeJob){analysisController?.abort();cancelPreparation();meta=null;manifest=null;}}},1000);
  const beforeUnload=e=>{if(activeJob){e.preventDefault();e.returnValue='';}};
  win.addEventListener('beforeunload',beforeUnload);
  try{menu?.('下载当前 B站视频',open);}catch{}
  return {open,close,shadow,entry,getState:()=>({meta,manifest,prepared,activeJob,preparation,failMessage}),dispose(){disposed=true;analysisController?.abort();activeJob?.controller.abort();cancelPreparation();observer.disconnect();win.clearInterval(routeTimer);win.clearInterval(tickTimer);win.clearTimeout(mountTimer);revokeBlob();win.removeEventListener('beforeunload',beforeUnload);entry.remove();entryStyle.remove();host.remove();}};
}

module.exports={startBiliDownloader};
