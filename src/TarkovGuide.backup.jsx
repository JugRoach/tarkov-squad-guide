import { useState, useEffect, useCallback } from "react";

const T = { bg:"#07090b",surface:"#0d1117",border:"#1a2a1a",borderBright:"#2a3a2a",gold:"#c8a84b",text:"#b8b0a0",textDim:"#4a5a4a",textBright:"#d8d0c0",mono:"'Courier New',Consolas,monospace" };
const PLAYER_COLORS = ["#c8a84b","#5a9aba","#9a5aba","#5aba8a","#ba7a5a"];
const MAX_SQUAD = 5;
const API_URL = "https://api.tarkov.dev/graphql";
const CODE_VERSION = "TG2";

// ─── SHARE CODES ─────────────────────────────────────────────────────────
function encodeProfile(p){try{return CODE_VERSION+":"+btoa(unescape(encodeURIComponent(JSON.stringify({v:2,n:p.name,c:p.color,t:p.tasks||[],pr:p.progress||{}}))));}catch{return null;}}
function decodeProfile(code){try{const b64=code.trim().startsWith(CODE_VERSION+":")?code.trim().slice(CODE_VERSION.length+1):code.trim();const d=JSON.parse(decodeURIComponent(escape(atob(b64))));if(!d.n)return null;return{id:"imp_"+Date.now()+"_"+Math.random().toString(36).slice(2,5),name:d.n,color:d.c||PLAYER_COLORS[0],tasks:d.t||[],progress:d.pr||{},imported:true,importedAt:Date.now()};}catch{return null;}}

// ─── STORAGE ─────────────────────────────────────────────────────────────
function useStorage(key,def){const[val,setVal]=useState(def);const[ready,setReady]=useState(false);useEffect(()=>{(async()=>{try{const r=await window.storage.get(key);if(r?.value)setVal(JSON.parse(r.value));}catch(_){}setReady(true);})();},[key]);const save=useCallback((v)=>{setVal(p=>{const next=typeof v==="function"?v(p):v;(async()=>{try{await window.storage.set(key,JSON.stringify(next));}catch(_){}})();return next;});},[key]);return[val,save,ready];}

// ─── API ─────────────────────────────────────────────────────────────────
const MAPS_Q=`{maps{id name normalizedName lootContainers{lootContainer{name}}}}`;
const TASKS_Q=`{tasks(lang:en){id name minPlayerLevel trader{name} map{id name normalizedName} objectives{id type description optional ...on TaskObjectiveMark{markerItem{name} zones{id map{id} position{x y z}}} ...on TaskObjectiveQuestItem{questItem{name} count possibleLocations{map{id} positions{x y z}} zones{id map{id} position{x y z}}} ...on TaskObjectiveShoot{targetNames count zoneNames zones{id map{id} position{x y z}}} ...on TaskObjectiveItem{items{name} count foundInRaid} ...on TaskObjectiveExtract{exitName}}}}`;
const HIDEOUT_Q=`{hideoutStations{id name normalizedName levels{level itemRequirements{item{id name shortName} count} stationLevelRequirements{station{id name} level} traderRequirements{trader{name} level}}}}`;
async function fetchAPI(q){const r=await fetch(API_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:q})});return(await r.json()).data;}

// ─── EXTRACT DATA (with approx. map positions + item requirements) ────────
// pct = normalized {x,y} position on tarkov.dev SVG map (0-1 scale)
// requirement = text shown in item check prompt
// requireItems = array of items player needs to confirm they have
const ET_CONFIG = {
  open:    {label:"Always Open",         icon:"✓",  color:"#5dba5d", bg:"#0a1a0a", border:"#2a6a2a"},
  key:     {label:"Key Required",        icon:"⚿",  color:"#d4b84a", bg:"#1a1a08", border:"#6a5a0a"},
  pay:     {label:"Pay Roubles",         icon:"₽",  color:"#5a7aba", bg:"#08091a", border:"#2a3a6a"},
  coop:    {label:"N/A in PvE",          icon:"✗",  color:"#555",    bg:"#141414", border:"#3a3a3a"},
  special: {label:"Special Required",   icon:"⚠",  color:"#e05a5a", bg:"#1a0808", border:"#8a2a2a"},
  timed:   {label:"Timed — Listen Up",   icon:"◷",  color:"#d4943a", bg:"#180f02", border:"#7a5a1a"},
};

const TC = {Beginner:"#4a9a4a",Intermediate:"#9a8a3a",Advanced:"#9a4a3a",Endgame:"#4a8a9a"};

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


