const numberFormatter = new Intl.NumberFormat('en-AU');
const compactFormatter = new Intl.NumberFormat('en-AU', {
  notation: 'compact',
  maximumFractionDigits: 1
});

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export class DemoUI {
  constructor() {
    this.elements = {
      statusPill: document.querySelector('#status-pill'),
      outputMode: document.querySelector('#output-mode'),
      lodThreshold: document.querySelector('#lod-threshold'),
      lodValue: document.querySelector('#lod-value'),
      occlusionEnabled: document.querySelector('#occlusion-enabled'),
      coneEnabled: document.querySelector('#cone-enabled'),
      occludersVisible: document.querySelector('#occluders-visible'),
      assetFile: document.querySelector('#asset-file'),
      assetName: document.querySelector('#asset-name'),
      restoreDefault: document.querySelector('#restore-default'),
      resetCamera: document.querySelector('#reset-camera'),
      loading: document.querySelector('#loading'),
      loadingTitle: document.querySelector('#loading-title'),
      loadingDetail: document.querySelector('#loading-detail'),
      fatalError: document.querySelector('#fatal-error'),
      fatalErrorText: document.querySelector('#fatal-error-text'),
      sourceTriangles: document.querySelector('#stat-source-triangles'),
      instances: document.querySelector('#stat-instances'),
      groups: document.querySelector('#stat-groups'),
      sourceScene: document.querySelector('#stat-source-scene'),
      visibleMeshlets: document.querySelector('#stat-visible-meshlets'),
      submittedTriangles: document.querySelector('#stat-submitted-triangles'),
      capacity: document.querySelector('#stat-capacity'),
      lodBars: document.querySelector('#lod-bars'),
      overflowWarning: document.querySelector('#overflow-warning')
    };

    this.pipeline = null;
    this.onAssetFile = null;
    this.onRestoreDefault = null;
    this.onResetCamera = null;

    this.bindEvents();
  }

  bindEvents() {
    this.elements.outputMode.addEventListener('change', () => {
      this.pipeline?.setOutputMode(this.elements.outputMode.value);
    });

    this.elements.lodThreshold.addEventListener('input', () => {
      const value = Number(this.elements.lodThreshold.value);
      this.elements.lodValue.textContent = `${value.toFixed(1)} px`;
      this.pipeline?.setLodThreshold(value);
    });

    this.elements.occlusionEnabled.addEventListener('change', () => {
      this.pipeline?.setOcclusionEnabled(
        this.elements.occlusionEnabled.checked
      );
    });

    this.elements.coneEnabled.addEventListener('change', () => {
      this.pipeline?.setConeEnabled(this.elements.coneEnabled.checked);
    });

    this.elements.occludersVisible.addEventListener('change', () => {
      this.pipeline?.setOccludersVisible(
        this.elements.occludersVisible.checked
      );
    });

    this.elements.assetFile.addEventListener('change', () => {
      const file = this.elements.assetFile.files?.[0];
      if (file) this.onAssetFile?.(file);
      this.elements.assetFile.value = '';
    });

    this.elements.restoreDefault.addEventListener('click', () => {
      this.onRestoreDefault?.();
    });

    this.elements.resetCamera.addEventListener('click', () => {
      this.onResetCamera?.();
    });
  }

  bindPipeline(pipeline) {
    this.pipeline = pipeline;
    pipeline.setOutputMode(this.elements.outputMode.value);
    pipeline.setLodThreshold(Number(this.elements.lodThreshold.value));
    pipeline.setOcclusionEnabled(this.elements.occlusionEnabled.checked);
    pipeline.setConeEnabled(this.elements.coneEnabled.checked);
    pipeline.setOccludersVisible(this.elements.occludersVisible.checked);
  }

  setStatus(text, busy = false) {
    this.elements.statusPill.textContent = text;
    this.elements.statusPill.classList.toggle('busy', busy);
  }

  setAssetName(name) {
    this.elements.assetName.textContent = name;
  }

  showLoading(title, detail = '') {
    this.elements.loadingTitle.textContent = title;
    this.elements.loadingDetail.textContent = detail;
    this.elements.loading.classList.add('visible');
    this.elements.loading.classList.remove('hidden');
    this.setStatus(title, true);
  }

  updateLoading(title, detail = '') {
    this.elements.loadingTitle.textContent = title;
    this.elements.loadingDetail.textContent = detail;
    this.setStatus(title, true);
  }

  hideLoading() {
    this.elements.loading.classList.remove('visible');
    this.elements.loading.classList.add('hidden');
    this.setStatus('WebGPU active', false);
  }

  showFatalError(error) {
    const message = error instanceof Error
      ? `${error.message}\n\n${error.stack ?? ''}`
      : String(error);

    this.elements.fatalErrorText.textContent = message;
    this.elements.fatalError.classList.remove('hidden');
    this.elements.loading.classList.add('hidden');
    this.setStatus('Failed', true);
  }

  createLodBars(lodCount) {
    this.elements.lodBars.replaceChildren();

    for (let index = 0; index < lodCount; index += 1) {
      const row = document.createElement('div');
      row.className = 'lod-row';
      row.innerHTML = `
        <span>LOD ${index}</span>
        <div class="lod-track"><div class="lod-fill" data-lod-fill="${index}"></div></div>
        <span data-lod-count="${index}">0</span>
      `;
      this.elements.lodBars.append(row);
    }
  }

  updateStats(stats) {
    this.elements.sourceTriangles.textContent = numberFormatter.format(
      stats.sourceTriangles
    );
    this.elements.groups.textContent = numberFormatter.format(stats.groups);
    this.elements.groups.title = `${numberFormatter.format(stats.lockedVertices)} shared-boundary vertices locked`;
    this.elements.instances.textContent = numberFormatter.format(stats.instances);
    this.elements.sourceScene.textContent = compactFormatter.format(
      stats.sourceSceneTriangles
    );
    this.elements.visibleMeshlets.textContent = numberFormatter.format(
      stats.visibleMeshlets
    );
    this.elements.submittedTriangles.textContent = compactFormatter.format(
      stats.submittedTriangles
    );

    const percent = stats.capacity > 0
      ? (stats.visibleMeshlets / stats.capacity) * 100
      : 0;
    this.elements.capacity.textContent = `${percent.toFixed(1)}%`;
    this.elements.capacity.title = `${numberFormatter.format(stats.visibleMeshlets)} / ${numberFormatter.format(stats.capacity)} meshlets`; 

    this.elements.overflowWarning.classList.toggle(
      'hidden',
      !stats.overflowed
    );

    const maximum = Math.max(1, ...stats.lodCounts);
    stats.lodCounts.forEach((count, index) => {
      const fill = this.elements.lodBars.querySelector(
        `[data-lod-fill="${index}"]`
      );
      const label = this.elements.lodBars.querySelector(
        `[data-lod-count="${index}"]`
      );

      if (fill) fill.style.width = `${(count / maximum) * 100}%`;
      if (label) label.textContent = numberFormatter.format(count);
    });

    this.elements.sourceTriangles.title = `GPU asset buffers: ${formatBytes(stats.assetBytes)}`;
  }
}
