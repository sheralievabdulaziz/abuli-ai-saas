"use client";
import { useState, useEffect, Suspense } from "react";
import { supabase } from "@/supabaseClient";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoConference,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { useSearchParams } from 'next/navigation';

function AnaUygulama() {
  const searchParams = useSearchParams();
  const urlRoomName = searchParams.get("room") || "";

  const [session, setSession] = useState<any>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLogin, setIsLogin] = useState(true);

  const [roomName, setRoomName] = useState(urlRoomName);
  const [participantName, setParticipantName] = useState("");
  const [token, setToken] = useState("");
  
  const [summary, setSummary] = useState<any>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);

  const [chatQuery, setChatQuery] = useState("");
  const [chatResponse, setChatResponse] = useState("");
  const [isAsking, setIsAsking] = useState(false);

  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [isWaitingForApproval, setIsWaitingForApproval] = useState(false);
  const [myRequestId, setMyRequestId] = useState<string | null>(null);

  const [isHost, setIsHost] = useState(false);

  const [hasLeft, setHasLeft] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!myRequestId) return;
    
    const channel = supabase
      .channel('guest_wait')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bekleme_odasi', filter: `id=eq.${myRequestId}` },
        (payload) => {
          if (payload.new.durum === 'onaylandi' && payload.new.token) {
            setToken(payload.new.token);
            setIsWaitingForApproval(false);
          } else if (payload.new.durum === 'reddedildi') {
            alert("Toplantı sahibi katılım isteğinizi reddetti.");
            setIsWaitingForApproval(false);
          }
        }
      ).subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [myRequestId]);

  useEffect(() => {
    if (!token) return; 

    const fetchPending = async () => {
       const { data } = await supabase.from('bekleme_odasi').select('*').eq('oda_adi', roomName).eq('durum', 'bekliyor');
       if (data) setPendingRequests(data);
    };
    fetchPending();

    const channel = supabase
      .channel('host_listen')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bekleme_odasi', filter: `oda_adi=eq.${roomName}` },
        (payload) => setPendingRequests((prev) => [...prev, payload.new])
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bekleme_odasi', filter: `oda_adi=eq.${roomName}` },
        (payload) => {
          if (payload.new.durum !== 'bekliyor') {
            setPendingRequests((prev) => prev.filter(r => r.id !== payload.new.id));
          }
        }
      ).subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [token, roomName]);

  const handleAuth = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (isLogin) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) alert(error.message);
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) alert(error.message);
      else alert("Kayıt başarılı. Giriş yapabilirsiniz.");
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const joinAsGuest = async () => {
    setIsWaitingForApproval(true);
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/request-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oda_adi: roomName, katilimci_adi: participantName })
    });
    const data = await res.json();
    setMyRequestId(data.request_id);
  };

  const joinAsHost = async () => {
    const password = prompt("Odayı başlatmak için Admin şifresini girin:");
    
    if (password !== "abuli2026") {
      alert("Hatalı şifre! Sadece admin toplantı başlatabilir.");
      return;
    }

    setIsHost(true);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/get-token?room_name=${roomName}&participant_name=${participantName}`
      );
      const data = await response.json();
      setToken(data.token);
    } catch (error) {
      console.error("Sunucu hatası:", error);
      alert("Toplantı başlatılamadı, lütfen sunucu bağlantısını kontrol edin.");
    }
  };

  const approveAccess = async (requestId: string, guestName: string) => {
    await fetch(`${process.env.NEXT_PUBLIC_API_URL}/approve-access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, oda_adi: roomName, katilimci_adi: guestName })
    });
  };

  const rejectAccess = async (requestId: string) => {
    await supabase.from('bekleme_odasi').update({ durum: 'reddedildi' }).eq('id', requestId);
  };

  const fetchSummary = async () => {
    setIsSummarizing(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/generate-summary-from-latest`, {
        method: "POST"
      });
          
      if (!response.ok) {
        alert("Henüz özet hazır değil veya toplantı bitmedi.");
        setIsSummarizing(false);
        return;
      }

      const data = await response.json();
      setSummary(data.ai_ozeti);
    } catch (error) {
      console.error("Özet alınırken hata oluştu:", error);
      alert("Özet alınamadı. Arka plan sunucusunu kontrol edin.");
    }
    setIsSummarizing(false);
  };

  const handleDisconnect = () => {
    setToken("");
    setIsHost(false);
    setHasLeft(true);
  };

  const copyInviteLink = () => {
    const inviteUrl = `${window.location.origin}/?room=${roomName}`;
    navigator.clipboard.writeText(inviteUrl);
    alert(`Davet linki kopyalandı:\n${inviteUrl}`);
  };

  const downloadPDF = async () => {
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/export-pdf`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(summary),
      });
      
      if (!response.ok) {
        alert("PDF oluşturulamadı!");
        return;
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Toplanti_Raporu.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (error) {
      console.error("PDF indirilirken hata oluştu:", error);
      alert("PDF indirilemedi.");
    }
  };

  const askAbuli = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!chatQuery.trim()) return;
    
    setIsAsking(true);
    setChatResponse("Abuli-ai geçmiş toplantılarınızı inceliyor...");

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/ask-abuli`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soru: chatQuery }),
      });
      const data = await response.json();
      setChatResponse(data.cevap);
    } catch (error) {
      setChatResponse("Bağlantı hatası oluştu. Sunucuyu kontrol edin.");
    }
    setIsAsking(false);
  };

  if (!session && !urlRoomName) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <form onSubmit={handleAuth} className="bg-gray-800 p-8 rounded-lg shadow-xl w-96">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-extrabold tracking-tight text-white mb-2">
              Abuli<span className="text-blue-500">-ai</span>
            </h1>
            <p className="text-gray-400 text-sm font-medium tracking-wide">
              {isLogin ? "Hesabınıza giriş yapın" : "Yeni bir hesap oluşturun"}
            </p>
          </div>
          <input
            type="email"
            placeholder="E-posta"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full mb-4 p-3 bg-gray-700 rounded outline-none"
            required
          />
          <input
            type="password"
            placeholder="Şifre"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full mb-6 p-3 bg-gray-700 rounded outline-none"
            required
          />
          <button type="submit" className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded font-bold transition">
            {isLogin ? "Giriş Yap" : "Kayıt Ol"}
          </button>
          
          <p className="mt-4 text-center text-sm text-gray-400">
            {isLogin ? "Hesabınız yok mu? " : "Zaten hesabınız var mı? "}
            <button type="button" onClick={() => setIsLogin(!isLogin)} className="text-blue-400 underline">
              {isLogin ? "Kayıt Ol" : "Giriş Yap"}
            </button>
          </p>
        </form>
      </div>
    );
  }

  if (isWaitingForApproval) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mb-4"></div>
        <h2 className="text-xl font-bold">Toplantı sahibinin onayı bekleniyor...</h2>
        <p className="text-gray-400 mt-2">Lütfen ekrandan ayrılmayın.</p>
      </div>
    );
  }

  if (hasLeft) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white p-4">
        <div className="bg-gray-800 p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 text-center border border-gray-700 max-w-sm w-full">
          
          <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mb-2">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
            </svg>
          </div>
          
          <h2 className="text-2xl font-bold text-white">Toplantıdan Ayrıldınız</h2>
          
          <button 
            onClick={() => { 
              setHasLeft(false); 
              setRoomName(""); 
              setParticipantName(""); 
            }} 
            className="mt-4 bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-6 rounded-lg transition-all shadow-lg w-full"
          >
            Ana Sayfaya Dön
          </button>
          
        </div>
      </div>
    );
  }

  if (token === "") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white p-4">
        <div className="bg-gray-800 p-8 rounded-2xl shadow-2xl flex flex-col gap-5 w-full max-w-sm border border-gray-700">
          
          <div className="text-center mb-2">
            <h1 className="text-2xl font-extrabold tracking-tight text-white">
              AI Destekli Toplantı
            </h1>
            <p className="text-gray-400 text-sm mt-2">Odaya katılmak için bilgileri girin</p>
          </div>
          
          <input 
            type="text" 
            placeholder="Oda Adı" 
            className="w-full bg-gray-900 border border-gray-600 text-white placeholder-gray-400 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" 
            value={roomName} 
            onChange={(e) => setRoomName(e.target.value)} 
          />
          
          <input 
            type="text" 
            placeholder="Adınız" 
            className="w-full bg-gray-900 border border-gray-600 text-white placeholder-gray-400 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" 
            value={participantName} 
            onChange={(e) => setParticipantName(e.target.value)} 
          />
          
          <div className="flex gap-3 mt-2">
            <button 
              onClick={joinAsHost} 
              className="flex-1 bg-green-600 hover:bg-green-500 text-white font-bold py-3 px-2 rounded-lg text-sm transition-all shadow-lg hover:shadow-green-500/30"
            >
              Sahip Olarak Gir
            </button>
            <button 
              onClick={joinAsGuest} 
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-2 rounded-lg text-sm transition-all shadow-lg hover:shadow-blue-500/30"
            >
              Misafir Olarak Katıl
            </button>
          </div>

        </div>
      </div>
    );
  }

    return (
      <div className="flex flex-col h-screen bg-gray-950">
        <div className="p-4 bg-gray-900 flex justify-end gap-4 border-b border-gray-800 shadow-md z-10">
        
          {isHost && (
          <button 
            onClick={copyInviteLink}
            className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-6 rounded-lg transition-colors flex items-center gap-2"
          >
            🔗 Davet Linkini Kopyala
          </button>
          )}

          <button 
            onClick={fetchSummary}
            disabled={isSummarizing}
            className="bg-green-600 hover:bg-green-500 disabled:bg-gray-500 text-white font-bold py-2 px-6 rounded-lg transition-colors"
          >
            {isSummarizing ? "Gemini Özeti Hazırlıyor..." : "Toplantı Özetini Çıkar"}
          </button>
        </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-grow relative border-r border-gray-700">
          <LiveKitRoom
            video={true}
            audio={true}
            token={token}
            serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL}
            data-lk-theme="default"
            style={{ height: '100%', width: '100%' }}
            onDisconnected={handleDisconnect}
          >
            <VideoConference />
            <RoomAudioRenderer />
          </LiveKitRoom>
        </div>

        <div className="w-[400px] bg-gray-800 flex flex-col shadow-2xl z-10 overflow-y-auto text-white">
          
          {pendingRequests.length > 0 && (
            <div className="m-5 bg-orange-900 p-4 rounded-lg border border-orange-700 shadow-lg">
              <h3 className="text-md font-bold text-orange-400 mb-3 flex items-center gap-2">
                Kapıda Bekleyenler ({pendingRequests.length})
              </h3>
              <ul className="space-y-3">
                {pendingRequests.map((req) => (
                  <li key={req.id} className="flex items-center justify-between text-sm text-white bg-orange-950 p-2 rounded">
                    <span className="font-semibold">{req.katilimci_adi}</span>
                    <div className="flex gap-2">
                      <button onClick={() => approveAccess(req.id, req.katilimci_adi)} className="bg-green-600 px-3 py-1 rounded hover:bg-green-500 font-bold transition">Al</button>
                      <button onClick={() => rejectAccess(req.id)} className="bg-red-600 px-3 py-1 rounded hover:bg-red-500 font-bold transition">Reddet</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="p-5 border-b border-gray-700 bg-gray-850 shrink-0">
            <h3 className="text-lg font-bold text-blue-400 mb-3 flex items-center gap-2">
              Abuli-ai Geçmişi Tara
            </h3>
            <form onSubmit={askAbuli} className="flex flex-col gap-2">
              <input
                type="text"
                placeholder="Örn: Geçen haftaki toplantı kararları nelerdi?"
                className="w-full border border-gray-600 bg-gray-900 p-3 text-sm rounded-lg text-white outline-none focus:border-blue-500 transition-colors"
                value={chatQuery}
                onChange={(e) => setChatQuery(e.target.value)}
              />
              <button 
                type="submit" 
                disabled={isAsking}
                className="w-full bg-purple-600 hover:bg-purple-500 disabled:bg-gray-600 text-white font-bold py-2 px-4 rounded-lg transition-colors text-sm"
              >
                {isAsking ? "Aranıyor..." : "Geçmişte Ara"}
              </button>
            </form>
            
            {chatResponse && (
              <div className="mt-3 bg-gray-900 p-3 rounded-lg border border-gray-700 text-gray-300 leading-relaxed text-sm overflow-y-auto max-h-48 custom-scrollbar">
                {chatResponse}
              </div>
            )}
          </div>

          <div className="p-5">
            {summary ? (
              <>
                <h2 className="text-xl font-bold mb-5 flex items-center gap-2">
                  Toplantı Özeti
                </h2>
                
                <div className="mb-5">
                  <h3 className="text-md font-semibold text-blue-400 mb-2 border-b border-gray-700 pb-1">Genel Bakış</h3>
                  <p className="text-gray-300 leading-relaxed text-sm">{summary.ozet}</p>
                </div>

                <div className="mb-5">
                  <h3 className="text-md font-semibold text-green-400 mb-2 border-b border-gray-700 pb-1">Alınan Kararlar</h3>
                  <ul className="list-disc pl-5 text-gray-300 space-y-1 text-sm">
                    {summary.kararlar.map((karar: string, index: number) => (
                      <li key={index}>{karar}</li>
                    ))}
                  </ul>
                </div>

                <div className="mb-6">
                  <h3 className="text-md font-semibold text-orange-400 mb-2 border-b border-gray-700 pb-1">Görevler</h3>
                  <ul className="list-disc pl-5 text-gray-300 space-y-1 text-sm">
                    {summary.gorevler.map((gorev: string, index: number) => (
                      <li key={index}>{gorev}</li>
                    ))}
                  </ul>
                </div>

                <div className="flex flex-col gap-3 mt-auto">
                  <button 
                    onClick={downloadPDF}
                    className="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-2.5 px-4 rounded-lg shadow-lg flex items-center justify-center gap-2 transition-all hover:scale-105 text-sm"
                  >
                    📄 PDF İndir
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center text-gray-500 opacity-70 mt-10">
                <svg className="w-12 h-12 mb-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                </svg>
                <p className="text-sm">Şu anki toplantının özeti henüz çıkarılmadı.</p>
                <p className="text-xs mt-2">Sağ üstteki yeşil butona basarak oluşturabilirsiniz.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">Yükleniyor...</div>}>
      <AnaUygulama />
    </Suspense>
  );
}