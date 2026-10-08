import {attachVersionInteraction} from './version-interaction.js';
import {calendarSchemes,segments,collapsedKeys,validSeparator,validPadding,validColor,validSize,validOffset} from './presentation.js';
const instances=new WeakMap();
export function disposeVersion(element){instances.get(element)?.controller?.dispose();instances.delete(element);}
// Parses the canonical coordinate for inspr-calver-3 and its identical-grammar
// predecessor inspr-calendar-v2. Every other scheme renders as plain text.
export function parts(value, scheme) {
  if (!calendarSchemes.includes(scheme)) return null;
  const match = /^(v?)([1-9][0-9])(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])([01][0-9]|2[0-3])([0-5][0-9])([0-5][0-9])(\.0\.0)$/.exec(value);
  if (!match) return null;
  const [, v, yy, mm, dd, hh, mi, ss, tail] = match;
  const date = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd)));
  if (date.getUTCMonth() + 1 !== Number(mm) || date.getUTCDate() !== Number(dd)) return null;
  return {v, yy, mm, dd, hh, mi, ss, tail};
}
export const utcLabel = ({yy,mm,dd,hh,mi,ss}) => `20${yy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
const monospace='ui-monospace,SFMono-Regular,Menlo,monospace';
// A zero rest-opacity element takes no width until revealed.
function collapse(node,inline=true){
  node.dataset.collapsed='true';node.style.opacity='0';
  if(inline)Object.assign(node.style,{display:'inline-block',maxWidth:'0px',overflow:'hidden',verticalAlign:'bottom'});
}
// All presentation styles live in this renderer, also used by portable export.
export function renderVersion(element,value,scheme,{config,mode='reduced',brand='#d69b31',interactive=true,text}={}) {
  const signature=JSON.stringify([value,scheme,config,mode,brand,interactive,text]);
  if(instances.get(element)?.signature===signature)return;
  disposeVersion(element);
  element.replaceChildren();element.classList.add('coordinate');
  for(const name of ['aria-label','role','title'])element.removeAttribute(name);
  const canonical=String(value).replace(/^v/,'');
  element.dataset.canonical=canonical;
  const parsed=parts(value,scheme);
  const pretty=mode==='pretty'&&parsed?config?.pretty:null;
  Object.assign(element.style,{fontFamily:pretty&&typeof config?.typography?.family==='string'?config.typography.family:monospace,fontVariantNumeric:'tabular-nums',whiteSpace:'pre',letterSpacing:'0',fontWeight:'inherit'});
  if(!parsed){element.textContent=value;return;}
  const weight=key=>{const w=config?.weights?.[key];return Number.isFinite(w)&&w>=0&&w<=1?w:null;};
  if(!pretty){
    // Reduced (SemVer) display: the complete canonical text, fully visible and
    // independent of the Pretty weights (INSPR-486).
    for(const [key,digits] of Object.entries(parsed)){
      if(!digits)continue;
      const span=document.createElement('span');span.className=key;span.textContent=digits;
      element.append(span);
    }
    return;
  }
  // Pretty: six segments. The v prefix and the .0.0 tail are never drawn;
  // the accessible name and tooltip carry the full canonical version.
  const label=`${canonical} · ${utcLabel(parsed)}`;
  element.setAttribute('role','img');element.setAttribute('aria-label',label);element.setAttribute('title',label);
  const tint=config?.tint?.mode==='auto'?brand:config?.tint?.default;
  const collapsed=collapsedKeys(config?.weights);
  for(const key of segments) {
    const digit=document.createElement('span');digit.className=key;digit.textContent=parsed[key];digit.setAttribute('aria-hidden','true');
    if(weight(key)!==null)digit.style.opacity=String(weight(key));
    const color=pretty.colors?.[key];
    if(validColor(color))digit.style.color=color;
    else if(['yy','mm','dd'].includes(key)&&validColor(tint)&&Number.isFinite(config?.tint?.mix))digit.style.color=`color-mix(in oklab,currentColor,${tint} ${Math.max(0,Math.min(1,config.tint.mix))*100}%)`;
    if(collapsed.segments.has(key))collapse(digit);
    element.append(digit);
    const b=pretty.separators?.[key];
    if(!b||!validSeparator(b.text))continue;
    const floating=['sup','sub'].includes(b.placement);
    const separator=document.createElement('span');separator.className='separator';separator.setAttribute('aria-hidden','true');separator.dataset.placement=floating?b.placement:'inline';
    // Outer carrier inherits parent font size, so offsets and padding stay in
    // parent em even when only the nested glyph is scaled. Transforms never advance text.
    Object.assign(separator.style,{display:'inline-block',position:'relative',verticalAlign:'baseline',fontSize:'inherit',lineHeight:'inherit',whiteSpace:'pre',transform:`translate(${validOffset(b.offsetX)?b.offsetX:0}em,${validOffset(b.offsetY)?b.offsetY:0}em)`});
    if(floating)Object.assign(separator.style,{width:'0',height:'0',overflow:'visible'});
    separator.style.color=validColor(b.color)?b.color:validColor(brand)?brand:'currentColor';
    const anchor=document.createElement('span');anchor.className='separator-anchor';
    Object.assign(anchor.style,{display:'inline-block',fontSize:'inherit',paddingLeft:`${validPadding(b.paddingLeft)?b.paddingLeft:0}em`,paddingRight:`${validPadding(b.paddingRight)?b.paddingRight:0}em`});
    if(floating)Object.assign(anchor.style,{position:'absolute',left:'0',transform:'translateX(-50%)',whiteSpace:'pre',lineHeight:'1',...(b.placement==='sup'?{bottom:'.65em'}:{top:'.25em'})});
    const glyph=document.createElement('span');glyph.className='separator-glyph';glyph.textContent=b.text;glyph.style.fontSize=`${(validSize(b.size)?b.size:1)*100}%`;
    anchor.append(glyph);separator.append(anchor);
    if(collapsed.separators.has(key))collapse(separator,!floating);
    element.append(separator);
  }
  if(interactive&&typeof element.getBoundingClientRect==='function'){const controller=attachVersionInteraction(element,canonical,{label,text});instances.set(element,{signature,controller});}
}
export function portableHTML(value,scheme,options={}) {
  const element=document.createElement('span');renderVersion(element,value,scheme,{...options,interactive:false});
  // Native DOM serialization escapes arbitrary Unicode text and HTML metacharacters.
  for(const child of [element,...element.querySelectorAll('*')])child.removeAttribute('class');
  element.removeAttribute('data-canonical');
  return element.outerHTML;
}
