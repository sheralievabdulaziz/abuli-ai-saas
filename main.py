import os
import json
import httpx
from google import genai
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from livekit.api import AccessToken, VideoGrants
from dotenv import load_dotenv
from pydantic import BaseModel
from fastapi.responses import FileResponse
from fpdf import FPDF
from supabase import create_client, Client
from pydantic import BaseModel
from livekit import api

class ChatRequest(BaseModel):
    soru: str

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
supabase_client: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

app = FastAPI(title="AI Zoom Clone Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_KEY = os.getenv("LIVEKIT_API_KEY")
API_SECRET = os.getenv("LIVEKIT_API_SECRET")
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

gemini_client = genai.Client(api_key=GEMINI_API_KEY)

@app.post("/ask-abuli")
async def ask_abuli(request: ChatRequest):
    try:
        response = supabase_client.table("toplantilar").select("created_at, oda_adi, ozet_json").order("created_at", desc=True).limit(30).execute()
        
        gecmis_toplantilar = [t for t in response.data if t.get("ozet_json") is not None]

        if not gecmis_toplantilar:
            return {"cevap": "Henüz veritabanında özetlenmiş bir toplantı bulunmuyor."}

        veritabani_metni = "Geçmiş Toplantı Kayıtları:\n"
        for t in gecmis_toplantilar:
            tarih = t["created_at"][:10]
            ozet_data = t["ozet_json"]
            veritabani_metni += f"- Tarih: {tarih}, Oda: {t['oda_adi']}, Özet: {ozet_data.get('ozet', '')}\n"
            veritabani_metni += f"  Kararlar: {', '.join(ozet_data.get('kararlar', []))}\n"

        prompt = f"""
        Sen Abuli-ai isimli zeki bir toplantı asistanısın. 
        Kullanıcı sana geçmiş toplantılarıyla ilgili bir soru soruyor. 
        Aşağıdaki 'Geçmiş Toplantı Kayıtları' verisini kullanarak kullanıcının sorusuna net, kibar ve profesyonel bir Türkçe ile cevap ver. 
        Eğer sorunun cevabı kayıtlarda yoksa, "Bu konuda bir kayıt bulamadım" de ve kesinlikle uydurma.

        {veritabani_metni}

        Kullanıcının Sorusu: {request.soru}
        """

        chat = gemini_client.chats.create(model="gemini-3.8-flash")
        ai_response = chat.send_message(prompt)
        
        return {"cevap": ai_response.text}

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"cevap": f"Bir hata oluştu: {str(e)}"}


class AccessRequest(BaseModel):
    oda_adi: str
    katilimci_adi: str

@app.post("/request-access")
async def request_access(req: AccessRequest):
    response = supabase_client.table("bekleme_odasi").insert({
        "oda_adi": req.oda_adi,
        "katilimci_adi": req.katilimci_adi,
        "durum": "bekliyor"
    }).execute()
    
    return {"mesaj": "İstek gönderildi", "request_id": response.data[0]["id"]}

class ApproveRequest(BaseModel):
    request_id: str
    oda_adi: str
    katilimci_adi: str

@app.post("/approve-access")
async def approve_access(req: ApproveRequest):
    token = api.AccessToken(os.environ.get("LIVEKIT_API_KEY"), os.environ.get("LIVEKIT_API_SECRET")) \
        .with_identity(req.katilimci_adi) \
        .with_name(req.katilimci_adi) \
        .with_grants(api.VideoGrants(room_join=True, room=req.oda_adi)) \
        .to_jwt()
    
    supabase_client.table("bekleme_odasi").update({
        "durum": "onaylandi",
        "token": token
    }).eq("id", req.request_id).execute()
    
    return {"mesaj": "Onaylandı"}
class SummaryRequest(BaseModel):
    filename: str = "ornek_toplanti.wav"

