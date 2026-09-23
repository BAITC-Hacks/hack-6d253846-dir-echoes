/** Forward audio immediately while retaining a bounded copy for durable replay. */
export function streamAndCacheAudio(input: {
  source: ReadableStream<Uint8Array>;
  save: (bytes: Uint8Array) => Promise<void>;
  release: () => Promise<void>;
  maximumBytes?: number;
}): ReadableStream<Uint8Array> {
  const reader=input.source.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  let released=false;
  let cancelled=false;
  const release=async()=>{
    if(released) return;
    released=true;
    await input.release().catch(()=>console.error("Audio lease release failed"));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next=await reader.read();
        if(cancelled) return;
        if(next.done) {
          const bytes=new Uint8Array(size);
          let offset=0;
          for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
          await input.save(bytes).catch(()=>console.error("Complete audio could not be cached"));
          await release();
          if(cancelled) return;
          controller.close();
          return;
        }
        size+=next.value.byteLength;
        if(size>(input.maximumBytes??4_000_000)) throw new Error("Audio exceeds the response size limit");
        chunks.push(next.value);
        controller.enqueue(next.value);
      } catch(error) {
        await reader.cancel(error).catch(()=>{});
        await release();
        if(!cancelled) controller.error(error);
      }
    },
    async cancel(reason) { cancelled=true; await reader.cancel(reason).catch(()=>{}); await release(); },
  });
}