// Each extract has: name, type, note, pct (approx position on map SVG 0-1), requireItems[]
const EMAPS = [
  {id:"customs",name:"Customs",tier:"Beginner",diff:1,color:"#c8a84b",
   desc:"Best starting map. Dense early quests.",bosses:["Reshala + 4 guards (Dorms)"],
   wiki:"https://escapefromtarkov.fandom.com/wiki/Customs",mapgenie:"https://mapgenie.io/tarkov/maps/customs",tarkovdev:"https://tarkov.dev/map/customs",
   lootPoints:[
    {name:"Marked Room (Dorms 314)",type:"high-value",pct:{x:0.58,y:0.18},note:"Rare loot room — requires Marked Key",tags:["Weapon","Info","Key","Jewelry","Electronics"]},
    {name:"3-Story Dorms",type:"mixed",pct:{x:0.56,y:0.2},note:"Multiple locked rooms, weapon crates, jackets",tags:["Weapon","Weapon mod","Key","Jewelry","Meds","Info"]},
    {name:"2-Story Dorms",type:"mixed",pct:{x:0.52,y:0.22},note:"Safes, weapon boxes, quest items",tags:["Jewelry","Money","Weapon","Info"]},
    {name:"Crack House",type:"mixed",pct:{x:0.42,y:0.35},note:"Medical supplies, weapon parts, tech spawns",tags:["Meds","Medical supplies","Weapon mod","Electronics"]},
    {name:"USEC Stash (Big Red)",type:"tech",pct:{x:0.15,y:0.55},note:"Intel spawns, electronics, valuables",tags:["Electronics","Info","Jewelry"]},
    {name:"New Gas Station",type:"mixed",pct:{x:0.48,y:0.48},note:"Medical crate, food, barter items",tags:["Meds","Food","Barter item","Medical supplies"]},
    {name:"Old Gas Station",type:"stash",pct:{x:0.68,y:0.28},note:"Duffle bags, hidden stashes nearby",tags:["Barter item","Building material","Tool","Food"]},
    {name:"Warehouse 4 (Factory Shacks)",type:"mixed",pct:{x:0.3,y:0.45},note:"Weapon crates, loose loot, jackets",tags:["Weapon","Weapon mod","Ammo","Barter item"]},
   ],
   pmcExtracts:[
    {name:"Crossroads",         type:"open",   note:"Always available — southeast corner near the main road T-junction", pct:{x:0.82,y:0.86}, requireItems:[]},
    {name:"RUAF Roadblock",     type:"open",   note:"Always available — far northeast past the three-story dorms", pct:{x:0.9,y:0.08}, requireItems:[]},
    {name:"Trailer Park",       type:"open",   note:"Always available — far west side, past the gas station", pct:{x:0.05,y:0.52}, requireItems:[]},
    {name:"Smuggler's Boat",    type:"open",   note:"Always available — south riverbank, accessible from construction", pct:{x:0.67,y:0.95}, requireItems:[]},
    {name:"ZB-1011",            type:"key",    note:"Requires ZB-1011 key to unlock the bunker door", pct:{x:0.26,y:0.33}, requireItems:["ZB-1011 key"]},
    {name:"ZB-1012",            type:"key",    note:"Requires ZB-1012 key to unlock the bunker door — near old gas station", pct:{x:0.7,y:0.22}, requireItems:["ZB-1012 key"]},
    {name:"Old Gas Station",    type:"coop",   note:"NOT usable in PvE — requires friendly Scav", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Crossroads",         type:"open",   note:"Always available", pct:{x:0.82,y:0.86}, requireItems:[]},
    {name:"Trailer Park",       type:"open",   note:"Always available", pct:{x:0.05,y:0.52}, requireItems:[]},
    {name:"Railroad to Tarkov", type:"open",   note:"Always available — north rail line", pct:{x:0.55,y:0.06}, requireItems:[]},
    {name:"RUAF Roadblock",     type:"open",   note:"Always available", pct:{x:0.9,y:0.08}, requireItems:[]},
    {name:"Old Gas Station",    type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
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
    {name:"Gate 0",             type:"open",   note:"Always available — main entrance south side", pct:{x:0.15,y:0.9}, requireItems:[]},
    {name:"Gate 3",             type:"open",   note:"Always available — east side exit near machinery", pct:{x:0.85,y:0.9}, requireItems:[]},
    {name:"Hole in the Fence",  type:"open",   note:"Always available — north fence near forklift area", pct:{x:0.12,y:0.1}, requireItems:[]},
    {name:"Third Floor Stairs", type:"key",    note:"Requires Factory Exit Key — climb to third floor office stairwell", pct:{x:0.62,y:0.28}, requireItems:["Factory Exit Key"]},
   ],
   scavExtracts:[
    {name:"Gate 0",             type:"open",   note:"Always available", pct:{x:0.15,y:0.9}, requireItems:[]},
    {name:"Gate 3",             type:"open",   note:"Always available", pct:{x:0.85,y:0.9}, requireItems:[]},
    {name:"Hole in the Fence",  type:"open",   note:"Always available", pct:{x:0.12,y:0.1}, requireItems:[]},
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
    {name:"UN Roadblock",       type:"open",   note:"Always available — far northwest corner", pct:{x:0.1,y:0.06}, requireItems:[]},
    {name:"RUAF Roadblock",     type:"open",   note:"Always available — far northeast corner", pct:{x:0.88,y:0.06}, requireItems:[]},
    {name:"Outskirts",          type:"open",   note:"Always available — far west side", pct:{x:0.06,y:0.88}, requireItems:[]},
    {name:"Old Station",        type:"open",   note:"Always available — south-center, near the main road", pct:{x:0.35,y:0.92}, requireItems:[]},
    {name:"ZB-016",             type:"key",    note:"Requires ZB-016 key — military bunker in the forest", pct:{x:0.6,y:0.44}, requireItems:["ZB-016 key"]},
    {name:"Bridge V-Ex",        type:"pay",    note:"Pay 3,000 roubles to the driver — south bridge exit. Have exact change.", pct:{x:0.52,y:0.96}, requireItems:["3,000 roubles"]},
    {name:"Scav House",         type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"UN Roadblock",       type:"open",   note:"Always available", pct:{x:0.1,y:0.06}, requireItems:[]},
    {name:"Old Station",        type:"open",   note:"Always available", pct:{x:0.35,y:0.92}, requireItems:[]},
    {name:"Outskirts",          type:"open",   note:"Always available", pct:{x:0.06,y:0.88}, requireItems:[]},
    {name:"Scav House",         type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
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
    {name:"Power Station",      type:"open",   note:"Always available — outside northwest, near the power station building", pct:{x:0.06,y:0.12}, requireItems:[]},
    {name:"Emercom Checkpoint", type:"open",   note:"Always available — southeast corner road exit", pct:{x:0.88,y:0.88}, requireItems:[]},
    {name:"Hole in Fence (IDEA)",type:"open",  note:"Always available — west side of IDEA store exterior", pct:{x:0.08,y:0.58}, requireItems:[]},
    {name:"Railway Exfil",      type:"pay",    note:"Pay 3,000 roubles — vehicle extract on the railway east side", pct:{x:0.92,y:0.35}, requireItems:["3,000 roubles"]},
   ],
   scavExtracts:[
    {name:"Power Station",      type:"open",   note:"Always available", pct:{x:0.06,y:0.12}, requireItems:[]},
    {name:"Emercom Checkpoint", type:"open",   note:"Always available", pct:{x:0.88,y:0.88}, requireItems:[]},
    {name:"Hole in Fence (IDEA)",type:"open",  note:"Always available", pct:{x:0.08,y:0.58}, requireItems:[]},
    {name:"Scav Camp",          type:"open",   note:"Always available — southeast area near UN checkpoint", pct:{x:0.78,y:0.78}, requireItems:[]},
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
    {name:"Rock Passage",       type:"open",   note:"Always available — northwest rocky coastline", pct:{x:0.08,y:0.18}, requireItems:[]},
    {name:"CCP Temporary",      type:"open",   note:"Always available — southeast military checkpoint", pct:{x:0.88,y:0.82}, requireItems:[]},
    {name:"Pier Boat",          type:"open",   note:"Always available — south pier on the waterfront", pct:{x:0.52,y:0.96}, requireItems:[]},
    {name:"South Fence Gate",   type:"pay",    note:"Pay 3,000 roubles — south road vehicle extract", pct:{x:0.72,y:0.92}, requireItems:["3,000 roubles"]},
    {name:"Path to Lighthouse", type:"special",note:"Requires Paracord + Red Rebel Ice Pick + NO armored rig equipped. All three conditions must be met.", pct:{x:0.06,y:0.06}, requireItems:["Paracord","Red Rebel Ice Pick","Non-armored rig (not an armored vest)"]},
   ],
   scavExtracts:[
    {name:"Rock Passage",       type:"open",   note:"Always available", pct:{x:0.08,y:0.18}, requireItems:[]},
    {name:"CCP Temporary",      type:"open",   note:"Always available", pct:{x:0.88,y:0.82}, requireItems:[]},
    {name:"Pier Boat",          type:"open",   note:"Always available", pct:{x:0.52,y:0.96}, requireItems:[]},
    {name:"South Fence Gate",   type:"open",   note:"Always available for Scavs", pct:{x:0.72,y:0.92}, requireItems:[]},
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
    {name:"Armored Train",      type:"timed",  note:"The train spawns at a random time during the raid and stays for ~7 minutes before leaving. Listen for the horn — extract is at the train station south side. You cannot predict when it arrives.", pct:{x:0.72,y:0.88}, requireItems:[]},
    {name:"D-2 Hermetic Door",  type:"special",note:"Requires pulling two levers in the underground tunnels in the correct sequence to open the bunker door. You must be underground to use it.", pct:{x:0.38,y:0.52}, requireItems:["Knowledge of the lever sequence (pull both levers in the underground)"]},
    {name:"Cliff Descent",      type:"special",note:"Requires Paracord + Red Rebel Ice Pick + NO armored rig. All three conditions required simultaneously.", pct:{x:0.08,y:0.08}, requireItems:["Paracord","Red Rebel Ice Pick","Non-armored rig"]},
    {name:"Scav Lands",         type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Armored Train",      type:"timed",  note:"Spawns randomly — listen for the horn", pct:{x:0.72,y:0.88}, requireItems:[]},
    {name:"Cliff Descent",      type:"special",note:"Requires Paracord + Red Rebel Ice Pick + NO armored rig", pct:{x:0.08,y:0.08}, requireItems:["Paracord","Red Rebel Ice Pick","Non-armored rig"]},
    {name:"Scav Lands",         type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
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
    {name:"Armored Train",      type:"timed",  note:"Spawns randomly during the raid — listen for the horn, extract at the train station", pct:{x:0.18,y:0.88}, requireItems:[]},
    {name:"Side Tunnel",        type:"special",note:"Requires Paracord + Red Rebel Ice Pick + NO armored rig. Same cliff-descent conditions as Reserve.", pct:{x:0.06,y:0.45}, requireItems:["Paracord","Red Rebel Ice Pick","Non-armored rig"]},
    {name:"South Road V-Ex",    type:"pay",    note:"Pay 3,000 roubles to the vehicle — south road exit", pct:{x:0.82,y:0.95}, requireItems:["3,000 roubles"]},
    {name:"North V-Ex",         type:"pay",    note:"Pay 3,000 roubles to the vehicle — north road exit", pct:{x:0.25,y:0.06}, requireItems:["3,000 roubles"]},
    {name:"Lighthouse Island",  type:"open",   note:"Always available once you reach the island via boat area — accessible from the south coast", pct:{x:0.88,y:0.22}, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Armored Train",      type:"timed",  note:"Spawns randomly", pct:{x:0.18,y:0.88}, requireItems:[]},
    {name:"South Road",         type:"open",   note:"Always available", pct:{x:0.82,y:0.95}, requireItems:[]},
    {name:"North Road",         type:"open",   note:"Always available", pct:{x:0.25,y:0.06}, requireItems:[]},
   ],
  },
  {id:"streets",name:"Streets",tier:"Advanced",diff:4,color:"#8a4a4a",
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
    {name:"Damaged House",      type:"open",   note:"Always available — northwest area, collapsed building entrance", pct:{x:0.08,y:0.12}, requireItems:[]},
    {name:"Klimov Street",      type:"open",   note:"Always available — south side near the intersection", pct:{x:0.45,y:0.92}, requireItems:[]},
    {name:"Cardinal",           type:"open",   note:"Always available — northeast area, Cardinal Hotel side exit", pct:{x:0.88,y:0.15}, requireItems:[]},
    {name:"Primorsky Ave Taxi", type:"pay",    note:"Pay 3,000 roubles to the taxi — northwest corner of Primorsky Ave", pct:{x:0.12,y:0.35}, requireItems:["3,000 roubles"]},
    {name:"Scav Checkpoint",    type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Damaged House",      type:"open",   note:"Always available", pct:{x:0.08,y:0.12}, requireItems:[]},
    {name:"Klimov Street",      type:"open",   note:"Always available", pct:{x:0.45,y:0.92}, requireItems:[]},
    {name:"Scav Checkpoint",    type:"coop",   note:"NOT usable in PvE", pct:null, requireItems:[]},
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
    {name:"Police Checkpoint",   type:"open",   note:"Always available — west side of the map near the police barricade", pct:{x:0.08,y:0.45}, requireItems:[]},
    {name:"Scav Checkpoint",     type:"open",   note:"Always available — east side road exit", pct:{x:0.92,y:0.5}, requireItems:[]},
    {name:"Emercom Checkpoint",  type:"open",   note:"Always available — south side near the medical camp", pct:{x:0.5,y:0.92}, requireItems:[]},
   ],
   scavExtracts:[
    {name:"Police Checkpoint",   type:"open",   note:"Always available", pct:{x:0.08,y:0.45}, requireItems:[]},
    {name:"Scav Checkpoint",     type:"open",   note:"Always available", pct:{x:0.92,y:0.5}, requireItems:[]},
    {name:"Emercom Checkpoint",  type:"open",   note:"Always available", pct:{x:0.5,y:0.92}, requireItems:[]},
   ],
  },
  {id:"labs",name:"The Lab",tier:"Endgame",diff:5,color:"#4a8a8a",
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
    {name:"Parking Gate",       type:"key",    note:"Requires Red Keycard — parking level exit. The Red Card is extremely valuable.", pct:{x:0.15,y:0.88}, requireItems:["Red Keycard"]},
    {name:"Hangar Gate",        type:"key",    note:"Requires Blue Keycard — hangar exit on the east side.", pct:{x:0.88,y:0.55}, requireItems:["Blue Keycard"]},
    {name:"Elevator (Main)",    type:"key",    note:"Requires Manager Office Key — main floor elevator exit.", pct:{x:0.52,y:0.45}, requireItems:["Manager Office Key"]},
   ],
   scavExtracts:[
    {name:"Parking Gate",       type:"key",    note:"Requires Red Keycard", pct:{x:0.15,y:0.88}, requireItems:["Red Keycard"]},
    {name:"Hangar Gate",        type:"key",    note:"Requires Blue Keycard", pct:{x:0.88,y:0.55}, requireItems:["Blue Keycard"]},
   ],
  },
];

// ─── ROUTE UTILS ─────────────────────────────────────────────────────────
function worldToPct(pos,bounds){if(!pos||!bounds)return null;const{bottom,left,top,right}=bounds;const x=(pos.x-left)/(right-left);const y=(pos.z-top)/(bottom-top);if(isNaN(x)||isNaN(y))return null;if(x<-0.05||x>1.05||y<-0.05||y>1.05)return null;return{x:Math.max(0.02,Math.min(0.98,x)),y:Math.max(0.02,Math.min(0.98,y))};}
function nearestNeighbor(waypoints){if(!waypoints.length)return[];const origin={pct:{x:0.5,y:0.85}};const remaining=[...waypoints];const route=[];let cur=origin;while(remaining.length){const hasPos=remaining.some(w=>w.pct);if(!hasPos){route.push(...remaining);break;}let best=0,bestD=Infinity;remaining.forEach((w,i)=>{if(!w.pct)return;const d=Math.hypot(w.pct.x-cur.pct.x,w.pct.y-cur.pct.y);if(d<bestD){bestD=d;best=i;}});const next=remaining.splice(best,1)[0];route.push(next);if(next.pct)cur={pct:next.pct};}return route;}
function getObjMeta(obj){const t=obj.type;if(t==="shoot")return{icon:"☠",color:"#e05a5a",summary:`Kill ${obj.count>1?obj.count+"× ":""}${obj.targetNames?.[0]||"enemy"}${obj.zoneNames?.length?" ("+obj.zoneNames[0]+")":""}`,isCountable:true,total:obj.count||1};if(t==="findItem"||t==="giveItem")return{icon:"◈",color:"#d4b84a",summary:`${obj.count>1?obj.count+"× ":""}${obj.items?.[0]?.name||"item"}${obj.foundInRaid?" (FIR)":""}`,isCountable:obj.count>1,total:obj.count||1};if(t==="findQuestItem"||t==="giveQuestItem")return{icon:"◈",color:"#d4b84a",summary:obj.questItem?.name||obj.description,isCountable:false,total:1};if(t==="visit"||t==="mark")return{icon:"◉",color:"#9a7aba",summary:obj.description,isCountable:false,total:1};if(t==="extract")return{icon:"⬆",color:"#5dba5d",summary:obj.exitName?`Extract via ${obj.exitName}`:"Extract from map",isCountable:false,total:1};return{icon:"♦",color:"#7a9a7a",summary:obj.description||t,isCountable:false,total:1};}

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
const SL=({c,s={}})=><div style={{fontSize:8,color:T.textDim,letterSpacing:4,marginBottom:8,fontFamily:T.mono,...s}}>{c}</div>;
const Badge=({label,color,small})=><span style={{background:color+"22",color,border:`1px solid ${color}44`,padding:small?"1px 5px":"2px 7px",fontSize:small?7:8,letterSpacing:1.5,fontFamily:T.mono,whiteSpace:"nowrap"}}>{label}</span>;
const Btn=({ch,onClick,active,color=T.gold,small,style={},disabled})=><button onClick={disabled?undefined:onClick} style={{background:active?color+"22":"transparent",color:disabled?T.textDim:(active?color:T.textDim),border:`1px solid ${active?color:T.border}`,padding:small?"4px 8px":"7px 12px",fontSize:small?8:9,letterSpacing:2,cursor:disabled?"default":"pointer",fontFamily:T.mono,textTransform:"uppercase",whiteSpace:"nowrap",...style}}>{ch}</button>;

function Tip({ text, step }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        style={{
          width: 16, height: 16, borderRadius: "50%",
          background: open ? "#2a3a2a" : "transparent",
          border: `1px solid ${open ? T.gold : "#3a4a3a"}`,
          color: open ? T.gold : "#5a6a5a",
          fontSize: 9, fontWeight: "bold", fontFamily: T.mono,
          cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
          padding: 0, marginLeft: 6, flexShrink: 0,
        }}
      >?</button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: 22, left: -8, zIndex: 50,
            background: "#0d1a0d", border: `1px solid ${T.gold}55`,
            borderLeft: `2px solid ${T.gold}`,
            padding: "8px 10px", minWidth: 220, maxWidth: 280,
            boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
          }}
        >
          {step && <div style={{ fontSize: 7, letterSpacing: 3, color: T.gold, marginBottom: 4, fontFamily: T.mono }}>{step}</div>}
          <div style={{ fontSize: 10, color: T.text, lineHeight: 1.6, fontFamily: T.mono }}>{text}</div>
          <button
            onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            style={{ background: "transparent", border: "none", color: "#5a6a5a", fontSize: 8, cursor: "pointer", fontFamily: T.mono, padding: "4px 0 0", letterSpacing: 1 }}
          >DISMISS</button>
        </div>
      )}
    </span>
  );
}

