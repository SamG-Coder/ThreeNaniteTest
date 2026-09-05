export const TILE_SIZE = 8;
export const MASK_WORDS = 4;
export const CANDIDATE_CAPACITY = MASK_WORDS * 32;
export const EMPTY_ID = 0xffffffff;

export function edge(a, b, p) {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}
function topLeft(a, b) {
  return b[1] < a[1] || (b[1] === a[1] && b[0] > a[0]);
}
// Screen coordinates have Y down. Match GPU coverage: positive area, pixel
// centres, and exactly one owner for a shared edge. Returns -1 for no sample.
export function sampleDepth(triangle, pixel) {
  let [a, b, c] = triangle;
  let area = edge(a, b, c);
  if (Math.abs(area) < 1e-8) return -1;
  if (area < 0) { [b, c] = [c, b]; area = -area; }
  const e = [edge(b, c, pixel), edge(c, a, pixel), edge(a, b, pixel)];
  const pairs = [[b, c], [c, a], [a, b]];
  if (e.some((v, i) => v < 0 || (v === 0 && !topLeft(...pairs[i])))) return -1;
  const depth = (e[0] * a[2] + e[1] * b[2] + e[2] * c[2]) / area;
  return depth >= 0 && depth <= 1 ? depth : -1;
}
export function collectMask(triangles, ids, pixel) {
  const mask = new Uint32Array(MASK_WORDS);
  ids.slice(0, CANDIDATE_CAPACITY).forEach((id, slot) => {
    if (sampleDepth(triangles[id], pixel) >= 0) mask[slot >>> 5] |= 1 << (slot & 31);
  });
  return mask;
}
export function resolveReference(triangles, ids, pixel) {
  let depth = 1, id = EMPTY_ID;
  for (const candidate of ids) {
    const z = sampleDepth(triangles[candidate], pixel);
    if (z >= 0 && (z < depth || (z === depth && candidate < id))) { depth = z; id = candidate; }
  }
  return { depth, id };
}
export function resolveMask(triangles, ids, pixel) {
  if (ids.length > CANDIDATE_CAPACITY) {
    return resolveReference(triangles, triangles.map((_, i) => i), pixel);
  }
  const mask = collectMask(triangles, ids, pixel);
  return resolveReference(triangles, ids.filter((_, slot) => ((mask[slot >>> 5] >>> (slot & 31)) & 1) !== 0), pixel);
}

// Forest path retains the winner between 32-candidate batches.
export function resolveBatches(triangles, ids, pixel) {
  let best={depth:1,id:EMPTY_ID};
  for(let offset=0;offset<ids.length;offset+=32) {
    const next=resolveMask(triangles,ids.slice(offset,offset+32),pixel);
    if(next.depth<best.depth||(next.depth===best.depth&&next.id<best.id))best=next;
  }
  return best;
}
export function clipNearPlane(points) {
  const clipped=[];
  for(let i=0;i<3;i++) {
    const a=points[i],b=points[(i+1)%3];
    if(a[2]>=0)clipped.push([...a]);
    if((a[2]>0&&b[2]<0)||(a[2]<0&&b[2]>0)) {
      const t=a[2]/(a[2]-b[2]);
      const p=a.map((v,j)=>v+(b[j]-v)*t);p[2]=0;clipped.push(p);
    }
  }
  return clipped;
}
