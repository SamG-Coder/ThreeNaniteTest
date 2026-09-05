import * as THREE from 'three/webgpu';

export class GameControls {
  constructor(camera, canvas, world, elements) {
    this.camera = camera; this.canvas = canvas; this.world = world;
    this.elements = elements; this.keys = new Set(); this.enabled = false;
    this.yaw = 0; this.pitch = -.05; this.velocityY = 0;
    this.stick = {x:0,y:0}; this.listeners = [];
    const listen = (target,type,handler) => {
      target.addEventListener(type,handler);
      this.listeners.push(()=>target.removeEventListener(type,handler));
    };
    const typing = e => /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target?.tagName);
    listen(window,'keydown',e=>{
      if (!this.enabled || typing(e)) return;
      if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight'].includes(e.code)) {
        e.preventDefault(); this.keys.add(e.code);
        if (e.code==='Space' && !e.repeat) this.jump();
      }
    });
    listen(window,'keyup',e=>this.keys.delete(e.code));
    listen(window,'blur',()=>this.clear());
    listen(document,'visibilitychange',()=>this.clear());
    listen(document,'pointerlockchange',()=>{
      if (document.pointerLockElement!==canvas) this.clear();
      document.body.classList.toggle('pointer-locked',document.pointerLockElement===canvas);
    });
    listen(canvas,'click',()=>{
      if(this.enabled && !matchMedia('(pointer: coarse)').matches) {
        canvas.requestPointerLock?.()?.catch?.(()=>{});
      }
    });
    listen(document,'mousemove',e=>{
      if(this.enabled && document.pointerLockElement===canvas) this.look(e.movementX,e.movementY);
    });
    let lookPointer = null, previous;
    listen(canvas,'pointerdown',e=>{
      if(!this.enabled || e.pointerType==='mouse' || lookPointer!==null) return;
      lookPointer=e.pointerId; previous=[e.clientX,e.clientY]; canvas.setPointerCapture(e.pointerId);
    });
    listen(canvas,'pointermove',e=>{
      if(e.pointerId!==lookPointer || !this.enabled) return;
      this.look(e.clientX-previous[0],e.clientY-previous[1]); previous=[e.clientX,e.clientY];
    });
    const endLook=e=>{if(e.pointerId===lookPointer) lookPointer=null;};
    for(const type of ['pointerup','pointercancel','lostpointercapture']) listen(canvas,type,endLook);
    let stickPointer=null;
    const updateStick=e=>{
      const rect=elements.stick.getBoundingClientRect();
      const dx=(e.clientX-rect.left-rect.width/2)/(rect.width*.35);
      const dy=(e.clientY-rect.top-rect.height/2)/(rect.height*.35);
      const len=Math.max(1,Math.hypot(dx,dy));
      this.stick={x:dx/len,y:dy/len};
      elements.thumb.style.transform=`translate(${this.stick.x*30}px,${this.stick.y*30}px)`;
    };
    listen(elements.stick,'pointerdown',e=>{
      if(!this.enabled || stickPointer!==null) return;
      stickPointer=e.pointerId; elements.stick.setPointerCapture(e.pointerId); updateStick(e);
    });
    listen(elements.stick,'pointermove',e=>{if(e.pointerId===stickPointer) updateStick(e);});
    const endStick=e=>{if(e.pointerId===stickPointer){stickPointer=null; this.stick={x:0,y:0}; elements.thumb.style.transform='';}};
    for(const type of ['pointerup','pointercancel','lostpointercapture']) listen(elements.stick,type,endStick);
    listen(elements.jump,'click',()=>this.jump());
    this.reset();
  }
  clear() { this.keys.clear(); this.stick={x:0,y:0}; this.elements.thumb.style.transform=''; }
  setEnabled(enabled) {
    this.enabled=enabled; this.clear();
    document.body.classList.toggle('walking',enabled);
    if(!enabled && document.pointerLockElement===this.canvas) document.exitPointerLock();
  }
  reset() {
    const [x,,z]=this.world.spawn;
    this.camera.position.set(x,this.world.heightAt(x,z)+1.7,z);
    this.yaw=this.world.spawnYaw??0; this.pitch=this.world.spawnPitch??-.05; this.velocityY=0; this.look(0,0);
  }
  look(dx,dy) {
    this.yaw-=dx*.0025; this.pitch=THREE.MathUtils.clamp(this.pitch-dy*.0025,-1.35,1.35);
    this.camera.rotation.set(this.pitch,this.yaw,0,'YXZ');
  }
  jump() {
    if(!this.enabled) return;
    const p=this.camera.position;
    if(p.y<=this.world.heightAt(p.x,p.z)+1.72) this.velocityY=6.2;
  }
  blocked(x,z) {
    return Boolean(this.world.blockedAt?.(x,z)) || this.world.obstacles.some(o=>o.radius!==undefined
      ? Math.hypot(x-o.x,z-o.z)<o.radius+.35
      : Math.abs(x-o.x)<o.halfX+.35 && Math.abs(z-o.z)<o.halfZ+.35);
  }
  update(dt) {
    if(!this.enabled) return;
    dt=Math.min(dt,.05);
    const has=(...codes)=>codes.some(c=>this.keys.has(c));
    let forward=Number(has('KeyW','ArrowUp'))-Number(has('KeyS','ArrowDown'))-this.stick.y;
    let right=Number(has('KeyD','ArrowRight'))-Number(has('KeyA','ArrowLeft'))+this.stick.x;
    const norm=Math.max(1,Math.hypot(forward,right)); forward/=norm; right/=norm;
    const speed=has('ShiftLeft','ShiftRight')?10:5.5;
    const p=this.camera.position, bound=this.world.bounds;
    const x=THREE.MathUtils.clamp(p.x+(Math.cos(this.yaw)*right-Math.sin(this.yaw)*forward)*speed*dt,-bound,bound);
    const z=THREE.MathUtils.clamp(p.z+(-Math.sin(this.yaw)*right-Math.cos(this.yaw)*forward)*speed*dt,-bound,bound);
    if(!this.blocked(x,p.z)) p.x=x;
    if(!this.blocked(p.x,z)) p.z=z;
    this.velocityY-=18*dt; p.y+=this.velocityY*dt;
    const floor=this.world.heightAt(p.x,p.z)+1.7;
    if(p.y<floor) {p.y=floor; this.velocityY=0;}
  }
  dispose() { this.setEnabled(false); for(const remove of this.listeners) remove(); }
}
