"use strict";

/* === Minimal stable rebuild (menu always works) === */
const START_CHIPS=1000, SB=10, BB=20, BOT_COUNT=5, MAX_RAISES_PER_ROUND=4;
const TURN_SECONDS_OPTIONS=[5,10,15,20], TURN_SECONDS_DEFAULT=15;
const BOT_THINK_MS=450, STREET_PAUSE_MS=850;
const MC_ITERS_PREFLOP=250, MC_ITERS_POSTFLOP=200;
const SUITS=["♣","♦","♥","♠"], RANKS=["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const RVAL=Object.fromEntries(RANKS.map((r,i)=>[r,i+2]));
const STORAGE_PREFIX="poker_rebuild_v2_";

const $=id=>document.getElementById(id);

const elNick=$("nick"), elStack=$("stack"), elPot=$("pot"), elStage=$("stage"),
      elTurnName=$("turnName"), elTurnTimer=$("turnTimer"), elBoard=$("board"),
      elSeats=$("seats"), elMsg=$("msg");

const btnMenu=$("btnMenu"), btnFold=$("btnFold"), btnCheck=$("btnCheck"), btnCall=$("btnCall"), btnRaise=$("btnRaise");

const nickOverlay=$("nickOverlay"), nickInput=$("nickInput"), nickOk=$("nickOk");
const menuOverlay=$("menuOverlay"), btnCloseMenu=$("btnCloseMenu"), menuControls=$("menuControls");

const raiseOverlay=$("raiseOverlay"), raiseSlider=$("raiseSlider"), raiseToLabel=$("raiseToLabel"),
      raiseInput=$("raiseInput"), btnRaiseConfirm=$("btnRaiseConfirm"), btnRaiseClose=$("btnRaiseClose"),
      btnRaiseMin=$("btnRaiseMin"), btnRaiseHalf=$("btnRaiseHalf"), btnRaiseAll=$("btnRaiseAll");

function show(el, yes){ if(el) el.style.display=yes?"flex":"none"; }
function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function cardKey(c){ return c ? (c.r+c.s) : ""; }

let nick=null, saveKey=null;

let players=[], deck=[], board=[], pot=0;
let stage="IDLE", handInProgress=false, tournamentStarted=false;
let dealer=0, sbPos=1, bbPos=2, current=0, toCall=0, raisesThisRound=0;

let paused=true, menuOpen=false;
let turnSeconds=TURN_SECONDS_DEFAULT, turnLeft=TURN_SECONDS_DEFAULT;

let turnTimerId=null, botTimerId=null, streetPauseId=null;
let token=1;
function bumpToken(){ token=(token+1)|0; if(token<=0) token=1; }
function stopAllTimers(){
  bumpToken();
  if(turnTimerId) clearInterval(turnTimerId);
  if(botTimerId) clearTimeout(botTimerId);
  if(streetPauseId) clearTimeout(streetPauseId);
  turnTimerId=botTimerId=streetPauseId=null;
}
function scheduleTimeout(fn, ms){
  const t=token;
  return setTimeout(()=>{ if(t===token) fn(); }, ms);
}
function scheduleInterval(fn, ms){
  const t=token;
  return setInterval(()=>{ if(t===token) fn(); }, ms);
}

/* ====== Persist ====== */
function keyForNick(n){ return STORAGE_PREFIX + String(n||"").toLowerCase(); }
function save(){
  if(!saveKey) return;
  const state={ v:2, nick, turnSeconds, paused:true, // 🔥 всегда сохраняем как paused:true
    game:{ players, deck, board, pot, stage, handInProgress, tournamentStarted, dealer, sbPos, bbPos, current, toCall, raisesThisRound }
  };
  try{ localStorage.setItem(saveKey, JSON.stringify(state)); }catch{}
  try{ localStorage.setItem(STORAGE_PREFIX+"lastNick", nick); }catch{}
}
function load(n){
  try{ const raw=localStorage.getItem(keyForNick(n)); return raw?JSON.parse(raw):null; }catch{ return null; }
}

/* ====== Core helpers ====== */
function newDeck(){
  const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({r,s});
  for(let i=d.length-1;i>0;i--){
    const j=(Math.random()*(i+1))|0;
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}
function inHandPlayers(){ return players.filter(p=>p && !p.out && !p.folded); }
function nextActiveIndex(from){
  const n=players.length;
  for(let k=1;k<=n;k++){
    const i=(from+k)%n;
    const p=players[i];
    if(p && !p.out && !p.folded) return i;
  }
  return from;
}
function nextNotOutIndex(from){
  const n=players.length;
  for(let k=1;k<=n;k++){
    const i=(from+k)%n;
    const p=players[i];
    if(p && !p.out) return i;
  }
  return from;
}
function onlyOneLeft(){ return inHandPlayers().length===1; }
function ensureTournament(){
  if(tournamentStarted && players.length===BOT_COUNT+1) return;
  players=[];
  players.push({name:nick||"YOU",isBot:false,chips:START_CHIPS,bet:0,folded:false,out:false,acted:false,hand:[]});
  for(let i=1;i<=BOT_COUNT;i++){
    players.push({name:`BOT${i}`,isBot:true,chips:START_CHIPS,bet:0,folded:false,out:false,acted:false,hand:[]});
  }
  dealer=0; sbPos=1; bbPos=2; current=0;
  deck=[]; board=[]; pot=0;
  stage="IDLE"; handInProgress=false; tournamentStarted=true;
  toCall=0; raisesThisRound=0;
}
function cleanupElims(){
  for(const p of players){
    if(!p) continue;
    if(!p.out && p.chips<=0){ p.out=true; p.chips=0; p.folded=true; }
  }
}
function tournamentWinner(){
  const alive=players.filter(p=>p && !p.out);
  return alive.length===1 ? alive[0] : null;
}
function resetForStreet(){
  for(const p of players){ if(!p||p.out) continue; p.bet=0; p.acted=false; }
  toCall=0; raisesThisRound=0;
}
function postBlind(i,amt){
  const p=players[i]; if(!p||p.out) return;
  const pay=Math.min(amt,p.chips);
  p.chips-=pay; p.bet+=pay; pot+=pay;
}
function bettingRoundComplete(){
  for(const p of inHandPlayers()){
    if(p.chips===0) continue;
    if(!p.acted) return false;
    if(p.bet!==toCall) return false;
  }
  return true;
}
function resetOthersActedAfterRaise(raiser){
  for(let i=0;i<players.length;i++){
    const p=players[i];
    if(!p||p.out||p.folded) continue;
    p.acted=(i===raiser);
  }
}
function minRaiseTo(){ return toCall + BB; }

/* ====== Evaluator (safe) ====== */
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
  const ranks=cards5.map(c=>RVAL[c.r]).sort((a,b)=>b-a);
  const suits=cards5.map(c=>c.s);
  const isFlush=suits.every(s=>s===suits[0]);

  const cnt=new Map();
  for(const r of ranks) cnt.set(r,(cnt.get(r)||0)+1);
  const unique=[...new Set(ranks)].sort((a,b)=>b-a);
  const st=straightHighFromSet(new Set(unique));
  const groups=[...cnt.entries()].map(([r,c])=>({r,c})).sort((a,b)=>(b.c-a.c)||(b.r-a.r));

  if(isFlush && st) return {cat:8,t:[st]};
  if(groups[0].c===4){
    const quad=groups[0].r, k=unique.find(x=>x!==quad);
    return {cat:7,t:[quad,k]};
  }
  if(groups[0].c===3 && groups[1] && groups[1].c===2) return {cat:6,t:[groups[0].r,groups[1].r]};
  if(isFlush) return {cat:5,t:ranks};
  if(st) return {cat:4,t:[st]};
  if(groups[0].c===3){
    const trip=groups[0].r; const kick=unique.filter(x=>x!==trip);
    return {cat:3,t:[trip,...kick]};
  }
  if(groups[0].c===2 && groups[1] && groups[1].c===2){
    const p1=Math.max(groups[0].r,groups[1].r), p2=Math.min(groups[0].r,groups[1].r);
    const k=unique.find(x=>x!==p1 && x!==p2);
    return {cat:2,t:[p1,p2,k]};
  }
  if(groups[0].c===2){
    const p=groups[0].r; const kick=unique.filter(x=>x!==p);
    return {cat:1,t:[p,...kick]};
  }
  return {cat:0,t:ranks};
}
function cmp(a,b){
  if(a.cat!==b.cat) return a.cat-b.cat;
  const L=Math.max(a.t.length,b.t.length);
  for(let i=0;i<L;i++){
    const x=a.t[i]||0, y=b.t[i]||0;
    if(x!==y) return x-y;
  }
  return 0;
}
function bestOf7(cards){
  if(!cards || cards.length<5) return {ev:{cat:0,t:[]}, best5:[]};
  let best=null, best5=null;
  const n=cards.length;
  for(let a=0;a<n-4;a++)
    for(let b=a+1;b<n-3;b++)
      for(let c=b+1;c<n-2;c++)
        for(let d=c+1;d<n-1;d++)
          for(let e=d+1;e<n;e++){
            const combo=[cards[a],cards[b],cards[c],cards[d],cards[e]];
            const ev=evaluate5(combo);
            if(!best || cmp(best,ev)<0){ best=ev; best5=combo; }
          }
  if(!best) return {ev:{cat:0,t:[]}, best5:[]};
  return {ev:best, best5};
}
function catName(cat){
  return ["High Card","Pair","Two Pair","Trips","Straight","Flush","Full House","Quads","Straight Flush"][cat]||"Unknown";
}

/* ====== Win% ====== */
function monteCarloWinPct(){
  if(!handInProgress) return null;
  const hero=players[0];
  if(!hero || hero.out || hero.folded || hero.hand.length<2) return null;

  const opps=players.map((p,idx)=>({p,idx})).filter(x=>x.idx!==0 && x.p && !x.p.out && !x.p.folded);
  if(opps.length===0) return 100;

  const known=[...hero.hand, ...board.filter(Boolean)];
  const used=new Set(known.map(cardKey));

  const full=[];
  for(const s of SUITS) for(const r of RANKS) full.push({r,s});
  const rem=full.filter(c=>!used.has(cardKey(c)));

  const iters=board.length===0 ? MC_ITERS_PREFLOP : MC_ITERS_POSTFLOP;
  let score=0;

  for(let t=0;t<iters;t++){
    const needBoard=5-board.length;
    const needOpp=opps.length*2;

    const pool=rem.slice();
    for(let i=pool.length-1;i>0;i--){
      const j=(Math.random()*(i+1))|0;
      [pool[i],pool[j]]=[pool[j],pool[i]];
    }
    const pick=pool.slice(0, needBoard+needOpp);

    const simBoard=board.slice();
    for(let i=0;i<needBoard;i++) simBoard.push(pick[i]);

    let off=needBoard;
    const heroEv=bestOf7(hero.hand.concat(simBoard)).ev;

    let best=true, tie=1;
    for(let k=0;k<opps.length;k++){
      const oppHand=[pick[off],pick[off+1]]; off+=2;
      const oppEv=bestOf7(oppHand.concat(simBoard)).ev;
      const c=cmp(heroEv,oppEv);
      if(c<0){ best=false; break; }
      if(c===0) tie++;
    }
    if(best) score+=1/tie;
  }
  return Math.round((score/iters)*100);
}

/* ====== Render ====== */
function renderHUD(){
  elNick.textContent=nick ?? "-";
  elStack.textContent=String(players[0]?.chips ?? 0);
  elPot.textContent=String(pot);
  elStage.textContent=stage + (paused ? " (PAUSED)" : "");
  elTurnName.textContent=players[current]?.name ?? "-";
  elTurnTimer.textContent=String(turnLeft);
}
function makeCardEl(text, hidden){
  const el=document.createElement("div");
  el.className="card"+(hidden?" hidden":"");
  if(hidden){ el.textContent="🂠"; return el; }
  if(!text){ el.style.opacity="0.35"; el.textContent="—"; return el; }
  const r=text[0], s=text.slice(1);
  const sm=document.createElement("small"); sm.textContent=r;
  const suit=document.createElement("div"); suit.className="suit"; suit.textContent=s;
  el.appendChild(sm); el.appendChild(suit);
  return el;
}

let heroCombo="", heroPct=null, heroHL=new Set();
function updateHero(){
  heroCombo=""; heroPct=null; heroHL.clear();
  const hero=players[0];
  if(!handInProgress || !hero || hero.out || hero.folded) return;
  const cards=hero.hand.concat(board);
  if(cards.length>=5){
    const {ev,best5}=bestOf7(cards);
    heroCombo=catName(ev.cat);
    for(const c of best5) heroHL.add(cardKey(c));
  }
  heroPct=monteCarloWinPct();
}

function render(){
  updateHero();

  elBoard.innerHTML="";
  for(let i=0;i<5;i++){
    const c=board[i];
    const el=makeCardEl(c?(c.r+c.s):"", !c);
    if(c && heroHL.has(cardKey(c))) el.classList.add("neon");
    elBoard.appendChild(el);
  }

  elSeats.innerHTML="";
  const pos=["pos-0","pos-1","pos-2","pos-3","pos-4","pos-5"];
  for(let i=0;i<players.length;i++){
    const p=players[i];
    const seat=document.createElement("div");
    seat.className=`seat ${pos[i]||"pos-5"}`;

    const top=document.createElement("div"); top.className="top";
    const nm=document.createElement("div"); nm.className="name"; nm.textContent=p.name;

    const tag=document.createElement("div"); tag.className="tag";
    if(p.out){ tag.classList.add("out"); tag.textContent="OUT"; }
    else if(handInProgress && i===current && !paused && !p.folded){ tag.classList.add("turn"); tag.textContent="TURN"; }
    else tag.textContent=p.isBot?"BOT":"YOU";

    top.appendChild(nm); top.appendChild(tag);

    const meta=document.createElement("div"); meta.className="meta";
    meta.innerHTML=`<span>chips: <b>${p.chips}</b></span><span>${p.folded? "<span style='color:var(--danger)'>folded</span>":""}</span>`;

    const cards=document.createElement("div"); cards.className="cards";
    const hide=p.isBot && handInProgress && stage!=="SHOWDOWN";
    const showCards=!p.isBot || stage==="SHOWDOWN" || !handInProgress;

    const c1=p.hand[0], c2=p.hand[1];
    const el1=makeCardEl(c1&&showCards?(c1.r+c1.s):"", hide||!showCards);
    const el2=makeCardEl(c2&&showCards?(c2.r+c2.s):"", hide||!showCards);

    if(i===0 && c1 && heroHL.has(cardKey(c1))) el1.classList.add("neon");
    if(i===0 && c2 && heroHL.has(cardKey(c2))) el2.classList.add("neon");

    cards.appendChild(el1); cards.appendChild(el2);

    const bet=document.createElement("div"); bet.className="bet";
    bet.textContent = p.out ? "" : (p.bet>0 ? `Bet: ${p.bet}` : "");

    seat.appendChild(top); seat.appendChild(meta); seat.appendChild(cards); seat.appendChild(bet);

    if(i===0){
      const info=document.createElement("div");
      info.className="hero-info";
      info.innerHTML = `<div>Hand: <b>${heroCombo||"-"}</b></div><div>Win: <span class="pct">${heroPct==null?"-":heroPct+"%"}</span></div>`;
      seat.appendChild(info);
    }

    elSeats.appendChild(seat);
  }

  renderHUD();
  updateButtons();
}

function updateButtons(){
  const you=players[0];
  const yourTurn = tournamentStarted && handInProgress && current===0 && you && !you.out && !you.folded && !paused && !menuOpen;
  btnFold.disabled=!yourTurn;
  btnRaise.disabled=!yourTurn || raisesThisRound>=MAX_RAISES_PER_ROUND;
  const need=(you&&handInProgress)?Math.max(0,toCall-you.bet):0;
  btnCheck.disabled=!(yourTurn && need===0);
  btnCall.disabled=!(yourTurn && need>0);
}

/* ====== Turn timer ====== */
function startTurnTimer(){
  if(turnTimerId) clearInterval(turnTimerId);
  turnLeft=turnSeconds;
  elTurnTimer.textContent=String(turnLeft);
  turnTimerId=scheduleInterval(()=>{
    if(paused || menuOpen) return;
    turnLeft--;
    elTurnTimer.textContent=String(Math.max(0,turnLeft));
    if(turnLeft<=0){
      clearInterval(turnTimerId); turnTimerId=null;
      // auto action
      const you=players[0];
      const need=Math.max(0,toCall-you.bet);
      if(need===0) actionCheck(0,true);
      else actionFold(0,true);
    }
  },1000);
}

/* ====== Game flow ====== */
function startHand(){
  if(paused || menuOpen) return;

  ensureTournament();
  cleanupElims();

  const champ=tournamentWinner();
  if(champ){
    elMsg.textContent=`🏆 CHAMPION: ${champ.name}!`;
    render(); save();
    stopAllTimers();
    streetPauseId=scheduleTimeout(()=>{
      if(paused||menuOpen) return;
      players.forEach(p=>{ p.out=false;p.folded=false;p.bet=0;p.acted=false;p.hand=[];p.chips=START_CHIPS; });
      dealer=0; sbPos=1; bbPos=2;
      stage="IDLE"; handInProgress=false;
      board=[]; pot=0; deck=[];
      toCall=0; raisesThisRound=0;
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

  players.forEach(p=>{ p.folded=false; p.bet=0; p.acted=false; p.hand=[]; });

  dealer=nextNotOutIndex(dealer);
  sbPos=nextNotOutIndex(dealer);
  bbPos=nextNotOutIndex(sbPos);

  for(let r=0;r<2;r++){
    for(const p of players) if(!p.out) p.hand.push(deck.pop());
  }

  resetForStreet();
  postBlind(sbPos,SB);
  postBlind(bbPos,BB);
  toCall=Math.max(players[sbPos].bet, players[bbPos].bet);

  current=nextActiveIndex(bbPos);

  elMsg.textContent="Новая раздача…";
  render(); save();
  tick();
}

function pauseThen(fn, text){
  stopAllTimers();
  elMsg.textContent=text;
  renderHUD();
  streetPauseId=scheduleTimeout(()=>{ if(!paused && !menuOpen) fn(); }, STREET_PAUSE_MS);
}

function advanceStreet(){
  const label = stage==="PREFLOP"?"Флоп…":stage==="FLOP"?"Тёрн…":stage==="TURN"?"Ривер…":"Шоудаун…";
  pauseThen(()=>{
    resetForStreet();

    if(stage==="PREFLOP"){ board.push(deck.pop(),deck.pop(),deck.pop()); stage="FLOP"; }
    else if(stage==="FLOP"){ board.push(deck.pop()); stage="TURN"; }
    else if(stage==="TURN"){ board.push(deck.pop()); stage="RIVER"; }
    else if(stage==="RIVER"){ stage="SHOWDOWN"; }

    current=nextActiveIndex(dealer);
    render(); save();

    if(stage==="SHOWDOWN"){ pauseThen(showdown,"Шоудаун…"); return; }
    tick();
  }, label);
}

function showdown(){
  const alive=inHandPlayers();
  if(alive.length===1){ awardPot(players.indexOf(alive[0]),"(all folded)"); return; }

  const evals=alive.map(p=>({p,ev:bestOf7(p.hand.concat(board)).ev})).sort((a,b)=>cmp(a.ev,b.ev));
  const best=evals[evals.length-1].ev;
  const winners=evals.filter(x=>cmp(x.ev,best)===0).map(x=>x.p);

  const share=Math.floor(pot/winners.length);
  let rem=pot-share*winners.length;
  for(const w of winners){ w.chips+=share; if(rem>0){ w.chips+=1; rem--; } }

  elMsg.textContent=`Победитель: ${winners.map(w=>w.name).join(", ")}`;
  pot=0;
  handInProgress=false;
  stage="IDLE";
  cleanupElims();
  render(); save();

  stopAllTimers();
  streetPauseId=scheduleTimeout(()=>{ if(!paused&&!menuOpen) startHand(); },1200);
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
  streetPauseId=scheduleTimeout(()=>{ if(!paused&&!menuOpen) startHand(); },1200);
}

/* ====== Actions ====== */
function actionFold(i, byTimeout=false){
  stopAllTimers();
  const p=players[i]; if(!handInProgress||!p||p.out||p.folded) return;
  p.folded=true; p.acted=true;
  elMsg.textContent=byTimeout?`${p.name} auto-fold (timeout)`:`${p.name} folds`;
  render(); save();

  if(onlyOneLeft()){ awardPot(players.indexOf(inHandPlayers()[0]),"(all folded)"); return; }

  current=nextActiveIndex(i);
  if(bettingRoundComplete()) { advanceStreet(); return; }
  tick();
}

function actionCheck(i, byTimeout=false){
  stopAllTimers();
  const p=players[i]; if(!handInProgress||!p||p.out||p.folded) return;
  const need=Math.max(0,toCall-p.bet);
  if(need!==0) return;
  p.acted=true;
  elMsg.textContent=byTimeout?`${p.name} auto-check (timeout)`:`${p.name} checks`;
  current=nextActiveIndex(i);
  render(); save();
  if(bettingRoundComplete()) { advanceStreet(); return; }
  tick();
}

function actionCall(i){
  stopAllTimers();
  const p=players[i]; if(!handInProgress||!p||p.out||p.folded) return;
  const need=Math.max(0,toCall-p.bet);
  const pay=Math.min(need,p.chips);
  p.chips-=pay; p.bet+=pay; pot+=pay;
  p.acted=true;
  elMsg.textContent=`${p.name} calls ${pay}`;
  current=nextActiveIndex(i);
  render(); save();
  if(bettingRoundComplete()) { advanceStreet(); return; }
  tick();
}

function actionRaiseTo(i, raiseTo){
  stopAllTimers();
  const p=players[i]; if(!handInProgress||!p||p.out||p.folded) return;
  if(raisesThisRound>=MAX_RAISES_PER_ROUND){ actionCall(i); return; }

  const min=minRaiseTo();
  const max=p.bet+p.chips;
  raiseTo=clamp(Math.max(raiseTo,min), 0, max);

  const add=Math.max(0,raiseTo-p.bet);
  const pay=Math.min(add,p.chips);
  if(pay<=0){ actionCall(i); return; }

  p.chips-=pay; p.bet+=pay; pot+=pay;
  toCall=Math.max(toCall,p.bet);
  raisesThisRound++;
  resetOthersActedAfterRaise(i);

  elMsg.textContent=`${p.name} raises to ${p.bet}`;
  current=nextActiveIndex(i);
  render(); save();
  tick();
}

/* ====== Bots ====== */
function botDecision(i){
  const p=players[i];
  const need=Math.max(0,toCall-p.bet);
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
  let strength=(ev.cat/8)+(Math.random()-0.5)*0.10;

  if(need===0) return (strength>0.62 && raisesThisRound<MAX_RAISES_PER_ROUND && Math.random()<0.22) ? "RAISE" : "CHECK";
  if(strength<0.25 && pressure>0.14 && Math.random()<0.80) return "FOLD";
  if(strength>0.72 && raisesThisRound<MAX_RAISES_PER_ROUND && Math.random()<0.30) return "RAISE";
  return "CALL";
}

function botAct(){
  if(!handInProgress || paused || menuOpen) return;

  if(players[current].out || players[current].folded) current=nextActiveIndex(current);
  if(onlyOneLeft()){ awardPot(players.indexOf(inHandPlayers()[0]),"(all folded)"); return; }

  const d=botDecision(current);
  if(d==="FOLD") actionFold(current);
  else if(d==="CHECK") actionCheck(current);
  else if(d==="RAISE"){
    const p=players[current];
    const min=minRaiseTo(), max=p.bet+p.chips;
    let target=min + ((Math.random()*3)|0)*BB;
    target=clamp(target,min,max);
    actionRaiseTo(current,target);
  } else actionCall(current);
}

/* ====== Tick ====== */
function tick(){
  stopAllTimers();

  if(paused || menuOpen){
    updateButtons();
    return;
  }

  ensureTournament();

  if(!handInProgress || stage==="IDLE"){
    startHand();
    return;
  }

  if(players[current].out || players[current].folded) current=nextActiveIndex(current);

  renderHUD();
  updateButtons();

  if(!players[current].isBot){
    elMsg.textContent="Твой ход.";
    startTurnTimer();
    return;
  }

  elMsg.textContent="Бот думает…";
  botTimerId=scheduleTimeout(()=>botAct(), BOT_THINK_MS);
}

/* ====== Menu (ALWAYS OPEN) ====== */
function buildMenu(){
  menuControls.innerHTML="";

  const row=document.createElement("div");
  row.className="row between";

  const status=document.createElement("div");
  status.className="pill";
  status.textContent = paused ? "Status: PAUSED" : "Status: RUNNING";

  const pauseBtn=document.createElement("button");
  pauseBtn.className="btn";
  pauseBtn.textContent="Pause";
  pauseBtn.onclick=()=>{
    paused=true;
    stopAllTimers();
    render(); save();
    buildMenu();
  };

  const resumeBtn=document.createElement("button");
  resumeBtn.className="btn accent";
  resumeBtn.textContent="Resume";
  resumeBtn.onclick=()=>resumeGame();

  const sel=document.createElement("select");
  for(const v of TURN_SECONDS_OPTIONS){
    const opt=document.createElement("option");
    opt.value=String(v);
    opt.textContent=`${v} sec`;
    if(v===turnSeconds) opt.selected=true;
    sel.appendChild(opt);
  }
  sel.onchange=()=>{ turnSeconds=Number(sel.value); save(); };

  row.appendChild(status);
  row.appendChild(pauseBtn);
  row.appendChild(resumeBtn);
  row.appendChild(sel);
  menuControls.appendChild(row);
}

function openMenu(){
  // 🔥 ВАЖНО: меню открывается ВСЕГДА
  menuOpen=true;
  stopAllTimers();
  show(menuOverlay,true);
  buildMenu();
  renderHUD();
  updateButtons();
}

function closeMenu(){
  show(menuOverlay,false);
  menuOpen=false;
  if(!paused) tick();
  else updateButtons();
}

function resumeGame(){
  stopAllTimers();
  ensureTournament();

  paused=false;
  menuOpen=false;
  show(menuOverlay,false);

  if(!handInProgress || stage==="IDLE") startHand();
  else tick();

  save();
}

/* ====== Raise modal ====== */
function openRaiseModal(){
  const you=players[0];
  const min=clamp(minRaiseTo(),0,you.bet+you.chips);
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
  const min=clamp(minRaiseTo(),0,you.bet+you.chips);
  const max=you.bet+you.chips;
  let v=Number(raiseInput.value||min);
  v=clamp(v,min,max);
  raiseInput.value=String(v);
  raiseSlider.value=String(v);
  raiseToLabel.textContent=String(v);
}

/* ====== Events ====== */
btnMenu.addEventListener("click", openMenu);
btnCloseMenu.addEventListener("click", closeMenu);

btnFold.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) actionFold(0); });
btnCheck.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) actionCheck(0); });
btnCall.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) actionCall(0); });
btnRaise.addEventListener("click", ()=>{ if(current===0 && !paused && !menuOpen) openRaiseModal(); });

