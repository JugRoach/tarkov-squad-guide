import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabase.js";

const T = {
  bg:"#141414",surface:"#1e1e1e",surfaceAlt:"#252525",border:"#333",borderBright:"#444",gold:"#d4a644",text:"#c0b8a8",textDim:"#6a6a6a",textBright:"#e8e0d0",
  sans:"'Segoe UI',Arial,Helvetica,sans-serif",mono:"'Courier New',Consolas,monospace",
  // Semantic colors
  error:"#d44040",errorBg:"#1f1414",errorBorder:"#4a2020",
  success:"#4daa4d",successBg:"#141f14",successBorder:"#2a5a2a",
  cyan:"#4ab0b0",cyanBg:"#141e1e",cyanBorder:"#2a4a4a",
  orange:"#c08040",orangeBg:"#1f1a14",orangeBorder:"#5a4020",
  blue:"#5a90b0",blueBg:"#141a1f",blueBorder:"#2a4060",
  purple:"#9080b0",purpleBg:"#1a141f",purpleBorder:"#3a2a5a",
  // Spacing scale
  sp1:4, sp2:8, sp3:12, sp4:16, sp5:24,
  // Font sizes
  fs1:12, fs2:13, fs3:14, fs4:18, fs5:22,
  // Accent border
  accent:2,
  // Input base style
  input:{ background:"#181818", border:"1px solid #383838", color:"#e0d8c8", padding:"8px 12px", fontSize:13, fontFamily:"'Segoe UI',Arial,Helvetica,sans-serif", outline:"none", boxSizing:"border-box" },
};
const PLAYER_COLORS = ["#c8a84b","#5a9aba","#9a5aba","#5aba8a","#ba7a5a"];
const MAX_SQUAD = 5;
const API_URL = "https://api.tarkov.dev/graphql";
const CODE_VERSION = "TG2";
// In-game trader menu order
const TRADER_ORDER = ["Prapor","Therapist","Fence","Skier","Peacekeeper","Mechanic","Ragman","Jaeger","Lightkeeper","BTR Driver","Ref","Taran","Radio station","Mr. Kerman","Voevoda"];
const traderSort = (a, b) => { const ia = TRADER_ORDER.indexOf(a); const ib = TRADER_ORDER.indexOf(b); return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib); };

// ─── SHARE CODES ─────────────────────────────────────────────────────────
function encodeProfile(p){try{return CODE_VERSION+":"+btoa(unescape(encodeURIComponent(JSON.stringify({v:2,n:p.name,c:p.color,t:p.tasks||[],pr:p.progress||{}}))));}catch{return null;}}
function decodeProfile(code){try{const b64=code.trim().startsWith(CODE_VERSION+":")?code.trim().slice(CODE_VERSION.length+1):code.trim();const d=JSON.parse(decodeURIComponent(escape(atob(b64))));if(!d.n)return null;return{id:"imp_"+Date.now()+"_"+Math.random().toString(36).slice(2,5),name:d.n,color:d.c||PLAYER_COLORS[0],tasks:d.t||[],progress:d.pr||{},imported:true,importedAt:Date.now()};}catch{return null;}}

// ─── STORAGE ─────────────────────────────────────────────────────────────
function useStorage(key,def){const[val,setVal]=useState(def);const[ready,setReady]=useState(false);useEffect(()=>{(async()=>{try{const r=await window.storage.get(key);if(r?.value)setVal(JSON.parse(r.value));}catch(_){}setReady(true);})();},[key]);const save=useCallback((v)=>{setVal(p=>{const next=typeof v==="function"?v(p):v;(async()=>{try{await window.storage.set(key,JSON.stringify(next));}catch(_){}})();return next;});},[key]);return[val,save,ready];}

// ─── API ─────────────────────────────────────────────────────────────────
const MAPS_Q=`{maps{id name normalizedName lootContainers{lootContainer{name}}}}`;
const TASKS_Q=`{tasks(lang:en){id name minPlayerLevel trader{name} map{id name normalizedName} taskRequirements{task{id}status} objectives{id type description optional ...on TaskObjectiveBasic{zones{id map{id} position{x y z}}} ...on TaskObjectiveMark{markerItem{name} zones{id map{id} position{x y z}}} ...on TaskObjectiveQuestItem{questItem{name} count possibleLocations{map{id} positions{x y z}} zones{id map{id} position{x y z}}} ...on TaskObjectiveShoot{targetNames count zoneNames zones{id map{id} position{x y z}}} ...on TaskObjectiveItem{items{name} count foundInRaid zones{id map{id} position{x y z}}} ...on TaskObjectiveExtract{exitName}}}}`;
const HIDEOUT_Q=`{hideoutStations{id name normalizedName levels{level itemRequirements{item{id name shortName} count} stationLevelRequirements{station{id name} level} traderRequirements{trader{name} level}}}}`;
const TRADERS_Q=`{traders{id name imageLink}}`;
async function fetchAPI(q){const r=await fetch(API_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:q})});return(await r.json()).data;}

// ─── EXTRACT DATA (with approx. map positions + item requirements) ────────
// pct = normalized {x,y} position on tarkov.dev SVG map (0-1 scale)
// requirement = text shown in item check prompt
// requireItems = array of items player needs to confirm they have
const ET_CONFIG = {
  open:    {label:"Always Open",         icon:"✓",  color:"#5dba5d", bg:T.successBg, border:"#2a6a2a"},
  key:     {label:"Key Required",        icon:"⚿",  color:"#d4b84a", bg:T.orangeBg, border:"#6a5a0a"},
  pay:     {label:"Pay Roubles",         icon:"₽",  color:"#5a7aba", bg:T.blueBg, border:"#2a3a6a"},
  coop:    {label:"N/A in PvE",          icon:"✗",  color:"#555",    bg:"#141414", border:"#3a3a3a"},
  special: {label:"Special Required",   icon:"⚠",  color:"#e05a5a", bg:T.errorBg, border:"#8a2a2a"},
  timed:   {label:"Timed — Listen Up",   icon:"◷",  color:"#d4943a", bg:T.orangeBg, border:"#7a5a1a"},
};

const TC = {Beginner:"#4a9a4a",Intermediate:"#9a8a3a",Advanced:"#9a4a3a",Endgame:"#4a8a9a"};

// ─── KEY GUIDE — Notable loot room keys per map ──────────────────────────
const MAP_KEYS = {
  customs:[
    {key:"Marked Key (Dorms 314)",use:"Marked Room — rare weapons, cases, keycards",priority:"high"},
    {key:"Dorms Room 204 Key",use:"Quest items (Prapor), loose loot",priority:"med"},
    {key:"Dorms Room 214 Key",use:"Quest items, safe, PC",priority:"med"},
    {key:"Dorms Room 220 Key",use:"Quest items (Therapist early tasks)",priority:"med"},
    {key:"Customs Office Key",use:"Safe + filing cabinets in Big Red office",priority:"med"},
    {key:"Unknown Key",use:"Locked room near ZB-1014 — loose loot",priority:"low"},
  ],
  factory:[
    {key:"Factory Key",use:"Smugglers' Passage extract + locked shortcuts",priority:"high"},
  ],
  woods:[
    {key:"Shturman's Stash Key",use:"Shturman's crate near sawmill — rare loot",priority:"high"},
    {key:"ZB-014 Key",use:"Underground bunker — weapon crates, loot",priority:"med"},
    {key:"Yotota Car Key",use:"Locked car — loose valuables",priority:"low"},
  ],
  interchange:[
    {key:"KIBA Store Key (Part 1 & 2)",use:"KIBA weapon store — best weapon loot on map",priority:"high"},
    {key:"ULTRA Medical Storage Key",use:"LEDX, defibs, rare medical spawns",priority:"high"},
    {key:"Object 11SR Keycard",use:"Secret room — rare barter, electronics",priority:"high"},
    {key:"21WS Keycard",use:"Weapon safe room — rare spawns",priority:"med"},
    {key:"EMERCOM Medical Unit Key",use:"Medical crates, stims",priority:"med"},
  ],
  shoreline:[
    {key:"East Wing Room 310 Key",use:"LEDX spawn, medical supplies",priority:"high"},
    {key:"East Wing Room 226 Key",use:"Safe, intel folder, valuables",priority:"high"},
    {key:"East Wing Room 222/218 Key",use:"Weapon spawns, rare attachments",priority:"med"},
    {key:"West Wing Room 301 Key",use:"Safe, electronics, weapon parts",priority:"med"},
    {key:"West Wing Room 216 Key",use:"Quest items, loose loot",priority:"med"},
    {key:"Cottage Key (Cottage Safe)",use:"Safe + weapon spawn in cottage area",priority:"med"},
    {key:"Health Resort Universal Key",use:"Opens admin offices — PCs, filing cabinets",priority:"low"},
  ],
  reserve:[
    {key:"RB-BK Marked Room Key",use:"Marked room — rare loot, weapon cases",priority:"high"},
    {key:"RB-VO Key",use:"Medical supply room — LEDX chance",priority:"high"},
    {key:"RB-AM Key",use:"Ammo & weapon attachments room",priority:"med"},
    {key:"RB-GN Key",use:"Intel, electronics room",priority:"med"},
    {key:"RB-KPRL Key",use:"Underground room — weapon parts",priority:"med"},
    {key:"RB-PSP1/PSP2 Keys",use:"Bunker rooms — loot caches",priority:"med"},
  ],
  lighthouse:[
    {key:"Hillside House Key",use:"Safes, valuables in chalet area",priority:"high"},
    {key:"Water Treatment Plant Key (multiple)",use:"Various locked buildings in Rogue camp",priority:"med"},
    {key:"Operating Room Key",use:"Medical supplies, LEDX chance",priority:"med"},
    {key:"Conference Room Key",use:"Intel, electronics",priority:"med"},
  ],
  "streets-of-tarkov":[
    {key:"Concordia Apartment Keys",use:"Multiple apartments — safes, PCs, valuables",priority:"high"},
    {key:"Abandoned Factory Key",use:"Weapon crates, loose loot",priority:"med"},
    {key:"Hotel Room Keys (various)",use:"Cardinal/Pinewood hotels — safes, loot",priority:"med"},
    {key:"Financial Office Key",use:"Safe, intel folder, electronics",priority:"med"},
  ],
  "ground-zero":[
    {key:"Office Key (Ground Zero)",use:"Office building safes + PCs",priority:"med"},
    {key:"Supermarket Storage Key",use:"Back room — food, barter items",priority:"low"},
  ],
  "the-lab":[
    {key:"Lab. Green Keycard",use:"Green lab — LEDX, stims, rare medical",priority:"high"},
    {key:"Lab. Blue Keycard",use:"Blue lab — electronics, tech spawns",priority:"high"},
    {key:"Lab. Black Keycard",use:"Black room — weapons, rare gear",priority:"high"},
    {key:"Lab. Violet Keycard",use:"Violet room — intel, electronics",priority:"high"},
    {key:"Lab. Yellow Keycard",use:"Yellow lab — medical, electronics",priority:"med"},
    {key:"Lab. Access Keycard",use:"Required to enter The Lab raid",priority:"high"},
  ],
};

const LOOT_CONFIG = {
  "high-value":{label:"High Value",icon:"★",color:"#d4b84a",bg:"#1a1a08",border:"#6a5a0a"},
  tech:        {label:"Tech",      icon:"⚡",color:"#5a9aba",bg:"#08101a",border:"#2a4a6a"},
  medical:     {label:"Medical",   icon:"✚",color:"#5dba5d",bg:"#0a1a0a",border:"#2a6a2a"},
  mixed:       {label:"Mixed",     icon:"◈",color:"#9a8aba",bg:"#0f0a18",border:"#4a3a6a"},
  stash:       {label:"Stashes",   icon:"◉",color:"#8a7a5a",bg:"#141008",border:"#5a4a2a"},
};

// Maps item categories from tarkov.dev API to loot point types
const CAT_TO_LOOT = {
  Electronics:["tech","high-value"],Info:["tech","high-value"],Battery:["tech","mixed"],
  Weapon:["high-value","mixed"],"Assault rifle":["high-value","mixed"],"Assault carbine":["high-value","mixed"],
  SMG:["high-value","mixed"],Shotgun:["high-value","mixed"],"Sniper rifle":["high-value","mixed"],
  "Marksman rifle":["high-value","mixed"],Handgun:["high-value","mixed"],Machinegun:["high-value","mixed"],
  "Weapon mod":["high-value","mixed"],"Gear mod":["mixed","high-value"],
  Armor:["high-value","mixed"],"Armored equipment":["high-value","mixed"],"Chest rig":["high-value","mixed"],
  Headwear:["high-value","mixed"],Backpack:["mixed","stash"],
  Meds:["medical","mixed"],Medikit:["medical","mixed"],"Medical supplies":["medical","mixed"],
  Stimulant:["medical","high-value"],Drug:["medical"],
  "Building material":["mixed","stash"],Tool:["mixed","stash"],Multitools:["mixed","stash"],
  Fuel:["mixed","stash"],"Household goods":["mixed","stash"],Lubricant:["mixed","stash"],
  Key:["mixed","stash","high-value"],Keycard:["high-value","tech"],
  Jewelry:["high-value","stash"],Money:["high-value","mixed","stash"],
  Food:["mixed","stash"],"Food and drink":["mixed","stash"],Drink:["mixed","stash"],
  Ammo:["mixed","high-value"],"Ammo container":["mixed","high-value"],
};
function itemCatsToLootTypes(categories) {
  const types = new Set();
  (categories || []).forEach(c => (CAT_TO_LOOT[c.name] || ["mixed"]).forEach(t => types.add(t)));
  if (types.size === 0) types.add("mixed");
  return types;
}
const ITEMS_SEARCH_Q = (term) => `{items(name:"${term.replace(/"/g,"")}", limit:20){id name shortName types categories{name}}}`;

// Hierarchical "What are you looking for?" categories
// tags: matched against loot point tags. subs: optional drill-down.
const LOOK_CATS = [
  {id:"guns",label:"Guns",icon:"⊕",tags:["Weapon"],subs:[
    {id:"ar",label:"Assault Rifles",tags:["Assault rifle","Weapon"],subs:[
      {id:"ak74",label:"AK-74 Series",tags:["Weapon"]},{id:"ak100",label:"AK-100 Series",tags:["Weapon"]},
      {id:"m4",label:"M4A1 / HK416",tags:["Weapon"]},{id:"mdr",label:"MDR / SCAR",tags:["Weapon"]},
    ]},
    {id:"smg",label:"SMGs",tags:["SMG","Weapon"],subs:[
      {id:"mp5",label:"MP5 / MP7",tags:["Weapon"]},{id:"mpx",label:"MPX / Vector",tags:["Weapon"]},
      {id:"pp19",label:"PP-19 / Saiga-9",tags:["Weapon"]},
    ]},
    {id:"sniper",label:"Sniper / DMR",tags:["Sniper rifle","Marksman rifle","Weapon"],subs:[
      {id:"svd",label:"SVD / RSASS",tags:["Weapon"]},{id:"bolt",label:"M700 / DVL / T-5000",tags:["Weapon"]},
    ]},
    {id:"shotgun",label:"Shotguns",tags:["Shotgun","Weapon"]},
    {id:"pistol",label:"Pistols",tags:["Handgun","Weapon"]},
    {id:"lmg",label:"Machine Guns",tags:["Machinegun","Weapon"]},
  ]},
  {id:"armor",label:"Armor & Gear",icon:"◆",tags:["Armor","Armored equipment","Chest rig"],subs:[
    {id:"bodyarmor",label:"Body Armor",tags:["Armor","Armored equipment"]},
    {id:"rigs",label:"Chest Rigs",tags:["Chest rig"]},
    {id:"helmets",label:"Helmets",tags:["Headwear","Armor"]},
    {id:"backpacks",label:"Backpacks",tags:["Backpack"]},
  ]},
  {id:"mods",label:"Weapon Mods",icon:"⚙",tags:["Weapon mod","Gear mod"],subs:[
    {id:"scopes",label:"Scopes & Sights",tags:["Scope","Reflex sight","Compact reflex sight"]},
    {id:"muzzle",label:"Suppressors & Muzzle",tags:["Silencer","Muzzle device","Flashhider"]},
    {id:"grips",label:"Grips & Stocks",tags:["Foregrip","Pistol grip","Stock"]},
    {id:"mags",label:"Magazines",tags:["Magazine"]},
  ]},
  {id:"medical",label:"Medical",icon:"✚",tags:["Meds","Medical supplies","Stimulant"],subs:[
    {id:"medkits",label:"Medkits",tags:["Medikit","Meds"]},
    {id:"stims",label:"Stimulants",tags:["Stimulant"]},
    {id:"medsupply",label:"Medical Supplies",tags:["Medical supplies"]},
  ]},
  {id:"tech",label:"Electronics & Tech",icon:"⚡",tags:["Electronics","Info"],subs:[
    {id:"electronics",label:"Electronics",tags:["Electronics"]},
    {id:"intel",label:"Intel & Data",tags:["Info"]},
  ]},
  {id:"barter",label:"Barter & Crafting",icon:"◈",tags:["Barter item","Building material","Tool","Household goods","Fuel"],subs:[
    {id:"building",label:"Building Materials",tags:["Building material"]},
    {id:"tools",label:"Tools",tags:["Tool","Multitools"]},
    {id:"fuel",label:"Fuel",tags:["Fuel"]},
    {id:"household",label:"Household Goods",tags:["Household goods"]},
  ]},
  {id:"keys",label:"Keys & Keycards",icon:"⚿",tags:["Key","Keycard","Mechanical Key"]},
  {id:"valuables",label:"Valuables",icon:"★",tags:["Jewelry","Money"]},
  {id:"ammo",label:"Ammo & Grenades",icon:"▪",tags:["Ammo","Throwable weapon"]},
  {id:"food",label:"Food & Drink",icon:"▫",tags:["Food","Drink","Food and drink"]},
];

// Rank maps by how many loot points match the given tags
function rankMapsByTags(tags) {
  const tagSet = new Set(tags);
  const mapScores = EMAPS.map(emap => {
    const matching = (emap.lootPoints || []).filter(lp => (lp.tags || []).some(t => tagSet.has(t)));
    return { mapId: emap.id, mapName: emap.name, color: emap.color, matchCount: matching.length, matchingSpots: matching.map(lp => lp.name) };
  }).filter(m => m.matchCount > 0).sort((a, b) => b.matchCount - a.matchCount);
  return mapScores;
}


