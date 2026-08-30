/* global require, widget */
(function () {
  'use strict';

  function start() {
    if (typeof widget === 'undefined' || typeof require !== 'function') {
      window.setTimeout(start, 50);
      return;
    }

    require([
      'DS/WAFData/WAFData',
      'DS/i3DXCompassServices/i3DXCompassServices',
      'DS/TagNavigatorProxy/TagNavigatorProxy'
    ], function (WAFData, i3DXCompassServices, TagNavigatorProxy) {
      var PAGE_SIZE = 1000;
      var DEFAULT_CONTEXT = 'VPLMProjectLeader.Company Name.3DXPowerShell';
      var serviceUrl = null;
      var objects = [];
      var selectedObject = null;
      var bomRoot = null;
      var bomNodes = {};
      var expandedNodes = {};
      var resultFilters = {};
      var bomFilters = {};
      var tagProxy = null;
      var tagFilterActive = false;
      var visibleTagSubjects = {};
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
      function findNestedValue(object, name) {
        var keys, i, found;
        if (!object || typeof object !== 'object') { return ''; }
        if (object[name] !== undefined && object[name] !== null) { return String(object[name]); }
        keys = Object.keys(object);
        for (i = 0; i < keys.length; i += 1) {
          found = findNestedValue(object[keys[i]], name);
          if (found) { return found; }
        }
        return '';
      }
      function errorMessage(error, response) {
        return findNestedValue(response, 'message') || findNestedValue(response, 'errorMessage') || findNestedValue(response, 'detail') || (error && (error.message || String(error))) || 'Errore durante la richiesta.';
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
      function objectId(item) { return valueOf(item, ['id', 'Id', 'identifier', 'Identifier']); }
      function subjectOf(item) { return 'urn:3dx:' + (widget.getValue('x3dPlatformId') || 'platform') + ':' + objectId(item); }
      function fieldValue(item, field) {
        if (field === 'title') { return valueOf(item, ['title', 'Title']); }
        if (field === 'name') { return valueOf(item, ['name', 'Name']); }
        if (field === 'id') { return objectId(item); }
        if (field === 'type') { return valueOf(item, ['type', 'Type']); }
        if (field === 'state') { return valueOf(item, ['state', 'State']); }
        return '';
      }
      function stateClass(state) { return String(state || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
      function stateBadge(state) {
        var text = String(state || 'N/A');
        return '<span class="dsbom-state dsbom-state-' + escapeHtml(stateClass(text)) + '"><span></span>' + escapeHtml(text.replace(/_/g, ' ')) + '</span>';
      }
      function matchesFilters(item, filters) {
        var keys = Object.keys(filters);
        var i, filter;
        for (i = 0; i < keys.length; i += 1) {
          filter = String(filters[keys[i]] || '').toLowerCase().trim();
          if (filter && fieldValue(item, keys[i]).toLowerCase().indexOf(filter) < 0) { return false; }
        }
        return true;
      }
      function tagVisible(item) { return !tagFilterActive || !!visibleTagSubjects[subjectOf(item)]; }
      function columnHeaders(kind, columns) {
        var html = '<thead><tr>';
        var i;
        for (i = 0; i < columns.length; i += 1) { html += '<th>' + columns[i].label + '</th>'; }
        html += '</tr><tr class="dsbom-filter-row">';
        for (i = 0; i < columns.length; i += 1) {
          html += '<th>' + (columns[i].filter ? '<input class="dsbom-column-filter" data-kind="' + kind + '" data-field="' + columns[i].field + '" value="' + escapeHtml(kind === 'results' ? resultFilters[columns[i].field] || '' : bomFilters[columns[i].field] || '') + '" />' : '') + '</th>';
        }
        return html + '</tr></thead>';
      }
      function bindColumnFilters() {
        widget.body.querySelectorAll('.dsbom-column-filter').forEach(function (input) {
          input.addEventListener('input', function () {
            var target = input.getAttribute('data-kind') === 'results' ? resultFilters : bomFilters;
            target[input.getAttribute('data-field')] = input.value;
            if (input.getAttribute('data-kind') === 'results') { renderResults(); } else { renderBom(); }
          });
        });
      }

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
        var i, name, nextRole = role, nextOrganization = organization, nextSpace = space;
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

      function buildTags(item) {
        var tags = [];
        function add(sixw, object, label, type) {
          if (object) { tags.push({ sixw: sixw, object: String(object), dispValue: label || String(object), type: type || 'string' }); }
        }
        add('ds6w:what/ds6w:title', fieldValue(item, 'title'));
        add('ds6w:what/ds6w:type', fieldValue(item, 'type'));
        add('ds6w:what/ds6w:state', fieldValue(item, 'state'));
        add('ds6w:who/ds6w:owner', valueOf(item, ['owner', 'Owner']));
        add('ds6w:where/ds6w:collabspace', valueOf(item, ['collabspace', 'collabSpace', 'CollaborativeSpace']));
        add('ds6w:when/ds6w:modified', valueOf(item, ['modified', 'Modified']), null, 'date');
        return tags;
      }
      function sync6WTags() {
        var subjectTags = {};
        var seen = {};
        var ids, i;
        function add(item) {
          var subject = subjectOf(item);
          if (!objectId(item) || seen[subject]) { return; }
          seen[subject] = true;
          subjectTags[subject] = buildTags(item);
        }
        if (!tagProxy) { return; }
        objects.forEach(add);
        if (bomRoot) { add(bomRoot); }
        ids = Object.keys(bomNodes);
        for (i = 0; i < ids.length; i += 1) { add(bomNodes[ids[i]].item); }
        try { tagProxy.setSubjectsTags(subjectTags); tagProxy.activate(); } catch (ignore) { }
      }
      function initialize6WTagger() {
        try {
          tagProxy = TagNavigatorProxy.createProxy({
            widgetId: widget.id,
            filteringMode: 'WithFilteringServices',
            tenant: widget.getValue('x3dPlatformId')
          });
          tagProxy.addEvent('onFilterSubjectsChange', function (filter) {
            var subjects = filter && filter.filteredSubjectList;
            var i;
            visibleTagSubjects = {};
            tagFilterActive = Array.isArray(subjects) && subjects.length > 0;
            if (tagFilterActive) {
              for (i = 0; i < subjects.length; i += 1) { visibleTagSubjects[subjects[i]] = true; }
            }
            renderResults();
            renderBom();
          });
        } catch (ignore) { tagProxy = null; }
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
        busy = true;
        el('.dsbom-search-button').disabled = true;
        selectedObject = null;
        bomRoot = null;
        bomNodes = {};
        resultFilters = {};
        bomFilters = {};
        tagFilterActive = false;
        visibleTagSubjects = {};
        function next() {
          requestPage(modeler, type, mask, text, skip, function (response) {
            var page = members(response);
            var total = totalOf(response, skip + page.length);
            all = all.concat(page);
            skip += page.length;
            if (!page.length || skip >= total || page.length < PAGE_SIZE) {
              objects = all;
              renderResults();
              renderBom();
              sync6WTags();
              setStatus(objects.length + ' oggetti | ' + (Date.now() - started) + ' ms', false);
              busy = false;
              el('.dsbom-search-button').disabled = false;
            } else { next(); }
          }, function (error, response) {
            setStatus(errorMessage(error, response), true);
            busy = false;
            el('.dsbom-search-button').disabled = false;
          });
        }
        ensureServiceUrl(next, function (message) {
          setStatus(message, true);
          busy = false;
          el('.dsbom-search-button').disabled = false;
        });
      }
      function renderResults() {
        var columns = [
          { label: 'Title', field: 'title', filter: true }, { label: 'Name', field: 'name', filter: true },
          { label: 'Id', field: 'id', filter: true }, { label: 'Type', field: 'type', filter: true }, { label: 'State', field: 'state', filter: true }
        ];
        var html = columnHeaders('results', columns) + '<tbody>';
        var shown = 0;
        var i, item;
        for (i = 0; i < objects.length; i += 1) {
          item = objects[i];
          if (!matchesFilters(item, resultFilters) || !tagVisible(item)) { continue; }
          shown += 1;
          html += '<tr class="dsbom-object' + (selectedObject && objectId(selectedObject) === objectId(item) ? ' ds-selected' : '') + '" data-index="' + i + '"><td>' + escapeHtml(fieldValue(item, 'title')) + '</td><td>' + escapeHtml(fieldValue(item, 'name')) + '</td><td>' + escapeHtml(fieldValue(item, 'id')) + '</td><td>' + escapeHtml(fieldValue(item, 'type')) + '</td><td>' + stateBadge(fieldValue(item, 'state')) + '</td></tr>';
        }
        if (!shown) { html += '<tr><td class="dsbom-empty" colspan="5">Nessun risultato corrisponde ai filtri.</td></tr>'; }
        el('.dsbom-results').innerHTML = html + '</tbody>';
        el('.dsbom-results').querySelectorAll('tr.dsbom-object').forEach(function (row) {
          row.addEventListener('click', function () {
            selectedObject = objects[Number(row.getAttribute('data-index'))];
            loadBom(selectedObject);
          });
        });
        bindColumnFilters();
      }
      function csrf(done, failure) {
        WAFData.authenticatedRequest(serviceUrl + '/resources/v1/application/CSRF', {
          method: 'GET', type: 'json', timeout: 30000, headers: { SecurityContext: securityContext() },
          onComplete: function (response) {
            var token = findNestedValue(response, 'value') || findNestedValue(response, 'Value') || findNestedValue(response, 'csrfToken');
            if (token) { done(token); } else { failure('Token CSRF non restituito.'); }
          },
          onFailure: function (error, response) { failure(errorMessage(error, response)); }
        });
      }
      function createBomTree(response, root) {
        var entries = members(response);
        var paths = {};
        var i, item, id, node, parentId;
        bomRoot = root;
        bomNodes = {};
        expandedNodes = {};
        bomNodes[objectId(root)] = { item: root, id: objectId(root), children: [] };
        for (i = 0; i < entries.length; i += 1) {
          if (Array.isArray(entries[i].Path) && entries[i].Path.length) { paths[entries[i].Path[entries[i].Path.length - 1]] = entries[i].Path; }
        }
        for (i = 0; i < entries.length; i += 1) {
          item = entries[i];
          if (item.Path) { continue; }
          id = objectId(item);
          if (id && !bomNodes[id]) { bomNodes[id] = { item: item, id: id, children: [] }; }
        }
        Object.keys(bomNodes).forEach(function (childId) {
          if (childId === objectId(root)) { return; }
          node = bomNodes[childId];
          parentId = paths[childId] && paths[childId].length > 1 ? paths[childId][paths[childId].length - 2] : objectId(root);
          if (!bomNodes[parentId] || parentId === childId) { parentId = objectId(root); }
          bomNodes[parentId].children.push(node);
          expandedNodes[childId] = true;
        });
        expandedNodes[objectId(root)] = true;
      }
      function loadBom(item) {
        var id = objectId(item);
        if (!id) { setStatus('L\'oggetto selezionato non contiene un ID.', true); return; }
        setStatus('Caricamento distinta...', false);
        csrf(function (token) {
          var body = {
            expandDepth: Number(el('.dsbom-depth').value),
            withPath: true,
            type_filter_bo: ['VPMReference', 'VPMRepReference'],
            type_filter_rel: ['VPMInstance', 'VPMRepInstance']
          };
          WAFData.authenticatedRequest(serviceUrl + '/resources/v1/modeler/dseng/dseng:EngItem/' + encodeURIComponent(id) + '/expand', {
            method: 'POST', type: 'json', timeout: 120000, data: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json;charset=UTF-8', SecurityContext: securityContext(), ENO_CSRF_TOKEN: token },
            onComplete: function (response) {
              createBomTree(response, item);
              renderResults();
              renderBom();
              sync6WTags();
              setStatus('Distinta caricata.', false);
            },
            onFailure: function (error, response) { setStatus('Impossibile caricare la distinta: ' + errorMessage(error, response), true); }
          });
        }, function (message) { setStatus('Impossibile caricare la distinta: ' + message, true); });
      }
      function nodeMatchesOrHasMatchingChild(node) {
        var i;
        if (matchesFilters(node.item, bomFilters) && tagVisible(node.item)) { return true; }
        for (i = 0; i < node.children.length; i += 1) { if (nodeMatchesOrHasMatchingChild(node.children[i])) { return true; } }
        return false;
      }
      function appendBomNode(node, depth, rows) {
        var children = node.children;
        var hasChildren = children.length > 0;
        var expanded = expandedNodes[node.id] !== false;
        var i;
        if (!nodeMatchesOrHasMatchingChild(node)) { return; }
        rows.push('<tr class="dsbom-tree-row" data-node-id="' + escapeHtml(node.id) + '"><td class="dsbom-tree-title" style="padding-left:' + (8 + depth * 18) + 'px">' + (hasChildren ? '<button class="dsbom-toggle" type="button" data-node-id="' + escapeHtml(node.id) + '" aria-label="Espandi o comprimi">' + (expanded ? '-' : '+') + '</button>' : '<span class="dsbom-leaf"></span>') + escapeHtml(fieldValue(node.item, 'title') || fieldValue(node.item, 'name')) + '</td><td>' + escapeHtml(fieldValue(node.item, 'name')) + '</td><td>' + escapeHtml(fieldValue(node.item, 'id')) + '</td><td>' + escapeHtml(fieldValue(node.item, 'type')) + '</td><td>' + stateBadge(fieldValue(node.item, 'state')) + '</td></tr>');
        if (hasChildren && expanded) {
          for (i = 0; i < children.length; i += 1) { appendBomNode(children[i], depth + 1, rows); }
        }
      }
      function renderBom() {
        var columns = [
          { label: 'Title', field: 'title', filter: true }, { label: 'Name', field: 'name', filter: true },
          { label: 'Id', field: 'id', filter: true }, { label: 'Type', field: 'type', filter: true }, { label: 'State', field: 'state', filter: true }
        ];
        var html = columnHeaders('bom', columns) + '<tbody>';
        var rows = [];
        if (!bomRoot || !bomNodes[objectId(bomRoot)]) {
          el('.dsbom-bom').innerHTML = html + '<tr><td class="dsbom-empty" colspan="5">Seleziona un risultato per caricare la distinta.</td></tr></tbody>';
          bindColumnFilters();
          return;
        }
        appendBomNode(bomNodes[objectId(bomRoot)], 0, rows);
        if (!rows.length) { rows.push('<tr><td class="dsbom-empty" colspan="5">Nessun nodo corrisponde ai filtri.</td></tr>'); }
        el('.dsbom-bom').innerHTML = html + rows.join('') + '</tbody>';
        el('.dsbom-bom').querySelectorAll('.dsbom-toggle').forEach(function (button) {
          button.addEventListener('click', function (event) {
            event.stopPropagation();
            var id = button.getAttribute('data-node-id');
            expandedNodes[id] = !expandedNodes[id];
            renderBom();
          });
        });
        bindColumnFilters();
      }
      function setup() {
        widget.body.innerHTML = '<main class="dsbom-root"><div class="dsbom-toolbar"><div class="dsbom-field"><label>Modeler</label><input class="dsbom-modeler" value="dseng" /></div><div class="dsbom-field"><label>Tipo tecnico</label><input class="dsbom-type" value="dseng:EngItem" /></div><div class="dsbom-field"><label>Mask (opzionale)</label><input class="dsbom-mask" value="dsmveng:EngItemMask.Common" /></div><div class="dsbom-field"><label>Prefisso / ricerca</label><input class="dsbom-search" placeholder="es. DO- o SP-" /></div><button class="dsbom-button dsbom-search-button" type="button">Cerca</button></div><div class="dsbom-status">Pronto.</div><section class="dsbom-section"><h2 class="dsbom-section-title">Risultati</h2><div class="dsbom-table-wrap"><table class="dsbom-table dsbom-results"><tbody><tr><td class="dsbom-empty" colspan="5">Esegui una ricerca.</td></tr></tbody></table></div></section><section class="dsbom-section"><h2 class="dsbom-section-title">Distinta <select class="dsbom-depth" title="Profondita della distinta"><option value="1">Livello 1</option><option value="2">Livello 2</option><option value="-1">Tutti i livelli</option></select></h2><div class="dsbom-table-wrap dsbom-tree-wrap"><table class="dsbom-table dsbom-bom-table dsbom-bom"><tbody><tr><td class="dsbom-empty" colspan="5">Seleziona un risultato per caricare la distinta.</td></tr></tbody></table></div></section></main>';
        el('.dsbom-search-button').addEventListener('click', search);
        el('.dsbom-search').addEventListener('keydown', function (event) { if (event.key === 'Enter') { search(); } });
        el('.dsbom-depth').addEventListener('change', function () { if (selectedObject) { loadBom(selectedObject); } });
        initialize6WTagger();
        loadContexts();
      }
      widget.addEvent('onLoad', setup);
    });
  }
  start();
}());
