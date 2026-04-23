/* ═══════════════════════════════════════════════════════════
   BATTLESHIP (multijoueur MQTT 1v1) + SPACE INVADERS (solo)
   ═══════════════════════════════════════════════════════════ */

const {useState:_useState,useEffect:_useEffect,useRef:_useRef,useCallback:_useCallback,useMemo:_useMemo}=React;

/* ──────────── BATTLESHIP ──────────── */
const BS_SIZE=10;
const BS_SHIPS=[{n:'Porte-avions',s:5},{n:'Croiseur',s:4},{n:'Sous-marin',s:3},{n:'Destroyer',s:3},{n:'Patrouilleur',s:2}];
const BS_TOPIC_STATE='arcade-hub/bs-room/v1/state';
const BS_TOPIC_ACTION='arcade-hub/bs-room/v1/action';
const BS_LOBBY='arcade-hub/bs-room/v1/lobby';

function bsEmptyGrid(){return Array(BS_SIZE).fill(null).map(()=>Array(BS_SIZE).fill(0));}
function bsRandomFleet(){
  const g=bsEmptyGrid();const ships=[];
  for(const {n,s} of BS_SHIPS){
    let tries=0;
    while(tries++<500){
      const h=Math.random()<0.5;
      const r=Math.floor(Math.random()*(h?BS_SIZE:BS_SIZE-s+1));
      const c=Math.floor(Math.random()*(h?BS_SIZE-s+1:BS_SIZE));
      let ok=true;
      for(let i=0;i<s;i++){
        const rr=r+(h?0:i),cc=c+(h?i:0);
        for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
          const nr=rr+dr,nc=cc+dc;
          if(nr>=0&&nr<BS_SIZE&&nc>=0&&nc<BS_SIZE&&g[nr][nc]){ok=false;break;}
        }
        if(!ok)break;
      }
      if(ok){
        const cells=[];
        for(let i=0;i<s;i++){const rr=r+(h?0:i),cc=c+(h?i:0);g[rr][cc]=ships.length+1;cells.push([rr,cc]);}
        ships.push({name:n,size:s,cells,hits:0});
        break;
      }
    }
  }
  return {grid:g,ships};
}

