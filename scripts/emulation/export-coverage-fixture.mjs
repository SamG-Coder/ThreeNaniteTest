import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const out=process.argv[2],alpha=Number(process.argv[3]??.25);
if(!out||!Number.isFinite(alpha)||alpha<0||alpha>1)throw new Error('Usage: export-coverage-fixture.mjs OUT ALPHA');
execFileSync(process.execPath,['scripts/emulation/export-visibility-fixture.mjs',out]);
for(let i=0;i<2;i++){
 const file=`${out}/${i}-vertices.bin`,b=readFileSync(file),v=new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
 for(let j=0;j<6;j++)v[j*12+11]=alpha;
 writeFileSync(file,v);
}
const file=`${out}/manifest.json`,m=JSON.parse(readFileSync(file));m.coverageFixture=alpha;writeFileSync(file,JSON.stringify(m,null,2));