// Each extract has: name, type, note, pct (approx position on map SVG 0-1), requireItems[]
const EMAPS = [
  {id:"customs",name:"Customs",tier:"Beginner",diff:1,color:"#c8a84b",
   desc:"Best starting map. Dense early quests.",bosses:["Reshala + 4 guards (Dorms)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Customs",mapgenie:"https://mapgenie.io/tarkov/maps/customs",tarkovdev:"https://tarkov.dev/map/customs",
   lootPoints:[
    {name:"Marked Room (Dorms 314)",type:"high-value",pct:{x:0.47,y:0.93},note:"Rare loot room — requires Marked Key",tags:["Weapon","Info","Key","Jewelry","Electronics"]},
    {name:"3-Story Dorms",type:"mixed",pct:{x:0.48,y:0.94},note:"Multiple locked rooms, weapon crates, jackets",tags:["Weapon","Weapon mod","Key","Jewelry","Meds","Info"]},
    {name:"2-Story Dorms",type:"mixed",pct:{x:0.50,y:0.92},note:"Safes, weapon boxes, quest items",tags:["Jewelry","Money","Weapon","Info"]},
    {name:"Crack House",type:"mixed",pct:{x:0.52,y:0.62},note:"Medical supplies, weapon parts, tech spawns",tags:["Meds","Medical supplies","Weapon mod","Electronics"]},
    {name:"USEC Stash (Big Red)",type:"tech",pct:{x:0.92,y:0.20},note:"Intel spawns, electronics, valuables",tags:["Electronics","Info","Jewelry"]},
    {name:"New Gas Station",type:"mixed",pct:{x:0.56,y:0.50},note:"Medical crate, food, barter items",tags:["Meds","Food","Barter item","Medical supplies"]},
    {name:"Old Gas Station",type:"stash",pct:{x:0.36,y:0.24},note:"Duffle bags, hidden stashes nearby",tags:["Barter item","Building material","Tool","Food"]},
    {name:"Warehouse 4 (Factory Shacks)",type:"mixed",pct:{x:0.40,y:0.55},note:"Weapon crates, loose loot, jackets",tags:["Weapon","Weapon mod","Ammo","Barter item"]},
   ],
   pmcExtracts:[
    {name:"Crossroads",                type:"open",   note:"Always available — south side", pct:{x:0.97,y:0.40}, requireItems:[]},
    {name:"RUAF Roadblock",            type:"open",   note:"Always available — central", pct:{x:0.66,y:0.31}, requireItems:[]},
    {name:"Trailer Park",              type:"open",   note:"Always available — far west", pct:{x:0.95,y:0.14}, requireItems:[]},
    {name:"Smugglers' Boat",           type:"open",   note:"Always available — south riverbank", pct:{x:0.69,y:0.79}, requireItems:[]},
    {name:"Old Gas Station",           type:"open",   note:"Always available", pct:{x:0.36,y:0.24}, requireItems:[]},
    {name:"Dorms V-Ex",                type:"pay",    note:"Pay roubles — 3-story dorms parking", pct:{x:0.48,y:0.96}, requireItems:["Roubles"]},
    {name:"ZB-1011",                   type:"key",    note:"Requires ZB-1011 key", pct:{x:0.07,y:0.33}, requireItems:["ZB-1011 key"]},
    {name:"Smugglers' Bunker (ZB-1012)", type:"key",  note:"Requires key", pct:{x:0.22,y:0.36}, requireItems:["ZB-1012 key"]},
    {name:"ZB-013",                    type:"key",    note:"Requires ZB-013 key", pct:{x:0.46,y:0.28}, requireItems:["ZB-013 key"]},
    {name:"Railroad Passage (Flare)",  type:"special",note:"Requires flare", pct:{x:0.52,y:0.02}, requireItems:["Flare"]},
    {name:"Boiler Room Basement (Co-op)", type:"coop", note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Crossroads",                type:"open",   note:"Always available", pct:{x:0.97,y:0.40}, requireItems:[]},
    {name:"Military Base CP",          type:"open",   note:"Always available", pct:{x:0.05,y:0.80}, requireItems:[]},
    {name:"Passage Between Rocks",     type:"open",   note:"Always available", pct:{x:0.15,y:0.93}, requireItems:[]},
    {name:"Railroad to Military Base", type:"open",   note:"Always available", pct:{x:0.20,y:0.97}, requireItems:[]},
    {name:"Old Road Gate",             type:"open",   note:"Always available", pct:{x:0.48,y:0.96}, requireItems:[]},
    {name:"Sniper Roadblock",          type:"open",   note:"Always available", pct:{x:0.64,y:0.80}, requireItems:[]},
    {name:"Railroad to Port",          type:"open",   note:"Always available", pct:{x:0.79,y:0.65}, requireItems:[]},
    {name:"Trailer Park Workers' Shack", type:"open", note:"Always available", pct:{x:0.88,y:0.14}, requireItems:[]},
    {name:"Railroad to Tarkov",        type:"open",   note:"Always available", pct:{x:0.81,y:0.16}, requireItems:[]},
    {name:"RUAF Roadblock",            type:"open",   note:"Always available", pct:{x:0.66,y:0.31}, requireItems:[]},
    {name:"Warehouse 17",              type:"open",   note:"Always available", pct:{x:0.60,y:0.44}, requireItems:[]},
    {name:"Factory Shacks",            type:"open",   note:"Always available", pct:{x:0.46,y:0.57}, requireItems:[]},
    {name:"Warehouse 4",               type:"open",   note:"Always available", pct:{x:0.33,y:0.52}, requireItems:[]},
    {name:"Old Gas Station Gate",      type:"open",   note:"Always available", pct:{x:0.37,y:0.20}, requireItems:[]},
    {name:"Factory Far Corner",        type:"open",   note:"Always available", pct:{x:0.04,y:0.27}, requireItems:[]},
    {name:"Administration Gate",       type:"open",   note:"Always available", pct:{x:0.03,y:0.46}, requireItems:[]},
    {name:"Scav Checkpoint",           type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
  },
  {id:"factory",name:"Factory",tier:"Beginner",diff:1,color:"#a85c3a",
   desc:"Tiny arena. Great for kill quests.",bosses:["Tagilla (avoid early)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Factory",mapgenie:"https://mapgenie.io/tarkov/maps/factory",tarkovdev:"https://tarkov.dev/map/factory",
   lootPoints:[
    {name:"Office (3rd Floor)",type:"mixed",pct:{x:0.6,y:0.25},note:"Safe, PC, jackets — best loot in Factory",tags:["Jewelry","Money","Electronics","Info","Key"]},
    {name:"Pumping Station",type:"mixed",pct:{x:0.35,y:0.5},note:"Weapon crates, loose ammo",tags:["Weapon","Weapon mod","Ammo"]},
    {name:"Breach Room",type:"mixed",pct:{x:0.5,y:0.7},note:"Weapon parts, medical spawns",tags:["Weapon mod","Meds","Medical supplies"]},
    {name:"Locker Room",type:"stash",pct:{x:0.7,y:0.55},note:"Jackets, duffle bags",tags:["Key","Barter item","Money"]},
   ],
   pmcExtracts:[
    {name:"Gate 0",             type:"open",   note:"Always available", pct:{x:0.09,y:0.98}, requireItems:[]},
    {name:"Gate 3",             type:"open",   note:"Always available", pct:{x:0.03,y:0.13}, requireItems:[]},
    {name:"Cellars",            type:"open",   note:"Always available — basement exit", pct:{x:0.73,y:0.02}, requireItems:[]},
    {name:"Courtyard Gate",     type:"open",   note:"Always available", pct:{x:0.02,y:0.37}, requireItems:[]},
    {name:"Med Tent Gate",      type:"open",   note:"Always available", pct:{x:0.98,y:0.66}, requireItems:[]},
    {name:"Smugglers' Passage", type:"key",    note:"Requires key", pct:{x:0.73,y:0.20}, requireItems:["Factory key"]},
   ],
   scavExtracts:[
    {name:"Gate 3",             type:"open",   note:"Always available", pct:{x:0.05,y:0.13}, requireItems:[]},
    {name:"Camera Bunker Door", type:"open",   note:"Always available", pct:{x:0.21,y:0.65}, requireItems:[]},
    {name:"Office Window",      type:"open",   note:"Always available — 3rd floor", pct:{x:0.21,y:0.42}, requireItems:[]},
   ],
  },
  {id:"woods",name:"Woods",tier:"Beginner",diff:2,color:"#4a7c3f",
   desc:"Open terrain. Teaches positioning vs AI.",bosses:["Shturman + 2 guards (Sawmill)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Woods",mapgenie:"https://mapgenie.io/tarkov/maps/woods",tarkovdev:"https://tarkov.dev/map/woods",
   lootPoints:[
    {name:"USEC Camp",type:"high-value",pct:{x:0.7,y:0.35},note:"Intel, electronics, weapon attachments, food",tags:["Info","Electronics","Weapon mod","Food","Barter item"]},
    {name:"Sunken Village",type:"mixed",pct:{x:0.25,y:0.65},note:"Hidden stashes, duffle bags, loose loot",tags:["Barter item","Building material","Tool","Food"]},
    {name:"Sawmill (Shturman)",type:"high-value",pct:{x:0.45,y:0.5},note:"Boss loot, weapon crates — dangerous area",tags:["Weapon","Weapon mod","Key","Ammo"]},
    {name:"Scav Bunker (ZB-016)",type:"mixed",pct:{x:0.6,y:0.44},note:"Weapon box, medical supplies",tags:["Weapon","Weapon mod","Meds","Medical supplies"]},
    {name:"Abandoned Village",type:"stash",pct:{x:0.35,y:0.78},note:"Stashes, jackets, food spawns",tags:["Food","Barter item","Key","Building material"]},
    {name:"Mountain Stash",type:"stash",pct:{x:0.78,y:0.15},note:"Hidden stashes along the ridge",tags:["Barter item","Building material","Tool","Meds"]},
   ],
   pmcExtracts:[
    {name:"UN Roadblock",              type:"open",   note:"Always available", pct:{x:0.84,y:0.89}, requireItems:[]},
    {name:"Northern UN Roadblock",     type:"open",   note:"Always available", pct:{x:0.86,y:0.62}, requireItems:[]},
    {name:"Outskirts",                 type:"open",   note:"Always available — far west", pct:{x:0.21,y:0.94}, requireItems:[]},
    {name:"RUAF Gate",                 type:"open",   note:"Always available", pct:{x:0.56,y:0.98}, requireItems:[]},
    {name:"Railway Bridge to Tarkov",  type:"open",   note:"Always available", pct:{x:0.98,y:0.77}, requireItems:[]},
    {name:"ZB-014",                    type:"key",    note:"Requires key", pct:{x:0.14,y:0.72}, requireItems:["ZB-014 key"]},
    {name:"ZB-016",                    type:"key",    note:"Requires key", pct:{x:0.74,y:0.68}, requireItems:["ZB-016 key"]},
    {name:"Bridge V-Ex",               type:"pay",    note:"Pay roubles", pct:{x:0.80,y:0.30}, requireItems:["Roubles"]},
    {name:"Power Line Passage (Flare)",type:"special",note:"Requires flare", pct:{x:0.05,y:0.61}, requireItems:["Flare"]},
    {name:"Friendship Bridge (Co-Op)", type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Outskirts",          type:"open",   note:"Always available", pct:{x:0.21,y:0.94}, requireItems:[]},
    {name:"Dead Man's Place",   type:"open",   note:"Always available", pct:{x:0.32,y:0.87}, requireItems:[]},
    {name:"Boat",               type:"open",   note:"Always available", pct:{x:0.33,y:0.83}, requireItems:[]},
    {name:"Scav House",         type:"open",   note:"Always available", pct:{x:0.17,y:0.85}, requireItems:[]},
    {name:"Scav Bunker",        type:"open",   note:"Always available", pct:{x:0.30,y:0.15}, requireItems:[]},
    {name:"Mountain Stash",     type:"open",   note:"Always available", pct:{x:0.61,y:0.52}, requireItems:[]},
    {name:"Eastern Rocks",      type:"open",   note:"Always available", pct:{x:0.82,y:0.65}, requireItems:[]},
    {name:"Old Railway Depot",  type:"open",   note:"Always available", pct:{x:0.83,y:0.78}, requireItems:[]},
    {name:"UN Roadblock",       type:"open",   note:"Always available", pct:{x:0.84,y:0.89}, requireItems:[]},
    {name:"RUAF Roadblock",     type:"open",   note:"Always available", pct:{x:0.56,y:0.98}, requireItems:[]},
   ],
  },
  {id:"interchange",name:"Interchange",tier:"Intermediate",diff:2,color:"#3a6b8a",
   desc:"ULTRA Mall. High loot density.",bosses:["Killa (mall interior)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Interchange",mapgenie:"https://mapgenie.io/tarkov/maps/interchange",tarkovdev:"https://tarkov.dev/map/interchange",
   lootPoints:[
    {name:"Techlight",type:"tech",pct:{x:0.52,y:0.3},note:"GPUs, Tetriz, electronics — top-tier tech loot",tags:["Electronics","Info"]},
    {name:"Rasmussen",type:"tech",pct:{x:0.48,y:0.35},note:"Electronics, barter items, tech spawns",tags:["Electronics","Barter item"]},
    {name:"KIBA Store",type:"high-value",pct:{x:0.55,y:0.42},note:"Weapons, attachments — requires 2 KIBA keys",tags:["Weapon","Weapon mod","Ammo"]},
    {name:"OLI (back shelves)",type:"mixed",pct:{x:0.6,y:0.6},note:"Fuel, motors, hoses, hideout materials",tags:["Fuel","Building material","Tool","Household goods"]},
    {name:"IDEA Office",type:"mixed",pct:{x:0.3,y:0.45},note:"PCs, filing cabinets, office loot",tags:["Electronics","Info","Barter item"]},
    {name:"EMERCOM Medical",type:"medical",pct:{x:0.75,y:0.72},note:"Medical supplies, stims, LEDX chance",tags:["Meds","Medical supplies","Stimulant"]},
    {name:"Power Station",type:"stash",pct:{x:0.08,y:0.15},note:"Weapon box, toolboxes, loose loot",tags:["Weapon","Tool","Building material"]},
    {name:"Mantis / German",type:"mixed",pct:{x:0.45,y:0.45},note:"Weapon parts, barter items in mall center",tags:["Weapon mod","Barter item","Armor"]},
   ],
   pmcExtracts:[
    {name:"Emercom Checkpoint",  type:"open",   note:"Always available", pct:{x:0.89,y:0.82}, requireItems:[]},
    {name:"Railway Exfil",       type:"open",   note:"Always available", pct:{x:0.12,y:0.02}, requireItems:[]},
    {name:"Hole in the Fence",   type:"open",   note:"Always available — IDEA side", pct:{x:0.79,y:0.47}, requireItems:[]},
    {name:"Power Station V-Ex",  type:"pay",    note:"Pay roubles", pct:{x:0.82,y:0.09}, requireItems:["Roubles"]},
    {name:"Saferoom Exfil",      type:"key",    note:"Requires key + power on", pct:{x:0.63,y:0.56}, requireItems:["Saferoom key"]},
    {name:"Scav Camp (Co-Op)",   type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Emercom Checkpoint",  type:"open",   note:"Always available", pct:{x:0.89,y:0.82}, requireItems:[]},
    {name:"Railway Exfil",       type:"open",   note:"Always available", pct:{x:0.12,y:0.02}, requireItems:[]},
    {name:"Scav Camp (Co-Op)",   type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
  },
  {id:"shoreline",name:"Shoreline",tier:"Intermediate",diff:3,color:"#5a8a7a",
   desc:"Resort = high risk/reward zone.",bosses:["Sanitar + guards (Resort)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Shoreline",mapgenie:"https://mapgenie.io/tarkov/maps/shoreline",tarkovdev:"https://tarkov.dev/map/shoreline",
   lootPoints:[
    {name:"East Wing Resort",type:"high-value",pct:{x:0.55,y:0.25},note:"LEDX, GPUs, rare keys — many locked rooms",tags:["Medical supplies","Electronics","Key","Jewelry","Stimulant"]},
    {name:"West Wing Resort",type:"high-value",pct:{x:0.48,y:0.25},note:"Safes, weapon spawns, intel folders",tags:["Jewelry","Money","Weapon","Info","Key"]},
    {name:"Admin Building (Resort)",type:"mixed",pct:{x:0.52,y:0.28},note:"PCs, office loot, quest items",tags:["Electronics","Info","Barter item"]},
    {name:"Pier",type:"mixed",pct:{x:0.52,y:0.85},note:"Safe, PCs, food, jackets",tags:["Jewelry","Money","Electronics","Food","Key"]},
    {name:"Gas Station",type:"mixed",pct:{x:0.62,y:0.55},note:"Medical crate, register, loose loot",tags:["Meds","Medical supplies","Food","Barter item"]},
    {name:"Weather Station",type:"tech",pct:{x:0.72,y:0.38},note:"Tech spawns, intel, electronics",tags:["Electronics","Info"]},
    {name:"Swamp Village",type:"stash",pct:{x:0.2,y:0.7},note:"Hidden stashes, tool boxes, building loot",tags:["Building material","Tool","Barter item"]},
   ],
   pmcExtracts:[
    {name:"Road to Customs",       type:"open",   note:"Always available", pct:{x:0.87,y:0.40}, requireItems:[]},
    {name:"Pier Boat",             type:"open",   note:"Always available", pct:{x:0.54,y:0.95}, requireItems:[]},
    {name:"Climber's Trail",       type:"special",note:"Requires Paracord + Red Rebel + no armored rig", pct:{x:0.46,y:0.05}, requireItems:["Paracord","Red Rebel Ice Pick"]},
    {name:"Path to Lighthouse",    type:"open",   note:"Always available", pct:{x:0.04,y:0.16}, requireItems:[]},
    {name:"Mountain Bunker",       type:"key",    note:"Requires key", pct:{x:0.57,y:0.03}, requireItems:["Bunker key"]},
    {name:"Railway Bridge",        type:"open",   note:"Always available", pct:{x:0.98,y:0.70}, requireItems:[]},
    {name:"Tunnel",                type:"open",   note:"Always available — west side", pct:{x:0.08,y:0.71}, requireItems:[]},
    {name:"Road to North V-Ex",    type:"pay",    note:"Pay roubles", pct:{x:0.67,y:0.03}, requireItems:["Roubles"]},
    {name:"Smugglers' Path (Co-op)", type:"coop", note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Road to Customs",       type:"open",   note:"Always available", pct:{x:0.87,y:0.40}, requireItems:[]},
    {name:"Lighthouse",            type:"open",   note:"Always available", pct:{x:0.62,y:0.95}, requireItems:[]},
    {name:"Ruined Road",           type:"open",   note:"Always available", pct:{x:0.09,y:0.72}, requireItems:[]},
    {name:"East Wing Gym Entrance",type:"open",   note:"Always available — Resort east wing", pct:{x:0.51,y:0.30}, requireItems:[]},
    {name:"Admin Basement",        type:"open",   note:"Always available — Resort basement", pct:{x:0.49,y:0.26}, requireItems:[]},
   ],
  },
  {id:"reserve",name:"Reserve",tier:"Advanced",diff:4,color:"#7a5a8a",
   desc:"Raiders are elite AI. Very dangerous.",bosses:["Glukhar (Admin)","Raiders (underground)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Reserve",mapgenie:"https://mapgenie.io/tarkov/maps/reserve",tarkovdev:"https://tarkov.dev/map/reserve",
   lootPoints:[
    {name:"Marked Room (RB-BK)",type:"high-value",pct:{x:0.42,y:0.35},note:"Rare items, keycards, weapon cases",tags:["Weapon","Key","Keycard","Jewelry","Info"]},
    {name:"Black Knight",type:"mixed",pct:{x:0.55,y:0.42},note:"Weapon crates, attachments, ammo",tags:["Weapon","Weapon mod","Ammo"]},
    {name:"White Knight",type:"mixed",pct:{x:0.48,y:0.45},note:"Weapon spawns, crates, medical loot",tags:["Weapon","Weapon mod","Meds","Medical supplies"]},
    {name:"King Building",type:"high-value",pct:{x:0.52,y:0.38},note:"Intel, electronics, military tech",tags:["Info","Electronics","Weapon mod"]},
    {name:"Underground Bunkers",type:"high-value",pct:{x:0.4,y:0.55},note:"Raiders, weapon crates, ammo, rare spawns",tags:["Weapon","Ammo","Armor","Weapon mod","Meds"]},
    {name:"Helicopter",type:"mixed",pct:{x:0.58,y:0.5},note:"Military loot, weapon parts",tags:["Weapon mod","Ammo","Weapon"]},
    {name:"Drop-Down Room",type:"tech",pct:{x:0.35,y:0.3},note:"Tech spawns, loose electronics",tags:["Electronics","Info"]},
   ],
   pmcExtracts:[
    {name:"Cliff Descent",         type:"special",note:"Requires Paracord + Red Rebel + no armored rig", pct:{x:0.50,y:0.93}, requireItems:["Paracord","Red Rebel Ice Pick"]},
    {name:"D-2",                   type:"special",note:"Requires pulling levers in underground", pct:{x:0.69,y:0.87}, requireItems:[]},
    {name:"Exit to Woods",         type:"open",   note:"Always available", pct:{x:0.43,y:0.13}, requireItems:[]},
    {name:"Armored Train",         type:"timed",  note:"Spawns randomly — listen for the horn", pct:{x:0.24,y:0.27}, requireItems:[]},
    {name:"Bunker Hermetic Door",  type:"special",note:"Requires activation", pct:{x:0.38,y:0.19}, requireItems:[]},
    {name:"Sewer Manhole",         type:"open",   note:"Always available — no backpack allowed", pct:{x:0.42,y:0.69}, requireItems:[]},
    {name:"Scav Lands (Co-Op)",    type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Hole in the Wall by the Mountains", type:"open", note:"Always available", pct:{x:0.93,y:0.64}, requireItems:[]},
    {name:"Heating Pipe",          type:"open",   note:"Always available", pct:{x:0.55,y:0.21}, requireItems:[]},
    {name:"Depot Hermetic Door",   type:"open",   note:"Always available", pct:{x:0.28,y:0.32}, requireItems:[]},
    {name:"Checkpoint Fence",      type:"open",   note:"Always available", pct:{x:0.38,y:0.80}, requireItems:[]},
   ],
  },
  {id:"lighthouse",name:"Lighthouse",tier:"Advanced",diff:4,color:"#8a7a3a",
   desc:"Rogues shoot PMCs on sight.",bosses:["Rogues (Water Treatment)","Zryachiy (island)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Lighthouse",mapgenie:"https://mapgenie.io/tarkov/maps/lighthouse",tarkovdev:"https://tarkov.dev/map/lighthouse",
   lootPoints:[
    {name:"Water Treatment (Rogues)",type:"high-value",pct:{x:0.35,y:0.4},note:"Best loot on map — Rogue gear, crates, intel. Very dangerous.",tags:["Weapon","Armor","Weapon mod","Ammo","Electronics","Info"]},
    {name:"Chalet",type:"high-value",pct:{x:0.7,y:0.55},note:"Safes, valuables, rare spawns",tags:["Jewelry","Money","Info","Key"]},
    {name:"Resort Hotel",type:"mixed",pct:{x:0.55,y:0.65},note:"Safes, PCs, jackets, loose valuables",tags:["Jewelry","Money","Electronics","Key"]},
    {name:"Train Yard",type:"mixed",pct:{x:0.2,y:0.82},note:"Weapon crates, ammo spawns",tags:["Weapon","Weapon mod","Ammo"]},
    {name:"Rogue Camp (North)",type:"high-value",pct:{x:0.3,y:0.2},note:"Military crates, Rogue drops",tags:["Weapon","Armor","Weapon mod","Ammo"]},
    {name:"Southern Road Stashes",type:"stash",pct:{x:0.65,y:0.88},note:"Hidden stashes along the road",tags:["Barter item","Building material","Food","Meds"]},
   ],
   pmcExtracts:[
    {name:"Mountain Pass",             type:"special",note:"Requires Paracord + Red Rebel + no armored rig", pct:{x:0.65,y:0.58}, requireItems:["Paracord","Red Rebel Ice Pick"]},
    {name:"Northern Checkpoint",       type:"open",   note:"Always available", pct:{x:0.38,y:0.02}, requireItems:[]},
    {name:"Passage by the Lake",       type:"open",   note:"Always available", pct:{x:0.83,y:0.25}, requireItems:[]},
    {name:"Path to Shoreline",         type:"open",   note:"Always available", pct:{x:0.83,y:0.51}, requireItems:[]},
    {name:"Southern Road",             type:"open",   note:"Always available", pct:{x:0.76,y:0.82}, requireItems:[]},
    {name:"Road to Military Base V-Ex",type:"pay",    note:"Pay roubles", pct:{x:0.80,y:0.12}, requireItems:["Roubles"]},
    {name:"Armored Train",             type:"timed",  note:"Spawns randomly — listen for horn", pct:{x:0.48,y:0.07}, requireItems:[]},
    {name:"Side Tunnel (Co-Op)",       type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Path to Shoreline",         type:"open",   note:"Always available", pct:{x:0.83,y:0.51}, requireItems:[]},
    {name:"Southern Road Landslide",   type:"open",   note:"Always available", pct:{x:0.75,y:0.82}, requireItems:[]},
    {name:"Hideout Under the Landing Stage", type:"open", note:"Always available", pct:{x:0.36,y:0.75}, requireItems:[]},
    {name:"Scav Hideout at the Grotto",type:"open",   note:"Always available", pct:{x:0.32,y:0.30}, requireItems:[]},
    {name:"Industrial Zone Gates",     type:"open",   note:"Always available", pct:{x:0.63,y:0.12}, requireItems:[]},
   ],
  },
  {id:"streets-of-tarkov",name:"Streets",tier:"Advanced",diff:4,color:"#8a4a4a",
   desc:"Massive urban map. The Goons roam here.",bosses:["The Goons (roaming)","Kolontay + guards"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Streets_of_Tarkov",mapgenie:"https://mapgenie.io/tarkov/maps/streets-of-tarkov",tarkovdev:"https://tarkov.dev/map/streets-of-tarkov",
   lootPoints:[
    {name:"Concordia",type:"high-value",pct:{x:0.45,y:0.4},note:"Apartments — safes, PCs, valuables, quest items",tags:["Jewelry","Money","Electronics","Info","Key"]},
    {name:"Lexos Dealership",type:"high-value",pct:{x:0.55,y:0.55},note:"High-value car spawns, intel, electronics",tags:["Info","Electronics","Jewelry"]},
    {name:"TerraGroup Building",type:"tech",pct:{x:0.38,y:0.6},note:"Tech loot, PCs, server racks",tags:["Electronics","Info"]},
    {name:"Cardinal Hotel",type:"mixed",pct:{x:0.85,y:0.18},note:"Multiple floors, weapon spawns, safes",tags:["Weapon","Jewelry","Money","Key","Meds"]},
    {name:"Pinewood Hotel",type:"mixed",pct:{x:0.3,y:0.3},note:"Safes, loose loot, jackets",tags:["Jewelry","Money","Key","Barter item"]},
    {name:"Underground Parking",type:"stash",pct:{x:0.5,y:0.7},note:"Weapon crates, duffle bags, stashes",tags:["Weapon","Barter item","Building material","Tool"]},
   ],
   pmcExtracts:[
    {name:"Courtyard",              type:"open",   note:"Always available", pct:{x:0.78,y:0.96}, requireItems:[]},
    {name:"Damaged House",          type:"open",   note:"Always available", pct:{x:0.95,y:0.77}, requireItems:[]},
    {name:"Crash Site",             type:"open",   note:"Always available", pct:{x:0.02,y:0.85}, requireItems:[]},
    {name:"Sewer River",            type:"open",   note:"Always available — underground sewer exit", pct:{x:0.98,y:0.62}, requireItems:[]},
    {name:"Collapsed Crane",        type:"open",   note:"Always available", pct:{x:0.18,y:0.69}, requireItems:[]},
    {name:"Expo Checkpoint",        type:"open",   note:"Always available", pct:{x:0.18,y:0.23}, requireItems:[]},
    {name:"Smugglers' Basement",    type:"open",   note:"Always available", pct:{x:0.41,y:0.42}, requireItems:[]},
    {name:"Stylobate Building Elevator", type:"key", note:"Requires key", pct:{x:0.61,y:0.27}, requireItems:["Stylobate key"]},
    {name:"Primorsky Ave Taxi V-Ex",type:"pay",    note:"Pay roubles for taxi extraction", pct:{x:0.54,y:0.91}, requireItems:["Roubles"]},
    {name:"Klimov Street (Flare)",  type:"special",note:"Requires flare signal", pct:{x:0.97,y:0.41}, requireItems:["Flare"]},
    {name:"Pinewood Basement (Co-Op)", type:"coop", note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Entrance to Catacombs",  type:"open",   note:"Always available — underground entrance", pct:{x:0.95,y:0.65}, requireItems:[]},
    {name:"Ventilation Shaft",      type:"open",   note:"Always available", pct:{x:0.74,y:0.87}, requireItems:[]},
    {name:"Sewer Manhole",          type:"open",   note:"Always available — sewer access", pct:{x:0.08,y:0.77}, requireItems:[]},
    {name:"Near Kamchatskaya Arch", type:"open",   note:"Always available — near the arch", pct:{x:0.11,y:0.42}, requireItems:[]},
    {name:"Cardinal Apartment Complex Parking", type:"open", note:"Always available — parking area", pct:{x:0.36,y:0.16}, requireItems:[]},
    {name:"Klimov Shopping Mall Exfil", type:"open", note:"Always available — mall area", pct:{x:0.81,y:0.35}, requireItems:[]},
   ],
  },
  {id:"ground-zero",name:"Ground Zero",tier:"Beginner",diff:1,color:"#6a8a5a",
   desc:"Starter map. Learn the basics here.",bosses:["Kollontay (roaming, rare)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Ground_Zero",mapgenie:"https://mapgenie.io/tarkov/maps/ground-zero",tarkovdev:"https://tarkov.dev/map/ground-zero",
   lootPoints:[
    {name:"Office Building",type:"mixed",pct:{x:0.45,y:0.35},note:"PCs, safes, office loot",tags:["Electronics","Jewelry","Money","Info"]},
    {name:"Supermarket",type:"mixed",pct:{x:0.55,y:0.5},note:"Food, barter items, medical supplies",tags:["Food","Barter item","Meds","Medical supplies"]},
    {name:"Parking Garage",type:"stash",pct:{x:0.4,y:0.6},note:"Weapon crates, duffle bags",tags:["Weapon","Barter item","Building material"]},
    {name:"Residential Buildings",type:"stash",pct:{x:0.6,y:0.4},note:"Jackets, stashes, loose loot",tags:["Key","Barter item","Food","Building material"]},
   ],
   pmcExtracts:[
    {name:"Police Cordon V-Ex",       type:"pay",    note:"Pay roubles", pct:{x:0.77,y:0.49}, requireItems:["Roubles"]},
    {name:"Tartowers Sales Office",   type:"open",   note:"Always available", pct:{x:0.17,y:0.53}, requireItems:[]},
    {name:"Emercom Checkpoint",       type:"open",   note:"Always available", pct:{x:0.28,y:0.05}, requireItems:[]},
    {name:"Nakatani Basement Stairs", type:"open",   note:"Always available", pct:{x:0.76,y:0.94}, requireItems:[]},
    {name:"Mira Ave (Flare)",         type:"special",note:"Requires flare", pct:{x:0.09,y:0.18}, requireItems:["Flare"]},
    {name:"Scav Checkpoint (Co-op)",  type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Emercom Checkpoint",       type:"open",   note:"Always available", pct:{x:0.28,y:0.05}, requireItems:[]},
    {name:"Nakatani Basement Stairs", type:"open",   note:"Always available", pct:{x:0.76,y:0.94}, requireItems:[]},
    {name:"Scav Checkpoint (Co-op)",  type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
  },
  {id:"the-lab",name:"The Lab",tier:"Endgame",diff:5,color:"#4a8a8a",
   desc:"Raiders everywhere. Keycards to extract.",bosses:["Raiders (entire map)","Facility Guards"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/The_Lab",mapgenie:"https://mapgenie.io/tarkov/maps/the-lab",tarkovdev:"https://tarkov.dev/map/the-lab",
   lootPoints:[
    {name:"Server Room",type:"tech",pct:{x:0.45,y:0.35},note:"GPUs, electronics, server racks — premium tech",tags:["Electronics","Info"]},
    {name:"Manager's Office",type:"high-value",pct:{x:0.52,y:0.45},note:"Safe, intel, rare spawns",tags:["Jewelry","Money","Info","Key"]},
    {name:"Weapon Testing",type:"mixed",pct:{x:0.65,y:0.55},note:"Weapon crates, rare attachments, ammo",tags:["Weapon","Weapon mod","Ammo"]},
    {name:"Green Lab",type:"medical",pct:{x:0.35,y:0.6},note:"LEDX chance, stims, medical supplies",tags:["Medical supplies","Stimulant","Meds"]},
    {name:"Blue Lab",type:"tech",pct:{x:0.7,y:0.4},note:"Tech spawns, electronics, lab equipment",tags:["Electronics","Info","Barter item"]},
   ],
   pmcExtracts:[
    {name:"Hangar Gate",        type:"key",    note:"Requires keycard", pct:{x:0.81,y:0.56}, requireItems:["Keycard"]},
    {name:"Parking Gate",       type:"key",    note:"Requires keycard", pct:{x:0.15,y:0.27}, requireItems:["Keycard"]},
    {name:"Sewage Conduit",     type:"open",   note:"Always available — no backpack", pct:{x:0.77,y:0.79}, requireItems:[]},
    {name:"Ventilation Shaft",  type:"open",   note:"Always available", pct:{x:0.28,y:0.69}, requireItems:[]},
    {name:"Cargo Elevator",     type:"open",   note:"Always available", pct:{x:0.24,y:0.84}, requireItems:[]},
    {name:"Main Elevator",      type:"open",   note:"Always available", pct:{x:0.50,y:0.02}, requireItems:[]},
    {name:"Medical Block Elevator", type:"open", note:"Always available", pct:{x:0.47,y:0.84}, requireItems:[]},
   ],
   scavExtracts:[],
  },
];

// ─── MAP COORDINATE BOUNDS ──────────────────────────────────────────────
// Derived from tarkov.dev maps.json transform + coordinateRotation data.
// SVG maps are drawn inverted; these bounds map game world coords → SVG 0-1 pct.
// {left,right,top,bottom} = game coordinate value at each SVG edge.
// swap: true if axes are swapped (90°/270° rotation maps).
const MAP_BOUNDS = {
  customs:             {left:698,right:-372,top:-307,bottom:237},
  factory:             {left:67.4,right:-64.5,top:77,bottom:-65.5,swap:true},
  woods:               {left:646,right:-761,top:-914,bottom:442},
  interchange:         {left:598,right:-433,top:-442,bottom:426},
  shoreline:           {left:504,right:-1056,top:-415,bottom:618},
  reserve:             {left:289,right:-303,top:-293,bottom:244},
  lighthouse:          {left:515,right:-545,top:-998,bottom:725},
  "streets-of-tarkov": {left:323,right:-280,top:-295,bottom:532},
  "the-lab":           {left:-477,right:-193,top:-287,bottom:-80,swap:true},
  "ground-zero":       {left:249,right:-99,top:-124,bottom:364},
};

// ─── ROUTE UTILS ─────────────────────────────────────────────────────────
function worldToPct(pos,bounds){if(!pos||!bounds)return null;const{left,right,top,bottom}=bounds;const gx=bounds.swap?pos.z:pos.x;const gz=bounds.swap?pos.x:pos.z;const x=(gx-left)/(right-left);const y=(gz-top)/(bottom-top);if(isNaN(x)||isNaN(y))return null;if(x<-0.05||x>1.05||y<-0.05||y>1.05)return null;return{x:Math.max(0.02,Math.min(0.98,x)),y:Math.max(0.02,Math.min(0.98,y))};}
function nearestNeighbor(waypoints){if(!waypoints.length)return[];const origin={pct:{x:0.5,y:0.5}};const remaining=[...waypoints];const route=[];let cur=origin;while(remaining.length){const hasPos=remaining.some(w=>w.pct);if(!hasPos){route.push(...remaining);break;}let best=0,bestD=Infinity;remaining.forEach((w,i)=>{if(!w.pct)return;const d=Math.hypot(w.pct.x-cur.pct.x,w.pct.y-cur.pct.y);if(d<bestD){bestD=d;best=i;}});const next=remaining.splice(best,1)[0];route.push(next);if(next.pct)cur={pct:next.pct};}return route;}
function getObjMeta(obj){const t=obj.type;if(t==="shoot")return{icon:"☠",color:"#e05a5a",summary:`Kill ${obj.count>1?obj.count+"× ":""}${obj.targetNames?.[0]||"enemy"}${obj.zoneNames?.length?" ("+obj.zoneNames[0]+")":""}`,isCountable:true,total:obj.count||1};if(t==="findItem"||t==="giveItem")return{icon:"◈",color:"#d4b84a",summary:`${obj.count>1?obj.count+"× ":""}${obj.items?.[0]?.name||"item"}${obj.foundInRaid?" (FIR)":""}`,isCountable:obj.count>1,total:obj.count||1};if(t==="findQuestItem"||t==="giveQuestItem")return{icon:"◈",color:"#d4b84a",summary:obj.questItem?.name||obj.description,isCountable:false,total:1};if(t==="visit"||t==="mark")return{icon:"◉",color:"#9a7aba",summary:obj.description,isCountable:false,total:1};if(t==="extract")return{icon:"⬆",color:"#5dba5d",summary:obj.exitName?`Extract via ${obj.exitName}`:"Extract from map",isCountable:false,total:1};return{icon:"♦",color:"#7a9a7a",summary:obj.description||t,isCountable:false,total:1};}

// ─── PREREQUISITE HELPERS ─────────────────────────────────────────────────
function getAllPrereqTaskIds(taskId, apiTasks, visited = new Set()) {
  if (visited.has(taskId)) return [];
  visited.add(taskId);
  const task = apiTasks?.find(t => t.id === taskId);
  if (!task?.taskRequirements?.length) return [];
  const prereqIds = [];
  for (const req of task.taskRequirements) {
    if (req.status?.includes("complete") && req.task?.id) {
      prereqIds.push(req.task.id);
      prereqIds.push(...getAllPrereqTaskIds(req.task.id, apiTasks, visited));
    }
  }
  return prereqIds;
}
function markTaskCompleteInProgress(profileId, taskId, apiTask, progress) {
  const p = { ...progress };
  (apiTask.objectives || []).forEach(obj => {
    if (obj.optional) return;
    const k = `${profileId}-${taskId}-${obj.id}`;
    const meta = getObjMeta(obj);
    p[k] = meta.total;
  });
  return p;
}

// ─── MAP RECOMMENDATION ──────────────────────────────────────────────────
function computeMapRecommendation(profiles, apiTasks) {
  if (!profiles?.length || !apiTasks?.length) return [];
  const mapStats = {}; // mapId -> { mapId, mapName, totalTasks, totalIncomplete, players: { pid -> { name, color, tasks: [{ taskName, remaining, total }] } } }

  profiles.forEach(profile => {
    (profile.tasks || []).forEach(({ taskId }) => {
      const apiTask = apiTasks.find(t => t.id === taskId);
      if (!apiTask?.map?.id) return;

      const objs = (apiTask.objectives || []).filter(o => !o.optional);
      const totalObjs = objs.length;
      const doneObjs = objs.filter(obj => {
        const k = `${profile.id}-${taskId}-${obj.id}`;
        return ((profile.progress || {})[k] || 0) >= getObjMeta(obj).total;
      }).length;

      if (doneObjs >= totalObjs && totalObjs > 0) return; // fully complete

      const mid = apiTask.map.id;
      if (!mapStats[mid]) mapStats[mid] = { mapId: mid, mapName: apiTask.map.name, totalTasks: 0, totalIncomplete: 0, players: {} };
      const ms = mapStats[mid];

      if (!ms.players[profile.id]) ms.players[profile.id] = { name: profile.name, color: profile.color, isMe: !profile.imported, tasks: [] };
      ms.players[profile.id].tasks.push({ taskName: apiTask.name, remaining: totalObjs - doneObjs, total: totalObjs });
      ms.totalTasks++;
      ms.totalIncomplete += (totalObjs - doneObjs);
    });
  });

  return Object.values(mapStats)
    .sort((a, b) => b.totalTasks - a.totalTasks || b.totalIncomplete - a.totalIncomplete)
    .map((ms, i) => ({ ...ms, rank: i + 1, playerCount: Object.keys(ms.players).length, playerList: Object.values(ms.players) }));
}

function computeQuickTasks(profiles, mapId, apiTasks, tasksPerPerson) {
  const result = {};
  profiles.forEach(profile => {
    const incomplete = (profile.tasks || []).filter(t => {
      const at = apiTasks?.find(x => x.id === t.taskId);
      if (!at || at.map?.id !== mapId) return false;
      const objs = (at.objectives || []).filter(o => !o.optional);
      if (!objs.length) return false;
      const done = objs.filter(obj => {
        const k = `${profile.id}-${t.taskId}-${obj.id}`;
        return ((profile.progress || {})[k] || 0) >= getObjMeta(obj).total;
      }).length;
      return done < objs.length;
    });
    result[profile.id] = incomplete.slice(0, tasksPerPerson).map(t => t.taskId);
  });
  return result;
}

// Convert item name to loot-point category tags via heuristics (for items without API categories)
function itemNameToCategories(name) {
  const cats = [];
  const n = (name || "").toLowerCase();
  if (n.includes("gpu") || n.includes("graphics") || n.includes("circuit") || n.includes("wire") || n.includes("relay") || n.includes("tetriz") || n.includes("vpx") || n.includes("flash drive") || n.includes("ssd") || n.includes("phase") || n.includes("capacitor") || n.includes("cable") || n.includes("processor")) cats.push("Electronics");
  if (n.includes("ledx") || n.includes("ophthalmoscope") || n.includes("defib") || n.includes("salewa") || n.includes("medic") || n.includes("surv12") || n.includes("cms") || n.includes("vaseline")) cats.push("Medical supplies");
  if (n.includes("salewa") || n.includes("grizzly") || n.includes("ifak") || n.includes("afak") || n.includes("cms") || n.includes("surv")) cats.push("Meds");
  if (n.includes("stim") || n.includes("propital") || n.includes("etg") || n.includes("sj")) cats.push("Stimulant");
  if (n.includes("bolt") || n.includes("screw") || n.includes("nail") || n.includes("duct tape") || n.includes("insulating") || n.includes("bulb") || n.includes("cable") || n.includes("capacitor")) cats.push("Building material");
  if (n.includes("wrench") || n.includes("plier") || n.includes("screwdriver") || n.includes("multitool")) cats.push("Tool");
  if (n.includes("hose") || n.includes("pipe") || n.includes("motor") || n.includes("filter") || n.includes("tube") || n.includes("corrugated")) cats.push("Household goods");
  if (n.includes("fuel") || n.includes("propane") || n.includes("expeditionary")) cats.push("Fuel");
  if (n.includes("weapon") || n.includes("gun") || n.includes("rifle") || n.includes("pistol") || n.includes("ak-") || n.includes("m4a1")) cats.push("Weapon");
  if (n.includes("intel") || n.includes("folder") || n.includes("diary") || n.includes("sas drive")) cats.push("Info");
  if (n.includes("key") && !n.includes("keyboard")) cats.push("Key");
  if (n.includes("gold") || n.includes("bitcoin") || n.includes("lion") || n.includes("cat figurine") || n.includes("horse") || n.includes("chain") || n.includes("roler")) cats.push("Jewelry");
  if (n.includes("battery") || n.includes("military") || n.includes("gyro") || n.includes("power")) cats.push("Electronics");
  if (cats.length === 0) { cats.push("Barter item"); cats.push("Building material"); }
  return [...new Set(cats)].map(c => ({ name: c }));
}

// Container type → item keyword affinity for scoring
const CONTAINER_AFFINITY = {
  "PC block": ["circuit","cpu","fan","ram","ssd","hdd","flash","drive","wire","cable","capacitor","processor","graphics","board"],
  "Toolbox": ["bolt","screw","nut","nail","wrench","plier","tape","hose","drill","clamp","pipe","tube","relay","motor","bulb","wire","cable","tool","awl","cutter"],
  "Medcase": ["bandage","medkit","saline","medicine","pills","injector","splint","tourniquet","surgical","balsam","balm","ibuprofen","analgin"],
  "Medbag SMU06": ["bandage","medkit","saline","medicine","pills","injector","splint","tourniquet","surgical","balsam","balm"],
  "Technical supply crate": ["battery","military","filter","gyro","cable","power","relay","corrugated"],
  "Drawer": ["diary","folder","intel","flash","key","chain","match","lighter","book"],
  "Jacket": ["key","match","lighter"],
  "Safe": ["roler","bitcoin","lion","gold","chain","ring","figurine"],
  "Weapon box": ["gun lube","weapon","silicone"],
};

function computeItemRecommendation(neededItems, apiMaps) {
  if (!neededItems?.length || !apiMaps?.length) return [];
  const playable = ["customs","factory","woods","interchange","shoreline","reserve","lighthouse","streets-of-tarkov","the-lab"];

  // Build container counts per map
  const mapScores = {};
  apiMaps.filter(m => playable.includes(m.normalizedName)).forEach(m => {
    const containerCounts = {};
    (m.lootContainers || []).forEach(c => {
      const n = c.lootContainer.name;
      containerCounts[n] = (containerCounts[n] || 0) + 1;
    });
    const totalContainers = Object.values(containerCounts).reduce((a, b) => a + b, 0);

    // Score: base from total containers + bonus for containers matching needed item types
    let affinityScore = 0;
    neededItems.forEach(item => {
      const nameLower = item.name.toLowerCase();
      Object.entries(CONTAINER_AFFINITY).forEach(([containerType, keywords]) => {
        if (keywords.some(kw => nameLower.includes(kw))) {
          affinityScore += (containerCounts[containerType] || 0) * item.count;
        }
      });
    });

    mapScores[m.id] = {
      mapId: m.id, mapName: m.name,
      totalContainers,
      affinityScore,
      score: totalContainers + affinityScore * 2,
      neededItems: neededItems.map(i => ({ ...i })),
    };
  });

  return Object.values(mapScores)
    .sort((a, b) => b.score - a.score)
    .map((ms, i) => ({ ...ms, rank: i + 1 }));
}

// ─── SHARED UI ────────────────────────────────────────────────────────────
const SL=({c,s={}})=><div style={{fontSize:T.fs2,color:T.textDim,letterSpacing:1.5,marginBottom:T.sp2,fontFamily:T.sans,textTransform:"uppercase",fontWeight:600,...s}}>{c}</div>;
const Badge=({label,color,small})=><span style={{background:color+"22",color,border:`1px solid ${color}44`,padding:small?`2px 6px`:`${T.sp1}px ${T.sp2}px`,fontSize:small?T.fs1:T.fs2,letterSpacing:0.5,fontFamily:T.sans,whiteSpace:"nowrap"}}>{label}</span>;
// Button sizes: small (fs1/sp1), medium (fs2/sp2), large (fs3/sp3)
const Btn=({ch,onClick,active,color=T.gold,small,style={},disabled})=><button onClick={disabled?undefined:onClick} style={{background:active?color+"22":"transparent",color:disabled?T.textDim:(active?color:T.textDim),border:active?`2px solid ${color}`:`1px solid ${T.border}`,padding:small?`${T.sp1}px ${T.sp2}px`:`${T.sp2}px ${T.sp4}px`,fontSize:small?T.fs2:T.fs3,letterSpacing:1,cursor:disabled?"default":"pointer",fontFamily:T.sans,textTransform:"uppercase",whiteSpace:"nowrap",fontWeight:active?"bold":"normal",transition:"background 0.15s, border-color 0.15s",...style}}>{ch}</button>;

function Tip({ text, step }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        style={{
          width: 16, height: 16, borderRadius: "50%",
          background: open ? T.surfaceAlt : "transparent",
          border: `1px solid ${open ? T.gold : T.border}`,
          color: open ? T.gold : T.textDim,
          fontSize: 12, fontWeight: "bold", fontFamily: T.sans,
          cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
          padding: 0, marginLeft: 6, flexShrink: 0,
        }}
      >?</button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: 22, left: -8, zIndex: 50,
            background: T.surface, border: `1px solid ${T.gold}55`,
            borderLeft: `2px solid ${T.gold}`,
            padding: "8px 10px", minWidth: 220, maxWidth: 280,
            boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
          }}
        >
          {step && <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.gold, marginBottom: 4, fontFamily: T.sans }}>{step}</div>}
          <div style={{ fontSize: T.fs3, color: T.text, lineHeight: 1.6, fontFamily: T.sans }}>{text}</div>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, padding: "4px 0 0", letterSpacing: 0.5 }}
          >DISMISS</button>
        </div>
      )}
    </span>
  );
}

// ─── HIDEOUT MANAGER ─────────────────────────────────────────────────────
function HideoutManager({ apiHideout, hideoutLevels, saveHideoutLevels, hideoutTarget, saveHideoutTarget, onBack }) {
  const [prereqPrompt, setPrereqPrompt] = useState(null); // { stationName, level, unmet: [{stationId, stationName, level}] }
  if (!apiHideout?.length) return <div style={{ color: T.textDim, fontSize: T.fs4, padding: 20, textAlign: "center" }}>Loading hideout data...</div>;

  const stations = apiHideout.filter(s => s.levels.length > 0).sort((a, b) => a.name.localeCompare(b.name));
  const target = hideoutTarget ? stations.find(s => s.id === hideoutTarget.stationId) : null;
  const targetLevel = target?.levels.find(l => l.level === hideoutTarget?.level);

  // Check if station level requirements are met
  const canBuild = (station, level) => {
    const lvl = station.levels.find(l => l.level === level);
    if (!lvl) return false;
    return (lvl.stationLevelRequirements || []).every(req =>
      (hideoutLevels[req.station.id] || 0) >= req.level
    );
  };

  // Get unmet prerequisites for a station level
  const getUnmetPrereqs = (station, level) => {
    const lvl = station.levels.find(l => l.level === level);
    if (!lvl) return [];
    return (lvl.stationLevelRequirements || [])
      .filter(req => (hideoutLevels[req.station.id] || 0) < req.level)
      .map(req => ({ stationId: req.station.id, stationName: req.station.name, level: req.level }));
  };

  // Handle target button click — show prereq prompt if needed
  const handleTargetClick = (station, level, isThisTarget) => {
    if (isThisTarget) { saveHideoutTarget(null); return; }
    const unmet = getUnmetPrereqs(station, level);
    if (unmet.length > 0) {
      setPrereqPrompt({ stationName: station.name, stationId: station.id, level, unmet });
    } else {
      saveHideoutTarget({ stationId: station.id, level });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <button onClick={onBack} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs3, letterSpacing: 1, cursor: "pointer", fontFamily: T.sans, padding: 0, marginBottom: 8 }}>← BACK</button>
        <SL c={<>HIDEOUT UPGRADES<Tip text="Set your current hideout levels, then pick which upgrade you're working toward. The Squad tab will recommend maps where you're most likely to find the items you need." /></>} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {/* Target upgrade selection */}
        {target && targetLevel && (
          <div style={{ background: T.cyanBg, border: `1px solid ${T.cyanBorder}`, borderLeft: `2px solid ${T.cyan}`, padding: 12, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.cyan, marginBottom: 2 }}>TARGET UPGRADE</div>
                <div style={{ fontSize: T.fs3, color: T.textBright, fontWeight: "bold" }}>{target.name} → Level {hideoutTarget.level}</div>
              </div>
              <button onClick={() => saveHideoutTarget(null)} style={{ background: "transparent", border: `1px solid ${T.errorBorder}`, color: T.error, padding: "4px 8px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans }}>CLEAR</button>
            </div>
            <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.textDim, marginBottom: 6 }}>ITEMS NEEDED:</div>
            {targetLevel.itemRequirements.map((req, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: T.fs2, color: T.text }}>{req.item.name}</span>
                <Badge label={`×${req.count}`} color={T.cyan} small />
              </div>
            ))}
            {targetLevel.traderRequirements?.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {targetLevel.traderRequirements.map((req, i) => (
                  <div key={i} style={{ fontSize: T.fs3, color: T.orange, marginTop: 2 }}>Requires {req.trader.name} LL{req.level}</div>
                ))}
              </div>
            )}
            {targetLevel.stationLevelRequirements?.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {targetLevel.stationLevelRequirements.map((req, i) => {
                  const met = (hideoutLevels[req.station.id] || 0) >= req.level;
                  return <div key={i} style={{ fontSize: T.fs3, color: met ? T.success : T.error, marginTop: 2 }}>{met ? "✓" : "✕"} {req.station.name} Level {req.level}</div>;
                })}
              </div>
            )}
          </div>
        )}

        {/* Prerequisite prompt */}
        {prereqPrompt && (
          <div style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, borderLeft: `2px solid ${T.orange}`, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.orange, marginBottom: 6 }}>PREREQUISITES NEEDED</div>
            <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.6, marginBottom: 10 }}>
              <span style={{ color: T.textBright, fontWeight: "bold" }}>{prereqPrompt.stationName} Level {prereqPrompt.level}</span> requires upgrades you don't have yet. Target a prerequisite first?
            </div>
            {prereqPrompt.unmet.map((req, i) => {
              const prereqStation = stations.find(s => s.id === req.stationId);
              const prereqItems = prereqStation?.levels.find(l => l.level === req.level)?.itemRequirements?.filter(r => r.item.name !== "Roubles") || [];
              return (
                <button key={i} onClick={() => { saveHideoutTarget({ stationId: req.stationId, level: req.level }); setPrereqPrompt(null); }}
                  style={{ width: "100%", background: T.cyanBg, border: `1px solid ${T.cyanBorder}`, padding: "8px 10px", marginBottom: 4, cursor: "pointer", textAlign: "left" }}>
                  <div style={{ fontSize: T.fs2, color: T.cyan, fontWeight: "bold" }}>{req.stationName} → Level {req.level}</div>
                  {prereqItems.length > 0 && <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 2 }}>{prereqItems.slice(0, 4).map(r => `${r.item.shortName || r.item.name} ×${r.count}`).join(", ")}{prereqItems.length > 4 ? " ..." : ""}</div>}
                </button>
              );
            })}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button onClick={() => { saveHideoutTarget({ stationId: prereqPrompt.stationId, level: prereqPrompt.level }); setPrereqPrompt(null); }}
                style={{ flex: 1, background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "6px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>TARGET ANYWAY</button>
              <button onClick={() => setPrereqPrompt(null)}
                style={{ flex: 1, background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "6px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>CANCEL</button>
            </div>
          </div>
        )}

        {/* Station grid */}
        <SL c={<>YOUR HIDEOUT LEVELS<Tip text="Tap the number buttons to set your current level for each station. Then tap a 'TARGET' button on any station to mark the upgrade you're saving items for." /></>} s={{ marginBottom: 10 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {stations.map(station => {
            const curLevel = hideoutLevels[station.id] || 0;
            const maxLevel = Math.max(...station.levels.map(l => l.level));
            const isTarget = hideoutTarget?.stationId === station.id;

            return (
              <div key={station.id} style={{
                background: isTarget ? T.cyanBg : T.surface,
                border: `1px solid ${isTarget ? T.cyan + "44" : T.border}`,
                borderLeft: `2px solid ${curLevel >= maxLevel ? T.successBorder : (isTarget ? T.cyan : T.borderBright)}`,
                padding: "8px 10px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: T.fs2, color: curLevel >= maxLevel ? T.success : T.textBright, fontWeight: "bold" }}>
                    {station.name}
                    {curLevel >= maxLevel && <span style={{ fontSize: T.fs2, color: T.successBorder, marginLeft: 5 }}>MAX</span>}
                  </div>
                  <div style={{ fontSize: T.fs3, color: T.textDim }}>Lv {curLevel}/{maxLevel}</div>
                </div>

                {/* Level selector */}
                <div style={{ display: "flex", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
                  {Array.from({ length: maxLevel + 1 }, (_, i) => (
                    <button key={i} onClick={() => saveHideoutLevels({ ...hideoutLevels, [station.id]: i })}
                      style={{
                        width: 28, height: 24, fontSize: T.fs3, fontFamily: T.mono,
                        background: curLevel === i ? T.gold + "22" : "transparent",
                        border: `1px solid ${curLevel === i ? T.gold : T.border}`,
                        color: curLevel === i ? T.gold : (i <= curLevel ? T.success : T.textDim),
                        cursor: "pointer",
                      }}>{i}</button>
                  ))}
                </div>

                {/* Set as target buttons for levels above current */}
                {curLevel < maxLevel && (
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {station.levels.filter(l => l.level > curLevel).map(l => {
                      const isThisTarget = isTarget && hideoutTarget.level === l.level;
                      const buildable = canBuild(station, l.level);
                      return (
                        <button key={l.level}
                          onClick={() => handleTargetClick(station, l.level, isThisTarget)}
                          style={{
                            background: isThisTarget ? T.cyan + "22" : "transparent",
                            border: `1px solid ${isThisTarget ? T.cyan : T.border}`,
                            color: isThisTarget ? T.cyan : (buildable ? T.textDim : T.errorBorder),
                            padding: "2px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1,
                          }}
                        >{isThisTarget ? "★ " : ""}TARGET L{l.level}{!buildable ? " (prereq)" : ""}</button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}

// ─── MAP RECOMMENDATION UI ───────────────────────────────────────────────
function MapRecommendation({ allProfiles, activeIds, apiTasks, apiMaps, onSelectMap, selectedMapId, hideoutTarget, apiHideout }) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState("tasks"); // "tasks", "hideout", "looking"
  const [lookPath, setLookPath] = useState([]); // drill-down path of category ids

  const profiles = activeIds.size > 0
    ? allProfiles.filter(p => activeIds.has(p.id))
    : allProfiles;
  const scope = activeIds.size > 0 ? `${activeIds.size} active` : "all";

  const taskRanked = computeMapRecommendation(profiles, apiTasks);

  // Item-based recommendation
  let itemRanked = [];
  let targetStation = null;
  let targetLevel = null;
  if (hideoutTarget && apiHideout) {
    targetStation = apiHideout.find(s => s.id === hideoutTarget.stationId);
    targetLevel = targetStation?.levels.find(l => l.level === hideoutTarget.level);
    if (targetLevel) {
      const neededItems = targetLevel.itemRequirements
        .filter(r => r.item.name !== "Roubles")
        .map(r => ({ id: r.item.id, name: r.item.name, shortName: r.item.shortName, count: r.count }));
      itemRanked = computeItemRecommendation(neededItems, apiMaps);
    }
  }

  // "Looking for" drill-down
  const getCurrentLookCat = () => {
    let cats = LOOK_CATS;
    let current = null;
    for (const id of lookPath) {
      current = cats.find(c => c.id === id);
      if (!current) break;
      cats = current.subs || [];
    }
    return { current, children: current?.subs || (lookPath.length === 0 ? LOOK_CATS : []) };
  };
  const { current: lookCurrent, children: lookChildren } = getCurrentLookCat();
  const lookTags = lookCurrent?.tags || [];
  const lookRanked = lookTags.length > 0 ? rankMapsByTags(lookTags) : [];
  const lookTop = lookRanked[0];

  const hasTaskData = taskRanked.length > 0;
  const hasItemData = itemRanked.length > 0;
  if (!hasTaskData && !hasItemData && mode === "tasks") return null;

  // Summary for collapsed bar
  const getTopInfo = () => {
    if (mode === "looking" && lookTop) return { name: lookTop.mapName, desc: `${lookTop.matchCount} loot spot${lookTop.matchCount !== 1 ? "s" : ""} · ${lookCurrent?.label || ""}` };
    if (mode === "hideout" && itemRanked[0]) return { name: itemRanked[0].mapName, desc: `${itemRanked[0].totalContainers} containers · hideout items` };
    if (taskRanked[0]) return { name: taskRanked[0].mapName, desc: `${taskRanked[0].totalTasks} task${taskRanked[0].totalTasks !== 1 ? "s" : ""} · ${taskRanked[0].playerCount} player${taskRanked[0].playerCount !== 1 ? "s" : ""}` };
    return null;
  };
  const topInfo = getTopInfo();
  if (!topInfo && mode !== "looking") return null;

  // Find the API map id for an EMAPS slug
  const emapToApiId = (slug) => apiMaps?.find(m => m.normalizedName === slug)?.id;

  return (
    <div style={{ marginTop: 8, marginBottom: 2 }}>
      {/* Collapsed summary bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%", background: T.cyanBg, border: `1px solid ${T.cyanBorder}`,
          borderLeft: `2px solid ${T.cyan}`, padding: "8px 10px",
          cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
          fontFamily: T.sans, textAlign: "left",
        }}
      >
        <div>
          <span style={{ fontSize: T.fs2, letterSpacing: 1, color: T.cyan }}>{topInfo ? "RECOMMENDED: " : "FIND YOUR MAP: "}</span>
          {topInfo ? <>
            <span style={{ fontSize: T.fs4, color: T.textBright, fontWeight: "bold" }}>{topInfo.name}</span>
            <span style={{ fontSize: T.fs3, color: T.textDim, marginLeft: 6 }}>{topInfo.desc}</span>
          </> : <span style={{ fontSize: T.fs4, color: T.textDim }}>Select what you're looking for</span>}
        </div>
        <span style={{ fontSize: T.fs4, color: T.cyan, flexShrink: 0 }}>{expanded ? "▴" : "▾"}</span>
      </button>

      {/* Expanded breakdown */}
      {expanded && (
        <div style={{ background: "#181818", border: `1px solid ${T.cyanBorder}`, borderTop: "none", padding: 12 }}>
          {/* Mode toggle — 3 options */}
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {[
              {id:"tasks",label:"BY TASKS",color:T.cyan,disabled:!hasTaskData},
              {id:"hideout",label:"BY HIDEOUT",color:T.orange,disabled:!hasItemData},
              {id:"looking",label:"LOOKING FOR...",color:T.purple,disabled:false},
            ].map(m => (
              <button key={m.id} onClick={() => { if (!m.disabled) setMode(m.id); }} style={{
                flex: 1, padding: "5px 0", fontSize: T.fs1, letterSpacing: 1, fontFamily: T.sans,
                background: mode === m.id ? m.color + "22" : "transparent",
                border: `1px solid ${mode === m.id ? m.color : T.border}`,
                color: m.disabled ? "#2a3a3a" : (mode === m.id ? m.color : T.textDim),
                cursor: m.disabled ? "default" : "pointer",
              }}>{m.label}</button>
            ))}
          </div>

          {/* TASKS MODE */}
          {mode === "tasks" && hasTaskData && (() => {
            const top = taskRanked[0]; const isTopSel = selectedMapId === top.mapId;
            return <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.cyan, marginBottom: 3 }}>BEST MAP FOR TASKS ({scope})</div>
                  <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold" }}>{top.mapName}</div>
                  <div style={{ fontSize: T.fs3, color: T.textDim, marginTop: 2 }}>{top.totalTasks} task{top.totalTasks !== 1 ? "s" : ""} · {top.totalIncomplete} objective{top.totalIncomplete !== 1 ? "s" : ""}</div>
                </div>
                {!isTopSel ? <button onClick={(e) => { e.stopPropagation(); onSelectMap(top.mapId); }} style={{ background: T.cyan + "22", border: `1px solid ${T.cyan}`, color: T.cyan, padding: "6px 12px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, whiteSpace: "nowrap", flexShrink: 0 }}>SELECT</button> : <Badge label="SELECTED" color={T.cyan} />}
              </div>
              {top.playerList.map(pl => (
                <div key={pl.name} style={{ borderLeft: `2px solid ${pl.color}`, paddingLeft: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: T.fs3, color: pl.color, fontWeight: "bold", marginBottom: 3 }}>{pl.name}{pl.isMe ? <span style={{ fontSize: T.fs1, color: T.textDim, fontWeight: "normal", marginLeft: 4 }}>YOU</span> : ""}</div>
                  {pl.tasks.map((t, i) => <div key={i} style={{ fontSize: T.fs3, color: T.textDim, marginBottom: 2, paddingLeft: 4 }}>★ {t.taskName} — <span style={{ color: t.remaining === t.total ? "#7a8a7a" : "#ba9a4a" }}>{t.remaining}/{t.total} obj</span></div>)}
                </div>
              ))}
            </>;
          })()}

          {/* HIDEOUT MODE */}
          {mode === "hideout" && hasItemData && (() => {
            const top = itemRanked[0]; const isTopSel = selectedMapId === top.mapId;
            return <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.orange, marginBottom: 3 }}>BEST MAP FOR HIDEOUT ITEMS</div>
                  <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold" }}>{top.mapName}</div>
                  <div style={{ fontSize: T.fs3, color: T.textDim, marginTop: 2 }}>{top.totalContainers} containers · {top.affinityScore > 0 ? "high" : "average"} relevance</div>
                </div>
                {!isTopSel ? <button onClick={(e) => { e.stopPropagation(); onSelectMap(top.mapId); }} style={{ background: T.orange + "22", border: `1px solid ${T.orange}`, color: T.orange, padding: "6px 12px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, whiteSpace: "nowrap", flexShrink: 0 }}>SELECT</button> : <Badge label="SELECTED" color={T.orange} />}
              </div>
              {targetStation && targetLevel && (
                <div style={{ borderLeft: `2px solid ${T.orange}`, paddingLeft: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: T.fs3, color: T.orange, fontWeight: "bold", marginBottom: 4 }}>{targetStation.name} → Level {hideoutTarget.level}</div>
                  {targetLevel.itemRequirements.filter(r => r.item.name !== "Roubles").map((r, i) => <div key={i} style={{ fontSize: T.fs3, color: T.textDim, marginBottom: 2, paddingLeft: 4 }}>◈ {r.item.name} ×{r.count}</div>)}
                </div>
              )}
            </>;
          })()}
          {mode === "hideout" && !hasItemData && (
            <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", padding: 12 }}>Set a hideout target in My Profile → Hideout to enable this.</div>
          )}

          {/* LOOKING FOR MODE */}
          {mode === "looking" && (
            <div>
              {/* Breadcrumb */}
              {lookPath.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 8 }}>
                  <button onClick={() => setLookPath([])} style={{ background: "transparent", border: "none", color: T.purple, fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, padding: 0 }}>ALL</button>
                  {lookPath.map((id, i) => {
                    let cats = LOOK_CATS;
                    let cat = null;
                    for (let j = 0; j <= i; j++) { cat = cats.find(c => c.id === lookPath[j]); cats = cat?.subs || []; }
                    return <span key={id} style={{ fontSize: T.fs2, color: T.textDim }}><span style={{ margin: "0 2px" }}>›</span><button onClick={() => setLookPath(lookPath.slice(0, i + 1))} style={{ background: "transparent", border: "none", color: i === lookPath.length - 1 ? T.purple : T.textDim, fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, padding: 0 }}>{cat?.label}</button></span>;
                  })}
                </div>
              )}

              {/* Category grid */}
              <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.purple, marginBottom: 6 }}>
                {lookPath.length === 0 ? "WHAT ARE YOU LOOKING FOR?" : lookCurrent?.label ? `${lookCurrent.label} — NARROW DOWN (OPTIONAL)` : "SELECT"}
                <Tip text="Pick a broad category to see which maps are best. Optionally drill down to subcategories for more specific results." />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 4, marginBottom: 10 }}>
                {(lookPath.length === 0 ? LOOK_CATS : lookChildren).map(cat => (
                  <button key={cat.id} onClick={() => setLookPath([...lookPath, cat.id])} style={{
                    background: T.purple + "11", border: `1px solid ${T.purpleBorder}`,
                    color: T.textBright, padding: "8px 6px", fontSize: T.fs3, cursor: "pointer",
                    fontFamily: T.sans, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                  }}>
                    {lookPath.length === 0 && <span style={{ fontSize: 12 }}>{cat.icon}</span>}
                    <span>{cat.label}</span>
                    {cat.subs && <span style={{ fontSize: T.fs1, color: T.purple }}>▾ {cat.subs.length} types</span>}
                  </button>
                ))}
              </div>

              {/* Map recommendation based on selection */}
              {lookRanked.length > 0 && (
                <div style={{ borderTop: `1px solid ${T.purpleBorder}`, paddingTop: 8 }}>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.purple, marginBottom: 6 }}>BEST MAPS FOR {(lookCurrent?.label || "").toUpperCase()}</div>
                  {lookRanked.slice(0, 5).map((m, i) => {
                    const apiId = emapToApiId(m.mapId);
                    const isSel = selectedMapId === apiId;
                    return (
                      <div key={m.mapId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", marginBottom: 4, background: isSel ? T.purple + "11" : "transparent", border: `1px solid ${isSel ? T.purpleBorder : T.border}` }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: T.fs4, color: i === 0 ? T.purple : T.textDim, fontWeight: i === 0 ? "bold" : "normal" }}>#{i + 1} {m.mapName}</span>
                            <span style={{ fontSize: T.fs2, color: T.textDim }}>{m.matchCount} spot{m.matchCount !== 1 ? "s" : ""}</span>
                          </div>
                          <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 2 }}>{m.matchingSpots.slice(0, 3).join(", ")}{m.matchingSpots.length > 3 ? ` +${m.matchingSpots.length - 3}` : ""}</div>
                        </div>
                        {apiId && !isSel && <button onClick={(e) => { e.stopPropagation(); onSelectMap(apiId); }} style={{ background: T.purple + "22", border: `1px solid ${T.purple}`, color: T.purple, padding: "4px 10px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, flexShrink: 0 }}>SELECT</button>}
                        {isSel && <Badge label="SELECTED" color={T.purple} />}
                      </div>
                    );
                  })}
                </div>
              )}
              {lookPath.length > 0 && lookRanked.length === 0 && (
                <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", padding: 8 }}>No maps have tagged loot spots for this category.</div>
              )}
            </div>
          )}

          {/* Runner-up maps (tasks & hideout modes) */}
          {(mode === "tasks" || mode === "hideout") && (() => {
            const ranked = mode === "hideout" ? itemRanked : taskRanked;
            return ranked.length > 1 ? (
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 4 }}>
                <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.textDim, marginBottom: 6 }}>OTHER OPTIONS</div>
                {ranked.slice(1, 4).map(m => (
                  <button key={m.mapId} onClick={(e) => { e.stopPropagation(); onSelectMap(m.mapId); }}
                    style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: selectedMapId === m.mapId ? T.cyan + "11" : "transparent", border: `1px solid ${selectedMapId === m.mapId ? T.cyanBorder : T.border}`, padding: "5px 8px", marginBottom: 4, cursor: "pointer", fontFamily: T.sans }}>
                    <span style={{ fontSize: T.fs3, color: selectedMapId === m.mapId ? T.cyan : T.textDim }}>#{m.rank} {m.mapName}</span>
                    <span style={{ fontSize: T.fs2, color: T.textDim }}>{mode === "tasks" ? `${m.totalTasks} task${m.totalTasks !== 1 ? "s" : ""}` : `${m.totalContainers} containers`}</span>
                  </button>
                ))}
              </div>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
}

// ─── EXTRACT SELECTOR ─────────────────────────────────────────────────────
// Called per-player inside the Squad planning screen after map selection
function ExtractSelector({ player, mapData, faction, choice, onChoice }) {
  const [pendingExtract, setPendingExtract] = useState(null); // extract being confirmed
  const [itemChecks, setItemChecks] = useState({}); // {itemName: true/false}

  const extracts = faction === "pmc" ? mapData.pmcExtracts : mapData.scavExtracts;
  const usable = extracts.filter(e => e.type !== "coop");

  const handleSelect = (ext) => {
    if (ext.requireItems.length === 0) {
      // Open extract — confirm immediately
      onChoice({ extract: ext, confirmed: true, missingItems: [] });
      setPendingExtract(null);
    } else {
      // Non-open — show item check
      setPendingExtract(ext);
      setItemChecks({});
    }
  };

  const confirmItems = () => {
    const missing = pendingExtract.requireItems.filter(item => !itemChecks[item]);
    onChoice({ extract: pendingExtract, confirmed: missing.length === 0, missingItems: missing });
    setPendingExtract(null);
  };

  const cfg = choice?.extract ? ET_CONFIG[choice.extract.type] : null;

  return (
    <div style={{ marginBottom: 4 }}>
      {/* Current selection display */}
      {choice?.extract ? (
        <div style={{
          background: choice.confirmed ? cfg.bg : T.errorBg,
          border: `1px solid ${choice.confirmed ? cfg.border : T.errorBorder}`,
          borderLeft: `2px solid ${choice.confirmed ? cfg.color : T.error}`,
          padding: "8px 10px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontSize: T.fs3, color: choice.confirmed ? cfg.color : T.error, fontWeight: "bold" }}>
                {choice.confirmed ? "⬆ " : "⚠ "}{choice.extract.name}
              </span>
              <Badge label={ET_CONFIG[choice.extract.type].label} color={cfg.color} small />
            </div>
            <button onClick={() => onChoice(null)} style={{ background: "transparent", border: "none", color: T.textDim, cursor: "pointer", fontSize: T.fs3, fontFamily: T.sans }}>
              CHANGE
            </button>
          </div>
          {!choice.confirmed && choice.missingItems?.length > 0 && (
            <div style={{ fontSize: T.fs3, color: T.error, marginTop: 5, lineHeight: 1.5 }}>
              ⚠ Missing: {choice.missingItems.join(", ")} — this extract may not be usable. Consider a different exit.
            </div>
          )}
          {choice.confirmed && choice.extract.type !== "open" && (
            <div style={{ fontSize: T.fs3, color: cfg.color, marginTop: 4, opacity: 0.8 }}>
              ✓ Items confirmed — extract added as final route waypoint
            </div>
          )}
        </div>
      ) : (
        <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: "8px 10px" }}>
          <div style={{ fontSize: T.fs3, color: T.textDim, marginBottom: 7 }}>Select extract for {player.name}:</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {usable.map(ext => {
              const c = ET_CONFIG[ext.type];
              return (
                <button key={ext.name} onClick={() => handleSelect(ext)} style={{
                  background: "transparent", border: `1px solid ${c.border}`,
                  borderLeft: `2px solid ${c.color}`, color: T.textBright,
                  padding: "7px 10px", textAlign: "left", cursor: "pointer",
                  fontFamily: T.sans, fontSize: T.fs4, display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span>{ext.name}</span>
                  <span style={{ fontSize: T.fs2, color: c.color }}>{c.icon} {c.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Item check modal */}
      {pendingExtract && (
        <div style={{ background: T.errorBg, border: `1px solid ${T.errorBorder}`, borderLeft: `2px solid ${T.error}`, padding: 12, marginTop: 6 }}>
          <div style={{ fontSize: T.fs3, color: T.error, letterSpacing: 1, marginBottom: 6 }}>EXTRACT REQUIREMENTS CHECK</div>
          <div style={{ fontSize: T.fs3, color: T.textBright, fontWeight: "bold", marginBottom: 6 }}>{pendingExtract.name}</div>
          <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.6, marginBottom: 10 }}>{pendingExtract.note}</div>
          <SL c="DO YOU HAVE THESE ITEMS IN YOUR LOADOUT?" s={{ marginBottom: 8 }} />
          {pendingExtract.requireItems.map(item => (
            <div key={item} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <button onClick={() => setItemChecks(c => ({ ...c, [item]: !c[item] }))} style={{
                width: 20, height: 20, flexShrink: 0,
                background: itemChecks[item] ? T.successBg : "transparent",
                border: `1px solid ${itemChecks[item] ? T.successBorder : T.borderBright}`,
                color: itemChecks[item] ? T.success : T.textDim,
                cursor: "pointer", fontSize: T.fs3, display: "flex", alignItems: "center", justifyContent: "center",
              }}>{itemChecks[item] ? "✓" : ""}</button>
              <span style={{ fontSize: T.fs4, color: itemChecks[item] ? T.success : T.textBright }}>{item}</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={() => setPendingExtract(null)} style={{ flex: 1, background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "8px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>
              ← PICK ANOTHER
            </button>
            <button onClick={confirmItems} style={{
              flex: 2,
              background: pendingExtract.requireItems.every(i => itemChecks[i]) ? T.successBg : T.errorBg,
              border: `1px solid ${pendingExtract.requireItems.every(i => itemChecks[i]) ? T.successBorder : T.errorBorder}`,
              color: pendingExtract.requireItems.every(i => itemChecks[i]) ? T.success : T.error,
              padding: "8px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1,
            }}>
              {pendingExtract.requireItems.every(i => itemChecks[i]) ? "✓ CONFIRM — ADD TO ROUTE" : "⚠ CONFIRM ANYWAY (MISSING ITEMS)"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MAP OVERLAY ─────────────────────────────────────────────────────────
const MAP_SVG_NAMES = {customs:"Customs",factory:"Factory",woods:"Woods",interchange:"Interchange",shoreline:"Shoreline",reserve:"Reserve",lighthouse:"Lighthouse","streets-of-tarkov":"StreetsOfTarkov","the-lab":"Labs","ground-zero":"GroundZero"};
function MapOverlay({ apiMap, emap, route, conflicts, onConflictResolve }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const svgName = apiMap ? MAP_SVG_NAMES[apiMap.normalizedName] : null;
  const svgUrl = svgName ? `https://assets.tarkov.dev/maps/svg/${svgName}.svg` : null;
  const objWaypoints = route.filter(w => w.pct && !w.isExtract);
  const extractWaypoints = route.filter(w => w.pct && w.isExtract);
  const allPositioned = route.filter(w => w.pct);

  return (
    <div>
      <div style={{ position: "relative", background: "#181818", border: `1px solid ${T.border}` }}>
        {svgUrl && !imgErr ? (
          <>
            {!imgLoaded && <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: T.textDim, fontSize: T.fs4, fontFamily: T.sans }}>Loading map from tarkov.dev...</div>}
            <img src={svgUrl} alt={apiMap?.name} style={{ width: "100%", display: imgLoaded ? "block" : "none" }}
              onLoad={() => setImgLoaded(true)} onError={() => setImgErr(true)} />
            {imgLoaded && (
              <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
                viewBox="0 0 1 1" preserveAspectRatio="none">
                {/* Location labels from EMAPS loot points */}
                {(emap?.lootPoints || []).map((lp, i) => lp.pct && (
                  <g key={`label_${i}`}>
                    <rect x={lp.pct.x - 0.002} y={lp.pct.y - 0.018} width={lp.name.length * 0.0055 + 0.008} height="0.016" rx="0.003" fill="rgba(20,20,20,0.75)" stroke={T.border} strokeWidth="0.001" />
                    <text x={lp.pct.x + 0.002} y={lp.pct.y - 0.007} fill={T.textDim} fontSize="0.011" fontFamily={T.mono}>{lp.name}</text>
                  </g>
                ))}
                {/* Route path through objectives */}
                {objWaypoints.length > 1 && (
                  <polyline points={objWaypoints.map(w => `${w.pct.x},${w.pct.y}`).join(" ")}
                    fill="none" stroke={T.gold} strokeWidth="0.005" strokeDasharray="0.018,0.009" opacity="0.85" />
                )}
                {/* Spawn to first */}
                {objWaypoints[0] && (
                  <line x1="0.5" y1="0.5" x2={objWaypoints[0].pct.x} y2={objWaypoints[0].pct.y}
                    stroke={T.success} strokeWidth="0.004" strokeDasharray="0.015,0.008" opacity="0.7" />
                )}
                {/* Last obj to extract */}
                {objWaypoints.length > 0 && extractWaypoints[0] && (
                  <line
                    x1={objWaypoints[objWaypoints.length-1].pct.x} y1={objWaypoints[objWaypoints.length-1].pct.y}
                    x2={extractWaypoints[0].pct.x} y2={extractWaypoints[0].pct.y}
                    stroke={T.success} strokeWidth="0.005" strokeDasharray="0.02,0.01" opacity="0.8" />
                )}
                {/* Spawn marker */}
                <circle cx="0.5" cy="0.5" r="0.018" fill={T.successBg} stroke={T.success} strokeWidth="0.004" />
                <text x="0.5" y="0.507" textAnchor="middle" fill={T.success} fontSize="0.017" fontFamily={T.mono} fontWeight="bold">S</text>
                {/* Objective waypoints */}
                {objWaypoints.map((w, i) => {
                  const col = w.players[0]?.color || T.gold;
                  return (
                    <g key={w.id}>
                      <circle cx={w.pct.x} cy={w.pct.y} r="0.024" fill={T.bg} stroke={col} strokeWidth="0.005" />
                      <text x={w.pct.x} y={w.pct.y + 0.009} textAnchor="middle" fill={col} fontSize="0.019" fontFamily={T.mono} fontWeight="bold">{i + 1}</text>
                      {w.players.slice(1, 3).map((p, pi) => (
                        <circle key={pi} cx={w.pct.x + 0.028 * (pi + 1)} cy={w.pct.y - 0.02}
                          r="0.012" fill={p.color} stroke={T.bg} strokeWidth="0.003" />
                      ))}
                    </g>
                  );
                })}
                {/* Extract waypoints — green, with ⬆ symbol */}
                {extractWaypoints.map((w) => (
                  <g key={w.id}>
                    <circle cx={w.pct.x} cy={w.pct.y} r="0.026" fill={T.successBg} stroke={T.success} strokeWidth="0.006" />
                    <text x={w.pct.x} y={w.pct.y + 0.009} textAnchor="middle" fill={T.success} fontSize="0.018" fontFamily={T.mono} fontWeight="bold">⬆</text>
                  </g>
                ))}
              </svg>
            )}
          </>
        ) : (
          <div style={{ height: 160, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <div style={{ color: T.textDim, fontSize: T.fs4, fontFamily: T.sans }}>{imgErr ? "Map image unavailable" : "Select a map above"}</div>
            {apiMap && <a href={`https://tarkov.dev/map/${apiMap.normalizedName}`} target="_blank" rel="noreferrer" style={{ color: T.blue, fontSize: T.fs3, fontFamily: T.sans }}>Open on tarkov.dev →</a>}
          </div>
        )}
      </div>

      {/* Conflicts */}
      {conflicts.map(c => (
        <div key={c.id} style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, borderLeft: `2px solid ${T.orange}`, padding: 10, marginTop: 8 }}>
          <div style={{ fontSize: T.fs3, color: T.orange, letterSpacing: 1, marginBottom: 5 }}>⚠ OVERLAPPING OBJECTIVES</div>
          <div style={{ fontSize: T.fs2, color: T.textBright, marginBottom: 8 }}>{c.label}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => onConflictResolve(c.id, "merge")} style={{ flex: 1, background: T.successBg, border: `1px solid ${T.successBorder}`, color: T.success, padding: "7px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans }}>✓ MERGE</button>
            <button onClick={() => onConflictResolve(c.id, "separate")} style={{ flex: 1, background: "#181818", border: `1px solid ${T.blueBorder}`, color: T.blue, padding: "7px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans }}>⇄ TWO STOPS</button>
          </div>
        </div>
      ))}

      {/* Unpositioned objectives */}
      {route.filter(w => !w.pct && !w.isExtract).length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.success}`, padding: 10, marginTop: 8 }}>
          <SL c="MAP-WIDE OBJECTIVES (no pin data)" s={{ marginBottom: 6 }} />
          {route.filter(w => !w.pct && !w.isExtract).map((w, i) => (
            <div key={w.id} style={{ display: "flex", gap: 7, alignItems: "flex-start", marginBottom: 5 }}>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{w.players.map(p => <Badge key={p.playerId} label={p.name} color={p.color} small />)}</div>
              <div style={{ fontSize: T.fs4, color: T.text, flex: 1 }}>{w.locationName}</div>
            </div>
          ))}
        </div>
      )}

      {/* Route sequence */}
      {(objWaypoints.length > 0 || extractWaypoints.length > 0) && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.gold}`, padding: 10, marginTop: 8 }}>
          <SL c="ROUTE SEQUENCE" s={{ marginBottom: 10 }} />
          {objWaypoints.map((w, i) => (
            <div key={w.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${T.border}` }}>
              <div style={{ background: (w.isLoot ? w.players[0]?.color : T.gold) + "22", border: `1px solid ${w.isLoot ? w.players[0]?.color : T.gold}`, color: w.isLoot ? w.players[0]?.color : T.gold, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontSize: T.fs4, fontWeight: "bold", flexShrink: 0, fontFamily: T.sans }}>{i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ color: T.textBright, fontSize: T.fs2, fontWeight: "bold", marginBottom: 4 }}>{w.locationName}</div>
                {w.isLoot ? (
                  <div style={{ fontSize: T.fs4, color: w.players[0]?.color, marginBottom: 2 }}>
                    {w.players[0]?.objective}
                    <div style={{ fontSize: T.fs3, color: T.textDim, marginTop: 2 }}>{w.players[0]?.name}</div>
                  </div>
                ) : w.players.map((p, pi) => (
                  <div key={pi} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 3 }}>
                    <Badge label={p.name} color={p.color} small />
                    <div style={{ fontSize: T.fs4, color: p.color, flex: 1 }}>{p.objective}{p.total > 1 && p.progress < p.total && <span style={{ color: T.textDim }}> ({p.progress}/{p.total})</span>}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {/* Extract as final step */}
          {extractWaypoints.map((w) => (
            <div key={w.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <div style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, color: T.success, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontSize: T.fs3, flexShrink: 0 }}>⬆</div>
              <div style={{ flex: 1 }}>
                <div style={{ color: T.success, fontSize: T.fs2, fontWeight: "bold", marginBottom: 4 }}>EXTRACT — {w.extractName}</div>
                {w.players.map((p, pi) => (
                  <div key={pi} style={{ fontSize: T.fs3, color: T.success, opacity: 0.8 }}>
                    {p.name}{p.missingItems?.length > 0 && <span style={{ color: T.error }}> ⚠ missing {p.missingItems.join(", ")}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {/* Tarkov.dev link */}
          {apiMap && (
            <a href={`https://tarkov.dev/map/${apiMap.normalizedName}`} target="_blank" rel="noreferrer"
              style={{ display: "block", background: T.blueBg, border: `1px solid ${T.blueBorder}`, color: T.blue, padding: "9px 0", fontSize: T.fs3, letterSpacing: 1, textDecoration: "none", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center", marginTop: 10 }}>
              🗺 OPEN FULL INTERACTIVE MAP ON TARKOV.DEV →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ─── POST-RAID ────────────────────────────────────────────────────────────
function PostRaidTracker({ route, myProfile, onSave, onClose }) {
  const [updates, setUpdates] = useState({});
  const myId = myProfile.id;
  const trackable = [];
  route.forEach(w => !w.isExtract && w.players?.filter(p => p.playerId === myId).forEach(p => { if (p.isCountable) trackable.push({ ...p }); }));
  const key = p => `${p.playerId}-${p.taskId}-${p.objId}`;
  const set = (k, v) => setUpdates(u => ({ ...u, [k]: v }));
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(20,20,20,0.97)", zIndex: 70, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "12px 14px", flexShrink: 0 }}>
        <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1.5, marginBottom: 4 }}>POST-RAID — MY PROGRESS</div>
        <div style={{ fontSize: T.fs4, color: T.textBright, fontWeight: "bold" }}>How did your raid go?</div>
        <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 3 }}>Only your objectives. Copy updated code after saving.</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {trackable.length === 0 ? (
          <div style={{ color: T.textDim, fontSize: T.fs2, textAlign: "center", padding: 32, fontFamily: T.sans }}>No countable objectives this raid.</div>
        ) : trackable.map((p, i) => {
          const k = key(p); const cur = updates[k]; const done = (myProfile.progress || {})[k] || 0; const remaining = Math.max(0, p.total - done);
          return (
            <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${p.color || T.gold}`, padding: 10, marginBottom: 8 }}>
              <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold", marginBottom: 4 }}>{p.objective}</div>
              <div style={{ fontSize: T.fs3, color: T.textDim, marginBottom: 8 }}>Progress: {done}/{p.total} — need {remaining} more</div>
              {p.total === 1 ? (
                <div style={{ display: "flex", gap: 8 }}>
                  {["Done ✓", "Not done"].map((opt, oi) => (
                    <button key={opt} onClick={() => set(k, oi === 0 ? 1 : 0)} style={{ flex: 1, padding: "7px 0", background: cur === (oi === 0 ? 1 : 0) && cur !== undefined ? (oi === 0 ? T.successBg : T.errorBg) : "transparent", border: `1px solid ${cur === (oi === 0 ? 1 : 0) && cur !== undefined ? (oi === 0 ? T.successBorder : T.errorBorder) : T.border}`, color: cur === (oi === 0 ? 1 : 0) && cur !== undefined ? (oi === 0 ? T.success : T.error) : T.textDim, cursor: "pointer", fontFamily: T.sans, fontSize: 9 }}>{opt.toUpperCase()}</button>
                  ))}
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 6 }}>COMPLETED THIS RAID:</div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {Array.from({ length: Math.min(remaining + 1, 10) }, (_, n) => (
                      <button key={n} onClick={() => set(k, n)} style={{ width: 36, height: 36, background: cur === n ? (p.color || T.gold) + "22" : "transparent", border: `1px solid ${cur === n ? (p.color || T.gold) : T.border}`, color: cur === n ? (p.color || T.gold) : T.textDim, cursor: "pointer", fontFamily: T.sans, fontSize: 12 }}>{n}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ padding: 12, display: "flex", gap: 8, borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
        <button onClick={onClose} style={{ flex: 1, background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "10px 0", fontSize: T.fs4, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase" }}>Cancel</button>
        <button onClick={() => { const newProg = { ...(myProfile.progress || {}) }; Object.entries(updates).forEach(([k, v]) => { newProg[k] = Math.min((newProg[k] || 0) + v, 9999); }); onSave(newProg); onClose(); }} style={{ flex: 2, background: T.success + "22", border: `1px solid ${T.successBorder}`, color: T.success, padding: "10px 0", fontSize: T.fs4, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", fontWeight: "bold" }}>✓ SAVE MY PROGRESS</button>
      </div>
    </div>
  );
}

// ─── MY PROFILE TAB ──────────────────────────────────────────────────────
function MyProfileTab({ myProfile, saveMyProfile, apiTasks, apiTraders, loading, apiError, apiHideout, hideoutLevels, saveHideoutLevels, hideoutTarget, saveHideoutTarget }) {
  const [screen, setScreen] = useState("profile");
  const [profileSub, setProfileSub] = useState("profile"); // "profile" | "tasks" | "hideout"
  const [taskSearch, setTaskSearch] = useState("");
  const [taskTrader, setTaskTrader] = useState("all");
  const [taskMapFilter, setTaskMapFilter] = useState("all");
  const [copied, setCopied] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [restoreCode, setRestoreCode] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [hideoutPrereq, setHideoutPrereq] = useState(null);
  const [expandedStation, setExpandedStation] = useState(null);

  const copyCode = () => {
    const code = encodeProfile(myProfile); if (!code) return;
    try { navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => { const ta = document.createElement("textarea"); ta.value = code; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); setCopied(true); setTimeout(() => setCopied(false), 2500); }); } catch(e) {}
  };

  const traders = [...new Set((apiTasks || []).map(t => t.trader?.name).filter(Boolean))].sort(traderSort);
  const traderImgMap = Object.fromEntries((apiTraders || []).map(t => [t.name, t.imageLink]));
  const taskMaps = [...new Set((apiTasks || []).map(t => t.map?.name).filter(Boolean))].sort();
  const filteredTasks = (apiTasks || []).filter(t => {
    if (taskTrader !== "all" && t.trader?.name !== taskTrader) return false;
    if (taskMapFilter !== "all" && t.map?.name !== taskMapFilter) return false;
    if (taskSearch && !t.name.toLowerCase().includes(taskSearch.toLowerCase())) return false;
    return true;
  }).slice(0, 50);

  const addTask = taskId => {
    const existing = myProfile.tasks || [];
    if (existing.some(t => t.taskId === taskId)) return;
    const prereqIds = [...new Set(getAllPrereqTaskIds(taskId, apiTasks))];
    const newTasks = [...existing, { taskId }];
    let newProgress = { ...(myProfile.progress || {}) };
    prereqIds.forEach(prereqId => {
      if (!newTasks.some(t => t.taskId === prereqId)) newTasks.push({ taskId: prereqId });
      const prereqTask = apiTasks?.find(t => t.id === prereqId);
      if (prereqTask) newProgress = markTaskCompleteInProgress(myProfile.id, prereqId, prereqTask, newProgress);
    });
    saveMyProfile({ ...myProfile, tasks: newTasks, progress: newProgress });
  };
  const removeTask = taskId => saveMyProfile({ ...myProfile, tasks: (myProfile.tasks || []).filter(t => t.taskId !== taskId) });

  if (screen === "hideout") return (
    <HideoutManager
      apiHideout={apiHideout}
      hideoutLevels={hideoutLevels}
      saveHideoutLevels={saveHideoutLevels}
      hideoutTarget={hideoutTarget}
      saveHideoutTarget={saveHideoutTarget}
      onBack={() => setScreen("profile")}
    />
  );

  if (screen === "browsetasks") {
    const traderTaskCounts = {};
    traders.forEach(tr => {
      const trTasks = (apiTasks || []).filter(t => t.trader?.name === tr);
      const addedCount = trTasks.filter(t => myProfile.tasks?.some(mt => mt.taskId === t.id)).length;
      traderTaskCounts[tr] = { total: trTasks.length, added: addedCount };
    });
    // When a specific trader is selected, don't cap at 50
    const browseLimit = taskTrader !== "all" ? 999 : 50;
    const browseTasks = (apiTasks || []).filter(t => {
      if (taskTrader !== "all" && t.trader?.name !== taskTrader) return false;
      if (taskMapFilter !== "all" && t.map?.name !== taskMapFilter) return false;
      if (taskSearch && !t.name.toLowerCase().includes(taskSearch.toLowerCase())) return false;
      return true;
    }).slice(0, browseLimit);
    const addAllForTrader = (traderName) => {
      const trTasks = (apiTasks || []).filter(t => t.trader?.name === traderName);
      let allTasks = [...(myProfile.tasks || [])];
      let newProgress = { ...(myProfile.progress || {}) };
      trTasks.forEach(task => {
        if (!allTasks.some(t => t.taskId === task.id)) allTasks.push({ taskId: task.id });
        const prereqIds = [...new Set(getAllPrereqTaskIds(task.id, apiTasks))];
        prereqIds.forEach(prereqId => {
          if (!allTasks.some(t => t.taskId === prereqId)) allTasks.push({ taskId: prereqId });
          const prereqTask = apiTasks?.find(t => t.id === prereqId);
          if (prereqTask) newProgress = markTaskCompleteInProgress(myProfile.id, prereqId, prereqTask, newProgress);
        });
      });
      saveMyProfile({ ...myProfile, tasks: allTasks, progress: newProgress });
    };
    const removeAllForTrader = (traderName) => {
      const trTaskIds = new Set((apiTasks || []).filter(t => t.trader?.name === traderName).map(t => t.id));
      saveMyProfile({ ...myProfile, tasks: (myProfile.tasks || []).filter(t => !trTaskIds.has(t.taskId)) });
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <button onClick={() => setScreen("profile")} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs3, letterSpacing: 1, cursor: "pointer", fontFamily: T.sans, padding: 0 }}>← BACK</button>
            <div style={{ fontSize: T.fs2, color: T.textDim, fontFamily: T.sans }}>{myProfile.tasks?.length || 0} selected</div>
          </div>
          <input value={taskSearch} onChange={e => setTaskSearch(e.target.value)} placeholder="Search tasks..." style={{ width: "100%", background: "#181818", border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "7px 10px", fontSize: T.fs2, fontFamily: T.sans, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
          <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1.5, marginBottom: 6, fontFamily: T.sans }}>TRADERS<Tip text="Tap a trader to see their tasks. Use 'ADD ALL' to grab every task from that trader, or add them one by one." /></div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            <button onClick={() => setTaskTrader("all")} style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", fontSize: T.fs2, fontFamily: T.sans,
              background: taskTrader === "all" ? T.gold + "22" : "transparent",
              border: `2px solid ${taskTrader === "all" ? T.gold : T.border}`,
              color: taskTrader === "all" ? T.gold : T.textDim, cursor: "pointer",
            }}>All</button>
            {traders.map(tr => {
              const counts = traderTaskCounts[tr] || { total: 0, added: 0 };
              const allAdded = counts.added === counts.total && counts.total > 0;
              const isActive = taskTrader === tr;
              const clr = allAdded ? T.success : T.gold;
              return (
                <button key={tr} onClick={() => setTaskTrader(tr)} style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", fontSize: T.fs2, fontFamily: T.sans,
                  background: isActive ? clr + "22" : "transparent",
                  border: `2px solid ${isActive ? clr : T.border}`,
                  color: isActive ? clr : T.textDim, cursor: "pointer",
                }}>
                  {traderImgMap[tr] && <img src={traderImgMap[tr]} alt={tr} style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover" }} />}
                  <span>{tr} ({counts.added}/{counts.total})</span>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <Btn ch="All Maps" small active={taskMapFilter === "all"} onClick={() => setTaskMapFilter("all")} />
            {taskMaps.map(m => <Btn key={m} ch={m.split(" ")[0]} small active={taskMapFilter === m} onClick={() => setTaskMapFilter(m)} />)}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {loading && <div style={{ color: T.textDim, fontSize: T.fs4, textAlign: "center", padding: 20 }}>Loading live data from tarkov.dev...</div>}
          {apiError && <div style={{ color: T.error, fontSize: T.fs4, textAlign: "center", padding: 20 }}>Could not reach tarkov.dev. Check connection.</div>}
          {/* ADD ALL / REMOVE ALL for selected trader */}
          {taskTrader !== "all" && (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              {(traderTaskCounts[taskTrader]?.added || 0) < (traderTaskCounts[taskTrader]?.total || 0) && (
                <button onClick={() => addAllForTrader(taskTrader)} style={{ flex: 1, background: myProfile.color + "22", border: `2px solid ${myProfile.color}`, color: myProfile.color, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", fontWeight: "bold" }}>+ ADD ALL {taskTrader.toUpperCase()}</button>
              )}
              {(traderTaskCounts[taskTrader]?.added || 0) > 0 && (
                <button onClick={() => removeAllForTrader(taskTrader)} style={{ flex: 1, background: T.errorBg, border: `2px solid ${T.errorBorder}`, color: T.error, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", fontWeight: "bold" }}>✕ REMOVE ALL</button>
              )}
            </div>
          )}
          <div style={{ fontSize: T.fs3, color: T.textDim, letterSpacing: 1, marginBottom: 10 }}>{browseTasks.length} TASKS{taskTrader !== "all" ? ` · ${taskTrader.toUpperCase()}` : " · LIVE FROM TARKOV.DEV"}</div>
          {browseTasks.map(task => {
            const added = myProfile.tasks?.some(t => t.taskId === task.id);
            return (
              <div key={task.id} style={{ background: T.surface, border: `1px solid ${added ? myProfile.color : T.border}`, borderLeft: `2px solid ${added ? myProfile.color : T.border}`, padding: 10, marginBottom: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
                  <div style={{ color: T.textBright, fontSize: T.fs2, fontWeight: "bold", flex: 1 }}>{task.name}</div>
                  <button onClick={() => added ? removeTask(task.id) : addTask(task.id)} style={{ background: added ? T.errorBg : "transparent", border: `1px solid ${added ? T.errorBorder : T.borderBright}`, color: added ? T.error : T.textDim, padding: "4px 8px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, flexShrink: 0 }}>{added ? "✕ REMOVE" : "+ ADD"}</button>
                </div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 4 }}>
                  {taskTrader === "all" && <Badge label={task.trader?.name || "?"} color={T.textDim} />}
                  {task.map && <Badge label={task.map.name} color={T.blue} />}
                  {task.minPlayerLevel > 1 && <Badge label={`Lvl ${task.minPlayerLevel}+`} color={T.textDim} />}
                </div>
                {task.objectives?.slice(0, 2).map(obj => <div key={obj.id} style={{ fontSize: T.fs3, color: T.textDim, marginTop: 2 }}>{getObjMeta(obj).icon} {obj.description}</div>)}
              </div>
            );
          })}
          <div style={{ height: 20 }} />
        </div>
      </div>
    );
  }

  const subTabs = [
    { id: "profile", label: "Profile", icon: "▲" },
    { id: "tasks", label: `Tasks (${myProfile.tasks?.length || 0})`, icon: "★" },
    { id: "hideout", label: "Hideout", icon: "◈" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", background: myProfile.color + "33", border: `2px solid ${myProfile.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: T.fs4, color: myProfile.color, flexShrink: 0 }}>{myProfile.name?.[0]?.toUpperCase() || "?"}</div>
          {editingName ? (
            <input autoFocus value={myProfile.name || ""} onChange={e => saveMyProfile({ ...myProfile, name: e.target.value })} onBlur={() => setEditingName(false)} onKeyDown={e => e.key === "Enter" && setEditingName(false)} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `1px solid ${myProfile.color}`, color: myProfile.color, fontSize: T.fs4, fontFamily: T.sans, outline: "none", padding: "2px 0" }} />
          ) : (
            <div style={{ flex: 1, color: myProfile.color, fontSize: T.fs4, fontWeight: "bold", cursor: "pointer" }} onClick={() => setEditingName(true)}>
              {myProfile.name || "Tap to set name"}<span style={{ fontSize: T.fs2, color: T.textDim, fontWeight: "normal", marginLeft: 6 }}>✎</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {PLAYER_COLORS.map((col, i) => <button key={i} onClick={() => saveMyProfile({ ...myProfile, color: col })} style={{ width: 24, height: 24, borderRadius: "50%", background: col, cursor: "pointer", border: myProfile.color === col ? "2px solid #d8d0c0" : "2px solid transparent", padding: 0 }} />)}
        </div>
        {/* Sub-tabs */}
        <div style={{ display: "flex", gap: 4 }}>
          {subTabs.map(st => (
            <button key={st.id} onClick={() => setProfileSub(st.id)} style={{
              flex: 1, padding: "8px 4px", fontSize: T.fs2, letterSpacing: 1, fontFamily: T.sans, textTransform: "uppercase",
              background: profileSub === st.id ? myProfile.color + "22" : "transparent",
              border: `2px solid ${profileSub === st.id ? myProfile.color : T.border}`,
              color: profileSub === st.id ? myProfile.color : T.textDim,
              cursor: "pointer", fontWeight: profileSub === st.id ? "bold" : "normal",
              transition: "background 0.15s, border-color 0.15s",
            }}>{st.icon} {st.label}</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {/* ── PROFILE SUB-TAB ── */}
        {profileSub === "profile" && (
          <>
            <SL c={<>YOUR SHARE CODE<Tip text="Copy this code and paste it in Discord before each raid. Your squadmates paste it in their Squad tab to import your profile and tasks." /></>} />
            <div style={{ background: T.surface, border: `1px solid ${myProfile.color}44`, borderLeft: `2px solid ${myProfile.color}`, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.7, marginBottom: 10 }}>Copy your code and paste it in Discord before each raid. Teammates import it in the Squad tab — no account needed.</div>
              <div style={{ background: "#181818", border: `1px solid ${T.border}`, padding: "8px 10px", marginBottom: 8, fontSize: T.fs2, color: T.textDim, fontFamily: T.mono, wordBreak: "break-all", lineHeight: 1.5 }}>{myProfile.tasks?.length > 0 ? encodeProfile(myProfile)?.slice(0, 60) + "..." : "Add tasks to generate your code"}</div>
              <button onClick={copyCode} disabled={!myProfile.tasks?.length} style={{ width: "100%", background: copied ? T.successBg : myProfile.color + "22", border: `2px solid ${copied ? T.successBorder : myProfile.color}`, color: copied ? T.success : myProfile.color, padding: "10px 0", fontSize: T.fs2, cursor: myProfile.tasks?.length ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", fontWeight: "bold" }}>
                {copied ? "✓ COPIED TO CLIPBOARD" : "📋 COPY MY CODE"}
              </button>
              {!myProfile.tasks?.length && <div style={{ fontSize: T.fs2, color: T.textDim, textAlign: "center", marginTop: 6 }}>Add tasks in the Tasks tab first</div>}
              <button onClick={() => setShowRestore(!showRestore)} style={{ width: "100%", background: showRestore ? T.successBg : T.blueBg, border: `2px solid ${showRestore ? T.successBorder : T.blueBorder}`, color: showRestore ? T.success : T.blue, fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, marginTop: 8, padding: "8px 0", textTransform: "uppercase" }}>{showRestore ? "▾ HIDE RESTORE" : "▸ RESTORE PROFILE FROM CODE"}</button>
              {showRestore && (
                <div style={{ background: "#181818", border: `1px solid ${T.border}`, padding: 10, marginTop: 4 }}>
                  <div style={{ fontSize: T.fs2, color: T.textDim, lineHeight: 1.5, marginBottom: 8 }}>Paste a share code to restore your profile on this device — name, color, tasks, and progress will all transfer.</div>
                  <textarea value={restoreCode} onChange={e => setRestoreCode(e.target.value)} placeholder="Paste your TG2:... code here"
                    style={{ width: "100%", background: "#181818", border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box", resize: "none", height: 52, lineHeight: 1.4, marginBottom: 6 }} />
                  {restoreError && <div style={{ fontSize: T.fs2, color: T.error, marginBottom: 6 }}>{restoreError}</div>}
                  <button onClick={() => {
                    setRestoreError("");
                    const decoded = decodeProfile(restoreCode.trim());
                    if (!decoded) { setRestoreError("Invalid code — check for typos."); return; }
                    saveMyProfile({ ...myProfile, name: decoded.name, color: decoded.color, tasks: decoded.tasks, progress: decoded.progress });
                    setRestoreCode(""); setShowRestore(false);
                  }} disabled={!restoreCode.trim()} style={{ width: "100%", background: restoreCode.trim() ? T.successBg : "transparent", border: `2px solid ${restoreCode.trim() ? T.successBorder : T.border}`, color: restoreCode.trim() ? T.success : T.textDim, padding: "10px 0", fontSize: T.fs2, cursor: restoreCode.trim() ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1 }}>RESTORE MY PROFILE</button>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── TASKS SUB-TAB ── */}
        {profileSub === "tasks" && (() => {
          // Group selected tasks by trader
          const myTasksWithApi = (myProfile.tasks || []).map(t => {
            const apiTask = apiTasks?.find(x => x.id === t.taskId);
            return apiTask ? { taskId: t.taskId, apiTask } : null;
          }).filter(Boolean);
          const traderGroups = {};
          myTasksWithApi.forEach(({ taskId, apiTask }) => {
            const traderName = apiTask.trader?.name || "Unknown";
            if (!traderGroups[traderName]) traderGroups[traderName] = [];
            traderGroups[traderName].push({ taskId, apiTask });
          });
          const sortedTraders = Object.keys(traderGroups).sort(traderSort);
          return (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <SL c={<>MY TASKS ({myProfile.tasks?.length || 0})<Tip text="Browse and add the tasks you're currently working on. These get included in your share code so your squad knows what objectives you need to hit." /></>} s={{ marginBottom: 0 }} />
                <button onClick={() => setScreen("browsetasks")} style={{ background: myProfile.color + "22", border: `2px solid ${myProfile.color}`, color: myProfile.color, padding: "6px 12px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>+ BROWSE TASKS</button>
              </div>
              {myProfile.tasks?.length > 0 && (
                <button onClick={() => { if (window.confirm("Clear all " + myProfile.tasks.length + " tasks?")) saveMyProfile({ ...myProfile, tasks: [], progress: {} }); }} style={{ width: "100%", background: T.errorBg, border: `2px solid ${T.errorBorder}`, color: T.error, padding: "8px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>✕ CLEAR ALL TASKS</button>
              )}
              {!myProfile.tasks?.length && (
                <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 20, textAlign: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: T.fs2, color: T.textDim, marginBottom: 8 }}>No tasks added yet</div>
                  <button onClick={() => setScreen("browsetasks")} style={{ background: "transparent", border: `2px solid ${myProfile.color}`, color: myProfile.color, padding: "8px 16px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>BROWSE ALL TASKS →</button>
                </div>
              )}
              {sortedTraders.map(traderName => {
                const tasks = traderGroups[traderName];
                const completedCount = tasks.filter(({ taskId, apiTask }) => {
                  const prog = myProfile.progress || {};
                  const done = (apiTask.objectives || []).filter(obj => { const k = `${myProfile.id}-${taskId}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) >= meta.total; }).length;
                  const total = (apiTask.objectives || []).filter(o => !o.optional).length;
                  return done >= total && total > 0;
                }).length;
                return (
                  <div key={traderName} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: myProfile.color + "11", borderLeft: `2px solid ${myProfile.color}`, marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {traderImgMap[traderName] && <img src={traderImgMap[traderName]} alt={traderName} style={{ width: 32, height: 32, borderRadius: "50%", border: `2px solid ${myProfile.color}44`, objectFit: "cover" }} />}
                        <div style={{ fontSize: T.fs3, color: myProfile.color, fontWeight: "bold", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase" }}>{traderName}</div>
                      </div>
                      <div style={{ fontSize: T.fs2, color: completedCount === tasks.length && tasks.length > 0 ? T.success : T.textDim, fontFamily: T.sans }}>{completedCount}/{tasks.length} done</div>
                    </div>
                    {tasks.map(({ taskId, apiTask }) => {
                      const prog = myProfile.progress || {};
                      const completedObjs = (apiTask.objectives || []).filter(obj => { const k = `${myProfile.id}-${taskId}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) >= meta.total; }).length;
                      const totalObjs = (apiTask.objectives || []).filter(o => !o.optional).length;
                      const isComplete = completedObjs >= totalObjs && totalObjs > 0;
                      return (
                        <div key={taskId} style={{ background: isComplete ? T.successBg : T.surface, border: `1px solid ${isComplete ? T.successBorder : T.border}`, borderLeft: `2px solid ${isComplete ? T.success : T.border}`, padding: 10, marginBottom: 4 }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ color: isComplete ? T.success : T.textBright, fontSize: T.fs2, fontWeight: "bold", textDecoration: isComplete ? "line-through" : "none" }}>{apiTask.name}</div>
                              <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                                {apiTask.map && <Badge label={apiTask.map.name} color={T.blue} />}
                                <span style={{ fontSize: T.fs2, color: isComplete ? T.success : T.textDim }}>{completedObjs}/{totalObjs} obj</span>
                              </div>
                            </div>
                            <button onClick={() => removeTask(taskId)} style={{ background: "transparent", border: "none", color: T.errorBorder, cursor: "pointer", fontSize: T.fs4, padding: "0 4px", flexShrink: 0 }}>×</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* ── HIDEOUT SUB-TAB ── */}
        {profileSub === "hideout" && (() => {
          const stations = apiHideout?.filter(s => s.levels.length > 0).sort((a, b) => a.name.localeCompare(b.name)) || [];
          const maxedCount = stations.filter(s => (hideoutLevels[s.id] || 0) >= Math.max(...s.levels.map(l => l.level))).length;
          const stationIcons = {
            "Air Filtering Unit":"◎","Bitcoin Farm":"₿","Booze Generator":"⚗","Cultist Circle":"⁂",
            "Defective Wall":"▦","Generator":"⚡","Gym":"⚔","Hall of Fame":"★","Heating":"♨",
            "Illumination":"☀","Intelligence Center":"◈","Lavatory":"⚙","Library":"≡",
            "Medstation":"✚","Nutrition Unit":"⊟","Rest Space":"☾","Scav Case":"▣","Security":"⊕",
            "Shooting Range":"◎","Solar Power":"☼","Stash":"▤","Vents":"≋","Water Collector":"◇","Workbench":"⊞",
          };
          return (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <SL c={<>MY HIDEOUT ({maxedCount}/{stations.length} maxed)<Tip text="Tap a station to see upgrade requirements and set your current level. Use TARGET to mark what you're working toward — it's included in your share code." /></>} s={{ marginBottom: 0 }} />
              </div>

              {/* Current target banner */}
              {hideoutTarget && apiHideout ? (() => {
                const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
                const level = station?.levels.find(l => l.level === hideoutTarget.level);
                return station && level ? (
                  <div style={{ background: myProfile.color + "11", border: `1px solid ${myProfile.color}44`, borderLeft: `2px solid ${myProfile.color}`, padding: 10, marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ fontSize: T.fs1, letterSpacing: 1.5, color: myProfile.color }}>★ TARGET</div>
                        <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold" }}>{station.name} → Lv {hideoutTarget.level}</div>
                      </div>
                      <button onClick={() => saveHideoutTarget(null)} style={{ background: "transparent", border: `2px solid ${T.errorBorder}`, color: T.error, padding: "3px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans }}>CLEAR</button>
                    </div>
                    <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 4 }}>
                      {level.itemRequirements.slice(0, 3).map(r => `${r.item.shortName || r.item.name} ×${r.count}`).join(", ")}
                      {level.itemRequirements.length > 3 && ` +${level.itemRequirements.length - 3} more`}
                    </div>
                  </div>
                ) : null;
              })() : (
                <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 12, textAlign: "center", marginBottom: 10 }}>
                  <div style={{ fontSize: T.fs2, color: T.textDim }}>No target set — tap a station below</div>
                </div>
              )}

              {/* Prereq prompt */}
              {hideoutPrereq && (
                <div style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, borderLeft: `2px solid ${T.orange}`, padding: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.orange, marginBottom: 6 }}>PREREQUISITES NEEDED</div>
                  <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.6, marginBottom: 10 }}>
                    <span style={{ color: T.textBright, fontWeight: "bold" }}>{hideoutPrereq.stationName} Level {hideoutPrereq.level}</span> requires upgrades you don't have yet.
                  </div>
                  {hideoutPrereq.unmet.map((req, i) => {
                    const prereqStation = apiHideout?.find(s => s.id === req.stationId);
                    const prereqItems = prereqStation?.levels.find(l => l.level === req.level)?.itemRequirements?.filter(r => r.item.name !== "Roubles") || [];
                    return (
                      <button key={i} onClick={() => { saveHideoutTarget({ stationId: req.stationId, level: req.level }); setHideoutPrereq(null); }}
                        style={{ width: "100%", background: myProfile.color + "11", border: `2px solid ${myProfile.color}44`, padding: "8px 10px", marginBottom: 4, cursor: "pointer", textAlign: "left" }}>
                        <div style={{ fontSize: T.fs2, color: myProfile.color, fontWeight: "bold" }}>{req.stationName} → Level {req.level}</div>
                        {prereqItems.length > 0 && <div style={{ fontSize: T.fs1, color: T.textDim, marginTop: 2 }}>{prereqItems.slice(0, 4).map(r => `${r.item.shortName || r.item.name} ×${r.count}`).join(", ")}{prereqItems.length > 4 ? " ..." : ""}</div>}
                      </button>
                    );
                  })}
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button onClick={() => { saveHideoutTarget({ stationId: hideoutPrereq.stationId, level: hideoutPrereq.level }); setHideoutPrereq(null); }}
                      style={{ flex: 1, background: "transparent", border: `2px solid ${T.border}`, color: T.textDim, padding: "6px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>TARGET ANYWAY</button>
                    <button onClick={() => setHideoutPrereq(null)}
                      style={{ flex: 1, background: "transparent", border: `2px solid ${T.border}`, color: T.textDim, padding: "6px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>CANCEL</button>
                  </div>
                </div>
              )}

              {/* Station grid — 2-column like in-game hideout */}
              {apiHideout ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                  {stations.map(station => {
                    const curLevel = hideoutLevels[station.id] || 0;
                    const maxLevel = Math.max(...station.levels.map(l => l.level));
                    const isMaxed = curLevel >= maxLevel;
                    const isTarget = hideoutTarget?.stationId === station.id;
                    const isExpanded = expandedStation === station.id;
                    const icon = stationIcons[station.name] || "◇";
                    const nextLevel = !isMaxed ? station.levels.find(l => l.level === curLevel + 1) : null;
                    const canUpgradeNext = nextLevel ? (nextLevel.stationLevelRequirements || []).every(req => (hideoutLevels[req.station.id] || 0) >= req.level) : false;
                    return (
                      <div key={station.id} style={{
                        gridColumn: isExpanded ? "1 / -1" : undefined,
                        background: isMaxed ? T.successBg : (isTarget ? myProfile.color + "08" : T.surface),
                        border: `1px solid ${isMaxed ? T.successBorder : (isTarget ? myProfile.color + "44" : T.border)}`,
                        borderLeft: `2px solid ${isMaxed ? T.success : (isTarget ? myProfile.color : (!isMaxed && canUpgradeNext ? T.orange + "66" : T.border))}`,
                        padding: isExpanded ? 10 : 8,
                      }}>
                        {/* Tile header — clickable */}
                        <div onClick={() => setExpandedStation(isExpanded ? null : station.id)}
                          style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: isExpanded ? T.fs4 : T.fs3, color: isMaxed ? T.success : (isTarget ? myProfile.color : T.textDim), lineHeight: 1, flexShrink: 0, width: isExpanded ? 24 : 18, textAlign: "center" }}>{icon}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: T.fs2, fontWeight: "bold",
                              color: isMaxed ? T.success : T.textBright,
                              textDecoration: "none",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>{station.name}</div>
                            {/* Level progress bar */}
                            <div style={{ display: "flex", gap: 1, marginTop: 3 }}>
                              {maxLevel > 0 && Array.from({ length: maxLevel }, (_, i) => (
                                <div key={i} style={{
                                  flex: 1, height: 3, borderRadius: 1,
                                  background: i < curLevel ? (isMaxed ? T.success : (isTarget ? myProfile.color : T.success + "88")) : T.border,
                                }} />
                              ))}
                            </div>
                          </div>
                          <div style={{ fontSize: T.fs1, color: isMaxed ? T.success : T.textDim, flexShrink: 0 }}>
                            {isMaxed ? <Badge label="MAX" color={T.success} small /> : `${curLevel}/${maxLevel}`}
                          </div>
                        </div>

                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
                            {/* Level selector */}
                            <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 1, marginBottom: 4 }}>SET LEVEL</div>
                            <div style={{ display: "flex", gap: 3, marginBottom: 10, flexWrap: "wrap" }}>
                              {Array.from({ length: maxLevel + 1 }, (_, i) => (
                                <button key={i} onClick={() => saveHideoutLevels({ ...hideoutLevels, [station.id]: i })}
                                  style={{
                                    width: 30, height: 26, fontSize: T.fs2, fontFamily: T.sans,
                                    background: curLevel === i ? myProfile.color + "22" : "transparent",
                                    border: `2px solid ${curLevel === i ? myProfile.color : T.border}`,
                                    color: curLevel === i ? myProfile.color : (i < curLevel ? T.success : T.textDim),
                                    cursor: "pointer",
                                  }}>{i}</button>
                              ))}
                            </div>

                            {/* Next upgrade requirements */}
                            {!isMaxed && nextLevel && (
                              <>
                                <div style={{ fontSize: T.fs1, color: T.textDim, letterSpacing: 1, marginBottom: 6 }}>UPGRADE TO LEVEL {curLevel + 1}</div>
                                {nextLevel.itemRequirements.length > 0 && (
                                  <div style={{ marginBottom: 8 }}>
                                    {nextLevel.itemRequirements.map((req, i) => (
                                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${T.border}` }}>
                                        <span style={{ fontSize: T.fs2, color: T.text }}>{req.item.name}</span>
                                        <Badge label={`×${req.count}`} color={myProfile.color} small />
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {nextLevel.traderRequirements?.length > 0 && (
                                  <div style={{ marginBottom: 6 }}>
                                    {nextLevel.traderRequirements.map((req, i) => (
                                      <div key={i} style={{ fontSize: T.fs2, color: T.orange, marginBottom: 2 }}>Requires {req.trader.name} LL{req.level}</div>
                                    ))}
                                  </div>
                                )}
                                {nextLevel.stationLevelRequirements?.length > 0 && (
                                  <div style={{ marginBottom: 8 }}>
                                    {nextLevel.stationLevelRequirements.map((req, i) => {
                                      const met = (hideoutLevels[req.station.id] || 0) >= req.level;
                                      return <div key={i} style={{ fontSize: T.fs2, color: met ? T.success : T.error, marginBottom: 2 }}>{met ? "✓" : "✕"} {req.station.name} Level {req.level}</div>;
                                    })}
                                  </div>
                                )}
                              </>
                            )}

                            {/* Target buttons */}
                            {!isMaxed && (
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                {station.levels.filter(l => l.level > curLevel).map(l => {
                                  const isThisTarget = isTarget && hideoutTarget.level === l.level;
                                  const canBuildIt = (l.stationLevelRequirements || []).every(req => (hideoutLevels[req.station.id] || 0) >= req.level);
                                  return (
                                    <button key={l.level}
                                      onClick={() => {
                                        if (isThisTarget) { saveHideoutTarget(null); return; }
                                        const unmet = (l.stationLevelRequirements || []).filter(req => (hideoutLevels[req.station.id] || 0) < req.level).map(req => ({ stationId: req.station.id, stationName: req.station.name, level: req.level }));
                                        if (unmet.length > 0) { setHideoutPrereq({ stationName: station.name, stationId: station.id, level: l.level, unmet }); }
                                        else { saveHideoutTarget({ stationId: station.id, level: l.level }); }
                                      }}
                                      style={{
                                        background: isThisTarget ? myProfile.color + "22" : "transparent",
                                        border: `2px solid ${isThisTarget ? myProfile.color : T.border}`,
                                        color: isThisTarget ? myProfile.color : (canBuildIt ? T.textDim : T.error + "88"),
                                        padding: "4px 10px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1,
                                      }}
                                    >{isThisTarget ? "★ " : ""}TARGET L{l.level}{!canBuildIt ? " (prereq)" : ""}</button>
                                  );
                                })}
                              </div>
                            )}

                            {isMaxed && (
                              <div style={{ fontSize: T.fs2, color: T.success, textAlign: "center", padding: 6 }}>✓ FULLY UPGRADED</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ color: T.textDim, fontSize: T.fs2, textAlign: "center", padding: 20 }}>Loading hideout data...</div>
              )}
            </>
          );
        })()}

        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}

// ─── SQUAD ROOM HOOK ─────────────────────────────────────────────────────
const ROOM_WORDS = ["ALPHA","BRAVO","CHARLIE","DELTA","ECHO","FOXTROT","GHOST","HUNTER","IRON","JACKAL","KILO","LIMA","MIKE","NOVA","OSCAR","PAPA","QUEST","RAVEN","SIERRA","TANGO","ULTRA","VIPER","WOLF","XRAY","YANK","ZULU"];
function generateRoomCode() {
  const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
  const num = Math.floor(Math.random() * 900 + 100);
  return `${word}-${num}`;
}

function useSquadRoom(myProfile) {
  const deviceId = localStorage.getItem("tg-device-id") || "unknown";
  const [roomId, setRoomId] = useState(null);
  const [roomCode, setRoomCode] = useState(null);
  const [members, setMembers] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | creating | joining | connected | error
  const [error, setError] = useState(null);
  const [leaderId, setLeaderId] = useState(null); // device_id of leader, null = no leader
  const [sharedRoute, setSharedRoute] = useState(null); // route broadcast from leader
  const [sharedRouteConfig, setSharedRouteConfig] = useState(null); // {mapId, faction, routeMode, ...}
  const subRef = useRef(null);
  const roomSubRef = useRef(null);

  const isLeader = leaderId === deviceId;
  const hasLeader = leaderId !== null;

  // Push profile + preferences to room whenever they change
  useEffect(() => {
    if (!supabase || !roomId || !myProfile?.name) return;
    const profileData = { name: myProfile.name, color: myProfile.color, tasks: myProfile.tasks || [], progress: myProfile.progress || {} };
    supabase.from("squad_members").upsert(
      { room_id: roomId, device_id: deviceId, profile: profileData, updated_at: new Date().toISOString() },
      { onConflict: "room_id,device_id" }
    ).then(({ error: e }) => { if (e) console.warn("[TG] Room profile sync failed:", e); });
  }, [roomId, myProfile?.name, myProfile?.color, myProfile?.tasks?.length, myProfile?.progress]);

  // Push preferences (extract vote, ready state) separately so they don't conflict with profile syncs
  const updatePreferences = useCallback(async (prefs) => {
    if (!supabase || !roomId) return;
    // Merge with existing preferences
    const { data: current } = await supabase.from("squad_members").select("preferences").eq("room_id", roomId).eq("device_id", deviceId).single();
    const merged = { ...(current?.preferences || {}), ...prefs };
    await supabase.from("squad_members").update({ preferences: merged }).eq("room_id", roomId).eq("device_id", deviceId);
  }, [roomId, deviceId]);

  // Subscribe to room members AND room changes (for leader/route)
  const subscribeToRoom = useCallback((rid) => {
    if (!supabase) return;
    if (subRef.current) { supabase.removeChannel(subRef.current); subRef.current = null; }
    if (roomSubRef.current) { supabase.removeChannel(roomSubRef.current); roomSubRef.current = null; }

    // Initial fetch — members
    supabase.from("squad_members").select("*").eq("room_id", rid).then(({ data }) => {
      if (data) setMembers(data.filter(m => m.device_id !== deviceId));
    });

    // Initial fetch — room (leader, route)
    supabase.from("squad_rooms").select("leader_id, route, route_config").eq("id", rid).single().then(({ data }) => {
      if (data) {
        setLeaderId(data.leader_id || null);
        setSharedRoute(data.route || null);
        setSharedRouteConfig(data.route_config || null);
      }
    });

    // Realtime: members
    const memberChannel = supabase.channel(`room-members-${rid}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "squad_members", filter: `room_id=eq.${rid}` }, (payload) => {
        if (payload.eventType === "DELETE") {
          setMembers(prev => prev.filter(m => m.id !== payload.old.id));
        } else {
          const row = payload.new;
          if (row.device_id === deviceId) return;
          setMembers(prev => {
            const exists = prev.findIndex(m => m.id === row.id);
            if (exists >= 0) { const next = [...prev]; next[exists] = row; return next; }
            return [...prev, row];
          });
        }
      })
      .subscribe();
    subRef.current = memberChannel;

    // Realtime: room (leader changes, route broadcasts)
    const roomChannel = supabase.channel(`room-state-${rid}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "squad_rooms", filter: `id=eq.${rid}` }, (payload) => {
        const row = payload.new;
        setLeaderId(row.leader_id || null);
        setSharedRoute(row.route || null);
        setSharedRouteConfig(row.route_config || null);
      })
      .subscribe();
    roomSubRef.current = roomChannel;
  }, [deviceId]);

  const createRoom = useCallback(async () => {
    if (!supabase) { setError("Supabase not configured"); return; }
    setStatus("creating"); setError(null);
    try {
      const code = generateRoomCode();
      const { data, error: e } = await supabase.from("squad_rooms").insert({ code, created_by: deviceId }).select().single();
      if (e) throw e;
      setRoomId(data.id); setRoomCode(data.code); setStatus("connected");
      subscribeToRoom(data.id);
    } catch (e) { setError(e.message); setStatus("error"); }
  }, [deviceId, subscribeToRoom]);

  const joinRoom = useCallback(async (code) => {
    if (!supabase) { setError("Supabase not configured"); return; }
    setStatus("joining"); setError(null);
    try {
      const { data, error: e } = await supabase.from("squad_rooms").select("id, code, leader_id, route, route_config").eq("code", code.trim().toUpperCase()).single();
      if (e || !data) throw new Error("Room not found — check the code and try again.");
      setRoomId(data.id); setRoomCode(data.code); setStatus("connected");
      setLeaderId(data.leader_id || null);
      setSharedRoute(data.route || null);
      setSharedRouteConfig(data.route_config || null);
      subscribeToRoom(data.id);
    } catch (e) { setError(e.message); setStatus("error"); }
  }, [subscribeToRoom]);

  const leaveRoom = useCallback(async () => {
    if (subRef.current && supabase) { supabase.removeChannel(subRef.current); subRef.current = null; }
    if (roomSubRef.current && supabase) { supabase.removeChannel(roomSubRef.current); roomSubRef.current = null; }
    if (supabase && roomId) {
      // If leaving leader, clear leader
      if (isLeader) await supabase.from("squad_rooms").update({ leader_id: null, route: null, route_config: null }).eq("id", roomId);
      await supabase.from("squad_members").delete().eq("room_id", roomId).eq("device_id", deviceId);
    }
    setRoomId(null); setRoomCode(null); setMembers([]); setStatus("idle"); setError(null);
    setLeaderId(null); setSharedRoute(null); setSharedRouteConfig(null);
  }, [roomId, deviceId, isLeader]);

  // Claim / release leadership
  const claimLeader = useCallback(async () => {
    if (!supabase || !roomId) return;
    await supabase.from("squad_rooms").update({ leader_id: deviceId, route: null, route_config: null }).eq("id", roomId);
  }, [roomId, deviceId]);

  const releaseLeader = useCallback(async () => {
    if (!supabase || !roomId) return;
    await supabase.from("squad_rooms").update({ leader_id: null, route: null, route_config: null }).eq("id", roomId);
  }, [roomId]);

  // Broadcast route (leader only)
  const broadcastRoute = useCallback(async (route, config) => {
    if (!supabase || !roomId || !isLeader) return;
    await supabase.from("squad_rooms").update({ route, route_config: config }).eq("id", roomId);
  }, [roomId, isLeader]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (subRef.current && supabase) supabase.removeChannel(subRef.current);
      if (roomSubRef.current && supabase) supabase.removeChannel(roomSubRef.current);
    };
  }, []);

  // Convert members to squad profiles format
  const roomSquad = members.map(m => ({
    id: "room_" + m.device_id,
    name: m.profile?.name || "???",
    color: m.profile?.color || PLAYER_COLORS[1],
    tasks: m.profile?.tasks || [],
    progress: m.profile?.progress || {},
    imported: true,
    importedAt: new Date(m.updated_at).getTime(),
    isRoomMember: true,
    deviceId: m.device_id,
    preferences: m.preferences || {},
  }));

  return {
    roomId, roomCode, roomSquad, status, error,
    createRoom, joinRoom, leaveRoom,
    // Leader
    leaderId, isLeader, hasLeader, claimLeader, releaseLeader,
    // Route broadcast
    sharedRoute, sharedRouteConfig, broadcastRoute,
    // Preferences
    updatePreferences,
    deviceId,
  };
}

// ─── SQUAD TAB ────────────────────────────────────────────────────────────
function SquadTab({ myProfile, saveMyProfile, apiMaps, apiTasks, loading, apiError, hideoutTarget, apiHideout, hideoutLevels }) {
  const [importCode, setImportCode] = useState("");
  const [importError, setImportError] = useState("");
  const [importedSquad, saveImportedSquad] = useStorage("tg-squad-v3", []);
  const [joinCode, setJoinCode] = useState("");
  const room = useSquadRoom(myProfile);
  const [selectedMapId, setSelectedMapId] = useState(null);
  const [faction, setFaction] = useState("pmc");
  const [activeIds, setActiveIds] = useState(new Set());
  const [priorityTasks, setPriorityTasks] = useState({});
  const [extractChoices, setExtractChoices] = useState({}); // {[playerId]: {extract, confirmed, missingItems}}
  const [route, setRoute] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [resolvedConflicts, setResolvedConflicts] = useState({});
  const [screen, setScreen] = useState("squad");
  const [routeMode, setRouteMode] = useState("tasks"); // "tasks" or "loot"
  const [lootSubMode, setLootSubMode] = useState("all"); // "all", "hideout", "equipment"
  const [targetEquipment, saveTargetEquipment] = useStorage("tg-target-equipment-v1", []); // [{id, name, shortName, categories}]
  const [equipSearch, setEquipSearch] = useState("");
  const [equipResults, setEquipResults] = useState(null);
  const [equipSearching, setEquipSearching] = useState(false);
  const [tasksPerPerson, setTasksPerPerson] = useState(1);
  const [plannerView, setPlannerView] = useState("quick"); // "quick" or "full"
  const [squadExpanded, setSquadExpanded] = useState(false);
  const [quickGenPending, setQuickGenPending] = useState(false);
  const [qhStation, setQhStation] = useState(null); // quick hideout: selected station id
  const [qhLevel, setQhLevel] = useState(null); // quick hideout: selected level number
  const [qhItem, setQhItem] = useState(null); // quick hideout: selected item {id, name, shortName, count}
  const [qiSearch, setQiSearch] = useState(""); // quick item search term
  const [qiResults, setQiResults] = useState(null); // quick item search results
  const [qiSearching, setQiSearching] = useState(false);

  const searchEquipment = async (term) => {
    if (!term || term.length < 2) { setEquipResults(null); return; }
    setEquipSearching(true);
    try {
      const data = await fetchAPI(ITEMS_SEARCH_Q(term));
      setEquipResults(data?.items || []);
    } catch(e) { setEquipResults([]); }
    setEquipSearching(false);
  };

  // Score loot points by tag relevance, return top 3 — exact tag matches score 3, "Barter item" gets 1
  const LOOT_TYPE_BONUS = { "high-value": 2, tech: 2, medical: 1, mixed: 0, stash: 0 };
  const rankLootPoints = (lootPoints, neededTags) => {
    if (!lootPoints?.length || !neededTags?.size) return lootPoints;
    const scored = lootPoints.map(lp => {
      const tags = lp.tags || [];
      let score = 0;
      tags.forEach(t => { if (neededTags.has(t)) score += 3; });
      score += (LOOT_TYPE_BONUS[lp.type] || 0);
      return { lp, score };
    });
    scored.sort((a, b) => b.score - a.score);
    // Take top 3 — but only include nodes with some relevance (score > 0)
    const top = scored.filter(s => s.score > 0).slice(0, 3);
    // If fewer than 3 matched, fill with best remaining general loot points
    if (top.length < 3) {
      const used = new Set(top.map(s => s.lp.name));
      const rest = scored.filter(s => !used.has(s.lp.name)).slice(0, 3 - top.length);
      top.push(...rest);
    }
    return top.map(s => s.lp);
  };

  // Compute filtered loot points based on sub-mode — uses tags for precise matching
  const getFilteredLootPoints = (lootPoints) => {
    if (!lootPoints) return [];
    if (lootSubMode === "all") return lootPoints;
    if (lootSubMode === "hideout" && hideoutTarget && apiHideout) {
      const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
      const level = station?.levels.find(l => l.level === hideoutTarget.level);
      if (level) {
        // Map hideout item names to tags via name heuristics (hideout API doesn't include categories)
        const neededTags = new Set();
        level.itemRequirements.forEach(req => {
          const n = (req.item.name || "").toLowerCase();
          if (n.includes("gpu") || n.includes("graphics") || n.includes("circuit") || n.includes("wire") || n.includes("relay") || n.includes("tetriz") || n.includes("vpx") || n.includes("flash drive") || n.includes("ssd") || n.includes("phase")) neededTags.add("Electronics");
          if (n.includes("ledx") || n.includes("ophthalmoscope") || n.includes("defib") || n.includes("salewa") || n.includes("medic") || n.includes("surv12") || n.includes("cms") || n.includes("vaseline")) neededTags.add("Medical supplies");
          if (n.includes("salewa") || n.includes("grizzly") || n.includes("ifak") || n.includes("afak") || n.includes("cms") || n.includes("surv")) neededTags.add("Meds");
          if (n.includes("stim") || n.includes("propital") || n.includes("etg") || n.includes("sj")) neededTags.add("Stimulant");
          if (n.includes("bolt") || n.includes("screw") || n.includes("nail") || n.includes("duct tape") || n.includes("insulating") || n.includes("bulb") || n.includes("cable") || n.includes("capacitor")) neededTags.add("Building material");
          if (n.includes("wrench") || n.includes("plier") || n.includes("screwdriver") || n.includes("multitool")) neededTags.add("Tool");
          if (n.includes("hose") || n.includes("pipe") || n.includes("motor") || n.includes("filter") || n.includes("tube") || n.includes("corrugated")) neededTags.add("Household goods");
          if (n.includes("fuel") || n.includes("propane") || n.includes("expeditionary")) neededTags.add("Fuel");
          if (n.includes("weapon") || n.includes("gun") || n.includes("rifle") || n.includes("pistol") || n.includes("ak-") || n.includes("m4a1")) neededTags.add("Weapon");
          if (n.includes("intel") || n.includes("folder") || n.includes("diary") || n.includes("sas drive")) neededTags.add("Info");
          if (n.includes("key") && !n.includes("keyboard")) neededTags.add("Key");
          if (n.includes("gold") || n.includes("bitcoin") || n.includes("lion") || n.includes("cat") || n.includes("horse") || n.includes("chain") || n.includes("roler")) neededTags.add("Jewelry");
          // If nothing matched, add broad tags
          if (neededTags.size === 0) { neededTags.add("Barter item"); neededTags.add("Building material"); }
        });
        return rankLootPoints(lootPoints, neededTags);
      }
    }
    if (lootSubMode === "equipment" && targetEquipment.length > 0) {
      // Use actual API categories from the selected items — match against loot point tags
      const neededTags = new Set();
      targetEquipment.forEach(item => {
        (item.categories || []).forEach(c => {
          if (c.name !== "Item" && c.name !== "Compound item" && c.name !== "Stackable item" && c.name !== "Searchable item") {
            neededTags.add(c.name);
          }
        });
      });
      return rankLootPoints(lootPoints, neededTags);
    }
    return lootPoints;
  };

  const selectedMap = apiMaps?.find(m => m.id === selectedMapId);
  const selectedMapNorm = apiMaps?.find(m => m.id === selectedMapId)?.normalizedName;
  const emap = EMAPS.find(m => m.id === selectedMapNorm);
  const allProfiles = [myProfile, ...room.roomSquad, ...importedSquad.filter(ip => !room.roomSquad.some(rp => rp.name === ip.name))];

  // When map changes, reset extract choices
  useEffect(() => { setExtractChoices({}); }, [selectedMapId, faction]);

  const handleImport = () => {
    setImportError("");
    const decoded = decodeProfile(importCode.trim());
    if (!decoded) { setImportError("Invalid code — check for typos or ask your squadmate to re-copy."); return; }
    if (importedSquad.some(p => p.name === decoded.name)) { setImportError(`Already have "${decoded.name}". Remove first to update.`); return; }
    saveImportedSquad([...importedSquad, decoded]);
    setImportCode("");
  };

  const toggleActive = id => setActiveIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // When leader broadcasts a route and we're not the leader, show it
  useEffect(() => {
    if (room.status !== "connected" || room.isLeader) return;
    if (room.sharedRoute && room.sharedRouteConfig) {
      setRoute(room.sharedRoute);
      if (room.sharedRouteConfig.mapId) setSelectedMapId(room.sharedRouteConfig.mapId);
      if (room.sharedRouteConfig.faction) setFaction(room.sharedRouteConfig.faction);
      if (room.sharedRouteConfig.routeMode) setRouteMode(room.sharedRouteConfig.routeMode);
      setScreen("route");
    }
  }, [room.sharedRoute, room.sharedRouteConfig, room.status, room.isLeader]);

  const generateRoute = useCallback(() => {
    if (!selectedMap || !emap || !activeIds.size) return;

    let positioned = [];
    let unpositioned = [];
    let newConflicts = [];

    if (routeMode === "loot") {
      // Loot mode: route through filtered loot points
      const filteredLP = getFilteredLootPoints(emap.lootPoints);
      positioned = filteredLP.map((lp, i) => {
        const lc = LOOT_CONFIG[lp.type] || LOOT_CONFIG.mixed;
        return {
          id: `loot_${i}`,
          pct: lp.pct,
          locationName: lp.name,
          isLoot: true,
          players: [{ playerId: "loot", name: lp.note, color: lc.color, objective: `${lc.icon} ${lc.label}`, isCountable: false, total: 1, progress: 0 }],
        };
      });
    } else {
      // Task mode: existing behavior
      const bounds = MAP_BOUNDS[selectedMapNorm] || null;
      const wpMap = new Map();

      activeIds.forEach(pid => {
        const profile = allProfiles.find(p => p.id === pid); if (!profile) return;
        const ptaskIds = priorityTasks[pid] || []; if (!ptaskIds.length) return;

        ptaskIds.forEach(ptaskId => {
          const apiTask = apiTasks?.find(t => t.id === ptaskId); if (!apiTask) return;

          (apiTask.objectives || []).filter(obj => !obj.optional).forEach(obj => {
            const progressKey = `${pid}-${ptaskId}-${obj.id}`;
            const objProgress = (profile.progress || {})[progressKey] || 0;
            const meta = getObjMeta(obj);
            if (objProgress >= meta.total) return;
            const zonePos = obj.zones?.[0]?.position || obj.possibleLocations?.[0]?.positions?.[0] || null;
            const pct = worldToPct(zonePos, bounds);
            const entry = { playerId: pid, name: profile.name, color: profile.color, taskId: ptaskId, objId: obj.id, objective: meta.summary, isCountable: meta.isCountable, total: meta.total, progress: objProgress };
            if (pct) {
              const gk = `${Math.round(pct.x * 20)}_${Math.round(pct.y * 20)}`;
              if (wpMap.has(gk)) wpMap.get(gk).players.push(entry);
              else wpMap.set(gk, { id: `wp_${gk}`, pct, locationName: obj.description?.split(",")[0] || "Location", players: [entry] });
            } else {
              unpositioned.push({ id: `unpos_${pid}_${obj.id}`, pct: null, locationName: apiTask.name, players: [entry] });
            }
          });
        });
      });

      positioned = [...wpMap.values()];
      positioned.forEach(wp => {
        const pids = [...new Set(wp.players.map(p => p.playerId))];
        if (pids.length > 1) {
          const kills = wp.players.filter(p => p.objective.toLowerCase().startsWith("kill"));
          if (kills.length > 1) newConflicts.push({ id: wp.id, label: `${kills.map(p => p.name).join(" & ")} both have kill objectives here. Merge into one stop?` });
        }
      });
    }

    // Build route: waypoints first (nearest-neighbor), then extract(s) last
    const orderedObjectives = nearestNeighbor(positioned);

    // Build extract waypoints — group players who share the same extract
    const extractWpMap = new Map();
    activeIds.forEach(pid => {
      const ec = extractChoices[pid];
      if (!ec?.extract) return;
      const profile = allProfiles.find(p => p.id === pid);
      if (!profile) return;
      const key = ec.extract.name;
      if (!extractWpMap.has(key)) {
        extractWpMap.set(key, {
          id: `ext_${key.replace(/\s+/g, "_")}`,
          pct: ec.extract.pct,
          extractName: ec.extract.name,
          isExtract: true,
          players: [],
        });
      }
      extractWpMap.get(key).players.push({
        playerId: pid, name: profile.name, color: profile.color,
        missingItems: ec.missingItems || [],
      });
    });
    const extractWaypoints = [...extractWpMap.values()];

    const finalRoute = [...orderedObjectives, ...unpositioned, ...extractWaypoints];
    setRoute(finalRoute);
    setConflicts(newConflicts.filter(c => !resolvedConflicts[c.id]));
    setScreen("route");

    // If leader, broadcast route to room
    if (room.isLeader && room.roomId) {
      room.broadcastRoute(finalRoute, { mapId: selectedMapId, faction, routeMode, lootSubMode });
    }
  }, [selectedMap, emap, activeIds, allProfiles, priorityTasks, apiTasks, extractChoices, resolvedConflicts, routeMode, lootSubMode, targetEquipment, hideoutTarget, apiHideout, room.isLeader, room.roomId]);

  const handleConflictResolve = (id, choice) => {
    setResolvedConflicts(r => ({ ...r, [id]: choice }));
    setConflicts(c => c.filter(x => x.id !== id));
    if (choice === "merge") setRoute(r => r.map(w => { if (w.id !== id) return w; const seen = new Set(); return { ...w, players: w.players.filter(p => { if (seen.has(p.playerId)) return false; seen.add(p.playerId); return true; }) }; }));
  };

  const handleSaveMyProgress = newProgress => saveMyProfile({ ...myProfile, progress: newProgress });

  const canGenerate = selectedMap && activeIds.size > 0 && (routeMode === "loot" || [...activeIds].some(id => (priorityTasks[id] || []).length > 0));

  // Deferred route generation for Quick Start GO button
  useEffect(() => {
    if (quickGenPending && selectedMap && emap && activeIds.size > 0) {
      generateRoute();
      setQuickGenPending(false);
    }
  }, [quickGenPending, selectedMap, emap, activeIds, generateRoute]);

  // Route screen — breaks out of the 480px container to use full width
  if (screen === "route" || screen === "postraid") return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: T.bg, zIndex: 50, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px", flexShrink: 0 }}>
        <button onClick={() => setScreen("squad")} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: T.fs3, letterSpacing: 1, cursor: "pointer", fontFamily: T.sans, padding: 0, marginBottom: 6 }}>← BACK TO PLANNER</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: T.fs4, color: T.gold, fontWeight: "bold" }}>{selectedMap?.name} — {routeMode === "loot" ? (lootSubMode === "hideout" ? "Hideout Run" : lootSubMode === "equipment" ? "Equipment Run" : "Loot Run") : "Squad Route"}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Tip text="After your raid, tap POST-RAID to log kills and items found. This updates your progress so your next share code reflects what's done." />
            <button onClick={() => setScreen("postraid")} style={{ background: T.success + "22", border: `1px solid ${T.successBorder}`, color: T.success, padding: "6px 12px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>POST-RAID ▶</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 7, flexWrap: "wrap" }}>
          {[...activeIds].map(pid => { const p = allProfiles.find(x => x.id === pid); const tasks = (priorityTasks[pid] || []).map(tid => apiTasks?.find(t => t.id === tid)).filter(Boolean); const ec = extractChoices[pid]; return p ? <div key={pid} style={{ background: p.color + "15", border: `1px solid ${p.color}44`, padding: "2px 7px", fontSize: T.fs2, fontFamily: T.sans, color: p.color }}>{p.name}{tasks.length ? ` — ${tasks.map(t => t.name.slice(0, 14)).join(", ")}` : ""}{ec?.extract ? ` → ⬆ ${ec.extract.name}` : ""}</div> : null; })}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 5%" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <MapOverlay apiMap={selectedMap} emap={emap} route={route} conflicts={conflicts} onConflictResolve={handleConflictResolve} />
          {/* Targeted items reminder */}
          {routeMode === "loot" && lootSubMode === "hideout" && hideoutTarget && apiHideout && (() => {
            const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
            const level = station?.levels.find(l => l.level === hideoutTarget.level);
            const items = level?.itemRequirements?.filter(r => r.item.name !== "Roubles") || [];
            return items.length > 0 ? (
              <div style={{ background: T.cyanBg, border: `1px solid ${T.cyanBorder}`, borderLeft: `2px solid ${T.cyan}`, padding: 12, marginTop: 10 }}>
                <SL c={<>ITEMS TO LOOK FOR<Tip text="These are the items needed for your hideout upgrade. Keep an eye out for them at each stop on the route." /></>} s={{ marginBottom: 8 }} />
                <div style={{ fontSize: T.fs3, color: T.cyan, marginBottom: 8 }}>{station.name} → Level {hideoutTarget.level}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {items.map((r, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: T.cyan + "08", border: `1px solid ${T.cyan}22` }}>
                      <span style={{ fontSize: T.fs4, color: T.textBright }}>{r.item.name}</span>
                      <span style={{ fontSize: T.fs3, color: T.cyan, fontFamily: T.mono }}>×{r.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}
          {routeMode === "loot" && lootSubMode === "equipment" && targetEquipment.length > 0 && (
            <div style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, borderLeft: `2px solid ${T.orange}`, padding: 12, marginTop: 10 }}>
              <SL c={<>ITEMS TO LOOK FOR<Tip text="These are the items you're targeting this raid. Keep an eye out for them at each stop on the route." /></>} s={{ marginBottom: 8 }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {targetEquipment.map((item, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: T.orange + "08", border: `1px solid ${T.orange}22` }}>
                    <span style={{ fontSize: T.fs4, color: T.textBright }}>{item.name}</span>
                    <span style={{ fontSize: T.fs2, color: T.orange, fontFamily: T.sans }}>{(item.categories || []).filter(c => c.name !== "Item" && c.name !== "Compound item").map(c => c.name).slice(0, 2).join(" · ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Extract selection — post-route (when no extract was pre-selected) */}
          {!route.some(w => w.isExtract) && emap && (
            <div style={{ background: T.surface, border: `1px solid ${T.successBorder}`, borderLeft: `2px solid ${T.success}`, padding: 12, marginTop: 10 }}>
              <SL c={<>CHOOSE YOUR EXTRACT<Tip text="Pick your exit point after seeing the route. It will be added as the final waypoint on your map." /></>} s={{ marginBottom: 8 }} />
              {[...activeIds].map(pid => {
                const p = allProfiles.find(x => x.id === pid);
                if (!p) return null;
                return (
                  <div key={pid} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: T.fs2, color: p.color, letterSpacing: 1, marginBottom: 4, fontFamily: T.sans }}>{p.name.toUpperCase()}'S EXTRACT</div>
                    <ExtractSelector player={p} mapData={emap} faction={faction} choice={extractChoices[pid] || null}
                      onChoice={choice => {
                        const newEC = { ...extractChoices, [pid]: choice };
                        setExtractChoices(newEC);
                        // Dynamically append extract waypoints to route
                        setRoute(prev => {
                          const withoutExtracts = prev.filter(w => !w.isExtract);
                          const extractWpMap = new Map();
                          activeIds.forEach(epid => {
                            const ec = epid === pid ? choice : newEC[epid];
                            if (!ec?.extract) return;
                            const profile = allProfiles.find(x => x.id === epid);
                            if (!profile) return;
                            const key = ec.extract.name;
                            if (!extractWpMap.has(key)) extractWpMap.set(key, { id: `ext_${key.replace(/\s+/g, "_")}`, pct: ec.extract.pct, extractName: ec.extract.name, isExtract: true, players: [] });
                            extractWpMap.get(key).players.push({ playerId: epid, name: profile.name, color: profile.color, missingItems: ec.missingItems || [] });
                          });
                          return [...withoutExtracts, ...extractWpMap.values()];
                        });
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {screen === "postraid" && <PostRaidTracker route={route} myProfile={myProfile} onSave={handleSaveMyProgress} onClose={() => setScreen("route")} />}
    </div>
  );

  // ─── Quick Start recommendation ───
  const quickRec = computeMapRecommendation(allProfiles, apiTasks);
  const quickTopMap = quickRec[0] || null;
  const quickTopApiMap = quickTopMap ? apiMaps?.find(m => m.id === quickTopMap.mapId) : null;
  const quickTasks = quickTopMap ? computeQuickTasks(allProfiles, quickTopMap.mapId, apiTasks, tasksPerPerson) : {};
  const quickTaskCount = Object.values(quickTasks).flat().length;
  const quickTaskDetails = Object.entries(quickTasks).flatMap(([pid, tids]) => tids.map(tid => {
    const at = apiTasks?.find(t => t.id === tid);
    return at ? { name: at.name, trader: at.trader?.name || "" } : null;
  })).filter(Boolean);

  const handleQuickGo = () => {
    if (!quickTopMap) return;
    setSelectedMapId(quickTopMap.mapId);
    setFaction("pmc");
    setRouteMode("tasks");
    const qIds = new Set([myProfile.id]);
    if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
    setActiveIds(qIds);
    setPriorityTasks(computeQuickTasks(allProfiles, quickTopMap.mapId, apiTasks, tasksPerPerson));
    setExtractChoices({});
    setQuickGenPending(true);
  };

  const handleCustomize = () => {
    if (quickTopMap) {
      setSelectedMapId(quickTopMap.mapId);
      setFaction("pmc");
      setRouteMode("tasks");
      const qIds = new Set([myProfile.id]);
      if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
      setActiveIds(qIds);
      setPriorityTasks(computeQuickTasks(allProfiles, quickTopMap.mapId, apiTasks, tasksPerPerson));
    }
    setPlannerView("full");
  };

  // ─── Quick Start view ───
  if (plannerView === "quick") return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <SL c={<>QUICK START<Tip text="Your recommended raid based on incomplete tasks. Tap GO to jump straight in, or CUSTOMIZE to adjust the map, tasks, and extract." /></>} s={{ marginBottom: 8 }} />
        {loading && <div style={{ fontSize: T.fs3, color: T.textDim, marginBottom: 6 }}>Loading from tarkov.dev...</div>}
        {apiError && <div style={{ fontSize: T.fs3, color: T.error, marginBottom: 6 }}>tarkov.dev unavailable — check connection</div>}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {quickTopMap && quickTaskCount > 0 ? (
          <div style={{ background: T.surface, border: `2px solid ${T.gold}44`, borderLeft: `2px solid ${T.gold}`, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 8 }}>★ RECOMMENDED MAP</div>
            <div style={{ fontSize: T.fs5, color: T.gold, fontWeight: "bold", fontFamily: T.sans, letterSpacing: 1, marginBottom: 4 }}>{quickTopMap.mapName}</div>
            <div style={{ fontSize: T.fs2, color: T.textDim, marginBottom: 10 }}>{quickTopMap.totalTasks} task{quickTopMap.totalTasks !== 1 ? "s" : ""} · {quickTopMap.totalIncomplete} objective{quickTopMap.totalIncomplete !== 1 ? "s" : ""} remaining</div>

            <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
              {[{n:1,label:"QUICK"},{n:2,label:"STANDARD"},{n:3,label:"LONG"}].map(o => (
                <button key={o.n} onClick={() => setTasksPerPerson(o.n)} style={{ flex: 1, background: tasksPerPerson === o.n ? T.gold + "22" : "transparent", border: `1px solid ${tasksPerPerson === o.n ? T.gold : T.border}`, color: tasksPerPerson === o.n ? T.gold : T.textDim, padding: "6px 4px", fontSize: T.fs2, fontFamily: T.sans, cursor: "pointer", letterSpacing: 1, textAlign: "center" }}>{o.n} {o.label}</button>
              ))}
            </div>

            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 6 }}>PRIORITY TASKS:</div>
            {quickTaskDetails.map((t, i) => (
              <div key={i} style={{ background: T.gold + "11", border: `1px solid ${T.gold}33`, borderLeft: `2px solid ${T.gold}`, padding: "8px 10px", marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: T.fs3, color: T.textBright }}>★ {t.name}</span>
                <span style={{ fontSize: T.fs2, color: T.textDim }}>{t.trader}</span>
              </div>
            ))}

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={handleQuickGo} style={{ flex: 2, background: T.gold, color: T.bg, border: "none", padding: "12px 0", fontSize: T.fs4, fontFamily: T.sans, fontWeight: "bold", letterSpacing: 1.5, cursor: "pointer" }}>▶ GO</button>
              <button onClick={handleCustomize} style={{ flex: 1, background: "transparent", color: T.textDim, border: `1px solid ${T.border}`, padding: "12px 0", fontSize: T.fs3, fontFamily: T.sans, letterSpacing: 1, cursor: "pointer" }}>✎ CUSTOMIZE</button>
            </div>
          </div>
        ) : (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 20, textAlign: "center" }}>
            <div style={{ fontSize: T.fs2, color: T.textDim, marginBottom: 8 }}>No incomplete tasks found.</div>
            <div style={{ fontSize: T.fs3, color: T.textDim }}>Add tasks in <span style={{ color: T.gold }}>My Profile → Tasks</span> to get a recommendation.</div>
            <button onClick={() => setPlannerView("full")} style={{ marginTop: 14, background: "transparent", color: T.textDim, border: `1px solid ${T.border}`, padding: "10px 20px", fontSize: T.fs3, fontFamily: T.sans, letterSpacing: 1, cursor: "pointer" }}>✎ OPEN FULL PLANNER</button>
          </div>
        )}

        {/* Pick any map */}
        {apiMaps && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 6 }}>OR PICK A MAP:</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 5 }}>
              {apiMaps.map(m => {
                const rec = quickRec.find(r => r.mapId === m.id);
                const taskCount = rec ? rec.totalTasks : 0;
                const isTop = quickTopMap && quickTopMap.mapId === m.id;
                return (
                  <button key={m.id} onClick={() => {
                    setSelectedMapId(m.id);
                    setFaction("pmc");
                    setRouteMode("tasks");
                    const qIds = new Set([myProfile.id]);
                    if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
                    setActiveIds(qIds);
                    setPriorityTasks(computeQuickTasks(allProfiles, m.id, apiTasks, tasksPerPerson));
                    setExtractChoices({});
                    setQuickGenPending(true);
                  }} style={{ background: isTop ? T.gold + "15" : "#181818", border: `1px solid ${isTop ? T.gold + "66" : T.border}`, color: isTop ? T.gold : T.textDim, padding: "8px 4px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textAlign: "center", textTransform: "uppercase" }}>
                    {m.name}
                    {taskCount > 0 && <div style={{ fontSize: T.fs2, color: T.gold, marginTop: 2 }}>{taskCount} task{taskCount !== 1 ? "s" : ""}</div>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Loot Run section */}
        {apiMaps && (() => {
          // Find best loot map (most loot points)
          let bestLootId = null, bestLootCount = 0;
          apiMaps.forEach(m => {
            const count = EMAPS.find(e => e.id === m.normalizedName)?.lootPoints?.length || 0;
            if (count > bestLootCount) { bestLootCount = count; bestLootId = m.id; }
          });
          // Find hideout-recommended map if target is set
          let hideoutLootId = null;
          if (hideoutTarget && apiHideout) {
            const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
            const level = station?.levels.find(l => l.level === hideoutTarget.level);
            if (level) {
              const neededItems = level.itemRequirements.filter(r => r.item.name !== "Roubles").map(r => ({ id: r.item.id, name: r.item.name, shortName: r.item.shortName, count: r.count }));
              const itemRanked = computeItemRecommendation(neededItems, apiMaps);
              hideoutLootId = itemRanked[0]?.mapId || null;
            }
          }
          return (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: T.fs2, color: T.purple, letterSpacing: 1, marginBottom: 8 }}>◈ LOOT RUN<Tip text="Pick a map to run a loot route — hits all key loot spots. Use CUSTOMIZE in the full planner to filter by hideout or equipment needs." /></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 5 }}>
                {apiMaps.map(m => {
                  const emapData = EMAPS.find(e => e.id === m.normalizedName);
                  const lootCount = emapData?.lootPoints?.length || 0;
                  const isTopLoot = m.id === bestLootId;
                  const isHideoutRec = m.id === hideoutLootId && hideoutLootId !== bestLootId;
                  const accent = isTopLoot ? T.purple : isHideoutRec ? T.cyan : null;
                  return (
                    <button key={m.id} onClick={() => {
                      setSelectedMapId(m.id);
                      setFaction("pmc");
                      setRouteMode("loot");
                      setLootSubMode("all");
                      const qIds = new Set([myProfile.id]);
                      if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
                      setActiveIds(qIds);
                      setExtractChoices({});
                      setQuickGenPending(true);
                    }} style={{ background: accent ? accent + "15" : "#181818", border: `1px solid ${accent ? accent + "66" : T.purple + "33"}`, color: accent || T.textDim, padding: "8px 4px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textAlign: "center", textTransform: "uppercase" }}>
                      {m.name}
                      {isTopLoot && <div style={{ fontSize: 14, color: T.purple, marginTop: 2 }}>★ BEST LOOT</div>}
                      {isHideoutRec && <div style={{ fontSize: 14, color: T.cyan, marginTop: 2 }}>◈ HIDEOUT</div>}
                      {!isTopLoot && !isHideoutRec && lootCount > 0 && <div style={{ fontSize: 14, color: T.purple + "66", marginTop: 2 }}>{lootCount} spot{lootCount !== 1 ? "s" : ""}</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Hideout Item Finder */}
        {apiHideout && apiMaps && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, color: T.cyan, letterSpacing: 1, marginBottom: 8 }}>◈ FIND HIDEOUT ITEM<Tip text="Pick a hideout station, level, and specific item. We'll find the best map to look for it and generate a loot run." /></div>
            <div style={{ background: T.surface, border: `1px solid ${T.cyan}33`, padding: 10 }}>
              {/* Station picker */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: qhStation ? 8 : 0 }}>
                {apiHideout.filter(s => s.levels.length > 0).sort((a, b) => a.name.localeCompare(b.name)).map(s => {
                  const curLv = (hideoutLevels || {})[s.id] || 0;
                  const maxLv = Math.max(...s.levels.map(l => l.level));
                  const isMaxed = curLv >= maxLv;
                  const isSel = qhStation === s.id;
                  const isTarget = hideoutTarget?.stationId === s.id;
                  return (
                    <button key={s.id} onClick={() => { setQhStation(isSel ? null : s.id); setQhLevel(null); setQhItem(null); }}
                      style={{ display: "flex", alignItems: "center", gap: 4, background: isSel ? T.cyan + "22" : isTarget ? T.orange + "18" : "transparent", border: `1px solid ${isSel ? T.cyan : isTarget ? T.orange : isMaxed ? T.successBorder : T.border}`, color: isSel ? T.cyan : isTarget ? T.orange : isMaxed ? T.success : T.textDim, padding: "4px 8px", fontSize: 14, fontFamily: T.sans, cursor: "pointer", opacity: isMaxed && !isTarget ? 0.6 : 1 }}>
                      {isTarget && !isSel ? "◈ " : ""}{s.name}
                      <span style={{ fontSize: 11, color: isMaxed ? T.success : isTarget && !isSel ? T.orange : isSel ? T.cyan : T.textDim, background: isMaxed ? T.successBorder + "44" : isSel ? T.cyan + "22" : "#ffffff08", padding: "1px 4px", borderRadius: 2 }}>{isMaxed ? "MAX" : `Lv${curLv}`}</span>
                    </button>
                  );
                })}
              </div>
              {/* Level picker */}
              {qhStation && (() => {
                const station = apiHideout.find(s => s.id === qhStation);
                if (!station) return null;
                return (
                  <>
                    {(() => { const curLv = (hideoutLevels || {})[qhStation] || 0; return (
                    <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: qhLevel ? 8 : 0 }}>
                      <span style={{ fontSize: 13, color: T.textDim, marginRight: 2 }}>Your level: <span style={{ color: T.cyan }}>{curLv}</span></span>
                      {station.levels.map(l => {
                        const isBuilt = l.level <= curLv;
                        const isNext = l.level === curLv + 1;
                        const isSel = qhLevel === l.level;
                        const isTargetLv = hideoutTarget?.stationId === qhStation && hideoutTarget?.level === l.level;
                        return (
                          <button key={l.level} onClick={() => { if (isBuilt) return; setQhLevel(isSel ? null : l.level); setQhItem(null); }}
                            style={{ background: isSel ? T.cyan + "22" : isTargetLv ? T.orange + "22" : isBuilt ? T.successBorder + "33" : isNext ? T.cyan + "0a" : "transparent", border: `1px solid ${isSel ? T.cyan : isTargetLv ? T.orange : isBuilt ? T.successBorder : isNext ? T.cyan + "55" : T.border}`, color: isSel ? T.cyan : isTargetLv ? T.orange : isBuilt ? T.success : isNext ? T.cyan : T.textDim, padding: "4px 10px", fontSize: T.fs2, fontFamily: T.sans, cursor: isBuilt ? "default" : "pointer", opacity: isBuilt ? 0.5 : 1, fontWeight: isNext || isTargetLv ? "bold" : "normal" }}>{isBuilt ? "✓ " : isTargetLv ? "◈ " : ""}Lv {l.level}</button>
                        );
                      })}
                    </div>
                    ); })()}
                    {/* Item picker */}
                    {qhLevel && (() => {
                      const level = station.levels.find(l => l.level === qhLevel);
                      const items = (level?.itemRequirements || []).filter(r => r.item.name !== "Roubles");
                      if (!items.length) return <div style={{ fontSize: T.fs2, color: T.textDim }}>No items needed for this level.</div>;
                      return (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {items.map(r => {
                            const isSel = qhItem?.id === r.item.id;
                            return (
                              <button key={r.item.id} onClick={() => setQhItem(isSel ? null : { id: r.item.id, name: r.item.name, shortName: r.item.shortName, count: r.count })}
                                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: isSel ? T.cyan + "22" : "transparent", border: `1px solid ${isSel ? T.cyan : T.border}`, padding: "6px 10px", cursor: "pointer", textAlign: "left" }}>
                                <span style={{ fontSize: T.fs3, color: isSel ? T.cyan : T.textBright, fontFamily: T.sans }}>{isSel ? "★ " : ""}{r.item.name}</span>
                                <span style={{ fontSize: T.fs2, color: isSel ? T.cyan : T.textDim, fontFamily: T.mono }}>×{r.count}</span>
                              </button>
                            );
                          })}
                          {qhItem && (() => {
                            const ranked = computeItemRecommendation([qhItem], apiMaps);
                            const top3 = ranked.slice(0, 3);
                            if (!top3.length) return null;
                            const topScore = top3[0].score;
                            const itemLabel = qhItem.shortName || qhItem.name.split(" ").slice(0, 2).join(" ");
                            return (
                              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={{ fontSize: 13, color: T.textDim, letterSpacing: 1, marginBottom: 2 }}>BEST MAPS FOR {itemLabel.toUpperCase()}</div>
                                {top3.map((m, i) => {
                                  const pct = topScore > 0 ? Math.round((m.score / topScore) * 100) : 0;
                                  return (
                                    <button key={m.mapId} onClick={() => {
                                      setSelectedMapId(m.mapId);
                                      setFaction("pmc");
                                      setRouteMode("loot");
                                      setLootSubMode("equipment");
                                      saveTargetEquipment([{ ...qhItem, categories: itemNameToCategories(qhItem.name) }]);
                                      const qIds = new Set([myProfile.id]);
                                      if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
                                      setActiveIds(qIds);
                                      setExtractChoices({});
                                      setQuickGenPending(true);
                                    }} style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", background: "transparent", border: `1px solid ${i === 0 ? T.cyan : T.border}`, padding: "8px 10px", cursor: "pointer", textAlign: "left", overflow: "hidden" }}>
                                      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: i === 0 ? T.cyan + "15" : T.cyan + "08", transition: "width 0.3s" }} />
                                      <span style={{ position: "relative", display: "flex", alignItems: "center", gap: 6, fontSize: T.fs3, color: i === 0 ? T.cyan : T.textBright, fontFamily: T.sans, fontWeight: i === 0 ? "bold" : "normal" }}>
                                        <span style={{ fontSize: 13, color: i === 0 ? T.cyan : T.textDim, minWidth: 16 }}>{i === 0 ? "★" : `#${i + 1}`}</span>
                                        {m.mapName}
                                      </span>
                                      <span style={{ position: "relative", fontSize: 13, color: i === 0 ? T.cyan : T.textDim, fontFamily: T.mono }}>{m.totalContainers} containers · {pct}%</span>
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* Quick Item Search */}
        {apiMaps && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: T.fs2, color: T.orange, letterSpacing: 1, marginBottom: 8 }}>⚡ FIND ANY ITEM<Tip text="Search for any item by name. We'll find the best map to look for it and generate a loot run." /></div>
            <div style={{ display: "flex", gap: 6 }}>
              <input value={qiSearch} onChange={e => setQiSearch(e.target.value)} placeholder="Search item name..."
                onKeyDown={e => {
                  if (e.key === "Enter" && qiSearch.length >= 2) {
                    setQiSearching(true);
                    fetchAPI(`{items(lang:en,name:"${qiSearch.replace(/"/g, '\\"')}"){id name shortName categories{name}}}`).then(d => {
                      setQiResults((d?.items || []).slice(0, 8));
                      setQiSearching(false);
                    }).catch(() => { setQiResults([]); setQiSearching(false); });
                  }
                }}
                style={{ ...T.input, flex: 1, fontSize: T.fs2 }} />
              <button onClick={() => {
                if (qiSearch.length < 2) return;
                setQiSearching(true);
                fetchAPI(`{items(lang:en,name:"${qiSearch.replace(/"/g, '\\"')}"){id name shortName categories{name}}}`).then(d => {
                  setQiResults((d?.items || []).slice(0, 8));
                  setQiSearching(false);
                }).catch(() => { setQiResults([]); setQiSearching(false); });
              }} style={{ background: qiSearch.length >= 2 ? T.orange + "22" : "transparent", border: `1px solid ${qiSearch.length >= 2 ? T.orange : T.border}`, color: qiSearch.length >= 2 ? T.orange : T.textDim, padding: "8px 14px", fontSize: T.fs2, fontFamily: T.sans, cursor: qiSearch.length >= 2 ? "pointer" : "default" }}>SEARCH</button>
            </div>
            {qiSearching && <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 6 }}>Searching...</div>}
            {qiResults && !qiSearching && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                {qiResults.length === 0 && <div style={{ fontSize: T.fs2, color: T.textDim }}>No items found.</div>}
                {qiResults.map(item => {
                  const ranked = computeItemRecommendation([{ id: item.id, name: item.name, shortName: item.shortName, count: 1 }], apiMaps);
                  const bestMap = ranked[0];
                  return (
                    <button key={item.id} onClick={() => {
                      if (!bestMap) return;
                      setSelectedMapId(bestMap.mapId);
                      setFaction("pmc");
                      setRouteMode("loot");
                      setLootSubMode("equipment");
                      saveTargetEquipment([{ id: item.id, name: item.name, shortName: item.shortName, categories: item.categories, count: 1 }]);
                      const qIds = new Set([myProfile.id]);
                      if (room.status === "connected") room.roomSquad.forEach(p => qIds.add(p.id));
                      setActiveIds(qIds);
                      setExtractChoices({});
                      setQuickGenPending(true);
                    }} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: T.surface, border: `1px solid ${T.border}`, padding: "8px 10px", cursor: "pointer", textAlign: "left" }}>
                      <span style={{ fontSize: T.fs3, color: T.textBright, fontFamily: T.sans }}>{item.name}</span>
                      {bestMap && <span style={{ fontSize: 14, color: T.orange, fontFamily: T.sans, whiteSpace: "nowrap", marginLeft: 8 }}>→ {bestMap.mapName}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // ─── Full Planner view ───
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <SL c={<>SQUAD RAID PLANNER<Tip text="Plan your squad's raid here. Select a map, import your teammates' codes, choose who's running, pick priority tasks and extracts, then generate an optimized route." /></>} />
          <button onClick={() => setPlannerView("quick")} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "4px 10px", fontSize: T.fs2, fontFamily: T.sans, cursor: "pointer", letterSpacing: 1 }}>← QUICK START</button>
        </div>
        {loading && <div style={{ fontSize: T.fs3, color: T.textDim, marginBottom: 6 }}>Loading maps from tarkov.dev...</div>}
        {apiError && <div style={{ fontSize: T.fs3, color: T.error, marginBottom: 6 }}>tarkov.dev unavailable — check connection</div>}
        {apiMaps && (() => {
          const profiles = activeIds.size > 0 ? allProfiles.filter(p => activeIds.has(p.id)) : allProfiles;
          const taskRanked = computeMapRecommendation(profiles, apiTasks);
          const taskTopId = taskRanked[0] ? taskRanked[0].mapId : null;
          let hideoutTopId = null;
          if (hideoutTarget && apiHideout) {
            const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
            const level = station?.levels.find(l => l.level === hideoutTarget.level);
            if (level) {
              const neededItems = level.itemRequirements.filter(r => r.item.name !== "Roubles").map(r => ({ id: r.item.id, name: r.item.name, shortName: r.item.shortName, count: r.count }));
              const itemRanked = computeItemRecommendation(neededItems, apiMaps);
              hideoutTopId = itemRanked[0] ? itemRanked[0].mapId : null;
            }
          }
          return (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 6, paddingBottom: 6 }}>
              {apiMaps.map(m => {
                const isSel = selectedMapId === m.id;
                const isTaskRec = taskTopId === m.id && !isSel;
                const isHideoutRec = hideoutTopId === m.id && hideoutTopId !== taskTopId && !isSel;
                const bg = isSel ? T.gold + "33" : isTaskRec ? T.gold + "11" : isHideoutRec ? T.cyan + "11" : "#181818";
                const border = isSel ? T.gold : isTaskRec ? T.gold + "66" : isHideoutRec ? T.cyan + "66" : T.border;
                const color = isSel ? T.gold : isTaskRec ? T.gold : isHideoutRec ? T.cyan : T.textDim;
                return (
                  <button key={m.id} onClick={() => setSelectedMapId(m.id)} style={{ background: bg, border: `2px solid ${border}`, color, padding: "10px 8px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center", fontWeight: isSel ? "bold" : "normal", transition: "background 0.15s, border-color 0.15s", position: "relative", wordBreak: "break-word", lineHeight: 1.3 }}>
                    {m.name}
                    {isTaskRec && <div style={{ fontSize: T.fs2, color: T.gold, letterSpacing: 1, marginTop: 4 }}>★ TASKS</div>}
                    {isHideoutRec && <div style={{ fontSize: T.fs2, color: T.cyan, letterSpacing: 1, marginTop: 4 }}>◈ HIDEOUT</div>}
                  </button>
                );
              })}
            </div>
          );
        })()}
        {apiTasks && (
          <MapRecommendation
            allProfiles={allProfiles}
            activeIds={activeIds}
            apiTasks={apiTasks}
            apiMaps={apiMaps}
            onSelectMap={setSelectedMapId}
            selectedMapId={selectedMapId}
            hideoutTarget={hideoutTarget}
            apiHideout={apiHideout}
          />
        )}
        {selectedMapId && (
          <>
            <div style={{ display: "flex", marginTop: 8, border: `1px solid ${T.border}` }}>
              {["pmc", "scav"].map(f => <button key={f} onClick={() => setFaction(f)} style={{ flex: 1, background: faction === f ? (f === "pmc" ? T.blueBg : T.successBg) : "transparent", color: faction === f ? (f === "pmc" ? T.cyan : T.success) : T.textDim, border: "none", padding: 6, fontSize: T.fs3, letterSpacing: 1.5, cursor: "pointer", textTransform: "uppercase", fontFamily: T.sans, fontWeight: "bold" }}>{f === "pmc" ? "▲ PMC" : "◆ SCAV"}</button>)}
            </div>
            <div style={{ display: "flex", marginTop: 6, border: `1px solid ${T.border}` }}>
              {[{id:"tasks",label:"★ TASKS",color:T.gold},{id:"loot",label:"◈ LOOT RUN",color:T.purple}].map(m => (
                <button key={m.id} onClick={() => setRouteMode(m.id)} style={{ flex: 1, background: routeMode === m.id ? m.color + "22" : "transparent", color: routeMode === m.id ? m.color : T.textDim, border: "none", padding: 6, fontSize: T.fs3, letterSpacing: 1, cursor: "pointer", textTransform: "uppercase", fontFamily: T.sans, fontWeight: "bold" }}>{m.label}</button>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {/* Collapsible Squad Section */}
        <button onClick={() => setSquadExpanded(!squadExpanded)} style={{ width: "100%", background: squadExpanded ? T.successBg : T.surface, border: `1px solid ${room.status === "connected" ? T.successBorder : T.border}`, padding: "10px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: T.sans, marginBottom: squadExpanded ? 0 : 14, borderBottom: squadExpanded ? "none" : undefined }}>
          <span style={{ color: room.status === "connected" ? T.success : T.textDim, letterSpacing: 1, fontSize: T.fs1 }}>◈ SQUAD {room.status === "connected" ? `● ${room.roomCode} (${room.roomSquad.length + 1})` : ""}</span>
          <span style={{ color: T.textDim, fontSize: T.fs2 }}>{squadExpanded ? "▴" : "▾"}</span>
        </button>
        {(squadExpanded || room.status === "connected") && <>
        <SL c={<>SQUAD ROOM<Tip text="Create a room and share the code with your squad. Everyone joins with the code and profiles sync automatically — no more copy-pasting share codes in Discord." /></>} s={{ marginTop: 8 }} />
        <div style={{ background: T.surface, border: `1px solid ${room.status === "connected" ? T.successBorder : T.border}`, padding: 10, marginBottom: 14 }}>
          {room.status === "connected" ? (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: T.fs2, color: T.success, letterSpacing: 1, marginBottom: 2 }}>● CONNECTED</div>
                  <div style={{ fontSize: T.fs4, color: T.textBright, fontWeight: "bold", fontFamily: T.mono, letterSpacing: 1.5 }}>{room.roomCode}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: T.fs2, color: T.textDim }}>{room.roomSquad.length + 1} in room</div>
                  <button onClick={room.leaveRoom} style={{ background: "transparent", border: `1px solid ${T.errorBorder}`, color: T.error, padding: "6px 12px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, marginTop: 4 }}>LEAVE</button>
                </div>
              </div>
              {/* Leader controls */}
              <div style={{ background: room.hasLeader ? T.successBg : "#181818", border: `1px solid ${room.hasLeader ? T.successBorder : T.border}`, padding: 8, marginBottom: 8 }}>
                {room.hasLeader ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.orange, marginBottom: 2 }}>★ SQUAD LEADER</div>
                      <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold" }}>
                        {room.isLeader ? "You are leading" : (() => { const leader = room.roomSquad.find(m => m.deviceId === room.leaderId); return leader ? leader.name : "..."; })()}
                      </div>
                      {!room.isLeader && <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 2 }}>Leader picks map, tasks & extracts. Route syncs to you.</div>}
                    </div>
                    {room.isLeader && <button onClick={room.releaseLeader} style={{ background: "transparent", border: `1px solid ${T.orangeBorder}`, color: T.orange, padding: "6px 12px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>STEP DOWN</button>}
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: T.fs3, color: T.textDim }}>No squad leader — everyone plans independently.</div>
                    <button onClick={room.claimLeader} style={{ background: T.orange + "22", border: `1px solid ${T.orange}`, color: T.orange, padding: "6px 12px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, whiteSpace: "nowrap" }}>★ LEAD RAID</button>
                  </div>
                )}
              </div>
              <div style={{ fontSize: T.fs3, color: T.textDim }}>Share this code with your squad. Profiles sync live.</div>
              {room.roomSquad.length > 0 && (
                <div style={{ marginTop: 8, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                  {room.roomSquad.map(p => (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                      <span style={{ fontSize: T.fs3, color: p.color, fontWeight: "bold" }}>{p.name}</span>
                      <span style={{ fontSize: T.fs2, color: T.textDim }}>{p.tasks.length} tasks</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.6, marginBottom: 10 }}>Create a room or join one with a code. Profiles sync automatically.</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button onClick={room.createRoom} disabled={room.status === "creating"} style={{ flex: 1, background: T.successBg, border: `1px solid ${T.successBorder}`, color: T.success, padding: "10px 0", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>{room.status === "creating" ? "CREATING..." : "◈ CREATE ROOM"}</button>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="ALPHA-123"
                  style={{ flex: 1, background: "#181818", border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box", letterSpacing: 1, textTransform: "uppercase" }} />
                <button onClick={() => room.joinRoom(joinCode)} disabled={!joinCode.trim() || room.status === "joining"} style={{ background: joinCode.trim() ? T.blueBg : "transparent", border: `1px solid ${joinCode.trim() ? T.blueBorder : T.border}`, color: joinCode.trim() ? T.blue : T.textDim, padding: "8px 14px", fontSize: T.fs3, cursor: joinCode.trim() ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1 }}>{room.status === "joining" ? "..." : "JOIN"}</button>
              </div>
              {room.error && <div style={{ fontSize: T.fs3, color: T.error, marginTop: 6 }}>{room.error}</div>}
            </>
          )}
        </div>

        {/* Import squadmate (fallback) */}
        <SL c={<>IMPORT SQUADMATE CODE<Tip step="FALLBACK" text="If a squadmate can't join the room, they can still share their code the old way — copy from My Profile, paste here." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 10, marginBottom: 14 }}>
          <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.6, marginBottom: 8 }}>Ask each squadmate to copy their code from My Profile and paste it in Discord.</div>
          <textarea value={importCode} onChange={e => setImportCode(e.target.value)} placeholder="Paste squadmate's TG2:... code here"
            style={{ width: "100%", background: "#181818", border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box", resize: "none", height: 52, lineHeight: 1.4, marginBottom: 8 }} />
          {importError && <div style={{ fontSize: T.fs3, color: T.error, marginBottom: 6 }}>{importError}</div>}
          <button onClick={handleImport} disabled={!importCode.trim()} style={{ width: "100%", background: importCode.trim() ? T.blueBg : "transparent", border: `1px solid ${importCode.trim() ? T.blueBorder : T.border}`, color: importCode.trim() ? T.blue : T.textDim, padding: "10px 0", fontSize: T.fs2, cursor: importCode.trim() ? "pointer" : "default", fontFamily: T.sans, letterSpacing: 1, textTransform: "uppercase" }}>↓ IMPORT SQUADMATE</button>
        </div>
        </>}

        {/* Players */}
        <SL c={<>SELECT WHO'S RUNNING THIS RAID<Tip step="STEP 2" text="Check the box next to each player joining this raid. In Tasks mode, pick a priority task per player. In Loot Run mode, the route hits all key loot spots on the map." /></>} />
        {allProfiles.map((p, idx) => {
          const isMe = idx === 0;
          const isActive = activeIds.has(p.id);
          const mapTasks = (p.tasks || []).filter(t => apiTasks?.find(at => at.id === t.taskId)?.map?.id === selectedMapId);
          return (
            <div key={p.id} style={{ background: isActive ? p.color + "10" : T.surface, border: `1px solid ${isActive ? p.color : (isMe ? T.borderBright : T.border)}`, borderLeft: `2px solid ${p.color}`, padding: 10, marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isActive && selectedMapId && routeMode === "tasks" ? 8 : 0 }}>
                <button onClick={() => toggleActive(p.id)} style={{ width: 20, height: 20, background: isActive ? p.color : "transparent", border: `1px solid ${p.color}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isActive ? T.bg : T.textDim, fontSize: T.fs3, flexShrink: 0 }}>{isActive ? "✓" : ""}</button>
                <div style={{ flex: 1 }}>
                  <div style={{ color: p.color, fontSize: T.fs3, fontWeight: "bold" }}>{p.name || "(no name)"}{isMe && <span style={{ fontSize: T.fs2, color: T.textDim, fontWeight: "normal", marginLeft: 5 }}>YOU</span>}</div>
                  {!isMe && <div style={{ fontSize: T.fs2, color: p.isRoomMember ? T.success : T.textDim }}>{p.isRoomMember ? "● Live synced" : `Imported ${new Date(p.importedAt).toLocaleDateString()}`} · {p.tasks?.length || 0} tasks</div>}
                </div>
                <Badge label={`${p.tasks?.length || 0} tasks`} color={p.color} />
                {!isMe && !p.isRoomMember && <button onClick={() => { saveImportedSquad(importedSquad.filter(x => x.id !== p.id)); setActiveIds(prev => { const n = new Set(prev); n.delete(p.id); return n; }); }} style={{ background: "transparent", border: "none", color: T.errorBorder, cursor: "pointer", fontSize: T.fs4, padding: "0 2px" }}>×</button>}
              </div>
              {isActive && selectedMapId && routeMode === "tasks" && (
                <>
                  <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 5 }}>PRIORITY TASKS THIS RAID (up to {tasksPerPerson}):</div>
                  {mapTasks.length === 0 ? (
                    <div style={{ fontSize: T.fs3, color: T.textDim }}>No tasks for this map{isMe ? " — add them in My Profile." : "."}</div>
                  ) : mapTasks.map(t => {
                    const at = apiTasks?.find(x => x.id === t.taskId); if (!at) return null;
                    const selected = priorityTasks[p.id] || [];
                    const isPri = selected.includes(t.taskId);
                    const atLimit = selected.length >= tasksPerPerson && !isPri;
                    return <button key={t.taskId} onClick={() => {
                      if (isPri) { setPriorityTasks(pt => ({ ...pt, [p.id]: selected.filter(id => id !== t.taskId) })); }
                      else if (!atLimit) { setPriorityTasks(pt => ({ ...pt, [p.id]: [...selected, t.taskId] })); }
                    }} style={{ width: "100%", background: isPri ? p.color + "22" : "transparent", border: `1px solid ${isPri ? p.color : T.border}`, color: atLimit ? T.border : (isPri ? p.color : T.textDim), padding: "6px 8px", textAlign: "left", cursor: atLimit ? "default" : "pointer", fontFamily: T.sans, fontSize: T.fs3, marginBottom: 4, opacity: atLimit ? 0.5 : 1 }}>{isPri ? "★ " : ""}{at.name}</button>;
                  })}
                </>
              )}
            </div>
          );
        })}

        {importedSquad.length === 0 && <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: "14px 10px", textAlign: "center", marginBottom: 12 }}><div style={{ fontSize: T.fs2, color: T.textDim }}>No squadmates imported yet.<br />Paste their codes above.</div></div>}

        {/* ── LOOT POINTS PREVIEW (loot mode) ── */}
        {routeMode === "loot" && selectedMapId && emap && (() => {
          const filteredLP = getFilteredLootPoints(emap.lootPoints);
          const hasHideout = hideoutTarget && apiHideout;
          const hasEquip = targetEquipment.length > 0;
          return (
          <div style={{ marginTop: 8, marginBottom: 14 }}>
            {/* Sub-mode selector */}
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {[
                {id:"all",label:"ALL LOOT",color:T.purple},
                {id:"hideout",label:"HIDEOUT",color:T.cyan,disabled:!hasHideout},
                {id:"equipment",label:"EQUIPMENT",color:T.orange},
              ].map(m => (
                <button key={m.id} onClick={() => !m.disabled && setLootSubMode(m.id)} style={{
                  flex: 1, padding: "6px 4px", fontSize: T.fs2, letterSpacing: 1, fontFamily: T.sans,
                  background: lootSubMode === m.id ? m.color + "22" : "transparent",
                  border: `1px solid ${lootSubMode === m.id ? m.color : T.border}`,
                  color: m.disabled ? T.border : (lootSubMode === m.id ? m.color : T.textDim),
                  cursor: m.disabled ? "default" : "pointer", opacity: m.disabled ? 0.5 : 1,
                }}>{m.label}</button>
              ))}
            </div>

            {/* Hideout mode info */}
            {lootSubMode === "hideout" && !hasHideout && (
              <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 10, marginBottom: 8, textAlign: "center" }}>
                <div style={{ fontSize: T.fs3, color: T.textDim }}>Set a hideout target in My Profile → Hideout first.</div>
              </div>
            )}
            {lootSubMode === "hideout" && hasHideout && (() => {
              const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
              const level = station?.levels.find(l => l.level === hideoutTarget.level);
              return station && level ? (
                <div style={{ background: T.cyanBg, border: `1px solid ${T.cyanBorder}`, borderLeft: `2px solid ${T.cyan}`, padding: "8px 10px", marginBottom: 8 }}>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.cyan, marginBottom: 3 }}>TARGETING ITEMS FOR:</div>
                  <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold", marginBottom: 4 }}>{station.name} → Level {hideoutTarget.level}</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {level.itemRequirements.filter(r => r.item.name !== "Roubles").map((r, i) => (
                      <div key={i} style={{ fontSize: T.fs2, color: T.cyan, background: T.cyan + "15", border: `1px solid ${T.cyan}33`, padding: "2px 6px" }}>
                        {r.item.shortName || r.item.name} ×{r.count}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}

            {/* Equipment mode — search + selected items */}
            {lootSubMode === "equipment" && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ background: T.orangeBg, border: `1px solid ${T.orangeBorder}`, borderLeft: `2px solid ${T.orange}`, padding: "8px 10px", marginBottom: 8 }}>
                  <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.orange, marginBottom: 4 }}>TARGET EQUIPMENT<Tip text="Search for any item — weapons, armor, barter goods, keys, etc. The route will only visit locations likely to contain your targeted items." /></div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input value={equipSearch} onChange={e => setEquipSearch(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && searchEquipment(equipSearch)}
                      placeholder="Search items (e.g. AK-74, Slick, GPU)..."
                      style={{ flex: 1, background: "#181818", border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "6px 8px", fontSize: T.fs2, fontFamily: T.mono, outline: "none", boxSizing: "border-box" }} />
                    <button onClick={() => searchEquipment(equipSearch)}
                      style={{ background: T.orange + "22", border: `1px solid ${T.orange}`, color: T.orange, padding: "6px 10px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1, flexShrink: 0 }}>SEARCH</button>
                  </div>
                </div>

                {/* Search results */}
                {equipSearching && <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", padding: 8 }}>Searching tarkov.dev...</div>}
                {equipResults && !equipSearching && (
                  <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
                    {equipResults.length === 0 && <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", padding: 8 }}>No items found.</div>}
                    {equipResults.map(item => {
                      const added = targetEquipment.some(e => e.id === item.id);
                      return (
                        <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", marginBottom: 2, background: added ? T.orange + "15" : T.surface, border: `1px solid ${added ? T.orange + "44" : T.border}` }}>
                          <div>
                            <div style={{ fontSize: T.fs2, color: T.textBright }}>{item.name}</div>
                            <div style={{ fontSize: T.fs1, color: T.textDim }}>{item.categories?.map(c => c.name).filter(n => n !== "Item" && n !== "Compound item").slice(0, 3).join(" · ")}</div>
                          </div>
                          <button onClick={() => {
                            if (added) saveTargetEquipment(targetEquipment.filter(e => e.id !== item.id));
                            else saveTargetEquipment([...targetEquipment, { id: item.id, name: item.name, shortName: item.shortName, categories: item.categories }]);
                          }} style={{ background: added ? T.errorBg : "transparent", border: `1px solid ${added ? T.errorBorder : T.orange}`, color: added ? T.error : T.orange, padding: "4px 8px", fontSize: T.fs3, cursor: "pointer", fontFamily: T.sans, flexShrink: 0 }}>
                            {added ? "✕" : "+ ADD"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Selected equipment */}
                {targetEquipment.length > 0 && (
                  <div>
                    <div style={{ fontSize: T.fs2, letterSpacing: 1, color: T.orange, marginBottom: 4 }}>TARGETING {targetEquipment.length} ITEM{targetEquipment.length !== 1 ? "S" : ""}:</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
                      {targetEquipment.map(item => (
                        <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 4, background: T.orange + "15", border: `1px solid ${T.orange}33`, padding: "3px 6px" }}>
                          <span style={{ fontSize: T.fs3, color: T.orange }}>{item.shortName || item.name}</span>
                          <button onClick={() => saveTargetEquipment(targetEquipment.filter(e => e.id !== item.id))}
                            style={{ background: "transparent", border: "none", color: T.errorBorder, cursor: "pointer", fontSize: T.fs4, padding: 0 }}>×</button>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => saveTargetEquipment([])}
                      style={{ background: "transparent", border: `1px solid ${T.errorBorder}`, color: T.error, padding: "3px 8px", fontSize: T.fs1, cursor: "pointer", fontFamily: T.sans, letterSpacing: 1 }}>CLEAR ALL</button>
                  </div>
                )}
                {targetEquipment.length === 0 && !equipResults && (
                  <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", padding: 8 }}>Search and add items you want to find in raid.</div>
                )}
              </div>
            )}

            <div style={{ background: T.purpleBg, border: `1px solid ${T.purpleBorder}`, borderLeft: `2px solid ${T.purple}`, padding: "10px 12px", marginBottom: 10 }}>
              <div style={{ fontSize: T.fs3, color: T.purple, letterSpacing: 1.5, marginBottom: 4 }}>◈ {lootSubMode === "hideout" ? "HIDEOUT" : lootSubMode === "equipment" ? "EQUIPMENT" : "LOOT"} RUN — {emap.name.toUpperCase()}<Tip text="ALL hits every loot spot. HIDEOUT filters to spots matching your hideout upgrade needs. EQUIPMENT filters to spots matching your targeted items." /></div>
              <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.7 }}>
                Route will hit {filteredLP.length} of {emap.lootPoints?.length || 0} loot locations{lootSubMode !== "all" ? " (filtered)" : ""}, ending at your chosen extract.
              </div>
            </div>
            {filteredLP.map((lp, i) => {
              const lc = LOOT_CONFIG[lp.type] || LOOT_CONFIG.mixed;
              return (
                <div key={i} style={{ background: lc.bg, border: `1px solid ${lc.border}`, borderLeft: `2px solid ${lc.color}`, padding: "7px 10px", marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: T.fs2, color: T.textBright, fontWeight: "bold" }}>{lc.icon} {lp.name}</div>
                    <div style={{ fontSize: T.fs1, color: lc.color, letterSpacing: 1, background: lc.border + "44", padding: "2px 6px" }}>{lc.label.toUpperCase()}</div>
                  </div>
                  <div style={{ fontSize: T.fs3, color: lc.color, marginTop: 3 }}>{lp.note}</div>
                </div>
              );
            })}
            {filteredLP.length === 0 && (
              <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 14, textAlign: "center" }}>
                <div style={{ fontSize: T.fs2, color: T.textDim }}>No matching loot locations on this map for your {lootSubMode === "hideout" ? "hideout target" : "targeted items"}.</div>
              </div>
            )}
          </div>
          );
        })()}

        {/* ── EXTRACT SELECTION ── */}
        {selectedMapId && emap && activeIds.size > 0 && (
          <div style={{ marginTop: 8, marginBottom: 14 }}>
            <div style={{ background: T.blueBg, border: `1px solid ${T.blueBorder}`, borderLeft: `2px solid ${T.blue}`, padding: "10px 12px", marginBottom: 12 }}>
              <div style={{ fontSize: T.fs3, color: T.blue, letterSpacing: 1.5, marginBottom: 4 }}>⬆ EXTRACT SELECTION<Tip step={routeMode === "tasks" ? "STEP 3" : "STEP 3"} text="Pick each player's intended extract. Special extracts (key, paracord, etc.) will ask if you have the required items. Your chosen extract becomes the final stop on the route." /></div>
              <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.7 }}>
                Extracts are only revealed when the raid loads — but you can plan ahead. Select your intended exit now. Special extracts will ask if you have required items before adding them to the route.
              </div>
            </div>
            {[...activeIds].map(pid => {
              const p = allProfiles.find(x => x.id === pid); if (!p) return null;
              return (
                <div key={pid} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: T.fs2, color: p.color, letterSpacing: 1, marginBottom: 5, fontFamily: T.sans }}>
                    {p.name.toUpperCase()}'S EXTRACT
                  </div>
                  <ExtractSelector
                    player={p}
                    mapData={emap}
                    faction={faction}
                    choice={extractChoices[pid] || null}
                    onChoice={choice => setExtractChoices(ec => ({ ...ec, [pid]: choice }))}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Tasks per person */}
        {routeMode === "tasks" && selectedMapId && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: T.fs3, color: T.textDim, letterSpacing: 1, fontFamily: T.sans, whiteSpace: "nowrap" }}>TASKS PER PERSON:</div>
            <div style={{ display: "flex", gap: 4 }}>
              {[1, 2, 3].map(n => (
                <button key={n} onClick={() => setTasksPerPerson(n)} style={{ width: 32, height: 28, background: tasksPerPerson === n ? T.gold + "22" : "transparent", border: `1px solid ${tasksPerPerson === n ? T.gold : T.border}`, color: tasksPerPerson === n ? T.gold : T.textDim, fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, fontWeight: tasksPerPerson === n ? "bold" : "normal" }}>{n}</button>
              ))}
            </div>
            <div style={{ fontSize: T.fs2, color: T.textDim }}>{tasksPerPerson === 1 ? "Quick raid" : tasksPerPerson === 2 ? "Standard raid" : "Long raid"}</div>
          </div>
        )}

        {/* Generate */}
        <button onClick={generateRoute} disabled={!canGenerate}
          style={{ width: "100%", background: canGenerate ? (routeMode === "loot" ? T.purple : T.gold) : "transparent", color: canGenerate ? T.bg : T.textDim, border: `2px solid ${canGenerate ? (routeMode === "loot" ? T.purple : T.gold) : T.border}`, padding: `${T.sp3}px 0`, fontSize: T.fs4, letterSpacing: 1.5, cursor: canGenerate ? "pointer" : "default", fontFamily: T.sans, textTransform: "uppercase", fontWeight: "bold", marginBottom: T.sp2, transition: "background 0.15s, border-color 0.15s" }}>
          ▶ {routeMode === "loot" ? (lootSubMode === "hideout" ? "GENERATE HIDEOUT RUN" : lootSubMode === "equipment" ? "GENERATE EQUIPMENT RUN" : "GENERATE LOOT RUN") : "GENERATE ROUTE"}{activeIds.size > 0 ? ` — ${activeIds.size} PLAYER${activeIds.size > 1 ? "S" : ""}` : ""}
        </button>
        {!selectedMapId && <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", fontFamily: T.sans, marginBottom: 4 }}>Select a map above to get started</div>}
        {routeMode === "tasks" && selectedMapId && activeIds.size > 0 && ![...activeIds].some(id => (priorityTasks[id] || []).length > 0) && <div style={{ fontSize: T.fs3, color: T.textDim, textAlign: "center", fontFamily: T.sans, marginBottom: 4 }}>Select a priority task for at least one active player</div>}

        <div style={{ marginTop: 12, background: T.surface, border: `1px solid ${T.blueBorder}`, borderLeft: `2px solid ${T.blueBorder}`, padding: 10 }}>
          <div style={{ fontSize: T.fs3, color: T.blue, lineHeight: 1.8 }}>{routeMode === "loot" ? "◈ Loot positions are approximate — use tarkov.dev for exact locations." : "ℹ Task data live from tarkov.dev — always current patch."}<br />Extract positions are approximate — exact locations shown on tarkov.dev.{routeMode === "tasks" && <><br />Reshare your code after completing tasks.</>}</div>
        </div>
        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}

// ─── EXTRACTS TAB ─────────────────────────────────────────────────────────
function ExtractsTab() {
  const [sel, setSel] = useState(EMAPS[0]);
  const [fac, setFac] = useState("pmc");
  const [fil, setFil] = useState("all");
  const [sv, setSv] = useState("extracts");
  const exts = fac === "pmc" ? sel.pmcExtracts : sel.scavExtracts;
  const filtered = fil === "all" ? exts : exts.filter(e => e.type === fil);
  const types = [...new Set(exts.map(e => e.type))];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px 0" }}>
        <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
          {["extracts", "keys", "roadmap"].map(v => <Btn key={v} ch={v === "keys" ? "Key Guide" : v} onClick={() => setSv(v)} active={sv === v} />)}
        </div>
        {sv === "extracts" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 4, paddingBottom: 10 }}>
            {EMAPS.map(m => <button key={m.id} onClick={() => { setSel(m); setFil("all"); }} style={{ background: sel.id === m.id ? m.color + "22" : "transparent", border: `2px solid ${sel.id === m.id ? m.color : T.border}`, color: sel.id === m.id ? m.color : T.textDim, padding: "5px 4px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center", wordBreak: "break-word" }}>{m.name}</button>)}
          </div>
          <div style={{ display: "flex", marginBottom: 10, border: `1px solid ${T.border}` }}>
            {["pmc", "scav"].map(f => <button key={f} onClick={() => { setFac(f); setFil("all"); }} style={{ flex: 1, background: fac === f ? (f === "pmc" ? T.blueBg : T.successBg) : "transparent", color: fac === f ? (f === "pmc" ? T.cyan : T.success) : T.textDim, border: "none", padding: 7, fontSize: T.fs3, letterSpacing: 1.5, cursor: "pointer", textTransform: "uppercase", fontFamily: T.sans, fontWeight: "bold" }}>{f === "pmc" ? "▲ PMC" : "◆ SCAV"}</button>)}
          </div>
        </>}
      </div>
      <div style={{ overflowY: "auto", flex: 1, padding: 14 }}>
        {sv === "roadmap" && <>
          <div style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, borderLeft: `2px solid ${T.success}`, padding: "10px 12px", marginBottom: 14, fontSize: T.fs2, color: "#7ab87a", lineHeight: 1.7 }}>⚔ PvE — Co-op extracts N/A. Difficulty = boss/Raider danger.</div>
          {["Beginner", "Intermediate", "Advanced", "Endgame"].map(tier => (
            <div key={tier} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: TC[tier], borderBottom: `1px solid ${TC[tier]}33`, paddingBottom: 5, marginBottom: 8, fontFamily: T.sans }}>{tier.toUpperCase()}</div>
              {EMAPS.filter(m => m.tier === tier).map(map => (
                <div key={map.id} onClick={() => { setSel(map); setSv("extracts"); setFil("all"); }} style={{ background: T.surface, border: `1px solid ${map.color}33`, borderLeft: `2px solid ${map.color}`, padding: 10, marginBottom: 7, cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}><div style={{ color: map.color, fontSize: T.fs3, fontWeight: "bold" }}>{map.name}</div><div style={{ fontSize: T.fs3, color: T.textDim }}>{"★".repeat(map.diff)}{"☆".repeat(5 - map.diff)}</div></div>
                  <div style={{ fontSize: T.fs2, color: T.textDim, lineHeight: 1.5, marginBottom: 5 }}>{map.desc}</div>
                  <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 5 }}>{map.bosses.map((b, i) => <div key={i} style={{ fontSize: T.fs3, color: T.errorBorder, marginBottom: 2 }}>☠ {b}</div>)}</div>
                </div>
              ))}
            </div>
          ))}
        </>}
        {sv === "keys" && <>
          <div style={{ background: T.orangeBg, border: `1px solid ${ET_CONFIG.key.border}`, borderLeft: `2px solid ${ET_CONFIG.key.color}`, padding: "10px 12px", marginBottom: 14, fontSize: T.fs2, color: ET_CONFIG.key.color, lineHeight: 1.7 }}>
            <Tip text="Quick reference for which keys to bring on each map. Includes extract keys and valuable loot room keys. Priority: HIGH = don't raid without it, MED = nice to have, LOW = situational." />
            ⚿ Keys organized by map — extract keys and high-value loot room keys. Tap a map to see its extracts.
          </div>
          {EMAPS.map(map => {
            const extractKeys = [...map.pmcExtracts, ...map.scavExtracts].filter(e => e.type === "key").map(e => ({ key: e.requireItems.join(" + "), use: `Extract: ${e.name}`, priority: "high", isExtract: true }));
            const uniqueExtractKeys = extractKeys.filter((k, i, arr) => arr.findIndex(a => a.key === k.key) === i);
            const lootKeys = MAP_KEYS[map.id] || [];
            const allKeys = [...uniqueExtractKeys, ...lootKeys];
            if (allKeys.length === 0) return null;
            const prioColor = { high: T.gold, med: T.cyan, low: T.textDim };
            const prioLabel = { high: "HIGH", med: "MED", low: "LOW" };
            return (
              <div key={map.id} style={{ marginBottom: 14 }}>
                <div onClick={() => { setSel(map); setSv("extracts"); setFil("key"); }} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", borderBottom: `1px solid ${map.color}33`, paddingBottom: 6, marginBottom: 8 }}>
                  <div style={{ color: map.color, fontSize: T.fs3, fontWeight: "bold", letterSpacing: 1 }}>{map.name.toUpperCase()}</div>
                  <div style={{ fontSize: T.fs1, color: T.textDim }}>{allKeys.length} key{allKeys.length !== 1 ? "s" : ""} →</div>
                </div>
                {allKeys.map((k, i) => (
                  <div key={i} style={{ background: k.isExtract ? T.orangeBg : T.surface, border: `1px solid ${k.isExtract ? ET_CONFIG.key.border : T.border}`, borderLeft: `2px solid ${k.isExtract ? ET_CONFIG.key.color : prioColor[k.priority]}`, padding: "8px 10px", marginBottom: 5, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: T.fs3, color: k.isExtract ? ET_CONFIG.key.color : T.textBright, fontWeight: "bold" }}>{k.isExtract ? "⚿ " : "🔑 "}{k.key}</div>
                      <div style={{ fontSize: T.fs2, color: T.textDim, marginTop: 3, lineHeight: 1.5 }}>{k.use}</div>
                    </div>
                    <Badge label={k.isExtract ? "EXTRACT" : prioLabel[k.priority]} color={k.isExtract ? ET_CONFIG.key.color : prioColor[k.priority]} small />
                  </div>
                ))}
              </div>
            );
          })}
        </>}
        {sv === "extracts" && <>
          <div style={{ background: T.surface, border: `1px solid ${sel.color}33`, borderLeft: `2px solid ${sel.color}`, padding: 10, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ color: sel.color, fontSize: T.fs2, fontWeight: "bold" }}>{sel.name}</div><Badge label={sel.tier} color={TC[sel.tier]} /></div>
            <div style={{ fontSize: T.fs2, color: T.textDim, margin: "5px 0 7px", lineHeight: 1.5 }}>{sel.desc}</div>
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 6 }}>{sel.bosses.map((b, i) => <div key={i} style={{ fontSize: T.fs3, color: T.errorBorder, marginBottom: 2 }}>☠ {b}</div>)}</div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <SL c="FILTER" s={{ marginBottom: 6 }} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              <Btn ch={`All (${exts.length})`} small active={fil === "all"} onClick={() => setFil("all")} />
              {types.map(t => { const c = ET_CONFIG[t]; return <button key={t} onClick={() => setFil(t)} style={{ background: fil === t ? c.bg : "transparent", color: fil === t ? c.color : T.textDim, border: `1px solid ${fil === t ? c.border : T.border}`, padding: "4px 8px", fontSize: T.fs2, cursor: "pointer", fontFamily: T.sans }}>{c.icon} {exts.filter(e => e.type === t).length}</button>; })}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map((ext, i) => {
              const c = ET_CONFIG[ext.type]; const dead = ext.type === "coop";
              return (
                <div key={i} style={{ background: c.bg, border: `1px solid ${c.border}`, borderLeft: `2px solid ${c.color}`, padding: 10, opacity: dead ? 0.5 : 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ color: dead ? T.borderBright : T.textBright, fontSize: T.fs3, fontWeight: "bold", flex: 1, textDecoration: dead ? "line-through" : "none" }}>{ext.name}</div>
                    <div style={{ background: c.border + "44", color: c.color, fontSize: T.fs1, letterSpacing: 1, padding: "2px 6px", whiteSpace: "nowrap", marginLeft: 8 }}>{c.icon} {c.label.toUpperCase()}</div>
                  </div>
                  <div style={{ marginTop: 5, fontSize: T.fs2, color: dead ? T.borderBright : c.color, lineHeight: 1.5 }}>{ext.note}</div>
                  {ext.requireItems?.length > 0 && (
                    <div style={{ marginTop: 7, paddingTop: 6, borderTop: `1px solid ${c.border}44` }}>
                      <div style={{ fontSize: T.fs2, color: T.textDim, letterSpacing: 1, marginBottom: 4 }}>REQUIRED ITEMS:</div>
                      {ext.requireItems.map(item => <div key={item} style={{ fontSize: T.fs3, color: c.color, marginBottom: 2 }}>• {item}</div>)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, padding: 10, border: `1px solid ${T.border}`, background: T.surface }}>
            <SL c={<>LEGEND<Tip text="Open extracts are always available. Key extracts need a specific key. Pay extracts cost roubles. Special extracts require items like a Red Rebel or Paracord. Co-op extracts are disabled in PvE." /></>} s={{ marginBottom: 7 }} />
            {Object.entries(ET_CONFIG).map(([t, c]) => <div key={t} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><div style={{ width: 6, height: 6, background: c.border, flexShrink: 0 }} /><div style={{ fontSize: T.fs2, color: c.color, width: 14 }}>{c.icon}</div><div style={{ fontSize: T.fs3, color: t === "coop" ? T.borderBright : T.textDim }}>{c.label}</div></div>)}
          </div>
        </>}
      </div>
    </div>
  );
}

// ─── MAPS TAB ─────────────────────────────────────────────────────────────
function MapsTab() {
  const [section, setSection] = useState("maps");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <div style={{ display: "flex", gap: 5 }}>
          <Btn ch="Maps" active={section === "maps"} onClick={() => setSection("maps")} />
          <Btn ch="Install App" active={section === "install"} onClick={() => setSection("install")} color={T.blue} />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {section === "install" && (
          <div>
            <div style={{ background: T.surface, border: `1px solid ${T.blueBorder}`, borderLeft: `2px solid ${T.blue}`, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: T.fs3, color: T.blue, fontWeight: "bold", marginBottom: 8 }}>Install as a native-feeling app</div>
              <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.8 }}>Add this app to your home screen. Runs full-screen, appears in your app launcher — no app store required.</div>
            </div>
            {[
              { platform: "iPhone / iPad", color: T.purple, steps: ["Open this page in Safari (must be Safari, not Chrome)", "Tap the Share icon (box with arrow pointing up)", "Scroll down and tap Add to Home Screen", "Name it Tarkov Guide and tap Add"] },
              { platform: "Android", color: T.success, steps: ["Open this page in Chrome", "Tap the ⋮ menu (top-right)", "Tap Add to Home screen or Install app", "Tap Add or Install to confirm"] },
              { platform: "Windows / Mac (Chrome or Edge)", color: T.gold, steps: ["Open this page in Chrome or Edge", "Look for the install icon (⊕) in the address bar", "Or: ⋮ menu → Save and share → Install page as app", "Name it Tarkov Guide and click Install"] },
            ].map(({ platform, color, steps }) => (
              <div key={platform} style={{ background: T.surface, border: `1px solid ${color}33`, borderLeft: `2px solid ${color}`, padding: 12, marginBottom: 10 }}>
                <div style={{ color, fontSize: T.fs2, fontWeight: "bold", marginBottom: 8 }}>{platform}</div>
                {steps.map((s, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 5, alignItems: "flex-start" }}><div style={{ background: color + "22", color, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: T.fs3, flexShrink: 0, fontFamily: T.mono }}>{i + 1}</div><div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.5 }}>{s}</div></div>)}
              </div>
            ))}
            <div style={{ background: T.successBg, border: `1px solid ${T.successBorder}`, borderLeft: `2px solid ${T.success}`, padding: 10 }}>
              <div style={{ fontSize: T.fs3, color: T.success, lineHeight: 1.8 }}>✓ No app store · ✓ Progress saved on device · ✓ Share codes work phone ↔ desktop · ✓ Live tarkov.dev data</div>
            </div>
          </div>
        )}
        {section === "maps" && <>
          <SL c={<>INTERACTIVE MAPS — ALL SOURCES<Tip text="Quick links to the best interactive maps for each location. Open them in a second tab while planning your raid." /></>} />
          {EMAPS.map(map => (
            <div key={map.id} style={{ background: T.surface, border: `1px solid ${map.color}22`, borderLeft: `2px solid ${map.color}`, padding: 10, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><div style={{ color: map.color, fontSize: T.fs3, fontWeight: "bold" }}>{map.name}</div><Badge label={map.tier} color={TC[map.tier]} /></div>
              <div style={{ display: "flex", gap: 6 }}>
                <a href={map.tarkovdev} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: T.blueBg, border: `1px solid ${T.blueBorder}`, color: T.blue, padding: "8px 0", fontSize: T.fs2, letterSpacing: 1, textDecoration: "none", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center" }}>tarkov.dev</a>
                <a href={map.mapgenie} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: T.blueBg, border: `1px solid ${T.blueBorder}`, color: T.blue, padding: "8px 0", fontSize: T.fs2, letterSpacing: 1, textDecoration: "none", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center" }}>mapgenie</a>
                <a href={map.wiki} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: T.surface, border: `1px solid ${map.color}33`, color: map.color, padding: "8px 0", fontSize: T.fs2, letterSpacing: 1, textDecoration: "none", fontFamily: T.sans, textTransform: "uppercase", textAlign: "center" }}>wiki</a>
              </div>
            </div>
          ))}
        </>}
      </div>
    </div>
  );
}

// ─── WELCOME + NAV ────────────────────────────────────────────────────────
function WelcomeBanner({ onDismiss }) {
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(20,20,20,0.96)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: T.surface, border: `1px solid ${T.borderBright}`, borderLeft: `2px solid ${T.gold}`, padding: 20, maxWidth: 340 }}>
        <div style={{ fontSize: T.fs3, letterSpacing: 1.5, color: T.gold, marginBottom: 8 }}>FIELD GUIDE v6</div>
        <div style={{ fontSize: T.fs3, color: T.textBright, fontWeight: "bold", marginBottom: 10 }}>Tarkov PvE Squad Guide</div>
        <div style={{ fontSize: T.fs2, color: T.text, lineHeight: 1.8, marginBottom: 14 }}>Each player manages their own profile. Share a code before raids — no squad secretary needed.</div>
        {["✓ Set your name + tasks in My Profile", "✓ Copy your code → paste it in Discord", "✓ Squad tab: paste teammates' codes, select map", "✓ Pick your intended extract — item checks included", "✓ Generate route: objectives optimized, extract last", "✓ Post-raid updates only your own progress", "✓ Install as home screen app — see Maps tab"].map((t, i) => <div key={i} style={{ fontSize: T.fs2, color: T.success, marginBottom: 4 }}>{t}</div>)}
        <button onClick={onDismiss} style={{ width: "100%", background: T.gold, color: T.bg, border: "none", padding: "11px 0", fontSize: T.fs4, letterSpacing: 1.5, cursor: "pointer", fontFamily: T.sans, textTransform: "uppercase", fontWeight: "bold", marginTop: 14 }}>ENTER FIELD GUIDE</button>
      </div>
    </div>
  );
}

function BottomNav({ tab, setTab }) {
  const items = [{ id: "profile", label: "My Profile", icon: "▲" }, { id: "squad", label: "Squad", icon: "◈" }, { id: "extracts", label: "Extracts", icon: "⬆" }, { id: "maps", label: "Maps", icon: "🗺" }];
  return (
    <div style={{ display: "flex", borderTop: `2px solid ${T.borderBright}`, background: T.surface, flexShrink: 0 }}>
      {items.map(item => <button key={item.id} onClick={() => setTab(item.id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 4px 10px", background: tab === item.id ? T.gold + "12" : "transparent", border: "none", cursor: "pointer", borderTop: `2px solid ${tab === item.id ? T.gold : "transparent"}`, transition: "background 0.15s" }}><span style={{ fontSize: T.fs4, marginBottom: 3 }}>{item.icon}</span><span style={{ fontSize: T.fs2, letterSpacing: 0.5, fontWeight: tab === item.id ? "bold" : "normal", fontFamily: T.sans, textTransform: "uppercase", color: tab === item.id ? T.gold : T.textDim }}>{item.label}</span></button>)}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────
export default function TarkovGuide() {
  const [tab, setTab] = useState("profile");
  const [myProfile, saveMyProfile, profileReady] = useStorage("tg-myprofile-v3", { id: "me_" + Math.random().toString(36).slice(2, 10), name: "", color: PLAYER_COLORS[0], tasks: [], progress: {} });
  const [apiMaps, setApiMaps] = useState(null);
  const [apiTasks, setApiTasks] = useState(null);
  const [apiHideout, setApiHideout] = useState(null);
  const [apiTraders, setApiTraders] = useState([]);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState(false);
  const [hideoutLevels, saveHideoutLevels] = useStorage("tg-hideout-v1", {});
  const [hideoutTarget, saveHideoutTarget] = useStorage("tg-hideout-target-v1", null);

  useEffect(() => {
    if (apiMaps || apiLoading) return;
    setApiLoading(true);
    (async () => {
      try {
        const [mData, tData, hData, trData] = await Promise.all([fetchAPI(MAPS_Q), fetchAPI(TASKS_Q), fetchAPI(HIDEOUT_Q), fetchAPI(TRADERS_Q)]);
        const playable = ["customs", "factory", "woods", "interchange", "shoreline", "reserve", "lighthouse", "streets-of-tarkov", "the-lab", "ground-zero"];
        setApiMaps((mData?.maps || []).filter(m => playable.includes(m.normalizedName)));
        setApiTasks(tData?.tasks || []);
        setApiHideout(hData?.hideoutStations || []);
        setApiTraders(trData?.traders || []);
      } catch (e) { setApiError(true); }
      setApiLoading(false);
    })();
  }, []);

  const [welcomed, saveWelcomed] = useStorage("tg-welcomed-v6", false);
  const [showWelcome, setShowWelcome] = useState(false);
  useEffect(() => { if (profileReady && !welcomed) setShowWelcome(true); }, [profileReady, welcomed]);

  return (
    <div style={{ height: "100vh", width: "100%", display: "flex", justifyContent: "center", background: "#000" }}>
    <div style={{ height: "100%", width: "100%", maxWidth: 960, background: T.bg, color: T.text, fontFamily: T.sans, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      {showWelcome && <WelcomeBanner onDismiss={() => { setShowWelcome(false); saveWelcomed(true); }} />}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.borderBright}`, padding: "10px 14px 8px", flexShrink: 0 }}>
        <div style={{ fontSize: T.fs2, letterSpacing: 1.5, color: T.textDim, marginBottom: 2 }}>PvE FIELD REFERENCE</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: T.fs5, fontWeight: "bold", color: T.gold, letterSpacing: 1.5 }}>TARKOV GUIDE</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {myProfile.name && <div style={{ fontSize: T.fs3, color: myProfile.color, fontFamily: T.sans }}>{myProfile.name}</div>}
            <div style={{ fontSize: T.fs1, color: apiError ? T.errorBorder : T.successBorder, display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: apiError ? T.error : T.success }} />
              {apiError ? "OFFLINE" : "LIVE DATA"}
            </div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {tab === "profile" && <MyProfileTab myProfile={myProfile} saveMyProfile={saveMyProfile} apiTasks={apiTasks} apiTraders={apiTraders} loading={apiLoading} apiError={apiError} apiHideout={apiHideout} hideoutLevels={hideoutLevels} saveHideoutLevels={saveHideoutLevels} hideoutTarget={hideoutTarget} saveHideoutTarget={saveHideoutTarget} />}
        {tab === "squad" && <SquadTab myProfile={myProfile} saveMyProfile={saveMyProfile} apiMaps={apiMaps} apiTasks={apiTasks} loading={apiLoading} apiError={apiError} hideoutTarget={hideoutTarget} apiHideout={apiHideout} hideoutLevels={hideoutLevels} />}
        {tab === "extracts" && <ExtractsTab />}
        {tab === "maps" && <MapsTab />}
      </div>
      <BottomNav tab={tab} setTab={setTab} />
    </div>
    </div>
  );
}
