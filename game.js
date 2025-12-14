/* Poker Tournament (Step 1)
   - fullscreen table
   - auto hands (no Start/Next)
   - 15s turn timer: auto-check if possible else auto-fold
   - separate buttons: fold/check/call/raise + raise modal
   - simple bot logic (enough for now)
*/

const START_CHIPS = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const BOT_COUNT = 5;
const MAX_RAISES_PER_ROUND = 4;
const TURN_SECONDS_DEFAULT = 15;
const BOT_THINK_MS = 450;
const STREET_PAUSE_MS = 900;

const SUITS = ["♣","♦","♥","♠"];
const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const RVAL = Object.fromEntries(RANKS.map((r,i)=>[r, i+2]));

let nick = null;
let saveKey = null;

let players = [];
let deck = [];
let board = [];
let pot = 0;
let stage = "IDLE";
let dealer = 0, sb = 1, bb = 2;
let current = 0;
let toCall = 0;
let raisesThisRound = 0;
let handInProgress = false;
let tournamentStarted = false;

let turnSeconds = TURN_SECONDS_DEFAULT;
let turnLeft = TURN_SECONDS_DEFAULT;
let turnTimerId = null;
let botTimerId = null;
let streetPauseId = null;

const $ = (id)=>document.getElementById(id);

const elNick = $("nick");
const elStack = $("stack");
const elPot = $("pot");
const elStage = $("stage");
const elTurnName = $("turnName");
const elTurnTimer = $("turnTimer");
const elBoard = $("board");
const elSeats = $("seats");
const elMsg = $("msg");

const btnMenu = $("btnMenu");
const btnFold = $("btnFold");
const btnCheck = $("btnCheck");
const btnCall = $("btnCall");
const btnRaise = $("btnRaise");

const nickOverlay = $("nickOverlay");
const nickInput = $("nickInput");
const nickOk = $("nickOk");

const menuOverlay = $("menuOverlay");
const btnCloseMenu = $("btnCloseMenu");

const raiseOverlay = $("raiseOverlay");
const raiseSlider = $("raiseSlider");
const raiseToLabel = $("raiseToLabel");
const raiseInput = $("raiseInput");
const btnRaiseConfirm = $("btnRaiseConfirm");
const btnRaiseClose = $("btnRaiseClose");
const btnRaiseMin = $("btnRaiseMin");
const btnRaiseHalf = $("btnRaiseHalf");
const btnRaiseAll = $("btnRaiseAll");