raiseSlider.addEventListener("input", syncRaiseFromSlider);
raiseInput.addEventListener("input", syncRaiseFromInput);
btnRaiseClose.addEventListener("click", closeRaiseModal);
btnRaiseConfirm.addEventListener("click", ()=>{
  const v=Number(raiseSlider.value);
  closeRaiseModal();
  if(current===0 && !paused && !menuOpen) actionRaiseTo(0,v);
});
btnRaiseMin.addEventListener("click", ()=>{ raiseSlider.value=raiseSlider.min; syncRaiseFromSlider(); });
btnRaiseAll.addEventListener("click", ()=>{ raiseSlider.value=raiseSlider.max; syncRaiseFromSlider(); });
btnRaiseHalf.addEventListener("click", ()=>{
  const min=Number(raiseSlider.min), max=Number(raiseSlider.max);
  raiseSlider.value=String(((min+max)/2)|0);
  syncRaiseFromSlider();
});

/* ====== Nick flow ====== */
function openNick(){
  show(nickOverlay,true);
  const last=localStorage.getItem(STORAGE_PREFIX+"lastNick");
  if(last){ nickInput.value=last; nickInput.select(); }
  setTimeout(()=>nickInput.focus(),30);
}

nickOk.addEventListener("click", ()=>{
  const n=nickInput.value.trim();
  if(!n){ nickInput.focus(); return; }

  nick=n;
  saveKey=keyForNick(nick);

  // грузим, но ВСЕГДА стартуем с paused=true и меню
  const st=load(nick);
  ensureTournament();

  if(st && st.game && Array.isArray(st.game.players)){
    players=st.game.players;
    deck=st.game.deck||[];
    board=st.game.board||[];
    pot=Number(st.game.pot||0);

    stage=st.game.stage||"IDLE";
    handInProgress=!!st.game.handInProgress;
    tournamentStarted=!!st.game.tournamentStarted;

    dealer=Number(st.game.dealer||0);
    sbPos=Number(st.game.sbPos||1);
    bbPos=Number(st.game.bbPos||2);
    current=Number(st.game.current||0);
    toCall=Number(st.game.toCall||0);
    raisesThisRound=Number(st.game.raisesThisRound||0);

    // hero enforce
    players[0].name=nick;
    players[0].isBot=false;
  } else {
    ensureTournament();
  }

  // 🔥 КЛЮЧ: всегда сначала меню и пауза
  paused=true;
  handInProgress=false;
  stage="IDLE";
  toCall=0; raisesThisRound=0;
  stopAllTimers();

  show(nickOverlay,false);
  render();
  openMenu();
  save();
});
nickInput.addEventListener("keydown",(e)=>{ if(e.key==="Enter") nickOk.click(); });

/* ====== Boot ====== */
function boot(){
  // placeholder seats
  players=[
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
