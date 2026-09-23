"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Headphones, Mic, MicOff, Phone, PhoneOff, Volume2 } from "lucide-react";
import type { Role } from "@/lib/types";
import { api, readableError } from "./workspace-ui";
import styles from "./operator-voice-controls.module.css";

type Signal = { callId:string|null; status:"waiting"|"offered"|"connected"|"ended"; offer?:RTCSessionDescriptionInit; answer?:RTCSessionDescriptionInit; iceServers:RTCIceServer[]; canOffer:boolean; canEnd?:boolean };
type VoiceState = "idle"|"microphone"|"connecting"|"ringing"|"connected"|"ended";

async function gatherIce(peer:RTCPeerConnection) {
  if(peer.iceGatheringState==="complete") return;
  await new Promise<void>((resolve,reject)=>{
    const finish=()=>{clearTimeout(timer);peer.removeEventListener("icegatheringstatechange",change);peer.removeEventListener("connectionstatechange",change);if(peer.connectionState==="closed")reject(new Error("Соединение завершено."));else resolve();};
    const change=()=>{if(peer.iceGatheringState==="complete"||peer.connectionState==="closed")finish();};
    const timer=setTimeout(finish,6_000);
    peer.addEventListener("icegatheringstatechange",change);peer.addEventListener("connectionstatechange",change);
  });
}

