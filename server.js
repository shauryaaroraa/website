// ============================================================
//  Casino Backend — server.js
//  Express + SQLite + JWT + Real Crypto Wallets
// ============================================================
'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const axios      = require('axios');
const { DatabaseSync: Database } = require('node:sqlite');
const { ethers } = require('ethers');

// ── Solana ───────────────────────────────────────────────────
const solanaWeb3 = require('@solana/web3.js');
const splToken   = require('@solana/spl-token');

// ETH deposit confirmation threshold
const ETH_CONFIRMATIONS_REQUIRED = 3;

// ── Constants ────────────────────────────────────────────────
const PORT            = process.env.PORT            || 3001;
const JWT_SECRET      = process.env.JWT_SECRET      || 'dev_secret_change_me';
const COINS_PER_DOLLAR = Number(process.env.COINS_PER_DOLLAR || 2000);
const ENC_KEY         = (process.env.ENCRYPTION_KEY || 'default_32_char_key_placeholder').slice(0, 32).padEnd(32, '0');

// ERC-20 minimal ABI (just transfer + balanceOf)
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

// ── Database ─────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'casino.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    UNIQUE NOT NULL,
    password    TEXT    NOT NULL,
    balance     INTEGER NOT NULL DEFAULT 0,
    is_admin    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS deposit_addresses (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    chain           TEXT    NOT NULL,   -- 'ETH','SOL','LTC'
    address         TEXT    NOT NULL,
    encrypted_key   TEXT    NOT NULL,
    key_iv          TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, chain)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    type        TEXT    NOT NULL,   -- 'deposit','withdrawal','game'
    chain       TEXT,
    token       TEXT,
    amount_usd  REAL,
    coins_delta INTEGER NOT NULL,
    tx_hash     TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending',
    note        TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS seen_txhashes (
    tx_hash     TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Add last_sol_balance column if it doesn't exist yet (idempotent migration)
try { db.exec('ALTER TABLE deposit_addresses ADD COLUMN last_sol_balance INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE deposit_addresses ADD COLUMN last_eth_balance TEXT NOT NULL DEFAULT "0"'); } catch (_) {}

// ── Battles table ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS battles (
    id            TEXT    PRIMARY KEY,
    creator_id    INTEGER NOT NULL REFERENCES users(id),
    fmt           TEXT    NOT NULL DEFAULT '1v1',
    mode          TEXT    NOT NULL DEFAULT 'normal',
    game_mode     TEXT    NOT NULL DEFAULT 'classic',
    cost          INTEGER NOT NULL DEFAULT 0,
    rounds        INTEGER NOT NULL DEFAULT 1,
    current_round INTEGER NOT NULL DEFAULT 0,
    players       TEXT    NOT NULL DEFAULT '[]',
    cases         TEXT    NOT NULL DEFAULT '[]',
    active        INTEGER NOT NULL DEFAULT 1,
    finished_at   TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);
