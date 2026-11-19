// upgrades.js —— M3-G3 波次三选一强化:
//   · 8 项升级,各自上限;已满级的不再出现在候选池;
//   · rollUpgrades(game,n) 从可用池无重复随机抽取。
const U=(id,zh,en,descZh,descEn,max,apply)=>({id,name:{zh,en},desc:{zh:descZh,en:descEn},max,apply});

export const UPGRADES=[
  U('dmg','火力强化','DAMAGE +','主武器伤害 +15%','Primary damage +15%',3,g=>{g.upgrades.dmg++;}),
  U('rpm','快速射击','RAPID FIRE','射速 +10%','Fire rate +10%',3,g=>{
    g.upgrades.rpm++;g.weapon.rpmMul=1+.1*g.upgrades.rpm;
  }),
  U('reload','快速装填','FAST RELOAD','换弹速度 +15%','Reload speed +15%',2,g=>{
    g.upgrades.reload++;g.weapon.reloadSpeedMul=(g.playerOperator?g.playerOperator.reloadMul:1)*(1+.15*g.upgrades.reload);
  }),
  U('speed','轻量机动','LIGHTWEIGHT','移动速度 +8%','Move speed +8%',2,g=>{
    g.upgrades.speed++;
    const s=5.2*(g.playerOperator?g.playerOperator.speedMul:1)*(1+.08*g.upgrades.speed);
    g.baseSpeed=s;g.baseSprint=s*1.5;
    g.player.speed=s;g.player.sprintSpeed=g.baseSprint;
  }),
  U('hp','加固装甲','REINFORCED','最大生命 +20','Max health +20',3,g=>{
    g.upgrades.hp++;g.player.maxHealth+=20;g.player.health+=20;
  }),
  U('crit','精准要害','PRECISION','暴击伤害 +25%','Critical damage +25%',2,g=>{g.upgrades.crit++;}),
  U('pierce','穿甲弹','ARMOR PIERCING','子弹穿透 +1','Bullet penetration +1',1,g=>{g.upgrades.pierce++;}),
  U('regen','战场恢复','FIELD MEDIC','击杀回血 +5','Heal 5 per kill',2,g=>{g.upgrades.regen++;}),
];
export function rollUpgrades(game,n=3){
  const pool=UPGRADES.filter(u=>(game.upgrades&&game.upgrades[u.id]||0)<u.max);
  const out=[];
  while(out.length<n&&pool.length){
    out.push(pool.splice(Math.floor(Math.random()*pool.length),1)[0]);
  }
  return out;
}

export function applyUpgrade(game,id){
  const u=UPGRADES.find(x=>x.id===id);
  if(!u)return false;
  const cur=(game.upgrades&&game.upgrades[id]||0);
  if(cur>=u.max)return false;
  u.apply(game);
  return true;
}
