const runButton = document.getElementById('run');
const urlsInput = document.getElementById('urls');
const outputInput = document.getElementById('outputDir');
const parallelInput = document.getElementById('parallel');
const threadInput = document.getElementById('thread');
const bentoInput = document.getElementById('bento');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

function setStatus(message, tone = 'neutral') {
  statusEl.textContent = message;
  statusEl.style.borderColor = tone === 'error' ? '#5f2a2a' : '#242431';
}

function clearResults() {
  resultsEl.innerHTML = '';
}

function renderResult(item) {
  const li = document.createElement('li');
  li.className = `result-item ${item.success ? 'success' : 'fail'}`;
  const title = document.createElement('h3');
  title.textContent = item.success ? `✅ ${item.author || 'Unknown'}` : `❌ ${item.url}`;
  const detail = document.createElement('p');

  if (item.success) {
    const files = [
      item.cardFilename && `Card: ${item.cardFilename}`,
      item.metadataFilename && `Metadata: ${item.metadataFilename}`,
    ].filter(Boolean).join(' • ');
    detail.textContent = files || 'Completed.';
  } else {
    detail.textContent = item.error || 'Failed.';
  }

  li.appendChild(title);
  li.appendChild(detail);
  resultsEl.appendChild(li);
}

runButton.addEventListener('click', async () => {
  const urls = urlsInput.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (urls.length === 0) {
    setStatus('Please paste at least one URL.', 'error');
    return;
  }

  runButton.disabled = true;
  clearResults();
  setStatus('Processing URLs...');

  try {
    const response = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls,
        outputDir: outputInput.value,
        parallel: parallelInput.value,
        thread: threadInput.checked,
        bento: bentoInput.checked,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Request failed.');
    }

    setStatus(
      `Done in ${data.elapsedSeconds}s. Saved to ${data.outputDir}.`,
    );

    data.results.forEach(renderResult);
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    runButton.disabled = false;
  }
});
