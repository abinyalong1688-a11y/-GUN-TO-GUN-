// radar.js — M3-G5 tactical radar (redrawn every 3 frames, 30 m radius, rotates with the player):
//   · enemies red / allies blue / drops yellow; shows noise under the EMP modifier.
export class Radar{
  constructor(canvas){
    this.cv=canvas;
    this.g=canvas?canvas.getContext('2d'):null;
    this.frame=0;
  }

  update(player,enemies,heroes,pickups,emp=false){
    if(!this.g)return;
    if(this.frame++%3)return;
    const g=this.g,w=this.cv.width,h=this.cv.height;
    const cx=w/2,cy=h/2,R=Math.min(cx,cy)-7;
    g.clearRect(0,0,w,h);
    g.save();
    g.beginPath();g.arc(cx,cy,R,0,Math.PI*2);g.clip();
    g.fillStyle='rgba(8,14,24,.72)';g.fillRect(0,0,w,h);
    // Grid
    g.strokeStyle='rgba(127,212,255,.14)';g.lineWidth=1;
    for(const f of [.34,.67,1]){
      g.beginPath();g.arc(cx,cy,R*f,0,Math.PI*2);g.stroke();
    }
    g.beginPath();g.moveTo(cx,cy-R);g.lineTo(cx,cy+R);
    g.moveTo(cx-R,cy);g.lineTo(cx+R,cy);g.stroke();
    // Heading: the player's forward direction (yaw+π) maps to screen up
    const heading=player.yaw+Math.PI;
    const plot=(x,z,color,size=3)=>{
      const dx=x-player.pos.x,dz=z-player.pos.z;
      const d=Math.hypot(dx,dz);
      if(d>30)return;
      const a=heading-Math.atan2(dx,dz); // things on the right plot on the right (old formula was mirrored)
      const px=cx+Math.sin(a)*(d/30)*R;
      const py=cy-Math.cos(a)*(d/30)*R;
      g.fillStyle=color;
      g.beginPath();g.arc(px,py,size,0,Math.PI*2);g.fill();
    };
    if(emp){
      // EMP: random noise, reveals no targets
      for(let i=0;i<38;i++){
        const a=Math.random()*Math.PI*2,rr=Math.random()*R;
        g.fillStyle='rgba(255,138,106,'+(.1+Math.random()*.35)+')';
        g.fillRect(cx+Math.cos(a)*rr,cy+Math.sin(a)*rr,2,2);
      }
    }else{
      for(const e of enemies)if(!e.decor&&!e.dead)plot(e.pos.x,e.pos.z,'#ef6a5a',e.boss?5:3);
      for(const h of heroes)if(h.alive)plot(h.pos.x,h.pos.z,h.team==='A'?'#7fb0ff':'#ff9a6a',3);
      if(pickups)for(const p of pickups.list)plot(p.pos.x,p.pos.z,'#e8c060',3);
    }
    // Player triangle
    g.fillStyle='#eef0f6';
    g.beginPath();g.moveTo(cx,cy-6);g.lineTo(cx-5,cy+5);g.lineTo(cx+5,cy+5);g.closePath();g.fill();
    g.restore();
    g.strokeStyle='rgba(127,212,255,.4)';g.lineWidth=1.5;
    g.beginPath();g.arc(cx,cy,R,0,Math.PI*2);g.stroke();
  }
}
