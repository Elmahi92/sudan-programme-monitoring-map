const DATA_PATH = '../Geo_Data/M_E_masterdata_by_state.geojson';
const BASEMAP_PATH = '../Geo_Data/sdn_admbnda_adm1_cbs_nic_ssa_download.geojson';
const COLORS = ['#e6f3fb', '#b8dced', '#81c3e0', '#45a8cf', '#1689b8', '#006eb5', '#004d80'];
const NO_DATA = '#f8fafc';
const BASEMAP_ATTRIBUTION = 'Tiles &copy; Esri, HERE, Garmin, FAO, NOAA, USGS';
const LIGHT_BASE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const LIGHT_LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const aliases = { gedarif: 'gedaref', kartoum: 'khartoum' };

const stateSelect = document.getElementById('stateSelect');
const localitySelect = document.getElementById('localitySelect');
const projectSelect = document.getElementById('projectSelect');
const interventionSelect = document.getElementById('interventionSelect');
const pillarSelect = document.getElementById('pillarSelect');
const beneficiarySelect = document.getElementById('beneficiarySelect');
const periodSelect = document.getElementById('periodSelect');
const groupSelect = document.getElementById('groupSelect');
const presenceToggle = document.getElementById('presenceToggle');

let records = [];
let boundaries = null;
let map;
let thematicLayer;
let boundaryLayer;
let projectLayer;
let lightBasemap;
let lightLabels;
let capitalLayer;
let stateLabelsLayer;
let crossMap;
let crossLayer;
let crossCapitalLayer;
let beneficiaryMap;
let beneficiaryLayer;
let beneficiaryCapitalLayer;
let beneficiaryStateLabelsLayer;
let distributionLeaders;
const basemapLayers = [];
let legendBreaks = [];
let activeColors = COLORS;
let bivariateThresholds = { target: [0, 0], actual: [0, 0] };

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const stateKey = value => aliases[clean(value).toLowerCase()] || clean(value).toLowerCase();
const valueOf = value => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const unique = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
const metricColumn = () => beneficiarySelect.value === 'Both'
  ? [`Direct ${periodSelect.value} ${groupSelect.value}`, `Indirect ${periodSelect.value} ${groupSelect.value}`]
  : `${beneficiarySelect.value} ${periodSelect.value} ${groupSelect.value}`;
const metricLabel = () => Array.isArray(metricColumn()) ? metricColumn().join(' + ') : metricColumn();
const escapeHtml = value => clean(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[character]));

function selectedRecords() {
  return records.filter(record => {
    const state = clean(record.State);
    const locality = clean(record.Location);
    return (pillarSelect.value === '__all__' || record.Piller === pillarSelect.value)
      && (stateSelect.value === '__all__' || stateKey(state) === stateKey(stateSelect.value))
      && (localitySelect.value === '__all__' || locality === localitySelect.value)
      && (projectSelect.value === '__all__' || record['Project Name'] === projectSelect.value)
      && (interventionSelect.value === '__all__' || record.Intervention === interventionSelect.value);
  });
}

function fillSelect(select, values, label) {
  select.innerHTML = `<option value="__all__">All ${label}</option>${unique(values).map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
}

function populateFilters() {
  fillSelect(pillarSelect, records.map(record => record.Piller), 'pillars');
  fillSelect(stateSelect, records.map(record => record.State), 'states');
  fillSelect(localitySelect, records.map(record => record.Location), 'localities');
  fillSelect(projectSelect, records.map(record => record['Project Name']), 'projects');
  fillSelect(interventionSelect, records.map(record => record.Intervention), 'interventions');
}

function updateDependentFilters() {
  const filtered = records.filter(record => pillarSelect.value === '__all__' || record.Piller === pillarSelect.value);
  const currentState = stateSelect.value;
  fillSelect(stateSelect, filtered.map(record => record.State), 'states');
  stateSelect.value = unique(filtered.map(record => record.State)).some(value => stateKey(value) === stateKey(currentState)) ? currentState : '__all__';
  const stateFiltered = filtered.filter(record => stateSelect.value === '__all__' || stateKey(record.State) === stateKey(stateSelect.value));
  fillSelect(localitySelect, stateFiltered.map(record => record.Location), 'localities');
  fillSelect(projectSelect, stateFiltered.map(record => record['Project Name']), 'projects');
  fillSelect(interventionSelect, stateFiltered.map(record => record.Intervention), 'interventions');
}

function buildStateFeatures() {
  const geometries = new Map();
  boundaries.features.forEach(feature => {
    const name = feature.properties.adm1_en;
    geometries.set(stateKey(name), { name, geometry: feature.geometry });
  });
  return [...geometries.values()].map(item => ({
    type: 'Feature', properties: { State: item.name, value: null, records: 0 }, geometry: item.geometry
  }));
}

function aggregateStates(filtered) {
  const totals = new Map();
  const counts = new Map();
  filtered.forEach(record => {
    const states = clean(record.State).split('/').map(part => part.trim()).filter(Boolean);
    const column = metricColumn();
    const value = Array.isArray(column) ? column.reduce((sum, field) => sum + (valueOf(record[field]) || 0), 0) : valueOf(record[column]);
    if (!states.length) return;
    states.forEach(state => {
      const key = stateKey(state);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (value !== null) totals.set(key, (totals.get(key) || 0) + value / states.length);
    });
  });
  return buildStateFeatures().map(feature => ({
    ...feature,
    properties: { ...feature.properties, value: totals.get(stateKey(feature.properties.State)) ?? null, records: counts.get(stateKey(feature.properties.State)) || 0 }
  }));
}

function breaksFor(values) {
  const valid = values.filter(value => value !== null && value > 0).sort((a, b) => a - b);
  if (!valid.length) return [];
  return COLORS.map((_, index) => valid[Math.max(0, Math.min(valid.length - 1, Math.floor(valid.length * (index + 1) / COLORS.length) - 1))]);
}

function colorFor(value) {
  if (value === null) return NO_DATA;
  const index = legendBreaks.findIndex(limit => value <= limit);
  return activeColors[index < 0 ? activeColors.length - 1 : index];
}

function mixColor(source, target, amount) {
  const channel = (hex, offset) => parseInt(hex.slice(offset, offset + 2), 16);
  const result = [1, 3, 5].map(offset => Math.round(channel(source, offset) + (channel(target, offset) - channel(source, offset)) * amount));
  return `#${result.map(value => value.toString(16).padStart(2, '0')).join('')}`;
}

