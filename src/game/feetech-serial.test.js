import assert from "node:assert/strict";
import test from "node:test";
import {
  FeetechSerialBus,
  ServoStatusError,
  makeGoalPositionPacket,
  makePositionReadPacket,
  makeSyncGoalPositionPacket,
  makeTorqueEnablePacket,
  parsePositionStatusPacket,
  radiansToServoPosition,
  simulatorAngleToServoPosition,
  servoPositionToRadians,
} from "./feetech-serial.js";

function statusPacket(id, status, position) {
  const length = 4;
  const low = position & 0xff;
  const high = position >> 8;
  const checksum = (~(id + length + status + low + high)) & 0xff;
  return new Uint8Array([0xff, 0xff, id, length, status, low, high, checksum]);
}

test("builds the Feetech present-position read request", () => {
  assert.deepEqual(
    [...makePositionReadPacket(0)],
    [0xff, 0xff, 0, 4, 2, 56, 2, 191],
  );
  assert.deepEqual(
    [...makePositionReadPacket(1)],
    [0xff, 0xff, 1, 4, 2, 56, 2, 190],
  );
  assert.doesNotThrow(() => makePositionReadPacket(253));
  assert.throws(() => makePositionReadPacket(254), RangeError);
});

test("builds an individual Feetech goal-position write packet", () => {
  assert.deepEqual(
    [...makeGoalPositionPacket(1, 2048)],
    [0xff, 0xff, 1, 5, 3, 42, 0, 8, 196],
  );
  assert.deepEqual(
    [...makeGoalPositionPacket(253, 4095)],
    [0xff, 0xff, 253, 5, 3, 42, 255, 15, 194],
  );
  assert.throws(() => makeGoalPositionPacket(0, 2048), RangeError);
  assert.throws(() => makeGoalPositionPacket(254, 2048), RangeError);
  assert.throws(() => makeGoalPositionPacket(1, 4096), RangeError);
});

test("builds individual torque enable and disable packets", async () => {
  assert.deepEqual(
    [...makeTorqueEnablePacket(1, false)],
    [0xff, 0xff, 1, 4, 3, 40, 0, 207],
  );
  assert.deepEqual(
    [...makeTorqueEnablePacket(15, true)],
    [0xff, 0xff, 15, 4, 3, 40, 1, 192],
  );
  assert.throws(() => makeTorqueEnablePacket(0, false), RangeError);
  assert.throws(() => makeTorqueEnablePacket(254, false), RangeError);
  assert.throws(() => makeTorqueEnablePacket(1, 0), TypeError);

  const writes = [];
  const bus = new FeetechSerialBus({});
  bus.reader = {};
  bus.writer = { write: async (packet) => writes.push([...packet]) };
  await bus.setTorqueEnabled(1, false);
  assert.deepEqual(writes, [[0xff, 0xff, 1, 4, 3, 40, 0, 207]]);
});

test("builds a Feetech sync goal-position packet for multiple servos", () => {
  const packet = makeSyncGoalPositionPacket([
    { id: 1, position: 2048 },
    { id: 15, position: 4095 },
  ]);
  assert.deepEqual(
    [...packet],
    [0xff, 0xff, 0xfe, 10, 0x83, 42, 2, 1, 0, 8, 15, 255, 15, 34],
  );
  const checksum = (~packet.subarray(2, -1).reduce((sum, byte) => sum + byte, 0)) & 0xff;
  assert.equal(checksum, packet.at(-1));
  assert.throws(() => makeSyncGoalPositionPacket([]), RangeError);
  assert.throws(() => makeSyncGoalPositionPacket([{ id: 1, position: 0 }, { id: 1, position: 1 }]), RangeError);
  assert.throws(() => makeSyncGoalPositionPacket([{ id: 254, position: 0 }]), RangeError);
  assert.throws(() => makeSyncGoalPositionPacket([{ id: 1, position: 4096 }]), RangeError);
});

test("parses a valid little-endian position response and checks its checksum", () => {
  const packet = statusPacket(15, 0, 0x0abc);
  assert.equal(parsePositionStatusPacket(packet, 15), 0x0abc);
  packet[7] ^= 1;
  assert.equal(parsePositionStatusPacket(packet, 15), null);
  assert.equal(parsePositionStatusPacket(statusPacket(2, 0, 123), 1), null);
});

test("reports a valid servo status error separately from a malformed packet", () => {
  assert.throws(
    () => parsePositionStatusPacket(statusPacket(3, 4, 0), 3),
    (error) => error instanceof ServoStatusError && error.status === 4,
  );
});

test("converts 12-bit single-turn positions to radians around center", () => {
  assert.equal(servoPositionToRadians(2048), 0);
  assert.equal(servoPositionToRadians(0), -Math.PI);
  assert.equal(servoPositionToRadians(4095), Math.PI * (1 - 1 / 2048));
  assert.equal(servoPositionToRadians(4096), -Math.PI);
  assert.equal(servoPositionToRadians(0xffff), servoPositionToRadians(4095));
  assert.throws(() => servoPositionToRadians(0x10000), RangeError);
});

test("converts radians to wrapped 12-bit single-turn servo positions", () => {
  assert.equal(radiansToServoPosition(0), 2048);
  assert.equal(radiansToServoPosition(-Math.PI), 0);
  assert.equal(radiansToServoPosition(Math.PI), 0);
  assert.equal(radiansToServoPosition(Math.PI / 2), 3072);
  assert.throws(() => radiansToServoPosition(Number.NaN), RangeError);
});

test("inverts joint mapping and enforces per-servo output limits", () => {
  assert.equal(
    simulatorAngleToServoPosition(15 * Math.PI / 180, { offsetDeg: 5 }),
    2162,
  );
  assert.equal(
    simulatorAngleToServoPosition(15 * Math.PI / 180, { offsetDeg: 5, reversed: true }),
    1934,
  );
  assert.equal(
    simulatorAngleToServoPosition(30 * Math.PI / 180, { minDeg: -5, maxDeg: 5 }),
    2105,
  );
  assert.throws(
    () => simulatorAngleToServoPosition(0, { minDeg: 5, maxDeg: 5 }),
    RangeError,
  );
});

test("assembles fragmented position responses from the serial stream", () => {
  const bus = new FeetechSerialBus({});
  const packet = statusPacket(7, 0, 2048);
  let result;
  bus.waiters.set(7, {
    resolve: (position) => { result = position; },
    reject: (error) => { throw error; },
  });

  bus.consume(packet.slice(0, 3));
  assert.equal(result, undefined);
  bus.consume(packet.slice(3));
  assert.equal(result, 2048);
  assert.equal(bus.waiters.size, 0);
});
