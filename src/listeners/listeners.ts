import WebSocket from 'ws';
import bs58 from 'bs58';
import * as base64js from 'base64-js';
import { EventEmitter } from 'events';

export class TokenCreationListener extends EventEmitter {
  private websocketUrl: string;
  private programId: string;
  private websocket: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(websocketUrl: string, programId: string) {
    super();
    this.websocketUrl = websocketUrl;
    this.programId = programId;
    this.preemptiveConnect();  // Open WebSocket early
  }

  private parseCreateInstruction(data: Uint8Array): Record<string, any> | null {
    if (data.length < 8) return null;

    let offset = 8;
    const parsedData: Record<string, any> = {};

    const fields: [string, string][] = [
      ['name', 'string'],
      ['symbol', 'string'],
      ['uri', 'string'],
      ['mint', 'publicKey'],
      ['bondingCurve', 'publicKey'],
      ['user', 'publicKey']
    ];

    try {
      fields.forEach(([fieldName, fieldType]) => {
        if (fieldType === 'string') {
          const length = new DataView(data.buffer).getUint32(offset, true);
          offset += 4;
          const value = new TextDecoder().decode(data.slice(offset, offset + length));
          offset += length;
          parsedData[fieldName] = value;
        } else if (fieldType === 'publicKey') {
          const value = bs58.encode(data.slice(offset, offset + 32));
          offset += 32;
          parsedData[fieldName] = value;
        }
      });
      return parsedData;
    } catch (error) {
      return null;
    }
  }

  // Open the WebSocket connection early
  private preemptiveConnect() {
    if (this.websocket && (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)) {
      console.log('WebSocket connection is already open or in progress.');
      return; // Prevent multiple WebSocket connections
    }
  
    this.websocket = new WebSocket(this.websocketUrl);
  
    this.websocket.on('open', () => {
      console.log('WebSocket preemptively connected.');
      this.startHeartbeat();
      this.subscribeToTokenCreations(); // Subscribe only once
    });
  
    this.websocket.on('error', (error: Error) => {
      console.error(`Preemptive connection error: ${error}`);
      this.websocket?.close();
    });
  
    this.websocket.on('close', () => {
      console.log('Preemptive WebSocket closed. Reconnecting in 30 seconds...');
      this.stopHeartbeat();
      setTimeout(() => {
        this.preemptiveConnect();
        this.listenForNewTokens(); // Restart listener after reconnecting
      }, 30000);  // Reconnect after 30 seconds
    });
  }
  
  private subscribeToTokenCreations() {
    if (this.websocket?.readyState === WebSocket.OPEN) {
      console.log(`Subscribed to new token creations from program: ${this.programId}`);
      const subscriptionMessage = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          { mentions: [this.programId] },
          { commitment: "processed" }
        ]
      });
      this.websocket.send(subscriptionMessage);
    } else {
      console.log('WebSocket not open for subscription.');
    }
  }
  
  private startHeartbeat() {
    if (this.heartbeatInterval) return;  // Avoid duplicate heartbeats

    this.heartbeatInterval = setInterval(() => {
      if (this.websocket?.readyState === WebSocket.OPEN) {
        this.websocket.send(JSON.stringify({ type: 'heartbeat' }));
        console.log('Sent heartbeat to keep connection alive');
      }
    }, 1000);  // Send a heartbeat every 1 seconds
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  public async listenForNewTokens(): Promise<void> {
    try {
      if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
        console.log('Reconnecting WebSocket for token subscription...');
        this.preemptiveConnect();
      }

      this.websocket?.on('message', (message: string) => {
        const data = JSON.parse(message);
        if (data.method === 'logsNotification') {
          const logData = data.params.result.value;
          const logs = logData.logs || [];

          if (logs.some((log: string) => log.includes("Program log: Instruction: Create"))) {
            logs.forEach((log: string) => {
              if (log.includes("Program data:")) {
                try {
                  const encodedData = log.split(": ")[1];
                  const decodedData = base64js.toByteArray(encodedData);
                  const parsedData = this.parseCreateInstruction(decodedData);
                  if (parsedData && parsedData.name) {
                    this.emit('tokenCreated', {
                      signature: logData.signature,
                      parsedData
                    });
                  }
                } catch (error) {
                  this.emit('error', new Error(`Failed to decode log: ${log}, Error: ${error}`));
                }
              }
            });
          }
        }
      });
    } catch (error) {
      this.emit('error', error);
      console.log('Reconnecting in 5 seconds...');
      await new Promise(res => setTimeout(res, 5000));
    }
  }

  public closeConnection(): void {
    if (this.websocket) {
      console.log('Closing WebSocket connection...');
      this.websocket.close();
      this.websocket = null;
      this.stopHeartbeat();  // Stop heartbeats on manual close
    }
  }
}