// Idempotent migration for existing DBs
try { db.exec('ALTER TABLE battles ADD COLUMN current_round INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

// ── Battle events (round-by-round results for spectators) ─────
db.exec(`
  CREATE TABLE IF NOT EXISTS battle_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    battle_id    TEXT    NOT NULL,
    round        INTEGER NOT NULL,
    player_idx   INTEGER NOT NULL,
    item_name    TEXT    NOT NULL DEFAULT '',
    item_val     REAL    NOT NULL DEFAULT 0,
    item_icon    TEXT    NOT NULL DEFAULT '📦',
    item_image_id TEXT   NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_battle_events_battle_id ON battle_events(battle_id);
`);

// ── Provably Fair tables ──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pf_sessions (
    id            TEXT    PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    server_seed   TEXT    NOT NULL,
    server_seed_hash TEXT NOT NULL,
    client_seed   TEXT    NOT NULL DEFAULT 'default',
    nonce         INTEGER NOT NULL DEFAULT 0,
    revealed      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pf_sessions_user ON pf_sessions(user_id, revealed);
`);

// ── Bet history table ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    game        TEXT    NOT NULL,
    bet_amount  INTEGER NOT NULL,
    payout      INTEGER NOT NULL DEFAULT 0,
    profit      INTEGER NOT NULL DEFAULT 0,
    multiplier  REAL    NOT NULL DEFAULT 0,
    won         INTEGER NOT NULL DEFAULT 0,
    detail      TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, created_at DESC);
`);

// ── Cases tables ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    icon       TEXT    NOT NULL DEFAULT '📦',
    price      INTEGER NOT NULL DEFAULT 1000,
    box_style  INTEGER NOT NULL DEFAULT 1,
    c1         TEXT    NOT NULL DEFAULT '#1A1A3A',
    c2         TEXT    NOT NULL DEFAULT '#0A0A18',
    glow       TEXT    NOT NULL DEFAULT '#7B68EE',
    active     INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS case_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    icon       TEXT    NOT NULL DEFAULT '📦',
    name       TEXT    NOT NULL,
    val        REAL    NOT NULL DEFAULT 100,
    pct        REAL    NOT NULL DEFAULT 10,
    ltd        INTEGER NOT NULL DEFAULT 0,
    image_id   TEXT    NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
`);

// ── Seed default cases (runs once if table is empty) ─────────
(function seedCases() {
  if (db.prepare('SELECT COUNT(*) as n FROM cases').get().n > 0) return;
  const defaultCases = [
    {name:'GrindR',icon:'⚙️',price:2930,box_style:4,c1:'#2A0A4A',c2:'#0D0618',glow:'#CC44FF',items:[
      {icon:'🎩',name:'Domino Crown',val:25600,pct:10,ltd:1,image_id:''},
      {icon:'🎄',name:'Elf Shades',val:155,pct:15,ltd:0,image_id:''},
      {icon:'💀',name:'Headless Head',val:145,pct:34,ltd:0,image_id:''},
      {icon:'📦',name:'Korblox Leg',val:134,pct:10,ltd:1,image_id:''},
      {icon:'🍗',name:'Lazer Shades',val:99,pct:16,ltd:0,image_id:''},
      {icon:'🧢',name:'Visor',val:12,pct:15,ltd:0,image_id:''},
    ]},
    {name:'Tiger Strikes',icon:'🐯',price:1538,box_style:1,c1:'#1A3A6A',c2:'#0A1A3A',glow:'#00AAFF',items:[
      {icon:'🦍',name:'When Animals Attack: Gorilla Grievance',val:7277,pct:15,ltd:1,image_id:'23301616'},
      {icon:'🗡️',name:'Bighead',val:1734,pct:10,ltd:0,image_id:''},
      {icon:'🎩',name:'Sparkling Top Hat',val:1546,pct:5,ltd:0,image_id:''},
      {icon:'🥚',name:'Pal Hat',val:80,pct:70,ltd:0,image_id:''},
    ]},
    {name:'Winter Chest',icon:'❄️',price:2553,box_style:1,c1:'#102040',c2:'#060C18',glow:'#88CCFF',items:[
      {icon:'🌨️',name:'Frost Guard Gen',val:14800,pct:12,ltd:1,image_id:''},
      {icon:'⛄',name:'Arctic Armor',val:3200,pct:10,ltd:0,image_id:''},
      {icon:'🧊',name:'Ice Antlers',val:890,pct:22,ltd:0,image_id:''},
      {icon:'🎿',name:'Ski Goggles',val:210,pct:20,ltd:0,image_id:''},
      {icon:'❄️',name:'Snowy Cap',val:88,pct:36,ltd:0,image_id:''},
    ]},
    {name:'Shark Crate',icon:'🦈',price:1431,box_style:1,c1:'#0A2040',c2:'#050F1E',glow:'#0088CC',items:[
      {icon:'🌊',name:'Bluesteel Sharkbite',val:7200,pct:13,ltd:1,image_id:''},
      {icon:'🦈',name:'Shark Fin',val:2100,pct:12,ltd:0,image_id:''},
      {icon:'💧',name:'Blue Shutter Shades',val:620,pct:24,ltd:0,image_id:''},
      {icon:'🐟',name:'Fisherman Hat',val:95,pct:51,ltd:0,image_id:''},
    ]},
    {name:'Guitar Shop',icon:'🎸',price:1634,box_style:1,c1:'#1A3A6A',c2:'#0A1A3A',glow:'#00AAFF',items:[
      {icon:'🎸',name:'Perfectly Legitimate',val:9800,pct:12,ltd:1,image_id:''},
      {icon:'🎵',name:'Golden Headphones',val:2200,pct:10,ltd:0,image_id:''},
      {icon:'🎼',name:'Rock Star Wings',val:680,pct:22,ltd:0,image_id:''},
      {icon:'🎺',name:'Band Hat',val:190,pct:20,ltd:0,image_id:''},
      {icon:'🎤',name:'Boombox',val:72,pct:36,ltd:0,image_id:''},
    ]},
    {name:'Tropical Beach',icon:'🌴',price:2147,box_style:1,c1:'#003040',c2:'#001820',glow:'#00CCFF',items:[
      {icon:'🌺',name:'Summer Star Shades',val:11200,pct:13,ltd:1,image_id:''},
      {icon:'🏄',name:'Beach Umbrella Hat',val:2600,pct:10,ltd:0,image_id:''},
      {icon:'🐚',name:'Shell Necklace',val:720,pct:22,ltd:0,image_id:''},
      {icon:'🕶️',name:'Sunglasses',val:175,pct:20,ltd:0,image_id:''},
      {icon:'🌴',name:'Luau Hat',val:68,pct:35,ltd:0,image_id:''},
    ]},
    {name:'Easter Luck',icon:'🐣',price:2116,box_style:1,c1:'#1A3A6A',c2:'#0A1A3A',glow:'#00AAFF',items:[
      {icon:'🐣',name:'Egg of Good Fortune',val:10500,pct:13,ltd:1,image_id:''},
      {icon:'🥚',name:'Golden Egg',val:2400,pct:10,ltd:0,image_id:''},
      {icon:'🌸',name:'Spring Shades',val:680,pct:22,ltd:0,image_id:''},
      {icon:'🍭',name:'Candy Cane',val:165,pct:20,ltd:0,image_id:''},
      {icon:'🍬',name:'Bunny Ears',val:62,pct:35,ltd:0,image_id:''},
    ]},
    {name:'Jungle King',icon:'🦁',price:3450,box_style:4,c1:'#3A1A5A',c2:'#1A0A2A',glow:'#AA66FF',items:[
      {icon:'👑',name:'Dominus Empyreus',val:28000,pct:8,ltd:1,image_id:''},
      {icon:'🐘',name:'Dominus Aureus',val:5200,pct:7,ltd:1,image_id:''},
      {icon:'🦊',name:'Dom. Formidulosus',val:1400,pct:18,ltd:1,image_id:''},
      {icon:'🐍',name:'Venom Shades',val:380,pct:22,ltd:0,image_id:''},
      {icon:'🌿',name:'Jungle Visor',val:95,pct:45,ltd:0,image_id:''},
    ]},
    {name:'Space Drop',icon:'🚀',price:4200,box_style:4,c1:'#0A0A3A',c2:'#04041A',glow:'#4444FF',items:[
      {icon:'🛸',name:'Dominus Vespertilio',val:34000,pct:8,ltd:1,image_id:''},
      {icon:'🌟',name:'Valkyrie Helm',val:6800,pct:7,ltd:1,image_id:''},
      {icon:'🪐',name:'Galaxy Shades',val:1800,pct:17,ltd:0,image_id:''},
      {icon:'🌙',name:'Moon Animator',val:480,pct:22,ltd:0,image_id:''},
      {icon:'🚀',name:'Space Cap',val:110,pct:46,ltd:0,image_id:''},
    ]},
    {name:'Cyber Strike',icon:'⚡',price:1820,box_style:1,c1:'#1A3A6A',c2:'#0A1A3A',glow:'#00AAFF',items:[
      {icon:'⚡',name:'Korblox Deathspeaker',val:11000,pct:11,ltd:1,image_id:''},
      {icon:'🔋',name:'Illumina',val:2400,pct:10,ltd:1,image_id:''},
      {icon:'💡',name:'Neon Shades',val:720,pct:22,ltd:0,image_id:''},
      {icon:'🔌',name:'Cyber Wings',val:180,pct:22,ltd:0,image_id:''},
      {icon:'🔦',name:'Laser Eyes',val:65,pct:35,ltd:0,image_id:''},
    ]},
    {name:'Dragon Vault',icon:'🐉',price:5500,box_style:4,c1:'#3A1A5A',c2:'#1A0A2A',glow:'#AA66FF',items:[
      {icon:'🐉',name:'Sinister Shades Evil',val:44000,pct:8,ltd:1,image_id:''},
      {icon:'🔥',name:'Dominus Rex',val:8500,pct:7,ltd:1,image_id:''},
      {icon:'⚔️',name:'Dragon Wings',val:2200,pct:17,ltd:0,image_id:''},
      {icon:'🛡️',name:'Dragon Scale Helm',val:580,pct:22,ltd:0,image_id:''},
      {icon:'🪨',name:'Dragon Tail',val:130,pct:46,ltd:0,image_id:''},
    ]},
    {name:'Lucky Clover',icon:'🍀',price:880,box_style:1,c1:'#1A3A6A',c2:'#0A1A3A',glow:'#00AAFF',items:[
      {icon:'🍀',name:'Lucky Shades',val:5500,pct:11,ltd:0,image_id:''},
      {icon:'🌈',name:'Pot of Gold Wings',val:1200,pct:11,ltd:0,image_id:''},
      {icon:'🎲',name:'Gold Dice Hat',val:380,pct:22,ltd:0,image_id:''},
      {icon:'🪙',name:'Shamrock',val:95,pct:56,ltd:0,image_id:''},
    ]},
  ];
  const insCase = db.prepare('INSERT INTO cases (name,icon,price,box_style,c1,c2,glow,sort_order) VALUES (?,?,?,?,?,?,?,?)');
  const insItem  = db.prepare('INSERT INTO case_items (case_id,icon,name,val,pct,ltd,image_id,sort_order) VALUES (?,?,?,?,?,?,?,?)');
  defaultCases.forEach((c, idx) => {
    const r = insCase.run(c.name, c.icon, c.price, c.box_style, c.c1, c.c2, c.glow, idx);
    c.items.forEach((it, iidx) => insItem.run(r.lastInsertRowid, it.icon, it.name, it.val, it.pct, it.ltd, it.image_id, iidx));
  });
  console.log(`[SEED] ${defaultCases.length} cases seeded.`);
})();

// ── Backfill imageIds for Tiger Strikes items ─────────────────
(function migrateImageIds() {
  const c = db.prepare("SELECT id FROM cases WHERE name='Tiger Strikes'").get();
  if (!c) return;
  const updates = [
    { val: 7277, name: 'When Animals Attack: Gorilla Grievance', imageId: '23301616' },
    { val: 1734, name: 'Bunny Ear Fedora',      imageId: '94160083106830' },
    { val: 1546, name: 'Rabbit Bow Top Hat',    imageId: '89359381546324' },
    { val: 80,   name: 'White Rabbit Backpack', imageId: '132138131140756' },
  ];
  const upd = db.prepare("UPDATE case_items SET name=?, image_id=? WHERE case_id=? AND val=?");
  updates.forEach(it => upd.run(it.name, it.imageId, c.id, it.val));
  console.log('[MIGRATE] Tiger Strikes imageIds backfilled.');
})();

// (one-time cleanup removed — user-created cases are now persistent)

// ── Seed Fedora 10% case ──────────────────────────────────────
(function seedFedoraCase() {
  const existing = db.prepare("SELECT id FROM cases WHERE name='Fedora 10%'").get();
  if (existing) {
    // Backfill any missing image_ids
    const items = [
      { val: 25000, name: 'Elite Crystal Fedora',   imageId: '73677617434077' },
      { val: 190,   name: 'Verified Fedora',         imageId: '121464493936622' },
      { val: 240,   name: 'Shades Fedora',           imageId: '131472162887395' },
      { val: 165,   name: 'Open Crack Fedora',       imageId: '13810220615' },
      { val: 80,    name: 'Pink Damascus Fedora',    imageId: '16304391478' },
    ];
    const upd = db.prepare("UPDATE case_items SET name=?, image_id=? WHERE case_id=? AND val=?");
    items.forEach(it => upd.run(it.name, it.imageId, existing.id, it.val));
    console.log('[MIGRATE] Fedora 10% imageIds backfilled.');
    return;
  }
  const r = db.prepare(
    "INSERT INTO cases (name,icon,price,box_style,c1,c2,glow,sort_order) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM cases))"
  ).run('Fedora 10%', '🎁', 2935, 4, '#3A1A5A', '#1A0A2A', '#7B68EE');
  const caseId = r.lastInsertRowid;
  const ins = db.prepare(
    "INSERT INTO case_items (case_id,icon,name,val,pct,ltd,image_id,sort_order) VALUES (?,?,?,?,?,?,?,?)"
  );
  const fedoraItems = [
    { name: 'Elite Crystal Fedora',  val: 25000, pct: 10, imageId: '73677617434077' },
    { name: 'Verified Fedora',       val: 190,   pct: 15, imageId: '121464493936622' },
    { name: 'Shades Fedora',         val: 240,   pct: 20, imageId: '131472162887395' },
    { name: 'Open Crack Fedora',     val: 165,   pct: 25, imageId: '13810220615' },
    { name: 'Pink Damascus Fedora',  val: 80,    pct: 30, imageId: '16304391478' },
  ];
  fedoraItems.forEach((it, i) => ins.run(caseId, '🎁', it.name, it.val, it.pct, 0, it.imageId, i+1));
  console.log('[MIGRATE] Fedora 10% case seeded with 5 items.');
})();

// ── Seed 5% Juicer case ───────────────────────────────────────
(function seed5pJuicerCase() {
  const existing = db.prepare("SELECT id FROM cases WHERE name='5% Juicer'").get();
  if (existing) {
    const items = [
      { val: 100000, name: 'Playful Vampire',       imageId: '105919952545574' },
      { val: 95000,  name: 'Blizzard Beast Mode',   imageId: '170591579555886' },
      { val: 85000,  name: 'American Baseball Cap', imageId: '29715020' },
      { val: 50,     name: 'Winter Lamb Plushie',   imageId: '106619699475922' },
    ];
    const upd = db.prepare("UPDATE case_items SET name=?, image_id=? WHERE case_id=? AND val=?");
    items.forEach(it => upd.run(it.name, it.imageId, existing.id, it.val));
    console.log('[MIGRATE] 5% Juicer imageIds backfilled.');
    return;
  }
  const r = db.prepare(
    "INSERT INTO cases (name,icon,price,box_style,c1,c2,glow,sort_order) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM cases))"
  ).run('5% Juicer', '🎁', 5053, 5, '#5A1A1A', '#2A0A0A', '#FF4466');
  const caseId = r.lastInsertRowid;
  const ins = db.prepare(
    "INSERT INTO case_items (case_id,icon,name,val,pct,ltd,image_id,sort_order) VALUES (?,?,?,?,?,?,?,?)"
  );
  const juicerItems = [
    { name: 'Playful Vampire',       val: 100000, pct: 1,  imageId: '105919952545574' },
    { name: 'Blizzard Beast Mode',   val: 95000,  pct: 1,  imageId: '170591579555886' },
    { name: 'American Baseball Cap', val: 85000,  pct: 3,  imageId: '29715020' },
    { name: 'Winter Lamb Plushie',   val: 50,     pct: 95, imageId: '106619699475922' },
  ];
  juicerItems.forEach((it, i) => ins.run(caseId, '🎁', it.name, it.val, it.pct, 0, it.imageId, i+1));
  console.log('[MIGRATE] 5% Juicer case seeded with 4 items.');
})();

// ── Seed admin user ──────────────────────────────────────────
(function seedAdmin() {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin';
  const existing  = db.prepare('SELECT id FROM users WHERE username=?').get(adminUser);
  if (!existing) {
    const hash = bcrypt.hashSync(adminPass, 10);
    db.prepare('INSERT INTO users(username,password,balance,is_admin) VALUES(?,?,?,1)')
      .run(adminUser, hash, 999999999);
    console.log(`[BOOT] Admin user "${adminUser}" created.`);
  }
})();

// ── Fix case box_styles based on max item value ──────────────
(function fixCaseBoxStyles() {
  const tiers = [
    { min: 300000, box_style: 2, c1: '#5A3A00', c2: '#2A1A00', glow: '#FFD700' },
    { min: 100000, box_style: 5, c1: '#5A1A1A', c2: '#2A0A0A', glow: '#FF4466' },
    { min: 25000,  box_style: 4, c1: '#3A1A5A', c2: '#1A0A2A', glow: '#AA66FF' },
    { min: 5000,   box_style: 1, c1: '#1A3A6A', c2: '#0A1A3A', glow: '#00AAFF' },
    { min: 0,      box_style: 3, c1: '#0A3A1A', c2: '#041200', glow: '#00FF88' },
  ];
  const cases = db.prepare('SELECT id, name FROM cases WHERE active=1').all();
  const upd = db.prepare('UPDATE cases SET box_style=?, c1=?, c2=?, glow=? WHERE id=?');
  for (const c of cases) {
    const row = db.prepare('SELECT MAX(val) as maxVal FROM case_items WHERE case_id=?').get(c.id);
    const maxVal = row?.maxVal || 0;
    const tier = tiers.find(t => maxVal >= t.min) || tiers[tiers.length - 1];
    upd.run(tier.box_style, tier.c1, tier.c2, tier.glow, c.id);
    console.log(`[MIGRATE] "${c.name}" maxVal=${maxVal} → box_style=${tier.box_style} glow=${tier.glow}`);
  }
  console.log('[MIGRATE] Case box styles fixed.');
})();

// ── Initialize deposit address balances on first run ─────────
// For addresses that have never been checked (last_sol_balance=0 but address is old),
// seed the current on-chain balance so we don't double-credit historical deposits.
async function initDepositBalances() {
  const solRows = db.prepare("SELECT user_id, address FROM deposit_addresses WHERE chain='SOL' AND last_sol_balance=0").all();
  if (!solRows.length) return;
  const RPC_URL    = process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new solanaWeb3.Connection(RPC_URL, 'confirmed');
  for (const row of solRows) {
    // Retry up to 5 times with backoff — public RPC may 429 on first hit
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const bal = await connection.getBalance(new solanaWeb3.PublicKey(row.address));
        db.prepare("UPDATE deposit_addresses SET last_sol_balance=? WHERE user_id=? AND chain='SOL'").run(bal, row.user_id);
        console.log(`[INIT] SOL ${row.address} seeded at ${bal} lamports (no credit — historical balance)`);
        break;
      } catch (e) {
        console.warn(`[INIT] getBalance attempt ${attempt}/5 failed for ${row.address}: ${e.message}`);
        if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
}

// ── Encryption helpers ───────────────────────────────────────
function encryptKey(plaintext) {
  const iv         = crypto.randomBytes(16);
  const cipher     = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENC_KEY), iv);
  const encrypted  = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { encrypted: encrypted.toString('hex'), iv: iv.toString('hex') };
}
function decryptKey(encHex, ivHex) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENC_KEY), Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return decrypted.toString();
}

// ── Wallet generation ────────────────────────────────────────
function genEthWallet() {
  const wallet = ethers.Wallet.createRandom();
  const { encrypted, iv } = encryptKey(wallet.privateKey);
  return { address: wallet.address, encrypted_key: encrypted, key_iv: iv };
}
function genSolWallet() {
  const kp = solanaWeb3.Keypair.generate();
  const privKeyB58 = Buffer.from(kp.secretKey).toString('base64');
  const { encrypted, iv } = encryptKey(privKeyB58);
  return { address: kp.publicKey.toBase58(), encrypted_key: encrypted, key_iv: iv };
}
// ── Get or create deposit addresses for a user ───────────────
function getOrCreateAddresses(userId) {
  const chains = { ETH: genEthWallet, SOL: genSolWallet };
  const result  = {};
  for (const [chain, gen] of Object.entries(chains)) {
    let row = db.prepare('SELECT address FROM deposit_addresses WHERE user_id=? AND chain=?').get(userId, chain);
    if (!row) {
      const wallet = gen();
      db.prepare('INSERT INTO deposit_addresses(user_id,chain,address,encrypted_key,key_iv) VALUES(?,?,?,?,?)')
        .run(userId, chain, wallet.address, wallet.encrypted_key, wallet.key_iv);
      row = { address: wallet.address };
    }
    result[chain] = row.address;
  }
  return result;
}

// ── Price helpers ─────────────────────────────────────────────
const priceCache = {};
async function getUsdPrice(coinId) {
  const now = Date.now();
  if (priceCache[coinId] && now - priceCache[coinId].ts < 60_000) return priceCache[coinId].price;
  try {
    const res = await axios.get(`${process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3'}/simple/price`, {
      params: { ids: coinId, vs_currencies: 'usd' }, timeout: 8000,
    });
    const price = res.data[coinId]?.usd || 0;
    priceCache[coinId] = { price, ts: now };
    return price;
  } catch (e) {
    return priceCache[coinId]?.price || 0;
  }
}

