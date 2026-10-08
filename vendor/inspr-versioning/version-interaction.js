// INSPR-CalVer3 reveal and copy (INSPR-486). Hover, keyboard focus or a tap
// reveals: every segment shows at 0.7 + 0.3 * rest opacity and zero-width rest
// segments grow to their natural width. Plain CSS transitions on opacity and
// max-width carry the shared ~1 s ease-in-out; reduced motion switches at once.
export const hoverOpacity = weight => .70+.30*(Number.isFinite(weight)?Math.max(0,Math.min(1,weight)):1);
export const duration=1000;
// Touch confirmation, after which a tapped version returns to rest.
export const confirmation=2000;
const words={copy:'Version kopieren',copied:'Kopiert',failed:'Kopieren nicht verfügbar. Die Version ist markiert: mit ⌘C oder Strg+C kopieren.'};
const touchLike=type=>type==='touch'||type==='pen';

export function attachVersionInteraction(host,canonical,{view=globalThis,label=canonical,text}={}) {
  const say={...words,...(text||{})};
  const doc=host.ownerDocument||document,originalStyle=host.getAttribute('style');
  const attributes=Object.fromEntries(['role','tabindex','aria-label','title'].map(name=>[name,host.getAttribute(name)]));
  const items=[...host.children].map(node=>({node,separator:node.className==='separator',collapsed:node.dataset?.collapsed==='true',
    rest:{opacity:node.style.opacity||'',maxWidth:node.style.maxWidth||'',transition:node.style.transition||'',userSelect:node.style.userSelect||''}}));
  host.setAttribute('role','button');host.setAttribute('tabindex','0');host.setAttribute('aria-label',`${label} — ${say.copy}`);host.setAttribute('title',label);
  Object.assign(host.style,{display:'inline-block',position:'relative',cursor:'pointer',userSelect:'text',outlineOffset:'4px'});
  const feedback=doc.createElement('span');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
  Object.assign(feedback.style,{position:'absolute',bottom:'100%',left:'0',fontFamily:'system-ui,sans-serif',fontSize:'12px',fontWeight:'400',lineHeight:'1.5',whiteSpace:'normal',padding:'3px 7px',borderRadius:'4px',background:'#17304a',color:'#fff',pointerEvents:'none',zIndex:'2'});
  feedback.hidden=true;host.append(feedback);
  let hovered=false,focused=false,down=false,held=false,dragged=false,pointer=false,revealed=false,disposed=false,timer=null,copySerial=0,start=null;
  const listeners=[];
  const media=view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced=()=>media?.matches===true;
  const listen=(target,type,fn)=>{target.addEventListener(type,fn);listeners.push(()=>target.removeEventListener(type,fn));};
  const selected=()=>{const s=doc.getSelection?.();return Boolean(s&&!s.isCollapsed&&(host.contains(s.anchorNode)||host.contains(s.focusNode)));};
  function motion(target,immediate=false){
    if(disposed)return;
    if(target===revealed&&!immediate)return;
    revealed=target;host.dataset.versionView=target?'revealed':'pretty';
    const transition=reduced()||immediate?'none':`opacity ${duration}ms ease-in-out, max-width ${duration}ms ease-in-out`;
    for(const {node,separator,collapsed,rest} of items){
      node.style.transition=transition;
      if(separator){node.style.userSelect='none';if(collapsed)node.style.opacity=target?'1':rest.opacity;}
      else node.style.opacity=target?String(hoverOpacity(rest.opacity===''?1:Number(rest.opacity))):rest.opacity;
      if(collapsed&&rest.maxWidth){
        // Grow to the measured natural width so the width change can transition.
        const width=Number(node.scrollWidth);
        node.style.maxWidth=target?(width>0?`${width}px`:'none'):rest.maxWidth;
      }
    }
  }
  const settle=()=>motion(hovered||focused||down||held||selected(),selected());
  function release(){if(!held)return;held=false;settle();}
  listen(host,'pointerenter',e=>{hovered=!touchLike(e.pointerType);settle();});listen(host,'pointerleave',()=>{hovered=false;settle();});
  // Only keyboard-visible focus reveals; a tap or click focuses too, after pointerup.
  const focusVisible=()=>{try{if(typeof host.matches==='function')return host.matches(':focus-visible');}catch{}return !down&&!pointer;};
  listen(host,'focus',()=>{focused=focusVisible();host.style.outline=focused?'2px solid currentColor':'';settle();});
  listen(host,'blur',()=>{focused=false;host.style.outline='';settle();});
  listen(host,'pointerdown',e=>{down=true;pointer=true;dragged=false;start={x:e.clientX,y:e.clientY};if(touchLike(e.pointerType))held=true;motion(true);});
  listen(host,'pointermove',e=>{if(down&&start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>4){dragged=true;motion(true,true);}});
  listen(doc,'pointerdown',e=>{if(held&&!host.contains(e.target)){view.clearTimeout(timer);release();}});
  listen(doc,'pointerup',()=>{down=false;if(dragged)held=false;settle();});listen(doc,'pointercancel',()=>{down=false;dragged=true;held=false;settle();});
  listen(doc,'selectionchange',settle);
  function clearFeedback(){feedback.hidden=true;feedback.textContent='';feedback.style.pointerEvents='none';}
  // Fallback for a missing or rejected Clipboard API: a hidden textarea holding
  // the canonical value, copied with execCommand. Reports whether it worked.
  function legacyCopy(){
    const area=doc.createElement('textarea');let ok=false;
    try{
      Object.assign(area,{value:canonical,readOnly:true});area.setAttribute('aria-hidden','true');
      Object.assign(area.style,{position:'fixed',top:'0',left:'0',width:'1px',height:'1px',opacity:'0',pointerEvents:'none'});
      (doc.body||host).append(area);area.select();ok=doc.execCommand?.('copy')===true;
    }catch{ok=false;}
    area.remove();return ok;
  }
  // Clicks and keys inside the fallback field must not start another copy.
  const inFeedback=e=>Boolean(e?.target&&e.target!==host&&feedback.contains?.(e.target));
  async function copy(){
    if(disposed)return;
    if(selected()||dragged){if(held){view.clearTimeout(timer);timer=view.setTimeout(release,confirmation);}return;}
    const serial=++copySerial;view.clearTimeout(timer);clearFeedback();host.dataset.copyState='copying';
    let copied=false;
    try{await view.navigator.clipboard.writeText(canonical);copied=true;}catch{copied=legacyCopy();}
    if(disposed||serial!==copySerial)return;
    feedback.hidden=false;
    if(copied){
      host.dataset.copyState='copied';feedback.textContent=say.copied;
      timer=view.setTimeout(()=>{clearFeedback();delete host.dataset.copyState;release();},confirmation);
      return;
    }
    // Last resort: the canonical text, selected, so the user can copy it by hand.
    // Selecting the Pretty text would lose .0.0, so it is never offered.
    host.dataset.copyState='error';feedback.textContent=say.failed;feedback.style.pointerEvents='auto';
    const field=doc.createElement('input');
    Object.assign(field,{type:'text',readOnly:true,value:canonical});field.setAttribute('aria-label',canonical);field.setAttribute('size',String(canonical.length));
    Object.assign(field.style,{display:'block',marginTop:'4px',font:'12px ui-monospace,SFMono-Regular,Menlo,monospace',color:'#17304a',background:'#fff',border:'0',borderRadius:'3px',padding:'2px 4px'});
    field.addEventListener('blur',()=>{if(host.dataset.copyState==='error'){clearFeedback();delete host.dataset.copyState;release();}});
    feedback.append(field);field.focus();field.select();
  }
  listen(host,'click',e=>{if(!inFeedback(e))void copy();});listen(host,'keydown',e=>{if(inFeedback(e))return;pointer=false;if(!focused&&doc.activeElement===host){focused=true;host.style.outline='2px solid currentColor';settle();}if(e.key==='Enter'||e.key===' '){e.preventDefault();if(!e.repeat){dragged=false;void copy();}}});
  if(media?.addEventListener)listen(media,'change',()=>motion(revealed,true));
  host.dataset.versionView='pretty';
  return {dispose(){
    if(disposed)return;disposed=true;++copySerial;view.clearTimeout(timer);listeners.forEach(remove=>remove());
    for(const {node,rest} of items)Object.assign(node.style,rest);
    feedback.remove();
    for(const [name,value] of Object.entries(attributes))if(value===null)host.removeAttribute(name);else host.setAttribute(name,value);
    if(originalStyle===null)host.removeAttribute('style');else host.setAttribute('style',originalStyle);
    delete host.dataset.versionView;delete host.dataset.copyState;
  },revealed:()=>revealed};
}
