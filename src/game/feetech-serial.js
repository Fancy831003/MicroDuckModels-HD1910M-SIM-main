const POSITION_ADDRESS = 56;
const POSITION_LENGTH = 2;
const GOAL_POSITION_ADDRESS = 42;
const TORQUE_ENABLE_ADDRESS = 40;

export class ServoTimeoutError extends Error {
  constructor(id) {
    super(`No response from servo ${id}.`);
    this.name = "ServoTimeoutError";
  }
}

export class ServoStatusError extends Error {
  constructor(id, status) {
    super(`Servo ${id} reported status 0x${status.toString(16).padStart(2, "0")}.`);
    this.name = "ServoStatusError";
    this.status = status;
  }
}

export function makePositionReadPacket(id) {
  if (!Number.isInteger(id) || id < 0 || id > 253) {
    throw new RangeError("Servo ID must be between 0 and 253.");
  }
  const length = 4;
  const checksum = (~(id + length + 2 + POSITION_ADDRESS + POSITION_LENGTH)) & 0xff;
  return new Uint8Array([0xff, 0xff, id, length, 2, POSITION_ADDRESS, POSITION_LENGTH, checksum]);
}

export function makeGoalPositionPacket(id, position) {
  if (!Number.isInteger(id) || id < 1 || id > 253) {
    throw new RangeError("Servo ID must be between 1 and 253 for individual position output.");
  }
  if (!Number.isInteger(position) || position < 0 || position > 4095) {
    throw new RangeError("Goal position must be between 0 and 4095.");
  }
  const low = position & 0xff;
  const high = position >> 8;
  const length = 5;
  const checksum = (~(id + length + 3 + GOAL_POSITION_ADDRESS + low + high)) & 0xff;
  return new Uint8Array([
    0xff, 0xff, id, length, 3, GOAL_POSITION_ADDRESS, low, high, checksum,
  ]);
}

export function makeSyncGoalPositionPacket(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 83) {
    throw new RangeError("Sync write requires between 1 and 83 servo targets.");
  }
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || !Number.isInteger(entry.id) || entry.id < 1 || entry.id > 253) {
      throw new RangeError("Servo IDs must be between 1 and 253 for sync position output.");
    }
    if (ids.has(entry.id)) {
      throw new RangeError("Sync position output requires unique servo IDs.");
    }
    ids.add(entry.id);
    if (!Number.isInteger(entry.position) || entry.position < 0 || entry.position > 4095) {
      throw new RangeError("Goal positions must be between 0 and 4095.");
    }
  }

  const parameters = [GOAL_POSITION_ADDRESS, 2];
  for (const { id, position } of entries) {
    parameters.push(id, position & 0xff, position >> 8);
  }
  const broadcastId = 0xfe;
  const length = parameters.length + 2;
  const checksum = (~(
    broadcastId
    + length
    + 0x83
    + parameters.reduce((sum, byte) => sum + byte, 0)
  )) & 0xff;
  return new Uint8Array([0xff, 0xff, broadcastId, length, 0x83, ...parameters, checksum]);
}

export function makeTorqueEnablePacket(id, enabled) {
  if (!Number.isInteger(id) || id < 1 || id > 253) {
    throw new RangeError("Servo ID must be between 1 and 253 for individual torque control.");
  }
  if (typeof enabled !== "boolean") {
    throw new TypeError("Torque enable state must be a boolean.");
  }
  const length = 4;
  const value = enabled ? 1 : 0;
  const checksum = (~(id + length + 3 + TORQUE_ENABLE_ADDRESS + value)) & 0xff;
  return new Uint8Array([
    0xff, 0xff, id, length, 3, TORQUE_ENABLE_ADDRESS, value, checksum,
  ]);
}

export function parsePositionStatusPacket(packet, expectedId) {
  if (!(packet instanceof Uint8Array) || packet.length !== 8) return null;
  if (packet[0] !== 0xff || packet[1] !== 0xff || packet[2] !== expectedId || packet[3] !== 4) {
    return null;
  }
  const checksum = (~packet.subarray(2, 7).reduce((sum, byte) => sum + byte, 0)) & 0xff;
  if (checksum !== packet[7]) return null;
  if (packet[4] !== 0) throw new ServoStatusError(expectedId, packet[4]);
  return packet[5] | (packet[6] << 8);
}

export function servoPositionToRadians(position) {
  if (!Number.isInteger(position) || position < 0 || position > 0xffff) {
    throw new RangeError("Servo position must be an unsigned 16-bit integer.");
  }
  const ticks = position & 0x0fff;
  return ((ticks - 2048) / 4096) * Math.PI * 2;
}

export function radiansToServoPosition(angle) {
  if (!Number.isFinite(angle)) {
    throw new RangeError("Servo target angle must be a finite number.");
  }
  const ticks = Math.round((angle / (Math.PI * 2)) * 4096 + 2048);
  return ((ticks % 4096) + 4096) % 4096;
}