// ── Credit helper ────────────────────────────────────────────
function creditCoins(userId, coinsAmount, { type = 'deposit', chain = null, token = null, amountUsd = null, txHash = null, note = null } = {}) {
  db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(coinsAmount, userId);
  db.prepare('INSERT INTO transactions(user_id,type,chain,token,amount_usd,coins_delta,tx_hash,status,note) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(userId, type, chain, token, amountUsd, coinsAmount, txHash, 'completed', note);
}
function debitCoins(userId, coinsAmount, opts = {}) {
  creditCoins(userId, -Math.abs(coinsAmount), { type: 'withdrawal', ...opts });
}

// ── Deposit Monitoring ────────────────────────────────────────
// ETH + ERC-20 via Etherscan
async function checkEthDeposits() {
  const rows = db.prepare("SELECT da.user_id, da.address, da.encrypted_key, da.key_iv FROM deposit_addresses da WHERE da.chain='ETH'").all();
  if (!rows.length) return;

  const ETHERSCAN = process.env.ETHERSCAN_BASE_URL || 'https://api.etherscan.io/api';
  const APIKEY    = process.env.ETHERSCAN_API_KEY   || '';

  for (const row of rows) {
    try {
      // Native ETH
      const res = await axios.get(ETHERSCAN, {
        params: { module:'account', action:'txlist', address: row.address, startblock:0, endblock:99999999, sort:'asc', apikey: APIKEY },
        timeout: 10000,
      });
      if (res.data.status === '1') {
        for (const tx of res.data.result) {
          if (tx.to?.toLowerCase() !== row.address.toLowerCase()) continue;
          if (tx.isError !== '0') continue;
          if (parseInt(tx.confirmations) < ETH_CONFIRMATIONS_REQUIRED) continue; // wait for confirmations
          const seen = db.prepare('SELECT 1 FROM seen_txhashes WHERE tx_hash=?').get(tx.hash);
          if (seen) continue;
          const ethAmount = Number(ethers.formatEther(tx.value));
          if (ethAmount < 0.0001) continue;
          const ethPrice  = await getUsdPrice('ethereum');
          const usd       = ethAmount * ethPrice;
          const coins     = Math.floor(usd * COINS_PER_DOLLAR);
          if (coins < 1) continue;
          db.prepare('INSERT INTO seen_txhashes(tx_hash,user_id) VALUES(?,?)').run(tx.hash, row.user_id);
          creditCoins(row.user_id, coins, { chain:'ETH', token:'ETH', amountUsd: usd, txHash: tx.hash });
          console.log(`[DEPOSIT] ETH user=${row.user_id} +${coins} coins (${ethAmount} ETH = $${usd.toFixed(2)})`);
          // Sweep deposited ETH to master wallet (async, non-blocking)
          sweepEth(row.encrypted_key, row.key_iv, row.address).catch(() => {});
        }
      }

      // ERC-20: USDT + USDC
      const tokens = [
        { contract: process.env.USDT_ETH_CONTRACT, symbol: 'USDT', decimals: 6, coinId: null },
        { contract: process.env.USDC_ETH_CONTRACT, symbol: 'USDC', decimals: 6, coinId: null },
      ].filter(t => t.contract);

      for (const token of tokens) {
        const r2 = await axios.get(ETHERSCAN, {
          params: { module:'account', action:'tokentx', contractaddress: token.contract, address: row.address, sort:'asc', apikey: APIKEY },
          timeout: 10000,
        });
        if (r2.data.status !== '1') continue;
        for (const tx of r2.data.result) {
          if (tx.to?.toLowerCase() !== row.address.toLowerCase()) continue;
          const seen = db.prepare('SELECT 1 FROM seen_txhashes WHERE tx_hash=?').get(tx.hash + '_' + token.symbol);
          if (seen) continue;
          const amount = Number(tx.value) / Math.pow(10, token.decimals);
          if (amount < 0.01) continue;
          const usd   = amount; // USDT/USDC = $1 each
          const coins = Math.floor(usd * COINS_PER_DOLLAR);
          if (coins < 1) continue;
          db.prepare('INSERT INTO seen_txhashes(tx_hash,user_id) VALUES(?,?)').run(tx.hash + '_' + token.symbol, row.user_id);
          creditCoins(row.user_id, coins, { chain:'ETH', token: token.symbol, amountUsd: usd, txHash: tx.hash });
          console.log(`[DEPOSIT] ${token.symbol}/ETH user=${row.user_id} +${coins} coins ($${usd.toFixed(2)})`);
        }
      }
    } catch (e) {
      // silently ignore per-address errors
    }
  }
}

// ── Sweep helpers — move funds from deposit address → master wallet ──
async function sweepSol(encryptedKey, ivHex, fromAddress, lamports) {
  try {
    const RPC_URL    = process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new solanaWeb3.Connection(RPC_URL, 'confirmed');

    // Decrypt deposit address private key (stored as base64)
    const privB64 = decryptKey(encryptedKey, ivHex);
    const fromKp  = solanaWeb3.Keypair.fromSecretKey(Buffer.from(privB64, 'base64'));

    // Master wallet key in .env is raw base58 (the Solana CLI / Phantom export format)
    // @solana/web3.js ships bs58 internally; use it via the Keypair helper
    const masterKp = (() => {
      const key = process.env.SOL_MASTER_PRIVATE_KEY || '';
      // Try base58 first (most common format for Solana wallets)
      try {
        // bs58 is a dependency of @solana/web3.js, available in node_modules
        const bs58 = require('bs58');
        return solanaWeb3.Keypair.fromSecretKey(bs58.decode(key));
      } catch (_) {}
      // Fall back to base64
      return solanaWeb3.Keypair.fromSecretKey(Buffer.from(key, 'base64'));
    })();

    const FEE_LAMPORTS = 5000; // ~0.000005 SOL for tx fee
    const sendLamports = lamports - FEE_LAMPORTS;
    if (sendLamports <= 0) return;

    const tx = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: fromKp.publicKey,
        toPubkey:   masterKp.publicKey,
        lamports:   sendLamports,
      })
    );
    const sig = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [fromKp]);
    console.log(`[SWEEP] SOL ${fromAddress} → master: ${(sendLamports/1e9).toFixed(6)} SOL (sig: ${sig})`);
  } catch (e) {
    console.error(`[SWEEP] SOL sweep failed for ${fromAddress}:`, e.message);
  }
}

