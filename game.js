/* Poker Tournament v3.2 (stable rewrite)
   Goals:
   - Resume ALWAYS deals if no hand; never self-pauses
   - Pause truly freezes everything (timers + pending callbacks)
   - Streets correct: PREFLOP -> FLOP(3) -> TURN -> RIVER -> SHOWDOWN
   - Win% MonteCarlo vs remaining opponents only (bots unknown)
   - Neon highlight best 5 + hand name + win%
   - Storage key v31
   - Defensive state-machine + runToken to avoid stale timers bugs
*/

"use strict";

/* -------------------- Config -------------------- */
const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND   = 20;
const BOT_COUNT   = 5;

const MAX_RAISES_PER_ROUND = 4;

const TURN_SECONDS_OPTIONS = [5,10,15,20];
const TURN_SECONDS_DEFAULT = 15;

const BOT_THINK_MS   = 450;
const STREET_PAUSE_MS = 850;

const MC_ITERS_PREFLOP  = 350;
const MC_ITERS_POSTFLOP = 250;

const SUITS = ["♣","♦","♥","♠"];
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const RVAL  = Object.fromEntries(RANKS.map((r,i)=>[r, i+2]));

/* -------------------- State -------------------- */
let nick = null;
let saveKey = null;

let players = [];   // [ {name,isBot,chips,bet,folded,out,acted,hand:[{r,s}]} ]
let deck = [];
let board = [];     // 0..5 cards
let pot = 0;

let stage = "IDLE"; // IDLE,PREFLOP,FLOP,TURN,RIVER,SHOWDOWN
let dealer = 0, sb = 1, bb = 2;
let current = 0;
let toCall = 0;
let raisesThisRound = 0;

let handInProgress = false;
let tournamentStarted = false;

let turnSeconds = TURN_SECONDS_DEFAULT;
let turnLeft = TURN_SECONDS_DEFAULT;

let menuOpen = false;
let paused = true;

/* Stale-timer protection: every time we "stopAll", we bump token.
   Any old callbacks check token before acting. */
let runToken = 1;
let turnTimerId = null;
let botTimerId = null;
let streetPauseId = null;

/* Hero UI */
let heroComboText = "";
let heroWinPct = null;
let heroHighlightKeys = new Set();

/* -------------------- DOM -------------------- */
const $ = (id)=>document.getElementById(id);

const elNick      = $("nick");
const elStack     = $("stack");
const elPot       = $("pot");
const elStage     = $("stage");
const elTurnName  = $("turnName");
const elTurnTimer = $("turnTimer");
const elBoard     = $("board");
const elSeats     = $("seats");
const elMsg       = $("msg");

const btnMenu  = $("btnMenu");
const btnFold  = $("btnFold");
const btnCheck = $("btnCheck");
const btnCall  = $("btnCall");
const btnRaise = $("btnRaise");

const nickOverlay = $("nickOverlay");
const nickInput   = $("nickInput");
const nickOk      = $("nickOk");

const menuOverlay   = $("menuOverlay");
const btnCloseMenu  = $("btnCloseMenu");

const raiseOverlay     = $("raiseOverlay");
const raiseSlider      = $("raiseSlider");
const raiseToLabel     = $("raiseToLabel");
const raiseInput       = $("raiseInput");
const btnRaiseConfirm  = $("btnRaiseConfirm");
const btnRaiseClose    = $("btnRaiseClose");
const btnRaiseMin      = $("btnRaiseMin");
const btnRaiseHalf     = $("btnRaiseHalf");
const btnRaiseAll      = $("btnRaiseAll");

