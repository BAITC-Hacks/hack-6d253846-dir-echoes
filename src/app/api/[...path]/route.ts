import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, checkOrigin, errorResponse, requireViewer, signIn, signOut, viewer } from "@/lib/auth";
import { getDataset } from "@/lib/dataset";
import { consumeLimit, query } from "@/lib/db";
import { initialState } from "@/lib/domain";
import { processTurn } from "@/lib/conversation";
import { transcribeAudio, synthesizeSpeech } from "@/lib/ai";
import { getBudgetStatus } from "@/lib/budget";
import { streamAndCacheAudio } from "@/lib/speech-stream";
import { getSupervision, saveReview, saveCatalogRevision, catalogPatchSchema } from "@/lib/supervision";
import { getSessionDetail, listHandoffs, listSessions, redact, sessionRow, stats } from "@/lib/repository";
import { updateHandoff } from "@/lib/handoffs";

export const runtime="nodejs";
export const maxDuration=60;
export const dynamic="force-dynamic";
type Context={params:Promise<{path:string[]}>};
const noStore={"Cache-Control":"no-store"};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:noStore});
async function body<T>(request:Request,schema:z.ZodType<T>):Promise<T>{
  if(Number(request.headers.get("content-length")||0)>20_000) throw new ApiError(413,"Слишком большой запрос.");
  const text=await request.text(); if(text.length>20_000) throw new ApiError(413,"Слишком большой запрос.");
  try { return schema.parse(JSON.parse(text)); } catch { throw new ApiError(400,"Проверьте поля запроса."); }
}
async function handle(request:Request,context:Context):Promise<Response>{
  const {path}=await context.params; const method=request.method;
  if(method!=="GET") checkOrigin(request);
  if(path.join("/")==="health" && method==="GET") return json({status:"ok",service:"DIR ECHOES Voice Router",version:"0.1.0"});
  if(path[0]==="auth"){
    if(method==="GET"){const user=await viewer();return json({authenticated:Boolean(user),role:user?.role??null});}
    if(method==="DELETE"){await signOut();return json({ok:true});}
    if(method==="POST"){
      const remote=request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"local";
      const ipKey=createHash("sha256").update(remote).digest("hex").slice(0,24);
      if(!await consumeLimit(`login:${ipKey}`,12,900)) throw new ApiError(429,"Слишком много попыток входа. Повторите через 15 минут.");
      const data=await body(request,z.object({code:z.string().min(1).max(200),role:z.enum(["participant","supervisor"])}));
      const user=await signIn(data.code,data.role); return json({ok:true,role:user.role});
    }
  }
  const user=await requireViewer();
  if(path[0]==="supervision" && path.length===1 && method==="GET") {
    await requireViewer("supervisor");
    return json(await getSupervision(user,await getDataset()));
  }
  if(path[0]==="reviews" && path.length===1 && method==="POST") {
    await requireViewer("supervisor");
    const data=await body(request,z.object({turnId:z.string().min(1).max(100),expectedScenario:z.string().min(1).max(50),note:z.string().trim().max(1500).optional()}));
    return json({review:await saveReview({...data,viewer:user,dataset:await getDataset()})});
  }
  if(path[0]==="catalog" && path[1] && path.length===2 && method==="PATCH") {
    await requireViewer("supervisor");
    const data=await body(request,z.object({expectedHash:z.string().length(64),patch:catalogPatchSchema}));
    if(!await consumeLimit(`catalog:${user.id}`,30,3600)) throw new ApiError(429,"Достигнут часовой лимит правок каталога.");
    return json({revision:await saveCatalogRevision({...data,scenarioId:path[1],viewer:user,dataset:await getDataset()})});
  }
  if(path[0]==="bootstrap" && method==="GET"){
    const dataset=await getDataset();
    const [sessions,handoffs,metrics,budget]=await Promise.all([listSessions(user),listHandoffs(user),stats(user),user.role==="supervisor"?getBudgetStatus():Promise.resolve(null)]);
    return json(redact({viewer:{role:user.role},stats:metrics,budget,catalog:dataset.scenarios,sessions,handoffs,businessDate:dataset.businessDate,configured:{database:true,ai:Boolean(process.env.OPENAI_API_KEY)},datasetHash:dataset.hash}));
  }
  if(path[0]==="sessions"){
    const id=path[1];
    if(!id && method==="GET") return json(redact(await listSessions(user)));
    if(!id && method==="POST"){
      await getDataset();
      if(!await consumeLimit(`sessions:${user.id}`,20,3600)) throw new ApiError(429,"Достигнут часовой лимит новых разговоров.");
      const newId=randomUUID(); await query("INSERT INTO sessions(id,owner_id,title,state) VALUES($1,$2,'Новый разговор',$3::jsonb)",[newId,user.id,JSON.stringify(initialState())]);
      return json(await getSessionDetail(newId,user),201);
    }
    if(id && path.length===2 && method==="GET") return json(redact(await getSessionDetail(id,user)));
    if(id && path[2]==="export" && method==="GET"){
      const detail=redact(await getSessionDetail(id,user));
      return new Response(JSON.stringify({exportedAt:new Date().toISOString(),...detail},null,2),{headers:{...noStore,"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="echoes-${id}.json"`}});
    }
    if(id && path[2]==="turn" && method==="POST"){
      const data=await body(request,z.object({text:z.string().trim().min(1).max(3000),requestId:z.string().min(8).max(100),mode:z.enum(["text","voice"]).default("text"),sttMs:z.number().finite().min(0).max(120000).optional()}));
      return json(redact(await processTurn(id,user,data)));
    }
    if(id && path[2]==="metrics" && method==="POST"){
      await sessionRow(id,user);
      const data=await body(request,z.object({turnId:z.string(),playbackMs:z.number().finite().min(0).max(300000),ttsFirstByteMs:z.number().finite().min(0).max(120000).optional()}));
      await query("UPDATE turns SET trace=jsonb_set(trace,'{timings}',(trace->'timings') || $3::jsonb) WHERE session_id=$1 AND id=$2 AND status='completed'",[id,data.turnId,JSON.stringify({playback:data.playbackMs})]);
      return json({ok:true});
    }
  }
  if(path[0]==="transcribe" && method==="POST"){
    if(!await consumeLimit(`voice:${user.id}`,20,300)) throw new ApiError(429,"Слишком много голосовых запросов. Подождите немного.");
    if(Number(request.headers.get("content-length")||0)>3_500_000) throw new ApiError(413,"Запись слишком большая. Говорите не дольше 45 секунд.");
    const form=await request.formData(); const audio=form.get("audio");
    if(!(audio instanceof File)||audio.size<100||audio.size>3_000_000) throw new ApiError(400,"Нужна аудиозапись размером до 3 МБ.");
    if(!/^(audio\/(webm|mp4|mpeg|wav|x-wav)|video\/webm)(;|$)/i.test(audio.type)) throw new ApiError(400,"Этот аудиоформат не поддерживается.");
    return json(await transcribeAudio(audio));
  }
  if(path[0]==="speech" && method==="POST"){
    const data=await body(request,z.object({sessionId:z.string(),turnId:z.string()}));
    const detail=await getSessionDetail(data.sessionId,user); const turn=detail.turns.find(t=>t.id===data.turnId);
    if(!turn) throw new ApiError(404,"Ответ не найден.");
    const speechText=redact(turn.assistantText);
    const speechLanguage=turn.trace.responseLanguage || turn.trace.language;
    const textHash=createHash("sha256").update(speechText).update(JSON.stringify([process.env.TTS_MODEL||"gpt-4o-mini-tts","coral",speechLanguage,turn.trace.tone||"neutral"])).digest("hex");
    // Ownership was checked above. Identical saved answers may reuse the same audio;
    // text, voice, model, language and tone all participate in the content key.
    const readCached=()=>query<{data:Buffer;mime:string;first_byte_ms:number}>("SELECT data,mime,first_byte_ms FROM speech_audio WHERE text_hash=$1 LIMIT 1",[textHash]);
    const audioResponse=async(cached:{data:Buffer;mime:string;first_byte_ms:number})=>{
      await query("UPDATE turns SET trace=jsonb_set(trace,'{timings}',(trace->'timings') || CASE WHEN trace->'timings' ? 'ttsFirstByte' THEN '{}'::jsonb ELSE '{\"ttsFirstByte\":0,\"ttsCacheHit\":true}'::jsonb END || '{\"lastPlaybackCached\":true}'::jsonb) WHERE id=$1",[turn.id]);
      return new Response(new Uint8Array(cached.data),{headers:{...noStore,"Content-Type":cached.mime,"X-TTS-First-Byte-Ms":"0","X-Audio-Cached":"true","X-Audio-Delivery":"cached"}});
    };
    const cached=await readCached(); if(cached.rows[0]) return audioResponse(cached.rows[0]);
    if(!await consumeLimit(`tts:${user.id}`,30,300)) throw new ApiError(429,"Слишком много запросов озвучивания.");
    const leaseToken=randomUUID();
    const lease=await query("INSERT INTO speech_content_leases(text_hash,token,expires_at) VALUES($1,$2,now()+interval '60 seconds') ON CONFLICT(text_hash) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at WHERE speech_content_leases.expires_at<now() RETURNING token",[textHash,leaseToken]);
    if(!lease.rows.length) throw new ApiError(409,"Этот ответ уже озвучивается. Попробуйте воспроизвести его через несколько секунд.");
    let streaming=false;
    let source:ReadableStream<Uint8Array>|undefined;
    const release=async()=>{await query("DELETE FROM speech_content_leases WHERE text_hash=$1 AND token=$2",[textHash,leaseToken]);};
    try {
      const fresh=await readCached(); if(fresh.rows[0]) return audioResponse(fresh.rows[0]);
      const speech=await synthesizeSpeech(speechText,speechLanguage,turn.trace.tone,request.signal);
      const mime=speech.response.headers.get("content-type")||"audio/mpeg";
      if(!speech.response.body) throw new ApiError(502,"Аудиосервис не вернул поток ответа.");
      source=speech.response.body;
      await query("UPDATE turns SET trace=jsonb_set(trace,'{timings}',(trace->'timings') || CASE WHEN trace->'timings' ? 'ttsFirstByte' THEN '{}'::jsonb ELSE $2::jsonb END || '{\"lastPlaybackCached\":false}'::jsonb) WHERE id=$1",[turn.id,JSON.stringify({ttsFirstByte:Math.round(speech.firstByteMs),ttsCacheHit:false})]);
      const audioStream=streamAndCacheAudio({source:speech.response.body,release,save:async bytes=>{
        await query("INSERT INTO speech_audio(turn_id,text_hash,data,mime,first_byte_ms) VALUES($1,$2,$3,$4,$5) ON CONFLICT(turn_id) DO UPDATE SET text_hash=EXCLUDED.text_hash,data=EXCLUDED.data,mime=EXCLUDED.mime,first_byte_ms=EXCLUDED.first_byte_ms",[turn.id,textHash,Buffer.from(bytes),mime,Math.round(speech.firstByteMs)]);
      }});
      streaming=true;
      return new Response(audioStream,{headers:{...noStore,"Content-Type":mime,"X-TTS-First-Byte-Ms":String(Math.round(speech.firstByteMs)),"X-Audio-Delivery":"stream"}});
    } finally { if(!streaming) {await source?.cancel().catch(()=>{});await release();} }
  }
  if(path[0]==="handoffs" && path[1] && method==="PATCH"){
    await requireViewer("supervisor");
    const data=await body(request,z.object({status:z.enum(["active","closed"]),message:z.string().trim().max(2000).optional(),requestId:z.string().min(8).max(100)}));
    const handoff=await updateHandoff(path[1],user,data);
    return json({handoff:redact(handoff)});
  }
  throw new ApiError(404,"Маршрут не найден.");
}
async function guarded(request:Request,context:Context){try{return await handle(request,context);}catch(error){return errorResponse(error);}}
export {guarded as GET,guarded as POST,guarded as PATCH,guarded as DELETE};
