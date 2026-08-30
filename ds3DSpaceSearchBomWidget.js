/* global require, widget */
(function () {
  'use strict';

  require(['DS/WAFData/WAFData', 'DS/i3DXCompassServices/i3DXCompassServices'], function (WAFData, i3DXCompassServices) {
    var PAGE_SIZE = 1000;
    var DEFAULT_CONTEXT = 'VPLMProjectLeader.Company Name.3DXPowerShell';
    var serviceUrl = null;
    var objects = [];
    var busy = false;

    function el(selector) { return widget.body.querySelector(selector); }
    function valueOf(object, names) {
      var i;
      if (!object) { return ''; }
      for (i = 0; i < names.length; i += 1) {
        if (object[names[i]] !== undefined && object[names[i]] !== null) { return String(object[names[i]]); }
      }
      return '';
    }
    function escapeHtml(value) {
      return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function setStatus(message, error) {
      var node = el('.dsbom-status');
      node.className = error ? 'dsbom-status error' : 'dsbom-status';
      node.textContent = message || '';
    }
    function errorMessage(error, response) {
      return valueOf(response, ['message', 'errorMessage', 'detail']) || (error && (error.message || String(error))) || 'Errore durante la richiesta.';
    }
    function members(response) {
      var candidates = [response && response.member, response && response.items, response && response.results, response && response.objects, response && response.data && response.data.member];
      var i;
      for (i = 0; i < candidates.length; i += 1) { if (Array.isArray(candidates[i])) { return candidates[i]; } }
      return [];
    }
    function totalOf(response, fallback) {
      var total = response && (response.totalItems || response.total || (response.data && response.data.totalItems));
      return total !== undefined && total !== null && !isNaN(Number(total)) ? Number(total) : fallback;
    }
    function securityContext() { return widget.getValue('SecurityContext') || DEFAULT_CONTEXT; }

    function configureContexts(contexts) {
      var current = securityContext();
      var options = [];
      var i;
      if (contexts.indexOf(current) < 0) { contexts.unshift(current); }
      contexts.sort(function (a, b) { return a.localeCompare(b); });
      for (i = 0; i < contexts.length; i += 1) { options.push({ label: contexts[i], value: contexts[i] }); }
      widget.addPreference({ name: 'SecurityContext', type: 'list', label: 'Security context', defaultValue: current, options: options });
      widget.setValue('SecurityContext', current);
    }
    function collectContexts(object, role, organization, space, component, result) {
      var i;
      var name;
      var nextRole = role;
      var nextOrganization = organization;
      var nextSpace = space;
      if (typeof object === 'string') {
        if (component === 'role') { nextRole = object; }
        if (component === 'organization') { nextOrganization = object; }
        if (component === 'space') { nextSpace = object; }
        if (object.replace(/^ctx::/i, '').split('.').length >= 3) { result.push(object.replace(/^ctx::/i, '').trim()); }
        if (component === 'space' && nextRole && nextOrganization) { result.push(nextRole + '.' + nextOrganization + '.' + object); }
        return;
      }
      if (Array.isArray(object)) {
        for (i = 0; i < object.length; i += 1) { collectContexts(object[i], nextRole, nextOrganization, nextSpace, component, result); }
        return;
      }
      if (!object || typeof object !== 'object') { return; }
      name = object.name || object.title || object.id || '';
      if (component === 'role') { nextRole = name || nextRole; }
      if (component === 'organization') { nextOrganization = name || nextOrganization; }
      if (component === 'space') { nextSpace = name || nextSpace; }
      if (nextRole && nextOrganization && nextSpace) { result.push(nextRole + '.' + nextOrganization + '.' + nextSpace); }
      Object.keys(object).forEach(function (key) {
        var lower = key.toLowerCase();
        var nextComponent = component;
        if (lower === 'role' || lower === 'roles' || lower === 'responsibility' || lower === 'responsibilities' || lower === 'credentials') { nextComponent = 'role'; }
        if (lower === 'organization' || lower === 'organizations' || lower === 'company' || lower === 'companies') { nextComponent = 'organization'; }
        if (lower === 'collabspace' || lower === 'collabspaces' || lower === 'collaborativespace' || lower === 'collaborativespaces') { nextComponent = 'space'; }
        collectContexts(object[key], nextRole, nextOrganization, nextSpace, nextComponent, result);
      });
    }
    function ensureServiceUrl(done, failure) {
      var platformId = widget.getValue('x3dPlatformId');
      if (serviceUrl) { done(); return; }
      if (!platformId) { failure('Platform instance non disponibile. Pubblica l\'app come Additional App trusted.'); return; }
      i3DXCompassServices.getServiceUrl({
        serviceName: '3DSpace', platformId: platformId,
        onComplete: function (url) { if (!url) { failure('URL 3DSpace non disponibile.'); return; } serviceUrl = String(url).replace(/\/$/, ''); done(); },
        onFailure: function () { failure('Impossibile recuperare l\'URL 3DSpace.'); }
      });
    }
    function loadContexts() {
      ensureServiceUrl(function () {
        WAFData.authenticatedRequest(serviceUrl + '/resources/modeler/pno/person?current=true&select=collabspaces', {
          method: 'GET', type: 'json', timeout: 30000,
          onComplete: function (response) {
            var result = [];
            collectContexts(response, null, null, null, null, result);
            result = result.filter(function (item, index, list) { return list.indexOf(item) === index; });
            configureContexts(result.length ? result : [DEFAULT_CONTEXT]);
          },
          onFailure: function () { configureContexts([DEFAULT_CONTEXT]); }
        });
      }, function () { configureContexts([DEFAULT_CONTEXT]); });
    }
    function requestPage(modeler, type, mask, searchText, skip, done, failure) {
      var encodedType = encodeURIComponent(type).replace(/%3A/gi, ':');
      var url = serviceUrl + '/resources/v1/modeler/' + encodeURIComponent(modeler) + '/' + encodedType + '/search' + '?$searchStr=' + encodeURIComponent(searchText) + '&$top=' + PAGE_SIZE + '&$skip=' + skip;
      if (mask) { url += '&$mask=' + encodeURIComponent(mask); }
      WAFData.authenticatedRequest(url, { method: 'GET', type: 'json', timeout: 60000, headers: { SecurityContext: securityContext() }, onComplete: done, onFailure: failure });
    }
    function search() {
      var modeler = el('.dsbom-modeler').value.trim();
      var type = el('.dsbom-type').value.trim();
      var mask = el('.dsbom-mask').value.trim();
      var text = el('.dsbom-search').value.trim();
      var started = Date.now();
      var all = [];
      var skip = 0;
      if (busy) { return; }
      if (!modeler || !type || text.length < 2) { setStatus('Inserisci modeler, tipo e almeno 2 caratteri di ricerca.', true); return; }
      busy = true; el('.dsbom-search-button').disabled = true; el('.dsbom-results').innerHTML = '<tbody><tr><td class="dsbom-empty" colspan="5">Ricerca in corso...</td></tr></tbody>'; el('.dsbom-bom').innerHTML = '<tbody><tr><td class="dsbom-empty" colspan="5">Seleziona un risultato per caricare la distinta.</td></tr></tbody>'; 
      ensureServiceUrl(function () {
        function next() {
          requestPage(modeler, type, mask, text, skip, function (response) {
            var page = members(response); var total = totalOf(response, skip + page.length); all = all.concat(page); skip += page.length;
            if (!page.length || skip >= total || page.length < PAGE_SIZE) { objects = all; renderResults(); setStatus(objects.length + ' oggetti | ' + (Date.now() - started) + ' ms', false); busy = false; el('.dsbom-search-button').disabled = false; } else { next(); }
          }, function (error, response) { setStatus(errorMessage(error, response), true); busy = false; el('.dsbom-search-button').disabled = false; });
        }
        next();
      }, function (message) { setStatus(message, true); busy = false; el('.dsbom-search-button').disabled = false; });
    }
    function renderResults() {
      var html = '<thead><tr><th>Title</th><th>Name</th><th>Id</th><th>Type</th><th>State</th></tr></thead><tbody>'; var i; var item;
      if (!objects.length) { el('.dsbom-results').innerHTML = '<tbody><tr><td class="dsbom-empty" colspan="5">Nessun oggetto trovato.</td></tr></tbody>'; return; }
      for (i = 0; i < objects.length; i += 1) { item = objects[i]; html += '<tr class="ds-object" data-index="' + i + '"><td>' + escapeHtml(valueOf(item, ['title', 'Title'])) + '</td><td>' + escapeHtml(valueOf(item, ['name', 'Name'])) + '</td><td>' + escapeHtml(valueOf(item, ['id', 'Id'])) + '</td><td>' + escapeHtml(valueOf(item, ['type', 'Type'])) + '</td><td>' + escapeHtml(valueOf(item, ['state', 'State'])) + '</td></tr>'; }
      el('.dsbom-results').innerHTML = html + '</tbody>';
      el('.dsbom-results').querySelectorAll('tr.ds-object').forEach(function (row) { row.addEventListener('click', function () { el('.dsbom-results').querySelectorAll('tr.ds-selected').forEach(function (old) { old.classList.remove('ds-selected'); }); row.classList.add('ds-selected'); loadBom(objects[Number(row.getAttribute('data-index'))]); }); });
    }
    function csrf(done, failure) {
      WAFData.authenticatedRequest(serviceUrl + '/resources/v1/application/CSRF', { method: 'GET', type: 'json', timeout: 30000, headers: { SecurityContext: securityContext() }, onComplete: function (response) { var token = response && response.value; if (!token && response && response.data) { token = response.data.value; } if (token) { done(token); } else { failure('Token CSRF non restituito.'); } }, onFailure: function (error, response) { failure(errorMessage(error, response)); } });
    }
    function loadBom(item) {
      var id = valueOf(item, ['id', 'Id']);
      if (!id) { setStatus('L\'oggetto selezionato non contiene un ID.', true); return; }
      setStatus('Caricamento distinta...', false);
      csrf(function (token) {
        var body = { expandDepth: Number(el('.dsbom-depth').value), withPath: true, type_filter_bo: ['VPMReference', 'VPMRepReference'], type_filter_rel: ['VPMInstance', 'VPMRepInstance'], filter: '' };
        WAFData.authenticatedRequest(serviceUrl + '/resources/v1/modeler/dseng/dseng:EngItem/' + encodeURIComponent(id) + '/expand', { method: 'POST', type: 'json', timeout: 120000, data: JSON.stringify(body), headers: { 'Content-Type': 'application/json;charset=UTF-8', SecurityContext: securityContext(), ENO_CSRF_TOKEN: token }, onComplete: function (response) { renderBom(response, item); setStatus('Distinta caricata.', false); }, onFailure: function (error, response) { setStatus('Impossibile caricare la distinta: ' + errorMessage(error, response), true); } });
      }, function (message) { setStatus('Impossibile caricare la distinta: ' + message, true); });
    }
    function renderBom(response, root) {
      var entries = members(response); var paths = {}; var rows = []; var i; var item; var path; var level; var html = '<thead><tr><th>Livello</th><th>Title</th><th>Name</th><th>Id</th><th>Type / State</th></tr></thead><tbody>';
      for (i = 0; i < entries.length; i += 1) { if (Array.isArray(entries[i].Path)) { paths[entries[i].Path[entries[i].Path.length - 1]] = entries[i].Path; } }
      rows.push({ item: root, level: 0 });
      for (i = 0; i < entries.length; i += 1) { item = entries[i]; if (item.Path) { continue; } path = paths[valueOf(item, ['id', 'Id'])]; level = path ? Math.max(1, path.length - 1) : 1; rows.push({ item: item, level: level }); }
      if (rows.length === 1 && !valueOf(root, ['title', 'Title'])) { el('.dsbom-bom').innerHTML = '<tbody><tr><td class="dsbom-empty" colspan="5">Nessun componente trovato.</td></tr></tbody>'; return; }
      for (i = 0; i < rows.length; i += 1) { item = rows[i].item; html += '<tr><td class="dsbom-level">' + rows[i].level + '</td><td>' + escapeHtml(valueOf(item, ['title', 'Title'])) + '</td><td>' + escapeHtml(valueOf(item, ['name', 'Name'])) + '</td><td>' + escapeHtml(valueOf(item, ['id', 'Id'])) + '</td><td>' + escapeHtml(valueOf(item, ['type', 'Type'])) + ' / ' + escapeHtml(valueOf(item, ['state', 'State'])) + '</td></tr>'; }
      el('.dsbom-bom').innerHTML = html + '</tbody>';
    }
    function setup() {
      widget.body.innerHTML = '<main class="dsbom-root"><div class="dsbom-toolbar"><div class="dsbom-field"><label>Modeler</label><input class="dsbom-modeler" value="dseng" /></div><div class="dsbom-field"><label>Tipo tecnico</label><input class="dsbom-type" value="dseng:EngItem" /></div><div class="dsbom-field"><label>Mask (opzionale)</label><input class="dsbom-mask" value="dsmveng:EngItemMask.Common" /></div><div class="dsbom-field"><label>Prefisso / ricerca</label><input class="dsbom-search" placeholder="es. DO- o SP-" /></div><button class="dsbom-button dsbom-search-button" type="button">Cerca</button></div><div class="dsbom-status">Pronto.</div><section class="dsbom-section"><h2 class="dsbom-section-title">Risultati</h2><div class="dsbom-table-wrap"><table class="dsbom-table dsbom-results"><tbody><tr><td class="dsbom-empty" colspan="5">Esegui una ricerca.</td></tr></tbody></table></div></section><section class="dsbom-section"><h2 class="dsbom-section-title">Distinta <select class="dsbom-depth" title="Profondita della distinta"><option value="1">Livello 1</option><option value="2">Livello 2</option><option value="-1">Tutti i livelli</option></select></h2><div class="dsbom-table-wrap"><table class="dsbom-table dsbom-bom-table dsbom-bom"><tbody><tr><td class="dsbom-empty" colspan="5">Seleziona un risultato per caricare la distinta.</td></tr></tbody></table></div></section></main>';
      el('.dsbom-search-button').addEventListener('click', search); el('.dsbom-search').addEventListener('keydown', function (event) { if (event.key === 'Enter') { search(); } }); loadContexts();
    }
    widget.addEvent('onLoad', setup);
  });
}());