function updateIntensity() {
  const intensity = Number(document.getElementById('intensityRange').value) / 100;
  document.getElementById('intensityValue').textContent = `${Math.round(intensity * 100)}%`;
  const target = intensity < 1 ? '#ffffff' : '#003f80';
  const amount = intensity < 1 ? 1 - intensity : Math.min((intensity - 1) * 0.75, 0.3);
  activeColors = COLORS.map(color => intensity === 1 ? color : mixColor(color, target, amount));
}

function renderLegend() {
  const legend = document.getElementById('legend');
  if (presenceToggle.checked) {
    legend.innerHTML = '<div class="legend-row"><span class="legend-swatch" style="background:#006eb5"></span><span>UNDP presence</span></div><div class="legend-row"><span class="legend-swatch" style="background:#f8fafc"></span><span>No recorded presence</span></div>';
    return;
  }
  if (!legendBreaks.length) {
    legend.innerHTML = '<div class="legend-row"><span class="legend-swatch" style="background:#f8fafc"></span><span>No data for this selection</span></div>';
    return;
  }
  legend.innerHTML = legendBreaks.map((limit, index) => {
    const lower = index ? legendBreaks[index - 1] : 0;
    return `<div class="legend-row"><span class="legend-swatch" style="background:${activeColors[index]}"></span><span>${numberFormat.format(lower)} - ${numberFormat.format(limit)}</span></div>`;
  }).join('') + '<div class="legend-row"><span class="legend-swatch" style="background:#f8fafc"></span><span>No data</span></div>';
}

function updateKpis(filtered) {
  const types = beneficiarySelect.value === 'Both' ? ['Direct', 'Indirect'] : [beneficiarySelect.value];
  const periodField = periodSelect.value === 'Target 2026' ? 'Target 2026' : 'Actual Sep 2026';
  const selectedTotal = filtered.reduce((sum, record) => sum + types.reduce((subtotal, type) => subtotal + (valueOf(record[`${type} ${periodField} Total`]) || 0), 0), 0);
  const actual = filtered.reduce((sum, record) => sum + types.reduce((subtotal, type) => subtotal + (valueOf(record[`${type} Actual Sep 2026 Total`]) || 0), 0), 0);
  const states = new Set(filtered.flatMap(record => clean(record.State).split('/').map(stateKey).filter(Boolean)));
  const localities = new Set(filtered.map(record => clean(record.Location)).filter(Boolean));
  const set = (id, value) => { document.getElementById(id).textContent = numberFormat.format(value); };
  document.getElementById('kpiPeriodLabel').textContent = periodSelect.value === 'Target 2026' ? 'Direct target' : 'Selected actual as of Sep 2026';
  document.getElementById('kpiActualLabel').textContent = `${beneficiarySelect.options[beneficiarySelect.selectedIndex].text.replace(' beneficiaries', '')} actual as of Sep 2026`;
  set('kpiStates', states.size); set('kpiLocalities', localities.size); set('kpiTarget', selectedTotal); set('kpiActual', actual);
}

