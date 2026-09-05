// Keep the phone-tested original as default; old comparison URLs still work.
export function rasterVariant(search='') {
  const params=new URLSearchParams(search);
  const requested=params.get('bitmaskVariant');
  if(['original','owned','cached','reject','bounded'].includes(requested))return requested;
  return params.get('bitmaskReference')==='0'?'cached':'original';
}
export const rasterVariantLabels={bounded:'visible dispatch + pixel bounds',reject:'tile rejection',original:'original',owned:'triangle-owned masks',cached:'depth cache (slower on tested phone)'};
