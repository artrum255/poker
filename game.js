/* Poker Tournament — REBUILD STABLE v500
   - Menu always opens
   - Pause freezes EVERYTHING
   - Resume always deals/continues
   - Streets correct: PREFLOP -> FLOP(3) -> TURN(1) -> RIVER(1) -> SHOWDOWN
   - Win% MC vs remaining opponents (bots unknown)
   - Highlight ONLY combo cards (no kickers)
   - Bots weaker (player has real chance)
   - Storage key: poker_stable_v500_<nick>
*/

"use strict";

/* =================== CONFIG =================== */
const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND   = 20;

const BOT_COUNT = 5;

// делаем меньше рейзов (и для игрока и для ботов) — игра спокойнее
const MAX_RAISES_PER_ROUND = 3;

// таймер
const TURN_SECONDS_OPTIONS = [5,10,15,20];
const TURN_SECONDS_DEFAULT = 15;

const BOT_THINK_MS    = 520;
const STREET_PAUSE_MS = 750;

const MC_ITERS_PREFLOP  = 300;
const MC_ITERS_POSTFLOP = 220;

const SUITS = ["♣","♦","♥","♠"];
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const RVAL  = Object.fromEntries(RANKS.map((r,i)=>[r,i+2]));

/* =================== DOM =================== */
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

const raiseOverlay    = $("raiseOverlay");
const raiseSlider     = $("raiseSlider");
const raiseToLabel    = $("raiseToLabel");
const raiseInput      = $("raiseInput");
const btnRaiseConfirm = $("btnRaiseConfirm");
const btnRaiseClose   = $("btnRaiseClose");
const btnRaiseMin     = $("btnRaiseMin");
const btnRaiseHalf    = $("btnRaiseHalf");
const btnRaiseAll     = $("btnRaiseAll");

/* =================== STATE =================== */
let nick = null;
let saveKey = null;

let players = [];
let deck = [];
let board = [];
let pot = 0;

let stage = "IDLE"; // IDLE, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN
let handInProgress = false;
let tournamentStarted = false;

let dealer = 0, sb = 1, bb = 2;
let current = 0;

let toCall = 0;
let raisesThisRound = 0;

let turnSeconds = TURN_SECONDS_DEFAULT;
let turnLeft = TURN_SECONDS_DEFAULT;

let paused = true;
let menuOpen = false;

/* timers + stale token */
let turnTimerId = null;
let botTimerId = null;
let streetPauseId = null;
let token = 1;

function bumpToken(){ token = (token + 1) | 0; if(token<=0) token = 1; }
function scheduleTimeout(fn, ms){
  const t = token;
  return setTimeout(()=>{ if(t===token) fn(); }, ms);
}
function scheduleInterval(fn, ms){
  const t = token;
  return setInterval(()=>{ if(t===token) fn(); }, ms);
}
function stopAllTimers(){
  bumpToken();
  if(turnTimerId) clearInterval(turnTimerId);
  if(botTimerId) clearTimeout(botTimerId);
  if(streetPauseId) clearTimeout(streetPauseId);
  turnTimerId = botTimerId = streetPauseId = null;
}

/* hero info */
let heroComboText = "";
let heroWinPct = null;
let heroHighlightKeys = new Set();

/* =================== EXTRA CSS (neon + hero bar) =================== */
(function injectExtraCSS(){
  const css = `
  .card.neon{
    box-shadow: 0 0 0 2px rgba(99,242,197,.65),
                0 0 12px rgba(99,242,197,.55),
                0 0 28px rgba(99,242,197,.35),
                0 10px 22px rgba(0,0,0,.55) !important;
    border-color: rgba(99,242,197,.7) !important;
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
  .menu-row .label{ color: rgba(181,201,193,.95); font-size:13px; font-weight:900; }
  .menu-row select{
    padding:10px 12px;
    border-radius:16px;
    border:1px solid rgba(255,255,255,.14);
    background:#0a1416;
    color:#eaf5f1;
    font-weight:900;
    outline:none;
  }`;
  const style=document.createElement("style");
  style.textContent=css;
  document.head.appendChild(style);
})();

/* =================== PERSIST =================== */
function keyForNick(n){ return `poker_stable_v500_${String(n||"").toLowerCase()}`; }