function renderMap() {
  const filtered = selectedRecords();
  updateIntensity();
  const features = aggregateStates(filtered);
  legendBreaks = breaksFor(features.map(feature => feature.properties.value));
  renderLegend(); updateKpis(filtered);
  document.getElementById('mapTitle').textContent = presenceToggle.checked ? 'UNDP Presence by State' : `${beneficiarySelect.value} Beneficiaries by State`;
  document.getElementById('mapSubtitle').textContent = presenceToggle.checked ? `${pillarSelect.value === '__all__' ? 'All pillars' : pillarSelect.value} | Recorded programme presence` : `${periodSelect.options[periodSelect.selectedIndex].text} | ${filtered.length} record${filtered.length === 1 ? '' : 's'} selected`;
  if (thematicLayer) thematicLayer.remove();
  thematicLayer = L.geoJSON(features, {
    style: feature => ({ color: '#ffffff', weight: 1.3, dashArray: '3 4', fillColor: presenceToggle.checked ? (feature.properties.records > 0 ? '#006eb5' : '#f8fafc') : colorFor(feature.properties.value), fillOpacity: presenceToggle.checked ? (feature.properties.records > 0 ? 0.88 : 0.72) : (feature.properties.value === null ? 0.72 : 0.86) }),
    onEachFeature: (feature, layer) => {
      const value = feature.properties.value === null ? 'No data' : numberFormat.format(feature.properties.value);
      const tooltip = presenceToggle.checked ? `<strong>${escapeHtml(feature.properties.State)}</strong><div>${feature.properties.records > 0 ? 'UNDP presence recorded' : 'No recorded UNDP presence'}</div>` : `<strong>${escapeHtml(feature.properties.State)}</strong><div>${escapeHtml(metricLabel())}: ${value}</div><div>${feature.properties.records} matching record${feature.properties.records === 1 ? '' : 's'}</div>`;
      layer.bindTooltip(tooltip, { sticky: true, className: 'map-tooltip' });
      layer.on({ mouseover: event => event.target.setStyle({ weight: 2.4, color: '#006eb5' }), mouseout: event => thematicLayer.resetStyle(event.target) });
    }
  }).addTo(map);
}

function renderStateLabels() {
  stateLabelsLayer = L.layerGroup(boundaries.features.map(feature => {
    const stateName = feature.properties?.adm1_en;
    const center = L.geoJSON(feature).getBounds().getCenter();
    return L.marker(center, {
      icon: L.divIcon({ className: 'state-name-label', html: escapeHtml(stateName), iconSize: [110, 22], iconAnchor: [55, 11] }),
      pane: 'stateNames',
      interactive: false,
      keyboard: false
    });
  })).addTo(map);
}

function statePillarSets() {
  const sets = new Map();
  records.forEach(record => {
    const pillar = clean(record.Piller);
    if (!pillar) return;
    clean(record.State).split('/').map(stateKey).filter(Boolean).forEach(state => {
      if (!sets.has(state)) sets.set(state, new Set());
      sets.get(state).add(pillar);
    });
  });
  return sets;
}

function crossColors(count) {
  const colors = ['#eef7fb', '#b8dced', '#81c3e0', '#45a8cf', '#1689b8', '#006eb5', '#004d80'];
  return colors[Math.min(count, colors.length - 1)];
}

function renderCrossLegend(maxCount) {
  document.getElementById('crossLegend').innerHTML = Array.from({ length: maxCount }, (_, index) => {
    const count = index + 1;
    return `<div class="cross-legend-row"><span class="cross-legend-swatch" style="background:${crossColors(count)}"></span><span>${count} active pillar${count === 1 ? '' : 's'}</span></div>`;
  }).join('') + '<div class="cross-legend-row"><span class="cross-legend-swatch" style="background:#f1f4f6"></span><span>Selected overlap not present</span></div>';
}

