import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import { JOINT_NAMES } from "../game/constants.js";
import {
  FeetechSerialBus,
  ServoStatusError,
  ServoTimeoutError,
  simulatorAngleToServoPosition,
  servoPositionToRadians,
} from "../game/feetech-serial.js";
import { gameApi, useGame } from "../store.js";
import { MONO, ORANGE } from "../theme.js";
import { ANTON, COMIC_INK, CREAM } from "./comic.jsx";

const CONFIG_KEY = "microduck.feetech-servo-debug.v1";
const MAX_SERVO_ID = 253;
const OUTPUT_HZ_OPTIONS = [1, 2, 5, 10, 20, 30, 40, 50];
const SERVO_JOINTS = [...JOINT_NAMES, "jaw"];
const DEFAULT_OUTPUT_LIMITS = {
  left_hip_yaw: [-25, 40],
  left_hip_roll: [-15, 20],
  left_hip_pitch: [-150, 69],
  left_knee: [-90, 100],
  left_ankle: [-65, 70],
  neck_pitch: [-150, 65],
  head_pitch: [-85, 85],
  head_yaw: [-140, 140],
  head_roll: [-20, 25],
  right_hip_yaw: [-25, 40],
  right_hip_roll: [-15, 20],
  right_hip_pitch: [-150, 69],
  right_knee: [-90, 100],
  right_ankle: [-65, 70],
  jaw: [-10, 10],
};

function defaultConfig() {
  return {
    baudRate: 1_000_000,
    pollHz: 20,
    outputHz: 5,
    joints: Object.fromEntries(SERVO_JOINTS.map((name, i) => [name, {
      id: i + 1,
      offsetDeg: 0,
      reversed: false,
      outputMinDeg: DEFAULT_OUTPUT_LIMITS[name][0],
      outputMaxDeg: DEFAULT_OUTPUT_LIMITS[name][1],
    }])),
  };
}

function readConfig() {
  const fallback = defaultConfig();
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return fallback;
    const joints = Object.fromEntries(SERVO_JOINTS.map((name, i) => {
      const entry = parsed.joints?.[name];
      const id = entry?.id === null ? null
        : Number.isInteger(entry?.id) && entry.id >= 0 && entry.id <= MAX_SERVO_ID ? entry.id
          : fallback.joints[name].id;
      const offsetDeg = Number.isFinite(entry?.offsetDeg) ? entry.offsetDeg : 0;
      const outputMinDeg = Number.isFinite(entry?.outputMinDeg)
        && entry.outputMinDeg >= -180 && entry.outputMinDeg <= 180
        ? entry.outputMinDeg
        : fallback.joints[name].outputMinDeg;
      const outputMaxDeg = Number.isFinite(entry?.outputMaxDeg)
        && entry.outputMaxDeg >= -180 && entry.outputMaxDeg <= 180
        ? entry.outputMaxDeg
        : fallback.joints[name].outputMaxDeg;
      return [name, {
        id,
        offsetDeg,
        reversed: entry?.reversed === true,
        outputMinDeg: outputMinDeg < outputMaxDeg
          ? outputMinDeg
          : fallback.joints[name].outputMinDeg,
        outputMaxDeg: outputMinDeg < outputMaxDeg
          ? outputMaxDeg
          : fallback.joints[name].outputMaxDeg,
      }];
    }));
    return {
      baudRate: [500_000, 1_000_000, 2_000_000].includes(parsed.baudRate)
        ? parsed.baudRate
        : fallback.baudRate,
      pollHz: [5, 10, 20, 30, 40].includes(parsed.pollHz) ? parsed.pollHz : fallback.pollHz,
      outputHz: OUTPUT_HZ_OPTIONS.includes(parsed.outputHz) ? parsed.outputHz : 5,
      joints,
    };
  } catch {
    return fallback;
  }
}

function getOutputMappings(settings) {
  const seenIds = new Set();
  return SERVO_JOINTS.flatMap((name) => {
    const mapping = { name, ...settings.joints[name] };
    if (mapping.id === null || seenIds.has(mapping.id)) return [];
    seenIds.add(mapping.id);
    return [mapping];
  });
}