async function sweepEth(encryptedKey, ivHex, fromAddress) {
  try {
    const provider  = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_KEY || ''}`);
    const privKey   = decryptKey(encryptedKey, ivHex);
    const fromWallet = new ethers.Wallet(privKey, provider);
    const masterAddr = new ethers.Wallet(process.env.ETH_MASTER_PRIVATE_KEY).address;

    const balance  = await provider.getBalance(fromAddress);
    const feeData  = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits('20', 'gwei');
    const gasCost  = gasPrice * 21000n;
    const sendAmt  = balance - gasCost;
    if (sendAmt <= 0n) return;

    const tx = await fromWallet.sendTransaction({ to: masterAddr, value: sendAmt, gasPrice });
    console.log(`[SWEEP] ETH ${fromAddress} → master: ${ethers.formatEther(sendAmt)} ETH (tx: ${tx.hash})`);
  } catch (e) {
    console.error(`[SWEEP] ETH sweep failed for ${fromAddress}:`, e.message);
  }
}

// SOL via balance polling — works without getSignaturesForAddress (which is rate-limited on public RPC)
async function checkSolDeposits() {
  const rows = db.prepare("SELECT user_id, address, encrypted_key, key_iv, last_sol_balance FROM deposit_addresses WHERE chain='SOL'").all();
  if (!rows.length) return;

  const RPC_URL    = process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new solanaWeb3.Connection(RPC_URL, 'confirmed');

  for (const row of rows) {
    try {
      const pubkey = new solanaWeb3.PublicKey(row.address);

      // getBalance works on public RPC even when getSignaturesForAddress is rate-limited
      let currentLamports;
      try {
        currentLamports = await connection.getBalance(pubkey);
      } catch (e) {
        console.error(`[SOL] getBalance failed for ${row.address}:`, e.message);
        continue;
      }

      const lastLamports = row.last_sol_balance || 0;
      const deltaLamports = currentLamports - lastLamports;

      if (deltaLamports <= 0) continue; // no new funds

      const solAmount = deltaLamports / 1e9;

      let solPrice = await getUsdPrice('solana');
      if (!solPrice || solPrice <= 0) {
        try {
          const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 8000 });
          solPrice = r.data?.solana?.usd || 0;
        } catch (_) {}
      }
      if (!solPrice || solPrice <= 0) {
        console.error(`[SOL] Could not get SOL price, skipping deposit for ${row.address}`);
        continue;
      }

      const usd   = solAmount * solPrice;
      const coins = Math.floor(usd * COINS_PER_DOLLAR);

      // Update balance first to prevent double-credit if server restarts mid-process
      db.prepare("UPDATE deposit_addresses SET last_sol_balance=? WHERE user_id=? AND chain='SOL'").run(currentLamports, row.user_id);

      if (coins < 1) continue; // dust, tracked but not credited

      creditCoins(row.user_id, coins, { chain:'SOL', token:'SOL', amountUsd: usd });
      console.log(`[DEPOSIT] SOL user=${row.user_id} +${coins} coins (${solAmount.toFixed(6)} SOL @ $${solPrice.toFixed(2)} = $${usd.toFixed(2)})`);

      // Sweep to master wallet — after sweep succeeds, reset last_sol_balance to 0
      sweepSol(row.encrypted_key, row.key_iv, row.address, currentLamports).then(() => {
        db.prepare("UPDATE deposit_addresses SET last_sol_balance=0 WHERE user_id=? AND chain='SOL'").run(row.user_id);
      }).catch(e => console.error(`[SWEEP] SOL failed for ${row.address}:`, e.message));

    } catch (e) {
      console.error(`[SOL] checkSolDeposits error for user ${row.user_id}:`, e.message);
    }
  }
}

async function runDepositChecks() {
  await Promise.allSettled([checkEthDeposits(), checkSolDeposits()]);
}
setInterval(runDepositChecks, 30_000);
// On startup: seed existing address balances first so we don't double-credit historical deposits,
// then begin normal polling
initDepositBalances().then(() => runDepositChecks()).catch(() => runDepositChecks());

// ── Withdrawal helpers ────────────────────────────────────────
async function sendEth(toAddress, amountEth) {
  const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_KEY || ''}`);
  const wallet   = new ethers.Wallet(process.env.ETH_MASTER_PRIVATE_KEY, provider);
  const tx = await wallet.sendTransaction({ to: toAddress, value: ethers.parseEther(String(amountEth)) });
  return tx.hash;
}
async function sendErc20(tokenContract, toAddress, amount, decimals) {
  const provider = new ethers.JsonRpcProvider(`https://mainnet.infura.io/v3/${process.env.INFURA_KEY || ''}`);
  const wallet   = new ethers.Wallet(process.env.ETH_MASTER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(tokenContract, ERC20_ABI, wallet);
  const tx = await contract.transfer(toAddress, ethers.parseUnits(String(amount), decimals));
  return tx.hash;
}
async function sendSol(toAddress, amountSol) {
  const connection   = new solanaWeb3.Connection(process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const secretKeyB64 = decryptKey(process.env.SOL_MASTER_ENCRYPTED_KEY || '', process.env.SOL_MASTER_IV || '');
  const secretKey    = Buffer.from(secretKeyB64, 'base64');
  const fromKp       = solanaWeb3.Keypair.fromSecretKey(secretKey);
  const toPub        = new solanaWeb3.PublicKey(toAddress);
  const tx           = new solanaWeb3.Transaction().add(
    solanaWeb3.SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey: toPub, lamports: Math.floor(amountSol * 1e9) })
  );
  const sig = await solanaWeb3.sendAndConfirmTransaction(connection, tx, [fromKp]);
  return sig;
}

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
// Log every request so you can see what's hitting the server
app.use((req, res, next) => { console.log(`[REQ] ${req.method} ${req.path}`); next(); });