function renderPillarCombinations(pillarSets) {
  const combinations = new Map();
  pillarSets.forEach(pillars => {
    const key = [...pillars].sort().join(' + ');
    if (key) combinations.set(key, (combinations.get(key) || 0) + 1);
  });
  const rows = [...combinations.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  document.getElementById('pillarCombinations').innerHTML = rows.map(([combination, count]) => `<div class="combo-row"><span>${escapeHtml(combination)}</span><strong>${count} state${count === 1 ? '' : 's'}</strong></div>`).join('') || '<p>No pillar combinations available.</p>';
}

function renderCrossPillarMap() {
  const pillarSets = statePillarSets();
  const selected = [...document.querySelectorAll('#crossPillarChecks input:checked')].map(input => input.value);
  const maxCount = Math.max(1, ...[...pillarSets.values()].map(set => set.size));
  renderCrossLegend(maxCount); renderPillarCombinations(pillarSets);
  const matchingStates = [...pillarSets.entries()].filter(([, set]) => selected.every(pillar => set.has(pillar))).length;
  document.getElementById('crossSummary').textContent = selected.length
    ? `${matchingStates} state${matchingStates === 1 ? '' : 's'} contain${matchingStates === 1 ? 's' : ''} all selected pillars. Shading still reflects total active-pillar count.`
    : `States are shaded by the number of active pillars. Select pillars to find states where all selected pillars overlap.`;
  const features = boundaries.features.map(feature => {
    const name = feature.properties.adm1_en;
    const pillars = pillarSets.get(stateKey(name)) || new Set();
    const matches = selected.length === 0 || selected.every(pillar => pillars.has(pillar));
    return { type: 'Feature', properties: { State: name, pillars: [...pillars], matches }, geometry: feature.geometry };
  });
  if (crossLayer) crossLayer.remove();
  crossLayer = L.geoJSON(features, {
    style: feature => ({ color: '#ffffff', weight: 1.3, dashArray: '3 4', fillColor: feature.properties.matches ? crossColors(feature.properties.pillars.length) : '#f1f4f6', fillOpacity: .9 }),
    onEachFeature: (feature, layer) => {
      const pillars = feature.properties.pillars;
      const target = records.filter(record => stateKey(record.State) === stateKey(feature.properties.State)).reduce((sum, record) => sum + (valueOf(record['Direct Target 2026 Total']) || 0), 0);
      layer.bindTooltip(`<strong>${escapeHtml(feature.properties.State)}</strong><div>Active pillars: ${pillars.length}</div><div>${pillars.length ? escapeHtml(pillars.join(' | ')) : 'No recorded pillar presence'}</div><div>Direct target: ${numberFormat.format(target)}</div>`, { sticky: true, className: 'map-tooltip' });
      layer.on({ mouseover: event => event.target.setStyle({ weight: 2.4, color: '#006eb5' }), mouseout: event => crossLayer.resetStyle(event.target) });
    }
  }).addTo(crossMap);
}

function createCapitalLayer(targetMap) {
  return L.layerGroup([
    L.marker([15.5007, 32.5599], {
      icon: L.divIcon({ className: 'national-capital-marker', html: '★', iconSize: [24, 24], iconAnchor: [12, 12] }),
      title: 'Khartoum - National capital'
    }).bindTooltip('Khartoum - National capital')
  ]).addTo(targetMap);
}

function initCrossPillarView() {
  const pillars = unique(records.map(record => record.Piller));
  document.getElementById('crossPillarChecks').innerHTML = pillars.map(pillar => `<label class="pillar-check"><input type="checkbox" value="${escapeHtml(pillar)}">${escapeHtml(pillar)}</label>`).join('');
  crossMap = L.map('crossMap', { zoomControl: false, attributionControl: false, minZoom: 3, maxZoom: 12 }).setView([15.5, 30.2], 5);
  L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 120 }).addTo(crossMap);
  const crossBasemap = L.tileLayer(LIGHT_BASE_URL, { maxZoom: 12 }).addTo(crossMap);
  basemapLayers.push([crossMap, crossBasemap]);
  L.geoJSON(boundaries, { style: { color: '#ffffff', weight: 1.3, dashArray: '3 4', fill: false } }).addTo(crossMap);
  L.layerGroup(boundaries.features.map(feature => L.marker(L.geoJSON(feature).getBounds().getCenter(), {
    icon: L.divIcon({ className: 'cross-state-label', html: escapeHtml(feature.properties.adm1_en), iconSize: [110, 22], iconAnchor: [55, 11] }),
    interactive: false,
    keyboard: false
  }))).addTo(crossMap);
  crossCapitalLayer = createCapitalLayer(crossMap);
  document.querySelectorAll('#crossPillarChecks input').forEach(input => input.addEventListener('change', renderCrossPillarMap));
  document.getElementById('clearCrossPillars').addEventListener('click', () => { document.querySelectorAll('#crossPillarChecks input').forEach(input => { input.checked = false; }); renderCrossPillarMap(); });
  renderCrossPillarMap();
  crossMap.fitBounds(L.geoJSON(boundaries).getBounds(), { padding: [18, 18] });
}

function beneficiaryColumns() {
  const type = document.getElementById('beneficiaryType').value;
  const period = document.getElementById('beneficiaryPeriod').value;
  if (type === 'Both') return Object.fromEntries(['female', 'male', 'youth', 'total'].map(group => [group, [`Direct ${period} ${group[0].toUpperCase()}${group.slice(1)}`, `Indirect ${period} ${group[0].toUpperCase()}${group.slice(1)}`]]));
  return { female: `${type} ${period} Female`, male: `${type} ${period} Male`, youth: `${type} ${period} Youth`, total: `${type} ${period} Total` };
}

function beneficiaryRatio(values) {
  return values && values.target > 0 ? Math.min(1, Math.max(0, values.actual / values.target)) : null;
}

function aggregateBeneficiaries() {
  const columns = beneficiaryColumns();
  const totals = new Map();
  records.forEach(record => {
    const states = clean(record.State).split('/').map(part => stateKey(part)).filter(Boolean);
    if (!states.length) return;
    const values = Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, Array.isArray(column) ? column.reduce((sum, field) => sum + (valueOf(record[field]) || 0), 0) : (valueOf(record[column]) || 0)]));
    values.target = valueOf(record[`${document.getElementById('beneficiaryType').value === 'Indirect' ? 'Indirect' : 'Direct'} Target 2026 Total`]) || 0;
    values.actual = valueOf(record[`${document.getElementById('beneficiaryType').value === 'Indirect' ? 'Indirect' : 'Direct'} Actual Sep 2026 Total`]) || 0;
    if (document.getElementById('beneficiaryType').value === 'Both') {
      values.target = ['Direct', 'Indirect'].reduce((sum, type) => sum + (valueOf(record[`${type} Target 2026 Total`]) || 0), 0);
      values.actual = ['Direct', 'Indirect'].reduce((sum, type) => sum + (valueOf(record[`${type} Actual Sep 2026 Total`]) || 0), 0);
    }
    states.forEach(state => {
      const previous = totals.get(state) || { female: 0, male: 0, youth: 0, total: 0, target: 0, actual: 0, records: 0 };
      Object.keys(values).forEach(key => { previous[key] += values[key] / states.length; });
      previous.records += 1;
      totals.set(state, previous);
    });
  });
  return totals;
}

