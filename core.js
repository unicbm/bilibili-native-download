'use strict';

/** Small, dependency-free helpers for the Bilibili userscript. */
function createBiliCore() {
  const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
  const CDN_DOMAINS = ['bilivideo.com','bilivideo.cn','bilivideo.net','akamaized.net','bcache.com','szbdyd.com'];
  const LABELS = {6:'240P',16:'360P 流畅',32:'480P 清晰',64:'720P 高清',74:'720P 60帧',80:'1080P 高清',112:'1080P 高码率',116:'1080P 60帧',120:'4K 超清',125:'HDR 真彩',126:'杜比视界',127:'8K 超高清'};

  // RFC 1321. The input is UTF-8; used only for the site's public WBI signature.
  function md5(text) {
    const bytes = new TextEncoder().encode(text);
    const len = ((bytes.length + 8) >>> 6) + 1;
    const buf = new Uint8Array(len * 64);
    buf.set(bytes); buf[bytes.length] = 128;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 8, (bytes.length * 8) >>> 0, true);
    dv.setUint32(buf.length - 4, Math.floor(bytes.length / 0x20000000), true);
    const s = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
    const k = Array.from({length:64},(_,i)=>(Math.abs(Math.sin(i+1))*0x100000000)|0);
    let a0=0x67452301, b0=0xefcdab89|0, c0=0x98badcfe|0, d0=0x10325476;
    for(let off=0;off<buf.length;off+=64) {
      let a=a0,b=b0,c=c0,d=d0;
      for(let i=0;i<64;i++) {
        let f,g;
        if(i<16){ f=(b&c)|(~b&d);g=i; }
        else if(i<32){ f=(d&b)|(~d&c);g=(5*i+1)%16; }
        else if(i<48){ f=b^c^d;g=(3*i+5)%16; }
        else { f=c^(b|~d);g=(7*i)%16; }
        const sum=(a+f+k[i]+dv.getInt32(off+g*4,true))|0;
        const shift=s[(i>>>4)*4+(i%4)];
        const next=(b+((sum<<shift)|(sum>>>(32-shift))))|0;
        a=d;d=c;c=b;b=next;
      }
      a0=(a0+a)|0;b0=(b0+b)|0;c0=(c0+c)|0;d0=(d0+d)|0;
    }
    return [a0,b0,c0,d0].flatMap(n=>[0,8,16,24].map(shift=>((n>>>shift)&255).toString(16).padStart(2,'0'))).join('');
  }
  function mixinKey(img, sub) {
    const key = u => new URL(u).pathname.split('/').pop().split('.')[0];
    const raw = key(img)+key(sub);
    if(raw.length!==64) throw new Error('B站签名密钥格式已变化，请更新脚本。');
    return MIXIN.map(i=>raw[i]).join('').slice(0,32);
  }
  function signWbi(params,key,now=Math.round(Date.now()/1000)) {
    const p={...params,wts:now};
    const query=Object.keys(p).sort().map(k=>`${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g,''))}`).join('&');
    return `${query}&w_rid=${md5(query+key)}`;
  }
  function safeMediaURL(raw) {
    try {
      const u=new URL(raw);
      if(u.protocol!=='https:' || u.username || u.password) return null;
      if(!CDN_DOMAINS.some(d=>u.hostname===d||u.hostname.endsWith(`.${d}`))) return null;
      return u.href;
    } catch { return null; }
  }
  function streamURLs(s) {
    const backup=s.backupUrl??s.backup_url??[];
    return [...new Set([s.baseUrl??s.base_url,...(Array.isArray(backup)?backup:[])].map(safeMediaURL).filter(Boolean))];
  }
  function codecName(s) {
    if(/^avc[13]/i.test(s.codecs)||s.codecid===7) return 'H.264';
    if(/^(hev1|hvc1)/i.test(s.codecs)||s.codecid===12) return 'HEVC';
    if(/^av01/i.test(s.codecs)||s.codecid===13) return 'AV1';
    if(/^mp4a/i.test(s.codecs)) return 'AAC';
    return s.codecs||'未知编码';
  }
  function streamKey(s) { return `${s.id}:${s.codecid??''}:${s.codecs??''}:${s.width??''}x${s.height??''}`; }
  function normalizePlay(data) {
    if(data?.is_drm || data?.drm_tech_type) throw new Error('这个视频返回了加密媒体，当前脚本不支持。');
    if(!data?.dash?.video?.length) {
      if(data?.durl?.length) throw new Error('本站为这个视频返回了旧版分段格式。本版支持普通视频的 DASH 流，请更换视频或稍后重试。');
      throw new Error('当前会话没有获得可下载的视频流，请确认网页可以正常播放。');
    }
    const labels=new Map((data.support_formats||[]).map(x=>[x.quality,x.new_description||x.display_desc||x.description]));
    const duration=Number(data.dash.duration)||(Number(data.timelength)/1000)||0;
    // Dolby Vision carries extra metadata that the browser remux path does not
    // preserve yet. Do not advertise it as a valid lossless MP4 output.
    const isDolbyVision=s=>Number(s.id)===126||/^(dvh1|dvhe)\./i.test(s.codecs||'');
    const unsupported=data.dash.video.filter(isDolbyVision).length?['杜比视界：本版不保留杜比元数据，暂不支持下载。']:[];
    const seen=new Set();
    const videos=data.dash.video.map(s=>({...s,urls:streamURLs(s),key:streamKey(s),codec:codecName(s),label:labels.get(s.id)||LABELS[s.id]||`${s.height||'?'}P`,estimate:Math.ceil((Number(s.bandwidth)||0)*duration/8)}))
      .filter(s=>{if(isDolbyVision(s)||!s.urls.length||!['H.264','HEVC','AV1'].includes(s.codec)||seen.has(s.key))return false;seen.add(s.key);return true;})
      .sort((a,b)=>b.id-a.id||(['H.264','HEVC','AV1'].indexOf(a.codec)-['H.264','HEVC','AV1'].indexOf(b.codec))||b.bandwidth-a.bandwidth);
    const allAudio=[...(data.dash.audio||[]),...(data.dash.dolby?.audio||[]),...(data.dash.flac?.audio?[data.dash.flac.audio]:[])];
    const audioSeen=new Set();
    const audios=allAudio.filter(s=>/^mp4a\./i.test(s.codecs||''))
      .map(s=>({...s,key:streamKey(s),urls:streamURLs(s),estimate:Math.ceil((Number(s.bandwidth)||0)*duration/8)}))
      .filter(s=>{if(!s.urls.length||audioSeen.has(s.key))return false;audioSeen.add(s.key);return true;})
      .sort((a,b)=>b.bandwidth-a.bandwidth);
    if(!videos.length) throw new Error(unsupported.length?unsupported.join(' '):'未找到受支持的视频编码或 HTTPS CDN 地址。');
    if(allAudio.length&&!audios.length) throw new Error('视频只有杜比或无损音轨。本版 MP4 合成需要 AAC 音轨。');
    return {videos,audios,duration,silent:allAudio.length===0,unsupported,advertised:(data.support_formats||[]).filter(f=>Number(f.quality)!==126&&!videos.some(v=>v.id===f.quality)).map(f=>f.new_description||f.description||LABELS[f.quality]||String(f.quality))};
  }
  function pageIdentity(href) {
    const u=new URL(href);
    const match=u.pathname.match(/^\/video\/(BV[0-9a-zA-Z]+|av\d+)/);
    if(!match) throw new Error('请在普通 B站视频页面打开下载。');
    const rawP=u.searchParams.get('p')||'1';
    const p=Number(rawP);
    if(!Number.isSafeInteger(p)||p<1) throw new Error('当前分P参数无效。');
    return {id:match[1],p,key:`${match[1]}:p${p}`};
  }
  function selectPage(view,identity) {
    const pages=view.pages||[];
    const page=pages.find(p=>Number(p.page)===identity.p);
    if(!page || !Number.isSafeInteger(Number(page.cid)) || Number(page.cid)<=0) throw new Error('找不到当前分P，已停止解析以免下载到其他分P。');
    return {bvid:view.bvid,aid:view.aid,cid:Number(page.cid),page:identity.p,pageCount:pages.length,title:view.title||'Bilibili',part:page.part||'',duration:page.duration||0,identity:identity.key};
  }
  function filename(meta,video,tag='') {
    const encoder=new TextEncoder();
    const clean=s=>String(s??'').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').replace(/[. ]+$/g,'').trim();
    // A component must fit both Windows UTF-16 limits and common 255-byte
    // UTF-8 filesystems. Reserve 15 bytes of headroom; keep code points intact.
    const cut=(s,budget)=>{let result='',used=0;for(const ch of s){const n=encoder.encode(ch).length;if(used+n>budget)break;result+=ch;used+=n;}return result.replace(/[. ]+$/g,'');};
    const suffix=`_${cut(clean(meta.bvid)||'Bilibili',24)}_P${Number.isSafeInteger(meta.page)&&meta.page>0?meta.page:1}_${cut(clean(video.label)||'video',64)}_${cut(clean(video.codec)||'codec',16)}${tag?'_'+cut(clean(tag),64):''}.mp4`;
    const budget=240-encoder.encode(suffix).length;
    let title=clean(meta.title)+(meta.pageCount>1?`_${clean(meta.part)}`:'');
    title=cut(title||'Bilibili',budget);
    // Windows also reserves CON.txt and COM1.any-extension, not only CON.
    if(/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(title))title=cut(`_${title}`,budget);
    return title+suffix;
  }
  function bytes(n) {if(!Number.isFinite(n)||n<0)return '—';const unit=['B','KiB','MiB','GiB'];let i=0;while(n>=1024&&i<3){n/=1024;i++;}return `${n.toFixed(i===0?0:n>=100?1:2)} ${unit[i]}`;}
  function safeError(err) { return String(err?.message||err||'未知错误').replace(/https?:\/\/[^\s)]+/g,u=>{try{return new URL(u).hostname;}catch{return '[地址]';}}).slice(0,360); }
  // Positional writes are required: MP4 finalization patches earlier headers.
  function memoryTarget(limit=256*1024*1024) {
    const BLOCK=1024*1024, chunks=new Map();let length=0,closed=false,blob=null;
    return {
      async write({type,position,data}) {
        if(closed)throw new Error('保存目标已经关闭。');
        if(type!=='write'||!Number.isSafeInteger(position)||position<0)throw new Error('无效的文件写入位置。');
        const src=data instanceof Uint8Array?data:new Uint8Array(data);
        if(position+src.byteLength>limit)throw new Error('内存下载超过 256 MiB，请改用“直接写入磁盘”。');
        for(let off=0;off<src.length;) {
          const index=Math.floor((position+off)/BLOCK),start=(position+off)%BLOCK,take=Math.min(src.length-off,BLOCK-start);
          let chunk=chunks.get(index);if(!chunk){chunk=new Uint8Array(BLOCK);chunks.set(index,chunk);}chunk.set(src.subarray(off,off+take),start);off+=take;
        }
        length=Math.max(length,position+src.length);
      },
      async close(){if(closed)return;closed=true;const parts=[];for(let i=0;i<Math.ceil(length/BLOCK);i++){const a=chunks.get(i)||new Uint8Array(BLOCK);parts.push(a.subarray(0,Math.min(BLOCK,length-i*BLOCK)));}blob=new Blob(parts,{type:'video/mp4'});chunks.clear();},
      async abort(){closed=true;chunks.clear();blob=null;},
      getBlob(){return blob;},get size(){return length;}
    };
  }
  return {md5,mixinKey,signWbi,safeMediaURL,streamURLs,streamKey,normalizePlay,pageIdentity,selectPage,filename,bytes,safeError,memoryTarget};
}
if(typeof module!=='undefined'&&module.exports)module.exports={createBiliCore};
