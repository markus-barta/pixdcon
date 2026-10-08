// INSPR-CalVer3 display-only policy (INSPR-486). The canonical grammar
// YYMMDDhhmmss.0.0 is unchanged; Pretty draws six segments and never the
// decorative v or the .0.0 tail.
export const schema = 'inspr.calver-display.v3';
export const scheme = 'inspr-calver-3';
// Schemes sharing the canonical coordinate. inspr-calendar-v2 is the
// predecessor with the identical grammar; its history stays valid.
export const calendarSchemes = Object.freeze(['inspr-calver-3','inspr-calendar-v2']);
export const segments = Object.freeze(['yy','mm','dd','hh','mi','ss']);
// One separator slot after every segment; the one after ss trails the seconds.
export const boundaries = segments;
export const fixed = Object.freeze({
  design_revision:4,
  floor:{yy:0},
  tint:{segments:['yy','mm','dd'],space:'oklab'},
  typography:{family:'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',numeric:'tabular-nums'},
  css:{class:'cv3',properties:{yy:'--o-yy',mm:'--o-mm',dd:'--o-dd',hh:'--o-hh',mi:'--o-mi',ss:'--o-ss',tint:'--cv3-tint',mix:'--cv3-mix'}},
});
// Families a config may choose; the first is the default look (INSPR-486).
export const typographyFamilies = Object.freeze([fixed.typography.family,'ui-monospace,SFMono-Regular,Menlo,monospace']);
export const separatorDefaults = Object.freeze({text:'',placement:'inline',paddingLeft:0,paddingRight:0,color:'auto',size:1,offsetX:0,offsetY:0});
export const validColor = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const storedColor = value => value === 'auto' || (typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value));
export const validSeparator = value => typeof value === 'string' && [...value].length <= 32 && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff؜‎‏‪-‮⁦-⁩]/u.test(value);
const hundredth = (value,min,max) => Number.isFinite(value) && value >= min && value <= max && Math.abs(value*100-Math.round(value*100)) <= 1e-9;
export const validPadding = value => hundredth(value,0,2);
export const validOffset = value => hundredth(value,-2,2);
export const validSize = value => hundredth(value,.1,3);
const validWeight = value => Number.isFinite(value) && value >= 0 && value <= 1;
// A segment at 0 % rest opacity takes no width at rest. A separator collapses
// with the segment before it, or when every later segment is collapsed, so no
// separator dangles at either end or doubles up in the middle.
export function collapsedKeys(weights) {
  const hidden = new Set(segments.filter(key => weights?.[key] === 0));
  const separators = new Set(segments.filter((key,i) => hidden.has(key)
    || (i < segments.length-1 && segments.slice(i+1).every(next => hidden.has(next)))));
  return {segments:hidden,separators};
}
// Completes a draft for editing and migrates v1/v2 presentation data to v3:
// v/tail weights, colors and the v separator are dropped; the old ss separator
// (between seconds and tail) becomes the trailing seconds separator. Fixed
// fields always take the v3 values. Servers never normalize; writes stay strict.
export function normalizeConfig(input) {
  const source = structuredClone(input ?? {});
  const color = value => typeof value==='string'?value.toLowerCase():value;
  const weight = key => validWeight(source.weights?.[key]) ? source.weights[key] : 1;
  return {
    schema, scheme,
    design_revision:fixed.design_revision,
    segments:[...segments],
    weights:Object.fromEntries(segments.map(key=>[key,weight(key)])),
    floor:{...fixed.floor},
    tint:{segments:[...fixed.tint.segments],mix:Number.isFinite(source.tint?.mix)?source.tint.mix:.8,space:fixed.tint.space,
      default:typeof source.tint?.default==='string'?source.tint.default:'#d69b31',mode:source.tint?.mode==='custom'?'custom':'auto'},
    typography:{family:typographyFamilies.includes(source.typography?.family)?source.typography.family:fixed.typography.family,numeric:fixed.typography.numeric},
    css:structuredClone(fixed.css),
    pretty:{
      separators:Object.fromEntries(boundaries.map(key=>[key,Object.fromEntries(Object.entries(separatorDefaults).map(([field,fallback])=>[field,field==='color'?color(source.pretty?.separators?.[key]?.[field]??fallback):source.pretty?.separators?.[key]?.[field]??fallback]))])),
      colors:Object.fromEntries(segments.map(key=>[key,color(source.pretty?.colors?.[key]??'auto')])),
    },
  };
}
export function validPresentation(config) {
  return config?.schema===schema && config.scheme===scheme && typographyFamilies.includes(config.typography?.family)
    && segments.every(key=>validWeight(config.weights?.[key]))
    && ['auto','custom'].includes(config.tint?.mode) && /^#[0-9a-f]{6}$/.test(config.tint.default)
    && Number.isFinite(config.tint.mix)&&config.tint.mix>=0&&config.tint.mix<=1
    && boundaries.every(key=>{
      const b=config.pretty?.separators?.[key];
      return b && Object.keys(b).length===8 && Object.keys(separatorDefaults).every(k=>Object.hasOwn(b,k))
        && validSeparator(b.text)&&['inline','sup','sub'].includes(b.placement)
        && validPadding(b.paddingLeft)&&validPadding(b.paddingRight)&&storedColor(b.color)
        && validSize(b.size)&&validOffset(b.offsetX)&&validOffset(b.offsetY);
    }) && segments.every(key=>storedColor(config.pretty?.colors?.[key]));
}