function save(){
  if(!saveKey) return;
  // важный трюк: сохраняем paused=true, чтобы после перезагрузки всегда начиналось с меню
  const state = {
    v: 500,
    nick,
    turnSeconds,
    paused: true,
    game: {
      players, deck, board, pot,
      stage, dealer, sb, bb, current,
      toCall, raisesThisRound,
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

/* =================== HELPERS =================== */
function show(el, yes){ el.style.display = yes ? "flex" : "none"; }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function cardKey(c){ return c ? (c.r + c.s) : ""; }

function newDeck(){
  const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({r,s});
  for(let i=d.length-1;i>0;i--){
    const j=(Math.random()*(i+1))|0;
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

function inHandPlayers(){ return players.filter(p=>!p.out && !p.folded); }
function nextActiveIndex(from){
  const n = players.length;
  for(let k=1;k<=n;k++){
    const i=(from+k)%n;
    if(!players[i].out && !players[i].folded) return i;
  }
  return from;
}
function nextNotOutIndex(from){
  const n = players.length;
  for(let k=1;k<=n;k++){
    const i=(from+k)%n;
    if(!players[i].out) return i;
  }
  return from;
}
function onlyOneLeftInHand(){ return inHandPlayers().length===1; }

/* =================== EVALUATOR =================== */
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
    return {cat:6,tiebreak:[groups[0].r,groups[1].r]};
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
function bestOf7(cards){
  if(!cards || cards.length<5) return {ev:{cat:0,tiebreak:[]}, best5:[]};
  let best=null, best5=null;
  const n=cards.length;
  for(let a=0;a<n-4;a++)
    for(let b=a+1;b<n-3;b++)
      for(let c=b+1;c<n-2;c++)
        for(let d=c+1;d<n-1;d++)
          for(let e=d+1;e<n;e++){
            const combo=[cards[a],cards[b],cards[c],cards[d],cards[e]];
            const ev=evaluate5(combo);
            if(!best || compareEval(best,ev)<0){ best=ev; best5=combo; }
          }
  if(!best) return {ev:{cat:0,tiebreak:[]}, best5:[]};
  return {ev:best, best5};
}
function catName(cat){
  return ["High Card","Pair","Two Pair","Trips","Straight","Flush","Full House","Quads","Straight Flush"][cat]||"Unknown";
}

/* ===== highlight ONLY combo cards (no kickers) ===== */
function comboOnlyCards(best5, ev){
  if(!best5 || !ev) return [];
  const cat = ev.cat;
  const tb  = ev.tiebreak || [];
  const rv = (c)=>RVAL[c.r];

  // Straight/Flush/FullHouse/StraightFlush => все 5 карт = комбинация
  if(cat===4 || cat===5 || cat===6 || cat===8) return best5;

  if(cat===7){ // quads
    const quad = tb[0];
    return best5.filter(c=>rv(c)===quad);
  }
  if(cat===3){ // trips
    const trip = tb[0];
    return best5.filter(c=>rv(c)===trip);
  }
  if(cat===2){ // two pair
    const p1=tb[0], p2=tb[1];
    return best5.filter(c=>{ const r=rv(c); return r===p1 || r===p2; });
  }
  if(cat===1){ // pair
    const pair=tb[0];
    return best5.filter(c=>rv(c)===pair);
  }

  // High card => ничего не подсвечиваем
  return [];
}

/* =================== WIN% MC =================== */
function monteCarloWinPct(){
  if(!handInProgress) return null;
  const hero=players[0];
  if(!hero || hero.out || hero.folded || hero.hand.length<2) return null;

  const opps = players
    .map((p,idx)=>({p,idx}))
    .filter(x=>x.idx!==0 && !x.p.out && !x.p.folded);

  if(opps.length===0) return 100;

  const known=[...hero.hand, ...board.filter(Boolean)];
  const used=new Set(known.map(cardKey));

  const full=[];
  for(const s of SUITS) for(const r of RANKS) full.push({r,s});
  const remaining=full.filter(c=>!used.has(cardKey(c)));

  const iters = (board.length===0 ? MC_ITERS_PREFLOP : MC_ITERS_POSTFLOP);
  let score=0;

  for(let t=0;t<iters;t++){
    const needBoard = 5 - board.length;
    const needOpp   = opps.length*2;
    const needTotal = needBoard + needOpp;

    const pool=remaining.slice();
    for(let i=pool.length-1;i>0;i--){
      const j=(Math.random()*(i+1))|0;
      [pool[i],pool[j]]=[pool[j],pool[i]];
    }
    const pick=pool.slice(0, needTotal);

    const simBoard = board.slice();
    for(let i=0;i<needBoard;i++) simBoard.push(pick[i]);

    let off=needBoard;
    const heroEv = bestOf7(hero.hand.concat(simBoard)).ev;

    let heroBest=true;
    let tie=1;

    for(let k=0;k<opps.length;k++){
      const oppHand=[pick[off], pick[off+1]];
      off+=2;
      const oppEv = bestOf7(oppHand.concat(simBoard)).ev;
      const cmp=compareEval(heroEv, oppEv);
      if(cmp<0){ heroBest=false; break; }
      if(cmp===0) tie++;
    }
    if(heroBest) score += 1/tie;
  }

  return Math.round((score/iters)*100);
}

/* =================== HERO INFO =================== */
function updateHeroInfo(){
  heroComboText="";
  heroWinPct=null;
  heroHighlightKeys.clear();

  const hero=players[0];
  if(!handInProgress || !hero || hero.out || hero.folded) return;

  const cards = hero.hand.concat(board);

  if(cards.length >= 5){
    const {ev,best5} = bestOf7(cards);
    heroComboText = catName(ev.cat);

    // ✅ подсвечиваем только КОМБО, без кикеров
    const only = comboOnlyCards(best5, ev);
    for(const c of only) heroHighlightKeys.add(cardKey(c));
  }

  heroWinPct = monteCarloWinPct();
}

/* =================== RENDER =================== */
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
  const r=text[0], s=text.slice(1);
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
    nm.textContent=p.name;

    const tag=document.createElement("div");
    tag.className="tag";
    if(p.out){ tag.classList.add("out"); tag.textContent="OUT"; }
    else if(handInProgress && i===current && !p.folded && !paused){ tag.classList.add("turn"); tag.textContent="TURN"; }
    else tag.textContent=p.isBot?"BOT":"YOU";

    top.appendChild(nm);
    top.appendChild(tag);

    const meta=document.createElement("div");
    meta.className="meta";
    meta.innerHTML=`<span>chips: <b>${p.chips}</b></span><span>${p.folded ? "<span style='color:var(--danger)'>folded</span>" : ""}</span>`;

    const cards=document.createElement("div");
    cards.className="cards";

    const hidden = p.isBot && handInProgress && stage!=="SHOWDOWN";
    const show   = !p.isBot || stage==="SHOWDOWN" || !handInProgress;

    const c1=p.hand?.[0], c2=p.hand?.[1];
    const el1=makeCardEl(c1 && show ? (c1.r+c1.s) : "", hidden || !show);
    const el2=makeCardEl(c2 && show ? (c2.r+c2.s) : "", hidden || !show);

    // highlight only hero combo cards
    if(i===0 && c1 && heroHighlightKeys.has(cardKey(c1))) el1.classList.add("neon");
    if(i===0 && c2 && heroHighlightKeys.has(cardKey(c2))) el2.classList.add("neon");

    cards.appendChild(el1);
    cards.appendChild(el2);

    const bet=document.createElement("div");
    bet.className="bet";
    bet.textContent = p.out ? "" : (p.bet>0 ? `Bet: ${p.bet}` : "");

    seat.appendChild(top);
    seat.appendChild(meta);
    seat.appendChild(cards);
    seat.appendChild(bet);

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

  const need = (you && handInProgress) ? Math.max(0,toCall-you.bet) : 0;
  btnCheck.disabled = !(yourTurn && need===0);
  btnCall.disabled  = !(yourTurn && need>0);
}

/* =================== TURN TIMER =================== */
function startTurnTimer(){
  if(turnTimerId) clearInterval(turnTimerId);
  turnLeft = turnSeconds;
  elTurnTimer.textContent = String(turnLeft);

  turnTimerId = scheduleInterval(()=>{
    if(menuOpen || paused) return;
    turnLeft--;
    elTurnTimer.textContent = String(Math.max(0,turnLeft));
    if(turnLeft<=0){
      clearInterval(turnTimerId);
      turnTimerId=null;
      onTurnTimeout();
    }
  }, 1000);
}

function onTurnTimeout(){
  if(!handInProgress || paused) return;
  if(players[current].isBot) return;

  const you=players[0];
  const need=Math.max(0,toCall-you.bet);
  if(need===0) playerCheck(0,true);
  else playerFold(0,true);
}

/* =================== TOURNAMENT / HAND =================== */
function ensureTournament(){
  if(tournamentStarted && players.length===BOT_COUNT+1) return;

  players=[];
  players.push({name:nick||"YOU",isBot:false,chips:START_CHIPS,bet:0,folded:false,out:false,acted:false,hand:[]});
  for(let i=1;i<=BOT_COUNT;i++){
    players.push({name:`BOT${i}`,isBot:true,chips:START_CHIPS,bet:0,folded:false,out:false,acted:false,hand:[]});
  }

  dealer=0; sb=1; bb=2;
  stage="IDLE";
  handInProgress=false;
  tournamentStarted=true;

  deck=[]; board=[]; pot=0;
  current=0; toCall=0; raisesThisRound=0;
}

function cleanupElims(){
  for(const p of players){
    if(!p.out && p.chips<=0){
      p.out=true;
      p.chips=0;
      p.folded=true;
    }
  }
}
function tournamentWinner(){
  const alive=players.filter(p=>!p.out);
  return alive.length===1 ? alive[0] : null;
}

function postBlind(i, amount){
  const p=players[i];
  const pay=Math.min(amount,p.chips);
  p.chips-=pay; p.bet+=pay; pot+=pay;
}

function resetStreetBets(){
  for(const p of players){
    p.bet=0;
    p.acted=false;
  }
  toCall=0;
  raisesThisRound=0;
}

function startHand(){
  if(menuOpen || paused) return;

  ensureTournament();
  cleanupElims();

  const champ=tournamentWinner();
  if(champ){
    elMsg.textContent=`🏆 CHAMPION: ${champ.name}! (new in 2s)`;
    render(); save();
    stopAllTimers();
    streetPauseId = scheduleTimeout(()=>{
      if(menuOpen || paused) return;
      players.forEach(p=>{
        p.out=false; p.folded=false; p.bet=0; p.hand=[]; p.acted=false; p.chips=START_CHIPS;
      });
      dealer=0; stage="IDLE"; pot=0; board=[]; toCall=0; raisesThisRound=0;
      handInProgress=false;
      render(); save();
      startHand();
    },2000);
    return;
  }

  handInProgress=true;
  stage="PREFLOP";
  deck=newDeck();
  board=[];
  pot=0;

  for(const p of players){
    p.folded=false; p.bet=0; p.hand=[]; p.acted=false;
  }

  dealer=nextNotOutIndex(dealer);
  sb=nextNotOutIndex(dealer);
  bb=nextNotOutIndex(sb);

  for(let r=0;r<2;r++){
    for(const p of players) if(!p.out) p.hand.push(deck.pop());
  }

  resetStreetBets();

  postBlind(sb,SMALL_BLIND);
  postBlind(bb,BIG_BLIND);
  toCall=Math.max(players[sb].bet, players[bb].bet);

  current=nextActiveIndex(bb);

  elMsg.textContent="Новая раздача…";
  render(); save();
  tick();
}

function pauseThen(fn, text){
  stopAllTimers();
  elMsg.textContent=text;
  renderHUD();
  streetPauseId = scheduleTimeout(()=>{
    if(menuOpen || paused) return;
    fn();
  }, STREET_PAUSE_MS);
}

function advanceStage(){
  const label =
    stage==="PREFLOP" ? "Флоп…" :
    stage==="FLOP"   ? "Тёрн…" :
    stage==="TURN"   ? "Ривер…" : "Шоудаун…";

  pauseThen(()=>{
    resetStreetBets();

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

    current = nextActiveIndex(dealer);
    render(); save();

    if(stage==="SHOWDOWN"){
      pauseThen(doShowdown, "Шоудаун…");
      return;
    }
    tick();
  }, label);
}

function doShowdown(){
  const contenders=inHandPlayers();
  if(contenders.length===1){
    awardPot(players.indexOf(contenders[0]),"(all folded)");
    return;
  }

  const evals=contenders.map(p=>{
    const {ev}=bestOf7(p.hand.concat(board));
    return {p,ev};
  }).sort((a,b)=>compareEval(a.ev,b.ev));

  const best=evals[evals.length-1].ev;
  const winners=evals.filter(x=>compareEval(x.ev,best)===0).map(x=>x.p);

  const share=Math.floor(pot/winners.length);
  let rem=pot-share*winners.length;
  for(const w of winners){
    w.chips+=share;
    if(rem>0){ w.chips+=1; rem--; }
  }

  elMsg.textContent=`Победитель: ${winners.map(w=>w.name).join(", ")}`;
  pot=0;
  handInProgress=false;
  stage="IDLE";
  cleanupElims();
  render(); save();

  stopAllTimers();
  streetPauseId=scheduleTimeout(()=>{ if(!menuOpen && !paused) startHand(); },1200);
}

function awardPot(idx, reason){
  players[idx].chips+=pot;
  elMsg.textContent=`${players[idx].name} wins ${pot} ${reason||""}`.trim();
  pot=0;
  handInProgress=false;
  stage="IDLE";
  cleanupElims();
  render(); save();

  stopAllTimers();
  streetPauseId=scheduleTimeout(()=>{ if(!menuOpen && !paused) startHand(); },1200);
}

/* =================== ACTIONS =================== */
function playerFold(i, byTimeout=false){
  stopAllTimers();
  const p=players[i];
  if(!handInProgress || p.out || p.folded) return;

  p.folded=true;
  p.acted=true;

  elMsg.textContent = byTimeout ? `${p.name} auto-fold (timeout)` : `${p.name} folds`;
  render(); save();

  if(onlyOneLeftInHand()){
    awardPot(players.indexOf(inHandPlayers()[0]),"(all folded)");
    return;
  }
  current=nextActiveIndex(i);
  if(bettingRoundComplete()){ advanceStage(); return; }
  tick();
}

function playerCheck(i, byTimeout=false){
  stopAllTimers();
  const p=players[i];
  if(!handInProgress || p.out || p.folded) return;

  const need=Math.max(0,toCall-p.bet);
  if(need!==0) return;

  p.acted=true;
  elMsg.textContent = byTimeout ? `${p.name} auto-check (timeout)` : `${p.name} checks`;
  current=nextActiveIndex(i);

  render(); save();
  if(bettingRoundComplete()){ advanceStage(); return; }
  tick();
}

function playerCall(i){
  stopAllTimers();
  const p=players[i];
  if(!handInProgress || p.out || p.folded) return;

  const need=Math.max(0,toCall-p.bet);
  const pay=Math.min(need,p.chips);
  p.chips-=pay; p.bet+=pay; pot+=pay;
  p.acted=true;

  elMsg.textContent=`${p.name} calls ${pay}`;
  current=nextActiveIndex(i);

  render(); save();
  if(bettingRoundComplete()){ advanceStage(); return; }
  tick();
}

function playerRaiseTo(i, raiseTo){
  stopAllTimers();
  const p=players[i];
  if(!handInProgress || p.out || p.folded) return;

  if(raisesThisRound>=MAX_RAISES_PER_ROUND){ playerCall(i); return; }

  const min = toCall + BIG_BLIND;
  const max = p.bet + p.chips;

  raiseTo = Math.max(raiseTo, min);
  raiseTo = Math.min(raiseTo, max);

  const add=Math.max(0, raiseTo-p.bet);
  const pay=Math.min(add, p.chips);
  if(pay<=0){ playerCall(i); return; }

  p.chips-=pay; p.bet+=pay; pot+=pay;
  toCall=Math.max(toCall,p.bet);
  raisesThisRound++;

  // после рейза остальные должны снова отвечать
  for(let k=0;k<players.length;k++){
    const q=players[k];
    if(q.out || q.folded) continue;
    q.acted = (k===i);
  }

  elMsg.textContent=`${p.name} raises to ${p.bet}`;
  current=nextActiveIndex(i);

  render(); save();
  tick();
}

function bettingRoundComplete(){
  for(const p of inHandPlayers()){
    if(p.chips===0) continue;
    if(!p.acted) return false;
    if(p.bet!==toCall) return false;
  }
  return true;
}

/* =================== BOTS (WEAKER) =================== */
/*
  Боты сделаны слабее специально:
  - часто просто чек/колл
  - редко рейзят
  - легко фолдят на давление
*/
function botDecision(i){
  const p=players[i];
  const need=Math.max(0,toCall-p.bet);

  // давление: сколько надо платить относительно стека
  const stack=Math.max(1,p.chips);
  const pressure = need/(stack+1);

  // очень пассивные боты: если можно чекнуть — часто чекают
  if(need===0){
    // иногда делают маленький рейз, но редко
    if(raisesThisRound < MAX_RAISES_PER_ROUND && Math.random() < 0.10) return "RAISE";
    return "CHECK";
  }

  // PREFLOP — грубая слабая логика
  if(stage==="PREFLOP"){
    const a=RVAL[p.hand[0].r], b=RVAL[p.hand[1].r];
    const pair = p.hand[0].r===p.hand[1].r;
    const suited = p.hand[0].s===p.hand[1].s;
    const high = Math.max(a,b);
    const gap = Math.abs(a-b);

    // низкая оценка силы (бот тупее)
    let score=0;
    score += pair ? 0.38 : 0;
    score += (high/14)*0.25;
    score += suited ? 0.06 : 0;
    score += (gap<=2) ? 0.04 : 0;
    score += (Math.random()-0.5)*0.10;

    // часто фолдят против давления
    if(pressure > 0.18 && score < 0.55 && Math.random() < 0.80) return "FOLD";
    if(score < 0.35 && Math.random() < 0.55) return "FOLD";

    // очень редко рейзят
    if(score > 0.82 && raisesThisRound < MAX_RAISES_PER_ROUND && Math.random() < 0.20) return "RAISE";

    return "CALL";
  }

  // POSTFLOP — смотрим только категорию (упрощено)
  const {ev} = bestOf7(p.hand.concat(board));
  const cat = ev.cat;

  // слабые руки часто фолдят на ставку
  if(cat <= 0){
    if(pressure > 0.10 && Math.random() < 0.85) return "FOLD";
    if(Math.random() < 0.55) return "FOLD";
    return "CALL";
  }
  if(cat === 1){ // pair
    if(pressure > 0.16 && Math.random() < 0.70) return "FOLD";
    if(Math.random() < 0.20) return "FOLD";
    if(raisesThisRound < MAX_RAISES_PER_ROUND && Math.random() < 0.06) return "RAISE";
    return "CALL";
  }
  if(cat === 2 || cat === 3){ // two pair / trips
    if(pressure > 0.22 && Math.random() < 0.35) return "FOLD";
    if(raisesThisRound < MAX_RAISES_PER_ROUND && Math.random() < 0.12) return "RAISE";
    return "CALL";
  }

  // straight+ — чаще колл, иногда рейз
  if(raisesThisRound < MAX_RAISES_PER_ROUND && Math.random() < 0.15) return "RAISE";
  return "CALL";
}

function botAct(){
  if(!handInProgress || menuOpen || paused) return;

  // пропускаем выбывших/сфолдивших
  if(players[current].out || players[current].folded) current=nextActiveIndex(current);

  if(onlyOneLeftInHand()){
    awardPot(players.indexOf(inHandPlayers()[0]),"(all folded)");
    return;
  }

  const d=botDecision(current);
  if(d==="FOLD") playerFold(current);
  else if(d==="CHECK") playerCheck(current);
  else if(d==="RAISE"){
    const p=players[current];
    const min = toCall + BIG_BLIND;
    const max = p.bet + p.chips;

    // слабые рейзы, чтобы боты не “давили”
    let target = min + ((Math.random()*2)|0)*BIG_BLIND;
    target = clamp(target, min, max);

    playerRaiseTo(current, target);
  } else {
    playerCall(current);
  }
}

/* =================== MENU =================== */
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
    paused=true;
    stopAllTimers();
    save();
    buildMenuControls();
    render();
  };

  const resumeBtn=document.createElement("button");
  resumeBtn.className="btn accent";
  resumeBtn.textContent="Resume";
  resumeBtn.onclick=()=>resumeGame();

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
    dealer=0; stage="IDLE"; pot=0; board=[]; toCall=0; raisesThisRound=0;
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
  tick();
}

/* ✅ Resume всегда делает действие */
function resumeGame(){
  stopAllTimers();
  ensureTournament();

  paused=false;
  menuOpen=false;
  show(menuOverlay,false);

  // если раздачи нет — стартуем
  if(!handInProgress || stage==="IDLE"){
    startHand();
  } else {
    tick();
  }
  save();
}

/* =================== TICK =================== */
function tick(){
  stopAllTimers();

  if(menuOpen || paused){
    updateButtons();
    return;
  }

  ensureTournament();

  if(!handInProgress || stage==="IDLE"){
    // автозапуск раздачи только когда RUNNING
    startHand();
    return;
  }

  if(stage==="SHOWDOWN"){
    updateButtons();
    return;
  }

  if(players[current].out || players[current].folded){
    current=nextActiveIndex(current);
  }

  renderHUD();
  updateButtons();

  if(!players[current].isBot){
    elMsg.textContent="Твой ход.";
    startTurnTimer();
    return;
  }

  elMsg.textContent="Бот думает…";
  botTimerId = scheduleTimeout(()=>botAct(), BOT_THINK_MS);
}

/* =================== RAISE MODAL =================== */
function openRaiseModal(){
  const you=players[0];
  const min=clamp(toCall + BIG_BLIND, 0, you.bet + you.chips);
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
  const min=clamp(toCall + BIG_BLIND, 0, you.bet + you.chips);
  const max=you.bet+you.chips;
  let v=Number(raiseInput.value||min);
  v=clamp(v,min,max);
  raiseInput.value=String(v);
  raiseSlider.value=String(v);
  raiseToLabel.textContent=String(v);
}

/* =================== EVENTS =================== */
btnMenu.addEventListener("click", openMenu);
btnCloseMenu.addEventListener("click", closeMenu);

btnFold.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) playerFold(0); });
btnCheck.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) playerCheck(0); });
btnCall.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) playerCall(0); });
btnRaise.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) openRaiseModal(); });