function fmtAngle(value) {
  return Number.isFinite(value) ? `${(value * 180 / Math.PI).toFixed(1)}°` : "—";
}

const buttonSx = {
  appearance: "none",
  border: `1px solid ${CREAM}`,
  borderRadius: 0,
  px: 1,
  py: 0.55,
  color: CREAM,
  background: "rgba(8, 8, 12, 0.92)",
  cursor: "pointer",
  fontFamily: ANTON,
  fontSize: "0.78rem",
  letterSpacing: "0.08em",
  "&:hover": { color: ORANGE, borderColor: ORANGE },
  "&:disabled": { opacity: 0.45, cursor: "not-allowed" },
};

export default function ServoDebug() {
  const entered = useGame((s) => s.entered);
  const loco = useGame((s) => s.loco);
  const externalServoFollowing = useGame((s) => s.externalServoFollowing);
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState(readConfig);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [outputArmed, setOutputArmed] = useState(false);
  const [emergencyStopping, setEmergencyStopping] = useState(false);
  const [outputStatus, setOutputStatus] = useState("OUTPUT DISABLED");
  const [readings, setReadings] = useState({});
  const [online, setOnline] = useState({});
  const [servoErrors, setServoErrors] = useState({});
  const [scanCount, setScanCount] = useState(0);
  const busRef = useRef(null);
  const activeRef = useRef(false);
  const outputArmedRef = useRef(false);
  const lastOutputAtRef = useRef(0);
  const missedOutputReadsRef = useRef({});
  const lastOutputStatusAtRef = useRef(0);
  const configRef = useRef(config);
  const readingsRef = useRef(readings);
  const onlineRef = useRef({});

  useEffect(() => {
    configRef.current = config;
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (err) {
      setError(`Cannot save servo settings: ${err.message}`);
    }
  }, [config]);

  useEffect(() => {
    readingsRef.current = readings;
  }, [readings]);

  useEffect(() => {
    if (outputArmedRef.current && (externalServoFollowing || !connected)) {
      outputArmedRef.current = false;
      setOutputArmed(false);
      setOutputStatus("OUTPUT STOPPED: connection or simulator mode changed.");
    }
  }, [connected, externalServoFollowing, loco]);

  const mappedAngles = (positions, settings) => {
    const angles = {};
    for (const name of SERVO_JOINTS) {
      const { id, offsetDeg, reversed } = settings.joints[name];
      if (id === null || !Number.isInteger(positions[id])) {
        angles[name] = null;
        continue;
      }
      const direction = reversed ? -1 : 1;
      angles[name] = direction * servoPositionToRadians(positions[id]) + offsetDeg * Math.PI / 180;
    }
    return angles;
  };

  const scanLoop = async (bus) => {
    while (activeRef.current && busRef.current === bus) {
      const settings = configRef.current;
      const startedAt = performance.now();
      const nextReadings = {};
      const nextOnline = {};
      const nextErrors = {};

      const servoIds = [...new Set(
        SERVO_JOINTS.map((name) => settings.joints[name].id)
          .filter((id) => Number.isInteger(id) && id >= 0 && id <= MAX_SERVO_ID),
      )];
      for (const id of servoIds) {
        if (!activeRef.current || busRef.current !== bus) return;
        try {
          nextReadings[id] = await bus.readPosition(id);
          nextOnline[id] = true;
        } catch (err) {
          if (err instanceof ServoTimeoutError) {
            nextOnline[id] = false;
          } else if (err instanceof ServoStatusError) {
            nextOnline[id] = true;
            nextErrors[id] = err.message;
          } else {
            throw err;
          }
        }
      }

      if (!activeRef.current || busRef.current !== bus) return;
      const mergedReadings = { ...readingsRef.current, ...nextReadings };
      readingsRef.current = mergedReadings;
      setReadings(mergedReadings);
      setOnline(nextOnline);
      onlineRef.current = nextOnline;
      setServoErrors(nextErrors);
      setScanCount((count) => count + 1);
      if (useGame.getState().externalServoFollowing) {
        gameApi.setExternalServoPose(true, mappedAngles(mergedReadings, settings));
      }
      const outputMappings = getOutputMappings(settings);
      if (outputArmedRef.current) {
        for (const { id } of outputMappings) {
          if (nextOnline[id] && Number.isInteger(nextReadings[id])) {
            delete missedOutputReadsRef.current[id];
          } else {
            missedOutputReadsRef.current[id] = (missedOutputReadsRef.current[id] ?? 0) + 1;
            if (missedOutputReadsRef.current[id] >= 3) {
              stopOutput(`OUTPUT STOPPED: servo #${id} missed 3 consecutive position reads.`);
              break;
            }
          }
        }
      }
      const interval = 1000 / settings.pollHz;
      const delay = Math.max(0, interval - (performance.now() - startedAt));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };

  const outputLoop = async (bus) => {
    while (activeRef.current && busRef.current === bus) {
      const settings = configRef.current;
      const startedAt = performance.now();
      const outputInterval = 1000 / settings.outputHz;
      const rateLimitWait = outputArmedRef.current && lastOutputAtRef.current > 0
        ? outputInterval - (startedAt - lastOutputAtRef.current)
        : 0;
      if (rateLimitWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, rateLimitWait));
        continue;
      }
      if (outputArmedRef.current) {
        const outputMappings = getOutputMappings(settings);
        if (useGame.getState().externalServoFollowing) {
          stopOutput("OUTPUT STOPPED: real-servo follow mode is active.");
        } else if (outputMappings.length === 0 || outputMappings.some(({ id, outputMinDeg, outputMaxDeg }) => (
          !Number.isInteger(id) || id < 1 || id > MAX_SERVO_ID
          || !Number.isFinite(outputMinDeg) || !Number.isFinite(outputMaxDeg)
          || outputMinDeg < -180 || outputMaxDeg > 180 || outputMinDeg >= outputMaxDeg
        ))) {
          stopOutput("OUTPUT STOPPED: check servo IDs and angle limits.");
        } else {
          const unavailable = outputMappings.filter(({ id }) => (
            !onlineRef.current[id] || !Number.isInteger(readingsRef.current[id])
          ));
          if (unavailable.length) {
            if (performance.now() - lastOutputStatusAtRef.current >= 250) {
              lastOutputStatusAtRef.current = performance.now();
              const details = unavailable.map(({ id }) => (
                `#${id} (${missedOutputReadsRef.current[id] ?? 0}/3)`
              )).join(", ");
              setOutputStatus(`OUTPUT HOLD · waiting for fresh position reads: ${details}`);
            }
          } else {
            const simPose = gameApi.getJointAngles?.() ?? {};
            const targets = outputMappings.map((mapping) => {
              const simAngle = simPose[mapping.name];
              if (!Number.isFinite(simAngle)) {
                throw new Error(`No simulator angle is available for ${mapping.name}.`);
              }
              const position = simulatorAngleToServoPosition(simAngle, {
                offsetDeg: mapping.offsetDeg,
                reversed: mapping.reversed,
                minDeg: mapping.outputMinDeg,
                maxDeg: mapping.outputMaxDeg,
              });
              return { id: mapping.id, position, name: mapping.name, simAngle };
            });

            await bus.writeSyncGoalPositions(targets);
            if (outputArmedRef.current && activeRef.current && busRef.current === bus) {
              const sentAt = performance.now();
              const actualHz = lastOutputAtRef.current > 0
                ? (1000 / (sentAt - lastOutputAtRef.current)).toFixed(1)
                : "measuring";
              lastOutputAtRef.current = sentAt;
              if (sentAt - lastOutputStatusAtRef.current >= 250) {
                lastOutputStatusAtRef.current = sentAt;
                const summary = targets.map(({ id, position, name, simAngle }) => {
                  const targetDeg = servoPositionToRadians(position) * 180 / Math.PI;
                  return `#${id} ${name}: ${(simAngle * 180 / Math.PI).toFixed(1)}° → ${targetDeg.toFixed(1)}° [${position}]`;
                }).join(" · ");
                setOutputStatus(
                  `OUTPUT ACTIVE · target ${settings.outputHz} Hz · actual ${actualHz} Hz · sent ${targets.length}/${outputMappings.length}: ${summary}`,
                );
              }
            }
          }
        }
      }

      const interval = outputArmedRef.current ? outputInterval : 100;
      const delay = Math.max(0, interval - (performance.now() - startedAt));
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };

  const stopOutput = (status = "OUTPUT STOPPED · no further position commands will be sent.") => {
    outputArmedRef.current = false;
    setOutputArmed(false);
    setOutputStatus(status);
    lastOutputAtRef.current = 0;
  };

  const emergencyStop = async () => {
    stopOutput("E-STOP ACTIVE · stopping position output and disabling servo torque.");
    setError("");
    const bus = busRef.current;
    if (!bus || !connected) {
      setOutputStatus("E-STOP LOCKED · no serial connection; torque-disable commands could not be sent.");
      setError("Software output is stopped, but no serial connection is available to disable servo torque.");
      return;
    }

    setEmergencyStopping(true);
    const configuredIds = SERVO_JOINTS
      .map((name) => configRef.current.joints[name].id)
      .filter((id) => id !== null);
    const ids = [...new Set(configuredIds.filter((id) => (
      Number.isInteger(id) && id >= 1 && id <= MAX_SERVO_ID
    )))];
    const invalidIds = configuredIds.filter((id) => (
      !Number.isInteger(id) || id < 1 || id > MAX_SERVO_ID
    ));
    const failures = [];

    try {
      for (const id of ids) {
        try {
          await bus.setTorqueEnabled(id, false);
        } catch (err) {
          failures.push(`#${id}: ${err.message}`);
        }
      }
      const skipped = invalidIds.length ? ` Invalid/broadcast IDs skipped: ${[...new Set(invalidIds)].join(", ")}.` : "";
      if (failures.length) {
        const details = failures.join("; ");
        setOutputStatus(`E-STOP PARTIAL · torque-off command failed for ${details}.${skipped}`);
        setError(`Could not send torque-disable command to every servo: ${details}`);
      } else if (!ids.length) {
        setOutputStatus(`E-STOP LOCKED · no individual servo IDs to disable.${skipped}`);
        setError("Position output is stopped, but no valid individual servo IDs are configured.");
      } else {
        setOutputStatus(`E-STOP SENT · torque-disable command sent to ${ids.map((id) => `#${id}`).join(", ")}.${skipped} Servo torque state is not read back.`);
      }
    } finally {
      setEmergencyStopping(false);
    }
  };

  const enableOutput = () => {
    setError("");
    const mappings = getOutputMappings(configRef.current);
    const ids = mappings.map(({ id }) => id);
    if (!connected || !running) {
      setError("Connect to the servo bus before enabling position output.");
      return;
    }
    if (externalServoFollowing) {
      setError("Stop real-servo following before enabling simulator-to-servo output.");
      return;
    }
    if (mappings.length === 0 || ids.some((id) => !Number.isInteger(id) || id < 1 || id > MAX_SERVO_ID)) {
      setError("Output requires mapped servo IDs from 1 to 253; ID 0 is broadcast and cannot be used.");
      return;
    }
    if (mappings.some(({ outputMinDeg, outputMaxDeg }) => (
      !Number.isFinite(outputMinDeg)
      || !Number.isFinite(outputMaxDeg)
      || outputMinDeg < -180
      || outputMaxDeg > 180
      || outputMinDeg >= outputMaxDeg
    ))) {
      setError("Every output angle range must be valid, ordered, and within -180° to 180°.");
      return;
    }
    if (mappings.some(({ id }) => !online[id] || !Number.isInteger(readingsRef.current[id]))) {
      setError("Every mapped servo must be online and have a fresh position reading before arming.");
      return;
    }
    if (!window.confirm(
      "This will move real servos using the simulator pose. Verify the wiring, IDs, direction, zero offsets, and mechanical clearance first. Continue?",
    )) return;
    outputArmedRef.current = true;
    lastOutputAtRef.current = 0;
    setOutputArmed(true);
    setOutputStatus("OUTPUT ARMED · waiting for fresh servo readings.");
  };

  const disconnect = async () => {
    const bus = busRef.current;
    stopOutput("OUTPUT STOPPED · serial connection closed.");
    activeRef.current = false;
    busRef.current = null;
    setRunning(false);
    setConnected(false);
    if (useGame.getState().externalServoFollowing) {
      gameApi.setExternalServoPose(false);
    }
    if (bus) {
      try {
        await bus.close();
      } catch (err) {
        setError(`Could not close serial port: ${err.message}`);
      }
    }
  };

  const connect = async () => {
    setError("");
    if (!("serial" in navigator)) {
      setError("Web Serial is unavailable. Open this page in desktop Chrome or Edge via localhost.");
      return;
    }
    let bus;
    try {
      const port = await navigator.serial.requestPort();
      bus = new FeetechSerialBus(port, (err) => {
        if (activeRef.current) {
          stopOutput(`OUTPUT STOPPED · serial read failed: ${err.message}`);
          setError(`Serial read failed: ${err.message}`);
        }
      });
      await bus.open(configRef.current.baudRate);
      busRef.current = bus;
      activeRef.current = true;
      setConnected(true);
      setRunning(true);
      onlineRef.current = {};
      void outputLoop(bus).catch((err) => {
        if (busRef.current !== bus) return;
        stopOutput(`OUTPUT STOPPED · ${err.message}`);
        setError(`Servo output failed: ${err.message}`);
      });
      setOutputStatus("CONNECTED · simulator remains active; enable follow explicitly if needed.");
      void scanLoop(bus).catch(async (err) => {
        if (busRef.current !== bus) return;
        stopOutput(`OUTPUT STOPPED · ${err.message}`);
        setError(`Servo polling stopped: ${err.message}`);
        await disconnect();
      });
    } catch (err) {
      activeRef.current = false;
      if (bus) {
        try {
          await bus.close();
        } catch (closeErr) {
          setError(`Could not close serial port: ${closeErr.message}`);
        }
      }
      if (busRef.current === bus) busRef.current = null;
      setRunning(false);
      setConnected(false);
      setError(err.message || String(err));
    }
  };

  const toggleFollow = () => {
    if (outputArmedRef.current) {
      setError("Stop real-servo output before changing follow mode.");
      return;
    }
    if (externalServoFollowing) {
      gameApi.setExternalServoPose(false);
      return;
    }
    if (loco !== "legs") {
      setError("Switch to leg mode before following servo positions.");
      return;
    }
    gameApi.setExternalServoPose(true, mappedAngles(readingsRef.current, configRef.current));
    setError("");
  };

  useEffect(() => () => {
    outputArmedRef.current = false;
    activeRef.current = false;
    const bus = busRef.current;
    busRef.current = null;
    if (useGame.getState().externalServoFollowing) gameApi.setExternalServoPose(false);
    if (bus) void bus.close();
  }, []);

  if (!entered) return null;

  const simAngles = gameApi.getJointAngles?.() ?? {};
  const outOfRangeMappings = getOutputMappings(config).filter(({ id, outputMinDeg, outputMaxDeg }) => {
    if (!online[id] || !Number.isInteger(readings[id])) return false;
    const currentDeg = servoPositionToRadians(readings[id]) * 180 / Math.PI;
    return currentDeg < outputMinDeg || currentDeg > outputMaxDeg;
  });
  const setJointConfig = (name, patch) => setConfig((current) => ({
    ...current,
    joints: { ...current.joints, [name]: { ...current.joints[name], ...patch } },
  }));

  return (
    <>
      <Box
        component="button"
        type="button"
        onClick={() => setOpen((value) => !value)}
        sx={{ ...buttonSx, position: "fixed", top: "1.25rem", right: "1.5rem", zIndex: 12 }}
      >
        SERVO DEBUG{connected ? " · LIVE" : ""}
      </Box>
      {open && (
        <Box
          sx={{
            position: "fixed",
            top: "4.2rem",
            right: "1.5rem",
            zIndex: 15,
            width: "min(680px, calc(100vw - 2rem))",
            maxHeight: "calc(100vh - 6rem)",
            overflow: "auto",
            p: 1.5,
            border: `2px solid ${CREAM}`,
            background: "rgba(8, 8, 12, 0.97)",
            color: CREAM,
            fontFamily: MONO,
            fontSize: "0.68rem",
            boxShadow: `4px 4px 0 ${COMIC_INK}`,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 1 }}>
            <Box sx={{ fontFamily: ANTON, fontSize: "1rem", letterSpacing: "0.08em" }}>
              FEETECH · SERVO DEBUG
            </Box>
            <Box component="button" type="button" onClick={() => setOpen(false)} sx={buttonSx}>
              CLOSE
            </Box>
          </Box>
          <Box sx={{ color: "rgba(250,248,242,.65)", mb: 1 }}>
            Output is disabled until explicitly armed. Web Serial requires desktop Chrome/Edge.
          </Box>
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1, mb: 1 }}>
            {!connected ? (
              <Box component="button" type="button" onClick={connect} sx={buttonSx}>
                CONNECT PORT
              </Box>
            ) : (
              <Box component="button" type="button" onClick={disconnect} sx={buttonSx}>
                DISCONNECT
              </Box>
            )}
            <Box component="label" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              BAUD
              <select
                value={config.baudRate}
                disabled={connected}
                onChange={(event) => setConfig((current) => ({ ...current, baudRate: Number(event.target.value) }))}
                style={{ color: CREAM, background: "#08080c", border: `1px solid ${CREAM}`, padding: "4px" }}
              >
                {[500_000, 1_000_000, 2_000_000].map((rate) => (
                  <option key={rate} value={rate}>{rate.toLocaleString()}</option>
                ))}
              </select>
            </Box>
            <Box component="label" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
              TARGET Hz
              <select
                value={config.pollHz}
                onChange={(event) => setConfig((current) => ({ ...current, pollHz: Number(event.target.value) }))}
                style={{ color: CREAM, background: "#08080c", border: `1px solid ${CREAM}`, padding: "4px" }}
              >
                {[5, 10, 20, 30, 40].map((rate) => <option key={rate} value={rate}>{rate}</option>)}
              </select>
            </Box>
            <Box sx={{ color: connected ? ORANGE : "rgba(250,248,242,.6)" }}>
              {connected
                ? `${scanCount} scans · ${Object.values(online).filter(Boolean).length}/${Object.keys(online).length} online`
                : "DISCONNECTED"}
            </Box>
          </Box>
          <Box
            component="button"
            type="button"
            disabled={!connected || loco !== "legs" || !running || outputArmed}
            onClick={toggleFollow}
            sx={{
              ...buttonSx,
              mb: 1,
              color: externalServoFollowing ? COMIC_INK : CREAM,
              background: externalServoFollowing ? ORANGE : "rgba(8,8,12,.92)",
              borderColor: externalServoFollowing ? ORANGE : CREAM,
            }}
          >
            {externalServoFollowing ? "STOP FOLLOWING · SIM AI PAUSED" : "FOLLOW REAL JOINTS IN SIM"}
          </Box>
          {loco !== "legs" && <Box sx={{ color: ORANGE, mb: 1 }}>Real-pose following is available in leg mode only; simulator-to-servo output remains available in both modes.</Box>}
          <Box sx={{ border: `1px solid ${outputArmed ? ORANGE : "rgba(250,248,242,.28)"}`, p: 1, mb: 1 }}>
            <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}>
              <Box
                component="button"
                type="button"
                disabled={!connected || !running || outputArmed}
                onClick={enableOutput}
                sx={buttonSx}
              >
                ENABLE SIM → SERVO OUTPUT
              </Box>
              <Box
                component="button"
                type="button"
                disabled={!connected || emergencyStopping}
                onClick={emergencyStop}
                sx={{
                  ...buttonSx,
                  color: emergencyStopping ? ORANGE : "#ff8a80",
                  borderColor: emergencyStopping ? ORANGE : "#ff8a80",
                }}
              >
                {emergencyStopping ? "SENDING TORQUE OFF…" : "E-STOP · STOP + TORQUE OFF"}
              </Box>
              <Box component="label" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
                OUTPUT Hz MAX
                <select
                  value={config.outputHz}
                  disabled={outputArmed}
                  onChange={(event) => setConfig((current) => ({ ...current, outputHz: Number(event.target.value) }))}
                  style={{ color: CREAM, background: "#08080c", border: `1px solid ${CREAM}`, padding: "4px" }}
                >
                  {OUTPUT_HZ_OPTIONS.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
                </select>
              </Box>
            </Box>
            <Box role={outputArmed ? "status" : "note"} sx={{ color: outputArmed ? ORANGE : "rgba(250,248,242,.65)", mt: 0.75 }}>
              {outputStatus}
            </Box>
            <Box sx={{ color: "rgba(250,248,242,.55)", mt: 0.5 }}>
                Limits are servo angles relative to center count 2048 (default ±10°) and clamp output targets; a real servo's current angle may be outside its configured range. If multiple joints share an ID, only its first joint mapping in the list controls that servo; its output limits apply. E-stop stops subsequent position writes, then sends Torque Enable=0 (register 40) to each configured individual ID. The command is not acknowledged/read back; a servo or bus failure may prevent torque release. This is not a hardware power cut.
            </Box>
            <Box sx={{ color: "rgba(250,248,242,.55)", mt: 0.5 }}>
                Output frequency is the target rate for Sync Write frames; bus load can lower the measured rate. Sync Write is broadcast and does not acknowledge individual servo acceptance.
            </Box>
            {outOfRangeMappings.length > 0 && (
                <Box role="status" sx={{ color: ORANGE, mt: 0.5 }}>
                  PRESENT POSITION OUTSIDE OUTPUT LIMITS: {outOfRangeMappings.map(({ name, id }) => `${name} (#${id})`).join(", ")}. Output may still be enabled; simulator targets remain clamped to the configured limits.
                </Box>
            )}
          </Box>
          {error && <Box role="alert" sx={{ color: "#ff8a80", mb: 1 }}>{error}</Box>}
          <Box sx={{ overflowX: "auto" }}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(95px, 1.1fr) 48px 62px 34px 55px 55px 48px 64px 55px",
                gap: "4px",
                minWidth: 590,
                alignItems: "center",
              }}
            >
              {["MODEL JOINT", "SERVO ID", "OFFSET°", "REV", "OUT MIN°", "OUT MAX°", "RAW", "MAPPED", "SIM Δ"].map((label) => (
                <Box key={label} sx={{ color: "rgba(250,248,242,.55)", py: 0.5 }}>{label}</Box>
              ))}
              {SERVO_JOINTS.map((name) => {
                const mapping = config.joints[name];
                const raw = mapping.id === null ? null : readings[mapping.id];
                const mapped = Number.isInteger(raw)
                  ? (mapping.reversed ? -1 : 1) * servoPositionToRadians(raw) + mapping.offsetDeg * Math.PI / 180
                  : null;
                const sim = simAngles[name];
                const delta = Number.isFinite(mapped) && Number.isFinite(sim) ? (mapped - sim) * 180 / Math.PI : null;
                return (
                  <Box key={name} sx={{ display: "contents" }}>
                    <Box sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</Box>
                    <input
                      aria-label={`${name} servo ID`}
                      disabled={outputArmed}
                      type="number"
                      min="0"
                      max={MAX_SERVO_ID}
                      step="1"
                      placeholder="—"
                      value={mapping.id ?? ""}
                      onChange={(event) => {
                        if (event.target.value === "") {
                          setJointConfig(name, { id: null });
                          setError("");
                          return;
                        }
                        const value = Number(event.target.value);
                        if (Number.isInteger(value) && value >= 0 && value <= MAX_SERVO_ID) {
                          setJointConfig(name, { id: value });
                          setError("");
                        } else {
                          setError(`Servo ID must be an integer from 0 to ${MAX_SERVO_ID}.`);
                        }
                      }}
                      style={{ width: "100%", color: CREAM, background: "#08080c", border: `1px solid ${COMIC_INK}`, padding: "3px" }}
                    />
                    <input
                      aria-label={`${name} zero offset degrees`}
                      type="number"
                      step="1"
                      value={mapping.offsetDeg}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value)) setJointConfig(name, { offsetDeg: value });
                      }}
                      style={{ width: "100%", color: CREAM, background: "#08080c", border: `1px solid ${COMIC_INK}`, padding: "3px" }}
                    />
                    <input
                      aria-label={`${name} reverse direction`}
                      disabled={outputArmed}
                      type="checkbox"
                      checked={mapping.reversed}
                      onChange={(event) => setJointConfig(name, { reversed: event.target.checked })}
                    />
                    <input
                      aria-label={`${name} output minimum degrees`}
                      type="number"
                      min="-180"
                      max="180"
                      step="1"
                      value={mapping.outputMinDeg}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value) && value >= -180 && value < mapping.outputMaxDeg) {
                          setJointConfig(name, { outputMinDeg: value });
                        }
                      }}
                      style={{ width: "100%", color: CREAM, background: "#08080c", border: `1px solid ${COMIC_INK}`, padding: "3px" }}
                    />
                    <input
                      aria-label={`${name} output maximum degrees`}
                      type="number"
                      min="-180"
                      max="180"
                      step="1"
                      value={mapping.outputMaxDeg}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value) && value <= 180 && value > mapping.outputMinDeg) {
                          setJointConfig(name, { outputMaxDeg: value });
                        }
                      }}
                      style={{ width: "100%", color: CREAM, background: "#08080c", border: `1px solid ${COMIC_INK}`, padding: "3px" }}
                    />
                    <Box sx={{ color: mapping.id !== null && online[mapping.id] ? CREAM : "rgba(250,248,242,.35)" }}>
                      {Number.isInteger(raw) ? raw : "—"}
                    </Box>
                    <Box>{fmtAngle(mapped)}</Box>
                    <Box sx={{ color: Number.isFinite(delta) && Math.abs(delta) > 5 ? ORANGE : "rgba(250,248,242,.65)" }}>
                      {Number.isFinite(delta) ? `${delta.toFixed(1)}°` : "—"}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
          <Box sx={{ color: "rgba(250,248,242,.48)", mt: 1 }}>
            Servo IDs are independently editable from 0 to 253; clear an ID to leave that joint unmapped. Defaults map 1–14 to policy joints and 15 to the jaw.
            Raw angle assumes 4096 ticks/revolution with center 2048. Configure offset and direction per joint.
          </Box>
          <Box sx={{ mt: 1, color: "rgba(250,248,242,.65)" }}>ALL BUS POSITIONS</Box>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mt: 0.5 }}>
            {[...new Set(SERVO_JOINTS.map((name) => config.joints[name].id)
              .filter((id) => Number.isInteger(id) && id >= 0 && id <= MAX_SERVO_ID))].map((id) => (
              <Box
                key={id}
                sx={{
                  border: `1px solid ${online[id] ? "rgba(250,248,242,.35)" : "rgba(250,248,242,.12)"}`,
                  px: 0.75,
                  py: 0.35,
                  color: online[id] ? CREAM : "rgba(250,248,242,.35)",
                }}
              >
                #{id} {Number.isInteger(readings[id])
                  ? `${readings[id]} · ${fmtAngle(servoPositionToRadians(readings[id]))}`
                  : servoErrors[id] ?? "—"}
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </>
  );
}