@app.post("/generate-summary")
async def generate_summary(request: SummaryRequest):
    try:
        if not os.path.exists(request.filename):
            raise HTTPException(status_code=404, detail=f"'{request.filename}' bulunamadı!")

        with open(request.filename, "rb") as audio_file:
            audio_data = audio_file.read()

        headers = {
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": "audio/wav"
        }
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            dg_response = await client.post(
                "https://api.deepgram.com/v1/listen?model=nova-2&language=tr&punctuate=true",
                headers=headers,
                content=audio_data
            )
        
        dg_json = dg_response.json()
        
        try:
            transcript = dg_json["results"]["channels"][0]["alternatives"][0]["transcript"]
        except (KeyError, IndexError):
            return {"hata": "Metin çıkarılamadı.", "detay": dg_json}

        if not transcript or transcript.strip() == "":
             return {"hata": "Konuşma algılanamadı."}

        prompt = f"""
        Aşağıdaki toplantı transkriptini analiz et ve bana kesinlikle JSON formatında şu yapıya uygun bir çıktı ver:
        {{
           "ozet": "Toplantının 2-3 cümlelik genel özeti",
           "kararlar": ["Karar 1", "Karar 2"],
           "gorevler": ["Kişi A'ya şu görev verildi", "Kişi B şunu yapacak"]
        }}
        
        Sadece JSON nesnesini döndür.
        
        Toplantı Metni:
        {transcript}
        """
        
        chat = gemini_client.chats.create(model="gemini-3.8-flash")
        ai_response = chat.send_message(prompt)
        
        response_text = ai_response.text.strip()
        if response_text.startswith("```json"):
            response_text = response_text[7:]
        if response_text.startswith("```"):
            response_text = response_text[3:]
        if response_text.endswith("```"):
            response_text = response_text[:-3]
            
        summary_data = json.loads(response_text.strip())
        
        return {
            "orijinal_metin": transcript,
            "ai_ozeti": summary_data
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/generate-summary-from-latest")
async def generate_summary_from_latest():
    try:
        response = supabase_client.table("toplantilar").select("*").order("created_at", desc=True).limit(1).execute()
        
        if not response.data:
            raise HTTPException(status_code=404, detail="Henüz veritabanında kayıtlı bir toplantı yok.")
            
        son_toplanti = response.data[0]
        toplanti_id = son_toplanti["id"]
        transcript = son_toplanti["transkript_metni"]
        
        # Eğer bu toplantının özeti zaten çıkarılmışsa, Gemini'ye tekrar gidip zaman harcamadan doğrudan veritabanındaki hazır özeti gönderme
        if son_toplanti.get("ozet_json"):
            print("Özet zaten veritabanında mevcut, hızlıca getiriliyor...")
            return {"ai_ozeti": son_toplanti["ozet_json"]}

        print("Özet veritabanında yok, Gemini'ye soruluyor...")
        prompt = f"""
        Aşağıdaki toplantı transkriptini analiz et ve bana kesinlikle JSON formatında şu yapıya uygun bir çıktı ver:
        {{
           "ozet": "Toplantının 2-3 cümlelik genel özeti",
           "kararlar": ["Karar 1", "Karar 2"],
           "gorevler": ["Kişi A'ya şu görev verildi", "Kişi B şunu yapacak"]
        }}
        
        Sadece JSON nesnesini döndür.
        
        Toplantı Metni:
        {transcript}
        """
        
        ai_response = gemini_client.models.generate_content(
            model="gemini-3.8-flash",
            contents=prompt
        )
        
        response_text = ai_response.text.strip()
        if response_text.startswith("```json"):
            response_text = response_text[7:]
        if response_text.startswith("```"):
            response_text = response_text[3:]
        if response_text.endswith("```"):
            response_text = response_text[:-3]
            
        summary_data = json.loads(response_text.strip())
        
        supabase_client.table("toplantilar").update({"ozet_json": summary_data}).eq("id", toplanti_id).execute()
        
        return {
            "ai_ozeti": summary_data
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    
class TextSummaryRequest(BaseModel):
    transcript_text: str

@app.post("/generate-summary-from-text")
async def generate_summary_from_text(request: TextSummaryRequest):
    try:
        if not request.transcript_text or request.transcript_text.strip() == "":
            raise HTTPException(status_code=400, detail="Transkript metni boş olamaz!")

        prompt = f"""
        Aşağıdaki toplantı transkriptini analiz et ve bana kesinlikle JSON formatında şu yapıya uygun bir çıktı ver:
        {{
           "ozet": "Toplantının 2-3 cümlelik genel özeti",
           "kararlar": ["Karar 1", "Karar 2"],
           "gorevler": ["Kişi A'ya şu görev verildi", "Kişi B şunu yapacak"]
        }}
        
        Sadece JSON nesnesini döndür.
        
        Toplantı Metni:
        {request.transcript_text}
        """
        
        ai_response = gemini_client.models.generate_content(
            model="gemini-3.8-flash",
            contents=prompt
        )
        
        response_text = ai_response.text.strip()
        if response_text.startswith("```json"):
            response_text = response_text[7:]
        if response_text.startswith("```"):
            response_text = response_text[3:]
        if response_text.endswith("```"):
            response_text = response_text[:-3]
            
        summary_data = json.loads(response_text.strip())
        
        return {
            "ai_ozeti": summary_data
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/")
def read_root():
    return {"mesaj": "AI Zoom Backend Çalışıyor."}

@app.get("/get-token")
def get_livekit_token(room_name: str, participant_name: str):
    if not API_KEY or not API_SECRET:
        raise HTTPException(status_code=500, detail="LiveKit API anahtarları eksik!")
    try:
        grant = VideoGrants(room_join=True, room=room_name)
        access_token = AccessToken(API_KEY, API_SECRET).with_grants(grant).with_identity(participant_name).with_name(participant_name)
        return {"oda_adi": room_name, "katilimci": participant_name, "token": access_token.to_jwt()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class PDFRequest(BaseModel):
    ozet: str
    kararlar: list[str]
    gorevler: list[str]

@app.post("/export-pdf")
async def export_pdf(request: PDFRequest):
    try:
        pdf = FPDF()
        pdf.add_page()
        
        def clean_tr(text):
            tr_map = str.maketrans("şŞğĞıİöÖüÜçÇ", "sSgGiIoOuUcC")
            return str(text).translate(tr_map)

        pdf.set_font("Helvetica", size=16, style="B")
        pdf.cell(200, 10, txt="Toplanti Ozeti Raporu", ln=True, align='C')
        pdf.ln(10)
        
        pdf.set_font("Helvetica", size=14, style="B")
        pdf.cell(200, 10, txt="Genel Bakis:", ln=True)
        pdf.set_font("Helvetica", size=12)
        pdf.multi_cell(0, 10, txt=clean_tr(request.ozet))
        pdf.ln(5)
        
        pdf.set_font("Helvetica", size=14, style="B")
        pdf.cell(200, 10, txt="Alinan Kararlar:", ln=True)
        pdf.set_font("Helvetica", size=12)
        for karar in request.kararlar:
            pdf.multi_cell(0, 8, txt=f"- {clean_tr(karar)}")
        pdf.ln(5)
        
        pdf.set_font("Helvetica", size=14, style="B")
        pdf.cell(200, 10, txt="Aksiyon Maddeleri (Gorevler):", ln=True)
        pdf.set_font("Helvetica", size=12)
        for gorev in request.gorevler:
            pdf.multi_cell(0, 8, txt=f"- {clean_tr(gorev)}")

        pdf_path = "toplanti_raporu.pdf"
        pdf.output(pdf_path)
        
        return FileResponse(pdf_path, media_type="application/pdf", filename="Toplanti_Raporu.pdf")
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))