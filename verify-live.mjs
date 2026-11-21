// Interactive regression: switches two real sidebar chats and restores the original.
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {pages,connect} from './cdp.mjs';
import {LocalMetrics} from './metrics.mjs';
import path from 'node:path';
import os from 'node:os';
const local=new LocalMetrics(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),process.env.APPDATA);
const sym="window[Symbol.for('codex-capsule.local.v1')]";
let verified=false;
for(const p of await pages()){
  const c=await connect(p);
  const evaluate=(fn,...args)=>c.evaluate('('+fn+')('+args.map(v=>JSON.stringify(v)).join(',')+')');
  const move=(x,y)=>c.call('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  const current=()=>c.evaluate(sym+'?.current()');
  const route=id=>evaluate((id)=>{
    const row=[...document.querySelectorAll('[data-app-action-sidebar-thread-row]')].find(e=>e.dataset.appActionSidebarThreadId==='local:'+id&&e.offsetWidth);
    if(!row)return false;row.click();return true;
  },id);
  async function ready(id){
    for(let i=0;i<32;i++){
      if(await current()===id){
        const seen=await evaluate(()=>{
          const h=[...document.querySelectorAll('[data-codex-capsule]')].find(e=>e.shadowRoot?.querySelector('.strip')?.offsetWidth);
          const b=h?.shadowRoot?.querySelector('[data-metric=context]');return [h?.dataset.thread,b?.textContent];
        });
        const data=await local.read(id);
        if(seen[0]===id && data.context && seen[1]?.includes(new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(data.context.percent)+'%'))return;
      }
      await sleep(220);
    }
    throw Error('Active composer/visible context did not match the selected rollout');
  }
  try{
    const a=await current();if(!a||a==='home')continue;
    const choices=await evaluate(()=>[...new Set([...document.querySelectorAll('[data-app-action-sidebar-thread-row]')]
      .filter(e=>e.offsetWidth&&e.dataset.appActionSidebarThreadId?.startsWith('local:'))
      .map(e=>e.dataset.appActionSidebarThreadId.slice(6)))]);
    const aUsage=(await local.read(a)).context;
    let b;
    for(const id of choices){if(id!==a){const val=(await local.read(id)).context;if(val&&val.percent!==aUsage?.percent){b=id;break}}}
    assert.ok(b&&choices.includes(a),'Two distinct indexed sidebar chats are required');
    try{
      await ready(a);assert.ok(await route(b));await ready(b);
      assert.equal(await c.evaluate(sym+'.apply('+JSON.stringify(a)+',{})'),false);
      assert.ok(await route(a));await ready(a);
      console.log('PASS real A → B → A, independent log matches and stale A result rejected in B');
      const capture=()=>evaluate(()=>{
        const h=[...document.querySelectorAll('[data-codex-capsule]')].find(e=>e.shadowRoot?.querySelector('.strip')?.offsetWidth);
        const f=h.closest('[data-composer-footer-responsive]'),sh=h.shadowRoot,b=f.closest('[data-composer-body]'),outer=b.parentElement;
        const left=f.querySelector('[data-composer-navigation-target=permissions]'),right=f.querySelector('[data-composer-navigation-target=reasoning]');
        const rect=e=>{const r=e.getBoundingClientRect();return {l:r.left,r:r.right,y:r.top+r.height/2,w:r.width}};
        const caret=b.querySelector('[data-woodfish-caret]'),cr=caret?.getBoundingClientRect(),br=b.getBoundingClientRect();
        return {strip:rect(sh.querySelector('.strip')),left:rect(left),right:rect(right),
          shadow:getComputedStyle(outer).boxShadow,focused:outer.matches(':focus-within'),
          caret:!!cr&&cr.height>0&&cr.left>=br.left&&cr.right<=br.right&&cr.top>=br.top&&cr.bottom<=br.bottom,
          metrics:[...sh.querySelectorAll('button')].map(e=>e.textContent),
          hoverPoint:rect(sh.querySelector('button:not([hidden])')),add:rect(f.querySelector('[data-composer-navigation-target=add-context]'))};
      });
      const editor=action=>evaluate(action=>{
        const e=[...document.querySelectorAll('[data-composer-body] [contenteditable=true]')].find(e=>e.offsetWidth);
        if(action==='focus')e.focus({preventScroll:true});else document.activeElement?.blur();
      },action);
      await editor('blur');const idle=await capture();await editor('focus');await sleep(500);const active=await capture();
      assert.ok(active.focused&&active.caret&&active.shadow!==idle.shadow,'Woodfish caret and focus glow');
      const bounds=s=>assert.ok(s.strip.w>0&&s.strip.l>=s.left.r-1&&s.strip.r<=s.right.l+1&&Math.abs(s.strip.y-s.left.y)<5,'same-row geometry');
      bounds(active);
      await move(active.hoverPoint.l+6,active.hoverPoint.y);await sleep(250);
      assert.equal(await evaluate(()=>!![...document.querySelectorAll('[data-codex-capsule]')].find(h=>h.shadowRoot.querySelector(':popover-open'))),true);
      await move(active.add.l+active.add.w/2,active.add.y);await sleep(1050);
      assert.ok(await evaluate(()=>[...document.querySelectorAll('[data-radix-popper-content-wrapper],[role=tooltip]')].some(e=>e.getBoundingClientRect().height>4&&/添加文件|add files/i.test(e.textContent))),'Native tooltip');
      await move(active.strip.l-45,active.strip.y-50);
      try{
        await evaluate(()=>{const style=document.createElement('style');style.id='cc-verify-width';style.textContent='[data-composer-placement="thread"] {max-width:540px!important}';document.head.append(style)});
        await sleep(450);bounds(await capture());
      }finally{await evaluate(()=>document.getElementById('cc-verify-width')?.remove())}
      console.log('PASS same-row bounds at normal / 540px composer, native tooltip, Capsule panel, Woodfish caret and focus glow');
      verified=true;
    }finally{if(await current()!==a){assert.ok(await route(a));await ready(a)}}
    break;
  }finally{c.close()}
}
assert.ok(verified,'No visible Codex chat tested');