function beneficiaryMetric(values) {
  const indicator = document.getElementById('beneficiaryIndicator').value;
  if (!values) return null;
  if (indicator === 'reachRatio') return beneficiaryRatio(values);
  if (indicator === 'bivariate') return values.actual;
  if (indicator === 'distribution') return values.total;
  if (indicator === 'femaleShare') return values.total ? values.female / values.total * 100 : null;
  if (indicator === 'maleShare') return values.total ? values.male / values.total * 100 : null;
  if (indicator === 'youthShare') return values.total ? values.youth / values.total * 100 : null;
  if (indicator === 'genderBalance') return values.total ? (values.female - values.male) / values.total * 100 : null;
  return values[indicator];
}

function beneficiaryAbsoluteIndicator() {
  return ['total', 'female', 'male', 'youth'].includes(document.getElementById('beneficiaryIndicator').value);
}

function renderBeneficiaryLegend(values) {
  const legend = document.getElementById('beneficiaryLegend');
  const indicator = document.getElementById('beneficiaryIndicator').value;
  if (indicator === 'distribution') {
    legend.innerHTML = [['#006eb5', 'Female'], ['#596878', 'Male'], ['#e39b3b', 'Youth']].map(([color, label]) => `<div class="beneficiary-legend-row"><span class="beneficiary-swatch" style="background:${color}"></span><span>${label}</span></div>`).join('');
    return;
  }
  if (indicator === 'bivariate') {
    const colors = ['#d9f2b4', '#a8dca0', '#6aa67f', '#bde7d5', '#75c7ae', '#388f82', '#8bd4d5', '#4aa9ae', '#176b70'];
    const matrix = [2, 1, 0].flatMap(row => [0, 1, 2].map(column => colors[row * 3 + column]));
    legend.innerHTML = `<div class="bivariate-wrap"><span class="bivariate-high-high">High - High</span><span class="bivariate-low-high">Low - High</span><span class="bivariate-low-low">Low - Low</span><span class="bivariate-high-low">High -<br>Low</span><div class="bivariate-diamond">${matrix.map(color => `<span class="bivariate-cell" style="background:${color}"></span>`).join('')}</div></div>`;
    return;
  }
  if (beneficiaryAbsoluteIndicator()) {
    const max = Math.max(...values.filter(value => value !== null), 0);
    legend.innerHTML = `<div class="beneficiary-legend-row"><span class="beneficiary-swatch" style="border-radius:50%;background:#006eb5"></span><span>Circle size is proportional to count (max ${numberFormat.format(max)})</span></div>`;
    return;
  }
  if (indicator === 'reachRatio') {
    legend.innerHTML = '<div class="ratio-scale"><div class="ratio-gradient"></div><div class="ratio-scale-labels"><span>0.00</span><span>0.50</span><span>1.00</span></div></div>';
    return;
  }
  const colors = indicator === 'genderBalance' ? ['#b65755', '#f1f4f6', '#1689b8'] : ['#e6f3fb', '#81c3e0', '#006eb5'];
  const labels = indicator === 'genderBalance' ? ['Male dominant', 'Balanced', 'Female dominant'] : ['Low', 'Medium', 'High'];
  legend.innerHTML = colors.map((color, index) => `<div class="beneficiary-legend-row"><span class="beneficiary-swatch" style="background:${color}"></span><span>${labels[index]}</span></div>`).join('');
}