raiseSlider.addEventListener("input", syncRaiseFromSlider);
raiseInput.addEventListener("input", syncRaiseFromInput);
btnRaiseClose.addEventListener("click", closeRaiseModal);
btnRaiseConfirm.addEventListener("click", ()=>{
  const v=Number(raiseSlider.value);
  closeRaiseModal();
  if(current===0 && !paused && !menuOpen) playerRaiseTo(0,v);
});
btnRaiseMin.addEventListener("click", ()=>{ raiseSlider.value=raiseSlider.min; syncRaiseFromSlider(); });
btnRaiseAll.addEventListener("click", ()=>{ raiseSlider.value=raiseSlider.max; syncRaiseFromSlider(); });
btnRaiseHalf.addEventListener("click", ()=>{
  const min=Number(raiseSlider.min), max=Number(raiseSlider.max);
  raiseSlider.value=String(((min+max)/2)|0);
  syncRaiseFromSlider();
});

/* =================== NICK =================== */
function openNick(){
  show(nickOverlay,true);
  const last=localStorage.getItem("poker_last_nick");
  if(last){ nickInput.value=last; nickInput.select(); }
  setTimeout(()=>nickInput.focus(), 30);
}

nickOk.addEventListener("click", ()=>{
  const n=nickInput.value.trim();
  if(!n){ nickInput.focus(); return; }

  nick=n;
  saveKey=keyForNick(nick);

  // загружаем, но всегда стартуем PAUSED + menu (чтобы не ломалось)
  const st=load(nick);

  ensureTournament();

  if(st && st.game && Array.isArray(st.game.players)){
    players = st.game.players;
    deck    = st.game.deck || [];
    board   = st.game.board || [];
    pot     = Number(st.game.pot || 0);

    stage = st.game.stage || "IDLE";
    dealer = Number(st.game.dealer || 0);
    sb = Number(st.game.sb || 1);
    bb = Number(st.game.bb || 2);
    current = Number(st.game.current || 0);
    toCall = Number(st.game.toCall || 0);
    raisesThisRound = Number(st.game.raisesThisRound || 0);
    handInProgress = !!st.game.handInProgress;
    tournamentStarted = !!st.game.tournamentStarted;

    turnSeconds = Number(st.turnSeconds || TURN_SECONDS_DEFAULT);

    // герой фикс
    if(players[0]){ players[0].name=nick; players[0].isBot=false; }
  } else {
    ensureTournament();
  }

  // всегда начинаем с меню и паузы (стабильность)
  paused = true;
  menuOpen = false;
  stopAllTimers();

  show(nickOverlay,false);
  render();
  openMenu();
  save();
});
nickInput.addEventListener("keydown", (e)=>{ if(e.key==="Enter") nickOk.click(); });

/* =================== BOOT =================== */
function boot(){
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
