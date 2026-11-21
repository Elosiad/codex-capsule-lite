// Executed only in the local Codex app renderer. Receives display metrics only.
(()=>{
  const key=Symbol.for('codex-capsule.local.v1');
  if(window[key])return;
  const idAttr='data-above-composer-conversation-id';
  const panels={
    speed:'输出与首字等待', context:'上下文占用', quota:'账户剩余额度'
  };
  let root,footer,host,shadow,pop,observer,sizing,strip,id='',latest,active='',signature='',sizeMode='',pinned=false,hideTimer;
  const buttons={};
  const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});
  const num=n=>number.format(n);
  const clock=t=>t?new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'未知';
  const alive=e=>!!e?.isConnected&&!!e.offsetWidth&&e.getClientRects().length>0;
  function identity(){
    if(!alive(root))return '';
    if(root.dataset.composerPlacement==='home')return 'home';
    const ids=new Set([...root.querySelectorAll('['+idAttr+']')].map(e=>e.getAttribute(idAttr)));
    const value=ids.size===1?[...ids][0]:'';
    return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)?value:'';
  }
  function closeDetail(){clearTimeout(hideTimer);pinned=false;if(pop?.matches(':popover-open'))pop.hidePopover();active=''}
  function leave(){clearTimeout(hideTimer);if(!pinned)hideTimer=setTimeout(closeDetail,140)}
  function detail(){
    if(!active)return;
    const v=latest||{},s=v.speed,c=v.context,q=v.quota;
    let lines=[];
    if(active==='speed'){
      lines=[s?'最近正文片段　'+num(s.tokens)+' tokens / '+num(s.ms/1000)+' 秒':'最近正文片段　暂无可计时记录',
        '本轮首 Token　'+(v.ttft!=null?num(v.ttft/1000)+' 秒':v.running?'本轮结束后报告':'暂无记录')];
    }else if(active==='context'){
      lines=[c?'最近用量记录　'+num(c.used)+' / '+num(c.max)+' tokens':'等待本聊天的用量记录'];
    }else{
      lines=(q?.windows||[]).map(w=>(w.minutes===300?'5 小时':'周')+'额度　'+
        (w.remaining==null?'待刷新':num(w.remaining)+'% 剩余')+'　重置 '+clock(w.reset));
      lines.push(q?.source?[q.plan,q.source,clock(q.at)].filter(Boolean).join(' · '):'等待额度记录');
    }
    pop.replaceChildren();
    const h=document.createElement('strong');h.textContent=panels[active];pop.append(h);
    for(const line of lines){const div=document.createElement('div');div.textContent=line;pop.append(div)}
  }
  function place(){
    if(!active||!pop.matches(':popover-open'))return;
    const r=buttons[active].getBoundingClientRect(),p=pop.getBoundingClientRect();
    pop.style.left=Math.max(4,Math.min(r.left,innerWidth-p.width-4))+'px';
    pop.style.top=Math.max(4,r.top-p.height-7)+'px';
  }
  function show(k,click){
    clearTimeout(hideTimer);
    if(click&&active===k&&pinned){closeDetail();return}
    if(!click&&pinned)return;
    pinned=click;
    active=k;detail();if(!pop.matches(':popover-open'))pop.showPopover();place();
  }
  function draw(value){
    latest=value;
    const s=value?.speed,t=value?.ttft,c=value?.context,w=value?.quota?.windows||[];
    const short=sizeMode!=='full';
    buttons.speed.textContent=(s?num(s.tps):'—')+(short?' t/s · ':' tok/s · 首字 ')+(t!=null?num(t/1000)+'s':'—');
    buttons.context.textContent=(short?'窗 ':'上下文 ')+(c?num(c.percent)+'%':'—');
    buttons.quota.textContent=w.length?w.map(a=>(a.minutes===300?'5h ':'周 ')+(a.remaining==null?'—':num(a.remaining)+'%')).join(' · '):'额度 —';
    buttons.speed.style.setProperty('--ink',!s?'#94989d':s.tps>=25?'#56b986':s.tps>=10?'#dfab4a':'#de786a');
    buttons.speed.toggleAttribute('data-live',!!value?.running&&!!s);
    buttons.context.style.setProperty('--used',(c?.percent||0)+'%');
    buttons.context.style.setProperty('--ink',c?.percent>=90?'#de786a':c?.percent>=75?'#dfab4a':'#88a9df');
    if(active){detail();place()}
  }
  function fit(){
    if(!host?.isConnected)return;
    const x=host.getBoundingClientRect().left;
    const trailing=footer.querySelector('[data-composer-trailing-controls]');
    const controls=[...(trailing?.querySelectorAll('button,[role="button"],[tabindex]')||[])]
      .filter(alive).map(e=>e.getBoundingClientRect().left);
    const right=Math.min(footer.getBoundingClientRect().right,...controls);
    const space=Math.max(0,Math.floor(right-x-7));
    strip.style.maxWidth=space+'px';
    const mode=space>=277?'full':space>=178?'short':'scroll';
    if(mode!==sizeMode){sizeMode=mode;draw(latest)}
  }
  function mount(f){
    closeDetail();sizing?.disconnect();host?.remove();
    footer=f;root=f.closest('[data-composer-placement]');
    host=document.createElement('div');host.dataset.codexCapsule='';
    host.style.cssText='position:relative;display:block;align-self:center;flex:0 0 0;width:0;height:0;min-width:0;box-sizing:border-box';
    shadow=host.attachShadow({mode:'open'});
    const style=document.createElement('style');
    style.textContent=`
      :host{color:inherit;font:inherit;}
      .strip{position:absolute;left:3px;top:0;transform:translateY(-50%);width:max-content;display:flex;align-items:center;gap:3px;overflow:auto hidden;scrollbar-width:none;line-height:1.4;}
      button{flex:none;display:inline-flex;align-items:center;gap:4px;border:1px solid color-mix(in srgb,currentColor 10%,transparent);border-radius:999px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:inherit;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;padding:2px 6px;line-height:15px;cursor:pointer;}
      button::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ink,#92b9a2)}
      button[data-metric="context"]::before{width:9px;height:9px;background:conic-gradient(var(--ink) var(--used),color-mix(in srgb,currentColor 26%,transparent) 0);mask:radial-gradient(circle,transparent 43%,black 48%)}
      button[data-metric="quota"]::before{width:8px;height:6px;border-radius:2px;border:1px solid #85b99a;background:linear-gradient(to right,#85b99a 50%,transparent 50%);background-size:3px 100%}
      @media(prefers-reduced-motion:no-preference){button[data-live]::before{animation:pulse 1.5s ease-in-out infinite}@keyframes pulse{50%{opacity:.45}}}
      button:hover,button:focus-visible{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}
      button:focus-visible{outline:1px solid currentColor}
      [popover]{box-sizing:border-box;position:fixed;inset:auto;margin:0;max-width:calc(100vw - 8px);border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:10px;background:var(--color-background-elevated,Canvas);color:var(--color-text,CanvasText);padding:8px 11px;font:inherit;font-size:12px;line-height:1.65;box-shadow:0 4px 16px #0003}
      strong{font-weight:600}
    `;
    strip=document.createElement('div');strip.className='strip';strip.setAttribute('role','group');strip.setAttribute('aria-label','Codex Capsule');
    for(const [k,label] of Object.entries(panels)){
      const b=document.createElement('button');b.type='button';b.dataset.metric=k;b.setAttribute('aria-label',label);
      b.onclick=()=>show(k,true);b.onpointerenter=()=>show(k,false);b.onpointerleave=leave;
      buttons[k]=b;strip.append(b);
    }
    pop=document.createElement('div');pop.popover='auto';pop.setAttribute('role','status');
    pop.onpointerenter=()=>clearTimeout(hideTimer);pop.onpointerleave=leave;
    const ownPop=pop;pop.addEventListener('toggle',()=>{if(pop===ownPop&&!pop.matches(':popover-open')){active='';pinned=false}});
    const leading=f.querySelector('[data-composer-leading-controls]')?.firstElementChild;
    if(!leading)return;
    shadow.append(style,strip,pop);leading.append(host);id='';signature='';draw(null);
    sizing=new ResizeObserver(fit);sizing.observe(f);sizing.observe(leading);
    const trailing=f.querySelector('[data-composer-trailing-controls]');if(trailing)sizing.observe(trailing);
    fit();
  }
  function sync(){
    if(!alive(footer)||!host?.isConnected){
      const f=[...document.querySelectorAll(':is([data-composer-placement="thread"],[data-composer-placement="home"]) [data-composer-footer-responsive]')].find(alive);
      if(!f){sizing?.disconnect();closeDetail();host?.remove();host=null;root=null;footer=null;id='';return ''}
      mount(f);
    }
    const next=identity();
    if(next!==id){closeDetail();id=next;host.dataset.thread=id;signature='';draw(null)}
    return id;
  }
  // Track identity changes synchronously at the DOM mutation boundary. The local
  // reader also rechecks the identity before delivering any asynchronous result.
  observer=new MutationObserver(records=>{
    if(!host)return;
    if(!host.isConnected||!root?.isConnected||records.some(r=>
      r.type==='attributes'||(root.contains(r.target)&&!r.target.closest('[contenteditable="true"]')&&r.target!==host)))sync();
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:[idAttr]});
  const reposition=()=>{if(active)place()};
  window.addEventListener('resize',reposition);
  window.addEventListener('scroll',reposition,true);
  window[key]={
    current(){if(document.hidden)return null;return sync()},
    apply(expected,value){
      if(!expected||sync()!==expected)return false;
      const next=JSON.stringify(value);if(next!==signature){signature=next;draw(value)}return true;
    },
    dispose(){observer.disconnect();window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true);
      sizing?.disconnect();closeDetail();host?.remove();delete window[key]}
  };
  return true;
})();