// ── Auth middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ── Provably Fair helpers ─────────────────────────────────────
function pfHmac(serverSeed, clientSeed, nonce) {
  return crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
}
function pfHmacFloat(serverSeed, clientSeed, nonce) {
  const hex = pfHmac(serverSeed, clientSeed, nonce);
  return parseInt(hex.slice(0, 8), 16) / 0x100000000; // 0 inclusive, 1 exclusive
}
function pfNewSession(userId, clientSeed = 'changeme') {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO pf_sessions(id,user_id,server_seed,server_seed_hash,client_seed,nonce,revealed) VALUES(?,?,?,?,?,0,0)')
    .run(id, userId, serverSeed, serverSeedHash, clientSeed);
  return { id, serverSeedHash, clientSeed, nonce: 0 };
}
function pfActiveSession(userId) {
  return db.prepare('SELECT * FROM pf_sessions WHERE user_id=? AND revealed=0 ORDER BY created_at DESC LIMIT 1').get(userId);
}

// GET /api/fair/session — get or create active session
app.get('/api/fair/session', requireAuth, (req, res) => {
  let s = pfActiveSession(req.user.id);
  if (!s) s = pfNewSession(req.user.id);
  // Never expose server_seed before reveal
  const next = db.prepare('SELECT server_seed_hash FROM pf_sessions WHERE user_id=? AND revealed=0 AND id!=? ORDER BY created_at DESC LIMIT 1').get(req.user.id, s.id);
  res.json({ id: s.id, serverSeedHash: s.server_seed_hash, clientSeed: s.client_seed, nonce: s.nonce, nextHash: next?.server_seed_hash });
});

