// Bound secondary-ray work independently of the main scene's pixel count.
export const lightingBudgets={fast:8192,balanced:16384,high:65536};
export function lightingResolution(width,height,quality='balanced'){
 const w=Math.max(1,Math.ceil(width/4)),h=Math.max(1,Math.ceil(height/4));
 const scale=Math.min(1,Math.sqrt((lightingBudgets[quality]??lightingBudgets.balanced)/(w*h)));
 return [Math.max(1,Math.floor(w*scale)),Math.max(1,Math.floor(h*scale))];
}
