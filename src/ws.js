import { createHash } from "node:crypto";

// RFC 6455 §1.3: the magic GUID appended to the client key for the accept hash.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Computes the `Sec-WebSocket-Accept` value for a client handshake key. */
export function acceptKey(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** Answers a WebSocket upgrade request with `101 Switching Protocols`. */
export function writeHandshake(socket, key) {
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      "\r\n",
  );
}

/** Rejects an upgrade attempt with a plain HTTP error and closes the socket. */
export function rejectUpgrade(socket, status = 401, message = "Unauthorized") {
  const body = `${status} ${message}`;
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
  socket.destroy();
}

/**
 * A minimal server-side WebSocket connection (RFC 6455).
 *
 * Parses masked client frames (text, fragmented continuation, ping/pong and
 * close) and sends unmasked server frames. Complete text messages are handed to
 * `onmessage`; `onclose` fires exactly once when the socket ends.
 */
export class WsConnection {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = head;
    this.closed = false;
    this.fragments = null; // Buffer[] while a fragmented message is in progress
    this.onmessage = null;
    this.onclose = null;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("end", () => this._destroy());
    socket.on("error", () => this._destroy());
    socket.on("close", () => this._destroy());
  }

  /** Sends a text frame to the client (server frames are never masked). */
  send(text) {
    if (this.closed) return;
    this.socket.write(this._frame(0x1, Buffer.from(String(text), "utf8")));
  }

  _frame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    try {
      while (!this.closed) {
        const frame = this._parse();
        if (!frame) break;
        this._handleFrame(frame);
      }
    } catch {
      this._destroy();
    }
  }

  _parse() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this._destroy();
        return null;
      }
      len = Number(big);
    }

    // RFC 6455 §5.1: every client-to-server frame must be masked.
    if (!masked) {
      this._destroy();
      return null;
    }
    if (buf.length < offset + 4) return null;
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      // Close: echo the frame back, then tear the connection down.
      if (!this.closed) this.socket.write(this._frame(0x8, payload));
      this._destroy();
      return;
    }
    if (opcode === 0x9) {
      // Ping: reply with a pong carrying the same payload.
      if (!this.closed) this.socket.write(this._frame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return; // Pong: nothing to do.
    if (opcode === 0x1 || opcode === 0x0) {
      // Text (0x1) opens a message; continuation (0x0) continues the open one.
      if (opcode === 0x1) {
        if (this.fragments) {
          this._destroy();
          return;
        }
        this.fragments = [];
      } else if (!this.fragments) {
        this._destroy();
        return;
      }
      this.fragments.push(payload);
      if (fin) {
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = null;
        if (this.onmessage) this.onmessage(text);
      }
      return;
    }
    // Binary and other opcodes are unused by this app; ignore them.
  }

  _destroy() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
    this.socket.destroy();
  }
}