// PATCH /api/fair/session — update client seed (resets nonce)
app.patch('/api/fair/session', requireAuth, (req, res) => {
  const { clientSeed } = req.body || {};
  if (!clientSeed || typeof clientSeed !== 'string' || clientSeed.length > 128) return res.status(400).json({ error: 'Invalid clientSeed' });
  let s = pfActiveSession(req.user.id);
  if (!s) s = pfNewSession(req.user.id, clientSeed);
  else db.prepare('UPDATE pf_sessions SET client_seed=?, nonce=0 WHERE id=?').run(clientSeed, s.id);
  res.json({ ok: true, clientSeed, nonce: 0 });
});

// POST /api/fair/rotate — reveal current seed, create next
app.post('/api/fair/rotate', requireAuth, (req, res) => {
  let s = pfActiveSession(req.user.id);
  if (!s) { pfNewSession(req.user.id); return res.json({ revealed: null, next: pfActiveSession(req.user.id) }); }
  db.prepare('UPDATE pf_sessions SET revealed=1 WHERE id=?').run(s.id);
  const next = pfNewSession(req.user.id, s.client_seed);
  res.json({ revealed: { serverSeed: s.server_seed, serverSeedHash: s.server_seed_hash, clientSeed: s.client_seed, nonce: s.nonce }, next });
});

// POST /api/fair/result — get next random float (increments nonce, returns float + seed info)
app.post('/api/fair/result', requireAuth, (req, res) => {
  let s = pfActiveSession(req.user.id);
  if (!s) s = pfNewSession(req.user.id);
  const float = pfHmacFloat(s.server_seed, s.client_seed, s.nonce);
  const nonceUsed = s.nonce;
  db.prepare('UPDATE pf_sessions SET nonce=nonce+1 WHERE id=?').run(s.id);
  res.json({ float, nonce: nonceUsed, serverSeedHash: s.server_seed_hash, clientSeed: s.client_seed });
});

// POST /api/fair/result-multi — get N floats at once (for mines, towers, etc.)
app.post('/api/fair/result-multi', requireAuth, (req, res) => {
  const { count = 1 } = req.body || {};
  if (count < 1 || count > 64) return res.status(400).json({ error: 'count must be 1-64' });
  let s = pfActiveSession(req.user.id);
  if (!s) s = pfNewSession(req.user.id);
  const results = [];
  const startNonce = s.nonce;
  for (let i = 0; i < count; i++) {
    results.push(pfHmacFloat(s.server_seed, s.client_seed, s.nonce + i));
  }
  db.prepare('UPDATE pf_sessions SET nonce=nonce+? WHERE id=?').run(count, s.id);
  res.json({ floats: results, startNonce, serverSeedHash: s.server_seed_hash, clientSeed: s.client_seed });
});

// POST /api/fair/verify — public endpoint, verify any result
app.post('/api/fair/verify', (req, res) => {
  const { serverSeed, clientSeed, nonce, game } = req.body || {};
  if (!serverSeed || !clientSeed || typeof nonce !== 'number') return res.status(400).json({ error: 'serverSeed, clientSeed, nonce required' });
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  const hmac = pfHmac(serverSeed, clientSeed, nonce);
  const float = pfHmacFloat(serverSeed, clientSeed, nonce);
  // Compute game-specific result
  let result = {};
  if (game === 'dice')     result = { roll: Math.floor(float * 10000) / 100 };         // 0.00–99.99
  if (game === 'crash')    result = { crashPoint: Math.max(1, 0.99 / (1 - float)).toFixed(2) };
  if (game === 'limbo')    result = { multiplier: Math.max(1, 0.99 / (1 - float)).toFixed(2) };
  if (game === 'upgrader') result = { float: float.toFixed(8) };
  if (game === 'mines')    result = { float: float.toFixed(8), note: 'Each consecutive nonce = next tile position' };
  res.json({ serverSeedHash, hmac, float, result });
});

// GET /api/fair/history — last 20 revealed sessions for user
app.get('/api/fair/history', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id,server_seed,server_seed_hash,client_seed,nonce,created_at FROM pf_sessions WHERE user_id=? AND revealed=1 ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  res.json(rows);
});

// ── Bet history routes ────────────────────────────────────────
// POST /api/bets — record a completed bet
app.post('/api/bets', requireAuth, (req, res) => {
  const { game, bet_amount, payout, multiplier, won, detail } = req.body || {};
  if (!game || bet_amount == null) return res.status(400).json({ error: 'game and bet_amount required' });
  const profit = (payout || 0) - bet_amount;
  db.prepare('INSERT INTO bets(user_id,game,bet_amount,payout,profit,multiplier,won,detail) VALUES(?,?,?,?,?,?,?,?)')
    .run(req.user.id, game, Math.round(bet_amount), Math.round(payout||0), Math.round(profit), multiplier||0, won?1:0, detail||null);
  res.json({ ok: true });
});

// GET /api/bets — last 100 bets for user
app.get('/api/bets', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bets WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json(rows);
});

// ── Auth routes ───────────────────────────────────────────────
app.post('/api/auth/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3–20 chars' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 chars' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username: letters, digits, underscores only' });
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already taken' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users(username,password,balance,is_admin) VALUES(?,?,?,0)').run(username, hash, 0);
  const user = db.prepare('SELECT id,username,balance,is_admin FROM users WHERE id=?').get(info.lastInsertRowid);
  const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, balance: user.balance, is_admin: !!user.is_admin } });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, balance: user.balance, is_admin: !!user.is_admin } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id,username,balance,is_admin FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, balance: user.balance, is_admin: !!user.is_admin });
});

