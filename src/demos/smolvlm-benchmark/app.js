import { appConfig } from './config.js';
import { sharedConfig } from '../../shared/config.js';

import { buildSubmission, sendSubmission } from '../../shared/sender.js';
import { collectEnvironment } from '../../shared/collect-environment.js';
import { createSmolVlmRunner } from '../../benchmarks/smolvlm-runner.js';

const imageInput = document.getElementById('imageInput');
const useDefaultBtn = document.getElementById('useDefaultBtn');
const loadBtn = document.getElementById('loadBtn');
const analyzeBtn = document.getElementById('analyzeBtn');
const preview = document.getElementById('preview');
const placeholder = document.getElementById('placeholder');
const configInput = document.getElementById('configInput');
const outputEl = document.getElementById('output');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');

let currentImageDataUrl = null;
let workerReady = false;
let modelReady = false;

let currentRun = {
  analyzeStartedAt: null,
  modelInfo: null
};

const runner = createSmolVlmRunner({
  workerUrl: new URL('../../benchmarks/worker-smolvlm.js', import.meta.url),
  onStatus: (text, kind) => setStatus(text, kind),
  onWorkerReady: () => {
    workerReady = true;
    setStatus('Worker ready.', 'ok');
    refreshButtons();
  },
  onModelReady: (msg) => {
    modelReady = true;
    currentRun.modelInfo = {
      backend: msg.backend || null,
      dtype: msg.dtype || null,
      load_ms: msg.load_ms ?? null
    };
    setStatus(
      `Model ready (${msg.backend || 'unknown'}${msg.dtype ? ', ' + msg.dtype : ''}).`,
      'ok'
    );
    refreshButtons();
  },
  onWorkerError: (err) => {
    setStatus(`Worker crashed: ${err.message || err}`, 'err');
    refreshButtons();
  }
});

function setStatus(text, kind = '') {
  statusText.textContent = text;
  statusDot.className = 'dot';
  if (kind) statusDot.classList.add(kind);
}

function showImage(src) {
  preview.src = src;
  preview.style.display = 'block';
  placeholder.style.display = 'none';
}

function clearImage() {
  preview.removeAttribute('src');
  preview.style.display = 'none';
  placeholder.style.display = 'block';
  currentImageDataUrl = null;
  refreshButtons();
}

function refreshButtons() {
  analyzeBtn.disabled = !(workerReady && modelReady && currentImageDataUrl);
}

function safeParseConfig() {
  return JSON.parse(configInput.value);
}

function buildTable(json_payload) {


  const objectScoreTable = document.getElementById('objectScoreTable');
  const detectionsArray = json_payload.detections;

  while (objectScoreTable.rows.length > 1) {
    objectScoreTable.deleteRow(1);
  }

  for (const detection of detectionsArray) {
    if (!detection.categories || detection.categories.length === 0) continue;

    const category = detection.categories[0];

    const newRow = objectScoreTable.insertRow(-1);

    const nameCell = newRow.insertCell(0);
    nameCell.textContent = category.categoryName;

    const scoreCell = newRow.insertCell(1);

    scoreCell.textContent = category.score;

    const scorePercentCell = newRow.insertCell(2);

    scorePercentCell.textContent = (category.score * 100).toFixed(2) + '%';
  }
}


async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function loadDefaultImage() {
  const res = await fetch(appConfig.defaultImageUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error('Could not load default image.');
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  currentImageDataUrl = dataUrl;
  showImage(dataUrl);
  refreshButtons();
}

imageInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    clearImage();
    return;
  }

  try {
    const dataUrl = await blobToDataUrl(file);
    currentImageDataUrl = dataUrl;
    showImage(dataUrl);
    refreshButtons();
  } catch {
    setStatus('Could not read the image file.', 'err');
  }
});

useDefaultBtn.addEventListener('click', async () => {
  try {
    setStatus('Loading default image...', 'busy');
    await loadDefaultImage();
    setStatus('Default image loaded.', 'ok');
  } catch (err) {
    setStatus(err.message || 'Could not load default image.', 'err');
  }
});

loadBtn.addEventListener('click', async () => {
  try {
    const config = safeParseConfig();
    modelReady = false;
    outputEl.textContent = '{}';
    refreshButtons();
    setStatus('Loading model...', 'busy');
    await runner.loadModel(config);
  } catch (err) {
    setStatus(err.message || 'Invalid JSON config.', 'err');
    refreshButtons();
  }
});

analyzeBtn.addEventListener('click', async () => {
  try {
    const config = safeParseConfig();
    if (!currentImageDataUrl) throw new Error('No image selected.');

    currentRun.analyzeStartedAt = performance.now();
    outputEl.textContent = '{}';
    setStatus('Analyzing image...', 'busy');
    analyzeBtn.disabled = true;

    const benchmarkResult = await runner.analyzeImage(config, currentImageDataUrl);

    const analyzeFinishedAt = performance.now();
    const totalAnalyzeMs = currentRun.analyzeStartedAt != null
      ? +(analyzeFinishedAt - currentRun.analyzeStartedAt).toFixed(2)
      : null;

    const resultPayload = {
      ...benchmarkResult,
      total_analyze_ms: totalAnalyzeMs
    };

    outputEl.textContent = JSON.stringify(resultPayload, null, 2);

    //console.log(resultPayload.parsed_json);
    //buildTable(resultPayload.parsed_json);

    try {
      setStatus('Collecting environment...', 'busy');
      const environment = await collectEnvironment();

      setStatus('Sending result...', 'busy');

      const submission = buildSubmission({
        project: appConfig.project,
        kind: appConfig.kind,
        client: appConfig.client,
        clientVersion: appConfig.clientVersion,
        probeVersion: sharedConfig.probeVersion,
        payload: {
          identity: environment.identity,
          hardware: environment.hardware,
          capabilities: environment.capabilities,
          media: environment.media,
          benchmark: {
            model_id: config.model_id,
            processor_id: config.processor_id || config.model_id,
            backend: resultPayload.backend,
            dtype: resultPayload.dtype,
            load_ms: currentRun.modelInfo?.load_ms ?? null,
            inference_ms: resultPayload.inference_ms ?? null,
            total_analyze_ms: resultPayload.total_analyze_ms
          },
          result: {
            raw_text: resultPayload.raw_text,
            parsed_json: resultPayload.parsed_json
          },
          config
        }
      });

      await sendSubmission(sharedConfig.apiEndpoint, submission);
      setStatus('Done and sent.', 'ok');
    } catch (err) {
      console.error(err);
      setStatus(`Done, but send failed: ${err.message || err}`, 'err');
    }

    refreshButtons();
  } catch (err) {
    setStatus(err.message || 'Could not analyze image.', 'err');
    refreshButtons();
  }
});

runner.init();
