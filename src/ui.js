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
      fpsValue: document.querySelector('#fps-value'),
      geometryDensity: document.querySelector('#geometry-density'),
      geometryReadout: document.querySelector('#geometry-readout'),
      frameMs: document.querySelector('#frame-ms'),
      terrainSample: document.querySelector('#terrain-sample'),
      forestSample: document.querySelector('#forest-sample'),
      navigationMode: document.querySelector('#navigation-mode'),
      gameHud: document.querySelector('#game-hud'),
      outputMode: document.querySelector('#output-mode'),
      renderMode: document.querySelector('#render-mode'),
      rasterizerMode: document.querySelector('#rasterizer-mode'),
      geometryView: document.querySelector('#geometry-view'),
      panelToggle: document.querySelector('#panel-toggle'),
      panel: document.querySelector('#controls-panel'),
      modeDescription: document.querySelector('#mode-description'),
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

    this.gameElements = {
      stick: document.querySelector('#move-stick'),
      thumb: document.querySelector('#move-thumb'),
      jump: document.querySelector('#jump-button')
    };
    this.pipeline = null;
    this.onAssetFile = null;
    this.onRestoreDefault = null;
    this.onResetCamera = null;

    this.bindEvents();
    this.setPanelOpen(!window.matchMedia('(max-width: 760px), (max-height: 520px)').matches);
    this.syncRendererControls();
  }

  bindEvents() {
    this.elements.forestSample.addEventListener('click', () => this.onForest?.());
    this.elements.terrainSample.addEventListener('click', () => this.onTerrain?.());
    this.elements.navigationMode.addEventListener('click', () => {
      const walking = this.elements.navigationMode.getAttribute('aria-pressed') !== 'true';
      this.elements.navigationMode.setAttribute('aria-pressed',String(walking));
      this.elements.navigationMode.textContent = walking ? 'Walking' : 'Orbit camera';
      this.onNavigationMode?.(walking);
    });
    this.elements.outputMode.addEventListener('change', () => this.syncRendererControls());
    this.elements.renderMode.addEventListener('change', () => {
      this.elements.visibleMeshlets.textContent = '—';
      this.elements.submittedTriangles.textContent = '—';
      this.elements.capacity.textContent = '—';
      this.elements.geometryReadout.textContent = 'Measuring geometry…';
      this.elements.overflowWarning.classList.add('hidden');
      this.syncRendererControls();
      this.onRenderModeChange?.();
    });
    this.elements.rasterizerMode.addEventListener('change',()=>{this.syncRendererControls();this.onRenderModeChange?.();});
    this.elements.geometryView.addEventListener('change', () => this.syncRendererControls());
    this.elements.panelToggle.addEventListener('click', () => {
      this.setPanelOpen(this.elements.panel.hidden);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.elements.panel.hidden) {
        this.setPanelOpen(false);
        this.elements.panelToggle.focus();
      }
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
    pipeline.setNaniteEnabled(this.elements.renderMode.value !== 'full'||this.elements.rasterizerMode.value.startsWith('bitmask'));
    this.syncRendererControls();
    pipeline.setLodThreshold(Number(this.elements.lodThreshold.value));
    pipeline.setOcclusionEnabled(this.elements.occlusionEnabled.checked);
    pipeline.setConeEnabled(this.elements.coneEnabled.checked);
    pipeline.setOccludersVisible(this.elements.occludersVisible.checked);
  }

  updateFps({fps, ms}) {
    this.elements.fpsValue.textContent = fps.toFixed(0);
    this.elements.frameMs.textContent = `${ms.toFixed(1)} ms`;
  }

  clearFps() {
    this.elements.fpsValue.textContent = '—';
    this.elements.frameMs.textContent = '— ms';
  }

  setGameScene(enabled, forest = false) {
    for(const option of this.elements.rasterizerMode.options)if(option.value.startsWith('bitmask')){option.disabled=!forest;option.hidden=!forest;}
    this.elements.occlusionEnabled.closest('label').hidden = forest;
    if (forest) this.elements.occlusionEnabled.checked = false;
    this.elements.gameHud.hidden = !enabled;
    this.elements.navigationMode.hidden = !enabled;
    this.elements.navigationMode.setAttribute('aria-pressed', 'true');
    this.elements.navigationMode.textContent = 'Walking';
    this.elements.occludersVisible.disabled = enabled;
    this.elements.occludersVisible.closest('label').hidden = enabled;
    if (enabled) this.setPanelOpen(false);
  }

  setPanelOpen(open) {
    this.elements.panel.hidden = !open;
    this.elements.panelToggle.setAttribute('aria-expanded', String(open));
    this.elements.panelToggle.textContent = open ? 'Hide controls' : 'Controls';
  }

  syncRendererControls() {
    const enabled = this.elements.renderMode.value !== 'full'||this.elements.rasterizerMode.value.startsWith('bitmask');
    const visualizing = enabled && this.elements.geometryView.checked;
    this.elements.geometryView.disabled = !enabled;
    this.elements.outputMode.disabled = !visualizing;
    for (const key of ['lodThreshold', 'occlusionEnabled', 'coneEnabled']) {
      this.elements[key].disabled = !enabled;
    }
    const mode = visualizing ? this.elements.outputMode.value : 'shaded';
    this.pipeline?.setOutputMode(mode);
    const label = visualizing ? this.elements.outputMode.selectedOptions[0].text : 'shaded';
    this.elements.lodThreshold.disabled=this.elements.renderMode.value==='full';
    this.elements.modeDescription.textContent = `${this.elements.renderMode.selectedOptions[0].text} · ${this.elements.rasterizerMode.value==='bitmask-voxel'?'Atomic HZB · streaming + surface voxels':this.elements.rasterizerMode.value==='bitmask-streaming'?'Visibility + atomic HZB · streaming':this.elements.rasterizerMode.value==='bitmask-visibility'?'Visibility + atomic HZB':this.elements.rasterizerMode.value.startsWith('bitmask')?'Bitmask compute':'Hardware'} · ${label}`;
    this.elements.lodBars.hidden = !enabled;
  }

  setStatus(text, busy = false) {
    this.elements.statusPill.textContent = text;
    this.elements.statusPill.classList.toggle('busy', busy);
  }

  setAssetName(name) {
    this.elements.assetName.textContent = name;
  }

  showLoading(title, detail = '') {
    this.elements.renderMode.disabled = true;
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
    this.elements.renderMode.disabled = false;
    this.elements.loading.classList.remove('visible');
    this.elements.loading.classList.add('hidden');
    this.setStatus('WebGPU active', false);
  }

  showFatalError(error) {
    const message = error instanceof Error
      ? error.message
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
        <span>${this.pipeline?.asset.hierarchy ? 'Tier' : 'LOD'} ${index}${this.pipeline?.asset.hierarchy && index === 5 ? '+' : ''}</span>
        <div class="lod-track"><div class="lod-fill" data-lod-fill="${index}"></div></div>
        <span data-lod-count="${index}">0</span>
      `;
      this.elements.lodBars.append(row);
    }
  }

  updateStats(stats) {
    const submitted = compactFormatter.format(stats.submittedTriangles);
    const source = compactFormatter.format(stats.sourceSceneTriangles);
    const reduction = Math.max(0, 100 * (1 - stats.submittedTriangles / Math.max(1, stats.sourceSceneTriangles)));
    this.elements.geometryReadout.textContent = stats.overflowed
      ? 'Meshlet capacity exceeded · some geometry was dropped'
      : `${submitted} submitted / ${source} source · ${reduction.toFixed(0)}% fewer`;
    if(stats.bitmask&&!stats.bitmask.visibility)this.elements.geometryReadout.textContent+=` · ${stats.bitmask.variant} · ${compactFormatter.format(stats.bitmask.batches)} mask batches · ${stats.bitmask.overflowTiles} scan tiles`;
    if(stats.bitmask?.visibility){const v=stats.bitmask;this.elements.geometryReadout.textContent+=` · ${compactFormatter.format(v.seed)} seed / ${compactFormatter.format(v.recovery)} recovery clusters · ${compactFormatter.format(v.culled)} HZB rejected · atomic coverage`; if(v.streaming)this.elements.geometryReadout.textContent+=` · ${(v.streaming.bytes/1048576).toFixed(1)} MiB page cache · ${v.streaming.pages} resident pages`; }
    if(stats.bitmask?.work){const w=stats.bitmask.work;this.elements.geometryReadout.textContent+=` · candidate tiles ${compactFormatter.format(w.candidates)} · edge rejected ${compactFormatter.format(w.edgeRejected)} · depth rejected ${compactFormatter.format(w.depthRejected)}/${compactFormatter.format(w.rasterCandidates)} · coverage tests ${compactFormatter.format(w.samples)} · depth tests ${compactFormatter.format(w.resolves)} · winner updates ${compactFormatter.format(w.wins)}`;}
    this.elements.geometryReadout.classList.toggle('capacity-error', Boolean(stats.overflowed));
    this.elements.geometryReadout.title = 'Meshlet submission counts include padded meshlet triangles. Fewer submitted triangles does not guarantee higher FPS.';
    this.elements.sourceTriangles.textContent = numberFormatter.format(
      stats.sourceTriangles
    );
    this.elements.groups.textContent = numberFormatter.format(stats.groups);
    this.elements.groups.title = this.pipeline?.asset.hierarchy ? 'Recursive hierarchy nodes; each parent replaces its complete subtree' : `${numberFormatter.format(stats.lockedVertices)} shared-boundary vertices locked`;
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
    this.elements.capacity.textContent = stats.naniteEnabled === false ? '—' : `${percent.toFixed(1)}%`;
    if (stats.naniteEnabled === false) this.elements.visibleMeshlets.textContent = '—';
    this.elements.capacity.title = `${numberFormatter.format(stats.visibleMeshlets)} / ${numberFormatter.format(stats.capacity)} meshlets`; 

    this.elements.overflowWarning.textContent=stats.overflowed
      ? 'Meshlet capacity exceeded. Some geometry was dropped before rasterization.'
      : `Raster pool exhausted in ${stats.bitmask?.overflowTiles??0} tiles. Those tiles scan all selected triangles in software; this can be very slow.`;
    this.elements.overflowWarning.classList.toggle('hidden',!stats.overflowed&&!stats.bitmask?.overflowTiles);

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