// ── Balance / Game sync ───────────────────────────────────────
app.post('/api/game/result', requireAuth, (req, res) => {
  const { delta } = req.body || {};
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return res.status(400).json({ error: 'Invalid delta' });
  const user = db.prepare('SELECT id,balance,is_admin FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.is_admin) {
    // Admin balance never goes below 0 and always stays at a large number
    return res.json({ balance: 999999999 });
  }
  const roundedDelta = Math.round(delta);
  const newBal = user.balance + roundedDelta;
  if (newBal < 0) return res.status(400).json({ error: 'Insufficient balance' });
  db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBal, user.id);
  db.prepare('INSERT INTO transactions(user_id,type,coins_delta,status,note) VALUES(?,?,?,?,?)')
    .run(user.id, 'game', roundedDelta, 'completed', 'game result sync');
  // Accrue 5% rakeback on net losses
  if (roundedDelta < 0) accrueRakeback(user.id, Math.abs(roundedDelta));
  res.json({ balance: newBal });
});

// ── Deposit addresses ─────────────────────────────────────────
app.get('/api/deposit/addresses', requireAuth, (req, res) => {
  const addresses = getOrCreateAddresses(req.user.id);
  res.json({ addresses });
});

// ── Withdrawal ────────────────────────────────────────────────
app.post('/api/withdraw', requireAuth, async (req, res) => {
  const { coins, chain, token, toAddress } = req.body || {};
  if (!coins || !chain || !token || !toAddress) return res.status(400).json({ error: 'coins, chain, token, toAddress required' });
  if (typeof coins !== 'number' || coins < 1) return res.status(400).json({ error: 'Invalid coin amount' });

  const user = db.prepare('SELECT id,balance,is_admin FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.is_admin && user.balance < coins) return res.status(400).json({ error: 'Insufficient balance' });

  // Convert coins → USD → crypto amount
  const usd = coins / COINS_PER_DOLLAR;

  let txHash = null;
  try {
    if (chain === 'ETH' && token === 'ETH') {
      const ethPrice = await getUsdPrice('ethereum');
      const amount   = usd / ethPrice;
      txHash = await sendEth(toAddress, amount.toFixed(8));
    } else if (chain === 'ETH' && token === 'USDT') {
      txHash = await sendErc20(process.env.USDT_ETH_CONTRACT, toAddress, usd.toFixed(2), 6);
    } else if (chain === 'ETH' && token === 'USDC') {
      txHash = await sendErc20(process.env.USDC_ETH_CONTRACT, toAddress, usd.toFixed(2), 6);
    } else if (chain === 'SOL' && token === 'SOL') {
      const solPrice = await getUsdPrice('solana');
      const amount   = usd / solPrice;
      txHash = await sendSol(toAddress, amount.toFixed(9));
    } else if (chain === 'SOL' && (token === 'USDT' || token === 'USDC')) {
      // SPL token withdrawal via Blockcypher not supported — use web3
      throw new Error(`SPL ${token} withdrawal not yet implemented. Contact support.`);
    } else {
      return res.status(400).json({ error: 'Unsupported chain/token combination' });
    }
  } catch (e) {
    console.error('[WITHDRAW ERROR]', e.message);
    return res.status(500).json({ error: e.message });
  }

  // Deduct from user balance
  if (!user.is_admin) {
    db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(coins, user.id);
  }
  debitCoins(user.id, coins, { chain, token, amountUsd: usd, txHash });
  const newBal = user.is_admin ? 999999999 : db.prepare('SELECT balance FROM users WHERE id=?').get(user.id).balance;
  res.json({ success: true, txHash, balance: newBal });
});

// ── Transaction history ───────────────────────────────────────
app.get('/api/transactions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ transactions: rows });
});

// ── Admin routes ──────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id,username,balance,is_admin,created_at FROM users ORDER BY created_at DESC').all();
  const stats = db.prepare(`
    SELECT user_id,
      COALESCE(SUM(CASE WHEN type='deposit'    AND status='completed' THEN amount_usd ELSE 0 END),0) AS total_deposited,
      COALESCE(SUM(CASE WHEN type='withdrawal' AND status='completed' THEN amount_usd ELSE 0 END),0) AS total_withdrawn,
      COALESCE(SUM(CASE WHEN coins_delta>0 AND type='game' THEN coins_delta ELSE 0 END),0) AS coins_won,
      COALESCE(SUM(CASE WHEN coins_delta<0 AND type='game' THEN ABS(coins_delta) ELSE 0 END),0) AS coins_wagered
    FROM transactions GROUP BY user_id
  `).all();
  const statsMap = {};
  stats.forEach(s => { statsMap[s.user_id] = s; });
  res.json({ users: users.map(u => ({ ...u, ...( statsMap[u.id] || { total_deposited:0, total_withdrawn:0, coins_won:0, coins_wagered:0 }) })) });
});

app.post('/api/admin/credit', requireAdmin, (req, res) => {
  const { userId, coins, note } = req.body || {};
  if (!userId || typeof coins !== 'number') return res.status(400).json({ error: 'userId and coins required' });
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  creditCoins(userId, coins, { type: 'game', note: note || 'admin credit' });
  const updated = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
  res.json({ balance: updated.balance });
});

