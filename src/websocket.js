import { createHash } from "node:crypto";

// RFC 6455 magic GUID used to compute the Sec-WebSocket-Accept handshake value.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Computes the Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key,
 * as required by the RFC 6455 opening handshake.
 */
export function computeAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/**
 * Encodes a single unfragmented WebSocket frame (FIN set, server->client so
 * unmasked). `opcode` is 0x1 for text, 0x2 for binary, 0x8 for close, 0x9 for
 * ping and 0xA for pong.
 */
export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const length = data.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), data]);
  }
  if (length < 65536) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, data]);
}

function applyMask(payload, maskKey) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = payload[i] ^ maskKey[i & 3];
  }
  return out;
}

/**
 * A minimal, dependency-free WebSocket server connection: reads and parses
 * client frames (masked, possibly fragmented) and writes server frames.
 */
export class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.onMessage = null;
    this.onClose = null;
    this.closed = false;

    socket.on("data", (chunk) => this.feed(chunk));
    socket.on("error", () => this.destroy());
    socket.on("close", () => this.destroy());
  }

  feed(chunk) {
    if (this.closed) return;
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.parse();
  }

  parse() {
    while (!this.closed && this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const b1 = this.buffer[1];
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) payload = applyMask(payload, maskKey);

      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      // Close: echo the close frame back and end the socket.
      try {
        this.socket.write(encodeFrame(0x8, payload));
      } catch {
        /* ignore write errors on a dying socket */
      }
      this.closed = true;
      this.socket.end();
      this.onClose?.();
      return;
    }
    if (opcode === 0x9) {
      try {
        this.socket.write(encodeFrame(0xa, payload));
      } catch {
        /* ignore */
      }
      return;
    }
    if (opcode === 0xa) return; // pong

    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [payload];
      if (fin) this.emitMessage();
      return;
    }
    if (opcode === 0x0) {
      // Continuation frame; ignore stray ones without a started message.
      if (this.fragments.length === 0) return;
      this.fragments.push(payload);
      if (fin) this.emitMessage();
      return;
    }
    // Unknown opcode: ignore.
  }

  emitMessage() {
    const message = Buffer.concat(this.fragments).toString("utf8");
    this.fragments = [];
    try {
      this.onMessage?.(message);
    } catch {
      /* handler errors must not break the parser */
    }
  }

  sendText(text) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeFrame(0x1, text));
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.onClose?.();
  }
}