export function simulatorAngleToServoPosition(angle, {
  offsetDeg = 0,
  reversed = false,
  minDeg = -180,
  maxDeg = 180,
} = {}) {
  if (!Number.isFinite(angle) || !Number.isFinite(offsetDeg)
    || !Number.isFinite(minDeg) || !Number.isFinite(maxDeg)
    || minDeg < -180 || maxDeg > 180 || minDeg >= maxDeg) {
    throw new RangeError("Simulator angle and servo output limits must be finite and within -180° to 180°.");
  }
  const direction = reversed ? -1 : 1;
  const servoAngle = direction * (angle - offsetDeg * Math.PI / 180);
  const limitedAngle = Math.max(
    minDeg * Math.PI / 180,
    Math.min(maxDeg * Math.PI / 180, servoAngle),
  );
  return radiansToServoPosition(limitedAngle);
}

export class FeetechSerialBus {
  constructor(port, onError = () => {}) {
    this.port = port;
    this.onError = onError;
    this.reader = null;
    this.writer = null;
    this.readTask = null;
    this.buffer = new Uint8Array();
    this.waiters = new Map();
    this.readError = null;
    this.closed = false;
    this.operationQueue = Promise.resolve();
  }

  async open(baudRate = 1_000_000) {
    if (!this.port?.readable || !this.port?.writable) {
      await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none" });
    }
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }

  async readPosition(id, timeoutMs = 25) {
    return this.runExclusive(async () => {
      if (this.readError) throw this.readError;
      if (this.closed || !this.writer || !this.reader) {
        throw new Error("Serial bus is not open.");
      }
      if (this.waiters.has(id)) throw new Error(`Servo ${id} is already being read.`);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.waiters.delete(id);
          reject(new ServoTimeoutError(id));
        }, timeoutMs);
        this.waiters.set(id, {
          resolve: (position) => {
            clearTimeout(timeout);
            resolve(position);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        this.writer.write(makePositionReadPacket(id)).catch((error) => {
          clearTimeout(timeout);
          this.waiters.delete(id);
          reject(error);
        });
      });
    });
  }

  async writeGoalPosition(id, position) {
    return this.runExclusive(async () => {
      if (this.closed || !this.writer || !this.reader) {
        throw new Error("Serial bus is not open.");
      }
      await this.writer.write(makeGoalPositionPacket(id, position));
    });
  }

  async writeSyncGoalPositions(entries) {
    return this.runExclusive(async () => {
      if (this.closed || !this.writer || !this.reader) {
        throw new Error("Serial bus is not open.");
      }
      await this.writer.write(makeSyncGoalPositionPacket(entries));
    });
  }

  async setTorqueEnabled(id, enabled) {
    return this.runExclusive(async () => {
      if (this.closed || !this.writer || !this.reader) {
        throw new Error("Serial bus is not open.");
      }
      await this.writer.write(makeTorqueEnablePacket(id, enabled));
    });
  }

  runExclusive(operation) {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.catch(() => {});
    return result;
  }

  async readLoop() {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.consume(value);
      }
      if (!this.closed) this.fail(new Error("Serial port was disconnected."));
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }

  consume(chunk) {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;

    while (this.buffer.length >= 4) {
      let header = -1;
      for (let i = 0; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === 0xff && this.buffer[i + 1] === 0xff) {
          header = i;
          break;
        }
      }
      if (header < 0) {
        this.buffer = this.buffer[this.buffer.length - 1] === 0xff
          ? this.buffer.slice(-1)
          : new Uint8Array();
        return;
      }
      if (header) this.buffer = this.buffer.slice(header);
      if (this.buffer.length < 4) return;

      const packetLength = this.buffer[3] + 4;
      if (this.buffer[3] < 2 || packetLength > 64) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < packetLength) return;

      const packet = this.buffer.slice(0, packetLength);
      this.buffer = this.buffer.slice(packetLength);
      const id = packet[2];
      const waiter = this.waiters.get(id);
      if (!waiter) continue;
      try {
        const position = parsePositionStatusPacket(packet, id);
        if (position === null) continue;
        this.waiters.delete(id);
        waiter.resolve(position);
      } catch (error) {
        this.waiters.delete(id);
        waiter.reject(error);
      }
    }
  }

  fail(error) {
    this.readError = error;
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      waiter.reject(error);
    }
    this.onError(error);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      waiter.reject(new Error("Serial bus was closed."));
    }
    await this.reader?.cancel();
    this.reader?.releaseLock();
    this.writer?.releaseLock();
    if (this.port?.readable || this.port?.writable) await this.port.close();
    await this.readTask;
    await this.operationQueue;
  }
}
