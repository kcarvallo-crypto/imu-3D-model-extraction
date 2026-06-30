/* global THREE */
/* global TransformStream */
/* global TextEncoderStream */
/* global TextDecoderStream */
'use strict';

import * as THREE from 'three';
import {OBJLoader} from 'objloader';

// ===============================
// SERIAL CONNECTION VARIABLES
// ===============================

let port;
let reader;
let inputDone;
let outputDone;
let inputStream;
let outputStream;
let showCalibration = false;

// ===============================
// IMU DATA VARIABLES
// ===============================

let orientation = [0, 0, 0]; // [heading, roll, pitch]
let quaternion = [1, 0, 0, 0]; // [w, x, y, z]
let calibration = [0, 0, 0, 0]; // [system, gyro, accelerometer, magnetometer]

// ===============================
// SYNCED CSV + VIDEO RECORDING VARIABLES
// ===============================

let recordedData = [];
let latestOrientation = [0, 0, 0];
let latestQuaternion = [1, 0, 0, 0];
let latestCalibration = [0, 0, 0, 0];

// Important: CSV recording starts ONLY when synced recording starts.
let recordingEnabled = false;

// These make the CSV and video match.
let recordingStartTimeMs = null;
let recordingStopTimeMs = null;
let recordingId = null;

// Video recording variables.
let mediaRecorder;
let recordedVideoChunks = [];
let videoRecording = false;

// ===============================
// PAGE ELEMENTS
// ===============================

const maxLogLength = 100;
const baudRates = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000, 2000000];

const log = document.getElementById('log');
const butConnect = document.getElementById('butConnect');
const butClear = document.getElementById('butClear');
const baudRate = document.getElementById('baudRate');
const autoscroll = document.getElementById('autoscroll');
const showTimestamp = document.getElementById('showTimestamp');
const angleType = document.getElementById('angle_type');
const lightSS = document.getElementById('light');
const darkSS = document.getElementById('dark');
const darkMode = document.getElementById('darkmode');
const canvas = document.querySelector('#canvas');
const calContainer = document.getElementById('calibration');
const logContainer = document.getElementById("log-container");

fitToContainer(canvas);

function fitToContainer(canvas) {
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
}

// ===============================
// PAGE STARTUP
// ===============================

document.addEventListener('DOMContentLoaded', async () => {
  butConnect.addEventListener('click', clickConnect);
  butClear.addEventListener('click', clickClear);
  autoscroll.addEventListener('click', clickAutoscroll);
  showTimestamp.addEventListener('click', clickTimestamp);
  baudRate.addEventListener('change', changeBaudRate);
  angleType.addEventListener('change', changeAngleType);
  darkMode.addEventListener('click', clickDarkMode);

  addRecordingButtons();

  if ('serial' in navigator) {
    const notSupported = document.getElementById('notSupported');
    notSupported.classList.add('hidden');
  }

  if (isWebGLAvailable()) {
    const webGLnotSupported = document.getElementById('webGLnotSupported');
    webGLnotSupported.classList.add('hidden');
  }

  initBaudRate();
  loadAllSettings();
  updateTheme();
  await finishDrawing();
  await render();
});

// ===============================
// BUTTON CREATION
// ===============================

function addRecordingButtons() {
  const startSyncedButton = document.createElement('button');
  startSyncedButton.id = 'startSyncedRecording';
  startSyncedButton.textContent = 'Start Synced Recording';
  startSyncedButton.style.marginLeft = '10px';
  startSyncedButton.addEventListener('click', startSyncedRecording);

  const stopSyncedButton = document.createElement('button');
  stopSyncedButton.id = 'stopSyncedRecording';
  stopSyncedButton.textContent = 'Stop Synced Recording';
  stopSyncedButton.style.marginLeft = '5px';
  stopSyncedButton.disabled = true;
  stopSyncedButton.addEventListener('click', stopSyncedRecording);

  const downloadButton = document.createElement('button');
  downloadButton.id = 'downloadCSV';
  downloadButton.textContent = 'Download CSV';
  downloadButton.style.marginLeft = '5px';
  downloadButton.addEventListener('click', downloadCSV);

  const clearRecordedButton = document.createElement('button');
  clearRecordedButton.id = 'clearRecordedData';
  clearRecordedButton.textContent = 'Clear Recorded Data';
  clearRecordedButton.style.marginLeft = '5px';
  clearRecordedButton.addEventListener('click', clearRecordedData);

  butConnect.insertAdjacentElement('afterend', startSyncedButton);
  startSyncedButton.insertAdjacentElement('afterend', stopSyncedButton);
  stopSyncedButton.insertAdjacentElement('afterend', downloadButton);
  downloadButton.insertAdjacentElement('afterend', clearRecordedButton);
}

