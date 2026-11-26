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
    error:'Request status',context:'Context usage',speed:'Throughput & TTFT',quota:'Account quota'
  };
  const contentKinds={
    results:['Tool results','#e5786d'],calls:['Tool calls','#da9b61'],
    instructions:['System','#ad92d4'],user:['User','#6eb7a0'],
    tools:['Tool defs','#d8bc67'],assistant:['Assistant','#66aec8'],
    reason:['Thinking','#cf88ab'],summary:['Summary','#afba82'],
    other:['Other','#c19481'],unclassified:['Unclassified','#999eab']
  };
  let root,footer,host,shadow,pop,observer,sizing,strip,id='',latest,active='',signature='',sizeMode='',pinned=false,hideTimer;
  const buttons={};
  let observed=null;
  let firstWatch=null;
  let summaryWatch=null;
  // Watch the public summary notification from this renderer, not reasoning text.
  // Arm at turn start so opening a running chat cannot register a late delta as its first.
  function watchSummary(event){
    if(event.source!==window||event.origin!==location.origin||document.hidden)return;
    const n=event.data;
    if(n?.type!=='mcp-notification'||!id||n.params?.threadId!==id)return;
    if(n.method==='turn/started'){
      const turn=n.params.turn?.id;
      if(turn&&summaryWatch?.turn!==turn)summaryWatch={thread:id,turn,at:null};
    }else if(n.method==='item/reasoning/summaryTextDelta'&&summaryWatch?.thread===id&&
      summaryWatch.turn===n.params.turnId&&summaryWatch.at===null&&typeof n.params.delta==='string'&&n.params.delta.trim()){
      summaryWatch.at=Date.now();
    }
  }
  window.addEventListener('message',watchSummary);
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
  const number=new Intl.NumberFormat('en-US',{maximumFractionDigits:1});
  const num=n=>number.format(n);
  const speedNumber=s=>(s.live||s.kind==='tool'?'≈':'')+num(s.tps);
  const waitNumber=(v,t)=>(['screen','summary','official'].includes(v?.ttftSource)?'≈':'')+num(t/1000);
  const kilo=n=>n==null?'—':n>0&&n<10?'<0.01K':(n>=1000?num(n/1000):Number((n/1000).toFixed(2)))+'K';
  const clock=t=>t?new Date(t).toLocaleString('en-US',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'Unknown';
  const planName=p=>({prolite:'Pro',pro:'Pro',plus:'Plus'})[p]||p||'Account quota';
  const failTitleMap={'连接已满 60 分钟':'60m limit reached','额度已用尽':'Quota exhausted','模型繁忙':'Model at capacity','服务繁忙':'Service busy','请求受限':'Rate limited','登录验证失败':'Auth failed','访问被拒绝':'Access denied','连接超时':'Timed out','连接被拒绝':'Connection refused','域名解析失败':'DNS failed','服务端错误':'Server error','连接中断':'Disconnected','请求异常':'Request error'};
  const failSummaryMap={'当前 WebSocket 连接已达到 60 分钟时限。':'WebSocket connection reached the 60-minute limit.','连接已满 60 分钟，Codex 正在自动重连':'60-minute connection limit reached; Codex is reconnecting.','服务报告可用额度已耗尽。请查看额度重置时间。':'Available quota exhausted. Check reset time.','所选模型暂时满载。':'Selected model is currently at capacity.','服务端暂时无法接收请求，可稍后再试。':'Service temporarily unavailable; retry shortly.','服务端限制了这次请求；可稍后再试。':'Request rate limited by server; retry shortly.','服务端拒绝了当前凭据，可检查 Codex 登录状态。':'Credentials rejected; check Codex sign-in status.','服务端拒绝了此请求，请检查当前账号或模型权限。':'Request forbidden; check account or model permissions.','等待响应超过时限。':'Timed out waiting for response.','建立连接时收到拒绝响应。':'Connection refused by server.','客户端未能解析连接所需的域名。':'Failed to resolve server hostname.','服务端处理请求时返回了错误。':'Server returned an error while processing the request.','回复传输提前结束，Codex 没有收到完整响应。':'Stream closed before completion; incomplete response.','与服务的连接未能建立或维持，具体断点未知。':'Connection dropped or could not be established.','Codex 报告了请求异常，当前记录未标明可确认的原因。':'Codex reported a request error without a specific reason.'};
  const trTitle=t=>failTitleMap[t]||t;
  const trSummary=s=>failSummaryMap[s]||s;
  let quotaMinute=-1;
  function retryTime(f){
    if(!Number.isFinite(f?.retryAt))return '';
    const sec=Math.max(0,Math.ceil((f.retryAt-Date.now())/1000));
    if(!sec)return 'Retry ready, awaiting log';
    return 'Retry in '+(sec>=60?Math.floor(sec/60)+'m ':'')+(sec%60)+'s';
  }
  function errorLabel(f){
    const secs=Math.ceil((f.retryAt-Date.now())/1000);
    const title=trTitle(f.title);
    return secs>0?title+' · '+Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0'):title;
  }
  function element(tag,cls,text){
    const e=document.createElement(tag);e.className=cls;if(text!=null)e.textContent=text;return e;
  }
  const SVG_NS='http://www.w3.org/2000/svg';
  function svgEl(tag,attrs){
    const e=document.createElementNS(SVG_NS,tag);
    for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));
    return e;
  }
  function dbIcon(){
    const s=svgEl('svg',{class:'db-icon',viewBox:'0 0 16 16',width:13,height:13,'aria-hidden':'true',fill:'none',stroke:'currentColor','stroke-width':1.35,'stroke-linecap':'round','stroke-linejoin':'round'});
    s.append(
      svgEl('ellipse',{cx:8,cy:4,rx:4.7,ry:1.9}),
      svgEl('path',{d:'M3.3 4v8c0 1.05 2.1 1.9 4.7 1.9s4.7-.85 4.7-1.9V4'}),
      svgEl('path',{d:'M3.3 8c0 1.05 2.1 1.9 4.7 1.9s4.7-.85 4.7-1.9'})
    );
    return s;
  }
  function ringIcon(pct){
    const r=5.4,c=2*Math.PI*r,fill=pct==null?0:Math.max(0,Math.min(100,pct));
    const color=pct==null?'#89909b':pct<=10?'#de786a':pct<=25?'#dfab4a':'#45c368';
    const s=svgEl('svg',{class:'ring-icon',viewBox:'0 0 16 16',width:14,height:14,'aria-hidden':'true'});
    s.append(svgEl('circle',{cx:8,cy:8,r,fill:'none',stroke:'color-mix(in srgb,currentColor 20%,transparent)','stroke-width':2.1}));
    if(fill>0){
      s.append(svgEl('circle',{
        cx:8,cy:8,r,fill:'none',stroke:color,'stroke-width':2.1,'stroke-linecap':'round',
        'stroke-dasharray':c.toFixed(2),'stroke-dashoffset':(c*(1-fill/100)).toFixed(2),
        transform:'rotate(-90 8 8)'
      }));
    }
    return s;
  }
  function countdown(t){
    if(!Number.isFinite(t)||t<=0)return 'Reset unknown';
    const mins=Math.ceil((t-Date.now())/60000);
    if(mins<=0)return 'Refreshing';
    if(mins>=1440)return Math.floor(mins/1440)+'d '+Math.floor(mins%1440/60)+'h';
    return mins>=60?Math.floor(mins/60)+'h '+mins%60+'m':mins+'m';
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
      const head=element('div','heading quota-head');
      head.append(element('span','',planName(q?.plan)));
      if(q?.at)head.title='Updated '+clock(q.at);
      if(q?.windows?.some(w=>w.remaining!=null&&w.remaining<=10)){
        const dot=element('i','quota-alert');dot.setAttribute('aria-hidden','true');head.append(dot);
      }
      pop.append(head);
      const list=element('div','quota-list');
      for(const w of q?.windows||[]){
        const row=element('div','quota-row'),bar=element('span','q-bar'),fillEl=element('i','q-fill');
        const left=w.remaining,pct=left==null?0:Math.max(0,Math.min(100,left));
        bar.setAttribute('aria-hidden','true');
        fillEl.style.width=pct+'%';
        if(pct>0)fillEl.style.minWidth='4px';
        fillEl.style.background=left==null?'#89909b':left<=10?'#de786a':left<=25?'#dfab4a':'#45c368';
        bar.append(fillEl);
        const reset=element('span','countdown',countdown(w.reset));reset.title='Resets at '+clock(w.reset);
        row.append(element('span','window',w.minutes===300?'5 Hours':'Weekly'),element('span','percent',left==null?'—':num(left)+'%'),bar,reset);
        list.append(row);
      }
      if(q?.windows?.length)pop.append(list);
      else if(!q?.source)pop.append(element('div','stat-label','Waiting for quota data'));
      if(q?.balance!=null)pop.append(element('div','balance','Balance '+q.balance));
      return;
    }
    if(active==='error'&&v.failure){
      const f=v.failure;
      pop.append(element('strong','heading',trTitle(f.title)),element('div','explanation',trSummary(f.summary)),
        element('div','stage',f.phase==='retry'?['Auto retry',f.attempt,retryTime(f)].filter(Boolean).join(' · '):'Request failed'));
      if(f.technical)pop.append(element('code','evidence',f.technical));
      return;
    }
    if(active==='speed'){
      const hint={
        message:'From prompt sent to first assistant message chunk, including progress updates.',
        summary:'From prompt sent to first visible reasoning summary, estimated from log chunk start.',
        summaryDelta:'From prompt sent to first non-empty reasoning summary received in UI.',
        screen:'From prompt sent to first assistant text sampled in UI.',
        official:'Missing visible response timing; using Codex recorded first-token latency.'
      }[v.ttftSource];
      const grid=element('div','speed-grid');
      const measures=[
        [s?.kind==='family'?'Turn avg':s?.kind==='toolPending'?'Tool args':s?.kind==='tool'?'Tool speed':s?.live?'Live 3s':'Speed',s?.kind==='toolPending'?num(s.ms/1000):s?speedNumber(s):'—',s?.kind==='toolPending'?'s':s?'tok/s':'',buttons.speed.style.getPropertyValue('--ink')],
        ['TTFT',v.ttft!=null?waitNumber(v,v.ttft):'—',v.ttft!=null?'s':'','#88a9df']
      ];
      for(const [label,amount,unit,color] of measures){
        const col=element('div','speed-stat'),value=element('div','speed-value');
        col.style.setProperty('--part',color);
        value.append(element('b','',amount));
        if(unit)value.append(element('span','unit',unit));
        col.append(element('span','stat-label',label),value);
        if(label==='TTFT'&&hint)col.title=hint;
        grid.append(col);
      }
      const caption=s?.kind==='family'?'Main '+(v.ownOutput==null?'—':num(v.ownOutput))+' · '+num(v.agentCount)+(v.agentCount===1?' agent ':' agents ')+num(v.agentOutput)+' tok':
        s?.kind==='toolPending'?'Awaiting tool args…':
        s?.kind==='tool'?'Tool '+num(s.tokens)+' tok · '+num(s.ms/1000)+'s':
        s?.live?'Sampled '+num(s.tokens)+' tok · '+num(s.ms/1000)+'s':
        s?num(s.tokens)+' tok · '+num(s.ms/1000)+'s':'Waiting for output';
      const total=element('div','turn-output');
      total.append(element('span','','Output'),element('b','',v.turnOutput==null?'—':num(v.turnOutput)+' tokens'));
      const foot=element('div','stamp speed-foot');
      foot.append(total,element('div','stat-label',caption));
      pop.append(grid,foot);
      return;
    }else if(active==='context'){
      if(!c){pop.append(element('strong','heading',panels.context),element('div','stamp','Waiting for usage data'));return}
      pop.append(element('strong','heading cache','Cache '+(c.cacheRate==null?'—':num(c.cacheRate)+'%')));
      const usage=element('div','ctx-usage');
      const pctEl=element('span','ctx-pct');
      pctEl.append(element('b','',num(c.percent)+'%'),document.createTextNode(' used'));
      usage.append(pctEl,element('span','ctx-cap',kilo(c.used)+' / '+kilo(c.max)));
      const bar=element('div','ctx-bar'),fill=element('div','ctx-fill');
      fill.style.width=Math.min(100,100*c.used/c.max)+'%';bar.append(fill);
      bar.setAttribute('role','img');
      const remaining=kilo(Math.max(0,c.max-c.used))+' remaining';
      const barLabel=num(c.percent)+'% used, '+remaining;
      bar.setAttribute('aria-label',barLabel);bar.title=barLabel;
      pop.append(usage,bar);
      const content=v.composition;
      if(!content){pop.append(element('div','stat-label','Reading local breakdown…'));return}
      const table=element('div','breakdown');
      const values=Object.entries(content.text).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]);
      const estimated=values.reduce((sum,[,n])=>sum+n,0);
      if(c.used>estimated)values.push(['unclassified',c.used-estimated]);
      const total=Math.max(c.used,estimated);
      for(const [key,n] of values){
        const [label,color]=contentKinds[key]||contentKinds.other;
        const entry=element('div','ctx-entry');
        const percent=100*n/total;
        const share=percent<0.1?'<0.1%':num(percent)+'%';
        entry.title=label+' · '+kilo(n)+' · ~'+share+' of used';
        const segment=element('span','');
        segment.style.flexGrow=String(n);
        segment.style.backgroundColor=color;
        segment.title=entry.title;
        fill.append(segment);
        entry.style.setProperty('--part',color);
        entry.append(element('span','',label),element('b','',share),element('small','',kilo(n)));
        table.append(entry);
      }
      pop.append(table);
      const media=[];
      if(content.images)media.push(content.images+(content.images===1?' image':' images'));
      if(content.files)media.push(content.files+(content.files===1?' file':' files'));
      if(content.audio)media.push(content.audio+' audio');
      if(media.length)pop.append(element('div','attachments',media.join(' · ')));
      pop.append(element('div','stamp ctx-foot',remaining+(content.partial?' · Partial log':'')));
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
    const s=value?.speed,c=value?.context,w=value?.quota?.windows||[];
    buttons.error.hidden=!value?.failure;
    // Avoid a relational selector on the toolbar during streamed composer updates.
    strip.classList.toggle('has-error',!!value?.failure);
    if(value?.failure){
      buttons.error.textContent=errorLabel(value.failure);
      buttons.error.dataset.phase=value.failure.phase;
    }else if(active==='error')closeDetail();
    buttons.context.replaceChildren(dbIcon(),element('span','val',c?num(c.percent)+'%':'—'));
    buttons.context.style.color=c?.percent>=90?'#de786a':c?.percent>=75?'#dfab4a':'';
    const speedLabel=s?.kind==='toolPending'?'tool '+num(s.ms/1000)+'s':
      (s?.kind==='family'?'total ':s?.kind==='tool'?'tool ':'')+(s?speedNumber(s):'—')+' tok/s';
    buttons.speed.replaceChildren(element('span','val',speedLabel));
    buttons.speed.style.setProperty('--ink',s?.tps==null?'#94989d':s.tps>=25?'#45c368':s.tps>=10?'#dfab4a':'#de786a');
    buttons.speed.toggleAttribute('data-live',!!s?.live);
    const qNodes=[];
    for(const a of w){
      const item=element('span','q-item');
      item.title=a.minutes===300?'5h limit':'Weekly limit';
      item.append(ringIcon(a.remaining),element('span','val',a.remaining==null?'—':num(a.remaining)+'%'));
      qNodes.push(item);
    }
    if(value?.quota?.balance!=null)qNodes.push(element('span','q-bal',(w.length?'· ':'Balance ')+value.quota.balance));
    if(!qNodes.length){
      const item=element('span','q-item');
      item.append(ringIcon(null),element('span','val','—'));
      qNodes.push(item);
    }
    buttons.quota.replaceChildren(...qNodes);
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
    const mode=space>=210?'full':space>=150?'short':'scroll';
    if(mode!==sizeMode){sizeMode=mode;strip.classList.toggle('compact',mode!=='full')}
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
      .strip{position:absolute;left:3px;top:0;transform:translateY(-50%);width:max-content;display:flex;align-items:center;gap:2px;overflow:auto hidden;scrollbar-width:none;line-height:1.4;}
      .strip.compact{gap:0}
      button{flex:none;display:inline-flex;align-items:center;gap:5px;border:0;border-radius:6px;background:transparent;color:color-mix(in srgb,currentColor 72%,transparent);font:inherit;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;padding:2px 5px;line-height:18px;cursor:pointer;transition:color .14s ease,background-color .14s ease;}
      button svg{flex:none;display:block}
      .db-icon{opacity:.88}
      button[data-metric="context"]{padding-inline-end:3px}
      button[data-metric="speed"]{padding-inline-start:3px;gap:6px}
      button[data-metric="speed"]::before{content:"";display:inline-block;width:4px;height:4px;border-radius:50%;background:color-mix(in srgb,currentColor 45%,transparent);transition:background-color .14s ease}
      button[data-metric="speed"][data-live]::before{width:5px;height:5px;background:var(--ink,#45c368)}
      button[data-metric="quota"]{gap:10px;margin-inline-start:3px}
      .strip.compact button[data-metric="quota"]{gap:6px;margin-inline-start:0}
      .strip.compact button{padding:2px 3px}
      .q-item{display:inline-flex;align-items:center;gap:4px}
      @media(prefers-reduced-motion:no-preference){button[data-metric="speed"][data-live]::before{animation:pulse 1.5s ease-in-out infinite}@keyframes pulse{50%{opacity:.4}}}
      button:hover,button:focus-visible{color:currentColor;background:color-mix(in srgb,currentColor 7%,transparent)}
      button:focus-visible{outline:1px solid color-mix(in srgb,currentColor 35%,transparent)}
      button[hidden]{display:none}
      .strip.has-error button{padding-inline:3px}
      button[data-metric="error"]{--ink:#df7e78;gap:5px;color:color-mix(in srgb,#df7e78 90%,currentColor);background:color-mix(in srgb,#df7e78 12%,transparent)}
      button[data-metric="error"]::before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--ink)}
      button[data-phase="retry"]{--ink:#d9a44d;color:var(--ink);background:color-mix(in srgb,#d9a44d 12%,transparent)}
      [popover]{box-sizing:border-box;position:fixed;inset:auto;margin:0;min-width:min(210px,90vw);max-width:min(300px,94vw);max-height:calc(100vh - 35px);overflow-y:auto;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:10px;background:color-mix(in srgb,var(--color-background-elevated,Canvas) 94%,transparent);color:var(--color-text,CanvasText);padding:9px 12px;font:inherit;font-size:12px;line-height:1.45;backdrop-filter:blur(14px);box-shadow:0 6px 20px #0004}
      .heading{display:block;font-weight:550;font-size:13px;margin-bottom:5px}
      .quota-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}
      .quota-alert{width:5px;height:5px;border-radius:50%;background:#de786a;flex:none}
      .quota-list{display:grid;grid-template-columns:max-content max-content 52px max-content;column-gap:9px;row-gap:3px;justify-content:start;align-items:center}
      .quota-row{display:grid;grid-template-columns:subgrid;grid-column:1/-1;align-items:center;min-height:22px;font-variant-numeric:tabular-nums}
      .percent{text-align:right}.q-bar{display:flex;align-items:center;width:52px;height:4px;border-radius:99px;background:color-mix(in srgb,currentColor 18%,transparent);overflow:hidden}
      .q-fill{display:block;height:100%;border-radius:99px}
      .countdown,.window,.stamp{opacity:.74}.stamp,.evidence{border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);margin-top:7px;padding-top:5px}
      .stamp{font-size:11px}.evidence{display:block;font-size:11px;overflow-wrap:anywhere}.stage{margin-top:5px;font-size:12px;font-weight:550}
      .cache{padding-bottom:6px;margin-bottom:6px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}
      .speed-grid{display:grid;grid-template-columns:max-content max-content;gap:18px;padding:1px 0}
      .turn-output{display:flex;align-items:baseline;justify-content:space-between;gap:16px;font-size:12px;margin-bottom:2px}
      .turn-output b{font-variant-numeric:tabular-nums;font-weight:550}
      .speed-foot{opacity:1}.speed-foot>div:first-child{opacity:.86}
      .speed-stat,.ctx-entry{border-inline-start:2px solid var(--part);padding-inline-start:7px}
      .stat-label,.unit{font-size:11px;opacity:.72}.speed-value{display:flex;align-items:baseline;gap:2.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .speed-value b{font-size:15px;line-height:1.3;font-weight:600}
      [popover]:has(> .breakdown > .ctx-entry){width:min(268px,94vw)}
      .breakdown{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:14px;row-gap:7px;font-size:11px}
      .ctx-entry{box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;column-gap:6px;row-gap:1px;min-width:0;line-height:1.3}
      .ctx-entry>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.78}
      .ctx-entry b{text-align:right;font-weight:550;font-variant-numeric:tabular-nums}
      .ctx-entry small{grid-column:1/-1;font-size:inherit;opacity:.66;font-variant-numeric:tabular-nums}
      .attachments,.balance{margin:6px 0 0;font-size:11px;opacity:.76}
      .ctx-foot{margin-top:7px}
      .ctx-usage{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;font-variant-numeric:tabular-nums}
      .ctx-pct{color:color-mix(in srgb,currentColor 65%,transparent)}.ctx-pct b{font-weight:600;color:var(--color-text,CanvasText)}
      .ctx-cap{color:color-mix(in srgb,currentColor 65%,transparent)}
      .ctx-bar{display:flex;overflow:hidden;height:5px;border-radius:99px;background:color-mix(in srgb,currentColor 12%,transparent);margin:6px 0 9px}
      .ctx-fill{display:flex;gap:1.5px}.ctx-fill:empty{background:#82a6d9}.ctx-fill > span{flex-basis:0;min-width:0;border-radius:99px}
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
    if(!leading){host=null;root=null;footer=null;return}
    shadow.append(style,strip,pop);leading.append(host);id='';signature='';sizeMode='';draw(null);
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
      const f=[...document.querySelectorAll(':is([data-composer-placement="thread"],[data-composer-placement="home"]) [data-composer-footer-responsive]')].find(el=>alive(el)&&!!el.querySelector('[data-composer-leading-controls]')?.firstElementChild);
      if(!f){sizing?.disconnect();toolbarWatch?.disconnect();closeDetail();host?.remove();root?.removeAttribute('data-codex-capsule-question');host=null;root=null;footer=null;id='';return ''}
      mount(f);
    }
    const next=identity();
    if(next!==id){closeDetail();summaryWatch=null;id=next;if(host)host.dataset.thread=id;signature='';draw(null)}
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
    observedWait(expected,turn,sentAt){
      if(sync()!==expected||!sentAt)return null;
      const body=firstWatch?.key===expected+'/'+turn?firstWatch.wait:null;
      const at=summaryWatch?.thread===expected&&summaryWatch.turn===turn?summaryWatch.at:null;
      if(at>=sentAt&&(body==null||at-sentAt<body))return {ms:at-sentAt,source:'summaryDelta'};
      return body==null?null:{ms:body,source:'screen'};
    },
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
    dispose(){observer.disconnect();window.removeEventListener('message',watchSummary);window.removeEventListener('resize',reposition);window.removeEventListener('scroll',reposition,true);
      sizing?.disconnect();toolbarWatch?.disconnect();cancelAnimationFrame(layoutFrame);closeDetail();host?.remove();root?.removeAttribute('data-codex-capsule-question');questionStyle.remove();delete window[key]}
  };
  return true;
})();
