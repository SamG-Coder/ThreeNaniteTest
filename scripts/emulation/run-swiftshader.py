"""Execute forest raster WGSL on a software Vulkan adapter, not phone timing.
Set VK_ICD_FILENAMES to an installed software adapter ICD before running.
SwiftShader exposes 10 storage buffers/stage: merge the two Vertex arrays
without changing arithmetic, ordering, source records or any raster entrypoint.
"""
import argparse, hashlib, json, re, struct, time, statistics, math
from pathlib import Path
import wgpu
p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--variants',default='original,owned,cached,reject');p.add_argument('--stats',type=int,default=0);p.add_argument('--empty-bounds',action='store_true');p.add_argument('--dispatch',choices=['capacity','visible','indirect','production'],default='capacity');p.add_argument('--samples',type=int,default=5);p.add_argument('--warmup',type=int,default=2);p.add_argument('--output');args=p.parse_args()
if args.samples<1 or args.warmup<0:p.error('samples must be positive and warmup nonnegative')
root=Path(args.directory);manifest=json.loads((root/'manifest.json').read_text())
adapters=wgpu.gpu.enumerate_adapters_sync()
if not adapters:raise RuntimeError('No software GPU adapter installed')
adapter=next((a for a in adapters if a.info['adapter_type']=='CPU'),None)
if adapter is None:raise RuntimeError('This harness requires an explicitly available CPU/software adapter')
print(dict(adapter.info),flush=True)
device=adapter.request_device_sync(required_features=['timestamp-query'],required_limits={'max-storage-buffers-per-shader-stage':10})
S=wgpu.BufferUsage.STORAGE;COPY=wgpu.BufferUsage.COPY_DST|wgpu.BufferUsage.COPY_SRC
make=lambda data,usage:device.create_buffer_with_data(data=data,usage=usage)
static={};vertices=(root/'0-vertices.bin').read_bytes();offset=len(vertices)//48
static[1]=make(vertices+(root/'1-vertices.bin').read_bytes(),S)
for binding,name in [(2,'0-indices'),(3,'0-matrices'),(4,'0-visible'),(6,'1-indices'),(7,'1-matrices'),(8,'1-visible')]:static[binding]=make((root/(name+'.bin')).read_bytes(),S)
counts=[len((root/(str(a)+'-visible.bin')).read_bytes())//8 for a in range(2)]
width,height=manifest['width'],manifest['height'];tx,ty=(width+7)//8,(height+7)//8
query=device.create_query_set(type='timestamp',count=8);query_buffer=device.create_buffer(size=256,usage=wgpu.BufferUsage.QUERY_RESOLVE|wgpu.BufferUsage.COPY_SRC)
report={'adapter':dict(adapter.info),'manifest':manifest,'layoutAdaptation':'Terrain/tree Vertex arrays concatenated to fit 10 storage bindings; source shader arithmetic unchanged','stats':args.stats,'dispatch':args.dispatch,'emptyBoundsExperiment':args.empty_bounds,'stageNames':['clear','bin','raster','dispatchArgs'],'warmup':args.warmup,'samples':args.samples,'limitations':['Software Vulkan timings are not phone GPU timings','Selection is a separately timed CPU equivalent, not the Three GPU selection shader','Scene/asset construction is startup work; excluded from raster timings','No sky/water, Three presentation or hardware raster baseline','Depth/ID comparisons do not establish shading parity with hardware'],'runs':[]};baseline=None
for variant in args.variants.split(','):
 dispatch=('indirect' if variant=='bounded' else 'capacity') if args.dispatch=='production' else args.dispatch
 code=(root/(variant+'.wgsl')).read_text();original_hash=hashlib.sha256(code.encode()).hexdigest()
 code=re.sub(r'@group\(0\) @binding\(5\) var<storage,read> bv:array<Vertex>;','',code)
 for index in ['base','base+1u','base+2u']:code=code.replace('bv[bi['+index+']]',f'av[bi[{index}]+{offset}u]')
 if args.empty_bounds:
  a=code.index('fn bin(');prefix=code[:a];body=code[a:];needle='  let maxTile=vec2<f32>'
  body=body.replace(needle,'  if(any(ceil(lo-vec2<f32>(.5))>floor(hi-vec2<f32>(.5)))){return;}\n'+needle,1);code=prefix+body
 (root/(variant+'-packed.wgsl')).write_text(code)
 print('Compiling',variant,flush=True);start=time.monotonic();module=device.create_shader_module(code=code)
 pipelines={name:device.create_compute_pipeline(layout='auto',compute={'module':module,'entry_point':name}) for name in ['clear','bin','raster']}
 print('Compiled in',round(time.monotonic()-start,2),'seconds',flush=True)
 params=bytearray((root/'params.bin').read_bytes());struct.pack_into('<I',params,120,args.stats)
 total=sum(manifest['capacity']) if dispatch in ['capacity','indirect'] else sum(counts);dispatch_width=min(total,65535);struct.pack_into('<I',params,124,dispatch_width)
 uniform=make(params,wgpu.BufferUsage.UNIFORM);control=make(struct.pack('<16I',*counts,*([0]*14)),S|COPY)
 heads=device.create_buffer(size=tx*ty*(36 if variant=='reject' else 8),usage=S);entries=device.create_buffer(size=8388608*8,usage=S)
 textures=[device.create_texture(size=(width,height,1),format=f,usage=wgpu.TextureUsage.STORAGE_BINDING|wgpu.TextureUsage.COPY_SRC) for f in ['r32float','r32uint','rgba16float']]
 bindings={0:uniform,**static,9:heads,10:entries,11:control};groups={}
 for name in pipelines:
  selected=[0,9,11] if name=='clear' else sorted(bindings)
  specs=[{'binding':i,'resource':{'buffer':bindings[i]}} for i in selected]
  if name=='raster':specs += [{'binding':12+i,'resource':t.create_view()} for i,t in enumerate(textures)]
  groups[name]=device.create_bind_group(layout=pipelines[name].get_bind_group_layout(0),entries=specs)
 indirect=None
 if dispatch=='indirect':
  indirect=device.create_buffer(size=12,usage=S|wgpu.BufferUsage.INDIRECT|wgpu.BufferUsage.COPY_SRC)
  dispatch_module=device.create_shader_module(code=(root/'dispatch.wgsl').read_text())
  dispatch_pipeline=device.create_compute_pipeline(layout='auto',compute={'module':dispatch_module,'entry_point':'prepareDispatch'})
  dispatch_group=device.create_bind_group(layout=dispatch_pipeline.get_bind_group_layout(0),entries=[{'binding':i,'resource':{'buffer':b}} for i,b in enumerate([uniform,control,indirect])])
 elapsed=[]
 for iteration in range(args.warmup+args.samples):
  encoder=device.create_command_encoder()
  for i,name in enumerate(pipelines):
   if name=='bin' and indirect is not None:
    prep=encoder.begin_compute_pass(timestamp_writes={'query_set':query,'beginning_of_pass_write_index':6,'end_of_pass_write_index':7});prep.set_pipeline(dispatch_pipeline);prep.set_bind_group(0,dispatch_group);prep.dispatch_workgroups(1);prep.end()
   cp=encoder.begin_compute_pass(timestamp_writes={'query_set':query,'beginning_of_pass_write_index':2*i,'end_of_pass_write_index':2*i+1});cp.set_pipeline(pipelines[name]);cp.set_bind_group(0,groups[name])
   if name=='clear':cp.dispatch_workgroups((max(16,tx*ty)+63)//64)
   elif name=='bin' and indirect is not None:cp.dispatch_workgroups_indirect(indirect,0)
   elif name=='bin':cp.dispatch_workgroups(dispatch_width,(total+dispatch_width-1)//dispatch_width)
   else:cp.dispatch_workgroups(tx,ty)
   cp.end()
  encoder.resolve_query_set(query,0,8 if indirect is not None else 6,query_buffer,0)
  print('Executing',variant,'iteration',iteration,flush=True);start=time.monotonic();device.queue.submit([encoder.finish()])
  n=8 if indirect is not None else 6
  timestamps=struct.unpack('<'+str(n)+'Q',device.queue.read_buffer(query_buffer,0,n*8));elapsed.append({'warmup':iteration<args.warmup,'wallSeconds':time.monotonic()-start,'stagesMs':[(timestamps[2*i+1]-timestamps[2*i])/1e6 for i in range(n//2)]});print(elapsed[-1],flush=True)
 def read(t):return bytes(device.queue.read_texture({'texture':t},{'offset':0,'bytes_per_row':width*4,'rows_per_image':height},(width,height,1)))
 depth,ids=read(textures[0]),read(textures[1]);(root/(variant+'-depth.bin')).write_bytes(depth);(root/(variant+'-ids.bin')).write_bytes(ids)
 if baseline is None:baseline=(depth,ids)
 depth_a=struct.unpack('<'+'f'*(width*height),baseline[0]);depth_b=struct.unpack('<'+'f'*(width*height),depth)
 measured=elapsed[args.warmup:]
 def summarize(values):
  ordered=sorted(values)
  return {'median':statistics.median(values),'min':min(values),'max':max(values),'p95':ordered[max(0,math.ceil(len(ordered)*.95)-1)]}
 summary={name:summarize([row['stagesMs'][i] for row in measured]) for i,name in enumerate(report['stageNames'][:4 if indirect is not None else 3])}
 summary['totalGpu']=summarize([sum(row['stagesMs']) for row in measured])
 summary['submitToReadback']=summarize([row['wallSeconds']*1000 for row in measured])
 result={'variant':variant,'dispatch':dispatch,'summaryMs':summary,'sourceSHA256':original_hash,'timings':elapsed,'depthMaxDifference':max(abs(a-b) for a,b in zip(depth_a,depth_b)),'idMismatches':sum(baseline[1][i:i+4]!=ids[i:i+4] for i in range(0,len(ids),4)),'counters':struct.unpack('<16I',device.queue.read_buffer(control)), 'checksum':hashlib.sha256(depth+ids).hexdigest()}
 baseline_path=root/'swiftshader-capacity-stats0.json'
 if (dispatch in ['visible','indirect'] or args.empty_bounds) and baseline_path.exists():
  reference=json.loads(baseline_path.read_text())['runs'][0]['checksum'];result['matchesCapacityChecksum']=result['checksum']==reference
 report['runs'].append(result);(Path(args.output) if args.output else root/(f'swiftshader-{args.dispatch}-stats{args.stats}'+('-empty' if args.empty_bounds else '')+'.json')).write_text(json.dumps(report,indent=2));print(result,flush=True)
 if result['idMismatches'] or result['depthMaxDifference']!=0 or result.get('matchesCapacityChecksum') is False:raise RuntimeError('Software shader visibility mismatch')
 if indirect is not None:
  print('GPU dispatch arguments:',struct.unpack('<3I',device.queue.read_buffer(indirect)),flush=True);indirect.destroy()
 for b in [uniform,control,heads,entries]:b.destroy()
 for t in textures:t.destroy()
