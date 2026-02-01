
import { GoogleGenAI, LiveServerMessage, Modality, Blob, Type, FunctionDeclaration } from '@google/genai';
import { encode, decode, decodeAudioData } from '../utils/audioUtils';

export class GeminiLiveService {
  private ai: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private audioContextOut: AudioContext | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private onMessageCallback: (msg: string, type: 'assistant' | 'user' | 'system' | 'haptic') => void;
  private onToolCall?: (name: string, args: any) => Promise<any>;
  
  private currentInputTranscription = '';
  private currentOutputTranscription = '';
  private isConnected = false;

  constructor(
    apiKey: string, 
    onMessage: (msg: string, type: 'assistant' | 'user' | 'system' | 'haptic') => void,
    onToolCall?: (name: string, args: any) => Promise<any>
  ) {
    this.ai = new GoogleGenAI({ apiKey });
    this.onMessageCallback = onMessage;
    this.onToolCall = onToolCall;
  }

  async connect(systemInstruction: string) {
    // Thorough cleanup of any existing state
    if (this.sessionPromise) {
      await this.disconnect();
    }

    if (!this.audioContextOut || this.audioContextOut.state === 'closed') {
      this.audioContextOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    
    if (this.audioContextOut.state === 'suspended') {
      await this.audioContextOut.resume();
    }

    const tools: FunctionDeclaration[] = [
      {
        name: 'startRecording',
        description: 'Starts a screen recording of the session.',
        parameters: { type: Type.OBJECT, properties: {} }
      },
      {
        name: 'stopRecording',
        description: 'Stops the recording and saves the file.',
        parameters: { type: Type.OBJECT, properties: {} }
      },
      {
        name: 'stopExploration',
        description: 'Stops exploration mode.',
        parameters: { type: Type.OBJECT, properties: {} }
      },
      {
        name: 'updateObjectMap',
        description: 'Starts exploration mode with detected objects.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            objects: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  label: { type: Type.STRING },
                  box_2d: { type: Type.ARRAY, items: { type: Type.NUMBER } }
                },
                required: ['label', 'box_2d']
              }
            }
          },
          required: ['objects']
        }
      },
      {
        name: 'setMaximizeCamera',
        description: 'Toggles camera fullscreen.',
        parameters: {
          type: Type.OBJECT,
          properties: { maximize: { type: Type.BOOLEAN } },
          required: ['maximize']
        }
      },
      {
        name: 'setCameraFacing',
        description: 'Switches front/back camera.',
        parameters: {
          type: Type.OBJECT,
          properties: { facingMode: { type: Type.STRING, enum: ['user', 'environment'] } },
          required: ['facingMode']
        }
      }
    ];

    this.sessionPromise = this.ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
        },
        systemInstruction,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [{ functionDeclarations: tools }]
      },
      callbacks: {
        onopen: () => {
          this.isConnected = true;
          this.onMessageCallback("Neural link online.", 'system');
        },
        onmessage: async (message: LiveServerMessage) => {
          if (message.toolCall && this.onToolCall) {
            const functionCalls = message.toolCall.functionCalls || [];
            for (const fc of functionCalls) {
              const result = await this.onToolCall(fc.name, fc.args || {});
              this.sessionPromise?.then((session) => {
                session.sendToolResponse({
                  functionResponses: [{
                    id: fc.id,
                    name: fc.name,
                    response: { result: result || "OK" }
                  }]
                });
              });
            }
          }

          if (message.serverContent?.outputTranscription) {
            const text = message.serverContent.outputTranscription.text;
            this.currentOutputTranscription += text;
            const hapticRegex = /HAPTIC_(STOP|START|CUSTOM\(.*?\)|[0-5]|H1|H2|H3)/g;
            let match;
            while ((match = hapticRegex.exec(this.currentOutputTranscription)) !== null) {
                const code = match[0];
                this.onMessageCallback(code, 'haptic');
                this.currentOutputTranscription = this.currentOutputTranscription.replace(code, '[SIGNAL]');
            }
          }

          if (message.serverContent?.inputTranscription) {
            this.currentInputTranscription += message.serverContent.inputTranscription.text;
          }

          if (message.serverContent?.turnComplete) {
            if (this.currentInputTranscription.trim()) {
              this.onMessageCallback(this.currentInputTranscription.trim(), 'user');
              this.currentInputTranscription = '';
            }
            if (this.currentOutputTranscription.trim()) {
              const displayMsg = this.currentOutputTranscription.replace(/\[SIGNAL\]/g, '').trim();
              if (displayMsg) this.onMessageCallback(displayMsg, 'assistant');
              this.currentOutputTranscription = '';
            }
          }

          const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
            this.playAudio(base64Audio);
          }

          if (message.serverContent?.interrupted) {
            this.stopAllAudio();
            this.currentOutputTranscription = ''; 
          }
        },
        onerror: (e) => {
          console.error('Gemini Live Error:', e);
          this.isConnected = false;
          this.onMessageCallback("Neural link error. Reconnecting...", 'system');
        },
        onclose: () => {
          this.isConnected = false;
          this.onMessageCallback("Link closed.", 'system');
        },
      }
    });

    return this.sessionPromise;
  }

  private async playAudio(base64: string) {
    if (!this.audioContextOut || this.audioContextOut.state === 'closed') return;
    try {
      this.nextStartTime = Math.max(this.nextStartTime, this.audioContextOut.currentTime);
      const audioBuffer = await decodeAudioData(decode(base64), this.audioContextOut, 24000, 1);
      const source = this.audioContextOut.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContextOut.destination);
      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
    } catch (err) {
      console.error("Audio playback error:", err);
    }
  }

  private stopAllAudio() {
    this.sources.forEach(s => { try { s.stop(); } catch(e) {} });
    this.sources.clear();
    this.nextStartTime = 0;
  }

  sendAudio(pcmBlob: Blob) {
    if (!this.isConnected || !this.sessionPromise) return;
    this.sessionPromise.then((session) => {
      session.sendRealtimeInput({ media: pcmBlob });
    }).catch(() => {});
  }

  sendFrame(base64Image: string) {
    if (!this.isConnected || !this.sessionPromise) return;
    this.sessionPromise.then((session) => {
      session.sendRealtimeInput({
        media: { data: base64Image, mimeType: 'image/jpeg' }
      });
    }).catch(() => {});
  }

  sendTextMessage(text: string) {
    if (!this.isConnected || !this.sessionPromise) return;
    this.sessionPromise.then((session) => {
      session.sendRealtimeInput({ text });
    }).catch(() => {});
  }

  async disconnect() {
    this.isConnected = false;
    const session = await this.sessionPromise;
    if (session) {
      try {
        session.close();
      } catch (e) {}
    }
    this.stopAllAudio();
    if (this.audioContextOut) {
      try {
        await this.audioContextOut.close();
      } catch (e) {}
      this.audioContextOut = null;
    }
    this.sessionPromise = null;
    this.nextStartTime = 0;
  }
}