/* ---------- Persistence ---------- */
function keyForNick(n){ return `poker_step1_${n.toLowerCase()}`; }
function save(){
  if(!saveKey) return;
  const state = {
    nick,
    turnSeconds,
    tournament: {
      players, deck, board, pot, stage, dealer, sb, bb, current, toCall, raisesThisRound,
      handInProgress, tournamentStarted
    }
  };
  localStorage.setItem(saveKey, JSON.stringify(state));
  localStorage.setItem("poker_last_nick", nick);
}
function load(n){
  const raw = localStorage.getItem(keyForNick(n));
  if(!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* ---------- Deck ---------- */
function newDeck(){
  const d = [];
  for(const s of SUITS) for(const r of RANKS) d.push({r,s});
  for(let i=d.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function inHandPlayers(){ return players.filter(p => !p.out && !p.folded); }
function nextActiveIndex(from){
  const n = players.length;
  for(let k=1;k<=n;k++){
    const i = (from + k) % n;
    if(!players[i].out && !players[i].folded) return i;
  }
  return from;
}
function nextNotOutIndex(from){
  const n = players.length;
  for(let k=1;k<=n;k++){
    const i = (from + k) % n;
    if(!players[i].out) return i;
  }
  return from;
}
function onlyOneLeftInHand(){ return inHandPlayers().length === 1; }

/* ---------- Evaluator (same as earlier simple 7-card) ---------- */
function straightHigh(uniqueRanksDesc){
  const set = new Set(uniqueRanksDesc);
  if(set.has(14) && set.has(5) && set.has(4) && set.has(3) && set.has(2)) return 5;
  for(let hi=14;hi>=5;hi--){
    let ok=true;
    for(let d=0;d<5;d++){ if(!set.has(hi-d)){ ok=false; break; } }
    if(ok) return hi;
  }
  return 0;
}
function evaluate7(cards){
  const ranks = cards.map(c=>RVAL[c.r]).sort((a,b)=>b-a);
  const suitMap = new Map();
  const countMap = new Map();
  for(const c of cards){
    suitMap.set(c.s, (suitMap.get(c.s)||0)+1);
    const v = RVAL[c.r];
    countMap.set(v, (countMap.get(v)||0)+1);
  }
  const unique = [...new Set(ranks)].sort((a,b)=>b-a);

  let flushSuit=null;
  for(const [s,c] of suitMap.entries()){ if(c>=5){ flushSuit=s; break; } }
  let flushRanks=null;
  if(flushSuit){
    flushRanks = cards.filter(c=>c.s===flushSuit).map(c=>RVAL[c.r]).sort((a,b)=>b-a);
  }
  if(flushRanks){
    const uniqFlush=[...new Set(flushRanks)].sort((a,b)=>b-a);
    const sf=straightHigh(uniqFlush);
    if(sf) return {cat:8,tiebreak:[sf]};
  }

  const groups=[...countMap.entries()].map(([r,c])=>({r,c}))
    .sort((a,b)=>(b.c-a.c)||(b.r-a.r));
  const fours=groups.filter(g=>g.c===4).map(g=>g.r);
  const threes=groups.filter(g=>g.c===3).map(g=>g.r);
  const pairs=groups.filter(g=>g.c===2).map(g=>g.r);

  if(fours.length){
    const quad=Math.max(...fours);
    const kicker=unique.find(r=>r!==quad);
    return {cat:7,tiebreak:[quad,kicker]};
  }
  if(threes.length){
    const trip=Math.max(...threes);
    const remainingTrips=threes.filter(r=>r!==trip);
    const bestPair=pairs.length?Math.max(...pairs):(remainingTrips.length?Math.max(...remainingTrips):0);
    if(bestPair) return {cat:6,tiebreak:[trip,bestPair]};
  }
  if(flushRanks) return {cat:5,tiebreak:flushRanks.slice(0,5)};
  const st=straightHigh(unique);
  if(st) return {cat:4,tiebreak:[st]};
  if(threes.length){
    const trip=Math.max(...threes);
    const kickers=unique.filter(r=>r!==trip).slice(0,2);
    return {cat:3,tiebreak:[trip,...kickers]};
  }
  if(pairs.length>=2){
    const sp=[...pairs].sort((a,b)=>b-a);
    const p1=sp[0], p2=sp[1];
    const kicker=unique.find(r=>r!==p1 && r!==p2);
    return {cat:2,tiebreak:[p1,p2,kicker]};
  }
  if(pairs.length===1){
    const p=pairs[0];
    const kickers=unique.filter(r=>r!==p).slice(0,3);
    return {cat:1,tiebreak:[p,...kickers]};
  }
  return {cat:0,tiebreak:unique.slice(0,5)};
}
function compareEval(a,b){
  if(a.cat!==b.cat) return a.cat-b.cat;
  for(let i=0;i<Math.max(a.tiebreak.length,b.tiebreak.length);i++){
    const x=a.tiebreak[i]||0, y=b.tiebreak[i]||0;
    if(x!==y) return x-y;
  }
  return 0;
}

/* ---------- Betting ---------- */
function resetRoundBets(){
  for(const p of players) p.bet=0;
  toCall=0;
  raisesThisRound=0;
}
function postBlind(i, amount){
  const p=players[i];
  const pay=Math.min(amount,p.chips);
  p.chips-=pay;
  p.bet+=pay;
  pot+=pay;
}
function bettingRoundComplete(){
  for(const p of inHandPlayers()){
    if(p.chips===0) continue;
    if(p.bet!==toCall) return false;
  }
  return true;
}
function minRaiseTo(){ return toCall + BIG_BLIND; }

/* ---------- Turn Timer ---------- */
function clearTurnTimer(){
  if(turnTimerId) clearInterval(turnTimerId);
  turnTimerId=null;
}
function startTurnTimer(){
  clearTurnTimer();
  turnLeft = turnSeconds;
  elTurnTimer.textContent = String(turnLeft);
  turnTimerId = setInterval(()=>{
    turnLeft--;
    elTurnTimer.textContent = String(Math.max(0,turnLeft));
    if(turnLeft<=0){
      clearTurnTimer();
      onTurnTimeout();
    }
  }, 1000);
}
function onTurnTimeout(){
  if(!handInProgress) return;
  if(players[current].isBot) return; // bots don't timeout
  // auto-check if possible, else fold
  const you = players[0];
  const need = Math.max(0, toCall - you.bet);
  if(need===0){
    playerCheck(0, true);
  } else {
    playerFold(0, true);
  }
}

/* ---------- Game Flow ---------- */
function cleanupElims(){
  for(const p of players){
    if(!p.out && p.chips<=0){
      p.out=true;
      p.chips=0;
    }
  }
}
function tournamentWinner(){
  const alive = players.filter(p=>!p.out);
  return alive.length===1 ? alive[0] : null;
}

function ensureTournament(){
  if(tournamentStarted && players.length) return;
  players = [];
  players.push({name:nick,isBot:false,chips:START_CHIPS,bet:0,folded:false,out:false,hand:[]});
  for(let i=1;i<=BOT_COUNT;i++){
    players.push({name:`BOT${i}`,isBot:true,chips:START_CHIPS,bet:0,folded:false,out:false,hand:[]});
  }
  dealer=0; sb=1; bb=2;
  stage="IDLE"; board=[]; pot=0; toCall=0; raisesThisRound=0;
  tournamentStarted=true;
  handInProgress=false;
}

function startHandAuto(){
  cleanupElims();
  const w = tournamentWinner();
  if(w){
    elMsg.textContent = `🏆 CHAMPION: ${w.name}! (авто-новый турнир через 2 сек)`;
    render();
    save();
    // start a new tournament automatically
    setTimeout(()=>{
      players.forEach(p=>{ p.out=false; p.folded=false; p.bet=0; p.hand=[]; p.chips=START_CHIPS; });
      dealer=0; stage="IDLE"; pot=0; board=[]; toCall=0; raisesThisRound=0;
      handInProgress=false;
      render();
      startHandAuto();
    }, 2000);
    return;
  }

  handInProgress=true;
  deck=newDeck();
  board=[];
  pot=0;
  for(const p of players){
    p.folded=false; p.bet=0; p.hand=[];
  }

  dealer = nextNotOutIndex(dealer);
  sb = nextNotOutIndex(dealer);
  bb = nextNotOutIndex(sb);

  for(let r=0;r<2;r++){
    for(const p of players) if(!p.out) p.hand.push(deck.pop());
  }

  resetRoundBets();
  postBlind(sb, SMALL_BLIND);
  postBlind(bb, BIG_BLIND);
  toCall = Math.max(players[sb].bet, players[bb].bet);

  stage="PREFLOP";
  current = nextActiveIndex(bb);

  elMsg.textContent = "Новая раздача…";
  save();
  render();
  tick();
}

function pauseThen(fn, text){
  if(streetPauseId) clearTimeout(streetPauseId);
  elMsg.textContent = text;
  renderHUD();
  streetPauseId = setTimeout(fn, STREET_PAUSE_MS);
}

function advanceStage(){
  pauseThen(()=>{
    for(const p of players) p.bet=0;
    toCall=0; raisesThisRound=0;

    if(stage==="PREFLOP"){ board.push(deck.pop(), deck.pop(), deck.pop()); stage="FLOP"; }
    else if(stage==="FLOP"){ board.push(deck.pop()); stage="TURN"; }
    else if(stage==="TURN"){ board.push(deck.pop()); stage="RIVER"; }
    else if(stage==="RIVER"){ stage="SHOWDOWN"; }

    current = nextActiveIndex(dealer);

    save();
    render();

    if(stage==="SHOWDOWN"){
      pauseThen(doShowdown, "Шоудаун…");
      return;
    }
    tick();
  }, stage==="PREFLOP"?"Флоп…":stage==="FLOP"?"Тёрн…":stage==="TURN"?"Ривер…":"Шоудаун…");
}

function doShowdown(){
  const contenders = inHandPlayers();
  if(contenders.length===1){
    awardPot(players.indexOf(contenders[0]), "(all folded)");
    return;
  }
  const evals = contenders.map(p=>({p, e:evaluate7([...p.hand, ...board])}))
    .sort((a,b)=>compareEval(a.e,b.e));
  const best = evals[evals.length-1].e;
  const winners = evals.filter(x=>compareEval(x.e,best)===0).map(x=>x.p);

  const share = Math.floor(pot / winners.length);
  let rem = pot - share*winners.length;
  for(const w of winners){
    w.chips += share;
    if(rem>0){ w.chips += 1; rem--; }
  }
  elMsg.textContent = `Победитель: ${winners.map(w=>w.name).join(", ")} (банк разделён)`;
  pot=0;

  handInProgress=false;
  stage="IDLE";
  cleanupElims();

  save();
  render();

  // auto next hand
  setTimeout(()=>startHandAuto(), 1200);
}

function awardPot(idx, reason){
  players[idx].chips += pot;
  elMsg.textContent = `${players[idx].name} wins ${pot} ${reason||""}`.trim();
  pot=0;
  handInProgress=false;
  stage="IDLE";
  cleanupElims();
  save();
  render();
  setTimeout(()=>startHandAuto(), 1200);
}

/* ---------- Player actions ---------- */
function playerFold(i, byTimeout=false){
  clearTurnTimer();
  players[i].folded=true;
  elMsg.textContent = byTimeout ? `${players[i].name} auto-fold (timeout)` : `${players[i].name} folds`;
  render();
  save();

  if(onlyOneLeftInHand()){
    awardPot(players.indexOf(inHandPlayers()[0]), "(all folded)");
    return;
  }
  current = nextActiveIndex(i);
  tick();
}
function playerCheck(i, byTimeout=false){
  clearTurnTimer();
  const p=players[i];
  const need=Math.max(0,toCall-p.bet);
  if(need!==0) return; // not allowed
  elMsg.textContent = byTimeout ? `${p.name} auto-check (timeout)` : `${p.name} checks`;
  current = nextActiveIndex(i);
  render();
  save();
  if(bettingRoundComplete()) { advanceStage(); return; }
  tick();
}
function playerCall(i){
  clearTurnTimer();
  const p=players[i];
  const need=Math.max(0,toCall-p.bet);
  const pay=Math.min(need,p.chips);
  p.chips-=pay; p.bet+=pay; pot+=pay;
  elMsg.textContent = `${p.name} calls ${pay}`;
  current = nextActiveIndex(i);
  render();
  save();
  if(bettingRoundComplete()) { advanceStage(); return; }
  tick();
}
function playerRaiseTo(i, raiseTo){
  clearTurnTimer();
  if(raisesThisRound>=MAX_RAISES_PER_ROUND){ playerCall(i); return; }
  const p=players[i];
  raiseTo = Math.max(raiseTo, minRaiseTo());
  raiseTo = Math.min(raiseTo, p.bet + p.chips);
  const add = Math.max(0, raiseTo - p.bet);
  const pay = Math.min(add, p.chips);
  if(pay<=0){ playerCall(i); return; }
  p.chips-=pay; p.bet+=pay; pot+=pay;
  toCall = Math.max(toCall, p.bet);
  raisesThisRound++;
  elMsg.textContent = `${p.name} raises to ${p.bet}`;
  current = nextActiveIndex(i);
  render();
  save();
  tick();
}

/* ---------- Bot logic ---------- */
function botDecision(i){
  const p=players[i];
  const need=Math.max(0,toCall-p.bet);
  const stack=Math.max(1,p.chips);
  const pressure = need/(stack+1);

  if(stage==="PREFLOP"){
    const a=RVAL[p.hand[0].r], b=RVAL[p.hand[1].r];
    const pair=p.hand[0].r===p.hand[1].r;
    const suited=p.hand[0].s===p.hand[1].s;
    const high=Math.max(a,b);
    const gap=Math.abs(a-b);
    let score=0;
    score += pair?0.55:0;
    score += (high/14)*0.30;
    score += suited?0.08:0;
    score += (gap<=2)?0.06:0;
    score += (Math.random()-0.5)*0.06;

    if(need===0) return (score>0.74 && Math.random()<0.35) ? "RAISE" : "CHECK";
    if(score<0.33 && pressure>0.12 && Math.random()<0.8) return "FOLD";
    if(score>0.78 && Math.random()<0.45) return "RAISE";
    return "CALL";
  }

  const e=evaluate7([...p.hand,...board]);
  let strength=(e.cat/8) + (Math.random()-0.5)*0.08;

  if(need===0) return (strength>0.62 && Math.random()<0.30) ? "RAISE" : "CHECK";
  if(strength<0.25 && pressure>0.14 && Math.random()<0.80) return "FOLD";
  if(strength>0.72 && Math.random()<0.35) return "RAISE";
  return "CALL";
}
function botAct(){
  if(!handInProgress) return;
  if(players[current].out || players[current].folded) current = nextActiveIndex(current);

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
    let target=min + Math.floor(Math.random()*3)*BIG_BLIND;
    if(stage!=="PREFLOP"){
      const e=evaluate7([...p.hand,...board]);
      if(e.cat>=4) target+=BIG_BLIND*3;
      if(e.cat>=6) target+=BIG_BLIND*5;
    }
    target = Math.max(min, Math.min(max, target));
    playerRaiseTo(current, target);
  } else {
    playerCall(current);
  }
}

/* ---------- Tick ---------- */
function tick(){
  clearTimeout(botTimerId);
  clearTurnTimer();

  if(!handInProgress || stage==="IDLE" || stage==="SHOWDOWN"){
    updateButtons();
    return;
  }

  // skip dead/folded
  if(players[current].out || players[current].folded){
    current = nextActiveIndex(current);
  }

  renderHUD();
  updateButtons();

  // human
  if(!players[current].isBot){
    elMsg.textContent = "Твой ход.";
    startTurnTimer();
    return;
  }

  // bot
  elMsg.textContent = "Бот думает…";
  botTimerId = setTimeout(()=>botAct(), BOT_THINK_MS);
}

/* ---------- UI Render ---------- */
function renderHUD(){
  elNick.textContent = nick ?? "-";
  elStage.textContent = stage;
  elPot.textContent = String(pot);
  elTurnName.textContent = players[current]?.name ?? "-";
  elStack.textContent = String(players[0]?.chips ?? 0);
  elTurnTimer.textContent = String(turnLeft);
  elToCallText();
}
function elToCallText(){
  // show "to call" via stage pill? not separate: keep in message/timer only
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
  // board
  elBoard.innerHTML="";
  for(let i=0;i<5;i++){
    const c=board[i];
    elBoard.appendChild(makeCardEl(c ? (c.r+c.s) : "", !c));
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
    else if(handInProgress && i===current && !p.folded){ tag.classList.add("turn"); tag.textContent="TURN"; }
    else tag.textContent=p.isBot?"BOT":"YOU";

    top.appendChild(nm);
    top.appendChild(tag);

    const meta=document.createElement("div");
    meta.className="meta";
    meta.innerHTML=`<span>chips: <b>${p.chips}</b></span><span>${p.folded ? "<span style='color:var(--danger)'>folded</span>" : ""}</span>`;

    const cards=document.createElement("div");
    cards.className="cards" + ((i===0 && p.folded) ? " folded" : "");

    const hidden = p.isBot && handInProgress && stage!=="SHOWDOWN";
    const show = !p.isBot || stage==="SHOWDOWN" || !handInProgress;

    const c1=p.hand?.[0], c2=p.hand?.[1];
    cards.appendChild(makeCardEl(c1 && show ? (c1.r+c1.s) : "", hidden || !show));
    cards.appendChild(makeCardEl(c2 && show ? (c2.r+c2.s) : "", hidden || !show));

    const bet=document.createElement("div");
    bet.className="bet";
    bet.textContent = p.out ? "" : (p.bet>0 ? `Bet: ${p.bet}` : "");

    seat.appendChild(top);
    seat.appendChild(meta);
    seat.appendChild(cards);
    seat.appendChild(bet);

    elSeats.appendChild(seat);
  }

  renderHUD();
  updateButtons();
}

function updateButtons(){
  const you = players[0];
  const yourTurn = tournamentStarted && handInProgress && current===0 && you && !you.folded && !you.out;

  btnFold.disabled = !yourTurn;
  btnRaise.disabled = !yourTurn || raisesThisRound>=MAX_RAISES_PER_ROUND;

  const need = you && handInProgress ? Math.max(0, toCall - you.bet) : 0;
  btnCheck.disabled = !(yourTurn && need===0);
  btnCall.disabled  = !(yourTurn && need>0);
}

/* ---------- Raise Modal ---------- */
function openRaiseModal(){
  const you=players[0];
  const min = Math.max(0, Math.min(minRaiseTo(), you.bet+you.chips));
  const max = you.bet + you.chips;
  raiseSlider.min = String(min);
  raiseSlider.max = String(max);
  raiseSlider.value = String(min);
  raiseToLabel.textContent = String(min);
  raiseInput.value = String(min);
  raiseInput.min = String(min);
  raiseInput.max = String(max);
  show(raiseOverlay,true);
}
function closeRaiseModal(){ show(raiseOverlay,false); }
function show(el, yes){ el.style.display = yes ? "flex" : "none"; }
function syncRaiseFromSlider(){
  const v=Number(raiseSlider.value);
  raiseToLabel.textContent=String(v);
  raiseInput.value=String(v);
}
function syncRaiseFromInput(){
  const you=players[0];
  const min = Math.max(0, Math.min(minRaiseTo(), you.bet+you.chips));
  const max = you.bet + you.chips;
  let v=Number(raiseInput.value||min);
  v = Math.max(min, Math.min(max, v));
  raiseInput.value=String(v);
  raiseSlider.value=String(v);
  raiseToLabel.textContent=String(v);
}

/* ---------- Events ---------- */
btnMenu.addEventListener("click", ()=>show(menuOverlay,true));
btnCloseMenu.addEventListener("click", ()=>show(menuOverlay,false));

btnFold.addEventListener("click", ()=> { if(current===0) playerFold(0); });
btnCheck.addEventListener("click", ()=> { if(current===0) playerCheck(0); });
btnCall.addEventListener("click", ()=> { if(current===0) playerCall(0); });
btnRaise.addEventListener("click", ()=> { if(current===0) openRaiseModal(); });

raiseSlider.addEventListener("input", syncRaiseFromSlider);
raiseInput.addEventListener("input", syncRaiseFromInput);

btnRaiseClose.addEventListener("click", closeRaiseModal);
btnRaiseConfirm.addEventListener("click", ()=>{
  const v=Number(raiseSlider.value);
  closeRaiseModal();
  if(current===0) playerRaiseTo(0, v);
});
btnRaiseMin.addEventListener("click", ()=>{ raiseSlider.value = raiseSlider.min; syncRaiseFromSlider(); });
btnRaiseAll.addEventListener("click", ()=>{ raiseSlider.value = raiseSlider.max; syncRaiseFromSlider(); });
btnRaiseHalf.addEventListener("click", ()=>{
  const min=Number(raiseSlider.min), max=Number(raiseSlider.max);
  const v=Math.floor((min+max)/2);
  raiseSlider.value=String(v); syncRaiseFromSlider();
});

/* Nick immediately */
function openNick(){
  show(nickOverlay,true);
  const last = localStorage.getItem("poker_last_nick");
  if(last){ nickInput.value = last; nickInput.select(); }
  setTimeout(()=>nickInput.focus(), 30);
}
nickOk.addEventListener("click", ()=>{
  const n=nickInput.value.trim();
  if(!n){ nickInput.focus(); return; }
  nick=n;
  saveKey=keyForNick(nick);

  const st = load(nick);
  if(st){
    turnSeconds = Number(st.turnSeconds ?? TURN_SECONDS_DEFAULT);
    const t = st.tournament;
    if(t && t.players){
      players = t.players;
      deck = t.deck ?? [];
      board = t.board ?? [];
      pot = t.pot ?? 0;
      stage = t.stage ?? "IDLE";
      dealer = t.dealer ?? 0; sb = t.sb ?? 1; bb = t.bb ?? 2;
      current = t.current ?? 0;
      toCall = t.toCall ?? 0;
      raisesThisRound = t.raisesThisRound ?? 0;
      handInProgress = !!t.handInProgress;
      tournamentStarted = !!t.tournamentStarted;

      if(players[0] && !players[0].isBot) players[0].name = nick;
    } else {
      ensureTournament();
    }
  } else {
    ensureTournament();
  }

  show(nickOverlay,false);
  render();

  // auto-start flow
  if(!handInProgress){
    setTimeout(()=>startHandAuto(), 400);
  } else {
    tick();
  }
  save();
});
nickInput.addEventListener("keydown", (e)=>{ if(e.key==="Enter") nickOk.click(); });

/* Boot */
function boot(){
  openNick();
  // placeholder seats so UI doesn't look empty before nick
  players = [
    {name:"YOU",isBot:false,chips:0,bet:0,folded:false,out:false,hand:[]},
    {name:"BOT1",isBot:true,chips:0,bet:0,folded:false,out:false,hand:[]},
    {name:"BOT2",isBot:true,chips:0,bet:0,folded:false,out:false,hand:[]},
    {name:"BOT3",isBot:true,chips:0,bet:0,folded:false,out:false,hand:[]},
    {name:"BOT4",isBot:true,chips:0,bet:0,folded:false,out:false,hand:[]},
    {name:"BOT5",isBot:true,chips:0,bet:0,folded:false,out:false,hand:[]},
  ];
  render();
}
boot();