function renderBeneficiaryView() {
  const totals = aggregateBeneficiaries();
  const indicator = document.getElementById('beneficiaryIndicator').value;
  if (beneficiaryStateLabelsLayer) beneficiaryStateLabelsLayer.addTo(beneficiaryMap);
  const features = boundaries.features.map(feature => {
    const values = totals.get(stateKey(feature.properties.adm1_en));
    return { type: 'Feature', properties: { State: feature.properties.adm1_en, values, metric: beneficiaryMetric(values) }, geometry: feature.geometry };
  });
  const metricValues = features.map(feature => feature.properties.metric).filter(value => value !== null);
  renderBeneficiaryLegend(metricValues);
  const overall = [...totals.values()].reduce((sum, values) => ({ female: sum.female + values.female, male: sum.male + values.male, youth: sum.youth + values.youth, total: sum.total + values.total, target: sum.target + values.target, actual: sum.actual + values.actual }), { female: 0, male: 0, youth: 0, total: 0, target: 0, actual: 0 });
  document.getElementById('beneficiaryTotal').textContent = indicator === 'reachRatio' ? `${overall.target ? Math.min(1, overall.actual / overall.target).toFixed(2) : '0.00'}` : numberFormat.format(overall.total);
  document.getElementById('beneficiaryPrimaryLabel').textContent = indicator === 'reachRatio' ? 'Actual / target reach' : 'Total';
  document.getElementById('beneficiaryFemaleShare').textContent = `${overall.total ? Math.round(overall.female / overall.total * 100) : 0}%`;
  document.getElementById('beneficiaryMaleShare').textContent = `${overall.total ? Math.round(overall.male / overall.total * 100) : 0}%`;
  document.getElementById('beneficiaryYouthShare').textContent = `${overall.total ? Math.round(overall.youth / overall.total * 100) : 0}%`;
  document.getElementById('beneficiaryAreas').textContent = totals.size;
  const labels = { distribution: 'Beneficiaries Distribution (Female, Male and Youth)', bivariate: 'Geographic Distribution of Beneficiary Reach Compared to Targets', total: 'Total beneficiaries', female: 'Female beneficiaries', male: 'Male beneficiaries', youth: 'Youth beneficiaries', femaleShare: 'Female share', maleShare: 'Male share', youthShare: 'Youth share', genderBalance: 'Gender balance', reachRatio: 'Ratio of Beneficiary Reach Against Targets' };
  const typeLabel = document.getElementById('beneficiaryType').options[document.getElementById('beneficiaryType').selectedIndex].text;
  document.getElementById('beneficiaryTitle').textContent = `${labels[indicator]} | ${typeLabel}`;
  if (beneficiaryLayer) beneficiaryLayer.remove();
  if (distributionLeaders) distributionLeaders.remove();
  if (indicator === 'distribution') {
    const max = Math.max(...metricValues, 1);
    distributionLeaders = L.layerGroup().addTo(beneficiaryMap);
    beneficiaryLayer = L.layerGroup(features.filter(feature => feature.properties.values).map(feature => {
      const values = feature.properties.values;
      const stateKeyName = stateKey(feature.properties.State);
      const center = L.geoJSON(feature).getBounds().getCenter();
      const offset = stateKeyName === 'kassala' ? L.latLng(center.lat + 0.15, center.lng + 1.15) : stateKeyName === 'gedaref' ? L.latLng(center.lat - 0.05, center.lng + 1.0) : center;
      if (offset !== center) L.polyline([center, offset], { color: '#006eb5', weight: 1.2, dashArray: '3 3', interactive: false }).addTo(distributionLeaders);
      const total = values.female + values.male + values.youth;
      const radiusWidth = 82 + Math.sqrt((values.total || 0) / max) * 18;
      const femaleWidth = total ? values.female / total * 100 : 0;
      const maleWidth = total ? values.male / total * 100 : 0;
      const youthWidth = total ? values.youth / total * 100 : 0;
      const femaleShare = values.total ? values.female / values.total * 100 : 0;
      const maleShare = values.total ? values.male / values.total * 100 : 0;
      const youthShare = values.total ? values.youth / values.total * 100 : 0;
      const boxWidth = Math.max(100, Math.min(144, 62 + clean(feature.properties.State).length * 5.2));
      const barWidth = boxWidth - 10;
      const marker = L.marker(offset, { zIndexOffset: 1000, icon: L.divIcon({ className: 'distribution-marker', html: `<div class="distribution-bar" style="width:${barWidth}px"><span class="distribution-female" style="width:${femaleWidth}%"></span><span class="distribution-male" style="width:${maleWidth}%"></span><span class="distribution-youth" style="width:${youthWidth}%"></span></div><div class="distribution-percentages">F ${femaleShare.toFixed(0)}% &nbsp; M ${maleShare.toFixed(0)}% &nbsp; Y ${youthShare.toFixed(0)}%</div><div class="distribution-state">${escapeHtml(feature.properties.State)}</div>`, iconSize: [boxWidth, 52], iconAnchor: [boxWidth / 2, 26] }) });
      marker.bindTooltip(beneficiaryTooltip(feature), { sticky: true, className: 'map-tooltip' });
      return marker;
    })).addTo(beneficiaryMap);
  } else if (beneficiaryAbsoluteIndicator()) {
    const max = Math.max(...metricValues, 1);
    beneficiaryLayer = L.layerGroup(features.filter(feature => feature.properties.metric !== null).map(feature => {
      const center = L.geoJSON(feature).getBounds().getCenter();
      const radius = 7 + Math.sqrt(feature.properties.metric / max) * 28;
      const marker = L.circleMarker(center, { radius, color: '#fff', weight: 1.5, fillColor: '#006eb5', fillOpacity: .78 });
      marker.bindTooltip(beneficiaryTooltip(feature), { sticky: true, className: 'map-tooltip' });
      return marker;
    })).addTo(beneficiaryMap);
  } else {
    const min = Math.min(...metricValues, 0); const max = Math.max(...metricValues, 1);
    if (indicator === 'bivariate') {
      const targets = features.map(feature => feature.properties.values?.target || 0).sort((a, b) => a - b);
      const actuals = features.map(feature => feature.properties.values?.actual || 0).sort((a, b) => a - b);
      bivariateThresholds = { target: [targets[Math.floor(targets.length * .33)] || 0, targets[Math.floor(targets.length * .66)] || 0], actual: [actuals[Math.floor(actuals.length * .33)] || 0, actuals[Math.floor(actuals.length * .66)] || 0] };
    }
    beneficiaryLayer = L.geoJSON(features, { style: feature => ({ color: '#ffffff', weight: 1.3, dashArray: '3 4', fillColor: beneficiaryColor(feature.properties.metric, indicator, min, max, feature.properties.values), fillOpacity: .9 }), onEachFeature: (feature, layer) => layer.bindTooltip(beneficiaryTooltip(feature), { sticky: true, className: 'map-tooltip' }) }).addTo(beneficiaryMap);
  }
}

