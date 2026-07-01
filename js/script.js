// let the editor know that `Chart` is defined by some code
// included in another file (in this case, `index.html`)
// Note: the code will still work without this line, but without it you
// will see an error in the editor
/* global THREE */
/* global TransformStream */
/* global TextEncoderStream */
/* global TextDecoderStream */
'use strict';

import * as THREE from 'three';
import {OBJLoader} from 'objloader';

let port;
let reader;
let inputDone;
let outputDone;
let inputStream;
let outputStream;
let showCalibration = false;

let orientation = [0, 0, 0];
let quaternion = [1, 0, 0, 0];
let calibration = [0, 0, 0, 0];

// ===============================
// CSV RECORDING VARIABLES
// ===============================
let recordedData = [];
let latestOrientation = [0, 0, 0];
let latestQuaternion = [1, 0, 0, 0];
let latestCalibration = [0, 0, 0, 0];

// CSV rows are saved only during a synced recording.
let recordingEnabled = false;

// These variables make the CSV and video belong to the same exact trial.
let recordingStartTimeMs = null;
let recordingStopTimeMs = null;
let recordingId = null;

// ===============================
// VIDEO RECORDING VARIABLES
// ===============================
let mediaRecorder;
let recordedVideoChunks = [];
let videoRecording = false;

const maxLogLength = 100;
const baudRates = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600,
  74880, 115200, 230400, 250000, 500000, 1000000, 2000000
];

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

