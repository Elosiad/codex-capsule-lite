// Executed only in the local Codex app renderer. Receives display metrics only.
(()=>{
  const key=Symbol.for('codex-capsule.local.v1');
  if(window[key])return;
  const idAttr='data-above-composer-conversation-id';
  // Request cards use Codex's single-line state internally. Give that surface
  // the normal thread layout without moving the editor or disturbing its selection.
  const questionStyle=document.createElement('style');
  const questionRoot='[data-codex-capsule-question]';
  const requestCard='[data-codex-composer-request-navigation]';
  const questionFooter=questionRoot+' [data-composer-footer-responsive][data-composer-layout="single-line"]';
  questionStyle.textContent=`
    ${questionFooter}:not([data-dictation-view="waveform"]){
      grid-template-columns:minmax(0,auto) auto minmax(0,1fr);grid-template-rows:auto auto;gap:0 5px;
      padding:0 calc(var(--spacing) * 2);margin-bottom:var(--spacing-composer-footer-bottom);
    }
    ${questionFooter}:not([data-dictation-view="waveform"]) > :not([data-composer-leading-controls],[data-composer-trailing-controls],[data-composer-expansion-control])[data-composer-layout]{
      grid-area:1 / 1 / 2 / -1;min-width:0;justify-self:stretch;margin-inline:calc(var(--spacing) * -2);
    }
    ${questionFooter}:not([data-dictation-view="waveform"]) > [data-composer-leading-controls]{grid-area:2 / 1}
    ${questionFooter}:not([data-dictation-view="waveform"]) > [data-composer-trailing-controls]{grid-area:2 / 3}
    ${questionRoot} [data-composer-surface-variant][data-composer-layout="single-line"]{
      border-radius:var(--composer-border-radius,22px);
    }
    ${questionRoot} [data-composer-body][data-composer-layout="single-line"]{
      border-radius:inherit;
    }
    ${questionRoot} [data-composer-body][data-composer-layout="single-line"] > [data-composer-attachments]:not([data-visible-attachments]),
    ${questionRoot} [data-composer-body][data-composer-layout="single-line"]:not(:has(> [data-composer-attachments]))::before{
      content:"";padding:var(--padding-composer-empty-attachments);
    }
    ${questionFooter} [data-composer-input][data-composer-layout="single-line"]{
      padding:0;margin:0 0 var(--spacing-composer-input-footer);
    }
    ${questionFooter} [data-composer-input-layout="single-line"]{
      display:grid;grid-template-rows:minmax(max(2lh,var(--composer-editor-min-height,0px)),auto);
      box-sizing:content-box;height:auto;margin:0;padding:var(--padding-composer-input);overflow:auto;
      max-height:min(25dvh,var(--composer-editor-max-height,25dvh));line-height:var(--composer-editor-line-height,1.35);
    }
    ${questionFooter} [data-composer-input-layout="single-line"] > [contenteditable="true"]{
      height:auto!important;min-height:var(--composer-editor-min-height,2.5rem)!important;
      padding:0;overflow:visible;white-space:break-spaces;overflow-wrap:anywhere;
    }
    /* As in the multiline editor, the scroll container clips the text and
       decorations together. Its individual children do not clip each other. */
    ${questionFooter} [data-composer-input-layout="single-line"] > *{overflow:visible}`;
  document.head.append(questionStyle);
  const panels={
    error:'请求状态',speed:'输出与首字等待', context:'上下文占用', quota:'账户剩余额度'
  };
  const contentKinds={
    results:['工具结果','#82a6d9'],calls:['工具调用','#da9b61'],
    instructions:['系统与开发者指令','#ad92d4'],user:['用户文字','#6eb7a0'],
    tools:['工具定义','#d8bc67'],assistant:['助手正文','#66aec8'],
    reason:['可见推理摘要','#cf88ab'],summary:['压缩摘要','#afba82'],
    other:['其他文字','#c19481'],unclassified:['未归类','#999eab']
  };
  let root,footer,host,shadow,pop,observer,sizing,strip,id='',latest,active='',signature='',sizeMode='',pinned=false,hideTimer;
  const buttons={};
  let observed=null;
  let firstWatch=null;
  function streamSample(expected,turn,finished,sentAt){
    if(document.hidden||sync()!==expected||!turn){observed=null;firstWatch=null;return null}
    const scope=root?.closest('[data-app-action-timeline-scroll]')||root?.closest('main');
    const selector='[data-response-update-thread="'+CSS.escape(expected)+'"][data-response-update-turn="'+CSS.escape(turn)+'"][data-response-update-item]';
    const block=scope?.querySelectorAll(selector);
    const last=block?.[block.length-1];
    const item=last?.dataset.responseUpdateItem;
    const body=last?.querySelector('[data-markdown-text-style="assistant-message"]');
    const now=Date.now(),turnKey=expected+'/'+turn;
    if(firstWatch?.key!==turnKey){
      firstWatch={key:turnKey,last:now,armed:false,wait:null};
      firstWatch.armed=!!sentAt&&!finished&&!body?.textContent?.trim()&&now>=sentAt&&now-sentAt<=2300;
    }
    if(now-firstWatch.last>2500)firstWatch.armed=false;
    firstWatch.last=now;
    if(firstWatch.armed&&sentAt&&body?.textContent?.trim()){
      firstWatch.wait=Math.max(0,now-sentAt);firstWatch.armed=false;
    }
    if(!item||item===finished||!body?.getClientRects().length){observed=null;return null}
    const key=expected+'/'+turn+'/'+item, text=body.textContent||'',at=performance.now();
    const prev=observed;
    observed={key,length:text.length,tail:text.slice(-96)};
    // Baseline on first sight, virtualized history, a rewritten Markdown prefix
    // or a huge pasted block; these do not measure a streaming interval.
    if(prev?.key!==key||text.length<prev.length||text.length-prev.length>16384||
       text.slice(Math.max(0,prev.length-96),prev.length)!==prev.tail)return {key,at,reset:true};
    return {key,at,delta:text.slice(prev.length)};
  }
  let toolbarWatch,layoutFrame=0;
  const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1});
  const num=n=>number.format(n);
  const kilo=n=>n==null?'—':n>0&&n<10?'<0.01K':(n>=1000?num(n/1000):Number((n/1000).toFixed(2)))+'K';
  const clock=t=>t?new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'未知';
  const planName=p=>({prolite:'Pro',pro:'Pro',plus:'Plus'})[p]||p||'账户额度';
  let quotaMinute=-1;
  function retryTime(f){
    if(!Number.isFinite(f?.retryAt))return '';
    const sec=Math.max(0,Math.ceil((f.retryAt-Date.now())/1000));
    if(!sec)return '重试时间已到，等待新记录';
    return (sec>=60?Math.floor(sec/60)+'分 ':'')+(sec%60)+'秒后重试';
  }
  function errorLabel(f){
    const secs=Math.ceil((f.retryAt-Date.now())/1000);
    return secs>0?f.title+' · '+Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0'):f.title;
  }
  function element(tag,cls,text){
    const e=document.createElement(tag);e.className=cls;if(text!=null)e.textContent=text;return e;
  }
  function countdown(t){
    if(!Number.isFinite(t)||t<=0)return '重置时间未知';
    const mins=Math.ceil((t-Date.now())/60000);
    if(mins<=0)return '待刷新';
    if(mins>=1440)return Math.floor(mins/1440)+'天 '+Math.floor(mins%1440/60)+'小时';
    return mins>=60?Math.floor(mins/60)+'小时 '+mins%60+'分':mins+'分';
  }
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
    pop.replaceChildren();
    if(active==='quota'){
      quotaMinute=Math.floor(Date.now()/60000);
      pop.append(element('strong','heading',planName(q?.plan)));
      const list=element('div','quota-list');
      for(const w of q?.windows||[]){
        const row=element('div','quota-row'),ring=element('i','meter');
        const left=w.remaining;
        ring.setAttribute('aria-hidden','true');
        ring.style.setProperty('--fill',(left??0)+'%');
        ring.style.setProperty('--ring',left==null?'#89909b':left<=10?'#d77974':left<=25?'#d6a04b':'#62a57c');
        const reset=element('span','countdown',countdown(w.reset));reset.title='重置于 '+clock(w.reset);
        row.append(element('span','window',w.minutes===300?'5h额度':'周额度'),element('span','percent',left==null?'—':num(left)+'%'),ring,reset);
        list.append(row);
      }
      pop.append(list);
      if(q?.balance!=null)pop.append(element('div','balance','余额　'+q.balance));
      pop.append(element('div','stamp',q?.source?planName(q.plan)+' · '+(q.at?'更新于 '+clock(q.at):'更新时间未知'):'等待额度记录'));
      return;
    }
    if(active==='error'&&v.failure){
      const f=v.failure;
      pop.append(element('strong','heading',f.title),element('div','explanation',f.summary),
        element('div','stage',f.phase==='retry'?['自动重试',f.attempt,retryTime(f)].filter(Boolean).join(' · '):'本次请求报错'));
      if(f.technical)pop.append(element('code','evidence',f.technical));
      return;
    }
    if(active==='speed'){
      pop.append(element('strong','heading panel-title',panels.speed));
      if(v.ttftSource==='message')pop.append(element('div','stat-label speed-hint','首字按消息发出至首段正文开始计算'));
      if(v.ttftSource==='screen')pop.append(element('div','stat-label speed-hint','首字来自界面采样，等待日志校准'));
      const grid=element('div','speed-grid');
      const measures=[
        [s?.live?'近 3 秒速度':'片段平均速度',s?(s.live?'≈':'')+num(s.tps):'—',s?'tokens/秒':'',buttons.speed.style.getPropertyValue('--ink')],
        [v.ttftSource==='official'?'官方首 Token':'首字等待',v.ttft!=null?(v.ttftSource==='screen'?'≈':'')+num(v.ttft/1000):'—',v.ttft!=null?'秒':'','#88a9df']
      ];
      for(const [label,amount,unit,color] of measures){
        const col=element('div','speed-stat'),value=element('div','speed-value');
        col.style.setProperty('--part',color);
        value.append(element('b','',amount));
        if(unit)value.append(element('span','unit',unit));
        col.append(element('span','stat-label',label),value);
        if(color==='#88a9df')col.title=v.ttftSource==='message'?'用户消息时间 → 首条助手正文的日志起始时间':
          v.ttftSource==='screen'?'用户消息时间 → 本机首次采样到正文':v.ttftSource==='official'?'缺少正文时间，采用 Codex 轮次首 Token 记录':'等待首条正文的时间记录';
        grid.append(col);
      }
      const caption=s?.live?'采样 '+num(s.ms/1000)+' 秒 · 约 '+num(s.tokens)+' tokens':
        s?'本段 '+num(s.tokens)+' tokens · 耗时 '+num(s.ms/1000)+' 秒 · '+num(s.tps)+' tokens/秒':'等待可计时的正文片段';
      const total=element('div','turn-output');
      total.append(element('span','','本轮累计输出'),element('b','',v.turnOutput==null?'待记录':num(v.turnOutput)+' tokens'));
      total.title='当前聊天本轮各次模型请求已记录的输出，含工具调用与推理；每次用量落盘后更新。';
      pop.append(grid,total,element('div','stamp',caption));
      return;
    }else if(active==='context'){
      if(!c){pop.append(element('strong','heading',panels.context),element('div','stamp','等待本聊天的用量记录'));return}
      pop.append(element('strong','heading cache','缓存命中 '+(c.cacheRate==null?'—':num(c.cacheRate)+'%')));
      const usage=element('div','ctx-usage');
      usage.append(element('b','',num(c.percent)+'% 已用'),element('span','',kilo(c.used)+' / '+kilo(c.max)));
      const bar=element('div','ctx-bar'),fill=element('div','ctx-fill');
      fill.style.width=Math.min(100,100*c.used/c.max)+'%';bar.append(fill);
      bar.setAttribute('role','img');
      const remaining='剩余 '+kilo(Math.max(0,c.max-c.used));
      const barLabel=num(c.percent)+'% 已用，'+remaining;
      bar.setAttribute('aria-label',barLabel);bar.title=barLabel;
      pop.append(usage,bar);
      pop.append(element('strong','composition-title','已用内容构成'));
      const content=v.composition;
      if(!content){pop.append(element('div','stat-label','正在读取本地可识别内容…'));return}
      const table=element('div','breakdown');
      const values=Object.entries(content.text).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]);
      const estimated=values.reduce((sum,[,n])=>sum+n,0);
      if(c.used>estimated)values.push(['unclassified',c.used-estimated]);
      const total=Math.max(c.used,estimated),stops=[];
      let cumulative=0;
      for(const [key,n] of values){
        const [label,color]=contentKinds[key]||contentKinds.other;
        const start=cumulative/total*100;
        cumulative+=n;stops.push(color+' '+start+'% '+(cumulative/total*100)+'%');
        const entry=element('div','ctx-entry');
        entry.title=label+' · 约占 '+num(100*n/total)+'%';
        entry.style.setProperty('--key-color',color);
        entry.append(element('span','',label),element('b','',kilo(n)));table.append(entry);
      }
      const layout=element('div','composition-layout');layout.append(table);
      if(stops.length&&c.used>0){
        const pie=element('div','ctx-pie');pie.style.background='conic-gradient('+stops.join(',')+')';
        pie.setAttribute('aria-hidden','true');pie.title='已用内容构成（估算）';layout.append(pie);
      }
      pop.append(layout);
      const media=['当前记录图片 '+content.images+' 张'];
      if(content.files)media.push('文件 '+content.files+' 个');
      if(content.audio)media.push('音频 '+content.audio+' 段');
      pop.append(element('div','attachments',media.join(' · ')));
      pop.append(element('div','stat-label',remaining+'。文字按 o200k_base 估算。'+
        (estimated>c.used?'文字估算超过已用量，扇形按各项估算占比分配。':c.used>estimated?'未归类为已用量减去可识别文字的估算差额，含图片等内容。':'')+
        (content.partial?'本地记录不完整。':'')));
      return;
    }
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
    buttons.error.hidden=!value?.failure;
    if(value?.failure){
      buttons.error.textContent=errorLabel(value.failure);
      buttons.error.dataset.phase=value.failure.phase;
    }else if(active==='error')closeDetail();
    const short=sizeMode!=='full';
    buttons.speed.textContent=(s?(s.live?'≈':'')+num(s.tps):'—')+(short?' tokens/秒 · ':' tokens/秒 · 首字 ')+(t!=null?(value.ttftSource==='screen'?'≈':'')+num(t/1000)+'s':'—');
    buttons.context.textContent=(short?'窗 ':'上下文 ')+(c?num(c.percent)+'%':'—');
    const quotaLabels=w.map(a=>(a.minutes===300?'5h额度 ':'周额度 ')+(a.remaining==null?'—':num(a.remaining)+'%'));
    if(value?.quota?.balance!=null)quotaLabels.push('余额 '+value.quota.balance);
    buttons.quota.textContent=quotaLabels.join(' · ')||'额度 —';
    buttons.speed.style.setProperty('--ink',!s?'#94989d':s.tps>=25?'#56b986':s.tps>=10?'#dfab4a':'#de786a');
    buttons.speed.toggleAttribute('data-live',!!s?.live);
    buttons.context.style.setProperty('--used',(c?.percent||0)+'%');
    buttons.context.style.setProperty('--ink',c?.percent>=90?'#de786a':c?.percent>=75?'#dfab4a':'#88a9df');
    if(active){detail();place()}
  }
  function fit(){
    if(!host?.isConnected)return;
    const anchor=host.getBoundingClientRect();
    const leading=footer.querySelector('[data-composer-leading-controls]');
    const trailing=footer.querySelector('[data-composer-trailing-controls]');
    const rects=group=>[...(group?.querySelectorAll('button,[role="button"],[tabindex],[data-composer-navigation-target]')||[])]
      .filter(e=>alive(e)&&getComputedStyle(e).visibility==='visible').map(e=>e.getBoundingClientRect());
    const leftRects=rects(leading),rightRects=rects(trailing);
    if(!leftRects.length||!rightRects.length){strip.style.visibility='hidden';closeDetail();return}
    const box=footer.getBoundingClientRect();
    // While React is swapping layouts, never put the strip on top of the input.
    const editor=footer.querySelector('[data-composer-input]');
    const inputBox=editor?.getBoundingClientRect(),mid=leftRects[0].top+leftRects[0].height/2;
    if(inputBox?.height>0&&mid>=inputBox.top&&mid<inputBox.bottom){
      strip.style.visibility='hidden';closeDetail();return;
    }
    const start=Math.max(box.left,...leftRects.map(r=>r.right))+4;
    const end=Math.min(box.right,...rightRects.map(r=>r.left))-4;
    const space=Math.max(0,Math.floor(end-start));
    // React can insert both native buttons after our host when a question closes.
    // Anchor to the buttons themselves, independently of the order of siblings.
    strip.style.left=(start-anchor.left)+'px';
    strip.style.top=(leftRects[0].top+leftRects[0].height/2-anchor.top)+'px';
    strip.style.maxWidth=space+'px';
    strip.style.visibility=space>=26?'visible':'hidden';
    const mode=space>=277?'full':space>=178?'short':'scroll';
    if(mode!==sizeMode){sizeMode=mode;draw(latest)}
    if(active)place();
  }
  function scheduleFit(){if(!layoutFrame)layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;fit()})}
  function updateQuestionLayout(){
    if(!root||!footer)return;
    const open=root.dataset.composerPlacement==='thread'&&footer.dataset.composerLayout==='single-line'&&
      footer.dataset.dictationView!=='waveform'&&!!root.querySelector(requestCard);
    root.toggleAttribute('data-codex-capsule-question',open);
  }
  function mount(f){
    closeDetail();sizing?.disconnect();toolbarWatch?.disconnect();host?.remove();root?.removeAttribute('data-codex-capsule-question');
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
      button[hidden]{display:none}
      button[data-metric="error"]{--ink:#df7e78;color:color-mix(in srgb,#df7e78 88%,currentColor);background:color-mix(in srgb,#df7e78 12%,transparent)}
      button[data-phase="retry"]{--ink:#d9a44d;color:var(--ink);background:color-mix(in srgb,#d9a44d 12%,transparent)}
      [popover]{min-width:min(208px,90vw);max-width:min(330px,96vw);border-radius:13px;padding:12px 15px;background:color-mix(in srgb,var(--color-background-elevated,Canvas) 93%,transparent);backdrop-filter:blur(14px);line-height:1.55;font-size:13px}
      .heading{display:block;font-weight:650;font-size:15px;margin-bottom:6px}
      .quota-list{display:grid;grid-template-columns:max-content max-content 13px auto;column-gap:7px;justify-content:start}
      .quota-row{display:grid;grid-template-columns:subgrid;grid-column:1/-1;align-items:center;min-height:25px;font-variant-numeric:tabular-nums}
      .percent{text-align:right}.meter{width:13px;height:13px;border-radius:50%;background:conic-gradient(var(--ring) var(--fill),color-mix(in srgb,currentColor 17%,transparent) 0);mask:radial-gradient(circle,transparent 45%,black 49%)}
      .countdown,.window,.stamp{opacity:.78}.stamp,.evidence{border-top:1px solid color-mix(in srgb,currentColor 13%,transparent);margin-top:8px;padding-top:6px}
      .stamp{font-size:11px}.evidence{display:block;font-size:11px;overflow-wrap:anywhere}.stage{margin-top:5px;font-size:12px;font-weight:600}
      .cache{padding-bottom:7px;border-bottom:1px solid color-mix(in srgb,currentColor 13%,transparent)}
      .speed-grid{display:grid;grid-template-columns:max-content max-content;gap:20px;padding:3px 0 2px}
      .turn-output{display:flex;align-items:baseline;justify-content:space-between;gap:14px;margin-top:7px;font-size:12px}
      .turn-output b{font-variant-numeric:tabular-nums}
      .speed-stat{border-inline-start:2px solid var(--part);padding-inline-start:7px}
      .stat-label,.unit{font-size:11px;opacity:.76}.speed-value{display:flex;align-items:baseline;gap:4px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .speed-value b{font-size:18px;line-height:1.35;font-weight:650}.panel-title{margin-bottom:8px}
      .panel-title:has(+.speed-hint){margin-bottom:2px}.speed-hint{margin-bottom:8px}
      [popover]{max-height:calc(100vh - 35px);overflow-y:auto}
      .composition-title{display:block;margin:10px 0 5px;font-size:13px}.breakdown{display:grid;gap:2px;font-size:11px}
      .composition-layout{display:flex;align-items:center;gap:14px}.breakdown{flex:1;min-width:0}
      .ctx-pie{width:clamp(52px,16vw,90px);aspect-ratio:1;flex:none;border-radius:50%}
      .ctx-entry{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:7px}
      .ctx-entry::before{content:"";width:8px;height:8px;border-radius:2px;background:var(--key-color)}
      .ctx-entry b{font-variant-numeric:tabular-nums}
      .attachments,.balance{margin:5px 0;font-size:12px}
      .ctx-usage{display:flex;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums}.ctx-usage span{opacity:.8}
      .ctx-bar{display:flex;overflow:hidden;height:7px;border-radius:5px;background:color-mix(in srgb,currentColor 12%,transparent);margin:8px 0 10px}
      .ctx-fill{background:#82a6d9}
    `;
    strip=document.createElement('div');strip.className='strip';strip.setAttribute('role','group');strip.setAttribute('aria-label','Codex Capsule');
    for(const [k,label] of Object.entries(panels)){
      const b=document.createElement('button');b.type='button';b.dataset.metric=k;b.setAttribute('aria-label',label);
      if(k==='error')b.hidden=true;
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
    const input=f.querySelector('[data-composer-input]');if(input)sizing.observe(input);
    const trailing=f.querySelector('[data-composer-trailing-controls]');if(trailing)sizing.observe(trailing);
    toolbarWatch=new MutationObserver(records=>{
      if(records.some(r=>r.target===f))updateQuestionLayout();
      scheduleFit();
    });
    toolbarWatch.observe(f,{attributes:true,attributeFilter:['data-composer-layout','data-composer-rows','data-dictation-view']});
    for(const group of [leading.parentElement,trailing])if(group)toolbarWatch.observe(group,{
      subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden']
    });
    updateQuestionLayout();fit();
  }
  function sync(){
    if(!alive(footer)||!host?.isConnected){
      const f=[...document.querySelectorAll(':is([data-composer-placement="thread"],[data-composer-placement="home"]) [data-composer-footer-responsive]')].find(alive);
      if(!f){sizing?.disconnect();toolbarWatch?.disconnect();closeDetail();host?.remove();root?.removeAttribute('data-codex-capsule-question');host=null;root=null;footer=null;id='';return ''}
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
    if(!host.isConnected||!root?.isConnected){sync();return}
    const marker='['+idAttr+']';
    // Caret paint and typing also mutate the composer. Neither can change
    // the conversation ID. Only look for a new/removed identity outside the editor.
    for(const record of records){
      if(!root.contains(record.target))continue;
      if(record.type==='attributes'){sync();return}
      if(footer.contains(record.target))continue;
      for(const node of [...record.addedNodes,...record.removedNodes]){
        if(node.nodeType!==1)continue;
        if(footer.dataset.composerLayout==='single-line'&&(node.matches(requestCard)||node.querySelector(requestCard)))updateQuestionLayout();
        if(node.matches(marker)||node.querySelector(marker)){sync();return}
      }
    }
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:[idAttr]});
  const reposition=()=>{if(active)place()};
  window.addEventListener('resize',reposition);
  window.addEventListener('scroll',reposition,true);
  window[key]={
    streamSample,
    observedWait(expected,turn){return sync()===expected&&firstWatch?.key===expected+'/'+turn?firstWatch.wait:null},
    wantsContent(){return active==='context'&&pop?.matches(':popover-open')},
    current(){if(document.hidden)return null;return sync()},
    apply(expected,value){
      if(!expected||sync()!==expected)return false;
      const next=JSON.stringify(value);if(next!==signature){signature=next;draw(value)}
      else if(active==='quota'&&quotaMinute!==Math.floor(Date.now()/60000)){detail();place()}
      if(value.failure?.retryAt){
        const label=errorLabel(value.failure);
        if(buttons.error.textContent!==label)buttons.error.textContent=label;
        if(active==='error'){detail();place()}
      }
      return true;
    },
    dispose(){observer.disconnect();window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true);
      sizing?.disconnect();toolbarWatch?.disconnect();cancelAnimationFrame(layoutFrame);closeDetail();host?.remove();root?.removeAttribute('data-codex-capsule-question');questionStyle.remove();delete window[key]}
  };
  return true;
})();
