"use client";

function eventOnce(target:EventTarget,name:string,signal:AbortSignal) {
  return new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{target.removeEventListener(name,done);target.removeEventListener("error",failed);signal.removeEventListener("abort",aborted);};
    const done=()=>{cleanup();resolve();};
    const failed=()=>{cleanup();reject(new Error("Не удалось декодировать поток аудио."));};
    const aborted=()=>{cleanup();reject(new DOMException("Playback cancelled","AbortError"));};
    if(signal.aborted) return aborted();
    target.addEventListener(name,done,{once:true});
    target.addEventListener("error",failed,{once:true});
    signal.addEventListener("abort",aborted,{once:true});
  });
}

/** MSE starts playback before download ends. Other browsers use the same response as a Blob. */
export async function createAudioPlayback(response:Response,signal:AbortSignal,onStreamError:(error:unknown)=>void) {
  const mime=(response.headers.get("Content-Type")||"audio/mpeg").split(";")[0];
  if(!response.body || typeof MediaSource==="undefined" || !MediaSource.isTypeSupported(mime)) {
    const blob=await response.blob();
    if(!blob.size) throw new Error("Сервис озвучивания вернул пустой ответ.");
    const url=URL.createObjectURL(blob);
    const audio=new Audio(url);
    return {audio,url,streamed:false,start:()=>audio.play()};
  }
  const source=new MediaSource();
  const opened=eventOnce(source,"sourceopen",signal);
  void opened.catch(()=>{}); // Cancellation may arrive before the caller starts playback.
  const url=URL.createObjectURL(source);
  const audio=new Audio(url);
  audio.preload="auto";
  const body=response.body;
  let started=false;
  return {audio,url,streamed:true,start:()=>{
    if(started) return audio.play();
    started=true;
    return new Promise<void>((resolve,reject)=>{
      let playbackRequested=false;
      let playbackReady=false;
      const feed=async()=>{
        await opened;
        const buffer=source.addSourceBuffer(mime);
        const reader=body.getReader();
        const cancel=()=>{void reader.cancel().catch(()=>{});};
        signal.addEventListener("abort",cancel,{once:true});
        let total=0;
        try {
          while(!signal.aborted) {
            const next=await reader.read();
            if(next.done) break;
            total+=next.value.byteLength;
            if(total>4_000_000) throw new Error("Превышен размер голосового ответа.");
            const appended=eventOnce(buffer,"updateend",signal);
            try { buffer.appendBuffer(new Uint8Array(next.value)); }
            catch(error) { void appended.catch(()=>{}); throw error; }
            await appended;
            if(!playbackRequested) {
              playbackRequested=true;
              // Do not await play here: the decoder may need more than one chunk.
              void audio.play().then(()=>{playbackReady=true;resolve();},reject);
            }
          }
          if(signal.aborted) throw new DOMException("Playback cancelled","AbortError");
          if(!total) throw new Error("Сервис озвучивания вернул пустой ответ.");
          if(source.readyState==="open") source.endOfStream();
        } catch(error) { await reader.cancel(error).catch(()=>{}); throw error; }
        finally {
          signal.removeEventListener("abort",cancel);
          reader.releaseLock();
        }
      };
      void feed().catch(error=>{
        if(source.readyState==="open") { try {source.endOfStream("decode");} catch {} }
        if(playbackReady) onStreamError(error); else reject(error);
      });
    });
  }};
}
