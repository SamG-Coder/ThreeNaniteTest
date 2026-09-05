"""Run the production visibility/atomic-HZB shaders on a software Vulkan GPU.
Compare fresh unculled hardware visibility with temporal seed/recovery, including
camera changes. This exercises hardware rasterization, not the old tile emulator.
"""
import argparse,json,struct,math,hashlib,time
from pathlib import Path
import wgpu
p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--output');p.add_argument('--depth-order',action='store_true');p.add_argument('--frames',type=int,default=3);a=p.parse_args();root=Path(a.directory);m=json.loads((root/'manifest.json').read_text())
adapter=next(x for x in wgpu.gpu.enumerate_adapters_sync() if x.info['adapter_type']=='CPU')
d=adapter.request_device_sync(required_limits={'max-storage-buffers-per-shader-stage':10});S=wgpu.BufferUsage.STORAGE;C=wgpu.BufferUsage.COPY_SRC|wgpu.BufferUsage.COPY_DST;U=wgpu.BufferUsage.UNIFORM
make=lambda b,usage:d.create_buffer_with_data(data=b,usage=usage)
u32=lambda v:struct.pack('<'+'I'*len(v),*v)
def buffer(size,usage):return d.create_buffer(size=size,usage=usage)
width,height=m['width'],m['height'];tx,ty=(width+7)//8,(height+7)//8;ps=2**math.ceil(math.log2(max(width,height)));levels=int(math.log2(ps))+1
counts=[len((root/f'{i}-visible.bin').read_bytes())//8 for i in range(2)];capacity=sum(m['capacity']);clusters=m['clusterCounts'];instances=m['instanceCounts'];aw=(clusters[0]*instances[0]+31)//32;hw=aw+(clusters[1]*instances[1]+31)//32
params=bytearray((root/'params.bin').read_bytes());uniform=make(params,U|C);config=make(u32([*clusters,aw,1]),U|C);layout=make(u32([hw,tx*ty*2,0,0]),U);dims=make(u32([width,height,hw,tx]),U)
bits=buffer((hw+tx*ty*2)*4,S|C);control=make(u32([*counts,*([0]*14)]),S|C);args=buffer(44,S|wgpu.BufferUsage.INDIRECT);seed=buffer(capacity*4,S);recovery=buffer(capacity*4,S)
common={0:uniform,10:bits,11:control,12:config,17:layout}
for i in range(2):
 for j,name in enumerate(['vertices','indices','matrices','visible']):common[1+i*4+j]=make((root/f'{i}-{name}.bin').read_bytes(),S|C)
bounds=[make((root/f'{i}-bounds.bin').read_bytes(),S) for i in range(2)]
T=wgpu.TextureUsage;tex=lambda fmt,usage:d.create_texture(size=(width,height,1),format=fmt,usage=usage)
ids=tex('r32uint',T.RENDER_ATTACHMENT|T.TEXTURE_BINDING|T.COPY_SRC);depth=tex('depth32float',T.RENDER_ATTACHMENT|T.TEXTURE_BINDING);color=tex('rgba16float',T.STORAGE_BINDING|T.COPY_SRC);outdepth=tex('r32float',T.STORAGE_BINDING|T.COPY_SRC)
hzb=d.create_texture(size=(ps,ps,1),mip_level_count=levels,format='r32float',usage=T.STORAGE_BINDING|T.TEXTURE_BINDING)
module=d.create_shader_module(code=(root/'visibility.wgsl').read_text())
render=d.create_render_pipeline(layout='auto',vertex={'module':module,'entry_point':'vertexMain','buffers':[]},fragment={'module':module,'entry_point':'fragmentMain','targets':[{'format':'r32uint'}]},primitive={'topology':'triangle-list','cull_mode':'back','front_face':'ccw'},depth_stencil={'format':'depth32float','depth_write_enabled':True,'depth_compare':'less'})
compute={}
for file,names in [('visibility',['coverage','shadeVisible']),('cull',['clearFrame','clearHistory','arguments','seed','recover']),('pyramid',['reduce']),('base',['base'])]:
 mod=d.create_shader_module(code=(root/(file+'.wgsl')).read_text())
 for name in names:compute[name]=d.create_compute_pipeline(layout='auto',compute={'module':mod,'entry_point':name})
def group(pipeline,resources,bindings):
 return d.create_bind_group(layout=pipeline.get_bind_group_layout(0),entries=[{'binding':i,'resource':({'buffer':resources[i]} if isinstance(resources[i],wgpu.GPUBuffer) else resources[i])} for i in bindings])
cull={**common,1:bounds[0],2:bounds[1],18:seed,19:recovery,20:hzb.create_view(),21:args};groups={}
for name,bindings in {'clearFrame':[10,11,17],'clearHistory':[10,17],'arguments':[0,11,21],'seed':[0,4,8,10,11,12,18],'recover':[0,1,2,3,4,7,8,10,11,12,19,20]}.items():groups[name]=group(compute[name],cull,bindings)
geo={**common,13:ids.create_view(),14:depth.create_view(),15:color.create_view(),16:outdepth.create_view()}
groups['coverage']=group(compute['coverage'],geo,[0,10,13,17]);groups['shadeVisible']=group(compute['shadeVisible'],geo,[0,1,2,3,4,5,6,7,8,10,11,12,13,14,15,16])
drawgroups=[group(render,{**common,9:lst},[0,1,2,3,4,5,6,7,8,9]) for lst in [seed,recovery]]
groups['base']=group(compute['base'],{0:depth.create_view(),1:hzb.create_view(base_mip_level=0,mip_level_count=1),2:bits,3:dims},[0,1,2,3])
reducegroups=[group(compute['reduce'],{0:hzb.create_view(base_mip_level=i,mip_level_count=1),1:hzb.create_view(base_mip_level=i+1,mip_level_count=1)},[0,1]) for i in range(levels-1)]
if a.depth_order:
 mod=d.create_shader_module(code=(root/'depth-order.wgsl').read_text())
 for name in ['orderSeed','orderRecovery']:
  compute[name]=d.create_compute_pipeline(layout='auto',compute={'module':mod,'entry_point':name})
  groups[name]=group(compute[name],cull,[0,1,2,3,4,7,8,11,18,19])
def frame(enabled):
 d.queue.write_buffer(config,0,u32([*clusters,aw,int(enabled)]));e=d.create_command_encoder()
 def dispatch(name,x=1,y=1,bg=None,indirect=False):
  cp=e.begin_compute_pass();cp.set_pipeline(compute[name]);cp.set_bind_group(0,bg or groups[name])
  if indirect:cp.dispatch_workgroups_indirect(args,32)
  else:cp.dispatch_workgroups(x,y)
  cp.end()
 def draw(phase):
  if a.depth_order:dispatch('orderRecovery' if phase else 'orderSeed',indirect=True)
  rp=e.begin_render_pass(color_attachments=[{'view':ids.create_view(),'clear_value':(0xffffffff,0,0,0),'load_op':'load' if phase else 'clear','store_op':'store'}],depth_stencil_attachment={'view':depth.create_view(),'depth_clear_value':1,'depth_load_op':'load' if phase else 'clear','depth_store_op':'store'})
  rp.set_pipeline(render);rp.set_bind_group(0,drawgroups[phase]);rp.draw_indirect(args,phase*16);rp.end()
 dispatch('clearFrame',(max(16,tx*ty*2)+63)//64);dispatch('arguments');dispatch('seed',indirect=True);dispatch('arguments');draw(0)
 dispatch('coverage',tx,ty);dispatch('base',(ps+7)//8,(ps+7)//8)
 for i,bg in enumerate(reducegroups):size=ps//2**(i+1);dispatch('reduce',(size+7)//8,(size+7)//8,bg)
 dispatch('recover',indirect=True);dispatch('arguments');draw(1);dispatch('clearHistory',(hw+63)//64);dispatch('shadeVisible',tx,ty)
 start=time.monotonic();d.queue.submit([e.finish()]);c=struct.unpack('<16I',d.queue.read_buffer(control));elapsed=time.monotonic()-start
 def read(t,bpp):return bytes(d.queue.read_texture({'texture':t},{'bytes_per_row':width*bpp,'rows_per_image':height},(width,height,1)))
 return {'enabled':enabled,'seed':c[2],'recovery':c[3],'culled':c[5],'covered':c[4],'wallMs':elapsed*1000},read(outdepth,4),read(ids,4),read(color,8)
report={'depthOrdering':a.depth_order,'adapter':dict(adapter.info),'manifest':m,'limitations':['Software Vulkan, not phone timing','Uses exported CPU-selected cluster lists; Three selection is outside harness','Hardware coplanar ties can pick different IDs after list reordering'],'frames':[]}
# Keep history across frames/camera changes. Baselines also update it, so save
# and restore the real prior-frame bitset around each unculled reference draw.
for i in range(a.frames):
 if i==2:
  # Shift clip X by 0.17 W without rebuilding selection: both comparisons use
  # the same superset. This specifically tests current-camera disocclusion.
  f=list(struct.unpack('<32f',params))
  for col in range(4):f[col*4]+=0.17*f[col*4+3]
  struct.pack_into('<16f',params,0,*f[:16]);d.queue.write_buffer(uniform,0,params)
 if i==3 and m.get('fixture'):
  # Remove the occluder from the selected list, reusing its slot for the hidden
  # cluster. Previous stable visibility bits must not suppress the newly exposed surface.
  d.queue.write_buffer(common[4],0,u32([0,1]))
 history=bytes(d.queue.read_buffer(bits,0,hw*4))
 reference=frame(False);d.queue.write_buffer(bits,0,history);actual=frame(True)
 rd=struct.unpack('<'+'f'*(width*height),reference[1]);ad=struct.unpack('<'+'f'*(width*height),actual[1])
 diff=max(abs(x-y) for x,y in zip(rd,ad));holes=sum((x==1)!=(y==1) for x,y in zip(rd,ad))
 result={**actual[0],'frame':i,'depthMaxDifference':diff,'coverageMismatches':holes,'idMismatches':sum(reference[2][j:j+4]!=actual[2][j:j+4] for j in range(0,len(actual[2]),4)),'colorMismatches':sum(reference[3][j:j+8]!=actual[3][j:j+8] for j in range(0,len(actual[3]),8)),'depthSHA256':hashlib.sha256(actual[1]).hexdigest()}
 if 'coverageFixture' in m and i<3:
  tokens=struct.unpack('<'+'I'*(width*height),actual[2])
  foreground=sum(t<64 for t in tokens);behind=sum(64<=t<128 for t in tokens)
  result['maskedForegroundPixels']=foreground;result['behindFoliagePixels']=behind
  if m['coverageFixture']==0 and foreground:raise RuntimeError('Transparent foliage wrote visibility/depth')
  if m['coverageFixture']==0.25 and not (100<foreground<800 and behind>0):raise RuntimeError('Partial coverage lost holes or rear surface')
 report['frames'].append(result);print(result,flush=True)
 if diff>2e-6 or holes:raise RuntimeError('HZB removed visible geometry')
Path(a.output or root/'visibility-results.json').write_text(json.dumps(report,indent=2))
