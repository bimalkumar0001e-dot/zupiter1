
export interface LogEntry {
  timestamp: string;
  type: 'system' | 'user' | 'assistant' | 'haptic';
  message: string;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface Point {
  x: number;
  y: number;
}