/* -------------------- CSS inject -------------------- */
(function injectExtraCSS(){
  const css = `
  .card.neon{
    box-shadow: 0 0 0 2px rgba(99,242,197,.65),
                0 0 12px rgba(99,242,197,.55),
                0 0 28px rgba(99,242,197,.35),
                0 10px 22px rgba(0,0,0,.55) !important;
    border-color: rgba(99,242,197,.6) !important;
  }
  .hero-info{
    margin-top:8px;
    padding:8px 10px;
    border-radius:14px;
    background: rgba(0,0,0,.22);
    border:1px solid rgba(255,255,255,.14);
    color: rgba(234,245,241,.92);
    font-size: 13px;
    display:flex;
    justify-content:space-between;
    gap:10px;
    align-items:center;
  }
  .hero-info b{ color: #eaf5f1; }
  .hero-info .pct{ color: rgba(99,242,197,.95); font-weight: 900; }
  .menu-controls{
    margin-top:12px;
    display:grid;
    gap:10px;
  }
  .menu-row{
    display:flex;
    gap:10px;
    flex-wrap:wrap;
    align-items:center;
    justify-content:space-between;
  }
  .menu-row .label{ color: rgba(181,201,193,.95); font-size:13px; }
  .menu-row select{
    padding:10px 12px;
    border-radius:16px;
    border:1px solid rgba(255,255,255,.14);
    background:#0a1416;
    color:#eaf5f1;
    font-weight:900;
    outline:none;
  }`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();

/* -------------------- Persistence -------------------- */
function keyForNick(n){ return `poker_step1_v31_${String(n||"").toLowerCase()}`; }

function safeClone(obj){
  try { return structuredClone(obj); }
  catch { return JSON.parse(JSON.stringify(obj)); }
}

function save(){
  if(!saveKey) return;
  const state = {
    version: 31,
    nick,
    turnSeconds,
    paused,
    tournament: {
      players, deck, board, pot, stage, dealer, sb, bb, current, toCall, raisesThisRound,
      handInProgress, tournamentStarted
    }
  };
  try { localStorage.setItem(saveKey, JSON.stringify(state)); } catch {}
  try { localStorage.setItem("poker_last_nick", nick); } catch {}
}

function load(n){
  const raw = localStorage.getItem(keyForNick(n));
  if(!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sanitizeLoadedState(st){
  if(!st || typeof st !== "object") return null;
  const t = st.tournament;
  if(!t || typeof t !== "object") return null;

  // Minimal defaults:
  const out = {
    version: 31,
    nick: String(st.nick || nick || "YOU"),
    turnSeconds: Number(st.turnSeconds || TURN_SECONDS_DEFAULT),
    paused: !!st.paused,
    tournament: {
      players: Array.isArray(t.players) ? t.players : [],
      deck: Array.isArray(t.deck) ? t.deck : [],
      board: Array.isArray(t.board) ? t.board : [],
      pot: Number(t.pot||0),
      stage: String(t.stage||"IDLE"),
      dealer: Number.isFinite(t.dealer) ? t.dealer : 0,
      sb: Number.isFinite(t.sb) ? t.sb : 1,
      bb: Number.isFinite(t.bb) ? t.bb : 2,
      current: Number.isFinite(t.current) ? t.current : 0,
      toCall: Number(t.toCall||0),
      raisesThisRound: Number(t.raisesThisRound||0),
      handInProgress: !!t.handInProgress,
      tournamentStarted: !!t.tournamentStarted
    }
  };

  // Fix invalid stage:
  const okStages = new Set(["IDLE","PREFLOP","FLOP","TURN","RIVER","SHOWDOWN"]);
  if(!okStages.has(out.tournament.stage)) out.tournament.stage = "IDLE";

  // Fix players:
  if(!Array.isArray(out.tournament.players) || out.tournament.players.length === 0){
    out.tournament.players = [];
  }
  // Ensure hero at index 0 exists and is not bot:
  if(out.tournament.players.length){
    out.tournament.players[0].isBot = false;
    out.tournament.players[0].name = out.nick;
  }

  // Ensure boolean flags:
  for(const p of out.tournament.players){
    if(!p) continue;
    p.name = String(p.name||"PLAYER");
    p.isBot = !!p.isBot;
    p.chips = Math.max(0, Number(p.chips||0));
    p.bet = Math.max(0, Number(p.bet||0));
    p.folded = !!p.folded;
    p.out = !!p.out;
    p.acted = !!p.acted;
    if(!Array.isArray(p.hand)) p.hand = [];
    p.hand = p.hand.filter(Boolean).slice(0,2);
  }

  return out;
}

/* -------------------- Helpers -------------------- */
function show(el, yes){ if(el) el.style.display = yes ? "flex" : "none"; }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function cardKey(c){ return c ? (c.r + c.s) : ""; }

function bumpToken(){ runToken = (runToken + 1) | 0; if(runToken<=0) runToken = 1; }

function stopAllTimers(){
  bumpToken();
  if(turnTimerId) clearInterval(turnTimerId);
  turnTimerId=null;
  if(botTimerId) clearTimeout(botTimerId);
  botTimerId=null;
  if(streetPauseId) clearTimeout(streetPauseId);
  streetPauseId=null;
}

function newDeck(){
  const d = [];
  for(const s of SUITS) for(const r of RANKS) d.push({r,s});
  for(let i=d.length-1;i>0;i--){
    const j = (Math.random()*(i+1))|0;
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function inHandPlayers(){ return players.filter(p=>p && !p.out && !p.folded); }

function nextActiveIndex(from){
  const n = players.length;
  if(n<=0) return 0;
  for(let k=1;k<=n;k++){
    const i=(from+k)%n;
    const p=players[i];
    if(p && !p.out && !p.folded) return i;
  }
  return from % n;
}
function nextNotOutIndex(from){
  const n = players.length;
  if(n<=0) return 0;
  for(let k=1;k<=n;k++){
    const i=(from+k)%n;
    const p=players[i];
    if(p && !p.out) return i;
  }
  return from % n;
}
function onlyOneLeftInHand(){ return inHandPlayers().length===1; }

function streetName(st){
  if(st==="PREFLOP") return "Префлоп…";
  if(st==="FLOP") return "Флоп…";
  if(st==="TURN") return "Тёрн…";
  if(st==="RIVER") return "Ривер…";
  if(st==="SHOWDOWN") return "Шоудаун…";
  return "";
}

/* -------------------- Evaluator best 5 of 7 -------------------- */
function straightHighFromSet(set){
  if(set.has(14)&&set.has(5)&&set.has(4)&&set.has(3)&&set.has(2)) return 5;
  for(let hi=14;hi>=5;hi--){
    let ok=true;
    for(let d=0;d<5;d++){ if(!set.has(hi-d)){ ok=false; break; } }
    if(ok) return hi;
  }
  return 0;
}

function evaluate5(cards5){
  const ranks = cards5.map(c=>RVAL[c.r]).sort((a,b)=>b-a);
  const suits = cards5.map(c=>c.s);
  const isFlush = suits.every(s=>s===suits[0]);

  const count=new Map();
  for(const r of ranks) count.set(r,(count.get(r)||0)+1);
  const unique=[...new Set(ranks)].sort((a,b)=>b-a);
  const set=new Set(unique);
  const st=straightHighFromSet(set);
  const groups=[...count.entries()].map(([r,c])=>({r,c}))
    .sort((a,b)=>(b.c-a.c)||(b.r-a.r));

  if(isFlush && st) return {cat:8,tiebreak:[st]};
  if(groups[0].c===4){
    const quad=groups[0].r;
    const kicker=unique.find(x=>x!==quad);
    return {cat:7,tiebreak:[quad,kicker]};
  }
  if(groups[0].c===3 && groups[1] && groups[1].c===2){
    return {cat:6,tiebreak:[groups[0].r, groups[1].r]};
  }
  if(isFlush) return {cat:5,tiebreak:ranks};
  if(st) return {cat:4,tiebreak:[st]};
  if(groups[0].c===3){
    const trip=groups[0].r;
    const kick=unique.filter(x=>x!==trip);
    return {cat:3,tiebreak:[trip,...kick]};
  }
  if(groups[0].c===2 && groups[1] && groups[1].c===2){
    const p1=Math.max(groups[0].r,groups[1].r);
    const p2=Math.min(groups[0].r,groups[1].r);
    const k=unique.find(x=>x!==p1 && x!==p2);
    return {cat:2,tiebreak:[p1,p2,k]};
  }
  if(groups[0].c===2){
    const p=groups[0].r;
    const kick=unique.filter(x=>x!==p);
    return {cat:1,tiebreak:[p,...kick]};
  }
  return {cat:0,tiebreak:ranks};
}

function compareEval(a,b){
  if(a.cat!==b.cat) return a.cat-b.cat;
  const L=Math.max(a.tiebreak.length,b.tiebreak.length);
  for(let i=0;i<L;i++){
    const x=a.tiebreak[i]||0, y=b.tiebreak[i]||0;
    if(x!==y) return x-y;
  }
  return 0;
}

function bestOf7(cards7){
  let best=null, best5=null;
  const n=cards7.length;
  for(let a=0;a<n-4;a++)
    for(let b=a+1;b<n-3;b++)
      for(let c=b+1;c<n-2;c++)
        for(let d=c+1;d<n-1;d++)
          for(let e=d+1;e<n;e++){
            const combo=[cards7[a],cards7[b],cards7[c],cards7[d],cards7[e]];
            const ev=evaluate5(combo);
            if(!best || compareEval(best,ev)<0){ best=ev; best5=combo; }
          }
  return {ev:best, best5};
}

function catName(cat){
  return ["High Card","Pair","Two Pair","Three of a Kind","Straight","Flush","Full House","Four of a Kind","Straight Flush"][cat]||"Unknown";
}

/* -------------------- Win% MonteCarlo (unknown bots) -------------------- */
function monteCarloWinPct(){
  if(!handInProgress) return null;
  const hero=players[0];
  if(!hero || hero.out || hero.folded || !Array.isArray(hero.hand) || hero.hand.length<2) return null;

  const opps = players
    .map((p,idx)=>({p,idx}))
    .filter(x=>x.idx!==0 && x.p && !x.p.out && !x.p.folded);

  if(opps.length===0) return 100;

  const known=[];
  for(const c of hero.hand) known.push(c);
  for(const c of board) if(c) known.push(c);

  const full=[];
  for(const s of SUITS) for(const r of RANKS) full.push({r,s});
  const used=new Set(known.map(cardKey));
  const remaining=full.filter(c=>!used.has(cardKey(c)));

  const iters = (board.length===0 ? MC_ITERS_PREFLOP : MC_ITERS_POSTFLOP);
  let score=0;

  for(let t=0;t<iters;t++){
    const needBoard=5-board.length;
    const needOpp=opps.length*2;
    const needTotal=needBoard+needOpp;

    const pool=remaining.slice();
    for(let i=pool.length-1;i>0;i--){
      const j=(Math.random()*(i+1))|0;
      [pool[i],pool[j]]=[pool[j],pool[i]];
    }
    const pick=pool.slice(0,needTotal);

    const simBoard=board.slice();
    for(let i=0;i<needBoard;i++) simBoard.push(pick[i]);

    let off=needBoard;
    const oppHands=[];
    for(let k=0;k<opps.length;k++){
      oppHands.push([pick[off],pick[off+1]]);
      off+=2;
    }

    const heroBest=bestOf7(hero.hand.concat(simBoard)).ev;

    let heroIsBest=true;
    let tieCount=1;

    for(let k=0;k<opps.length;k++){
      const oppEv=bestOf7(oppHands[k].concat(simBoard)).ev;
      const cmp=compareEval(heroBest, oppEv);
      if(cmp<0){ heroIsBest=false; break; }
      if(cmp===0) tieCount++;
    }

    if(heroIsBest) score += 1/tieCount;
  }

  return Math.round((score/iters)*100);
}

/* -------------------- Betting round logic -------------------- */
function resetActedFlags(){ for(const p of players) if(p && !p.out && !p.folded) p.acted=false; }
function resetOthersActedAfterRaise(raiserIdx){
  for(let i=0;i<players.length;i++){
    const p=players[i];
    if(!p || p.out || p.folded) continue;
    p.acted = (i===raiserIdx);
  }
}

function bettingRoundComplete(){
  for(const p of inHandPlayers()){
    if(p.chips===0) continue;      // all-in doesn't need to act
    if(!p.acted) return false;
    if(p.bet!==toCall) return false;
  }
  return true;
}

function minRaiseTo(){
  // simple model: min raise = toCall + BB
  return toCall + BIG_BLIND;
}

/* -------------------- Timer / Actions scheduling -------------------- */
function scheduleTimeout(fn, ms){
  const token = runToken;
  return setTimeout(()=>{
    if(token !== runToken) return;
    fn();
  }, ms);
}

function scheduleInterval(fn, ms){
  const token = runToken;
  return setInterval(()=>{
    if(token !== runToken) return;
    fn();
  }, ms);
}

/* -------------------- Turn timer -------------------- */
function startTurnTimer(){
  if(turnTimerId) clearInterval(turnTimerId);
  turnLeft = turnSeconds;
  elTurnTimer.textContent = String(turnLeft);

  turnTimerId = scheduleInterval(()=>{
    if(menuOpen || paused) return;
    turnLeft--;
    elTurnTimer.textContent = String(Math.max(0, turnLeft));
    if(turnLeft<=0){
      if(turnTimerId) clearInterval(turnTimerId);
      turnTimerId=null;
      onTurnTimeout();
    }
  }, 1000);
}

function onTurnTimeout(){
  if(!handInProgress || paused) return;
  if(!players[current] || players[current].isBot) return;
  const you = players[0];
  const need = Math.max(0, toCall - (you?.bet||0));
  if(need===0) playerCheck(0, true);
  else playerFold(0, true);
}

/* -------------------- Tournament management -------------------- */
function ensureTournament(){
  // IMPORTANT: must NOT modify paused here
  if(tournamentStarted && Array.isArray(players) && players.length===BOT_COUNT+1) return;

  players = [];
  players.push({name:nick||"YOU", isBot:false, chips:START_CHIPS, bet:0, folded:false, out:false, acted:false, hand:[]});
  for(let i=1;i<=BOT_COUNT;i++){
    players.push({name:`BOT${i}`, isBot:true, chips:START_CHIPS, bet:0, folded:false, out:false, acted:false, hand:[]});
  }

  dealer=0; sb=1; bb=2;
  stage="IDLE"; board=[]; pot=0; toCall=0; raisesThisRound=0;
  handInProgress=false;
  tournamentStarted=true;
}

function cleanupElims(){
  for(const p of players){
    if(!p) continue;
    if(!p.out && p.chips<=0){
      p.out=true;
      p.chips=0;
      p.folded=true;
    }
  }
}

function tournamentWinner(){
  const alive = players.filter(p=>p && !p.out);
  return alive.length===1 ? alive[0] : null;
}

function postBlind(i, amount){
  const p=players[i];
  if(!p || p.out) return;
  const pay=Math.min(amount, p.chips);
  p.chips-=pay; p.bet+=pay; pot+=pay;
}

/* -------------------- Hand flow -------------------- */
function hardResetRoundForNewStreet(){
  for(const p of players){
    if(!p || p.out) continue;
    p.bet = 0;
    p.acted = false;
  }
  toCall = 0;
  raisesThisRound = 0;
}

function startHandAuto(){
  // Called only when RUNNING (not paused/menu)
  if(menuOpen || paused) return;
  ensureTournament();

  cleanupElims();

  const w = tournamentWinner();
  if(w){
    elMsg.textContent = `🏆 CHAMPION: ${w.name}! (новый турнир через 2 сек)`;
    handInProgress=false;
    stage="IDLE";
    render(); save();

    stopAllTimers();
    streetPauseId = scheduleTimeout(()=>{
      if(menuOpen || paused) return;
      // New tournament
      players.forEach(p=>{
        p.out=false; p.folded=false; p.bet=0; p.hand=[]; p.acted=false;
        p.chips=START_CHIPS;
      });
      dealer=0; sb=1; bb=2;
      pot=0; board=[]; toCall=0; raisesThisRound=0;
      stage="IDLE"; handInProgress=false;
      render(); save();
      // start again
      startHandAuto();
    }, 2000);

    return;
  }

  // fresh hand
  handInProgress=true;
  stage="PREFLOP";
  deck=newDeck();
  board=[];
  pot=0;

  for(const p of players){
    if(!p) continue;
    p.folded=false;
    p.bet=0;
    p.hand=[];
    p.acted=false;
  }

  dealer = nextNotOutIndex(dealer);
  sb = nextNotOutIndex(dealer);
  bb = nextNotOutIndex(sb);

  // deal 2 cards each (skip out players)
  for(let r=0;r<2;r++){
    for(const p of players){
      if(p && !p.out) p.hand.push(deck.pop());
    }
  }

  // blinds
  hardResetRoundForNewStreet();
  postBlind(sb, SMALL_BLIND);
  postBlind(bb, BIG_BLIND);
  toCall = Math.max(players[sb]?.bet||0, players[bb]?.bet||0);

  // who acts first preflop: after BB
  current = nextActiveIndex(bb);

  // reset hero info
  heroComboText="";
  heroWinPct=null;
  heroHighlightKeys.clear();

  elMsg.textContent="Новая раздача…";
  render();
  save();
  tick();
}

function pauseThen(fn, text){
  stopAllTimers();
  elMsg.textContent = text;
  renderHUD();

  streetPauseId = scheduleTimeout(()=>{
    if(menuOpen || paused) return;
    fn();
  }, STREET_PAUSE_MS);
}

function advanceStage(){
  if(!handInProgress) return;

  const nextLabel =
    stage==="PREFLOP" ? "Флоп…" :
    stage==="FLOP"   ? "Тёрн…" :
    stage==="TURN"   ? "Ривер…" :
    stage==="RIVER"  ? "Шоудаун…" : "";

  pauseThen(()=>{
    // if ended by folds during pause:
    if(!handInProgress) return;

    hardResetRoundForNewStreet();

    if(stage==="PREFLOP"){
      board.push(deck.pop(), deck.pop(), deck.pop());
      stage="FLOP";
    } else if(stage==="FLOP"){
      board.push(deck.pop());
      stage="TURN";
    } else if(stage==="TURN"){
      board.push(deck.pop());
      stage="RIVER";
    } else if(stage==="RIVER"){
      stage="SHOWDOWN";
    }

    // first to act postflop: left of dealer (i.e. next active after dealer)
    current = nextActiveIndex(dealer);

    render(); save();

    if(stage==="SHOWDOWN"){
      pauseThen(doShowdown, "Шоудаун…");
      return;
    }
    tick();
  }, nextLabel);
}

function doShowdown(){
  if(!handInProgress) return;

  const contenders = inHandPlayers();
  if(contenders.length===1){
    awardPot(players.indexOf(contenders[0]), "(all folded)");
    return;
  }

  const evals = contenders.map(p=>{
    const {ev}=bestOf7(p.hand.concat(board));
    return {p, ev};
  }).sort((a,b)=>compareEval(a.ev,b.ev));

  const best = evals[evals.length-1].ev;
  const winners = evals.filter(x=>compareEval(x.ev, best)===0).map(x=>x.p);

  const share = Math.floor(pot / winners.length);
  let rem = pot - share*winners.length;
  for(const w of winners){
    w.chips += share;
    if(rem>0){ w.chips += 1; rem--; }
  }

  elMsg.textContent = `Победитель: ${winners.map(w=>w.name).join(", ")}`;
  pot=0;

  handInProgress=false;
  stage="IDLE";
  cleanupElims();

  render(); save();

  stopAllTimers();
  streetPauseId = scheduleTimeout(()=>{
    if(menuOpen || paused) return;
    startHandAuto();
  }, 1200);
}

function awardPot(idx, reason){
  const p = players[idx];
  if(p) p.chips += pot;

  elMsg.textContent = `${p?.name||"Player"} wins ${pot} ${reason||""}`.trim();
  pot=0;

  handInProgress=false;
  stage="IDLE";
  cleanupElims();

  render(); save();

  stopAllTimers();
  streetPauseId = scheduleTimeout(()=>{
    if(menuOpen || paused) return;
    startHandAuto();
  }, 1200);
}

/* -------------------- Player actions -------------------- */
function playerFold(i, byTimeout=false){
  stopAllTimers();
  const p=players[i];
  if(!handInProgress || !p || p.out || p.folded) { tick(); return; }

  p.folded=true;
  p.acted=true;

  elMsg.textContent = byTimeout ? `${p.name} auto-fold (timeout)` : `${p.name} folds`;
  render(); save();

  if(onlyOneLeftInHand()){
    awardPot(players.indexOf(inHandPlayers()[0]), "(all folded)");
    return;
  }

  current = nextActiveIndex(i);
  if(bettingRoundComplete()){ advanceStage(); return; }
  tick();
}

function playerCheck(i, byTimeout=false){
  stopAllTimers();
  const p=players[i];
  if(!handInProgress || !p || p.out || p.folded) { tick(); return; }

  const need = Math.max(0, toCall - p.bet);
  if(need!==0){ tick(); return; }

  p.acted=true;

  elMsg.textContent = byTimeout ? `${p.name} auto-check (timeout)` : `${p.name} checks`;
  current = nextActiveIndex(i);

  render(); save();
  if(bettingRoundComplete()){ advanceStage(); return; }
  tick();
}

function playerCall(i){
  stopAllTimers();
  const p=players[i];
  if(!handInProgress || !p || p.out || p.folded) { tick(); return; }

  const need = Math.max(0, toCall - p.bet);
  const pay = Math.min(need, p.chips);

  p.chips -= pay;
  p.bet   += pay;
  pot     += pay;

  p.acted = true;

  elMsg.textContent = `${p.name} calls ${pay}`;
  current = nextActiveIndex(i);

  render(); save();
  if(bettingRoundComplete()){ advanceStage(); return; }
  tick();
}

function playerRaiseTo(i, raiseTo){
  stopAllTimers();
  const p=players[i];
  if(!handInProgress || !p || p.out || p.folded) { tick(); return; }

  if(raisesThisRound >= MAX_RAISES_PER_ROUND){
    playerCall(i);
    return;
  }

  const min = minRaiseTo();
  const max = p.bet + p.chips;

  raiseTo = clamp(Math.max(raiseTo, min), 0, max);

  const add = Math.max(0, raiseTo - p.bet);
  const pay = Math.min(add, p.chips);
  if(pay<=0){ playerCall(i); return; }

  p.chips -= pay;
  p.bet   += pay;
  pot     += pay;

  toCall = Math.max(toCall, p.bet);
  raisesThisRound++;

  resetOthersActedAfterRaise(i);

  elMsg.textContent = `${p.name} raises to ${p.bet}`;
  current = nextActiveIndex(i);

  render(); save();
  tick();
}

/* -------------------- Bots -------------------- */
function botDecision(i){
  const p=players[i];
  const need=Math.max(0,toCall - p.bet);
  const stack=Math.max(1,p.chips);
  const pressure=need/(stack+1);

  if(stage==="PREFLOP"){
    const a=RVAL[p.hand[0].r], b=RVAL[p.hand[1].r];
    const pair=p.hand[0].r===p.hand[1].r;
    const suited=p.hand[0].s===p.hand[1].s;
    const high=Math.max(a,b);
    const gap=Math.abs(a-b);

    let score=0;
    score+=pair?0.55:0;
    score+=(high/14)*0.30;
    score+=suited?0.08:0;
    score+=(gap<=2)?0.06:0;
    score+=(Math.random()-0.5)*0.06;

    if(need===0) return (score>0.74 && raisesThisRound<MAX_RAISES_PER_ROUND && Math.random()<0.28) ? "RAISE" : "CHECK";
    if(score<0.33 && pressure>0.12 && Math.random()<0.85) return "FOLD";
    if(score>0.79 && raisesThisRound<MAX_RAISES_PER_ROUND && Math.random()<0.42) return "RAISE";
    return "CALL";
  }

  const {ev}=bestOf7(p.hand.concat(board));
  let strength=(ev.cat/8) + (Math.random()-0.5)*0.10;

  if(need===0) return (strength>0.62 && raisesThisRound<MAX_RAISES_PER_ROUND && Math.random()<0.22) ? "RAISE" : "CHECK";
  if(strength<0.25 && pressure>0.14 && Math.random()<0.80) return "FOLD";
  if(strength>0.72 && raisesThisRound<MAX_RAISES_PER_ROUND && Math.random()<0.30) return "RAISE";
  return "CALL";
}

function botAct(){
  if(!handInProgress || menuOpen || paused) return;

  // skip invalid / folded
  if(players[current]?.out || players[current]?.folded){
    current = nextActiveIndex(current);
  }

  if(onlyOneLeftInHand()){
    awardPot(players.indexOf(inHandPlayers()[0]), "(all folded)");
    return;
  }

  const d=botDecision(current);
  if(d==="FOLD") playerFold(current);
  else if(d==="CHECK") playerCheck(current);
  else if(d==="RAISE"){
    const p=players[current];
    const min=minRaiseTo();
    const max=p.bet+p.chips;

    const {ev}=bestOf7(p.hand.concat(board));
    let bump=0;
    if(ev.cat>=4) bump+=BIG_BLIND*3;
    if(ev.cat>=6) bump+=BIG_BLIND*5;

    let target=min + ((Math.random()*3)|0)*BIG_BLIND + bump;
    target=clamp(target,min,max);
    playerRaiseTo(current,target);
  } else {
    playerCall(current);
  }
}

/* -------------------- HERO info -------------------- */
function updateHeroInfo(){
  heroComboText="";
  heroWinPct=null;
  heroHighlightKeys.clear();

  const hero=players[0];
  if(!handInProgress || !hero || hero.out || hero.folded || !hero.hand || hero.hand.length<2) return;

  const cards7=hero.hand.concat(board);
  const {ev,best5}=bestOf7(cards7);
  heroComboText=catName(ev.cat);
  for(const c of best5) heroHighlightKeys.add(cardKey(c));

  heroWinPct=monteCarloWinPct();
}

/* -------------------- Render -------------------- */
function renderHUD(){
  elNick.textContent = nick ?? "-";
  elStage.textContent = stage + (paused ? " (PAUSED)" : "");
  elPot.textContent = String(pot);
  elTurnName.textContent = players[current]?.name ?? "-";
  elStack.textContent = String(players[0]?.chips ?? 0);
  elTurnTimer.textContent = String(turnLeft);
}

function makeCardEl(text, hidden){
  const el=document.createElement("div");
  el.className="card" + (hidden ? " hidden" : "");
  if(hidden){ el.textContent="🂠"; return el; }
  if(!text){ el.style.opacity="0.35"; el.textContent="—"; return el; }
  const r=text.slice(0,1), s=text.slice(1);
  const sm=document.createElement("small"); sm.textContent=r;
  const suit=document.createElement("div"); suit.className="suit"; suit.textContent=s;
  el.appendChild(sm); el.appendChild(suit);
  return el;
}

function render(){
  updateHeroInfo();

  // board
  elBoard.innerHTML="";
  for(let i=0;i<5;i++){
    const c=board[i];
    const el=makeCardEl(c ? (c.r+c.s) : "", !c);
    if(c && heroHighlightKeys.has(cardKey(c))) el.classList.add("neon");
    elBoard.appendChild(el);
  }

  // seats
  elSeats.innerHTML="";
  const pos=["pos-0","pos-1","pos-2","pos-3","pos-4","pos-5"];
  for(let i=0;i<players.length;i++){
    const p=players[i];
    const seat=document.createElement("div");
    seat.className=`seat ${pos[i]||"pos-5"}`;

    const top=document.createElement("div");
    top.className="top";

    const nm=document.createElement("div");
    nm.className="name";
    nm.textContent=p?.name ?? `P${i}`;

    const tag=document.createElement("div");
    tag.className="tag";

    if(p?.out){ tag.classList.add("out"); tag.textContent="OUT"; }
    else if(handInProgress && i===current && !p?.folded && !paused){ tag.classList.add("turn"); tag.textContent="TURN"; }
    else tag.textContent = p?.isBot ? "BOT" : "YOU";

    top.appendChild(nm);
    top.appendChild(tag);

    const meta=document.createElement("div");
    meta.className="meta";
    meta.innerHTML=`<span>chips: <b>${p?.chips ?? 0}</b></span><span>${p?.folded ? "<span style='color:var(--danger)'>folded</span>" : ""}</span>`;

    const cards=document.createElement("div");
    cards.className="cards" + ((i===0 && p?.folded) ? " folded" : "");

    const hidden = p?.isBot && handInProgress && stage!=="SHOWDOWN";
    const show   = !p?.isBot || stage==="SHOWDOWN" || !handInProgress;

    const c1=p?.hand?.[0], c2=p?.hand?.[1];
    const el1=makeCardEl(c1 && show ? (c1.r+c1.s) : "", hidden || !show);
    const el2=makeCardEl(c2 && show ? (c2.r+c2.s) : "", hidden || !show);

    if(i===0 && c1 && heroHighlightKeys.has(cardKey(c1))) el1.classList.add("neon");
    if(i===0 && c2 && heroHighlightKeys.has(cardKey(c2))) el2.classList.add("neon");

    cards.appendChild(el1);
    cards.appendChild(el2);

    const betEl=document.createElement("div");
    betEl.className="bet";
    betEl.textContent = p?.out ? "" : ((p?.bet||0)>0 ? `Bet: ${p.bet}` : "");

    seat.appendChild(top);
    seat.appendChild(meta);
    seat.appendChild(cards);
    seat.appendChild(betEl);

    if(i===0){
      const info=document.createElement("div");
      info.className="hero-info";
      info.innerHTML = `<div>Hand: <b>${heroComboText || "-"}</b></div>
                        <div>Win: <span class="pct">${heroWinPct==null ? "-" : heroWinPct+"%"}</span></div>`;
      seat.appendChild(info);
    }

    elSeats.appendChild(seat);
  }

  renderHUD();
  updateButtons();
}

function updateButtons(){
  const you=players[0];
  const yourTurn = tournamentStarted && handInProgress && current===0 &&
    you && !you.out && !you.folded && !menuOpen && !paused;

  btnFold.disabled = !yourTurn;
  btnRaise.disabled = !yourTurn || raisesThisRound>=MAX_RAISES_PER_ROUND;

  const need = (you && handInProgress) ? Math.max(0, toCall - (you.bet||0)) : 0;
  btnCheck.disabled = !(yourTurn && need===0);
  btnCall.disabled  = !(yourTurn && need>0);
}

/* -------------------- Raise modal -------------------- */
function openRaiseModal(){
  const you=players[0];
  if(!you) return;

  const min=clamp(minRaiseTo(), 0, you.bet+you.chips);
  const max=you.bet+you.chips;

  raiseSlider.min=String(min);
  raiseSlider.max=String(max);
  raiseSlider.value=String(min);

  raiseToLabel.textContent=String(min);

  raiseInput.value=String(min);
  raiseInput.min=String(min);
  raiseInput.max=String(max);

  show(raiseOverlay,true);
}
function closeRaiseModal(){ show(raiseOverlay,false); }
function syncRaiseFromSlider(){
  const v=Number(raiseSlider.value);
  raiseToLabel.textContent=String(v);
  raiseInput.value=String(v);
}
function syncRaiseFromInput(){
  const you=players[0];
  if(!you) return;
  const min=clamp(minRaiseTo(),0,you.bet+you.chips);
  const max=you.bet+you.chips;
  let v=Number(raiseInput.value||min);
  v=clamp(v,min,max);
  raiseInput.value=String(v);
  raiseSlider.value=String(v);
  raiseToLabel.textContent=String(v);
}

/* -------------------- Menu -------------------- */
function buildMenuControls(){
  const modal = menuOverlay?.querySelector(".modal");
  if(!modal) return;

  const old = modal.querySelector(".menu-controls");
  if(old) old.remove();

  const wrap=document.createElement("div");
  wrap.className="menu-controls";

  const row1=document.createElement("div");
  row1.className="menu-row";
  row1.innerHTML = `<div class="label">Status: <b>${paused ? "PAUSED" : "RUNNING"}</b></div>`;

  const btns=document.createElement("div");
  btns.style.display="flex";
  btns.style.gap="10px";
  btns.style.flexWrap="wrap";

  const pauseBtn=document.createElement("button");
  pauseBtn.className="btn";
  pauseBtn.textContent="Pause";
  pauseBtn.onclick=()=>{
    pauseGame();
    buildMenuControls();
  };

  const resumeBtn=document.createElement("button");
  resumeBtn.className="btn accent";
  resumeBtn.textContent="Resume";
  resumeBtn.onclick=()=>{ resumeGame(); };

  const newBtn=document.createElement("button");
  newBtn.className="btn danger";
  newBtn.textContent="New Tournament";
  newBtn.onclick=()=>{
    if(!confirm("Сбросить турнир и начать заново?")) return;
    stopAllTimers();
    ensureTournament();
    players.forEach(p=>{
      p.out=false; p.folded=false; p.bet=0; p.hand=[]; p.acted=false;
      p.chips=START_CHIPS;
    });
    dealer=0; sb=1; bb=2;
    stage="IDLE"; pot=0; board=[]; toCall=0; raisesThisRound=0;
    handInProgress=false;

    paused=true;
    render();
    save();
    buildMenuControls();
  };

  btns.appendChild(pauseBtn);
  btns.appendChild(resumeBtn);
  btns.appendChild(newBtn);
  row1.appendChild(btns);

  const row2=document.createElement("div");
  row2.className="menu-row";

  const lab=document.createElement("div");
  lab.className="label";
  lab.textContent="Turn time:";

  const sel=document.createElement("select");
  for(const v of TURN_SECONDS_OPTIONS){
    const opt=document.createElement("option");
    opt.value=String(v);
    opt.textContent=`${v} sec`;
    if(v===turnSeconds) opt.selected=true;
    sel.appendChild(opt);
  }
  sel.onchange=()=>{
    turnSeconds=Number(sel.value);
    save();
  };

  row2.appendChild(lab);
  row2.appendChild(sel);

  wrap.appendChild(row1);
  wrap.appendChild(row2);
  modal.appendChild(wrap);
}

function openMenu(){
  menuOpen=true;
  stopAllTimers();
  show(menuOverlay,true);
  buildMenuControls();
  renderHUD();
  updateButtons();
}

function closeMenu(){
  show(menuOverlay,false);
  menuOpen=false;
  // If running - continue tick
  if(!paused) tick();
  else updateButtons();
}

function pauseGame(){
  paused=true;
  stopAllTimers();
  render();
  save();
}

function resumeGame(){
  // absolute guarantee: on Resume we always have valid tournament, we close menu, unpause, then either deal or tick.
  stopAllTimers();
  ensureTournament();

  paused=false;
  menuOpen=false;
  show(menuOverlay,false);

  // If no hand or IDLE => deal immediately
  if(!handInProgress || stage==="IDLE"){
    startHandAuto();
    save();
    return;
  }

  tick();
  save();
}

/* -------------------- Tick (main loop) -------------------- */
function tick(){
  stopAllTimers(); // clears pending stuff & bumps token (prevents race)
  // BUT: stopAllTimers also bumps token; if we want to keep token stable for new timers,
  // it's fine because we schedule new ones after this.

  if(menuOpen || paused){
    updateButtons();
    return;
  }

  ensureTournament();

  // Auto-start hand if running but idle
  if(!handInProgress || stage==="IDLE"){
    startHandAuto();
    return;
  }

  // If showdown stage reached, we should already be in doShowdown scheduling; don't act here.
  if(stage==="SHOWDOWN"){
    updateButtons();
    return;
  }

  // skip invalid current
  if(players[current]?.out || players[current]?.folded){
    current = nextActiveIndex(current);
  }

  renderHUD();
  updateButtons();

  const actor = players[current];
  if(!actor){
    // emergency reset
    stage="IDLE";
    handInProgress=false;
    render(); save();
    startHandAuto();
    return;
  }

  if(!actor.isBot){
    elMsg.textContent="Твой ход.";
    startTurnTimer();
    return;
  }

  elMsg.textContent="Бот думает…";
  botTimerId = scheduleTimeout(()=>botAct(), BOT_THINK_MS);
}

/* -------------------- Events -------------------- */
btnMenu?.addEventListener("click", openMenu);
btnCloseMenu?.addEventListener("click", closeMenu);

btnFold?.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) playerFold(0); });
btnCheck?.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) playerCheck(0); });
btnCall?.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) playerCall(0); });
btnRaise?.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) openRaiseModal(); });