function BattleshipGame({myClientId,myName,onPoints}){
  const [phase,setPhase]=_useState('menu'); // menu | lobby | placing | playing | over
  const [myFleet,setMyFleet]=_useState(null);
  const [myShots,setMyShots]=_useState(()=>bsEmptyGrid());       // shots fired by me (on opponent)
  const [theirShots,setTheirShots]=_useState(()=>bsEmptyGrid()); // shots fired by opponent (on me)
  const [turn,setTurn]=_useState(null);
  const [opponent,setOpponent]=_useState(null);
  const [lobby,setLobby]=_useState({}); // clientId -> {name, ts}
  const [winner,setWinner]=_useState(null);
  const [status,setStatus]=_useState('Déconnecté');
  const [log,setLog]=_useState([]);
  const [placementIdx,setPlacementIdx]=_useState(0);
  const [orient,setOrient]=_useState('h');
  const [manualGrid,setManualGrid]=_useState(()=>({grid:bsEmptyGrid(),ships:[]}));
  const clientRef=_useRef(null);
  const gameIdRef=_useRef(null);
  const pointsAwardedRef=_useRef(false);
  const myFleetRef=_useRef(null);
  _useEffect(()=>{myFleetRef.current=myFleet;},[myFleet]);

  const pushLog=(t)=>setLog(l=>[...l.slice(-15),t]);

  _useEffect(()=>{
    let client;
    try{
      client=mqtt.connect('wss://broker.hivemq.com:8884/mqtt',{clientId:'bs_'+myClientId,clean:true,connectTimeout:8000,reconnectPeriod:3000,keepalive:30});
      client.on('connect',()=>{setStatus('En ligne');client.subscribe([BS_LOBBY,BS_TOPIC_ACTION,BS_TOPIC_STATE],{qos:0});});
      client.on('offline',()=>setStatus('Hors ligne'));
      client.on('reconnect',()=>setStatus('Reconnexion…'));
      client.on('message',(topic,msg)=>{
        try{
          const m=JSON.parse(msg.toString());
          if(topic===BS_LOBBY){
            if(m.type==='here'){
              setLobby(lb=>({...lb,[m.clientId]:{name:m.name,ts:Date.now()}}));
            }else if(m.type==='leave'){
              setLobby(lb=>{const c={...lb};delete c[m.clientId];return c;});
            }else if(m.type==='challenge'&&m.to===myClientId){
              // incoming challenge
              if(phase==='lobby'||phase==='menu'){
                // accept automatically if we're in lobby (simplification)
                const gid=[myClientId,m.from].sort().join('_');
                gameIdRef.current=gid;
                setOpponent({clientId:m.from,name:m.fromName});
                client.publish(BS_TOPIC_ACTION,JSON.stringify({gid,type:'accept',from:myClientId,fromName:myName,to:m.from}));
                setPhase('placing');
                setMyFleet({grid:bsEmptyGrid(),ships:[]});
                setManualGrid({grid:bsEmptyGrid(),ships:[]});
                setPlacementIdx(0);
                pushLog(`⚔ Défié par ${m.fromName} — placement…`);
              }
            }else if(m.type==='accept'&&m.to===myClientId){
              const gid=[myClientId,m.from].sort().join('_');
              gameIdRef.current=gid;
              setOpponent({clientId:m.from,name:m.fromName});
              setPhase('placing');
              setMyFleet({grid:bsEmptyGrid(),ships:[]});
              setManualGrid({grid:bsEmptyGrid(),ships:[]});
              setPlacementIdx(0);
              pushLog(`⚔ ${m.fromName} a accepté !`);
            }
          }else if(topic===BS_TOPIC_ACTION&&m.gid===gameIdRef.current){
            if(m.type==='ready'&&m.from!==myClientId){
              setOpponentReady(true);
            }else if(m.type==='shot'&&m.from!==myClientId){
              // opponent shot us
              const f=myFleetRef.current;
              if(!f)return;
              const [r,c]=m.cell;
              const hit=f.grid[r][c]>0;
              const newTheir=theirShotsRefFn().map(row=>[...row]);
              newTheir[r][c]=hit?2:1;
              setTheirShots(newTheir);
              // check sunk
              let sunkShip=null;let allSunk=false;
              if(hit){
                const shipId=f.grid[r][c];
                const ship=f.ships[shipId-1];
                ship.hits=(ship.hits||0)+1;
                if(ship.hits>=ship.size)sunkShip=ship.name;
                allSunk=f.ships.every(s=>(s.hits||0)>=s.size);
              }
              client.publish(BS_TOPIC_ACTION,JSON.stringify({gid:m.gid,type:'result',from:myClientId,cell:m.cell,hit,sunk:sunkShip,allSunk}));
              pushLog(hit?(sunkShip?`💥 ${opponent?.name||'Adv'} a coulé votre ${sunkShip} !`:`💥 ${opponent?.name||'Adv'} touche.`):`💧 ${opponent?.name||'Adv'} rate.`);
              if(allSunk){
                setWinner(opponent?.name||'Adversaire');
                setPhase('over');
              }else{
                setTurn(myClientId); // it's our turn now
              }
            }else if(m.type==='result'&&m.from!==myClientId){
              // result of our shot
              const [r,c]=m.cell;
              setMyShots(s=>{const n=s.map(row=>[...row]);n[r][c]=m.hit?2:1;return n;});
              pushLog(m.hit?(m.sunk?`🔥 Coulé ! ${m.sunk}`:'🎯 Touché !'):'💦 Manqué.');
              if(m.allSunk){
                setWinner(myName);
                setPhase('over');
              }else{
                setTurn(opponent?.clientId||m.from);
              }
            }else if(m.type==='quit'&&m.from!==myClientId){
              pushLog(`🚪 ${opponent?.name||'Adv'} a quitté.`);
              setWinner(myName);
              setPhase('over');
            }
          }
        }catch{}
      });
      clientRef.current=client;
    }catch{setStatus('Indisponible');}
    return()=>{
      if(clientRef.current?.connected){
        clientRef.current.publish(BS_LOBBY,JSON.stringify({type:'leave',clientId:myClientId}));
        if(gameIdRef.current)clientRef.current.publish(BS_TOPIC_ACTION,JSON.stringify({gid:gameIdRef.current,type:'quit',from:myClientId}));
        clientRef.current.end(true);
      }
    };
  },[]);

  const theirShotsRefFn=()=>theirShots;
  const [opponentReady,setOpponentReady]=_useState(false);
  const [iAmReady,setIAmReady]=_useState(false);
  _useEffect(()=>{
    if(iAmReady&&opponentReady&&phase==='placing'){
      // coin toss: lower clientId goes first
      const first=[myClientId,opponent.clientId].sort()[0];
      setTurn(first);
      setPhase('playing');
      pushLog(first===myClientId?'🎲 À vous de jouer !':`🎲 ${opponent.name} commence.`);
    }
  },[iAmReady,opponentReady,phase]);

  // Announce in lobby every 8s when in lobby
  _useEffect(()=>{
    if(phase!=='lobby')return;
    const ping=()=>clientRef.current?.publish(BS_LOBBY,JSON.stringify({type:'here',clientId:myClientId,name:myName,ts:Date.now()}));
    ping();
    const id=setInterval(ping,8000);
    // Clean stale players
    const clean=setInterval(()=>setLobby(lb=>{const n={};const now=Date.now();for(const k in lb)if(now-lb[k].ts<20000)n[k]=lb[k];return n;}),4000);
    return()=>{clearInterval(id);clearInterval(clean);};
  },[phase]);

  const joinLobby=()=>{setPhase('lobby');};
  const challenge=(targetId,targetName)=>{
    clientRef.current?.publish(BS_LOBBY,JSON.stringify({type:'challenge',from:myClientId,fromName:myName,to:targetId,ts:Date.now()}));
    pushLog(`📨 Défi envoyé à ${targetName}…`);
  };
  const quickMatch=()=>{
    const others=Object.entries(lobby).filter(([id])=>id!==myClientId);
    if(others.length===0){pushLog('Aucun adversaire.');return;}
    const [id,p]=others[Math.floor(Math.random()*others.length)];
    challenge(id,p.name);
  };
  const randomPlace=()=>{const f=bsRandomFleet();setMyFleet(f);setManualGrid(f);setPlacementIdx(BS_SHIPS.length);};
  const clearPlacement=()=>{setMyFleet({grid:bsEmptyGrid(),ships:[]});setManualGrid({grid:bsEmptyGrid(),ships:[]});setPlacementIdx(0);};
  const placeAt=(r,c)=>{
    if(placementIdx>=BS_SHIPS.length)return;
    const s=BS_SHIPS[placementIdx].s;
    const h=orient==='h';
    if(h&&c+s>BS_SIZE)return;
    if(!h&&r+s>BS_SIZE)return;
    const g=manualGrid.grid.map(row=>[...row]);
    const cells=[];
    for(let i=0;i<s;i++){
      const rr=r+(h?0:i),cc=c+(h?i:0);
      for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){
        const nr=rr+dr,nc=cc+dc;
        if(nr>=0&&nr<BS_SIZE&&nc>=0&&nc<BS_SIZE&&g[nr][nc])return;
      }
      cells.push([rr,cc]);
    }
    cells.forEach(([rr,cc])=>g[rr][cc]=manualGrid.ships.length+1);
    const newShips=[...manualGrid.ships,{name:BS_SHIPS[placementIdx].n,size:s,cells,hits:0}];
    const newState={grid:g,ships:newShips};
    setManualGrid(newState);
    setMyFleet(newState);
    setPlacementIdx(placementIdx+1);
  };
  const confirmReady=()=>{
    if(placementIdx<BS_SHIPS.length){pushLog('Placez tous les navires.');return;}
    setIAmReady(true);
    clientRef.current?.publish(BS_TOPIC_ACTION,JSON.stringify({gid:gameIdRef.current,type:'ready',from:myClientId}));
    pushLog('✅ Prêt — en attente de l\'adversaire…');
  };
  const fire=(r,c)=>{
    if(phase!=='playing')return;
    if(turn!==myClientId)return;
    if(myShots[r][c]!==0)return;
    clientRef.current?.publish(BS_TOPIC_ACTION,JSON.stringify({gid:gameIdRef.current,type:'shot',from:myClientId,cell:[r,c]}));
    setTurn(null); // wait for result
    pushLog(`🎯 Tir en ${String.fromCharCode(65+r)}${c+1}…`);
  };
  const backToMenu=()=>{
    if(phase==='playing')clientRef.current?.publish(BS_TOPIC_ACTION,JSON.stringify({gid:gameIdRef.current,type:'quit',from:myClientId}));
    gameIdRef.current=null;
    setPhase('menu');setMyFleet(null);setMyShots(bsEmptyGrid());setTheirShots(bsEmptyGrid());
    setOpponent(null);setWinner(null);setIAmReady(false);setOpponentReady(false);setPlacementIdx(0);
    pointsAwardedRef.current=false;
  };

  // award points once
  _useEffect(()=>{
    if(phase==='over'&&!pointsAwardedRef.current&&winner===myName){
      pointsAwardedRef.current=true;
      onPoints(400,'battleship');
    }
  },[phase,winner]);

  const renderGrid=(grid,shots,clickable,showShips)=>{
    return (
      <div className="bs-grid">
        <div className="bs-corner"/>
        {Array.from({length:BS_SIZE}).map((_,i)=><div key={'c'+i} className="bs-label">{i+1}</div>)}
        {Array.from({length:BS_SIZE}).map((_,r)=>(
          <React.Fragment key={'r'+r}>
            <div className="bs-label">{String.fromCharCode(65+r)}</div>
            {Array.from({length:BS_SIZE}).map((_,c)=>{
              const shot=shots?shots[r][c]:0;
              const ship=grid?grid[r][c]:0;
              let cls='bs-cell';
              if(showShips&&ship)cls+=' ship';
              if(shot===1)cls+=' miss';
              if(shot===2)cls+=' hit';
              if(clickable&&shot===0)cls+=' clickable';
              return <div key={r+'_'+c} className={cls} onClick={()=>clickable&&fire(r,c)}>
                {shot===1?'•':shot===2?'✕':''}
              </div>;
            })}
          </React.Fragment>
        ))}
      </div>
    );
  };

  if(phase==='menu')return(
    <div className="bs-panel">
      <div className="bs-title">⚓ Bataille Navale</div>
      <div className="bs-sub">Jeu multijoueur 1v1 · temps réel</div>
      <div className="bs-menu">
        <button className="ms-ov-btn" onClick={joinLobby}>Chercher un adversaire</button>
      </div>
      <div className="bs-rules">
        <div className="bs-rules-t">Règles</div>
        <div>• Placez 5 navires (tailles 5, 4, 3, 3, 2)</div>
        <div>• Tirez à tour de rôle. Premier à tout couler gagne.</div>
        <div>• Victoire = <b style={{color:'var(--amber)'}}>+400 pts</b></div>
      </div>
    </div>
  );

  if(phase==='lobby'){
    const others=Object.entries(lobby).filter(([id])=>id!==myClientId);
    return(
      <div className="bs-panel">
        <div className="bs-title">⚓ Salon d'attente</div>
        <div className="bs-sub">{others.length} joueur{others.length>1?'s':''} disponible{others.length>1?'s':''}</div>
        <div style={{display:'flex',gap:8,margin:'12px 0'}}>
          <button className="ms-ov-btn" onClick={quickMatch} disabled={others.length===0}>⚡ Match rapide</button>
          <button className="ms-ov-btn" style={{background:'transparent',border:'1px solid var(--border)'}} onClick={()=>setPhase('menu')}>← Retour</button>
        </div>
        <div className="bs-lobby-list">
          {others.length===0?<div className="bs-empty">Aucun autre joueur. Ouvrez l'app sur un 2ᵉ appareil pour tester.</div>:
            others.map(([id,p])=>(
              <div key={id} className="bs-lobby-row">
                <div className="bs-lobby-avatar">{p.name.slice(0,2).toUpperCase()}</div>
                <div style={{flex:1}}>{p.name}</div>
                <button className="ms-ov-btn" style={{fontSize:10,padding:'6px 12px'}} onClick={()=>challenge(id,p.name)}>Défier</button>
              </div>
            ))
          }
        </div>
        <div className="bs-log">{log.map((l,i)=><div key={i}>{l}</div>)}</div>
      </div>
    );
  }

  if(phase==='placing')return(
    <div className="bs-panel">
      <div className="bs-title">⚓ Placement des navires</div>
      <div className="bs-sub">Adversaire : <b>{opponent?.name}</b>{iAmReady&&' · ✅ Prêt'}{opponentReady&&' · adversaire prêt'}</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',margin:'10px 0'}}>
        <button className="ms-ov-btn" style={{fontSize:10,padding:'6px 12px'}} onClick={()=>setOrient(o=>o==='h'?'v':'h')}>Rotation : {orient==='h'?'Horizontal ↔':'Vertical ↕'}</button>
        <button className="ms-ov-btn" style={{fontSize:10,padding:'6px 12px'}} onClick={randomPlace}>🎲 Aléatoire</button>
        <button className="ms-ov-btn" style={{fontSize:10,padding:'6px 12px',background:'transparent',border:'1px solid var(--border)'}} onClick={clearPlacement}>↺ Effacer</button>
        {placementIdx>=BS_SHIPS.length&&!iAmReady&&<button className="ms-ov-btn" style={{fontSize:10,padding:'6px 12px',background:'var(--green)'}} onClick={confirmReady}>✓ Prêt</button>}
      </div>
      <div className="bs-ships-list">
        {BS_SHIPS.map((s,i)=><div key={i} className={`bs-ship-item${i===placementIdx?' current':''}${i<placementIdx?' done':''}`}>{i<placementIdx?'✓ ':''}{s.n} ({s.s})</div>)}
      </div>
      {renderGrid(manualGrid.grid,null,!iAmReady&&placementIdx<BS_SHIPS.length,true)}
      <div className="bs-log">{log.map((l,i)=><div key={i}>{l}</div>)}</div>
      <button className="ms-ov-btn" style={{fontSize:10,padding:'6px 12px',background:'transparent',border:'1px solid var(--red)',color:'var(--red)',marginTop:10}} onClick={backToMenu}>Abandonner</button>
    </div>
  );

  if(phase==='playing')return(
    <div className="bs-panel">
      <div className="bs-title">⚓ {turn===myClientId?<span style={{color:'var(--green)'}}>À vous !</span>:<span style={{color:'var(--text-dim)'}}>Attente de {opponent?.name}…</span>}</div>
      <div className="bs-sub">Contre <b>{opponent?.name}</b></div>
      <div className="bs-grids-wrap">
        <div>
          <div className="bs-grid-label">Tirs sur {opponent?.name}</div>
          {renderGrid(null,myShots,turn===myClientId,false)}
        </div>
        <div>
          <div className="bs-grid-label">Votre flotte</div>
          {renderGrid(myFleet?.grid,theirShots,false,true)}
        </div>
      </div>
      <div className="bs-log">{log.map((l,i)=><div key={i}>{l}</div>)}</div>
      <button className="ms-ov-btn" style={{fontSize:10,padding:'6px 12px',background:'transparent',border:'1px solid var(--red)',color:'var(--red)',marginTop:10}} onClick={backToMenu}>Abandonner</button>
    </div>
  );

  if(phase==='over')return(
    <div className="bs-panel">
      <div className="bs-title">{winner===myName?'🏆 VICTOIRE':'💀 DÉFAITE'}</div>
      <div className="bs-sub">{winner===myName?`+400 pts !`:`${winner} a gagné.`}</div>
      <div className="bs-grids-wrap">
        <div><div className="bs-grid-label">Vos tirs</div>{renderGrid(null,myShots,false,false)}</div>
        <div><div className="bs-grid-label">Votre flotte</div>{renderGrid(myFleet?.grid,theirShots,false,true)}</div>
      </div>
      <button className="ms-ov-btn" style={{marginTop:14}} onClick={backToMenu}>← Retour au menu</button>
    </div>
  );

  return null;
}

