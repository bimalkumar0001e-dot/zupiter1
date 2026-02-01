
export class SerialService {
  private port: any | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private encoder = new TextEncoder();

  async requestPort(): Promise<boolean> {
    try {
      if (!('serial' in navigator)) {
        throw new Error('Web Serial API not supported in this browser.');
      }
      this.port = await (navigator as any).serial.requestPort();
      return !!this.port;
    } catch (err: any) {
      // "NotFoundError" is the standard error when a user cancels the picker.
      if (err.name === 'NotFoundError') {
        console.log('User dismissed the serial port picker.');
      } else {
        console.error('Serial port request failed:', err);
      }
      return false;
    }
  }

  async connect(baudRate: number = 9600): Promise<boolean> {
    if (!this.port) return false;
    try {
      if (!this.port.writable) {
        await this.port.open({ baudRate });
      }
      
      if (this.writer) {
        try {
          this.writer.releaseLock();
        } catch (e) {}
      }
      
      this.writer = this.port.writable.getWriter();
      return true;
    } catch (err) {
      console.error('Failed to open serial port:', err);
      if (this.port.writable) {
        try {
          this.writer = this.port.writable.getWriter();
          return true;
        } catch (e) {
          return false;
        }
      }
      return false;
    }
  }

  async write(data: string) {
    if (!this.writer) {
      return;
    }
    try {
      await this.writer.write(this.encoder.encode(data + '\n'));
    } catch (err) {
      console.error('Error writing to serial port:', err);
    }
  }

  async disconnect() {
    try {
      if (this.writer) {
        try {
          this.writer.releaseLock();
        } catch (e) {}
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
      }
    } catch (err) {
      console.error('Error during serial disconnect:', err);
    } finally {
      this.port = null;
      this.writer = null;
    }
  }

  isOpen(): boolean {
    return !!(this.port && this.port.writable);
  }
}
