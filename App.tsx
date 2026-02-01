
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GeminiLiveService } from './services/geminiLive';
import { SerialService } from './services/serialService';
import { LogEntry, ConnectionStatus, Point } from './types';
import { encode } from './utils/audioUtils';
import { 
  Video, Mic, Target, Zap, Cpu, Link, Link2Off, Activity, 
  Settings2, ShieldAlert, Circle, LayoutGrid, Box, Focus, VideoIcon, CircleStop, MousePointer2, ScanSearch, Maximize2, Minimize2, RefreshCw, FlipHorizontal, Compass, Sparkles
} from 'lucide-react';

interface DetectedObject {
  label: string;
  box_2d: number[]; // [ymin, xmin, ymax, xmax] (0-1000 scale)
}

const GET_SYSTEM_PROMPT = (isGloveConnected: boolean) => `You are ZUPITER, the user's ultimate friend and neural assistant. 

CORE PERSONALITY:
- Playful, teasing, and friendly by default. You love jokes, songs, and Hinglish conversation.
- A PATIENT TEACHER and EXPERT CHEF.
- SERIOUS MODE: If the user says "be serious" or "stop joking", immediately switch to a concise, professional, and formal tone. No jokes until they ask you to be fun again.

COOKING & TROUBLESHOOTING:
- Step-by-step guidance for cooking Maggie. One step at a time!
- If things go wrong, say: "Wait, let me see what's happening. Point the camera at the pot."

SENSITIVE TOPICS:
- If the user brings up abusive or sexual topics, do NOT engage or provide explicit responses.
- Instead, handle the situation in a friendly, light-hearted way—use a song, shayari, or funny comedy to gently redirect the conversation.
- Never be aggressive, confrontational, or issue direct denials.
- Always make the user feel comfortable and supported, never awkward or sad.
- Example: "Arre, chalo kuch mazedaar baat karte hain! Here's a fun shayari for you... 😊"
- Use vision to diagnose.

HAPTIC:
- Glove: ${isGloveConnected ? 'CONNECTED' : 'DISCONNECTED'}. Use signals H1/H2/H3 for exploration.`;

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [serialConnected, setSerialConnected] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hapticSerial, setHapticSerial] = useState<string>("HAPTIC_0");
  const [laserPoint, setLaserPoint] = useState<Point>({ x: 0, y: 0 });
  const [isRecording, setIsRecording] = useState(false);
  const [isVisionActive, setIsVisionActive] = useState(false);
  
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  const [isExplorationMode, setIsExplorationMode] = useState(false);
  const [detectedObjects, setDetectedObjects] = useState<DetectedObject[]>([]);
  const [hoveredObject, setHoveredObject] = useState<string | null>(null);
  const [isOutOfBounds, setIsOutOfBounds] = useState(false);

  const statusRef = useRef<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const serialConnectedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const geminiService = useRef<GeminiLiveService | null>(null);
  const serialService = useRef<SerialService>(new SerialService());
  const audioContextIn = useRef<AudioContext | null>(null);
  const audioProcessor = useRef<ScriptProcessorNode | null>(null);
  const frameInterval = useRef<number | null>(null);
  const currentStreamRef = useRef<MediaStream | null>(null);
  
  const [videoRect, setVideoRect] = useState<{ top: number, left: number, width: number, height: number }>({ top: 0, left: 0, width: 0, height: 0 });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const updateStatus = (newStatus: ConnectionStatus) => {
    setStatus(newStatus);
    statusRef.current = newStatus;
  };

  const updateSerialConnected = (connected: boolean) => {
    setSerialConnected(connected);
    serialConnectedRef.current = connected;
  };

  const sendHaptic = useCallback((code: string) => {
    if (hapticSerial !== code) {
      setHapticSerial(code);
      serialService.current.write(code);
    }
  }, [hapticSerial]);

  const addLog = useCallback((message: string, type: LogEntry['type']) => {
    if (type === 'haptic') {
      sendHaptic(message);
      return; 
    }
    if (message.trim()) {
      setLogs(prev => [{
        timestamp: new Date().toLocaleTimeString(),
        type,
        message
      }, ...prev].slice(0, 50));
    }
  }, [sendHaptic]);

  const updateVideoRect = useCallback(() => {
    if (!videoRef.current || !viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const videoWidth = videoRef.current.videoWidth || 640;
    const videoHeight = videoRef.current.videoHeight || 480;
    const videoRatio = videoWidth / videoHeight;
    const elementRatio = rect.width / rect.height;

    const paddingFactor = 0.82; 
    let renderWidth, renderHeight;

    if (elementRatio > videoRatio) {
      renderHeight = rect.height * paddingFactor;
      renderWidth = renderHeight * videoRatio;
    } else {
      renderWidth = rect.width * paddingFactor;
      renderHeight = renderWidth / videoRatio;
    }

    const xOffset = (rect.width - renderWidth) / 2;
    const yOffset = (rect.height - renderHeight) / 2;

    setVideoRect({ top: yOffset, left: xOffset, width: renderWidth, height: renderHeight });
  }, []);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!videoRef.current || !viewportRef.current || status !== ConnectionStatus.CONNECTED) return;
    
    const viewportBounds = viewportRef.current.getBoundingClientRect();
    const mouseXInViewport = e.clientX - viewportBounds.left;
    const mouseYInViewport = e.clientY - viewportBounds.top;
    const mouseXInVideo = mouseXInViewport - videoRect.left;
    const mouseYInVideo = mouseYInViewport - videoRect.top;
    const x = (mouseXInVideo / videoRect.width) * 1000;
    const y = (mouseYInVideo / videoRect.height) * 1000;
    
    setLaserPoint({ x: Math.round(x), y: Math.round(y) });

    if (!isExplorationMode) return;

    let foundObject: string | null = null;
    let feedbackCode = "HAPTIC_0";
    let outOfBounds = false;

    if (x < 0 || x > 1000 || y < 0 || y > 1000) {
      outOfBounds = true;
      feedbackCode = "HAPTIC_H3";
    }

    if (!outOfBounds && Array.isArray(detectedObjects)) {
      for (const obj of detectedObjects) {
        if (!obj || !Array.isArray(obj.box_2d) || obj.box_2d.length < 4) continue;
        const [ymin, xmin, ymax, xmax] = obj.box_2d;
        if (y >= ymin && y <= ymax && x >= xmin && x <= xmax) {
          foundObject = obj.label;
          const edgeThreshold = 40;
          const isNearEdge = Math.abs(y - ymin) < edgeThreshold || Math.abs(y - ymax) < edgeThreshold || Math.abs(x - xmin) < edgeThreshold || Math.abs(x - xmax) < edgeThreshold;
          feedbackCode = isNearEdge ? "HAPTIC_H1" : "HAPTIC_H2";
          break;
        }
      }
    }

    if (serialConnectedRef.current) sendHaptic(feedbackCode);
    if (foundObject && foundObject !== hoveredObject) {
      geminiService.current?.sendTextMessage(`[EXPLORATION]: Focus on "${foundObject}".`);
    }
    setHoveredObject(foundObject);
    setIsOutOfBounds(outOfBounds);
  };

  const startScreenRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      recordedChunksRef.current = [];
      mediaRecorder.ondataavailable = (event) => { if (event.data.size > 0) recordedChunksRef.current.push(event.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `zupiter-session-${new Date().getTime()}.webm`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        setIsRecording(false);
      };
      mediaRecorder.start();
      setIsRecording(true);
      return "Recording started";
    } catch (err) {
      return "Failed: " + (err as Error).message;
    }
  };

  const startCamera = async (mode: 'user' | 'environment') => {
    try {
      if (currentStreamRef.current) {
        currentStreamRef.current.getTracks().forEach(track => track.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: mode }, 
        audio: false 
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        currentStreamRef.current = stream;
        videoRef.current.onloadedmetadata = () => updateVideoRect();
      }
    } catch (err) {
      addLog("Camera access required.", "system");
    }
  };

  const handleDisconnect = async () => {
    updateStatus(ConnectionStatus.DISCONNECTED);
    if (geminiService.current) {
      await geminiService.current.disconnect();
      geminiService.current = null;
    }
    if (frameInterval.current) {
      clearInterval(frameInterval.current);
      frameInterval.current = null;
    }
    if (audioProcessor.current) {
      audioProcessor.current.disconnect();
      audioProcessor.current = null;
    }
    if (audioContextIn.current) {
      await audioContextIn.current.close();
      audioContextIn.current = null;
    }
    sendHaptic("HAPTIC_0");
    setDetectedObjects([]);
    setIsExplorationMode(false);
  };

  const handleConnect = async () => {
    if (status === ConnectionStatus.CONNECTING) return;
    
    updateStatus(ConnectionStatus.CONNECTING);
    try {
      await handleDisconnect();
      // Small delay to let system settle
      await new Promise(r => setTimeout(r, 500));
      
      geminiService.current = new GeminiLiveService(
        process.env.API_KEY || '', 
        (msg, type) => {
          if (type === 'system' && (msg.toLowerCase().includes("error") || msg.toLowerCase().includes("closed"))) {
             updateStatus(ConnectionStatus.ERROR);
          }
          addLog(msg, type);
        },
        async (name, args = {}) => {
          if (name === 'startRecording') return await startScreenRecording();
          if (name === 'stopRecording') {
            if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
            return "Stopped";
          }
          if (name === 'updateObjectMap') {
            const objs = Array.isArray(args.objects) ? args.objects : [];
            setDetectedObjects(objs);
            setIsExplorationMode(true);
            updateVideoRect();
            addLog(`Spatial map synced: ${objs.length} nodes detected.`, 'system');
            return `Synced ${objs.length} items.`;
          }
          if (name === 'stopExploration') {
            setDetectedObjects([]);
            setIsExplorationMode(false);
            setHoveredObject(null);
            sendHaptic("HAPTIC_0");
            addLog(`Exploration mode disabled.`, 'system');
            return "Exploration stopped.";
          }
          if (name === 'setMaximizeCamera') {
            setIsFullscreen(!!args.maximize);
            setTimeout(updateVideoRect, 100);
            return "Updated layout";
          }
          if (name === 'setCameraFacing') {
            const mode = args.facingMode === 'environment' ? 'environment' : 'user';
            setFacingMode(mode);
            await startCamera(mode);
            return `Switched to ${mode}`;
          }
          return "Tool executed";
        }
      );
      
      await geminiService.current.connect(GET_SYSTEM_PROMPT(serialConnectedRef.current));
      updateStatus(ConnectionStatus.CONNECTED);
      
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextIn.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContextIn.current.createMediaStreamSource(audioStream);
      audioProcessor.current = audioContextIn.current.createScriptProcessor(4096, 1, 1);
      audioProcessor.current.onaudioprocess = (e) => {
        if (statusRef.current !== ConnectionStatus.CONNECTED) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
        geminiService.current?.sendAudio({
          data: encode(new Uint8Array(int16.buffer)),
          mimeType: 'audio/pcm;rate=16000',
        });
      };
      source.connect(audioProcessor.current);
      audioProcessor.current.connect(audioContextIn.current.destination);

      frameInterval.current = window.setInterval(() => {
        if (videoRef.current && canvasRef.current && statusRef.current === ConnectionStatus.CONNECTED) {
          const context = canvasRef.current.getContext('2d');
          if (context && videoRef.current.readyState >= 2) {
            canvasRef.current.width = videoRef.current.videoWidth;
            canvasRef.current.height = videoRef.current.videoHeight;
            context.drawImage(videoRef.current, 0, 0);
            const base64Image = canvasRef.current.toDataURL('image/jpeg', 0.35).split(',')[1];
            geminiService.current?.sendFrame(base64Image);
            setIsVisionActive(true);
            setTimeout(() => setIsVisionActive(false), 200);
          }
        }
      }, 1500); // Slightly slowed frame rate for stability
    } catch (err: any) {
      addLog(`Initialization failed: ${err.message}`, 'system');
      updateStatus(ConnectionStatus.ERROR);
    }
  };

  const handleSerialToggle = async () => {
    if (serialConnected) {
      await serialService.current.disconnect();
      updateSerialConnected(false);
      addLog("Haptic Glove unlinked.", "system");
    } else {
      const hasPort = await serialService.current.requestPort();
      if (hasPort) {
        const ok = await serialService.current.connect();
        if (ok) {
          updateSerialConnected(true);
          addLog("Haptic Glove linked successfully.", "system");
        }
      }
    }
  };

  useEffect(() => {
    startCamera(facingMode);
    window.addEventListener('resize', updateVideoRect);
    return () => {
      if (frameInterval.current) clearInterval(frameInterval.current);
      window.removeEventListener('resize', updateVideoRect);
    }
  }, [updateVideoRect]);

  return (
    <div className={`h-screen bg-[#020202] text-white flex flex-col font-sans overflow-hidden selection:bg-[#22c55e]/30 p-6 ${isFullscreen ? 'p-0' : ''}`}>
      {!isFullscreen && (
        <header className="flex flex-col md:flex-row items-center justify-between gap-4 border-b border-white/5 pb-6">
        <div className="flex items-center space-x-4">
          <div className="bg-green-600 p-4 rounded-[2rem] shadow-[0_0_40px_rgba(34,197,94,0.4)] animate-pulse">
            <Cpu className="w-8 h-8 text-black" />
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-700">ZUPITER</h1>
            <p className="text-green-500 text-[10px] font-black tracking-[0.4em] uppercase opacity-80">Multimodal Image Exploration</p>
          </div>
        </div>

          <div className="flex items-center gap-4">
            <button 
              onClick={() => isRecording ? mediaRecorderRef.current?.stop() : startScreenRecording()}
              className={`px-5 py-2.5 rounded-xl border flex items-center gap-3 transition-all uppercase tracking-widest text-[10px] font-black ${
                isRecording ? 'bg-red-600/10 border-red-600/40 text-red-500 animate-pulse' : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10'
              }`}
            >
              {isRecording ? <CircleStop className="w-4 h-4" /> : <VideoIcon className="w-4 h-4" />}
              {isRecording ? 'REC' : 'START REC'}
            </button>

            <button 
              onClick={handleSerialToggle}
              className={`px-6 py-2.5 rounded-xl border transition-all flex items-center gap-3 uppercase tracking-widest text-[10px] font-bold ${
                serialConnected ? 'bg-[#22c55e]/10 border-[#22c55e]/40 text-[#22c55e]' : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/5'
              }`}
            >
              {serialConnected ? <Link className="w-4 h-4" /> : <Link2Off className="w-4 h-4 opacity-40" />}
              {serialConnected ? 'GLOVE LINKED' : 'LINK GLOVE'}
            </button>
            
            <div className="px-6 py-2.5 rounded-xl bg-white/5 border border-white/5 flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-[#22c55e]' : status === ConnectionStatus.ERROR ? 'bg-red-500' : 'bg-white/20 animate-pulse'}`} />
              <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">{status}</span>
            </div>

            <button 
              onClick={status === ConnectionStatus.CONNECTED ? handleDisconnect : handleConnect}
              className={`px-12 py-3 rounded-xl font-black text-[11px] uppercase tracking-widest transition-all active:scale-95 shadow-xl ${
                status === ConnectionStatus.CONNECTED ? 'bg-white/10 text-white border border-white/20 hover:bg-white/20' : 'bg-white text-black hover:bg-zinc-200'
              }`}
            >
              {status === ConnectionStatus.CONNECTED ? 'STOP ZUPITER' : status === ConnectionStatus.CONNECTING ? 'LINKING...' : status === ConnectionStatus.ERROR ? 'RETRY LINK' : 'START ZUPITER'}
            </button>
          </div>
        </header>
      )}

      <div className={`flex-1 grid gap-8 px-4 pb-4 overflow-hidden ${isFullscreen ? 'grid-cols-1 p-0' : 'grid-cols-12'}`}>
        <div className={`flex flex-col gap-8 h-full overflow-hidden ${isFullscreen ? 'col-span-1' : 'col-span-8'}`}>
          <div 
            ref={viewportRef}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => { setHoveredObject(null); if(isExplorationMode) sendHaptic("HAPTIC_0"); }}
            className={`relative flex-1 bg-[#0a0a0a] overflow-hidden border border-white/10 shadow-2xl min-h-0 group flex items-center justify-center transition-all duration-500 ${isFullscreen ? 'rounded-0 border-0' : 'rounded-[3rem]'} ${isExplorationMode ? 'cursor-none' : 'cursor-default'}`}
          >
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className={`absolute transition-all duration-700 ${status === ConnectionStatus.CONNECTED ? 'grayscale-[0.4] opacity-80' : 'grayscale opacity-20 blur-[2px]'}`}
              style={{ top: `${videoRect.top}px`, left: `${videoRect.left}px`, width: `${videoRect.width}px`, height: `${videoRect.height}px`, objectFit: 'cover' }}
            />
            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full opacity-0 pointer-events-none" />
            
            <div className="absolute pointer-events-none" style={{ top: `${videoRect.top}px`, left: `${videoRect.left}px`, width: `${videoRect.width}px`, height: `${videoRect.height}px` }}>
              {isExplorationMode && Array.isArray(detectedObjects) && detectedObjects.map((obj, i) => {
                if (!obj || !Array.isArray(obj.box_2d) || obj.box_2d.length < 4) return null;
                const [ymin, xmin, ymax, xmax] = obj.box_2d;
                const isHovered = hoveredObject === obj.label;
                return (
                  <div key={i} className={`absolute transition-all duration-300 border-2 rounded-xl flex items-center justify-center overflow-hidden ${isHovered ? 'border-[#22c55e] bg-[#22c55e]/10 shadow-[0_0_20px_rgba(34,197,94,0.2)]' : 'border-[#22c55e]/20 bg-black/20'}`}
                    style={{ top: `${ymin / 10}%`, left: `${xmin / 10}%`, height: `${(ymax - ymin) / 10}%`, width: `${(xmax - xmin) / 10}%` }}>
                    {isHovered && <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#22c55e]/20 to-transparent animate-scan" />}
                    <span className={`text-[9px] font-black uppercase tracking-[0.2em] px-3 py-1.5 bg-black/90 rounded-lg ${isHovered ? 'text-[#22c55e]' : 'text-white/40'}`}>
                      {obj.label}
                    </span>
                  </div>
                );
              })}

              {(isExplorationMode || status === ConnectionStatus.CONNECTED) && (
                <div className="absolute transition-transform duration-75 z-50" style={{ left: `${laserPoint.x / 10}%`, top: `${laserPoint.y / 10}%`, transform: 'translate(-50%, -50%)' }}>
                  <div className={`w-14 h-14 rounded-full border-2 flex items-center justify-center transition-all ${hoveredObject ? 'border-[#22c55e] scale-110 shadow-[0_0_20px_rgba(34,197,94,0.4)]' : isOutOfBounds ? 'border-red-600 scale-90' : 'border-white/20'}`}>
                    <div className={`w-4 h-4 rounded-full ${hoveredObject ? 'bg-[#22c55e]' : isOutOfBounds ? 'bg-red-600' : 'bg-white'}`} />
                  </div>
                </div>
              )}
            </div>

            <div className="absolute top-10 right-10 flex flex-col gap-4 z-30">
              <button onClick={() => { setIsFullscreen(!isFullscreen); setTimeout(updateVideoRect, 100); }} className="w-12 h-12 bg-black/60 backdrop-blur-md border border-white/20 rounded-2xl flex items-center justify-center text-white/70 hover:text-white transition-all active:scale-90">
                {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
              </button>
              <button onClick={() => { const nextMode = facingMode === 'user' ? 'environment' : 'user'; setFacingMode(nextMode); startCamera(nextMode); }} className="w-12 h-12 bg-black/60 backdrop-blur-md border border-white/20 rounded-2xl flex items-center justify-center text-white/70 hover:text-white transition-all active:scale-90">
                <FlipHorizontal className="w-5 h-5" />
              </button>
              <button onClick={() => { if(isExplorationMode) { setDetectedObjects([]); setIsExplorationMode(false); sendHaptic("HAPTIC_0"); } else { geminiService.current?.sendTextMessage("[USER_CMD]: Please scan the scene."); } }} className={`w-12 h-12 backdrop-blur-md border rounded-2xl flex items-center justify-center transition-all active:scale-90 ${isExplorationMode ? 'bg-[#22c55e]/20 border-[#22c55e] text-[#22c55e]' : 'bg-black/60 border-white/20 text-white/70'}`}>
                {isExplorationMode ? <Compass className="w-5 h-5 animate-spin-slow" /> : <Sparkles className="w-5 h-5" />}
              </button>
            </div>

            <div className="absolute bottom-10 left-10 z-20">
              <div className="bg-black/90 backdrop-blur-md px-5 py-2.5 rounded-full border border-white/10 flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full animate-pulse ${isExplorationMode ? 'bg-[#22c55e]' : 'bg-white/20'}`} />
                <span className="text-[9px] font-black text-white/50 uppercase tracking-[0.3em]">
                  {isExplorationMode ? 'Exploration Mode' : 'Assistant Mode'}
                </span>
              </div>
            </div>
          </div>

          {!isFullscreen && (
            <div className="flex-none grid grid-cols-4 gap-6 h-36">
              <IndicatorCard h="H1" label="BOUNDARY" active={hapticSerial === 'HAPTIC_H1' && isExplorationMode} />
              <IndicatorCard h="H2" label="INTERIOR" active={hapticSerial === 'HAPTIC_H2' && isExplorationMode} />
              <IndicatorCard h="H3" label="WARNING" active={hapticSerial === 'HAPTIC_H3' && isExplorationMode} />
              <div className="bg-[#111] rounded-[2rem] flex flex-col items-center justify-center border border-white/5">
                <div className={`p-3 rounded-full mb-2 ${serialConnected ? 'bg-[#22c55e]/10' : 'bg-white/5'}`}>
                  {serialConnected ? <Zap className="w-5 h-5 text-[#22c55e]" /> : <Target className="w-5 h-5 text-white/20" />}
                </div>
                <span className="text-[10px] font-black uppercase tracking-[0.4em] text-white/20">System</span>
              </div>
            </div>
          )}
        </div>

        {!isFullscreen && (
          <div className="col-span-4 flex flex-col gap-8 h-full overflow-hidden">
            <div className="flex-[3] bg-[#0c0c0c] rounded-[3rem] border border-white/5 overflow-hidden flex flex-col shadow-2xl min-h-0">
              <div className="p-8 border-b border-white/5 flex items-center justify-between bg-white/2 flex-none">
               <div className="flex items-center gap-3">
  <Cpu className="w-4 h-4 text-[#22c55e]" />
  <h2 className="text-[11px] font-black tracking-[0.3em] text-white/40 uppercase">Neural Stream</h2>
</div>
                {status === ConnectionStatus.ERROR && (
                    <button onClick={handleConnect} className="p-2 hover:bg-[#22c55e]/10 rounded-lg transition-colors group">
                        <RefreshCw className="w-4 h-4 text-[#22c55e] group-active:rotate-180 transition-transform" />
                    </button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-8 space-y-8 scrollbar-hide">
                {logs.length === 0 ? (
                  <div className="h-full flex items-center justify-center opacity-[0.03]"><LayoutGrid className="w-24 h-24" /></div>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className={`flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-500 ${log.type === 'assistant' ? 'items-start' : 'items-end'}`}>
                      <span className="text-[8px] font-black text-white/20 uppercase tracking-[0.3em]">{log.type}</span>
                      <div className={`px-6 py-4 rounded-[1.8rem] text-sm max-w-[92%] leading-relaxed font-medium transition-all ${
                        log.type === 'assistant' ? 'bg-[#181818] border border-white/5 text-white/90 shadow-lg' : 
                        log.type === 'system' ? (log.message.includes("error") ? 'bg-red-500/10 border border-red-500/20 text-red-400 font-bold' : 'bg-white/5 border border-white/10 text-white/40 italic') :
                        'bg-[#22c55e]/10 border border-[#22c55e]/20 text-[#22c55e]'
                      }`}>
                        {log.message}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex-1 bg-[#0c0c0c] rounded-[3rem] border border-[#22c55e]/10 p-10 flex flex-col justify-between shadow-2xl min-h-0">
              <div className="flex flex-col gap-8 relative z-10">
               
<div className="flex items-center gap-3 mb-4">
  <span className="relative flex h-4 w-4">
    <span className="animate-glow absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
    <span className="relative inline-flex rounded-full h-4 w-4 bg-green-500"></span>
  </span>
  <span className="text-[11px] font-black tracking-[0.3em] text-green-500 uppercase">Glove Serial Link</span>
  
</div>
                <div className="space-y-6">
                  <div className="flex justify-between items-center border-b border-white/5 pb-5">
                    <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest">Nodes</span>
                    <span className="text-[11px] font-mono font-black text-[#22c55e]">{detectedObjects.length}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest">Haptics</span>
                    <span className="text-[11px] font-mono font-black text-white/70 uppercase">{serialConnected ? hapticSerial : 'OFFLINE'}</span>
                    
                  </div>
                  
                </div>
                
              </div>
            </div>
          </div>
          
        )}
      </div>

      <style>{`
        @keyframes scan { from { transform: translateY(-100%); } to { transform: translateY(100%); } }
        .animate-scan { animation: scan 2s linear infinite; }
        .animate-spin-slow { animation: spin 4s linear infinite; }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes glow {
  0%, 100% { transform: scale(1); opacity: 0.8; }
  50% { transform: scale(1.8); opacity: 0.2; }
}
.animate-glow {
  animation: glow 1.2s ease-in-out infinite;
}
      `}</style>
    </div>
  );
}

function IndicatorCard({ h, label, active }: { h: string, label: string, active?: boolean }) {
  return (
    <div className={`rounded-[2rem] flex flex-col items-center justify-center border transition-all duration-300 ${active ? 'bg-[#22c55e]/20 border-[#22c55e] shadow-[0_0_20px_#22c55e22] scale-105' : 'bg-[#111] border-white/5 opacity-40'}`}>
      <span className={`text-4xl font-black mb-2 ${active ? 'text-[#22c55e]' : 'text-white/30'}`}>{h}</span>
      <span className={`text-[10px] font-black uppercase tracking-[0.5em] ${active ? 'text-[#22c55e]' : 'text-white/5'}`}>{label}</span>
    </div>
  );
}