raiseSlider?.addEventListener("input", syncRaiseFromSlider);
raiseInput?.addEventListener("input", syncRaiseFromInput);
btnRaiseClose?.addEventListener("click", closeRaiseModal);
btnRaiseConfirm?.addEventListener("click", ()=>{
  const v=Number(raiseSlider.value);
  closeRaiseModal();
  if(current===0 && !paused && !menuOpen) playerRaiseTo(0, v);
});
btnRaiseMin?.addEventListener("click", ()=>{ raiseSlider.value=raiseSlider.min; syncRaiseFromSlider(); });
btnRaiseAll?.addEventListener("click", ()=>{ raiseSlider.value=raiseSlider.max; syncRaiseFromSlider(); });
btnRaiseHalf?.addEventListener("click", ()=>{
  const min=Number(raiseSlider.min), max=Number(raiseSlider.max);
  raiseSlider.value=String(((min+max)/2)|0);
  syncRaiseFromSlider();
});

/* -------------------- Nick flow -------------------- */
function openNick(){
  show(nickOverlay,true);
  const last=localStorage.getItem("poker_last_nick");
  if(last){ nickInput.value=last; nickInput.select(); }
  setTimeout(()=>nickInput.focus(), 30);
}

nickOk?.addEventListener("click", ()=>{
  const n = nickInput.value.trim();
  if(!n){ nickInput.focus(); return; }

  nick = n;
  saveKey = keyForNick(nick);

  const stRaw = load(nick);
  const st = sanitizeLoadedState(stRaw);

  if(st){
    turnSeconds = Number(st.turnSeconds ?? TURN_SECONDS_DEFAULT);
    paused = !!st.paused;

    const t = st.tournament;

    players = safeClone(t.players);
    deck    = safeClone(t.deck ?? []);
    board   = safeClone(t.board ?? []);
    pot     = Number(t.pot ?? 0);
    stage   = String(t.stage ?? "IDLE");
    dealer  = Number(t.dealer ?? 0);
    sb      = Number(t.sb ?? 1);
    bb      = Number(t.bb ?? 2);
    current = Number(t.current ?? 0);
    toCall  = Number(t.toCall ?? 0);
    raisesThisRound = Number(t.raisesThisRound ?? 0);
    handInProgress = !!t.handInProgress;
    tournamentStarted = !!t.tournamentStarted;

    // force hero naming
    if(players[0]){ players[0].isBot=false; players[0].name=nick; }
    for(const p of players) if(p) p.acted = !!p.acted;

    // if loaded weirdness -> fix
    ensureTournament();
  } else {
    ensureTournament();
    paused = true;
  }

  show(nickOverlay,false);
  render();

  // open menu first: user clicks Resume
  openMenu();
  save();
});

nickInput?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") nickOk.click(); });

/* -------------------- Boot -------------------- */
function boot(){
  // minimal placeholders so UI has something before nick
  players = [
    {name:"YOU",isBot:false,chips:0,bet:0,folded:false,out:false,acted:false,hand:[]},
    {name:"BOT1",isBot:true,chips:0,bet:0,folded:false,out:false,acted:false,hand:[]},
    {name:"BOT2",isBot:true,chips:0,bet:0,folded:false,out:false,acted:false,hand:[]},
    {name:"BOT3",isBot:true,chips:0,bet:0,folded:false,out:false,acted:false,hand:[]},
    {name:"BOT4",isBot:true,chips:0,bet:0,folded:false,out:false,acted:false,hand:[]},
    {name:"BOT5",isBot:true,chips:0,bet:0,folded:false,out:false,acted:false,hand:[]},
  ];
  render();
  openNick();
}
boot();

/* -------------------- Critical: betting completion hooks --------------------
   These were already correct in your version. Here is the missing link:
   We must advance street when round complete after CALL/CHECK/FOLD. Already done above.
   Additionally, after each action we do tick(); so loop continues.
*/