function beneficiaryColor(value, indicator, min, max, values) {
  if (value === null) return '#f8fafc';
  if (indicator === 'bivariate') {
    const targetLevel = values.target <= bivariateThresholds.target[0] ? 0 : values.target <= bivariateThresholds.target[1] ? 1 : 2;
    const actualLevel = values.actual <= bivariateThresholds.actual[0] ? 0 : values.actual <= bivariateThresholds.actual[1] ? 1 : 2;
    return [['#d9f2b4', '#a8dca0', '#6aa67f'], ['#bde7d5', '#75c7ae', '#388f82'], ['#8bd4d5', '#4aa9ae', '#176b70']][actualLevel][targetLevel];
  }
  if (indicator === 'genderBalance') return value < -10 ? '#b65755' : value > 10 ? '#1689b8' : '#f1f4f6';
  if (indicator === 'reachRatio') {
    const red = [217, 83, 79];
    const blue = [0, 110, 181];
    const amount = Math.min(1, Math.max(0, value));
    return `rgb(${red.map((channel, index) => Math.round(channel + (blue[index] - channel) * amount)).join(',')})`;
  }
  const ratio = (value - min) / Math.max(max - min, 1);
  return ratio > .66 ? '#006eb5' : ratio > .33 ? '#81c3e0' : '#e6f3fb';
}

function beneficiaryTooltip(feature) {
  const values = feature.properties.values || { total: 0, female: 0, male: 0, youth: 0 };
  const share = value => values.total ? `${(value / values.total * 100).toFixed(1)}%` : 'No data';
  const reach = beneficiaryRatio(values);
  return `<strong>${escapeHtml(feature.properties.State)}</strong><div>Total: ${numberFormat.format(values.total)}</div><div>Female: ${numberFormat.format(values.female)} (${share(values.female)})</div><div>Male: ${numberFormat.format(values.male)} (${share(values.male)})</div><div>Youth: ${numberFormat.format(values.youth)} (${share(values.youth)})</div><div>Reach ratio: ${reach === null ? 'No target' : reach.toFixed(2)}</div>`;
}

function initBeneficiaryView() {
  beneficiaryMap = L.map('beneficiaryMap', { zoomControl: false, attributionControl: false, minZoom: 3, maxZoom: 12 }).setView([15.5, 30.2], 5);
  L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 120 }).addTo(beneficiaryMap);
  const beneficiaryBasemap = L.tileLayer(LIGHT_BASE_URL, { maxZoom: 12 }).addTo(beneficiaryMap);
  const beneficiaryLabels = L.tileLayer(LIGHT_LABELS_URL, { maxZoom: 12 }).addTo(beneficiaryMap);
  basemapLayers.push([beneficiaryMap, beneficiaryBasemap, beneficiaryLabels]);
  const beneficiaryBoundaries = L.geoJSON(boundaries, { style: { color: '#ffffff', weight: 1.3, dashArray: '3 4', fillColor: '#c5e1f0', fillOpacity: .9 } }).addTo(beneficiaryMap);
  beneficiaryStateLabelsLayer = L.layerGroup(boundaries.features.map(feature => L.marker(L.geoJSON(feature).getBounds().getCenter(), {
    icon: L.divIcon({ className: 'state-name-label', html: escapeHtml(feature.properties.adm1_en), iconSize: [110, 22], iconAnchor: [55, 11] }),
    interactive: false,
    keyboard: false
  }))).addTo(beneficiaryMap);
  beneficiaryCapitalLayer = createCapitalLayer(beneficiaryMap);
  ['beneficiaryIndicator', 'beneficiaryType', 'beneficiaryPeriod'].forEach(id => document.getElementById(id).addEventListener('change', renderBeneficiaryView));
  renderBeneficiaryView();
  beneficiaryMap.fitBounds(L.geoJSON(boundaries).getBounds(), { padding: [18, 18] });
}