app.post('/api/admin/debit', requireAdmin, (req, res) => {
  const { userId, coins, note } = req.body || {};
  if (!userId || typeof coins !== 'number') return res.status(400).json({ error: 'userId and coins required' });
  const user = db.prepare('SELECT id,balance FROM users WHERE id=?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < coins) return res.status(400).json({ error: 'User has insufficient balance' });
  debitCoins(userId, coins, { note: note || 'admin debit' });
  const updated = db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
  res.json({ balance: updated.balance });
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT t.*, u.username FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 200').all();
  res.json({ transactions: rows });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalUsers   = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_admin=0').get().c;
  const totalDeposit = db.prepare("SELECT COALESCE(SUM(amount_usd),0) as s FROM transactions WHERE type='deposit' AND status='completed'").get().s;
  const totalWithdraw = db.prepare("SELECT COALESCE(SUM(amount_usd),0) as s FROM transactions WHERE type='withdrawal' AND status='completed'").get().s;
  res.json({ totalUsers, totalDeposit, totalWithdraw });
});

// ── Manual deposit check trigger ─────────────────────────────
app.post('/api/admin/trigger-deposits', requireAdmin, async (req, res) => {
  console.log('[ADMIN] Manual deposit check triggered');
  runDepositChecks().catch(e => console.error('[ADMIN] deposit check error:', e));
  res.json({ ok: true, message: 'Deposit check triggered — watch server console for results' });
});

// ── Price endpoint (for frontend display) ────────────────────
// ── Cases API (public read, admin write) ─────────────────────
app.get('/api/cases', (req, res) => {
  try {
    const cases = db.prepare('SELECT * FROM cases WHERE active=1 ORDER BY sort_order,id').all();
    if (!cases.length) return res.json([]);
    const ids = cases.map(c => c.id);
    const items = db.prepare(
      `SELECT * FROM case_items WHERE case_id IN (${ids.map(()=>'?').join(',')}) ORDER BY case_id,sort_order,id`
    ).all(...ids);
    res.json(cases.map(c => ({
      id: c.id, name: c.name, icon: c.icon, price: c.price,
      box_style: c.box_style, c1: c.c1, c2: c.c2, glow: c.glow, bg: c.c2,
      items: items.filter(i => i.case_id === c.id).map(i => ({
        id: i.id, icon: i.icon, name: i.name, val: i.val,
        pct: i.pct, ltd: !!i.ltd, imageId: i.image_id || ''
      }))
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/cases', requireAdmin, (req, res) => {
  console.log('[ADMIN] POST /api/admin/cases — body:', JSON.stringify(req.body));
  try {
    const { name, icon='📦', price=1000, box_style=1, c1='#1A1A3A', c2='#0A0A18', glow='#7B68EE' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = db.prepare(
      'INSERT INTO cases (name,icon,price,box_style,c1,c2,glow,sort_order) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM cases))'
    ).run(name, icon, price, box_style, c1, c2, glow);
    console.log('[ADMIN] Case created with id:', r.lastInsertRowid);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch(e) {
    console.error('[ADMIN] Error creating case:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/cases/:id', requireAdmin, (req, res) => {
  const { name, icon, price, box_style, c1, c2, glow, active } = req.body;
  db.prepare(
    'UPDATE cases SET name=COALESCE(?,name),icon=COALESCE(?,icon),price=COALESCE(?,price),box_style=COALESCE(?,box_style),c1=COALESCE(?,c1),c2=COALESCE(?,c2),glow=COALESCE(?,glow),active=COALESCE(?,active) WHERE id=?'
  ).run(name, icon, price, box_style, c1, c2, glow, active, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/cases/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM case_items WHERE case_id=?').run(req.params.id);
  db.prepare('DELETE FROM cases WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/cases/:id/items', requireAdmin, (req, res) => {
  try {
    const caseId = req.params.id;
    const { icon='📦', name, val=100, pct=10, ltd=false, image_id='' } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = db.prepare(
      'INSERT INTO case_items (case_id,icon,name,val,pct,ltd,image_id,sort_order) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM case_items WHERE case_id=?))'
    ).run(caseId, icon, name, val, pct, ltd?1:0, image_id, caseId);
    res.json({ id: Number(r.lastInsertRowid) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/cases/:id/items/:itemId', requireAdmin, (req, res) => {
  try {
    const { name, val, pct, icon, ltd, image_id } = req.body;
    db.prepare(
      'UPDATE case_items SET name=COALESCE(?,name),val=COALESCE(?,val),pct=COALESCE(?,pct),icon=COALESCE(?,icon),ltd=COALESCE(?,ltd),image_id=COALESCE(?,image_id) WHERE id=? AND case_id=?'
    ).run(name??null, val??null, pct??null, icon??null, ltd!=null?ltd?1:0:null, image_id??null, req.params.itemId, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/cases/:id/items/:itemId', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM case_items WHERE id=? AND case_id=?').run(req.params.itemId, req.params.id);
  res.json({ ok: true });
});

// ── Admin Set Balance ─────────────────────────────────────────
app.post('/api/admin/set-balance', requireAdmin, (req, res) => {
  const { username, balance } = req.body || {};
  if (!username || typeof balance !== 'number' || balance < 0)
    return res.status(400).json({ error: 'username and non-negative balance required' });
  const user = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET balance=? WHERE id=?').run(Math.floor(balance), user.id);
  res.json({ ok: true, balance: Math.floor(balance) });
});

// ── Rewards / Rakeback ────────────────────────────────────────
// Ensure rakeback_balance column exists (migration)
try {
  db.exec('ALTER TABLE users ADD COLUMN rakeback_balance INTEGER NOT NULL DEFAULT 0');
} catch(e) { /* column already exists */ }

// Call this whenever a game loss occurs: accrueRakeback(userId, lossCoins)
function accrueRakeback(userId, lossCoins) {
  const rb = Math.floor(lossCoins * 0.05);
  if (rb > 0) db.prepare('UPDATE users SET rakeback_balance=rakeback_balance+? WHERE id=?').run(rb, userId);
}

app.get('/api/rewards', requireAuth, (req, res) => {
  const user = db.prepare('SELECT rakeback_balance FROM users WHERE id=?').get(req.user.id);
  res.json({ rakeback_balance: user?.rakeback_balance || 0 });
});

app.post('/api/rewards/claim', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, balance, rakeback_balance FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const rb = user.rakeback_balance || 0;
  if (rb <= 0) return res.status(400).json({ error: 'No rakeback to claim' });
  db.prepare('UPDATE users SET balance=balance+?, rakeback_balance=0 WHERE id=?').run(rb, user.id);
  const updated = db.prepare('SELECT balance FROM users WHERE id=?').get(user.id);
  res.json({ ok: true, claimed: rb, balance: updated.balance });
});

// ── Battle Lobby API ─────────────────────────────────────────
// POST /api/battles — create a battle (auth required)
app.post('/api/battles', requireAuth, (req, res) => {
  const { id, fmt='1v1', mode='normal', game_mode='classic', cost=0, rounds=1, players='[]', cases='[]' } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    db.prepare(
      'INSERT OR REPLACE INTO battles (id,creator_id,fmt,mode,game_mode,cost,rounds,current_round,players,cases,active) VALUES (?,?,?,?,?,?,?,0,?,?,1)'
    ).run(id, req.user.id, fmt, mode, game_mode, cost, rounds,
      typeof players === 'string' ? players : JSON.stringify(players),
      typeof cases === 'string' ? cases : JSON.stringify(cases));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/battles — list active battles + finished within last 60 seconds
app.get('/api/battles', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM battles
    WHERE active=1
       OR (active=0 AND finished_at IS NOT NULL AND (unixepoch('now') - unixepoch(finished_at)) < 120)
    ORDER BY created_at DESC
    LIMIT 100
  `).all();
  const battles = rows.map(r => ({
    ...r,
    players: safeJSON(r.players, []),
    cases:   safeJSON(r.cases, []),
    ts: new Date(r.created_at).getTime(),
  }));
  res.json(battles);
});

// POST /api/battles/:id/events — push round results (creator only)
app.post('/api/battles/:id/events', requireAuth, (req, res) => {
  const { round, results } = req.body || {};
  if (!round || !Array.isArray(results)) return res.status(400).json({ error: 'round and results required' });
  try {
    const ins = db.prepare('INSERT INTO battle_events (battle_id,round,player_idx,item_name,item_val,item_icon,item_image_id) VALUES (?,?,?,?,?,?,?)');
    for (const r of results) {
      ins.run(req.params.id, round, r.player_idx ?? 0, r.item_name || '', r.item_val || 0, r.item_icon || '📦', r.item_image_id || '');
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/battles/:id/events — fetch all round results (public)
app.get('/api/battles/:id/events', (req, res) => {
  try {
    const events = db.prepare('SELECT * FROM battle_events WHERE battle_id=? ORDER BY round,player_idx').all(req.params.id);
    res.json(events);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/battles/:id — get single battle
app.get('/api/battles/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM battles WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ...row, players: safeJSON(row.players, []), cases: safeJSON(row.cases, []), ts: new Date(row.created_at).getTime() });
});

// PATCH /api/battles/:id — update round progress or mark finished
app.patch('/api/battles/:id', requireAuth, (req, res) => {
  const { current_round, finish, players } = req.body || {};
  if (finish) {
    db.prepare("UPDATE battles SET active=0, finished_at=datetime('now') WHERE id=?").run(req.params.id);
  } else if (current_round !== undefined) {
    db.prepare('UPDATE battles SET current_round=? WHERE id=?').run(current_round, req.params.id);
  } else if (players !== undefined) {
    db.prepare('UPDATE battles SET players=? WHERE id=?').run(JSON.stringify(players), req.params.id);
  }
  res.json({ ok: true });
});

function safeJSON(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

app.get('/api/prices', async (req, res) => {
  const [eth, sol] = await Promise.all([
    getUsdPrice('ethereum'),
    getUsdPrice('solana'),
  ]);
  res.json({ ETH: eth, SOL: sol, USDT: 1, USDC: 1 });
});

// ── Static files (after all API routes so they can't shadow /api/*) ──
app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/games.html'));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[SERVER] Casino backend running on http://localhost:${PORT}`);
  console.log(`[SERVER] Visit http://localhost:${PORT} to open the casino`);
});
