// let the editor know that `Chart` is defined by some code
// included in another file (in this case, `index.html`)
// Note: the code will still work without this line, but without it you
// will see an error in the editor
/* global THREE */
/* global TransformStream */
/* global TextEncoderStream */
/* global TextDecoderStream */
'use strict';

import * as THREE from 'three'; // This brings in Three.js so we can generate a 3D view
import {OBJLoader} from 'objloader'; // This lets us load the .obj 3D model file

// ===============================
// SERIAL CONNECTION VARIABLES
// ===============================
// These variables store the USB serial connection between the browser and the IMU/microcontroller.

let port; // Computer USB serial port
let reader; // Keeps reading incoming data from the IMU
let inputDone;
let outputDone;
let inputStream;
let outputStream;
let showCalibration = false;

// ===============================
// IMU DATA VARIABLES
// ===============================
// These store the latest IMU readings.

let orientation = [0, 0, 0]; // [heading, roll, pitch]
let quaternion = [1, 0, 0, 0]; // [w, x, y, z]
let calibration = [0, 0, 0, 0]; // [system, gyro, accelerometer, magnetometer]

// ===============================
// CSV RECORDING VARIABLES
// ===============================

let recordedData = []; // Every new reading gets added here
let latestOrientation = [0, 0, 0];
let latestQuaternion = [1, 0, 0, 0];
let latestCalibration = [0, 0, 0, 0];
let recordingEnabled = true;

// ===============================
// VIDEO RECORDING VARIABLES
// ===============================
// These allow us to record the 3D head canvas as a video.

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

  // Add CSV and video buttons automatically so you do NOT need to edit index.html.
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
// This creates the extra buttons directly from JavaScript.

function addRecordingButtons() {
  const downloadButton = document.createElement('button');
  downloadButton.id = 'downloadCSV';
  downloadButton.textContent = 'Download CSV';
  downloadButton.style.marginLeft = '10px';
  downloadButton.addEventListener('click', downloadCSV);

  const clearRecordedButton = document.createElement('button');
  clearRecordedButton.id = 'clearRecordedData';
  clearRecordedButton.textContent = 'Clear Recorded Data';
  clearRecordedButton.style.marginLeft = '5px';
  clearRecordedButton.addEventListener('click', clearRecordedData);

  const startVideoButton = document.createElement('button');
  startVideoButton.id = 'startVideoRecording';
  startVideoButton.textContent = 'Start Video';
  startVideoButton.style.marginLeft = '5px';
  startVideoButton.addEventListener('click', startVideoRecording);

  const stopVideoButton = document.createElement('button');
  stopVideoButton.id = 'stopVideoRecording';
  stopVideoButton.textContent = 'Stop Video';
  stopVideoButton.style.marginLeft = '5px';
  stopVideoButton.disabled = true;
  stopVideoButton.addEventListener('click', stopVideoRecording);

  butConnect.insertAdjacentElement('afterend', downloadButton);
  downloadButton.insertAdjacentElement('afterend', clearRecordedButton);
  clearRecordedButton.insertAdjacentElement('afterend', startVideoButton);
  startVideoButton.insertAdjacentElement('afterend', stopVideoButton);
}

// ===============================
// SERIAL CONNECTION
// ===============================

async function connect() {
  // Ask user which serial device to connect.
  port = await navigator.serial.requestPort();

  // Open the serial port using the selected baud rate.
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
// Expected lines:
// Orientation: 357.19, 0.94, 1.62
// Quaternion: 0.9996, -0.0146, -0.0079, -0.0249
// Calibration: 0, 3, 3, 0

function parseSerialLine(value) {
  value = value.trim();

  if (value.substr(0, 12) == "Orientation:") {
    orientation = value.substr(12).trim().split(",").map(x => +x);
    latestOrientation = orientation;
  }

  if (value.substr(0, 11) == "Quaternion:") {
    quaternion = value.substr(11).trim().split(",").map(x => +x);
    latestQuaternion = quaternion;

    // Save one CSV row every time a quaternion reading arrives.
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
// CSV RECORDING
// ===============================

function recordCurrentReading() {
  if (!recordingEnabled) {
    return;
  }

  recordedData.push({
    timestamp: new Date().toISOString(),

    heading: latestOrientation[0],
    roll: latestOrientation[1],
    pitch: latestOrientation[2],

    qw: latestQuaternion[0],
    qx: latestQuaternion[1],
    qy: latestQuaternion[2],
    qz: latestQuaternion[3],

    systemCal: latestCalibration[0],
    gyroCal: latestCalibration[1],
    accelCal: latestCalibration[2],
    magCal: latestCalibration[3]
  });
}

function downloadCSV() {
  if (recordedData.length === 0) {
    alert("No data recorded yet. Connect your IMU and wait for readings first.");
    return;
  }

  const headers = [
    "timestamp",
    "heading",
    "roll",
    "pitch",
    "qw",
    "qx",
    "qy",
    "qz",
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

  const now = new Date();
  const filename =
    "imu_data_" +
    now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0") + "_" +
    String(now.getHours()).padStart(2, "0") + "-" +
    String(now.getMinutes()).padStart(2, "0") + "-" +
    String(now.getSeconds()).padStart(2, "0") +
    ".csv";

  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

function clearRecordedData() {
  recordedData = [];
  alert("Recorded IMU data cleared.");
}

// ===============================
// VIDEO RECORDING
// ===============================
// This records the 3D canvas as a video.
// The downloaded file will be .webm.

function startVideoRecording() {
  if (videoRecording) {
    alert("Video is already recording.");
    return;
  }

  if (!canvas.captureStream) {
    alert("Your browser does not support canvas video recording. Try Chrome or Edge.");
    return;
  }

  recordedVideoChunks = [];

  // 30 means 30 frames per second.
  const stream = canvas.captureStream(30);

  try {
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'video/webm'
    });
  } catch (error) {
    console.error(error);
    alert("Could not start video recording. Try using Chrome or Edge.");
    return;
  }

  mediaRecorder.ondataavailable = function(event) {
    if (event.data && event.data.size > 0) {
      recordedVideoChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = function() {
    const blob = new Blob(recordedVideoChunks, {
      type: 'video/webm'
    });

    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;

    const now = new Date();
    const filename =
      "head_movement_" +
      now.getFullYear() + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0") + "_" +
      String(now.getHours()).padStart(2, "0") + "-" +
      String(now.getMinutes()).padStart(2, "0") + "-" +
      String(now.getSeconds()).padStart(2, "0") +
      ".webm";

    a.download = filename;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);

    videoRecording = false;

    const startButton = document.getElementById('startVideoRecording');
    const stopButton = document.getElementById('stopVideoRecording');

    if (startButton) {
      startButton.disabled = false;
    }

    if (stopButton) {
      stopButton.disabled = true;
    }
  };

  mediaRecorder.start();
  videoRecording = true;

  const startButton = document.getElementById('startVideoRecording');
  const stopButton = document.getElementById('stopVideoRecording');

  if (startButton) {
    startButton.disabled = true;
  }

  if (stopButton) {
    stopButton.disabled = false;
  }
}

function stopVideoRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    alert("No video is currently recording.");
    return;
  }

  mediaRecorder.stop();
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

    // Adjust this if the head appears too large or too small.
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
// This keeps redrawing the 3D head and applying the latest IMU rotation.

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