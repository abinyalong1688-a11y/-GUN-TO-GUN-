// operators.js —— 干员注册表(纯数据,零依赖):
//   8 名干员 · 阵营/性别/定位/属性/配色/装备/台词,
//   供角色构建(character.js)、名册 UI、立绘、击杀卡、MVP 共用。
// 约定:新增干员只改本文件;所有 rifle 必须是 weapon.js WEAPON_DEFS 的 id。

export const DEFAULT_OP='frost';

/* 迷彩覆盖:只覆盖服装色,肤色/发色/强调色保持干员个性 */
export const CAMOS={
  default:{},
  desert:{jacket:0x6a5a42,armor:0x3a3226,cloth:0x8a7a5a},
  snow:{jacket:0xc8d4e0,armor:0x8a9aaa,cloth:0xe8eef4},
  urban:{jacket:0x4a4a52,armor:0x2a2a30,cloth:0x6a6a72},
};

/* 配色约定(60-30-10):
   60% jacket/cloth 中性色 · 30% armor 阵营色 · 10% accent 高亮(臂章/镜片) */
export const OPERATORS=[
  /* ---------------- CT ---------------- */
  {
    id:'frost',faction:'ct',gender:'f',
    name:{zh:'霜华',en:'Frost'},
    role:{zh:'精确射手',en:'Marksman'},
    hp:115,speedMul:1.00,reloadMul:1.00,recoilMul:.90,rifle:'m4a4',
    palette:{skin:0xf3d0b8,hair:0x3a2418,jacket:0x46536b,armor:0x2b3140,accent:0x7fd4ff,cloth:0x39465c},
    headgear:'headset',hair:'ponytail',extras:['armband','kneepads','holster'],
    bio:{
      zh:'SAS 空勤特勤,擅长中远距离压制。冷静、话少,习惯在开火前先数三秒。',
      en:'SAS air service specialist built for mid-to-long range control. Calm, quiet, and always counts three seconds before pulling the trigger.',
    },
    quote:{zh:'呼吸,然后开枪。',en:'Breathe. Then shoot.'},
    voice:{pitch:1.08},
  },
  {
    id:'snowwolf',faction:'ct',gender:'m',
    name:{zh:'雪狼',en:'Snowwolf'},
    role:{zh:'重装',en:'Heavy'},
    hp:125,speedMul:.95,reloadMul:.95,recoilMul:.85,rifle:'m4a4',
    palette:{skin:0xdfab8c,hair:0x241a12,jacket:0x4d5a70,armor:0x323a4a,accent:0x9fd8ff,cloth:0x3a4558},
    headgear:'helmet',hair:'short',extras:['armband','backpack','kneepads'],
    bio:{
      zh:'来自北境的重装干员,背着全队最厚的插板。他相信掩体比勇气更可靠。',
      en:"A heavy operator from the northern frontier carrying the squad's thickest plate. He trusts cover more than courage.",
    },
    quote:{zh:'掩体不会背叛你。',en:"Cover won't betray you."},
    voice:{pitch:.82},
  },
  {
    id:'swift',faction:'ct',gender:'f',
    name:{zh:'雨燕',en:'Swift'},
    role:{zh:'侦察',en:'Scout'},
    hp:100,speedMul:1.08,reloadMul:1.05,recoilMul:1.00,rifle:'mp5',
    palette:{skin:0xf0c6a8,hair:0x6a4028,jacket:0x3c5a58,armor:0x2a3c3a,accent:0x6fffd2,cloth:0x33504c},
    headgear:'headset',hair:'bob',extras:['armband','holster'],
    bio:{
      zh:'侦察兵,跑得比子弹快半拍。她的任务是先把敌人的位置变成全队的常识。',
      en:'A scout who runs half a beat faster than the bullet. Her job is to turn enemy positions into common knowledge.',
    },
    quote:{zh:'我先看见他们,你们再开火。',en:'I see them first. You shoot second.'},
    voice:{pitch:1.12},
  },
  {
    id:'thunder',faction:'ct',gender:'m',
    name:{zh:'雷豹',en:'Thunder'},
    role:{zh:'突击',en:'Assault'},
    hp:115,speedMul:1.02,reloadMul:1.00,recoilMul:.95,rifle:'aug',
    palette:{skin:0xd9a97e,hair:0x1a130e,jacket:0x3f4a58,armor:0x2a303a,accent:0xffd166,cloth:0x35404c},
    headgear:'helmet',hair:'short',extras:['armband','kneepads'],
    bio:{
      zh:'爆破手出身的突击干员,喜欢用 AUG 把走廊清成一条直线。',
      en:'An assault operator with a demolitions background who likes to turn corridors into straight lines with his AUG.',
    },
    quote:{zh:'门后面?交给我。',en:'Behind the door? Mine.'},
    voice:{pitch:.90},
  },

  /* ---------------- T ---------------- */
  {
    id:'raven',faction:'t',gender:'m',
    name:{zh:'赤鸦',en:'Raven'},
    role:{zh:'突击',en:'Assault'},
    hp:100,speedMul:1.12,reloadMul:1.25,recoilMul:1.00,rifle:'ak47',
    palette:{skin:0xdfab8c,hair:0x1a130e,jacket:0x7e2620,armor:0x1e1c1c,accent:0xff8a6a,cloth:0x2f2c2c},
    headgear:'shemagh',hair:'short',extras:['armband','holster'],
    bio:{
      zh:'凤凰线佣兵,红夹克比他的履历更出名。他接单只看两件事:难度和价钱。',
      en:'A Phoenix-line mercenary whose red jacket is more famous than his record. He takes a job for two reasons: difficulty and pay.',
    },
    quote:{zh:'价钱谈好,剩下都好说。',en:'Pay is settled. The rest is easy.'},
    voice:{pitch:.95},
  },
  {
    id:'fox',faction:'t',gender:'f',
    name:{zh:'火狐',en:'Fox'},
    role:{zh:'游击',en:'Skirmisher'},
    hp:95,speedMul:1.18,reloadMul:1.15,recoilMul:1.05,rifle:'mp5',
    palette:{skin:0xefc0a0,hair:0xc25a22,jacket:0x5c4630,armor:0x33281e,accent:0xffa040,cloth:0x7a5c3e},
    headgear:'beanie',hair:'ponytail',extras:['armband','kneepads'],
    bio:{
      zh:'游击手,擅长在侧翼制造噪音。她说战场上最贵的资源是敌人的注意力。',
      en:"A skirmisher who makes noise on the flank. She says the most expensive resource on a battlefield is the enemy's attention.",
    },
    quote:{zh:'他们看左边,我们从右边进。',en:'They look left. We go right.'},
    voice:{pitch:1.06},
  },
  {
    id:'vulture',faction:'t',gender:'m',
    name:{zh:'秃鹫',en:'Vulture'},
    role:{zh:'狙击',en:'Sniper'},
    hp:100,speedMul:1.00,reloadMul:1.05,recoilMul:.88,rifle:'awp',
    palette:{skin:0xc99878,hair:0x2a2622,jacket:0x4a4a38,armor:0x2a2a22,accent:0xd8ff7a,cloth:0x3a3a2c},
    headgear:'goggles',hair:'short',extras:['armband','backpack'],
    bio:{
      zh:'狙击手,习惯在撤离路线上多留一颗子弹。他不喜欢解释,也不喜欢失手。',
      en:'A sniper who always saves a bullet for the exfil route. He dislikes explanations and misses in equal measure.',
    },
    quote:{zh:'风向对了,一枪就够。',en:'Right wind, one shot.'},
    voice:{pitch:.80},
  },
  {
    id:'viper',faction:'t',gender:'f',
    name:{zh:'黑蛇',en:'Viper'},
    role:{zh:'渗透',en:'Infiltrator'},
    hp:95,speedMul:1.10,reloadMul:1.30,recoilMul:1.02,rifle:'sg553',
    palette:{skin:0xe8bfa6,hair:0x14100e,jacket:0x2c2c34,armor:0x1a1a1f,accent:0x9a6aff,cloth:0x3a3a44},
    headgear:'shemagh',hair:'bob',extras:['armband','holster','kneepads'],
    bio:{
      zh:'渗透者,擅长在烟雾里换掉身份。她留下的痕迹通常只有一条被切断的通讯。',
      en:'An infiltrator who changes identities inside smoke. The only trace she usually leaves is a severed comms line.',
    },
    quote:{zh:'烟雾散之前,我已经不在了。',en:"Before the smoke clears, I'm gone."},
    voice:{pitch:1.00},
  },
];

export const byId=id=>OPERATORS.find(o=>o.id===id)||null;
export const byFaction=f=>OPERATORS.filter(o=>o.faction===f);

/* 干员基础配色 + 迷彩覆盖;未知迷彩静默回退 default */
export function paletteFor(def,camo='default'){
  const c=CAMOS[camo]||CAMOS.default;
  return {...def.palette,...c};
}