document.addEventListener('DOMContentLoaded', async () => {
  butConnect.addEventListener('click', clickConnect);
  butClear.addEventListener('click', clickClear);
  autoscroll.addEventListener('click', clickAutoscroll);
  showTimestamp.addEventListener('click', clickTimestamp);
  baudRate.addEventListener('change', changeBaudRate);
  angleType.addEventListener('change', changeAngleType);
  darkMode.addEventListener('click', clickDarkMode);

  // Add synced CSV/video recording buttons automatically.
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

/**
 * Adds synced recording, CSV download, and clear buttons to the top controls.
 *
 * Start Synced Recording starts BOTH:
 *   1. CSV data collection
 *   2. video recording of the 3D canvas
 *
 * This is what makes the video and CSV match.
 */
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

/**
 * Opens a Web Serial connection and sets up the input stream.
 */
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

/**
 * Closes the Web Serial connection.
 */
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

/**
 * Reads data from the input stream, parses it, and records it.
 */
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

/**
 * Parses serial data lines.
 *
 * Expected input examples:
 * Orientation: 357.19, 0.94, 1.62
 * Quaternion: 0.9996, -0.0146, -0.0079, -0.0249
 * Calibration: 0, 3, 3, 0
 */
function parseSerialLine(value) {
  value = value.trim();

  if (value.substr(0, 12) == "Orientation:") {
    orientation = value.substr(12).trim().split(",").map(x => +x);
    latestOrientation = orientation;
  }

  if (value.substr(0, 11) == "Quaternion:") {
    quaternion = value.substr(11).trim().split(",").map(x => +x);
    latestQuaternion = quaternion;

    // Record one row every time a quaternion line arrives,
    // but only while synced recording is active.
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
// SYNCED CSV + VIDEO RECORDING
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

  // Clear previous trial data so this CSV and video match one another.
  recordedData = [];
  recordedVideoChunks = [];

  recordingId = makeRecordingId();

  const stream = canvas.captureStream(30); // 30 frames per second

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

  // Shared start time for BOTH the CSV rows and the video.
  recordingStartTimeMs = performance.now();
  recordingStopTimeMs = null;

  // Start video recording.
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

  // Stop CSV first so no extra rows are saved after the video ends.
  recordingEnabled = false;
  recordingStopTimeMs = performance.now();

  // Stop video. When it stops, downloadVideo() runs automatically.
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

/**
 * Saves the latest complete reading into recordedData.
 *
 * Important columns:
 *   elapsedMs: milliseconds since Start Synced Recording was clicked
 *   videoTimeSec: seconds into the video
 *
 * A row with videoTimeSec = 2.50 matches about 2.50 seconds
 * into the downloaded .webm video.
 */
function recordCurrentReading() {
  if (!recordingEnabled || recordingStartTimeMs === null) {
    return;
  }

  const nowMs = performance.now();
  const elapsedMs = nowMs - recordingStartTimeMs;
  const videoTimeSec = elapsedMs / 1000.0;

  // These are the exact quaternion values being applied to the 3D headContainer.
  const threeQx = latestQuaternion[1];
  const threeQy = latestQuaternion[3];
  const threeQz = -latestQuaternion[2];
  const threeQw = latestQuaternion[0];

  recordedData.push({
    recordingId: recordingId,
    timestamp: new Date().toISOString(),

    elapsedMs: elapsedMs.toFixed(3),
    videoTimeSec: videoTimeSec.toFixed(6),

    heading: latestOrientation[0],
    roll: latestOrientation[1],
    pitch: latestOrientation[2],

    qw: latestQuaternion[0],
    qx: latestQuaternion[1],
    qy: latestQuaternion[2],
    qz: latestQuaternion[3],

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

/**
 * Downloads the synced IMU data as a CSV file.
 */
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
  a.download = recordingId ? recordingId + "_imu_data.csv" : "imu_data.csv";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

/**
 * Downloads the synced 3D head movement video.
 */
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
  a.download = recordingId ? recordingId + "_head_movement.webm" : "head_movement.webm";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

/**
 * Clears the recorded CSV data and video chunks.
 */
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

function logData(line) {
  if (showTimestamp.checked) {
    let d = new Date();
    let timestamp =
      d.getHours() + ":" +
      `${d.getMinutes()}`.padStart(2, 0) + ":" +
      `${d.getSeconds()}`.padStart(2, 0) + "." +
      `${d.getMilliseconds()}`.padStart(3, 0);

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

/**
 * Sets the theme.
 */
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

/**
 * Reset the Log.
 */
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

async function finishDrawing() {
  return new Promise(requestAnimationFrame);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * TransformStream to parse the stream into lines.
 */
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
    var canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
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
    "System",
    "Gyro",
    "Accelerometer",
    "Magnetometer"
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

// Parent container.
// The head model and vestibular canal rings are placed inside this group.
// This way, IMU rotation moves everything together.
const headContainer = new THREE.Group();

// Make the full head + canals fit better in the display window.
// Smaller scale = less zoomed in.
// Negative Y moves everything slightly down so the forehead is not cropped.
headContainer.scale.set(0.65, 0.65, 0.65);
headContainer.position.set(0, -2.5, 0);

const renderer = new THREE.WebGLRenderer({
  canvas,
  preserveDrawingBuffer: true
});

const camera = new THREE.PerspectiveCamera(
  45,
  canvas.width / canvas.height,
  0.1,
  200
);

// Move camera farther back so the whole model fits.
camera.position.set(0, 0, 50);

const scene = new THREE.Scene();
scene.background = new THREE.Color('black');

// Add the parent container to the scene.
scene.add(headContainer);

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

// Helper function to create custom 3D torus canals.
function createCanalRing(color) {
  // Smaller rings so they fit near the ears instead of floating away.
  const geometry = new THREE.TorusGeometry(1.25, 0.11, 8, 32);

  const material = new THREE.MeshPhongMaterial({
    color: color,
    transparent: true,
    opacity: 0.75,
    shininess: 80
  });

  return new THREE.Mesh(geometry, material);
}

// Generate structural sub-groups for left and right vestibular apparatuses.
const leftEarGroup = new THREE.Group();
const rightEarGroup = new THREE.Group();

// Move canal groups closer to the sides of the head.
// x = left/right, y = up/down, z = front/back.
leftEarGroup.position.set(4.8, 2.2, 4.0);
rightEarGroup.position.set(-4.8, 2.2, 4.0);

leftEarGroup.scale.set(0.8, 0.8, 0.8);
rightEarGroup.scale.set(0.8, 0.8, 0.8);

// ===============================
// LEFT VESTIBULAR APPARATUS
// ===============================

// Horizontal canal: 30-degree pitch backwards.
const leftHorizontal = createCanalRing(0x00ff00); // green
leftHorizontal.rotation.x = THREE.MathUtils.degToRad(30);
leftEarGroup.add(leftHorizontal);

// Anterior canal.
const leftAnterior = createCanalRing(0xff0000); // red
leftAnterior.rotation.y = THREE.MathUtils.degToRad(45);
leftEarGroup.add(leftAnterior);

// Posterior canal.
const leftPosterior = createCanalRing(0x0000ff); // blue
leftPosterior.rotation.y = THREE.MathUtils.degToRad(-45);
leftEarGroup.add(leftPosterior);

// ===============================
// RIGHT VESTIBULAR APPARATUS
// ===============================

const rightHorizontal = createCanalRing(0x00ff00); // green
rightHorizontal.rotation.x = THREE.MathUtils.degToRad(30);
rightEarGroup.add(rightHorizontal);

const rightAnterior = createCanalRing(0xff0000); // red
rightAnterior.rotation.y = THREE.MathUtils.degToRad(-45);
rightEarGroup.add(rightAnterior);

const rightPosterior = createCanalRing(0x0000ff); // blue
rightPosterior.rotation.y = THREE.MathUtils.degToRad(45);
rightEarGroup.add(rightPosterior);

// Add ear/canal groups to the master head container.
headContainer.add(leftEarGroup);
headContainer.add(rightEarGroup);

// Load the 3D head model.
{
  const objLoader = new OBJLoader();

  objLoader.load('assets/head.obj', (root) => {
    head = root;

    // Adjust if the head appears too large or too small.
    head.scale.set(1, 1, 1);

    // Add the head to the same container as the canals.
    headContainer.add(root);
  });
}

function resizeRendererToDisplaySize(renderer) {
  const canvas = renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const needResize = canvas.width !== width || canvas.height !== height;

  if (needResize) {
    renderer.setSize(width, height, false);
  }

  return needResize;
}

// ===============================
// RENDER LOOP
// ===============================
// This keeps redrawing the 3D head and applying the latest IMU rotation.
// The rotation is applied to headContainer so the head and canal rings move together.

async function render() {
  if (resizeRendererToDisplaySize(renderer)) {
    const canvas = renderer.domElement;
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }

  if (headContainer != undefined) {
    if (angleType.value == "euler") {
      if (showCalibration) {
        const rotationEuler = new THREE.Euler(
          THREE.MathUtils.degToRad(360 - orientation[2]),
          THREE.MathUtils.degToRad(orientation[0]),
          THREE.MathUtils.degToRad(orientation[1]),
          'YZX'
        );

        headContainer.setRotationFromEuler(rotationEuler);
      } else {
        const rotationEuler = new THREE.Euler(
          THREE.MathUtils.degToRad(orientation[2]),
          THREE.MathUtils.degToRad(orientation[0] - 180),
          THREE.MathUtils.degToRad(-orientation[1]),
          'YZX'
        );

        headContainer.setRotationFromEuler(rotationEuler);
      }
    } else {
      const rotationQuaternion = new THREE.Quaternion(
        quaternion[1],
        quaternion[3],
        -quaternion[2],
        quaternion[0]
      );

      headContainer.setRotationFromQuaternion(rotationQuaternion);
    }
  }

  renderer.render(scene, camera);
  updateCalibration();

  await sleep(10);
  await finishDrawing();
  await render();
}