// ===============================
// SERIAL CONNECTION
// ===============================

async function connect() {
  port = await navigator.serial.requestPort();
  await port.open({ baudRate: Number(baudRate.value) });

  let decoder = new TextDecoderStream();

  inputDone = port.readable.pipeTo(decoder.writable);

  inputStream = decoder.readable
    .pipeThrough(new TransformStream(new LineBreakTransformer()));

  reader = inputStream.getReader();

  readLoop().catch(async function(error) {
    console.error(error);
    toggleUIConnected(false);
    await disconnect();
  });
}

async function disconnect() {
  if (videoRecording) {
    stopSyncedRecording();
  }

  if (reader) {
    await reader.cancel();
    await inputDone.catch(() => {});
    reader = null;
    inputDone = null;
  }

  if (outputStream) {
    await outputStream.getWriter().close();
    await outputDone;
    outputStream = null;
    outputDone = null;
  }

  await port.close();
  port = null;
  showCalibration = false;
}

// ===============================
// SERIAL READING LOOP
// ===============================

async function readLoop() {
  while (true) {
    const {value, done} = await reader.read();

    if (value) {
      parseSerialLine(value);
    }

    if (done) {
      console.log('[readLoop] DONE', done);
      reader.releaseLock();
      break;
    }
  }
}

// ===============================
// PARSE SERIAL DATA
// ===============================

function parseSerialLine(value) {
  value = value.trim();

  if (value.substr(0, 12) == "Orientation:") {
    orientation = value.substr(12).trim().split(",").map(x => +x);
    latestOrientation = orientation;
  }

  if (value.substr(0, 11) == "Quaternion:") {
    quaternion = value.substr(11).trim().split(",").map(x => +x);
    latestQuaternion = quaternion;

    // This records only during synced recording.
    recordCurrentReading();
  }

  if (value.substr(0, 12) == "Calibration:") {
    calibration = value.substr(12).trim().split(",").map(x => +x);
    latestCalibration = calibration;

    if (!showCalibration) {
      showCalibration = true;
      updateTheme();
    }
  }
}

// ===============================
// SYNCED RECORDING
// ===============================