function switchView(view) {
  const recordsView = view === 'records';
  const crossView = view === 'cross';
  document.querySelector('.controls').hidden = !recordsView;
  document.querySelector('.kpis').hidden = !recordsView;
  document.querySelector('.map-sheet').hidden = !recordsView;
  document.getElementById('crossView').hidden = recordsView;
  document.getElementById('beneficiaryView').hidden = recordsView || crossView;
  document.getElementById('recordsTab').classList.toggle('active', recordsView);
  document.getElementById('crossPillarTab').classList.toggle('active', crossView);
  document.getElementById('beneficiaryTab').classList.toggle('active', !recordsView && !crossView);
  document.getElementById('mapTitle').textContent = recordsView ? 'Direct Beneficiaries by State' : crossView ? 'Cross-Pillar Activity by State' : 'Beneficiary Analysis by State';
  document.getElementById('mapSubtitle').textContent = recordsView ? '2026 Target | All Pillars | Total beneficiaries' : crossView ? 'Pillar presence and geographic overlap' : `${document.getElementById('beneficiaryPeriod').options[document.getElementById('beneficiaryPeriod').selectedIndex].text} | Demographic distribution by state`;
  if (crossView) { crossMap.invalidateSize(); renderCrossPillarMap(); }
  if (!recordsView && !crossView) { beneficiaryMap.invalidateSize(); renderBeneficiaryView(); }
  else map.invalidateSize();
}

function updateLabelStyle() {
  const root = document.documentElement;
  const font = document.getElementById('labelFont').value;
  const size = document.getElementById('labelSize').value;
  const color = document.getElementById('labelColor').value;
  root.style.setProperty('--map-label-font', font);
  root.style.setProperty('--map-label-size', `${size}px`);
  root.style.setProperty('--map-label-color', color);
  document.getElementById('labelSizeValue').textContent = `${size}px`;
}

function updateBasemapVisibility() {
  const visible = document.getElementById('showBasemap').checked;
  basemapLayers.forEach(([targetMap, ...layers]) => {
    targetMap.getContainer().classList.toggle('basemap-hidden', !visible);
    layers.forEach(layer => {
      if (visible && !targetMap.hasLayer(layer)) layer.addTo(targetMap);
      if (!visible && targetMap.hasLayer(layer)) layer.removeFrom(targetMap);
    });
  });
}

function resetView() {
  map.setView([15.5, 30.2], 5);
}

async function init() {
  map = L.map('map', { zoomControl: false, attributionControl: false, minZoom: 3, maxZoom: 12 }).setView([15.5, 30.2], 5);
  map.createPane('stateNames');
  map.getPane('stateNames').style.zIndex = 650;
  map.getPane('stateNames').style.pointerEvents = 'none';
  L.control.scale({ position: 'bottomleft', imperial: false, maxWidth: 120 }).addTo(map);
  lightBasemap = L.tileLayer(LIGHT_BASE_URL, { attribution: BASEMAP_ATTRIBUTION, maxZoom: 12, crossOrigin: true });
  lightLabels = L.tileLayer(LIGHT_LABELS_URL, { attribution: '', maxZoom: 12, crossOrigin: true });
  lightBasemap.addTo(map);
  lightLabels.addTo(map);
  basemapLayers.push([map, lightBasemap, lightLabels]);
  try {
    const [dataResponse, boundaryResponse] = await Promise.all([fetch(DATA_PATH), fetch(BASEMAP_PATH)]);
    if (!dataResponse.ok || !boundaryResponse.ok) throw new Error('Data files could not be loaded');
    const data = await dataResponse.json(); boundaries = await boundaryResponse.json();
    records = (data.features || []).map(feature => feature.properties || {});
    populateFilters();
    boundaryLayer = L.geoJSON(boundaries, { style: { color: '#ffffff', weight: 1.3, dashArray: '3 4', fillColor: '#eef4f7', fillOpacity: .62 } }).addTo(map);
    projectLayer = L.layerGroup();
    capitalLayer = L.layerGroup([
      L.marker([15.5007, 32.5599], {
        icon: L.divIcon({ className: 'national-capital-marker', html: '★', iconSize: [24, 24], iconAnchor: [12, 12] }),
        title: 'Khartoum - National capital'
      }).bindTooltip('Khartoum - National capital')
    ]).addTo(map);
    renderStateLabels();
    [...document.querySelectorAll('select')].forEach(control => control.addEventListener('change', () => {
      if (control.id === 'pillarSelect' || control.id === 'stateSelect') updateDependentFilters();
      renderMap();
    }));
    document.getElementById('intensityRange').addEventListener('input', renderMap);
    presenceToggle.addEventListener('change', renderMap);
    document.getElementById('recordsTab').addEventListener('click', () => switchView('records'));
    document.getElementById('crossPillarTab').addEventListener('click', () => switchView('cross'));
    document.getElementById('beneficiaryTab').addEventListener('click', () => switchView('beneficiary'));
    ['labelFont', 'labelSize', 'labelColor'].forEach(id => document.getElementById(id).addEventListener('input', updateLabelStyle));
    document.getElementById('showBasemap').addEventListener('change', updateBasemapVisibility);
    updateLabelStyle();
    initCrossPillarView();
    initBeneficiaryView();
    document.getElementById('printButton').addEventListener('click', () => window.print());
    renderMap(); resetView();
  } catch (error) {
    document.getElementById('map').innerHTML = '<div class="map-error">The dashboard could not load the validated data. Serve the project through a local web server and check the browser console.</div>';
    console.error(error);
  }
}

init();