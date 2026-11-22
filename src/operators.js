// operators.js — operator registry (pure data, no dependencies):
//   4 operators (one male + one female per faction) · faction / gender / role / stats / palette / gear / quotes,
//   shared by the character builder (character.js), roster UI, portraits, kill cards and MVP.
// Convention: new operators only touch this file; every rifle must be an id in weapon.js WEAPON_DEFS.

export const DEFAULT_OP='frost';

/* Camo override: only clothing colours change; skin / hair / accent keep the operator's identity */
export const CAMOS={
  default:{},
  desert:{jacket:0x6a5a42,armor:0x3a3226,cloth:0x8a7a5a},
  snow:{jacket:0xc8d4e0,armor:0x8a9aaa,cloth:0xe8eef4},
  urban:{jacket:0x4a4a52,armor:0x2a2a30,cloth:0x6a6a72},
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
];

export const byId=id=>OPERATORS.find(o=>o.id===id)||null;
export const byFaction=f=>OPERATORS.filter(o=>o.faction===f);

/* Operator base palette + camo override; unknown camos silently fall back to default */
export function paletteFor(def,camo='default'){
  const c=CAMOS[camo]||CAMOS.default;
  return {...def.palette,...c};
}