// ─── HIDEOUT MANAGER ─────────────────────────────────────────────────────
function HideoutManager({ apiHideout, hideoutLevels, saveHideoutLevels, hideoutTarget, saveHideoutTarget, onBack }) {
  if (!apiHideout?.length) return <div style={{ color: T.textDim, fontSize: 10, padding: 20, textAlign: "center" }}>Loading hideout data...</div>;

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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <button onClick={onBack} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: 9, letterSpacing: 2, cursor: "pointer", fontFamily: T.mono, padding: 0, marginBottom: 8 }}>← BACK</button>
        <SL c={<>HIDEOUT UPGRADES<Tip text="Set your current hideout levels, then pick which upgrade you're working toward. The Squad tab will recommend maps where you're most likely to find the items you need." /></>} />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {/* Target upgrade selection */}
        {target && targetLevel && (
          <div style={{ background: "#0a1518", border: "1px solid #1a3a3a", borderLeft: "3px solid #4ababa", padding: 12, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 7, letterSpacing: 3, color: "#4ababa", marginBottom: 2 }}>TARGET UPGRADE</div>
                <div style={{ fontSize: 12, color: T.textBright, fontWeight: "bold" }}>{target.name} → Level {hideoutTarget.level}</div>
              </div>
              <button onClick={() => saveHideoutTarget(null)} style={{ background: "transparent", border: `1px solid #6a2a2a`, color: "#e05a5a", padding: "3px 8px", fontSize: 8, cursor: "pointer", fontFamily: T.mono }}>CLEAR</button>
            </div>
            <div style={{ fontSize: 8, letterSpacing: 2, color: T.textDim, marginBottom: 6 }}>ITEMS NEEDED:</div>
            {targetLevel.itemRequirements.map((req, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 10, color: T.text }}>{req.item.name}</span>
                <Badge label={`×${req.count}`} color="#4ababa" small />
              </div>
            ))}
            {targetLevel.traderRequirements?.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {targetLevel.traderRequirements.map((req, i) => (
                  <div key={i} style={{ fontSize: 9, color: "#ba9a4a", marginTop: 2 }}>Requires {req.trader.name} LL{req.level}</div>
                ))}
              </div>
            )}
            {targetLevel.stationLevelRequirements?.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {targetLevel.stationLevelRequirements.map((req, i) => {
                  const met = (hideoutLevels[req.station.id] || 0) >= req.level;
                  return <div key={i} style={{ fontSize: 9, color: met ? "#5dba5d" : "#e05a5a", marginTop: 2 }}>{met ? "✓" : "✕"} {req.station.name} Level {req.level}</div>;
                })}
              </div>
            )}
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
                background: isTarget ? "#0a1518" : T.surface,
                border: `1px solid ${isTarget ? "#4ababa44" : T.border}`,
                borderLeft: `3px solid ${curLevel >= maxLevel ? "#3a8a3a" : (isTarget ? "#4ababa" : T.borderBright)}`,
                padding: "8px 10px",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 11, color: curLevel >= maxLevel ? "#5dba5d" : T.textBright, fontWeight: "bold" }}>
                    {station.name}
                    {curLevel >= maxLevel && <span style={{ fontSize: 8, color: "#3a8a3a", marginLeft: 5 }}>MAX</span>}
                  </div>
                  <div style={{ fontSize: 9, color: T.textDim }}>Lv {curLevel}/{maxLevel}</div>
                </div>

                {/* Level selector */}
                <div style={{ display: "flex", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
                  {Array.from({ length: maxLevel + 1 }, (_, i) => (
                    <button key={i} onClick={() => saveHideoutLevels({ ...hideoutLevels, [station.id]: i })}
                      style={{
                        width: 28, height: 24, fontSize: 9, fontFamily: T.mono,
                        background: curLevel === i ? T.gold + "22" : "transparent",
                        border: `1px solid ${curLevel === i ? T.gold : T.border}`,
                        color: curLevel === i ? T.gold : (i <= curLevel ? "#5dba5d" : T.textDim),
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
                          onClick={() => saveHideoutTarget(isThisTarget ? null : { stationId: station.id, level: l.level })}
                          style={{
                            background: isThisTarget ? "#4ababa22" : "transparent",
                            border: `1px solid ${isThisTarget ? "#4ababa" : "#1a2a2a"}`,
                            color: isThisTarget ? "#4ababa" : (buildable ? T.textDim : "#5a3a3a"),
                            padding: "2px 8px", fontSize: 7, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1,
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
  const [mode, setMode] = useState("tasks"); // "tasks" or "items"

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

  const hasTaskData = taskRanked.length > 0;
  const hasItemData = itemRanked.length > 0;
  if (!hasTaskData && !hasItemData) return null;

  const ranked = mode === "items" && hasItemData ? itemRanked : taskRanked;
  const top = ranked[0];
  if (!top) return null;
  const isTopSelected = selectedMapId === top.mapId;

  return (
    <div style={{ marginTop: 8, marginBottom: 2 }}>
      {/* Collapsed summary bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%", background: "#0a1518", border: `1px solid #1a3a3a`,
          borderLeft: `3px solid #4ababa`, padding: "8px 10px",
          cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
          fontFamily: T.mono, textAlign: "left",
        }}
      >
        <div>
          <span style={{ fontSize: 8, letterSpacing: 2, color: "#4ababa" }}>RECOMMENDED: </span>
          <span style={{ fontSize: 10, color: T.textBright, fontWeight: "bold" }}>{top.mapName}</span>
          <span style={{ fontSize: 9, color: T.textDim, marginLeft: 6 }}>
            {mode === "tasks"
              ? `${top.totalTasks} task${top.totalTasks !== 1 ? "s" : ""} · ${top.playerCount} player${top.playerCount !== 1 ? "s" : ""}`
              : `${top.totalContainers} loot spots · best for items`
            }
          </span>
        </div>
        <span style={{ fontSize: 10, color: "#4ababa", flexShrink: 0 }}>{expanded ? "▴" : "▾"}</span>
      </button>

      {/* Expanded breakdown */}
      {expanded && (
        <div style={{ background: "#080d10", border: "1px solid #1a3a3a", borderTop: "none", padding: 12 }}>
          {/* Mode toggle */}
          {(hasTaskData || hasItemData) && (
            <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
              <button onClick={() => setMode("tasks")} disabled={!hasTaskData}
                style={{
                  flex: 1, padding: "5px 0", fontSize: 8, letterSpacing: 1, fontFamily: T.mono,
                  background: mode === "tasks" ? "#4ababa22" : "transparent",
                  border: `1px solid ${mode === "tasks" ? "#4ababa" : "#1a2a2a"}`,
                  color: !hasTaskData ? "#2a3a3a" : (mode === "tasks" ? "#4ababa" : T.textDim),
                  cursor: hasTaskData ? "pointer" : "default",
                }}>BY TASKS</button>
              <button onClick={() => setMode("items")} disabled={!hasItemData}
                style={{
                  flex: 1, padding: "5px 0", fontSize: 8, letterSpacing: 1, fontFamily: T.mono,
                  background: mode === "items" ? "#ba8a4a22" : "transparent",
                  border: `1px solid ${mode === "items" ? "#ba8a4a" : "#1a2a2a"}`,
                  color: !hasItemData ? "#2a3a3a" : (mode === "items" ? "#ba8a4a" : T.textDim),
                  cursor: hasItemData ? "pointer" : "default",
                }}>BY ITEMS</button>
            </div>
          )}

          {!hasItemData && mode === "tasks" && (
            <div style={{ fontSize: 8, color: T.textDim, marginBottom: 8, padding: "4px 0", borderBottom: `1px solid #1a2a2a` }}>
              Set a hideout target in My Profile → Hideout to enable item-based recommendations.<Tip text="BY TASKS ranks maps by how many squad tasks can be completed there. BY ITEMS ranks maps by loot container density relevant to your hideout upgrade target." />
            </div>
          )}

          {/* TASKS MODE */}
          {mode === "tasks" && hasTaskData && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 7, letterSpacing: 3, color: "#4ababa", marginBottom: 3 }}>BEST MAP FOR TASKS ({scope})</div>
                  <div style={{ fontSize: 14, color: T.textBright, fontWeight: "bold" }}>{top.mapName}</div>
                  <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>
                    {top.totalTasks} incomplete task{top.totalTasks !== 1 ? "s" : ""} · {top.totalIncomplete} objective{top.totalIncomplete !== 1 ? "s" : ""} remaining
                  </div>
                </div>
                {!isTopSelected ? (
                  <button onClick={(e) => { e.stopPropagation(); onSelectMap(top.mapId); }}
                    style={{ background: "#4ababa22", border: "1px solid #4ababa", color: "#4ababa", padding: "6px 12px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1, whiteSpace: "nowrap", flexShrink: 0 }}
                  >SELECT</button>
                ) : <Badge label="SELECTED" color="#4ababa" />}
              </div>
              {top.playerList.map(pl => (
                <div key={pl.name} style={{ borderLeft: `2px solid ${pl.color}`, paddingLeft: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 9, color: pl.color, fontWeight: "bold", marginBottom: 3 }}>
                    {pl.name}{pl.isMe ? <span style={{ fontSize: 7, color: T.textDim, fontWeight: "normal", marginLeft: 4 }}>YOU</span> : ""}
                  </div>
                  {pl.tasks.map((t, i) => (
                    <div key={i} style={{ fontSize: 9, color: T.textDim, marginBottom: 2, paddingLeft: 4 }}>
                      ★ {t.taskName} — <span style={{ color: t.remaining === t.total ? "#7a8a7a" : "#ba9a4a" }}>{t.remaining}/{t.total} obj</span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          {/* ITEMS MODE */}
          {mode === "items" && hasItemData && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 7, letterSpacing: 3, color: "#ba8a4a", marginBottom: 3 }}>BEST MAP FOR ITEM HUNTING</div>
                  <div style={{ fontSize: 14, color: T.textBright, fontWeight: "bold" }}>{top.mapName}</div>
                  <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>
                    {top.totalContainers} searchable containers · {top.affinityScore > 0 ? "high" : "average"} relevance
                  </div>
                </div>
                {!isTopSelected ? (
                  <button onClick={(e) => { e.stopPropagation(); onSelectMap(top.mapId); }}
                    style={{ background: "#ba8a4a22", border: "1px solid #ba8a4a", color: "#ba8a4a", padding: "6px 12px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1, whiteSpace: "nowrap", flexShrink: 0 }}
                  >SELECT</button>
                ) : <Badge label="SELECTED" color="#ba8a4a" />}
              </div>
              {targetStation && targetLevel && (
                <div style={{ borderLeft: "2px solid #ba8a4a", paddingLeft: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 9, color: "#ba8a4a", fontWeight: "bold", marginBottom: 4 }}>
                    {targetStation.name} → Level {hideoutTarget.level}
                  </div>
                  {targetLevel.itemRequirements.filter(r => r.item.name !== "Roubles").map((r, i) => (
                    <div key={i} style={{ fontSize: 9, color: T.textDim, marginBottom: 2, paddingLeft: 4 }}>
                      ◈ {r.item.name} ×{r.count}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Runner-up maps (both modes) */}
          {ranked.length > 1 && (
            <div style={{ borderTop: `1px solid #1a2a2a`, paddingTop: 8, marginTop: 4 }}>
              <div style={{ fontSize: 7, letterSpacing: 3, color: T.textDim, marginBottom: 6 }}>OTHER OPTIONS</div>
              {ranked.slice(1, 4).map(m => (
                <button key={m.mapId} onClick={(e) => { e.stopPropagation(); onSelectMap(m.mapId); }}
                  style={{
                    width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
                    background: selectedMapId === m.mapId ? "#4ababa11" : "transparent",
                    border: `1px solid ${selectedMapId === m.mapId ? "#2a4a4a" : "#1a2a2a"}`,
                    padding: "5px 8px", marginBottom: 4, cursor: "pointer", fontFamily: T.mono,
                  }}
                >
                  <span style={{ fontSize: 9, color: selectedMapId === m.mapId ? "#4ababa" : T.textDim }}>
                    #{m.rank} {m.mapName}
                  </span>
                  <span style={{ fontSize: 8, color: T.textDim }}>
                    {mode === "tasks"
                      ? `${m.totalTasks} task${m.totalTasks !== 1 ? "s" : ""} · ${m.playerCount} plyr${m.playerCount !== 1 ? "s" : ""}`
                      : `${m.totalContainers} containers`
                    }
                  </span>
                </button>
              ))}
            </div>
          )}
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
          background: choice.confirmed ? cfg.bg : "#1a0808",
          border: `1px solid ${choice.confirmed ? cfg.border : "#8a2a2a"}`,
          borderLeft: `3px solid ${choice.confirmed ? cfg.color : "#e05a5a"}`,
          padding: "8px 10px",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontSize: 9, color: choice.confirmed ? cfg.color : "#e05a5a", fontWeight: "bold" }}>
                {choice.confirmed ? "⬆ " : "⚠ "}{choice.extract.name}
              </span>
              <Badge label={ET_CONFIG[choice.extract.type].label} color={cfg.color} small />
            </div>
            <button onClick={() => onChoice(null)} style={{ background: "transparent", border: "none", color: T.textDim, cursor: "pointer", fontSize: 9, fontFamily: T.mono }}>
              CHANGE
            </button>
          </div>
          {!choice.confirmed && choice.missingItems?.length > 0 && (
            <div style={{ fontSize: 9, color: "#e05a5a", marginTop: 5, lineHeight: 1.5 }}>
              ⚠ Missing: {choice.missingItems.join(", ")} — this extract may not be usable. Consider a different exit.
            </div>
          )}
          {choice.confirmed && choice.extract.type !== "open" && (
            <div style={{ fontSize: 9, color: cfg.color, marginTop: 4, opacity: 0.8 }}>
              ✓ Items confirmed — extract added as final route waypoint
            </div>
          )}
        </div>
      ) : (
        <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: "8px 10px" }}>
          <div style={{ fontSize: 9, color: T.textDim, marginBottom: 7 }}>Select extract for {player.name}:</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {usable.map(ext => {
              const c = ET_CONFIG[ext.type];
              return (
                <button key={ext.name} onClick={() => handleSelect(ext)} style={{
                  background: "transparent", border: `1px solid ${c.border}`,
                  borderLeft: `3px solid ${c.color}`, color: T.textBright,
                  padding: "7px 10px", textAlign: "left", cursor: "pointer",
                  fontFamily: T.mono, fontSize: 10, display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span>{ext.name}</span>
                  <span style={{ fontSize: 8, color: c.color }}>{c.icon} {c.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Item check modal */}
      {pendingExtract && (
        <div style={{ background: "#100808", border: "1px solid #6a2a1a", borderLeft: "3px solid #e05a5a", padding: 12, marginTop: 6 }}>
          <div style={{ fontSize: 9, color: "#e05a5a", letterSpacing: 2, marginBottom: 6 }}>EXTRACT REQUIREMENTS CHECK</div>
          <div style={{ fontSize: 12, color: T.textBright, fontWeight: "bold", marginBottom: 6 }}>{pendingExtract.name}</div>
          <div style={{ fontSize: 10, color: T.text, lineHeight: 1.6, marginBottom: 10 }}>{pendingExtract.note}</div>
          <SL c="DO YOU HAVE THESE ITEMS IN YOUR LOADOUT?" s={{ marginBottom: 8 }} />
          {pendingExtract.requireItems.map(item => (
            <div key={item} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <button onClick={() => setItemChecks(c => ({ ...c, [item]: !c[item] }))} style={{
                width: 20, height: 20, flexShrink: 0,
                background: itemChecks[item] ? "#0a1a0a" : "transparent",
                border: `1px solid ${itemChecks[item] ? "#2a6a2a" : T.borderBright}`,
                color: itemChecks[item] ? "#5dba5d" : T.textDim,
                cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center",
              }}>{itemChecks[item] ? "✓" : ""}</button>
              <span style={{ fontSize: 10, color: itemChecks[item] ? "#5dba5d" : T.textBright }}>{item}</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={() => setPendingExtract(null)} style={{ flex: 1, background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "8px 0", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1 }}>
              ← PICK ANOTHER
            </button>
            <button onClick={confirmItems} style={{
              flex: 2,
              background: pendingExtract.requireItems.every(i => itemChecks[i]) ? "#0a1a0a" : "#180a0a",
              border: `1px solid ${pendingExtract.requireItems.every(i => itemChecks[i]) ? "#2a6a2a" : "#6a2a2a"}`,
              color: pendingExtract.requireItems.every(i => itemChecks[i]) ? "#5dba5d" : "#e05a5a",
              padding: "8px 0", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1,
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
function MapOverlay({ apiMap, route, conflicts, onConflictResolve }) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const svgName = apiMap ? MAP_SVG_NAMES[apiMap.normalizedName] : null;
  const svgUrl = svgName ? `https://assets.tarkov.dev/maps/svg/${svgName}.svg` : null;
  const objWaypoints = route.filter(w => w.pct && !w.isExtract);
  const extractWaypoints = route.filter(w => w.pct && w.isExtract);
  const allPositioned = route.filter(w => w.pct);

  return (
    <div>
      <div style={{ position: "relative", background: "#080d08", border: `1px solid ${T.border}` }}>
        {svgUrl && !imgErr ? (
          <>
            {!imgLoaded && <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: T.textDim, fontSize: 10, fontFamily: T.mono }}>Loading map from tarkov.dev...</div>}
            <img src={svgUrl} alt={apiMap?.name} style={{ width: "100%", display: imgLoaded ? "block" : "none" }}
              onLoad={() => setImgLoaded(true)} onError={() => setImgErr(true)} />
            {imgLoaded && allPositioned.length > 0 && (
              <svg style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
                viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet">
                {/* Route path through objectives */}
                {objWaypoints.length > 1 && (
                  <polyline points={objWaypoints.map(w => `${w.pct.x},${w.pct.y}`).join(" ")}
                    fill="none" stroke={T.gold} strokeWidth="0.005" strokeDasharray="0.018,0.009" opacity="0.85" />
                )}
                {/* Spawn to first */}
                {objWaypoints[0] && (
                  <line x1="0.5" y1="0.85" x2={objWaypoints[0].pct.x} y2={objWaypoints[0].pct.y}
                    stroke="#5dba5d" strokeWidth="0.004" strokeDasharray="0.015,0.008" opacity="0.7" />
                )}
                {/* Last obj to extract */}
                {objWaypoints.length > 0 && extractWaypoints[0] && (
                  <line
                    x1={objWaypoints[objWaypoints.length-1].pct.x} y1={objWaypoints[objWaypoints.length-1].pct.y}
                    x2={extractWaypoints[0].pct.x} y2={extractWaypoints[0].pct.y}
                    stroke="#5dba5d" strokeWidth="0.005" strokeDasharray="0.02,0.01" opacity="0.8" />
                )}
                {/* Spawn marker */}
                <circle cx="0.5" cy="0.85" r="0.018" fill="#0a1a0a" stroke="#5dba5d" strokeWidth="0.004" />
                <text x="0.5" y="0.857" textAnchor="middle" fill="#5dba5d" fontSize="0.017" fontFamily={T.mono} fontWeight="bold">S</text>
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
                    <circle cx={w.pct.x} cy={w.pct.y} r="0.026" fill="#0a1a0a" stroke="#5dba5d" strokeWidth="0.006" />
                    <text x={w.pct.x} y={w.pct.y + 0.009} textAnchor="middle" fill="#5dba5d" fontSize="0.018" fontFamily={T.mono} fontWeight="bold">⬆</text>
                  </g>
                ))}
              </svg>
            )}
          </>
        ) : (
          <div style={{ height: 160, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <div style={{ color: T.textDim, fontSize: 10, fontFamily: T.mono }}>{imgErr ? "Map image unavailable" : "Select a map above"}</div>
            {apiMap && <a href={`https://tarkov.dev/map/${apiMap.normalizedName}`} target="_blank" rel="noreferrer" style={{ color: "#5a9aba", fontSize: 9, fontFamily: T.mono }}>Open on tarkov.dev →</a>}
          </div>
        )}
      </div>

      {/* Conflicts */}
      {conflicts.map(c => (
        <div key={c.id} style={{ background: "#180e02", border: "1px solid #7a5a1a", borderLeft: "3px solid #d4943a", padding: 10, marginTop: 8 }}>
          <div style={{ fontSize: 9, color: "#d4943a", letterSpacing: 2, marginBottom: 5 }}>⚠ OVERLAPPING OBJECTIVES</div>
          <div style={{ fontSize: 11, color: T.textBright, marginBottom: 8 }}>{c.label}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => onConflictResolve(c.id, "merge")} style={{ flex: 1, background: "#0a1a0a", border: "1px solid #2a6a2a", color: "#5dba5d", padding: "7px 0", fontSize: 8, cursor: "pointer", fontFamily: T.mono }}>✓ MERGE</button>
            <button onClick={() => onConflictResolve(c.id, "separate")} style={{ flex: 1, background: "#0a0d18", border: "1px solid #2a3a6a", color: "#5a7aba", padding: "7px 0", fontSize: 8, cursor: "pointer", fontFamily: T.mono }}>⇄ TWO STOPS</button>
          </div>
        </div>
      ))}

      {/* Unpositioned objectives */}
      {route.filter(w => !w.pct && !w.isExtract).length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: "3px solid #4a6a5a", padding: 10, marginTop: 8 }}>
          <SL c="MAP-WIDE OBJECTIVES (no pin data)" s={{ marginBottom: 6 }} />
          {route.filter(w => !w.pct && !w.isExtract).map((w, i) => (
            <div key={w.id} style={{ display: "flex", gap: 7, alignItems: "flex-start", marginBottom: 5 }}>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>{w.players.map(p => <Badge key={p.playerId} label={p.name} color={p.color} small />)}</div>
              <div style={{ fontSize: 10, color: T.text, flex: 1 }}>{w.locationName}</div>
            </div>
          ))}
        </div>
      )}

      {/* Route sequence */}
      {(objWaypoints.length > 0 || extractWaypoints.length > 0) && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `3px solid ${T.gold}`, padding: 10, marginTop: 8 }}>
          <SL c="ROUTE SEQUENCE" s={{ marginBottom: 10 }} />
          {objWaypoints.map((w, i) => (
            <div key={w.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${T.border}` }}>
              <div style={{ background: (w.isLoot ? w.players[0]?.color : T.gold) + "22", border: `1px solid ${w.isLoot ? w.players[0]?.color : T.gold}`, color: w.isLoot ? w.players[0]?.color : T.gold, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: "bold", flexShrink: 0, fontFamily: T.mono }}>{i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ color: T.textBright, fontSize: 11, fontWeight: "bold", marginBottom: 4 }}>{w.locationName}</div>
                {w.isLoot ? (
                  <div style={{ fontSize: 10, color: w.players[0]?.color, marginBottom: 2 }}>
                    {w.players[0]?.objective}
                    <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>{w.players[0]?.name}</div>
                  </div>
                ) : w.players.map((p, pi) => (
                  <div key={pi} style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 3 }}>
                    <Badge label={p.name} color={p.color} small />
                    <div style={{ fontSize: 10, color: p.color, flex: 1 }}>{p.objective}{p.total > 1 && p.progress < p.total && <span style={{ color: T.textDim }}> ({p.progress}/{p.total})</span>}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {/* Extract as final step */}
          {extractWaypoints.map((w) => (
            <div key={w.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <div style={{ background: "#0a1a0a", border: "1px solid #2a6a2a", color: "#5dba5d", width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>⬆</div>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#5dba5d", fontSize: 11, fontWeight: "bold", marginBottom: 4 }}>EXTRACT — {w.extractName}</div>
                {w.players.map((p, pi) => (
                  <div key={pi} style={{ fontSize: 9, color: "#5dba5d", opacity: 0.8 }}>
                    {p.name}{p.missingItems?.length > 0 && <span style={{ color: "#e05a5a" }}> ⚠ missing {p.missingItems.join(", ")}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {/* Tarkov.dev link */}
          {apiMap && (
            <a href={`https://tarkov.dev/map/${apiMap.normalizedName}`} target="_blank" rel="noreferrer"
              style={{ display: "block", background: "#0a1318", border: "1px solid #1a3a4a", color: "#4a8aba", padding: "9px 0", fontSize: 9, letterSpacing: 2, textDecoration: "none", fontFamily: T.mono, textTransform: "uppercase", textAlign: "center", marginTop: 10 }}>
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
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(7,9,11,0.97)", zIndex: 70, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "12px 14px", flexShrink: 0 }}>
        <div style={{ fontSize: 8, color: T.textDim, letterSpacing: 4, marginBottom: 4 }}>POST-RAID — MY PROGRESS</div>
        <div style={{ fontSize: 13, color: T.textBright, fontWeight: "bold" }}>How did your raid go?</div>
        <div style={{ fontSize: 10, color: T.textDim, marginTop: 3 }}>Only your objectives. Copy updated code after saving.</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {trackable.length === 0 ? (
          <div style={{ color: T.textDim, fontSize: 11, textAlign: "center", padding: 32, fontFamily: T.mono }}>No countable objectives this raid.</div>
        ) : trackable.map((p, i) => {
          const k = key(p); const cur = updates[k]; const done = (myProfile.progress || {})[k] || 0; const remaining = Math.max(0, p.total - done);
          return (
            <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `3px solid ${p.color || T.gold}`, padding: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: T.textBright, fontWeight: "bold", marginBottom: 4 }}>{p.objective}</div>
              <div style={{ fontSize: 9, color: T.textDim, marginBottom: 8 }}>Progress: {done}/{p.total} — need {remaining} more</div>
              {p.total === 1 ? (
                <div style={{ display: "flex", gap: 8 }}>
                  {["Done ✓", "Not done"].map((opt, oi) => (
                    <button key={opt} onClick={() => set(k, oi === 0 ? 1 : 0)} style={{ flex: 1, padding: "7px 0", background: cur === (oi === 0 ? 1 : 0) && cur !== undefined ? (oi === 0 ? "#0a1a0a" : "#1a0a0a") : "transparent", border: `1px solid ${cur === (oi === 0 ? 1 : 0) && cur !== undefined ? (oi === 0 ? "#2a6a2a" : "#6a2a2a") : T.border}`, color: cur === (oi === 0 ? 1 : 0) && cur !== undefined ? (oi === 0 ? "#5dba5d" : "#e05a5a") : T.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: 9 }}>{opt.toUpperCase()}</button>
                  ))}
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 8, color: T.textDim, letterSpacing: 2, marginBottom: 6 }}>COMPLETED THIS RAID:</div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {Array.from({ length: Math.min(remaining + 1, 10) }, (_, n) => (
                      <button key={n} onClick={() => set(k, n)} style={{ width: 36, height: 36, background: cur === n ? (p.color || T.gold) + "22" : "transparent", border: `1px solid ${cur === n ? (p.color || T.gold) : T.border}`, color: cur === n ? (p.color || T.gold) : T.textDim, cursor: "pointer", fontFamily: T.mono, fontSize: 12 }}>{n}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ padding: 12, display: "flex", gap: 8, borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
        <button onClick={onClose} style={{ flex: 1, background: "transparent", border: `1px solid ${T.border}`, color: T.textDim, padding: "10px 0", fontSize: 9, cursor: "pointer", fontFamily: T.mono, letterSpacing: 2, textTransform: "uppercase" }}>Cancel</button>
        <button onClick={() => { const newProg = { ...(myProfile.progress || {}) }; Object.entries(updates).forEach(([k, v]) => { newProg[k] = Math.min((newProg[k] || 0) + v, 9999); }); onSave(newProg); onClose(); }} style={{ flex: 2, background: "#5dba5d22", border: "1px solid #3a8a3a", color: "#5dba5d", padding: "10px 0", fontSize: 9, cursor: "pointer", fontFamily: T.mono, letterSpacing: 2, textTransform: "uppercase", fontWeight: "bold" }}>✓ SAVE MY PROGRESS</button>
      </div>
    </div>
  );
}

// ─── MY PROFILE TAB ──────────────────────────────────────────────────────
function MyProfileTab({ myProfile, saveMyProfile, apiTasks, loading, apiError, apiHideout, hideoutLevels, saveHideoutLevels, hideoutTarget, saveHideoutTarget }) {
  const [screen, setScreen] = useState("profile");
  const [taskSearch, setTaskSearch] = useState("");
  const [taskTrader, setTaskTrader] = useState("all");
  const [taskMapFilter, setTaskMapFilter] = useState("all");
  const [copied, setCopied] = useState(false);
  const [editingName, setEditingName] = useState(false);

  const copyCode = () => {
    const code = encodeProfile(myProfile); if (!code) return;
    try { navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => { const ta = document.createElement("textarea"); ta.value = code; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); setCopied(true); setTimeout(() => setCopied(false), 2500); }); } catch(e) {}
  };

  const traders = [...new Set((apiTasks || []).map(t => t.trader?.name).filter(Boolean))].sort();
  const taskMaps = [...new Set((apiTasks || []).map(t => t.map?.name).filter(Boolean))].sort();
  const filteredTasks = (apiTasks || []).filter(t => {
    if (taskTrader !== "all" && t.trader?.name !== taskTrader) return false;
    if (taskMapFilter !== "all" && t.map?.name !== taskMapFilter) return false;
    if (taskSearch && !t.name.toLowerCase().includes(taskSearch.toLowerCase())) return false;
    return true;
  }).slice(0, 50);

  const addTask = taskId => { if (!myProfile.tasks?.some(t => t.taskId === taskId)) saveMyProfile({ ...myProfile, tasks: [...(myProfile.tasks || []), { taskId }] }); };
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

  if (screen === "browsetasks") return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <button onClick={() => setScreen("profile")} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: 9, letterSpacing: 2, cursor: "pointer", fontFamily: T.mono, padding: 0, marginBottom: 8 }}>← BACK</button>
        <input value={taskSearch} onChange={e => setTaskSearch(e.target.value)} placeholder="Search tasks..." style={{ width: "100%", background: "#0a0d10", border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "7px 10px", fontSize: 11, fontFamily: T.mono, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
        <div style={{ display: "flex", gap: 4, marginBottom: 6, flexWrap: "wrap" }}>
          <Btn ch="All" small active={taskTrader === "all"} onClick={() => setTaskTrader("all")} />
          {traders.slice(0, 8).map(tr => <Btn key={tr} ch={tr} small active={taskTrader === tr} onClick={() => setTaskTrader(tr)} />)}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Btn ch="All Maps" small active={taskMapFilter === "all"} onClick={() => setTaskMapFilter("all")} />
          {taskMaps.map(m => <Btn key={m} ch={m.split(" ")[0]} small active={taskMapFilter === m} onClick={() => setTaskMapFilter(m)} />)}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {loading && <div style={{ color: T.textDim, fontSize: 10, textAlign: "center", padding: 20 }}>Loading live data from tarkov.dev...</div>}
        {apiError && <div style={{ color: "#e05a5a", fontSize: 10, textAlign: "center", padding: 20 }}>Could not reach tarkov.dev. Check connection.</div>}
        <div style={{ fontSize: 9, color: T.textDim, letterSpacing: 2, marginBottom: 10 }}>{filteredTasks.length} TASKS · LIVE FROM TARKOV.DEV<Tip text="Filter by trader or map, then tap '+ ADD' on any task you need to complete. Added tasks appear on your profile and get shared with your squad via your share code." /></div>
        {filteredTasks.map(task => {
          const added = myProfile.tasks?.some(t => t.taskId === task.id);
          return (
            <div key={task.id} style={{ background: T.surface, border: `1px solid ${added ? myProfile.color : T.border}`, borderLeft: `3px solid ${added ? myProfile.color : T.border}`, padding: 10, marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
                <div style={{ color: T.textBright, fontSize: 11, fontWeight: "bold", flex: 1 }}>{task.name}</div>
                <button onClick={() => added ? removeTask(task.id) : addTask(task.id)} style={{ background: added ? "#1a0a0a" : "transparent", border: `1px solid ${added ? "#6a2a2a" : T.borderBright}`, color: added ? "#e05a5a" : T.textDim, padding: "3px 8px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, flexShrink: 0 }}>{added ? "✕ REMOVE" : "+ ADD"}</button>
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 4 }}>
                <Badge label={task.trader?.name || "?"} color={T.textDim} />
                {task.map && <Badge label={task.map.name} color="#5a7a8a" />}
                {task.minPlayerLevel > 1 && <Badge label={`Lvl ${task.minPlayerLevel}+`} color={T.textDim} />}
              </div>
              {task.objectives?.slice(0, 2).map(obj => <div key={obj.id} style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>{getObjMeta(obj).icon} {obj.description}</div>)}
            </div>
          );
        })}
        <div style={{ height: 20 }} />
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "12px 14px" }}>
        <SL c={<>YOUR PLAYER PROFILE<Tip step="STEP 1" text="Set your callsign and pick a color. This is how your squadmates will see you on the route map." /></>} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", background: myProfile.color + "33", border: `2px solid ${myProfile.color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: myProfile.color, flexShrink: 0 }}>{myProfile.name?.[0]?.toUpperCase() || "?"}</div>
          {editingName ? (
            <input autoFocus value={myProfile.name || ""} onChange={e => saveMyProfile({ ...myProfile, name: e.target.value })} onBlur={() => setEditingName(false)} onKeyDown={e => e.key === "Enter" && setEditingName(false)} style={{ flex: 1, background: "transparent", border: "none", borderBottom: `1px solid ${myProfile.color}`, color: myProfile.color, fontSize: 16, fontFamily: T.mono, outline: "none", padding: "2px 0" }} />
          ) : (
            <div style={{ flex: 1, color: myProfile.color, fontSize: 16, fontWeight: "bold", cursor: "pointer" }} onClick={() => setEditingName(true)}>
              {myProfile.name || "Tap to set name"}<span style={{ fontSize: 8, color: T.textDim, fontWeight: "normal", marginLeft: 6 }}>✎</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {PLAYER_COLORS.map((col, i) => <button key={i} onClick={() => saveMyProfile({ ...myProfile, color: col })} style={{ width: 24, height: 24, borderRadius: "50%", background: col, cursor: "pointer", border: myProfile.color === col ? "2px solid #d8d0c0" : "2px solid transparent", padding: 0 }} />)}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        <SL c={<>YOUR SHARE CODE<Tip step="STEP 3" text="Copy this code and paste it in Discord before each raid. Your squadmates paste it in their Squad tab to import your profile and tasks." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${myProfile.color}44`, borderLeft: `3px solid ${myProfile.color}`, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: T.text, lineHeight: 1.7, marginBottom: 10 }}>Copy your code and paste it in Discord before each raid. Teammates import it in the Squad tab — no account needed.</div>
          <div style={{ background: "#060809", border: `1px solid ${T.border}`, padding: "8px 10px", marginBottom: 8, fontSize: 8, color: T.textDim, fontFamily: T.mono, wordBreak: "break-all", lineHeight: 1.5 }}>{myProfile.tasks?.length > 0 ? encodeProfile(myProfile)?.slice(0, 60) + "..." : "Add tasks to generate your code"}</div>
          <button onClick={copyCode} disabled={!myProfile.tasks?.length} style={{ width: "100%", background: copied ? "#0a1a0a" : myProfile.color + "22", border: `1px solid ${copied ? "#2a6a2a" : myProfile.color}`, color: copied ? "#5dba5d" : myProfile.color, padding: "10px 0", fontSize: 9, cursor: myProfile.tasks?.length ? "pointer" : "default", fontFamily: T.mono, letterSpacing: 2, textTransform: "uppercase", fontWeight: "bold" }}>
            {copied ? "✓ COPIED TO CLIPBOARD" : "📋 COPY MY CODE"}
          </button>
          {!myProfile.tasks?.length && <div style={{ fontSize: 8, color: T.textDim, textAlign: "center", marginTop: 6 }}>Add tasks below first</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <SL c={<>MY TASKS ({myProfile.tasks?.length || 0})<Tip step="STEP 2" text="Browse and add the tasks you're currently working on. These get included in your share code so your squad knows what objectives you need to hit." /></>} s={{ marginBottom: 0 }} />
          <button onClick={() => setScreen("browsetasks")} style={{ background: myProfile.color + "22", border: `1px solid ${myProfile.color}`, color: myProfile.color, padding: "5px 10px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1 }}>+ BROWSE TASKS</button>
        </div>
        {!myProfile.tasks?.length && (
          <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 20, textAlign: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: T.textDim, marginBottom: 8 }}>No tasks added yet</div>
            <button onClick={() => setScreen("browsetasks")} style={{ background: "transparent", border: `1px solid ${myProfile.color}`, color: myProfile.color, padding: "8px 16px", fontSize: 9, cursor: "pointer", fontFamily: T.mono, letterSpacing: 2 }}>BROWSE ALL TASKS →</button>
          </div>
        )}
        {(myProfile.tasks || []).map(t => {
          const apiTask = apiTasks?.find(x => x.id === t.taskId); if (!apiTask) return null;
          const prog = myProfile.progress || {};
          const completedObjs = (apiTask.objectives || []).filter(obj => { const k = `${myProfile.id}-${t.taskId}-${obj.id}`; const meta = getObjMeta(obj); return (prog[k] || 0) >= meta.total; }).length;
          const totalObjs = (apiTask.objectives || []).filter(o => !o.optional).length;
          const isComplete = completedObjs >= totalObjs && totalObjs > 0;
          return (
            <div key={t.taskId} style={{ background: isComplete ? "#0a140a" : T.surface, border: `1px solid ${isComplete ? "#2a5a2a" : T.border}`, borderLeft: `3px solid ${isComplete ? "#4a9a4a" : myProfile.color}`, padding: 10, marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: isComplete ? "#4a8a4a" : T.textBright, fontSize: 11, fontWeight: "bold", textDecoration: isComplete ? "line-through" : "none" }}>{apiTask.name}</div>
                  <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                    <Badge label={apiTask.trader?.name || "?"} color={T.textDim} />
                    {apiTask.map && <Badge label={apiTask.map.name} color="#5a7a8a" />}
                    <span style={{ fontSize: 8, color: isComplete ? "#4a7a4a" : T.textDim }}>{completedObjs}/{totalObjs} obj</span>
                  </div>
                </div>
                <button onClick={() => removeTask(t.taskId)} style={{ background: "transparent", border: "none", color: "#9a3a3a", cursor: "pointer", fontSize: 14, padding: "0 2px", flexShrink: 0 }}>×</button>
              </div>
            </div>
          );
        })}

        {/* Hideout section */}
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <SL c={<>MY HIDEOUT<Tip text="Track your hideout upgrade levels and set a target. The Squad tab will recommend maps based on what items you need to find." /></>} s={{ marginBottom: 0 }} />
            <button onClick={() => setScreen("hideout")} style={{ background: "#4ababa22", border: "1px solid #4ababa", color: "#4ababa", padding: "5px 10px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1 }}>MANAGE HIDEOUT</button>
          </div>
          {hideoutTarget && apiHideout ? (() => {
            const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
            const level = station?.levels.find(l => l.level === hideoutTarget.level);
            return station && level ? (
              <div style={{ background: "#0a1518", border: "1px solid #1a3a3a", borderLeft: "3px solid #4ababa", padding: 10 }}>
                <div style={{ fontSize: 9, color: "#4ababa", fontWeight: "bold", marginBottom: 4 }}>Target: {station.name} → Level {hideoutTarget.level}</div>
                <div style={{ fontSize: 9, color: T.textDim }}>
                  {level.itemRequirements.filter(r => r.item.name !== "Roubles").slice(0, 3).map(r => `${r.item.shortName || r.item.name} ×${r.count}`).join(", ")}
                  {level.itemRequirements.filter(r => r.item.name !== "Roubles").length > 3 ? " ..." : ""}
                </div>
              </div>
            ) : null;
          })() : (
            <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: "14px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 10, color: T.textDim, marginBottom: 4 }}>No hideout target set</div>
              <button onClick={() => setScreen("hideout")} style={{ background: "transparent", border: "1px solid #4ababa", color: "#4ababa", padding: "6px 14px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1 }}>SET HIDEOUT TARGET →</button>
            </div>
          )}
        </div>

        <div style={{ height: 20 }} />
      </div>
    </div>
  );
}

// ─── SQUAD TAB ────────────────────────────────────────────────────────────
function SquadTab({ myProfile, saveMyProfile, apiMaps, apiTasks, loading, apiError, hideoutTarget, apiHideout }) {
  const [importCode, setImportCode] = useState("");
  const [importError, setImportError] = useState("");
  const [importedSquad, saveImportedSquad] = useStorage("tg-squad-v3", []);
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

  const searchEquipment = async (term) => {
    if (!term || term.length < 2) { setEquipResults(null); return; }
    setEquipSearching(true);
    try {
      const data = await fetchAPI(ITEMS_SEARCH_Q(term));
      setEquipResults(data?.items || []);
    } catch(e) { setEquipResults([]); }
    setEquipSearching(false);
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
        return lootPoints.filter(lp => (lp.tags || []).some(t => neededTags.has(t)));
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
      return lootPoints.filter(lp => (lp.tags || []).some(t => neededTags.has(t)));
    }
    return lootPoints;
  };

  const selectedMap = apiMaps?.find(m => m.id === selectedMapId);
  const selectedMapNorm = apiMaps?.find(m => m.id === selectedMapId)?.normalizedName;
  const emap = EMAPS.find(m => m.id === selectedMapNorm);
  const allProfiles = [myProfile, ...importedSquad];

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
      const bounds = selectedMap.coordinateSpace || null;
      const wpMap = new Map();

      activeIds.forEach(pid => {
        const profile = allProfiles.find(p => p.id === pid); if (!profile) return;
        const ptaskId = priorityTasks[pid]; if (!ptaskId) return;
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

    setRoute([...orderedObjectives, ...unpositioned, ...extractWaypoints]);
    setConflicts(newConflicts.filter(c => !resolvedConflicts[c.id]));
    setScreen("route");
  }, [selectedMap, emap, activeIds, allProfiles, priorityTasks, apiTasks, extractChoices, resolvedConflicts, routeMode, lootSubMode, targetEquipment, hideoutTarget, apiHideout]);

  const handleConflictResolve = (id, choice) => {
    setResolvedConflicts(r => ({ ...r, [id]: choice }));
    setConflicts(c => c.filter(x => x.id !== id));
    if (choice === "merge") setRoute(r => r.map(w => { if (w.id !== id) return w; const seen = new Set(); return { ...w, players: w.players.filter(p => { if (seen.has(p.playerId)) return false; seen.add(p.playerId); return true; }) }; }));
  };

  const handleSaveMyProgress = newProgress => saveMyProfile({ ...myProfile, progress: newProgress });

  const canGenerate = selectedMap && activeIds.size > 0 && (routeMode === "loot" || [...activeIds].some(id => priorityTasks[id]));

  // Route screen — breaks out of the 480px container to use full width
  if (screen === "route" || screen === "postraid") return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: T.bg, zIndex: 50, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px", flexShrink: 0 }}>
        <button onClick={() => setScreen("squad")} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: 9, letterSpacing: 2, cursor: "pointer", fontFamily: T.mono, padding: 0, marginBottom: 6 }}>← BACK TO PLANNER</button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 13, color: T.gold, fontWeight: "bold" }}>{selectedMap?.name} — {routeMode === "loot" ? (lootSubMode === "hideout" ? "Hideout Run" : lootSubMode === "equipment" ? "Equipment Run" : "Loot Run") : "Squad Route"}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Tip text="After your raid, tap POST-RAID to log kills and items found. This updates your progress so your next share code reflects what's done." />
            <button onClick={() => setScreen("postraid")} style={{ background: "#5dba5d22", border: "1px solid #3a8a3a", color: "#5dba5d", padding: "5px 10px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1 }}>POST-RAID ▶</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 7, flexWrap: "wrap" }}>
          {[...activeIds].map(pid => { const p = allProfiles.find(x => x.id === pid); const task = apiTasks?.find(t => t.id === priorityTasks[pid]); const ec = extractChoices[pid]; return p ? <div key={pid} style={{ background: p.color + "15", border: `1px solid ${p.color}44`, padding: "2px 7px", fontSize: 8, fontFamily: T.mono, color: p.color }}>{p.name}{task ? ` — ${task.name.slice(0, 14)}…` : ""}{ec?.extract ? ` → ⬆ ${ec.extract.name}` : ""}</div> : null; })}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 5%" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <MapOverlay apiMap={selectedMap} route={route} conflicts={conflicts} onConflictResolve={handleConflictResolve} />
          {/* Targeted items reminder */}
          {routeMode === "loot" && lootSubMode === "hideout" && hideoutTarget && apiHideout && (() => {
            const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
            const level = station?.levels.find(l => l.level === hideoutTarget.level);
            const items = level?.itemRequirements?.filter(r => r.item.name !== "Roubles") || [];
            return items.length > 0 ? (
              <div style={{ background: "#0a1518", border: "1px solid #1a3a3a", borderLeft: "3px solid #4ababa", padding: 12, marginTop: 10 }}>
                <SL c={<>ITEMS TO LOOK FOR<Tip text="These are the items needed for your hideout upgrade. Keep an eye out for them at each stop on the route." /></>} s={{ marginBottom: 8 }} />
                <div style={{ fontSize: 9, color: "#4ababa", marginBottom: 8 }}>{station.name} → Level {hideoutTarget.level}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {items.map((r, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: "#4ababa08", border: "1px solid #4ababa22" }}>
                      <span style={{ fontSize: 10, color: T.textBright }}>{r.item.name}</span>
                      <span style={{ fontSize: 9, color: "#4ababa", fontFamily: T.mono }}>×{r.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}
          {routeMode === "loot" && lootSubMode === "equipment" && targetEquipment.length > 0 && (
            <div style={{ background: "#1a1408", border: "1px solid #5a4a1a", borderLeft: "3px solid #ba8a4a", padding: 12, marginTop: 10 }}>
              <SL c={<>ITEMS TO LOOK FOR<Tip text="These are the items you're targeting this raid. Keep an eye out for them at each stop on the route." /></>} s={{ marginBottom: 8 }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {targetEquipment.map((item, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", background: "#ba8a4a08", border: "1px solid #ba8a4a22" }}>
                    <span style={{ fontSize: 10, color: T.textBright }}>{item.name}</span>
                    <span style={{ fontSize: 8, color: "#ba8a4a", fontFamily: T.mono }}>{(item.categories || []).filter(c => c.name !== "Item" && c.name !== "Compound item").map(c => c.name).slice(0, 2).join(" · ")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {screen === "postraid" && <PostRaidTracker route={route} myProfile={myProfile} onSave={handleSaveMyProgress} onClose={() => setScreen("route")} />}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "10px 14px" }}>
        <SL c={<>SQUAD RAID PLANNER<Tip text="Plan your squad's raid here. Select a map, import your teammates' codes, choose who's running, pick priority tasks and extracts, then generate an optimized route." /></>} s={{ marginBottom: 6 }} />
        {loading && <div style={{ fontSize: 9, color: T.textDim, marginBottom: 6 }}>Loading maps from tarkov.dev...</div>}
        {apiError && <div style={{ fontSize: 9, color: "#e05a5a", marginBottom: 6 }}>tarkov.dev unavailable — check connection</div>}
        {apiMaps && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: 4, paddingBottom: 6 }}>
            {apiMaps.map(m => <button key={m.id} onClick={() => setSelectedMapId(m.id)} style={{ background: selectedMapId === m.id ? T.gold + "22" : "transparent", border: `1px solid ${selectedMapId === m.id ? T.gold : T.border}`, color: selectedMapId === m.id ? T.gold : T.textDim, padding: "5px 4px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, textTransform: "uppercase", textAlign: "center" }}>{m.name}</button>)}
          </div>
        )}
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
              {["pmc", "scav"].map(f => <button key={f} onClick={() => setFaction(f)} style={{ flex: 1, background: faction === f ? (f === "pmc" ? "#0a1520" : "#0a1a0a") : "transparent", color: faction === f ? (f === "pmc" ? "#5ab0d0" : "#5dba5d") : T.textDim, border: "none", padding: 6, fontSize: 9, letterSpacing: 3, cursor: "pointer", textTransform: "uppercase", fontFamily: T.mono, fontWeight: "bold" }}>{f === "pmc" ? "▲ PMC" : "◆ SCAV"}</button>)}
            </div>
            <div style={{ display: "flex", marginTop: 6, border: `1px solid ${T.border}` }}>
              {[{id:"tasks",label:"★ TASKS",color:"#d4b84a"},{id:"loot",label:"◈ LOOT RUN",color:"#9a8aba"}].map(m => (
                <button key={m.id} onClick={() => setRouteMode(m.id)} style={{ flex: 1, background: routeMode === m.id ? m.color + "22" : "transparent", color: routeMode === m.id ? m.color : T.textDim, border: "none", padding: 6, fontSize: 9, letterSpacing: 2, cursor: "pointer", textTransform: "uppercase", fontFamily: T.mono, fontWeight: "bold" }}>{m.label}</button>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {/* Import squadmate */}
        <SL c={<>IMPORT SQUADMATE CODE<Tip step="STEP 1" text="Each squadmate copies their code from their My Profile tab and pastes it in Discord. Grab it and paste it here to import their profile and task list." /></>} />
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 10, marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: T.text, lineHeight: 1.6, marginBottom: 8 }}>Ask each squadmate to copy their code from My Profile and paste it in Discord.</div>
          <textarea value={importCode} onChange={e => setImportCode(e.target.value)} placeholder="Paste squadmate's TG2:... code here"
            style={{ width: "100%", background: "#0a0d10", border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "8px 10px", fontSize: 10, fontFamily: T.mono, outline: "none", boxSizing: "border-box", resize: "none", height: 52, lineHeight: 1.4, marginBottom: 8 }} />
          {importError && <div style={{ fontSize: 9, color: "#e05a5a", marginBottom: 6 }}>{importError}</div>}
          <button onClick={handleImport} disabled={!importCode.trim()} style={{ width: "100%", background: importCode.trim() ? "#0a1520" : "transparent", border: `1px solid ${importCode.trim() ? "#2a4a6a" : T.border}`, color: importCode.trim() ? "#5a9aba" : T.textDim, padding: "8px 0", fontSize: 9, cursor: importCode.trim() ? "pointer" : "default", fontFamily: T.mono, letterSpacing: 2, textTransform: "uppercase" }}>↓ IMPORT SQUADMATE</button>
        </div>

        {/* Players */}
        <SL c={<>SELECT WHO'S RUNNING THIS RAID<Tip step="STEP 2" text="Check the box next to each player joining this raid. In Tasks mode, pick a priority task per player. In Loot Run mode, the route hits all key loot spots on the map." /></>} />
        {allProfiles.map((p, idx) => {
          const isMe = idx === 0;
          const isActive = activeIds.has(p.id);
          const mapTasks = (p.tasks || []).filter(t => apiTasks?.find(at => at.id === t.taskId)?.map?.id === selectedMapId);
          return (
            <div key={p.id} style={{ background: isActive ? p.color + "10" : T.surface, border: `1px solid ${isActive ? p.color : (isMe ? T.borderBright : T.border)}`, borderLeft: `3px solid ${p.color}`, padding: 10, marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: isActive && selectedMapId && routeMode === "tasks" ? 8 : 0 }}>
                <button onClick={() => toggleActive(p.id)} style={{ width: 20, height: 20, background: isActive ? p.color : "transparent", border: `1px solid ${p.color}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: isActive ? T.bg : T.textDim, fontSize: 12, flexShrink: 0 }}>{isActive ? "✓" : ""}</button>
                <div style={{ flex: 1 }}>
                  <div style={{ color: p.color, fontSize: 12, fontWeight: "bold" }}>{p.name || "(no name)"}{isMe && <span style={{ fontSize: 8, color: T.textDim, fontWeight: "normal", marginLeft: 5 }}>YOU</span>}</div>
                  {!isMe && <div style={{ fontSize: 8, color: T.textDim }}>Imported {new Date(p.importedAt).toLocaleDateString()} · {p.tasks?.length || 0} tasks</div>}
                </div>
                <Badge label={`${p.tasks?.length || 0} tasks`} color={p.color} />
                {!isMe && <button onClick={() => { saveImportedSquad(importedSquad.filter(x => x.id !== p.id)); setActiveIds(prev => { const n = new Set(prev); n.delete(p.id); return n; }); }} style={{ background: "transparent", border: "none", color: "#6a3a3a", cursor: "pointer", fontSize: 13, padding: "0 2px" }}>×</button>}
              </div>
              {isActive && selectedMapId && routeMode === "tasks" && (
                <>
                  <div style={{ fontSize: 8, color: T.textDim, letterSpacing: 2, marginBottom: 5 }}>PRIORITY TASK THIS RAID:</div>
                  {mapTasks.length === 0 ? (
                    <div style={{ fontSize: 9, color: T.textDim }}>No tasks for this map{isMe ? " — add them in My Profile." : "."}</div>
                  ) : mapTasks.map(t => {
                    const at = apiTasks?.find(x => x.id === t.taskId); if (!at) return null;
                    const isPri = priorityTasks[p.id] === t.taskId;
                    return <button key={t.taskId} onClick={() => setPriorityTasks(pt => ({ ...pt, [p.id]: t.taskId }))} style={{ width: "100%", background: isPri ? p.color + "22" : "transparent", border: `1px solid ${isPri ? p.color : T.border}`, color: isPri ? p.color : T.textDim, padding: "6px 8px", textAlign: "left", cursor: "pointer", fontFamily: T.mono, fontSize: 9, marginBottom: 4 }}>{isPri ? "★ " : ""}{at.name}</button>;
                  })}
                </>
              )}
            </div>
          );
        })}

        {importedSquad.length === 0 && <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: "14px 10px", textAlign: "center", marginBottom: 12 }}><div style={{ fontSize: 10, color: T.textDim }}>No squadmates imported yet.<br />Paste their codes above.</div></div>}

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
                {id:"all",label:"ALL LOOT",color:"#9a8aba"},
                {id:"hideout",label:"HIDEOUT",color:"#4ababa",disabled:!hasHideout},
                {id:"equipment",label:"EQUIPMENT",color:"#ba8a4a"},
              ].map(m => (
                <button key={m.id} onClick={() => !m.disabled && setLootSubMode(m.id)} style={{
                  flex: 1, padding: "6px 4px", fontSize: 8, letterSpacing: 1, fontFamily: T.mono,
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
                <div style={{ fontSize: 9, color: T.textDim }}>Set a hideout target in My Profile → Hideout first.</div>
              </div>
            )}
            {lootSubMode === "hideout" && hasHideout && (() => {
              const station = apiHideout.find(s => s.id === hideoutTarget.stationId);
              const level = station?.levels.find(l => l.level === hideoutTarget.level);
              return station && level ? (
                <div style={{ background: "#0a1518", border: "1px solid #1a3a3a", borderLeft: "3px solid #4ababa", padding: "8px 10px", marginBottom: 8 }}>
                  <div style={{ fontSize: 8, letterSpacing: 2, color: "#4ababa", marginBottom: 3 }}>TARGETING ITEMS FOR:</div>
                  <div style={{ fontSize: 11, color: T.textBright, fontWeight: "bold", marginBottom: 4 }}>{station.name} → Level {hideoutTarget.level}</div>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {level.itemRequirements.filter(r => r.item.name !== "Roubles").map((r, i) => (
                      <div key={i} style={{ fontSize: 8, color: "#4ababa", background: "#4ababa15", border: "1px solid #4ababa33", padding: "2px 6px" }}>
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
                <div style={{ background: "#1a1408", border: "1px solid #5a4a1a", borderLeft: "3px solid #ba8a4a", padding: "8px 10px", marginBottom: 8 }}>
                  <div style={{ fontSize: 8, letterSpacing: 2, color: "#ba8a4a", marginBottom: 4 }}>TARGET EQUIPMENT<Tip text="Search for any item — weapons, armor, barter goods, keys, etc. The route will only visit locations likely to contain your targeted items." /></div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input value={equipSearch} onChange={e => setEquipSearch(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && searchEquipment(equipSearch)}
                      placeholder="Search items (e.g. AK-74, Slick, GPU)..."
                      style={{ flex: 1, background: "#0a0d10", border: `1px solid ${T.borderBright}`, color: T.textBright, padding: "6px 8px", fontSize: 10, fontFamily: T.mono, outline: "none", boxSizing: "border-box" }} />
                    <button onClick={() => searchEquipment(equipSearch)}
                      style={{ background: "#ba8a4a22", border: "1px solid #ba8a4a", color: "#ba8a4a", padding: "6px 10px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1, flexShrink: 0 }}>SEARCH</button>
                  </div>
                </div>

                {/* Search results */}
                {equipSearching && <div style={{ fontSize: 9, color: T.textDim, textAlign: "center", padding: 8 }}>Searching tarkov.dev...</div>}
                {equipResults && !equipSearching && (
                  <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
                    {equipResults.length === 0 && <div style={{ fontSize: 9, color: T.textDim, textAlign: "center", padding: 8 }}>No items found.</div>}
                    {equipResults.map(item => {
                      const added = targetEquipment.some(e => e.id === item.id);
                      return (
                        <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", marginBottom: 2, background: added ? "#ba8a4a15" : T.surface, border: `1px solid ${added ? "#ba8a4a44" : T.border}` }}>
                          <div>
                            <div style={{ fontSize: 10, color: T.textBright }}>{item.name}</div>
                            <div style={{ fontSize: 8, color: T.textDim }}>{item.categories?.map(c => c.name).filter(n => n !== "Item" && n !== "Compound item").slice(0, 3).join(" · ")}</div>
                          </div>
                          <button onClick={() => {
                            if (added) saveTargetEquipment(targetEquipment.filter(e => e.id !== item.id));
                            else saveTargetEquipment([...targetEquipment, { id: item.id, name: item.name, shortName: item.shortName, categories: item.categories }]);
                          }} style={{ background: added ? "#1a0a0a" : "transparent", border: `1px solid ${added ? "#6a2a2a" : "#ba8a4a"}`, color: added ? "#e05a5a" : "#ba8a4a", padding: "3px 8px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, flexShrink: 0 }}>
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
                    <div style={{ fontSize: 8, letterSpacing: 2, color: "#ba8a4a", marginBottom: 4 }}>TARGETING {targetEquipment.length} ITEM{targetEquipment.length !== 1 ? "S" : ""}:</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
                      {targetEquipment.map(item => (
                        <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 4, background: "#ba8a4a15", border: "1px solid #ba8a4a33", padding: "3px 6px" }}>
                          <span style={{ fontSize: 9, color: "#ba8a4a" }}>{item.shortName || item.name}</span>
                          <button onClick={() => saveTargetEquipment(targetEquipment.filter(e => e.id !== item.id))}
                            style={{ background: "transparent", border: "none", color: "#6a3a3a", cursor: "pointer", fontSize: 10, padding: 0 }}>×</button>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => saveTargetEquipment([])}
                      style={{ background: "transparent", border: `1px solid #6a2a2a`, color: "#e05a5a", padding: "3px 8px", fontSize: 7, cursor: "pointer", fontFamily: T.mono, letterSpacing: 1 }}>CLEAR ALL</button>
                  </div>
                )}
                {targetEquipment.length === 0 && !equipResults && (
                  <div style={{ fontSize: 9, color: T.textDim, textAlign: "center", padding: 8 }}>Search and add items you want to find in raid.</div>
                )}
              </div>
            )}

            <div style={{ background: "#0f0a18", border: "1px solid #4a3a6a", borderLeft: "3px solid #9a8aba", padding: "10px 12px", marginBottom: 10 }}>
              <div style={{ fontSize: 9, color: "#9a8aba", letterSpacing: 3, marginBottom: 4 }}>◈ {lootSubMode === "hideout" ? "HIDEOUT" : lootSubMode === "equipment" ? "EQUIPMENT" : "LOOT"} RUN — {emap.name.toUpperCase()}<Tip text="ALL hits every loot spot. HIDEOUT filters to spots matching your hideout upgrade needs. EQUIPMENT filters to spots matching your targeted items." /></div>
              <div style={{ fontSize: 10, color: T.text, lineHeight: 1.7 }}>
                Route will hit {filteredLP.length} of {emap.lootPoints?.length || 0} loot locations{lootSubMode !== "all" ? " (filtered)" : ""}, ending at your chosen extract.
              </div>
            </div>
            {filteredLP.map((lp, i) => {
              const lc = LOOT_CONFIG[lp.type] || LOOT_CONFIG.mixed;
              return (
                <div key={i} style={{ background: lc.bg, border: `1px solid ${lc.border}`, borderLeft: `3px solid ${lc.color}`, padding: "7px 10px", marginBottom: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 10, color: T.textBright, fontWeight: "bold" }}>{lc.icon} {lp.name}</div>
                    <div style={{ fontSize: 7, color: lc.color, letterSpacing: 1, background: lc.border + "44", padding: "2px 6px" }}>{lc.label.toUpperCase()}</div>
                  </div>
                  <div style={{ fontSize: 9, color: lc.color, marginTop: 3 }}>{lp.note}</div>
                </div>
              );
            })}
            {filteredLP.length === 0 && (
              <div style={{ background: T.surface, border: `1px dashed ${T.border}`, padding: 14, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.textDim }}>No matching loot locations on this map for your {lootSubMode === "hideout" ? "hideout target" : "targeted items"}.</div>
              </div>
            )}
          </div>
          );
        })()}

        {/* ── EXTRACT SELECTION ── */}
        {selectedMapId && emap && activeIds.size > 0 && (
          <div style={{ marginTop: 8, marginBottom: 14 }}>
            <div style={{ background: "#0a0d18", border: "1px solid #2a3a5a", borderLeft: "3px solid #5a7aba", padding: "10px 12px", marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: "#5a7aba", letterSpacing: 3, marginBottom: 4 }}>⬆ EXTRACT SELECTION<Tip step={routeMode === "tasks" ? "STEP 3" : "STEP 3"} text="Pick each player's intended extract. Special extracts (key, paracord, etc.) will ask if you have the required items. Your chosen extract becomes the final stop on the route." /></div>
              <div style={{ fontSize: 10, color: T.text, lineHeight: 1.7 }}>
                Extracts are only revealed when the raid loads — but you can plan ahead. Select your intended exit now. Special extracts will ask if you have required items before adding them to the route.
              </div>
            </div>
            {[...activeIds].map(pid => {
              const p = allProfiles.find(x => x.id === pid); if (!p) return null;
              return (
                <div key={pid} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 8, color: p.color, letterSpacing: 2, marginBottom: 5, fontFamily: T.mono }}>
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

        {/* Generate */}
        <button onClick={generateRoute} disabled={!canGenerate}
          style={{ width: "100%", background: canGenerate ? (routeMode === "loot" ? "#9a8aba" : T.gold) : "transparent", color: canGenerate ? T.bg : T.textDim, border: `1px solid ${canGenerate ? (routeMode === "loot" ? "#9a8aba" : T.gold) : T.border}`, padding: "13px 0", fontSize: 11, letterSpacing: 3, cursor: canGenerate ? "pointer" : "default", fontFamily: T.mono, textTransform: "uppercase", fontWeight: "bold", marginBottom: 8 }}>
          ▶ {routeMode === "loot" ? (lootSubMode === "hideout" ? "GENERATE HIDEOUT RUN" : lootSubMode === "equipment" ? "GENERATE EQUIPMENT RUN" : "GENERATE LOOT RUN") : "GENERATE ROUTE"}{activeIds.size > 0 ? ` — ${activeIds.size} PLAYER${activeIds.size > 1 ? "S" : ""}` : ""}
        </button>
        {!selectedMapId && <div style={{ fontSize: 9, color: T.textDim, textAlign: "center", fontFamily: T.mono, marginBottom: 4 }}>Select a map above to get started</div>}
        {routeMode === "tasks" && selectedMapId && activeIds.size > 0 && ![...activeIds].some(id => priorityTasks[id]) && <div style={{ fontSize: 9, color: T.textDim, textAlign: "center", fontFamily: T.mono, marginBottom: 4 }}>Select a priority task for at least one active player</div>}

        <div style={{ marginTop: 12, background: T.surface, border: "1px solid #1a2a3a", borderLeft: "3px solid #2a4a6a", padding: 10 }}>
          <div style={{ fontSize: 9, color: "#5a7aba", lineHeight: 1.8 }}>{routeMode === "loot" ? "◈ Loot positions are approximate — use tarkov.dev for exact locations." : "ℹ Task data live from tarkov.dev — always current patch."}<br />Extract positions are approximate — exact locations shown on tarkov.dev.{routeMode === "tasks" && <><br />Reshare your code after completing tasks.</>}</div>
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
          {["extracts", "roadmap"].map(v => <Btn key={v} ch={v} onClick={() => setSv(v)} active={sv === v} />)}
        </div>
        {sv === "extracts" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: 4, paddingBottom: 10 }}>
            {EMAPS.map(m => <button key={m.id} onClick={() => { setSel(m); setFil("all"); }} style={{ background: sel.id === m.id ? m.color + "22" : "transparent", border: `1px solid ${sel.id === m.id ? m.color : T.border}`, color: sel.id === m.id ? m.color : T.textDim, padding: "5px 4px", fontSize: 8, cursor: "pointer", fontFamily: T.mono, textTransform: "uppercase", textAlign: "center" }}>{m.name}</button>)}
          </div>
          <div style={{ display: "flex", marginBottom: 10, border: `1px solid ${T.border}` }}>
            {["pmc", "scav"].map(f => <button key={f} onClick={() => { setFac(f); setFil("all"); }} style={{ flex: 1, background: fac === f ? (f === "pmc" ? "#0a1520" : "#0a1a0a") : "transparent", color: fac === f ? (f === "pmc" ? "#5ab0d0" : "#5dba5d") : T.textDim, border: "none", padding: 7, fontSize: 9, letterSpacing: 3, cursor: "pointer", textTransform: "uppercase", fontFamily: T.mono, fontWeight: "bold" }}>{f === "pmc" ? "▲ PMC" : "◆ SCAV"}</button>)}
          </div>
        </>}
      </div>
      <div style={{ overflowY: "auto", flex: 1, padding: 14 }}>
        {sv === "roadmap" && <>
          <div style={{ background: "#0a1a0a", border: "1px solid #1a3a1a", borderLeft: "3px solid #4a9a4a", padding: "10px 12px", marginBottom: 14, fontSize: 10, color: "#7ab87a", lineHeight: 1.7 }}>⚔ PvE — Co-op extracts N/A. Difficulty = boss/Raider danger.</div>
          {["Beginner", "Intermediate", "Advanced", "Endgame"].map(tier => (
            <div key={tier} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 8, letterSpacing: 4, color: TC[tier], borderBottom: `1px solid ${TC[tier]}33`, paddingBottom: 5, marginBottom: 8, fontFamily: T.mono }}>{tier.toUpperCase()}</div>
              {EMAPS.filter(m => m.tier === tier).map(map => (
                <div key={map.id} onClick={() => { setSel(map); setSv("extracts"); setFil("all"); }} style={{ background: T.surface, border: `1px solid ${map.color}33`, borderLeft: `3px solid ${map.color}`, padding: 10, marginBottom: 7, cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}><div style={{ color: map.color, fontSize: 12, fontWeight: "bold" }}>{map.name}</div><div style={{ fontSize: 9, color: T.textDim }}>{"★".repeat(map.diff)}{"☆".repeat(5 - map.diff)}</div></div>
                  <div style={{ fontSize: 10, color: T.textDim, lineHeight: 1.5, marginBottom: 5 }}>{map.desc}</div>
                  <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 5 }}>{map.bosses.map((b, i) => <div key={i} style={{ fontSize: 9, color: "#9a3a3a", marginBottom: 2 }}>☠ {b}</div>)}</div>
                </div>
              ))}
            </div>
          ))}
        </>}
        {sv === "extracts" && <>
          <div style={{ background: T.surface, border: `1px solid ${sel.color}33`, borderLeft: `3px solid ${sel.color}`, padding: 10, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ color: sel.color, fontSize: 14, fontWeight: "bold" }}>{sel.name}</div><Badge label={sel.tier} color={TC[sel.tier]} /></div>
            <div style={{ fontSize: 10, color: T.textDim, margin: "5px 0 7px", lineHeight: 1.5 }}>{sel.desc}</div>
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 6 }}>{sel.bosses.map((b, i) => <div key={i} style={{ fontSize: 9, color: "#9a3a3a", marginBottom: 2 }}>☠ {b}</div>)}</div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <SL c="FILTER" s={{ marginBottom: 6 }} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              <Btn ch={`All (${exts.length})`} small active={fil === "all"} onClick={() => setFil("all")} />
              {types.map(t => { const c = ET_CONFIG[t]; return <button key={t} onClick={() => setFil(t)} style={{ background: fil === t ? c.bg : "transparent", color: fil === t ? c.color : T.textDim, border: `1px solid ${fil === t ? c.border : T.border}`, padding: "4px 8px", fontSize: 8, cursor: "pointer", fontFamily: T.mono }}>{c.icon} {exts.filter(e => e.type === t).length}</button>; })}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map((ext, i) => {
              const c = ET_CONFIG[ext.type]; const dead = ext.type === "coop";
              return (
                <div key={i} style={{ background: c.bg, border: `1px solid ${c.border}`, borderLeft: `3px solid ${c.color}`, padding: 10, opacity: dead ? 0.5 : 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ color: dead ? "#444" : T.textBright, fontSize: 12, fontWeight: "bold", flex: 1, textDecoration: dead ? "line-through" : "none" }}>{ext.name}</div>
                    <div style={{ background: c.border + "44", color: c.color, fontSize: 7, letterSpacing: 1, padding: "2px 6px", whiteSpace: "nowrap", marginLeft: 8 }}>{c.icon} {c.label.toUpperCase()}</div>
                  </div>
                  <div style={{ marginTop: 5, fontSize: 10, color: dead ? "#444" : c.color, lineHeight: 1.5 }}>{ext.note}</div>
                  {ext.requireItems?.length > 0 && (
                    <div style={{ marginTop: 7, paddingTop: 6, borderTop: `1px solid ${c.border}44` }}>
                      <div style={{ fontSize: 8, color: T.textDim, letterSpacing: 2, marginBottom: 4 }}>REQUIRED ITEMS:</div>
                      {ext.requireItems.map(item => <div key={item} style={{ fontSize: 9, color: c.color, marginBottom: 2 }}>• {item}</div>)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, padding: 10, border: `1px solid ${T.border}`, background: T.surface }}>
            <SL c={<>LEGEND<Tip text="Open extracts are always available. Key extracts need a specific key. Pay extracts cost roubles. Special extracts require items like a Red Rebel or Paracord. Co-op extracts are disabled in PvE." /></>} s={{ marginBottom: 7 }} />
            {Object.entries(ET_CONFIG).map(([t, c]) => <div key={t} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><div style={{ width: 6, height: 6, background: c.border, flexShrink: 0 }} /><div style={{ fontSize: 10, color: c.color, width: 14 }}>{c.icon}</div><div style={{ fontSize: 9, color: t === "coop" ? "#444" : T.textDim }}>{c.label}</div></div>)}
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
          <Btn ch="Install App" active={section === "install"} onClick={() => setSection("install")} color="#5a9aba" />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {section === "install" && (
          <div>
            <div style={{ background: T.surface, border: "1px solid #2a4a6a", borderLeft: "3px solid #5a9aba", padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#5a9aba", fontWeight: "bold", marginBottom: 8 }}>Install as a native-feeling app</div>
              <div style={{ fontSize: 10, color: T.text, lineHeight: 1.8 }}>Add this app to your home screen. Runs full-screen, appears in your app launcher — no app store required.</div>
            </div>
            {[
              { platform: "iPhone / iPad", color: "#8a8aba", steps: ["Open this page in Safari (must be Safari, not Chrome)", "Tap the Share icon (box with arrow pointing up)", "Scroll down and tap Add to Home Screen", "Name it Tarkov Guide and tap Add"] },
              { platform: "Android", color: "#5aba8a", steps: ["Open this page in Chrome", "Tap the ⋮ menu (top-right)", "Tap Add to Home screen or Install app", "Tap Add or Install to confirm"] },
              { platform: "Windows / Mac (Chrome or Edge)", color: "#c8a84b", steps: ["Open this page in Chrome or Edge", "Look for the install icon (⊕) in the address bar", "Or: ⋮ menu → Save and share → Install page as app", "Name it Tarkov Guide and click Install"] },
            ].map(({ platform, color, steps }) => (
              <div key={platform} style={{ background: T.surface, border: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, padding: 12, marginBottom: 10 }}>
                <div style={{ color, fontSize: 11, fontWeight: "bold", marginBottom: 8 }}>{platform}</div>
                {steps.map((s, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 5, alignItems: "flex-start" }}><div style={{ background: color + "22", color, width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, flexShrink: 0, fontFamily: T.mono }}>{i + 1}</div><div style={{ fontSize: 10, color: T.text, lineHeight: 1.5 }}>{s}</div></div>)}
              </div>
            ))}
            <div style={{ background: "#0a1a0a", border: "1px solid #1a3a1a", borderLeft: "3px solid #4a9a4a", padding: 10 }}>
              <div style={{ fontSize: 9, color: "#5dba5d", lineHeight: 1.8 }}>✓ No app store · ✓ Progress saved on device · ✓ Share codes work phone ↔ desktop · ✓ Live tarkov.dev data</div>
            </div>
          </div>
        )}
        {section === "maps" && <>
          <SL c={<>INTERACTIVE MAPS — ALL SOURCES<Tip text="Quick links to the best interactive maps for each location. Open them in a second tab while planning your raid." /></>} />
          {EMAPS.map(map => (
            <div key={map.id} style={{ background: T.surface, border: `1px solid ${map.color}22`, borderLeft: `3px solid ${map.color}`, padding: 10, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><div style={{ color: map.color, fontSize: 12, fontWeight: "bold" }}>{map.name}</div><Badge label={map.tier} color={TC[map.tier]} /></div>
              <div style={{ display: "flex", gap: 6 }}>
                <a href={map.tarkovdev} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: "#080d14", border: "1px solid #1a2a3a", color: "#5a8aba", padding: "8px 0", fontSize: 8, letterSpacing: 1, textDecoration: "none", fontFamily: T.mono, textTransform: "uppercase", textAlign: "center" }}>tarkov.dev</a>
                <a href={map.mapgenie} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: "#0a1318", border: "1px solid #1a3a4a", color: "#4a7a9a", padding: "8px 0", fontSize: 8, letterSpacing: 1, textDecoration: "none", fontFamily: T.mono, textTransform: "uppercase", textAlign: "center" }}>mapgenie</a>
                <a href={map.wiki} target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", background: "#12100a", border: `1px solid ${map.color}33`, color: map.color, padding: "8px 0", fontSize: 8, letterSpacing: 1, textDecoration: "none", fontFamily: T.mono, textTransform: "uppercase", textAlign: "center" }}>wiki</a>
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
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(7,9,11,0.96)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: T.surface, border: `1px solid ${T.borderBright}`, borderLeft: `3px solid ${T.gold}`, padding: 20, maxWidth: 340 }}>
        <div style={{ fontSize: 9, letterSpacing: 4, color: T.gold, marginBottom: 8 }}>FIELD GUIDE v6</div>
        <div style={{ fontSize: 15, color: T.textBright, fontWeight: "bold", marginBottom: 10 }}>Tarkov PvE Squad Guide</div>
        <div style={{ fontSize: 11, color: T.text, lineHeight: 1.8, marginBottom: 14 }}>Each player manages their own profile. Share a code before raids — no squad secretary needed.</div>
        {["✓ Set your name + tasks in My Profile", "✓ Copy your code → paste it in Discord", "✓ Squad tab: paste teammates' codes, select map", "✓ Pick your intended extract — item checks included", "✓ Generate route: objectives optimized, extract last", "✓ Post-raid updates only your own progress", "✓ Install as home screen app — see Maps tab"].map((t, i) => <div key={i} style={{ fontSize: 10, color: "#5dba5d", marginBottom: 4 }}>{t}</div>)}
        <button onClick={onDismiss} style={{ width: "100%", background: T.gold, color: T.bg, border: "none", padding: "11px 0", fontSize: 10, letterSpacing: 3, cursor: "pointer", fontFamily: T.mono, textTransform: "uppercase", fontWeight: "bold", marginTop: 14 }}>ENTER FIELD GUIDE</button>
      </div>
    </div>
  );
}

function BottomNav({ tab, setTab }) {
  const items = [{ id: "profile", label: "My Profile", icon: "▲" }, { id: "squad", label: "Squad", icon: "◈" }, { id: "extracts", label: "Extracts", icon: "⬆" }, { id: "maps", label: "Maps", icon: "🗺" }];
  return (
    <div style={{ display: "flex", borderTop: `1px solid ${T.borderBright}`, background: T.surface, flexShrink: 0 }}>
      {items.map(item => <button key={item.id} onClick={() => setTab(item.id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "8px 2px 6px", background: tab === item.id ? "#0f1a0f" : "transparent", border: "none", cursor: "pointer", borderTop: `2px solid ${tab === item.id ? T.gold : "transparent"}` }}><span style={{ fontSize: 13, marginBottom: 2 }}>{item.icon}</span><span style={{ fontSize: 6, letterSpacing: 1, fontFamily: T.mono, textTransform: "uppercase", color: tab === item.id ? T.gold : T.textDim }}>{item.label}</span></button>)}
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
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState(false);
  const [hideoutLevels, saveHideoutLevels] = useStorage("tg-hideout-v1", {});
  const [hideoutTarget, saveHideoutTarget] = useStorage("tg-hideout-target-v1", null);

  useEffect(() => {
    if (apiMaps || apiLoading) return;
    setApiLoading(true);
    (async () => {
      try {
        const [mData, tData, hData] = await Promise.all([fetchAPI(MAPS_Q), fetchAPI(TASKS_Q), fetchAPI(HIDEOUT_Q)]);
        const playable = ["customs", "factory", "woods", "interchange", "shoreline", "reserve", "lighthouse", "streets-of-tarkov", "the-lab", "ground-zero"];
        setApiMaps((mData?.maps || []).filter(m => playable.includes(m.normalizedName)));
        setApiTasks(tData?.tasks || []);
        setApiHideout(hData?.hideoutStations || []);
      } catch (e) { setApiError(true); }
      setApiLoading(false);
    })();
  }, []);

  const [welcomed, saveWelcomed] = useStorage("tg-welcomed-v6", false);
  const [showWelcome, setShowWelcome] = useState(false);
  useEffect(() => { if (profileReady && !welcomed) setShowWelcome(true); }, [profileReady, welcomed]);

  // Scale factor: at 480px viewport the app renders at 1x, scales up linearly to fill wider screens
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => { const h = () => setWinW(window.innerWidth); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, []);
  const scale = Math.max(1, Math.min(winW / 480, 2.5));

  return (
    <div style={{ height: `${100 / scale}vh`, background: T.bg, color: T.text, fontFamily: T.mono, maxWidth: 480, margin: "0 auto", display: "flex", flexDirection: "column", overflow: "hidden", position: "relative", zoom: scale }}>
      {showWelcome && <WelcomeBanner onDismiss={() => { setShowWelcome(false); saveWelcomed(true); }} />}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.borderBright}`, padding: "10px 14px 8px", flexShrink: 0 }}>
        <div style={{ fontSize: 8, letterSpacing: 4, color: T.textDim, marginBottom: 2 }}>PvE FIELD REFERENCE</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 17, fontWeight: "bold", color: T.gold, letterSpacing: 3 }}>TARKOV GUIDE</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {myProfile.name && <div style={{ fontSize: 9, color: myProfile.color, fontFamily: T.mono }}>{myProfile.name}</div>}
            <div style={{ fontSize: 8, color: apiError ? "#6a2a2a" : "#2a5a2a", display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: apiError ? "#8a3a3a" : "#3a8a3a" }} />
              {apiError ? "OFFLINE" : "LIVE DATA"}
            </div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {tab === "profile" && <MyProfileTab myProfile={myProfile} saveMyProfile={saveMyProfile} apiTasks={apiTasks} loading={apiLoading} apiError={apiError} apiHideout={apiHideout} hideoutLevels={hideoutLevels} saveHideoutLevels={saveHideoutLevels} hideoutTarget={hideoutTarget} saveHideoutTarget={saveHideoutTarget} />}
        {tab === "squad" && <SquadTab myProfile={myProfile} saveMyProfile={saveMyProfile} apiMaps={apiMaps} apiTasks={apiTasks} loading={apiLoading} apiError={apiError} hideoutTarget={hideoutTarget} apiHideout={apiHideout} />}
        {tab === "extracts" && <ExtractsTab />}
        {tab === "maps" && <MapsTab />}
      </div>
      <BottomNav tab={tab} setTab={setTab} />
    </div>
  );
}