/** Real peer audio: no speech generation, recording or automatic microphone access. */
export function OperatorVoiceControls({sessionId,role,enabled}:{sessionId:string;role:Role;enabled:boolean}) {
  const [signal,setSignal]=useState<Signal|null>(null);
  const [state,setState]=useState<VoiceState>("idle");
  const [muted,setMuted]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [playBlocked,setPlayBlocked]=useState(false);
  const peerRef=useRef<RTCPeerConnection|null>(null);
  const streamRef=useRef<MediaStream|null>(null);
  const audioRef=useRef<HTMLAudioElement|null>(null);
  const callIdRef=useRef<string|null>(null);
  const pendingCallIdRef=useRef<string|null>(null);
  const generation=useRef(0);
  const starting=useRef(false);
  const timeoutRef=useRef<ReturnType<typeof setTimeout>|null>(null);
  const remoteReady=useRef(false);
  const disconnectRef=useRef<ReturnType<typeof setTimeout>|null>(null);
  const endpoint=`/api/sessions/${sessionId}/voice`;

  const cleanup=useCallback(()=>{
    generation.current++;starting.current=false;remoteReady.current=false;
    if(timeoutRef.current)clearTimeout(timeoutRef.current);
    if(disconnectRef.current)clearTimeout(disconnectRef.current);
    timeoutRef.current=null;disconnectRef.current=null;
    const peer=peerRef.current;peerRef.current=null;
    if(peer){peer.ontrack=null;peer.onconnectionstatechange=null;peer.close();}
    streamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current=null;
    if(audioRef.current){audioRef.current.pause();audioRef.current.srcObject=null;}
  },[]);

  const end=useCallback((notify=true)=>{
    const callId=callIdRef.current??pendingCallIdRef.current;callIdRef.current=null;pendingCallIdRef.current=null;cleanup();setState("ended");setMuted(false);setPlayBlocked(false);
    if(notify&&callId)void api(endpoint,{method:"POST",body:JSON.stringify({action:"end",callId}),keepalive:true}).catch(()=>{});
  },[cleanup,endpoint]);

  useEffect(()=>{
    let disposed=false,polling=false;
    setState("idle");setSignal(null);setError(null);setMuted(false);setPlayBlocked(false);
    if(!enabled){end();setSignal(null);return;}
    const poll=async()=>{
      if(polling||disposed||document.visibilityState!=="visible"&&!peerRef.current)return;
      polling=true;
      const pollGeneration=generation.current,pollCallId=callIdRef.current;
      try{
        const value=await api<Signal>(endpoint);
        if(disposed||pollGeneration!==generation.current||pollCallId!==callIdRef.current||pendingCallIdRef.current)return;setSignal(value);
        const active=callIdRef.current,peer=peerRef.current;
        if(active&&(value.callId!==active||value.status==="ended"||value.status==="waiting")){end(false);return;}
        if(role==="supervisor"&&peer&&active===value.callId&&value.answer&&!remoteReady.current){
          remoteReady.current=true;
          try{await peer.setRemoteDescription(value.answer);}catch(err){remoteReady.current=false;throw err;}
        }
      }catch(err){if(!disposed)setError(readableError(err));}finally{polling=false;}
    };
    void poll();const interval=setInterval(()=>void poll(),1_200);
    const pageHide=()=>end();window.addEventListener("pagehide",pageHide);
    return()=>{disposed=true;clearInterval(interval);window.removeEventListener("pagehide",pageHide);const callId=callIdRef.current??pendingCallIdRef.current;callIdRef.current=null;pendingCallIdRef.current=null;cleanup();if(callId)void api(endpoint,{method:"POST",body:JSON.stringify({action:"end",callId}),keepalive:true}).catch(()=>{});};
  },[enabled,endpoint,role,cleanup,end]);

  async function start(){
    if(!enabled||starting.current||peerRef.current)return;
    starting.current=true;setError(null);setMuted(false);setPlayBlocked(false);setState("microphone");
    const revision=++generation.current;
    try{
      if(!navigator.mediaDevices?.getUserMedia||typeof RTCPeerConnection==="undefined")throw new Error("Голосовой звонок недоступен в этом браузере. Откройте сайт в современном браузере по HTTPS.");
      const latest=await api<Signal>(endpoint);
      if(revision!==generation.current)return;
      if(role==="supervisor"&&!latest.canOffer)throw new Error("Звонок уже начат. Завершите его перед новым подключением.");
      if(role!=="supervisor"&&(!latest.offer||!latest.callId||latest.status!=="offered"))throw new Error("Оператор ещё не начал голосовое подключение.");
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(revision!==generation.current){stream.getTracks().forEach(t=>t.stop());return;}
      streamRef.current=stream;
      const peer=new RTCPeerConnection({iceServers:latest.iceServers});peerRef.current=peer;
      stream.getAudioTracks().forEach(track=>{peer.addTrack(track,stream);track.onended=()=>{if(revision===generation.current){setError("Микрофон отключён. Звонок завершён.");end();}};});
      peer.ontrack=event=>{
        if(revision!==generation.current||!audioRef.current)return;
        audioRef.current.srcObject=event.streams[0]??new MediaStream([event.track]);
        void audioRef.current.play().catch(()=>setPlayBlocked(true));
      };
      peer.onconnectionstatechange=()=>{
        if(revision!==generation.current)return;
        if(peer.connectionState==="connected"){
          if(timeoutRef.current)clearTimeout(timeoutRef.current);if(disconnectRef.current)clearTimeout(disconnectRef.current);
          setState("connected");setError(null);
        }else if(peer.connectionState==="failed"){
          setError("Не удалось соединить голос. Попробуйте другую сеть или продолжите в чате.");end();
        }else if(peer.connectionState==="disconnected"){
          setState("connecting");if(disconnectRef.current)clearTimeout(disconnectRef.current);
          disconnectRef.current=setTimeout(()=>{if(revision===generation.current){setError("Голосовое соединение потеряно. Переписка остаётся доступна.");end();}},10_000);
        }
      };
      setState("connecting");
      const callId=role==="supervisor"?crypto.randomUUID():latest.callId!;
      if(role==="supervisor")await peer.setLocalDescription(await peer.createOffer());
      else{await peer.setRemoteDescription(latest.offer!);await peer.setLocalDescription(await peer.createAnswer());}
      await gatherIce(peer);
      if(revision!==generation.current)return;
      const description=peer.localDescription;
      if(!description?.sdp)throw new Error("Браузер не создал голосовое соединение.");
      pendingCallIdRef.current=callId;
      const saved=await api<Signal>(endpoint,{method:"POST",body:JSON.stringify({action:role==="supervisor"?"offer":"answer",callId,description:{type:description.type,sdp:description.sdp}})});
      if(revision!==generation.current){void api(endpoint,{method:"POST",body:JSON.stringify({action:"end",callId}),keepalive:true}).catch(()=>{});return;}
      callIdRef.current=callId;pendingCallIdRef.current=null;setSignal(saved);
      if(peer.connectionState!=="connected")setState(role==="supervisor"?"ringing":"connecting");
      timeoutRef.current=setTimeout(()=>{if(revision===generation.current&&peer.connectionState!=="connected"){setError("Собеседник не подключился или сеть не пропускает голос. Можно повторить звонок либо продолжить в чате.");end();}},55_000);
    }catch(err){if(revision===generation.current){end();setError(err instanceof DOMException&&err.name==="NotAllowedError"?"Разрешите доступ к микрофону, чтобы говорить с собеседником.":readableError(err));}}
    finally{if(revision===generation.current)starting.current=false;}
  }

  const inProgress=state==="microphone"||state==="connecting"||state==="ringing"||state==="connected";
  const canJoin=enabled&&(role==="supervisor"?signal?.canOffer:signal?.status==="offered");
  const status=state==="connected"?"Голосовое соединение установлено":state==="microphone"?"Разрешите микрофон…":state==="connecting"?"Соединяем микрофоны…":state==="ringing"?"Ждём, пока клиент примет звонок":!enabled?"Ожидаем подключения оператора":role==="participant"&&signal?.status==="offered"?"Оператор приглашает вас в голосовой разговор":role==="supervisor"?"Начните голосовое подключение к клиенту":"Оператор подключён к обращению. Ожидаем голосовой звонок.";
  return <section className={styles.panel} aria-label="Голос с оператором"><div className={styles.heading}><Headphones size={18}/><span>Разговор с {role==="supervisor"?"клиентом":"оператором"}</span><i className={`${styles.dot} ${state==="connected"?styles.connected:""}`}/></div><p className={styles.status} role="status">{status}</p><div className={styles.actions}>{!inProgress?<button className={styles.primary} disabled={!canJoin} onClick={()=>void start()}><Phone size={16}/>{role==="supervisor"?"Позвонить клиенту":"Принять звонок"}</button>:<><button onClick={()=>{const next=!muted;streamRef.current?.getAudioTracks().forEach(track=>{track.enabled=!next;});setMuted(next);}} disabled={!streamRef.current}>{muted?<MicOff size={16}/>:<Mic size={16}/>} {muted?"Включить микрофон":"Выключить микрофон"}</button><button className={styles.end} onClick={()=>end()}><PhoneOff size={16}/>Завершить звонок</button></>}{playBlocked&&<button onClick={()=>void audioRef.current?.play().then(()=>setPlayBlocked(false)).catch(()=>setError("Нажмите воспроизведение в плеере ниже."))}><Volume2 size={16}/>Включить звук</button>}</div>{!inProgress&&signal?.canEnd&&signal.callId&&<div className={styles.actions}><button onClick={()=>{callIdRef.current=signal.callId;end();}}>Сбросить прошлое голосовое соединение</button></div>}<audio className={styles.audio} ref={audioRef} autoPlay controls playsInline aria-label="Голос собеседника" hidden={!inProgress}/>{error&&<p className={styles.error} role="alert">{error}</p>}<p className={styles.foot}>Микрофон включается по нажатию. Голос не записывается; текстовая история сохраняется.</p></section>;
}
