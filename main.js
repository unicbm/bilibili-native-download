'use strict';

function startBiliDownloader({ win, doc, network, media, core, range, getValue, setValue, menu } = {}) {
  const C=core;
  const MiB=1024*1024;
  const ICON='<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 3v12m-4.5-4.5L12 15l4.5-4.5M4 15.5v3A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let meta=null, manifest=null, selectedKey='', audioKey='', preparation=null, prepared=null;
  let analysisController=null, activeJob=null, disposed=false, sessionSerial=0, prepareSerial=0;
  let blobURL=null, lastHref=win.location.href, tickTimer=null, mountTimer=null;
  let previousFocus=null, prepStatus='', savedStatus='', failMessage='';
  let concurrency=4;
  try { const n=Number(getValue?.('bnd.concurrent',4)); if([1,2,4,6,8].includes(n))concurrency=n; } catch { /* defaults */ }
  const host=doc.createElement('div');host.id='bnd-panel-host';
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>
    :host{font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color-scheme:light dark;--bg:#fff;--text:#18191c;--muted:#61666d;--line:#e3e5e7;--soft:#f6f7f8;--blue:#00aeec;--blue-bg:#e8f8ff;--red:#b42318;--green:#178653}
    *{box-sizing:border-box}button,input,select{font:inherit}button,select{cursor:pointer}button:disabled,select:disabled,input:disabled{cursor:default;opacity:.5}
    dialog{position:fixed;inset:0;width:min(760px,calc(100vw - 32px));max-height:calc(100vh - 40px);margin:auto;padding:0;border:1px solid var(--line);border-radius:16px;color:var(--text);background:var(--bg);box-shadow:0 16px 72px #0003;font-size:14px;line-height:1.5;overflow:auto}
    dialog::backdrop{background:#0005;backdrop-filter:blur(2px)}
    .head{display:flex;align-items:center;justify-content:space-between;padding:22px 26px 14px;gap:16px}.heading{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600}.heading svg{color:var(--blue);width:24px;height:24px}.close{border:0;background:transparent;color:var(--muted);font-size:25px;width:32px;height:32px;border-radius:6px;line-height:1}
    .close:hover{background:var(--soft)}.body{padding:0 26px 24px}.title{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0 0 16px}.subhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0 10px;font-weight:600}.badge{font-size:12px;font-weight:400;color:var(--muted);background:var(--soft);padding:3px 8px;border-radius:4px}
    .table-wrap{max-height:252px;overflow:auto;border:1px solid var(--line);border-radius:9px}table{border-collapse:collapse;width:100%;font-size:13px}thead{position:sticky;top:0;background:var(--soft);z-index:1}th{text-align:left;font-weight:400;color:var(--muted);padding:10px 12px}td{padding:10px 12px;border-top:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{width:35px;padding-right:0}tr.chosen{background:var(--blue-bg)}tbody tr:hover{background:var(--soft)}tbody tr.chosen:hover{background:var(--blue-bg)}input[type=radio]{accent-color:var(--blue);margin:0;cursor:pointer}.resolution{font-weight:600}.dims{display:block;color:var(--muted);font-size:11px}.codec{border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:11px}.size{text-align:right;font-variant-numeric:tabular-nums}
    .settings{display:grid;grid-template-columns:1.35fr .65fr;gap:14px;margin-top:16px}.field{display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px}select{width:100%;height:36px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);padding:0 10px;outline-offset:2px}.save-field{margin-top:12px}.hint{font-size:12px;color:var(--muted);margin:8px 0 0}.note{color:var(--muted);font-size:12px;line-height:1.6}.linebox{background:var(--soft);border-radius:9px;padding:12px 14px;margin:16px 0 0}.line-title{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px}.text-button{border:0;background:transparent;color:var(--blue);padding:2px;font-size:12px}.routes{font-size:11px;color:var(--muted);margin:8px 0 0;overflow-wrap:anywhere;line-height:1.7}.total{font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}.status{margin-top:14px;font-size:13px;min-height:20px}.error{color:var(--red);background:#ffebe8;border-radius:7px;padding:10px 12px;font-size:13px;margin-top:12px;white-space:pre-wrap}.success{color:var(--green)}.bar{height:5px;border-radius:5px;overflow:hidden;background:var(--line);margin:9px 0}.bar>div{height:100%;width:0;background:var(--blue);transition:width .15s}.metrics{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}.foot{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:20px}.actions{display:flex;gap:8px;flex-shrink:0}.primary,.secondary{min-height:38px;border-radius:7px;padding:7px 17px;font-weight:500;font-size:14px}.primary{background:var(--blue);border:1px solid var(--blue);color:#fff}.primary:hover:enabled{filter:brightness(1.06)}.secondary{background:var(--bg);color:var(--muted);border:1px solid var(--line)}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--blue);outline-offset:3px}.empty{padding:28px 8px;color:var(--muted);text-align:center}[hidden]{display:none!important}
    @media(prefers-color-scheme:dark){:host{--bg:#202124;--text:#e8e8ec;--muted:#a4a8ad;--line:#3a3d42;--soft:#292c30;--blue-bg:#173947;--red:#ffb4aa;--green:#7cddb0}.error{background:#4c2421}}
    @media(max-width:560px){.head{padding:18px 16px 10px}.body{padding:0 16px 18px}.heading{font-size:18px}.settings{grid-template-columns:1fr 1fr}.foot{align-items:flex-end}.foot .note{max-width:45%}th,td{padding:9px 7px}.dims{font-size:10px}.codec{font-size:10px}.metrics{flex-wrap:wrap}}
  </style>
  <dialog aria-labelledby="bnd-heading">
    <div class="head"><div class="heading" id="bnd-heading">${ICON}<span>下载视频</span></div><button class="close" data-id="close" aria-label="关闭下载面板" title="关闭">×</button></div>
    <div class="body">
      <p class="title" data-id="title">正在读取当前视频…</p>
      <div class="subhead"><span>选择画质</span><span class="badge" data-id="session">当前浏览器会话</span></div>
      <div class="table-wrap"><table><thead><tr><th></th><th>清晰度</th><th>编码</th><th>帧率</th><th class="size">音视频体积</th></tr></thead><tbody data-id="rows"></tbody></table><div class="empty" data-id="empty">解析中…</div></div>
      <p class="hint" data-id="quality-hint">≈ 为码率估算；选中后读取文件头，获取准确体积。</p>
      <div class="settings">
        <label class="field">音轨<select data-id="audio" aria-label="音轨"></select></label>
        <label class="field">下载并发<select data-id="concurrency" aria-label="下载并发"><option value="1">1 路</option><option value="2">2 路</option><option value="4">4 路 · 默认</option><option value="6">6 路</option><option value="8">8 路</option></select></label>
      </div>
      <label class="field save-field">保存方式<select data-id="save-mode" aria-label="保存方式"><option value="disk">直接写入磁盘 · 适合长视频</option><option value="memory">内存下载 · 最大 256 MiB</option></select></label>
      <div class="linebox"><div class="line-title"><span>CDN 自动选线</span><button class="text-button" data-id="reprobe">重新测速</button></div><div class="routes" data-id="routes">从播放接口提供的地址中选择，每条线路最多测速 256 KiB。</div><div class="line-title" style="margin-top:9px"><span class="note">选定音视频</span><span class="total" data-id="total">—</span></div></div>
      <div class="status" data-id="status" role="status" aria-live="polite"></div>
      <div data-id="progress" hidden><div class="bar"><div data-id="bar"></div></div><div class="metrics"><span data-id="metrics-left"></span><span data-id="metrics-right"></span></div></div>
      <div class="error" data-id="error" role="alert" hidden></div>
      <div class="foot"><div class="note">MP4 · 本地无损合成<br>自动沿用当前登录权限</div><div class="actions"><button class="secondary" data-id="refresh">重新解析</button><button class="secondary" data-id="cancel" hidden>取消</button><button class="primary" data-id="save-blob" hidden>保存 MP4</button><button class="primary" data-id="download" disabled>下载 MP4</button></div></div>
    </div>
  </dialog>`;
  doc.documentElement.append(host);
  const el=id=>shadow.querySelector(`[data-id="${id}"]`);
  const dialog=shadow.querySelector('dialog');
  const entry=doc.createElement('button');entry.id='bnd-download-entry';entry.type='button';entry.setAttribute('aria-haspopup','dialog');entry.setAttribute('aria-label','下载视频');
  entry.innerHTML=`${ICON}<span>下载</span>`;
  const entryStyle=doc.createElement('style');entryStyle.textContent=`#bnd-download-entry{display:inline-flex;align-items:center;justify-content:center;gap:7px;margin:0 0 0 24px;padding:0;border:0;background:transparent;color:var(--text2,#61666d);font:14px/28px "PingFang SC",HarmonyOS_Regular,"Microsoft YaHei",sans-serif;white-space:nowrap;cursor:pointer;vertical-align:middle;flex-shrink:0}#bnd-download-entry:hover,#bnd-download-entry[data-busy="true"]{color:var(--brand_blue,#00aeec)}#bnd-download-entry:focus-visible{outline:2px solid #00aeec;outline-offset:4px;border-radius:3px}#bnd-download-entry svg{width:27px;height:27px} @media(max-width:1100px){#bnd-download-entry{margin-left:16px;gap:5px}}`;
  doc.documentElement.append(entryStyle);
  el('concurrency').value=String(concurrency);
  if(typeof win.showSaveFilePicker!=='function') { el('save-mode').value='memory';el('save-mode').options[0].disabled=true; }

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
      const href=win.location.href;
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
    const pack=prepared,v=currentVideo(),name=C.filename(meta,v),memory=el('save-mode').value==='memory';
    const total=pack.video.size+(pack.audio?.size||0);
    if(Date.now()-pack.time>180000){prepStatus='地址已刷新，请完成测速后再点击下载。';void prepareSelection({refresh:true});return;}
    if(memory&&total>248*MiB){setError('选定音视频超过内存下载上限，请选择“直接写入磁盘”。');return;}
    setError();savedStatus='';prepStatus='';revokeBlob();
    const controller=new AbortController();let target=null,engineOwnsTarget=false,stopSource=null;const job={controller,label:memory?'准备下载…':'请选择保存位置…',route:'',audioRoute:'',started:Date.now(),lastBytes:0,lastTime:Date.now(),speed:0,output:0,percent:0};
    activeJob=job;updateControls();
    try{
      // This call MUST precede every await: the browser needs the click's activation.
      const picked=memory?null:win.showSaveFilePicker({suggestedName:name,types:[{description:'MP4 视频',accept:{'video/mp4':['.mp4']}}]});
      if(memory)target=C.memoryTarget();else{const handle=await picked;if(controller.signal.aborted)throw new DOMException('操作已取消','AbortError');target=await handle.createWritable();}
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
      engineOwnsTarget=true;
      const result=await media.muxToTarget({videoSource:pack.video,audioSource:pack.audio,target,signal:controller.signal,onProgress:p=>{
        job.output=p.outputBytes||0;job.percent=p.stage==='done'?100:Math.min(99,Math.max(job.percent,Math.floor((p.seconds||0)/(p.duration||manifest.duration||1)*100)));
        job.label=p.stage==='finalizing'?'正在写入 MP4 索引…':p.stage==='inspecting'?'正在检查音视频轨道…':'下载并合成 MP4…';
        el('bar').style.width=`${job.percent}%`;el('status').textContent=job.label;
      }});
      if(controller.signal.aborted||disposed)throw new DOMException('操作已取消','AbortError');
      el('bar').style.width='100%';el('metrics-left').textContent=`文件大小 ${C.bytes(result.outputBytes)}`;el('metrics-right').textContent=`完成 · ${Math.floor((Date.now()-job.started)/1000)} 秒`;
      if(memory){const blob=target.getBlob();if(!blob)throw new Error('内存文件生成失败。');blobURL=win.URL.createObjectURL(blob);el('save-blob').hidden=false;el('save-blob').onclick=()=>{const link=doc.createElement('a');link.href=blobURL;link.download=name;doc.body.append(link);link.click();link.remove();};savedStatus='下载完成，点击“保存 MP4”保存文件。';}
      else savedStatus=`已保存：${name}`;
    }catch(error){if(!engineOwnsTarget&&target){try{await target.abort(error);}catch{}}
      if(error?.name==='AbortError'||controller.signal.aborted)savedStatus='下载已取消。';else setError(C.safeError(error));
    }finally{
      if(stopSource)controller.signal.removeEventListener('abort',stopSource);
      if(tickTimer)win.clearInterval(tickTimer);tickTimer=null;
      clearPrepared();pack.controller.abort();activeJob=null;updateControls();
      // A new click is required before another network operation or file save.
      if(!blobURL)el('download').textContent='下载 MP4';
    }
  }
  function open(){
    if(disposed)return;
    previousFocus=doc.activeElement;if(!dialog.open)dialog.showModal();
    if(activeJob){updateControls();return;}
    let same=false;try{same=meta?.identity===C.pageIdentity(win.location.href).key;}catch{}
    if(!same||!manifest)void analyze();else if(!prepared&&!blobURL)void prepareSelection({refresh:true});
  }
  function close(){dialog.close();previousFocus?.focus?.();}
  entry.addEventListener('click',open);el('close').addEventListener('click',close);
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
  el('refresh').addEventListener('click',()=>void analyze());el('reprobe').addEventListener('click',()=>void prepareSelection({refresh:true}));
  el('audio').addEventListener('change',()=>{audioKey=el('audio').value;revokeBlob();renderRows();void prepareSelection();});
  el('concurrency').addEventListener('change',()=>{concurrency=Number(el('concurrency').value);try{setValue?.('bnd.concurrent',concurrency);}catch{}void prepareSelection();});
  el('download').addEventListener('click',()=>void download());el('cancel').addEventListener('click',()=>{if(activeJob){activeJob.label='正在取消…';activeJob.controller.abort();updateControls();}});
  function mount(){
    if(disposed||entry.isConnected)return;
    const toolbar=doc.querySelector('.video-toolbar-left-main')||doc.querySelector('.video-toolbar-left')||doc.querySelector('.video-toolbar-container');
    if(toolbar)toolbar.append(entry);
  }
  const observer=new win.MutationObserver(()=>{if(!entry.isConnected&&!mountTimer)mountTimer=win.setTimeout(()=>{mountTimer=null;mount();},100);});
  observer.observe(doc.body||doc.documentElement,{childList:true,subtree:true});mount();
  const routeTimer=win.setInterval(()=>{if(lastHref!==win.location.href){lastHref=win.location.href;if(!activeJob&&dialog.open)void analyze();else if(!activeJob){analysisController?.abort();cancelPreparation();meta=null;manifest=null;}}},1000);
  const beforeUnload=e=>{if(activeJob){e.preventDefault();e.returnValue='';}};
  win.addEventListener('beforeunload',beforeUnload);
  try{menu?.('下载当前 B站视频',open);}catch{}
  return {open,close,shadow,entry,getState:()=>({meta,manifest,prepared,activeJob,preparation,failMessage}),dispose(){disposed=true;analysisController?.abort();activeJob?.controller.abort();cancelPreparation();observer.disconnect();win.clearInterval(routeTimer);win.clearInterval(tickTimer);win.clearTimeout(mountTimer);revokeBlob();win.removeEventListener('beforeunload',beforeUnload);entry.remove();entryStyle.remove();host.remove();}};
}

module.exports={startBiliDownloader};
