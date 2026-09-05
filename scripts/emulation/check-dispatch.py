"""Exercise production dispatch WGSL on GPU, including empty and multirow work."""
import sys, struct
from pathlib import Path
import wgpu
adapter=next(a for a in wgpu.gpu.enumerate_adapters_sync() if a.info['adapter_type']=='CPU')
d=adapter.request_device_sync();S=wgpu.BufferUsage.STORAGE
module=d.create_shader_module(code=Path(sys.argv[1]).read_text())
pipeline=d.create_compute_pipeline(layout='auto',compute={'module':module,'entry_point':'prepareDispatch'})
for counts,caps,width,expected in [
 ((0,0),(100,100),200,(0,1,1)),
 ((7,2),(100,100),200,(9,1,1)),
 ((65535,0),(100000,100000),65535,(65535,1,1)),
 ((65535,1),(100000,100000),65535,(65535,2,1)),
 ((100000,100000),(100000,100000),65535,(65535,4,1)),
 ((999,999),(4,5),9,(9,1,1))]:
 params=bytearray(128);struct.pack_into('<2I',params,96,*caps);struct.pack_into('<I',params,124,width)
 buffers=[d.create_buffer_with_data(data=params,usage=wgpu.BufferUsage.UNIFORM),d.create_buffer_with_data(data=struct.pack('<2I',*counts),usage=S),d.create_buffer(size=12,usage=S|wgpu.BufferUsage.COPY_SRC|wgpu.BufferUsage.INDIRECT)]
 group=d.create_bind_group(layout=pipeline.get_bind_group_layout(0),entries=[{'binding':i,'resource':{'buffer':b}} for i,b in enumerate(buffers)])
 enc=d.create_command_encoder();cp=enc.begin_compute_pass();cp.set_pipeline(pipeline);cp.set_bind_group(0,group);cp.dispatch_workgroups(1);cp.end();d.queue.submit([enc.finish()])
 actual=struct.unpack('<3I',d.queue.read_buffer(buffers[2]));assert actual==expected,(counts,actual,expected)
 n=sum(min(a,b) for a,b in zip(counts,caps));x,y,_=actual
 # Shader slot = workgroup.x + workgroup.y * uniform stride;
 # only excess groups in the final row may exceed the selected count.
 visited=[xx+yy*width for yy in range(y) for xx in range(x) if xx+yy*width<n]
 assert visited==list(range(n))
 for b in buffers:b.destroy()
print('Passed 6 GPU dispatch cases: empty, partial, boundary, multirow and clamped counts.')