function startSyncedRecording() {
  if (videoRecording) {
    alert("A synced recording is already running.");
    return;
  }

  if (!canvas.captureStream) {
    alert("Your browser does not support canvas video recording. Try Chrome or Edge.");
    return;
  }

  // Clear old trial data so the CSV and video belong to the same trial.
  recordedData = [];
  recordedVideoChunks = [];

  recordingId = makeRecordingId();

  const stream = canvas.captureStream(30);

  try {
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'video/webm'
    });
  } catch (error) {
    console.error(error);
    alert("Could not start video recording. Try Chrome or Edge.");
    return;
  }

  mediaRecorder.ondataavailable = function(event) {
    if (event.data && event.data.size > 0) {
      recordedVideoChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = function() {
    downloadVideo();
  };

  // This is the shared start time for BOTH the video and CSV.
  recordingStartTimeMs = performance.now();
  recordingStopTimeMs = null;

  // Start video.
  mediaRecorder.start();

  // Start CSV recording.
  recordingEnabled = true;
  videoRecording = true;

  setRecordingButtons(true);

  console.log("Synced recording started:", recordingId);
}

function stopSyncedRecording() {
  if (!videoRecording) {
    alert("No synced recording is currently running.");
    return;
  }

  // Stop CSV recording first so no extra rows are added after video stop.
  recordingEnabled = false;
  recordingStopTimeMs = performance.now();

  // Stop video recording.
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  videoRecording = false;
  setRecordingButtons(false);

  console.log("Synced recording stopped:", recordingId);
}

function setRecordingButtons(isRecording) {
  const startButton = document.getElementById('startSyncedRecording');
  const stopButton = document.getElementById('stopSyncedRecording');

  if (startButton) {
    startButton.disabled = isRecording;
  }

  if (stopButton) {
    stopButton.disabled = !isRecording;
  }
}

function makeRecordingId() {
  const now = new Date();

  return "trial_" +
    now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0") + "_" +
    String(now.getHours()).padStart(2, "0") + "-" +
    String(now.getMinutes()).padStart(2, "0") + "-" +
    String(now.getSeconds()).padStart(2, "0");
}

// ===============================
// CSV RECORDING
// ===============================

function recordCurrentReading() {
  if (!recordingEnabled || recordingStartTimeMs === null) {
    return;
  }

  const nowMs = performance.now();
  const elapsedMs = nowMs - recordingStartTimeMs;
  const videoTimeSec = elapsedMs / 1000.0;

  // These are the exact quaternion values used by Three.js to rotate the head.
  const threeQx = latestQuaternion[1];
  const threeQy = latestQuaternion[3];
  const threeQz = -latestQuaternion[2];
  const threeQw = latestQuaternion[0];

  recordedData.push({
    recordingId: recordingId,

    // Browser wall-clock timestamp.
    timestamp: new Date().toISOString(),

    // These two columns are what let you match CSV rows to the video.
    elapsedMs: elapsedMs.toFixed(3),
    videoTimeSec: videoTimeSec.toFixed(6),

    heading: latestOrientation[0],
    roll: latestOrientation[1],
    pitch: latestOrientation[2],

    qw: latestQuaternion[0],
    qx: latestQuaternion[1],
    qy: latestQuaternion[2],
    qz: latestQuaternion[3],

    // Exact quaternion applied to the 3D head in Three.js.
    three_qx: threeQx,
    three_qy: threeQy,
    three_qz: threeQz,
    three_qw: threeQw,

    systemCal: latestCalibration[0],
    gyroCal: latestCalibration[1],
    accelCal: latestCalibration[2],
    magCal: latestCalibration[3]
  });
}

function downloadCSV() {
  if (recordedData.length === 0) {
    alert("No synced data recorded yet. Click Start Synced Recording, move the IMU, then Stop Synced Recording.");
    return;
  }

  const headers = [
    "recordingId",
    "timestamp",
    "elapsedMs",
    "videoTimeSec",

    "heading",
    "roll",
    "pitch",

    "qw",
    "qx",
    "qy",
    "qz",

    "three_qx",
    "three_qy",
    "three_qz",
    "three_qw",

    "systemCal",
    "gyroCal",
    "accelCal",
    "magCal"
  ];

  const csvRows = [];
  csvRows.push(headers.join(","));

  recordedData.forEach(row => {
    const values = headers.map(header => {
      const value = row[header];

      if (value === undefined || value === null) {
        return "";
      }

      return value;
    });

    csvRows.push(values.join(","));
  });

  const csvContent = csvRows.join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;

  const filename = recordingId ? recordingId + "_imu_data.csv" : "imu_data.csv";

  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

function clearRecordedData() {
  if (videoRecording) {
    alert("Stop the synced recording before clearing data.");
    return;
  }

  recordedData = [];
  recordedVideoChunks = [];
  recordingStartTimeMs = null;
  recordingStopTimeMs = null;
  recordingId = null;

  alert("Recorded IMU data and video chunks cleared.");
}

// ===============================
// VIDEO DOWNLOAD
// ===============================

function downloadVideo() {
  if (recordedVideoChunks.length === 0) {
    alert("No video data was recorded.");
    return;
  }

  const blob = new Blob(recordedVideoChunks, {
    type: 'video/webm'
  });

  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;

  const filename = recordingId ? recordingId + "_head_movement.webm" : "head_movement.webm";

  a.download = filename;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

// ===============================
// SERIAL LOG
// ===============================

function logData(line) {
  if (showTimestamp.checked) {
    let d = new Date();
    let timestamp = d.getHours() + ":" + `${d.getMinutes()}`.padStart(2, 0) + ":" +
        `${d.getSeconds()}`.padStart(2, 0) + "." + `${d.getMilliseconds()}`.padStart(3, 0);
    log.innerHTML += '<span class="timestamp">' + timestamp + ' -> </span>';
    d = null;
  }

  log.innerHTML += line + "<br>";

  if (log.textContent.split("\n").length > maxLogLength + 1) {
    let logLines = log.innerHTML.replace(/(\n)/gm, "").split("<br>");
    log.innerHTML = logLines.splice(-maxLogLength).join("<br>\n");
  }

  if (autoscroll.checked) {
    log.scrollTop = log.scrollHeight;
  }
}

// ===============================
// THEME
// ===============================

function updateTheme() {
  document
    .querySelectorAll('link[rel=stylesheet].alternate')
    .forEach((styleSheet) => {
      enableStyleSheet(styleSheet, false);
    });

  if (darkMode.checked) {
    enableStyleSheet(darkSS, true);
  } else {
    enableStyleSheet(lightSS, true);
  }

  if (showCalibration && !logContainer.classList.contains('show-calibration')) {
    logContainer.classList.add('show-calibration');
  } else if (!showCalibration && logContainer.classList.contains('show-calibration')) {
    logContainer.classList.remove('show-calibration');
  }
}

function enableStyleSheet(node, enabled) {
  node.disabled = !enabled;
}

// ===============================
// BUTTON HANDLERS
// ===============================

async function reset() {
  log.innerHTML = "";
}

async function clickConnect() {
  if (port) {
    await disconnect();
    toggleUIConnected(false);
    return;
  }

  await connect();

  reset();

  toggleUIConnected(true);
}

async function clickAutoscroll() {
  saveSetting('autoscroll', autoscroll.checked);
}

async function clickTimestamp() {
  saveSetting('timestamp', showTimestamp.checked);
}

async function changeBaudRate() {
  saveSetting('baudrate', baudRate.value);
}

async function changeAngleType() {
  saveSetting('angletype', angleType.value);
}

async function clickDarkMode() {
  updateTheme();
  saveSetting('darkmode', darkMode.checked);
}

async function clickClear() {
  reset();
}

// ===============================
// UTILITY FUNCTIONS
// ===============================

async function finishDrawing() {
  return new Promise(requestAnimationFrame);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class LineBreakTransformer {
  constructor() {
    this.container = '';
  }

  transform(chunk, controller) {
    this.container += chunk;
    const lines = this.container.split('\n');
    this.container = lines.pop();

    lines.forEach(line => {
      controller.enqueue(line);
      logData(line);
    });
  }

  flush(controller) {
    controller.enqueue(this.container);
  }
}

function convertJSON(chunk) {
  try {
    let jsonObj = JSON.parse(chunk);
    jsonObj._raw = chunk;
    return jsonObj;
  } catch (e) {
    return chunk;
  }
}

function toggleUIConnected(connected) {
  let lbl = 'Connect';

  if (connected) {
    lbl = 'Disconnect';
  }

  butConnect.textContent = lbl;
  updateTheme();
}

function initBaudRate() {
  for (let rate of baudRates) {
    var option = document.createElement("option");
    option.text = rate + " Baud";
    option.value = rate;
    baudRate.add(option);
  }
}

function loadAllSettings() {
  autoscroll.checked = loadSetting('autoscroll', true);
  showTimestamp.checked = loadSetting('timestamp', false);
  baudRate.value = loadSetting('baudrate', 9600);
  angleType.value = loadSetting('angletype', 'quaternion');
  darkMode.checked = loadSetting('darkmode', false);
}

function loadSetting(setting, defaultValue) {
  let value = JSON.parse(window.localStorage.getItem(setting));

  if (value == null) {
    return defaultValue;
  }

  return value;
}

let isWebGLAvailable = function() {
  try {
    var testCanvas = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl')));
  } catch (e) {
    return false;
  }
};

function updateCalibration() {
  const calMap = [
    {caption: "Uncalibrated",         color: "#CC0000"},
    {caption: "Partially Calibrated", color: "#FF6600"},
    {caption: "Mostly Calibrated",    color: "#FFCC00"},
    {caption: "Fully Calibrated",     color: "#009900"},
  ];

  const calLabels = [
    "System", "Gyro", "Accelerometer", "Magnetometer"
  ];

  calContainer.innerHTML = "";

  for (var i = 0; i < calibration.length; i++) {
    let calInfo = calMap[calibration[i]];

    if (!calInfo) {
      calInfo = {caption: "Unknown", color: "#999999"};
    }

    let element = document.createElement("div");
    element.innerHTML = calLabels[i] + ": " + calInfo.caption;
    element.style = "color: " + calInfo.color;
    calContainer.appendChild(element);
  }
}

function saveSetting(setting, value) {
  window.localStorage.setItem(setting, JSON.stringify(value));
}

// ===============================
// THREE.JS 3D SCENE
// ===============================

let head;

const renderer = new THREE.WebGLRenderer({
  canvas,
  preserveDrawingBuffer: true
});

const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 100);
camera.position.set(0, 0, 30);

const scene = new THREE.Scene();
scene.background = new THREE.Color('black');

{
  const skyColor = 0xB1E1FF;
  const groundColor = 0x666666;
  const intensity = 0.5;
  const light = new THREE.HemisphereLight(skyColor, groundColor, intensity);
  scene.add(light);
}

{
  const color = 0xFFFFFF;
  const intensity = 1;
  const light = new THREE.DirectionalLight(color, intensity);
  light.position.set(0, 10, 0);
  light.target.position.set(-5, 0, 0);
  scene.add(light);
  scene.add(light.target);
}

{
  const objLoader = new OBJLoader();

  objLoader.load('assets/head.obj', (root) => {
    head = root;

    head.scale.set(1, 1, 1);

    scene.add(root);
  });
}

function resizeRendererToDisplaySize(renderer) {
  const rendererCanvas = renderer.domElement;
  const width = rendererCanvas.clientWidth;
  const height = rendererCanvas.clientHeight;
  const needResize = rendererCanvas.width !== width || rendererCanvas.height !== height;

  if (needResize) {
    renderer.setSize(width, height, false);
  }

  return needResize;
}

// ===============================
// RENDER LOOP
// ===============================

async function render() {
  if (resizeRendererToDisplaySize(renderer)) {
    const rendererCanvas = renderer.domElement;
    camera.aspect = rendererCanvas.clientWidth / rendererCanvas.clientHeight;
    camera.updateProjectionMatrix();
  }

  if (head != undefined) {
    if (angleType.value == "euler") {
      if (showCalibration) {
        let rotationEuler = new THREE.Euler(
          THREE.MathUtils.degToRad(360 - orientation[2]),
          THREE.MathUtils.degToRad(orientation[0]),
          THREE.MathUtils.degToRad(orientation[1]),
          'YZX'
        );

        head.setRotationFromEuler(rotationEuler);
      } else {
        let rotationEuler = new THREE.Euler(
          THREE.MathUtils.degToRad(orientation[2]),
          THREE.MathUtils.degToRad(orientation[0] - 180),
          THREE.MathUtils.degToRad(-orientation[1]),
          'YZX'
        );

        head.setRotationFromEuler(rotationEuler);
      }
    } else {
      let rotationQuaternion = new THREE.Quaternion(
        quaternion[1],
        quaternion[3],
        -quaternion[2],
        quaternion[0]
      );

      head.setRotationFromQuaternion(rotationQuaternion);
    }
  }

  renderer.render(scene, camera);
  updateCalibration();

  await sleep(10);
  await finishDrawing();
  await render();
}
