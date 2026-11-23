// operators.js — operator registry (pure data, no dependencies):
//   8 operators · faction / gender / role / stats / palette / gear / quotes,
//   shared by the character builder (character.js), roster UI, portraits, kill cards and MVP.
// Convention: new operators only touch this file; every rifle must be an id in weapon.js WEAPON_DEFS.

export const DEFAULT_OP='frost';

/* Faction identity: one shared outfit colour per team. skin / hair stay per-operator;
   jacket / armour / cloth / accent are team-coloured so friend-foe reads at a glance
   (accent is emissive and drives armbands / lens glints / headset stripes). */
export const FACTION_PALETTES={
  ct:{jacket:0x46536b,armor:0x2b3140,cloth:0x39465c,accent:0x7fd4ff},
  t:{jacket:0x7e2620,armor:0x1e1c1c,cloth:0x2f2c2c,accent:0xff7a52},
};

/* Camos blend the team colour toward a neutral pattern instead of replacing it: the team
   hue survives every camo, so a desert-camo Nova still reads as Nova. */
export const CAMOS={
  default:{mix:0,target:0x808080},
  desert:{mix:.55,target:0x9c8763},
  snow:{mix:.62,target:0xd8e2ec},
  urban:{mix:.50,target:0x3a3a42},
};

/* Palette convention (60-30-10):
   60% jacket/cloth neutral · 30% armor faction colour · 10% accent highlight (armband / lenses) */
export const OPERATORS=[
  /* ---------------- Nova ---------------- */
  {
    id:'frost',faction:'ct',gender:'f',
    name:{zh:'霜华',en:'Frost'},
    role:{zh:'精确射手',en:'Marksman'},
    hp:115,speedMul:1.00,reloadMul:1.00,recoilMul:.90,rifle:'m4a4',
    palette:{skin:0xf3d0b8,hair:0x3a2418,jacket:0x46536b,armor:0x2b3140,accent:0x7fd4ff,cloth:0x39465c},
    headgear:'headset',hair:'ponytail',extras:['armband','kneepads','holster'],
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
    quote:{zh:'门后面?交给我。',en:'Behind the door? Mine.'},
    voice:{pitch:.90},
  },

  /* ---------------- Rogue ---------------- */
  {
    id:'raven',faction:'t',gender:'m',
    name:{zh:'赤鸦',en:'Raven'},
    role:{zh:'突击',en:'Assault'},
    hp:100,speedMul:1.12,reloadMul:1.25,recoilMul:1.00,rifle:'ak47',
    palette:{skin:0xdfab8c,hair:0x1a130e,jacket:0x7e2620,armor:0x1e1c1c,accent:0xff8a6a,cloth:0x2f2c2c},
    headgear:'shemagh',hair:'short',extras:['armband','holster'],
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
    quote:{zh:'烟雾散之前,我已经不在了。',en:"Before the smoke clears, I'm gone."},
    voice:{pitch:1.00},
  },
];

export const byId=id=>OPERATORS.find(o=>o.id===id)||null;
export const byFaction=f=>OPERATORS.filter(o=>o.faction===f);

/* Team base palette + camo blend; unknown camos silently fall back to default.
   Pure-data module: colour maths is inline, no three.js dependency. */
function blendTo(hex,target,k){
  if(!k)return hex;
  const ch=(h,s)=>(h>>s)&255, mix=(a,b)=>Math.round(a+(b-a)*k);
  return (mix(ch(hex,16),ch(target,16))<<16)|(mix(ch(hex,8),ch(target,8))<<8)|mix(ch(hex,0),ch(target,0));
}
export function paletteFor(def,camo='default'){
  const team=FACTION_PALETTES[def.faction]||FACTION_PALETTES.ct;
  const c=CAMOS[camo]||CAMOS.default;
  return {
    ...def.palette,
    jacket:blendTo(team.jacket,c.target,c.mix),
    armor:blendTo(team.armor,c.target,c.mix),
    cloth:blendTo(team.cloth,c.target,c.mix),
    accent:team.accent, // emissive team ID stays fully saturated under every camo
  };
}