/* ──────────── SPACE INVADERS ──────────── */
function SpaceInvadersGame({onPoints}){
  const canvasRef=_useRef(null);
  const [state,setState]=_useState('menu'); // menu | playing | paused | over
  const [score,setScore]=_useState(0);
  const [lives,setLives]=_useState(3);
  const [wave,setWave]=_useState(1);
  const [best,setBest]=_useState(()=>parseInt(localStorage.getItem('si_best')||'0',10));
  const keysRef=_useRef({});
  const gameRef=_useRef(null);
  const stateRef=_useRef('menu');
  const pointsAwardedRef=_useRef(false);

  _useEffect(()=>{stateRef.current=state;},[state]);

  const start=()=>{
    setScore(0);setLives(3);setWave(1);
    pointsAwardedRef.current=false;
    initGame();
    setState('playing');
  };

  const initGame=()=>{
    const W=640,H=480;
    const player={x:W/2-16,y:H-48,w:32,h:18,cooldown:0};
    const invaders=[];
    const rows=4,cols=10;
    for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
      invaders.push({x:60+c*44,y:40+r*36,w:28,h:20,alive:true,type:r===0?'a':r===1?'b':'c'});
    }
    const bullets=[];const enemyBullets=[];
    const barriers=[];
    for(let i=0;i<4;i++){
      const bx=60+i*160;
      for(let px=0;px<40;px+=8)for(let py=0;py<24;py+=8){
        if(py>16&&(px<12||px>28))continue;
        barriers.push({x:bx+px,y:380+py,w:8,h:8,hp:3});
      }
    }
    gameRef.current={W,H,player,invaders,bullets,enemyBullets,barriers,dir:1,speed:0.7,stepDown:false,tick:0,wave:1,flash:0};
  };

  _useEffect(()=>{
    const onDown=(e)=>{keysRef.current[e.key]=true;if([' ','ArrowLeft','ArrowRight','ArrowUp'].includes(e.key))e.preventDefault();};
    const onUp=(e)=>{keysRef.current[e.key]=false;};
    window.addEventListener('keydown',onDown);window.addEventListener('keyup',onUp);
    return()=>{window.removeEventListener('keydown',onDown);window.removeEventListener('keyup',onUp);};
  },[]);

  _useEffect(()=>{
    if(state!=='playing')return;
    const canvas=canvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext('2d');
    let raf;let last=performance.now();
    const loop=(now)=>{
      if(stateRef.current!=='playing'){raf=requestAnimationFrame(loop);return;}
      const dt=Math.min(32,now-last);last=now;
      const g=gameRef.current;if(!g){raf=requestAnimationFrame(loop);return;}
      const {W,H,player,invaders,bullets,enemyBullets,barriers}=g;
      g.tick++;

      // player move
      const spd=4;
      if(keysRef.current['ArrowLeft']||keysRef.current['a'])player.x=Math.max(0,player.x-spd);
      if(keysRef.current['ArrowRight']||keysRef.current['d'])player.x=Math.min(W-player.w,player.x+spd);
      if((keysRef.current[' ']||keysRef.current['ArrowUp'])&&player.cooldown<=0){
        bullets.push({x:player.x+player.w/2-2,y:player.y,w:4,h:10,vy:-8});
        player.cooldown=20;
      }
      if(player.cooldown>0)player.cooldown--;

      // move invaders
      let leftMost=W,rightMost=0,bottomMost=0;
      invaders.forEach(inv=>{if(inv.alive){leftMost=Math.min(leftMost,inv.x);rightMost=Math.max(rightMost,inv.x+inv.w);bottomMost=Math.max(bottomMost,inv.y+inv.h);}});
      const alive=invaders.filter(i=>i.alive).length;
      const speedMul=1+(1-alive/40)*2.5+(g.wave-1)*0.3;
      invaders.forEach(inv=>{if(inv.alive)inv.x+=g.dir*g.speed*speedMul;});
      if(rightMost>=W-10||leftMost<=10){
        g.dir*=-1;
        invaders.forEach(inv=>{if(inv.alive)inv.y+=14;});
      }
      // enemy fire
      if(Math.random()<0.02+g.wave*0.005){
        const shooters=invaders.filter(i=>i.alive);
        if(shooters.length){
          const s=shooters[Math.floor(Math.random()*shooters.length)];
          enemyBullets.push({x:s.x+s.w/2-2,y:s.y+s.h,w:4,h:10,vy:3.5+g.wave*0.3});
        }
      }

      // update bullets
      for(let i=bullets.length-1;i>=0;i--){
        const b=bullets[i];b.y+=b.vy;
        if(b.y<-10){bullets.splice(i,1);continue;}
        // hit invader
        let hit=false;
        for(const inv of invaders){
          if(!inv.alive)continue;
          if(b.x<inv.x+inv.w&&b.x+b.w>inv.x&&b.y<inv.y+inv.h&&b.y+b.h>inv.y){
            inv.alive=false;hit=true;
            const pts=inv.type==='a'?30:inv.type==='b'?20:10;
            setScore(s=>s+pts);
            break;
          }
        }
        if(hit){bullets.splice(i,1);continue;}
        // hit barrier
        for(let j=barriers.length-1;j>=0;j--){
          const br=barriers[j];
          if(b.x<br.x+br.w&&b.x+b.w>br.x&&b.y<br.y+br.h&&b.y+b.h>br.y){
            br.hp--;if(br.hp<=0)barriers.splice(j,1);
            bullets.splice(i,1);hit=true;break;
          }
        }
      }
      for(let i=enemyBullets.length-1;i>=0;i--){
        const b=enemyBullets[i];b.y+=b.vy;
        if(b.y>H+10){enemyBullets.splice(i,1);continue;}
        // hit player
        if(b.x<player.x+player.w&&b.x+b.w>player.x&&b.y<player.y+player.h&&b.y+b.h>player.y){
          enemyBullets.splice(i,1);
          g.flash=15;
          setLives(l=>{const n=l-1;if(n<=0){stateRef.current='over';setState('over');}return n;});
          continue;
        }
        // hit barrier
        let hit=false;
        for(let j=barriers.length-1;j>=0;j--){
          const br=barriers[j];
          if(b.x<br.x+br.w&&b.x+b.w>br.x&&b.y<br.y+br.h&&b.y+b.h>br.y){
            br.hp--;if(br.hp<=0)barriers.splice(j,1);
            enemyBullets.splice(i,1);hit=true;break;
          }
        }
      }

      // invaders reached bottom
      if(bottomMost>=player.y){stateRef.current='over';setState('over');}

      // wave complete
      if(invaders.every(i=>!i.alive)){
        g.wave++;
        setWave(g.wave);
        setScore(s=>s+100*g.wave);
        // respawn
        const rows=4,cols=10;invaders.length=0;
        for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
          invaders.push({x:60+c*44,y:40+r*28,w:28,h:20,alive:true,type:r===0?'a':r===1?'b':'c'});
        }
        g.dir=1;g.speed=0.7+g.wave*0.15;
      }

      if(g.flash>0)g.flash--;

      // ─── render ───
      ctx.fillStyle='#05070b';ctx.fillRect(0,0,W,H);
      // stars
      ctx.fillStyle='rgba(255,255,255,.3)';
      for(let i=0;i<40;i++){const x=(i*73+g.tick*0.3)%W;const y=(i*131)%H;ctx.fillRect(x,y,1,1);}
      // player
      ctx.fillStyle=g.flash>0?'#ff3860':'#00e5ff';
      ctx.fillRect(player.x,player.y+6,player.w,player.h-6);
      ctx.fillRect(player.x+player.w/2-4,player.y,8,8);
      // invaders
      invaders.forEach(inv=>{
        if(!inv.alive)return;
        ctx.fillStyle=inv.type==='a'?'#ff3860':inv.type==='b'?'#ffb627':'#2ecc71';
        ctx.fillRect(inv.x+4,inv.y+4,inv.w-8,inv.h-8);
        ctx.fillRect(inv.x,inv.y+8,4,6);
        ctx.fillRect(inv.x+inv.w-4,inv.y+8,4,6);
        // eyes
        ctx.fillStyle='#000';
        ctx.fillRect(inv.x+8,inv.y+8,4,4);
        ctx.fillRect(inv.x+inv.w-12,inv.y+8,4,4);
      });
      // bullets
      ctx.fillStyle='#ffb627';bullets.forEach(b=>ctx.fillRect(b.x,b.y,b.w,b.h));
      ctx.fillStyle='#ff3860';enemyBullets.forEach(b=>ctx.fillRect(b.x,b.y,b.w,b.h));
      // barriers
      ctx.fillStyle='#2ecc71';barriers.forEach(br=>{ctx.globalAlpha=br.hp/3;ctx.fillRect(br.x,br.y,br.w,br.h);ctx.globalAlpha=1;});

      raf=requestAnimationFrame(loop);
    };
    raf=requestAnimationFrame(loop);
    return()=>cancelAnimationFrame(raf);
  },[state]);

  _useEffect(()=>{
    if(state==='over'&&!pointsAwardedRef.current){
      pointsAwardedRef.current=true;
      if(score>best){setBest(score);localStorage.setItem('si_best',String(score));}
      const pts=Math.floor(score/2);
      if(pts>0)onPoints(pts,'spaceinvaders');
    }
  },[state,score,best,onPoints]);

  // touch controls
  const touch=(dir,pressed)=>{
    if(dir==='left')keysRef.current['ArrowLeft']=pressed;
    if(dir==='right')keysRef.current['ArrowRight']=pressed;
    if(dir==='fire')keysRef.current[' ']=pressed;
  };

  if(state==='menu')return(
    <div className="si-panel">
      <div className="si-title">👾 Space Invaders</div>
      <div className="si-sub">Défendez la Terre · High score : <b style={{color:'var(--amber)'}}>{best}</b></div>
      <div className="si-menu">
        <button className="ms-ov-btn" onClick={start}>▶ Démarrer</button>
      </div>
      <div className="bs-rules">
        <div className="bs-rules-t">Contrôles</div>
        <div>• ← → ou A / D : déplacement</div>
        <div>• Espace ou ↑ : tirer</div>
        <div>• Score / 2 = points gagnés</div>
      </div>
    </div>
  );

  return(
    <div className="si-panel">
      <div className="si-hud">
        <div><div className="si-hud-lbl">Score</div><div className="si-hud-val">{score}</div></div>
        <div><div className="si-hud-lbl">Vague</div><div className="si-hud-val">{wave}</div></div>
        <div><div className="si-hud-lbl">Vies</div><div className="si-hud-val">{'❤'.repeat(Math.max(0,lives))||'—'}</div></div>
        <div><div className="si-hud-lbl">Best</div><div className="si-hud-val">{best}</div></div>
      </div>
      <canvas ref={canvasRef} width={640} height={480} className="si-canvas"/>
      {state==='over'&&(
        <div className="si-over">
          <div className="si-over-t">💥 GAME OVER</div>
          <div className="si-over-s">Score : <b>{score}</b> · Vague <b>{wave}</b></div>
          {score>best&&<div style={{color:'var(--amber)',fontSize:11,marginTop:4}}>🏆 Nouveau record !</div>}
          <div style={{fontSize:10,color:'var(--text-dim)',margin:'6px 0'}}>+{Math.floor(score/2)} pts</div>
          <button className="ms-ov-btn" onClick={start}>Rejouer</button>
          <button className="ms-ov-btn" style={{background:'transparent',border:'1px solid var(--border)',marginLeft:6}} onClick={()=>setState('menu')}>Menu</button>
        </div>
      )}
      <div className="si-touch">
        <button className="si-touch-btn" onTouchStart={(e)=>{e.preventDefault();touch('left',true);}} onTouchEnd={(e)=>{e.preventDefault();touch('left',false);}} onMouseDown={()=>touch('left',true)} onMouseUp={()=>touch('left',false)} onMouseLeave={()=>touch('left',false)}>←</button>
        <button className="si-touch-btn fire" onTouchStart={(e)=>{e.preventDefault();touch('fire',true);}} onTouchEnd={(e)=>{e.preventDefault();touch('fire',false);}} onMouseDown={()=>touch('fire',true)} onMouseUp={()=>touch('fire',false)} onMouseLeave={()=>touch('fire',false)}>🔥</button>
        <button className="si-touch-btn" onTouchStart={(e)=>{e.preventDefault();touch('right',true);}} onTouchEnd={(e)=>{e.preventDefault();touch('right',false);}} onMouseDown={()=>touch('right',true)} onMouseUp={()=>touch('right',false)} onMouseLeave={()=>touch('right',false)}>→</button>
      </div>
    </div>
  );
}

Object.assign(window,{BattleshipGame,SpaceInvadersGame});
