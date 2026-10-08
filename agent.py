import os
import asyncio
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import AutoSubscribe, JobContext, JobRequest, WorkerOptions, cli, stt
from livekit.plugins import deepgram
import json
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

async def request_fnc(req: JobRequest) -> None:
    print(f"🤖 Bot için odaya katılma isteği geldi: {req.room.name}")
    await req.accept()

async def entrypoint(ctx: JobContext):
    print(f"Bot '{ctx.room.name}' odasına bağlanıyor...")
    
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    print("Bot odaya katıldı ve dinlemeye hazır!")

    toplanti_transkripti = []

    dg_stt = deepgram.STT(language="tr")

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, publication: rtc.TrackPublication, participant: rtc.RemoteParticipant):
       
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            print(f"[{participant.identity}] kullanıcısının mikrofonu dinleniyor...")
            
            audio_stream = rtc.AudioStream(track)
            stt_stream = dg_stt.stream()

            async def forward_audio():
                async for event in audio_stream:
                    stt_stream.push_frame(event.frame)

            async def receive_text():
                async for event in stt_stream:
                    if event.type == stt.SpeechEventType.FINAL_TRANSCRIPT:
                        metin = event.alternatives[0].text
                        if metin.strip():
                            satir = f"{participant.identity}: {metin}"
                            print(f"{satir}")
                            toplanti_transkripti.append(satir)

                            if len(toplanti_transkripti) % 3 == 0:
                                tam_metin = "\n".join(toplanti_transkripti)
                                
                                kontrol = supabase.table("toplantilar").select("id").eq("oda_adi", ctx.room.name).execute()
                                
                                if len(kontrol.data) > 0:
                                    supabase.table("toplantilar").update({"transkript_metni": tam_metin}).eq("oda_adi", ctx.room.name).execute()
                                else:
                                    veri = {"oda_adi": ctx.room.name, "transkript_metni": tam_metin}
                                    supabase.table("toplantilar").insert(veri).execute()
                                    
                                print(f"[{len(toplanti_transkripti)} cümle] Transkript anlık olarak Supabase'e eşitlendi.")

            asyncio.create_task(forward_audio())
            asyncio.create_task(receive_text())

    # Odadan biri ayrıldığında tetiklenir
    @ctx.room.on("participant_disconnected")
    def on_participant_disconnected(participant: rtc.RemoteParticipant):
        print(f"{participant.identity} odadan ayrıldı.")
            
        if len(ctx.room.remote_participants) == 0:
            print("Toplantı bitti! Transkript veritabanına kaydediliyor...")
                
            tam_metin = "\n".join(toplanti_transkripti)
             
            veri = {
                "oda_adi": ctx.room.name,
                "transkript_metni": tam_metin
            }
            supabase.table("toplantilar").insert(veri).execute()
                
            print("Transkript Supabase'e kaydedildi!")

            toplanti_transkripti.clear()
            asyncio.create_task(ctx.room.disconnect())
            print("Bot odadan ayrıldı ve bellek temizlendi.")

if __name__ == "__main__":
    cli.run_app(WorkerOptions(
        entrypoint_fnc=entrypoint,
        request_fnc=request_fnc
    ))