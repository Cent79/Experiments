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
      var availableContexts = [];
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
      function set6WStatus(message, error) {
        var node = el('.dsbom-6w-status');
        if (!node) { return; }
        node.className = error ? 'dsbom-6w-status error' : 'dsbom-6w-status';
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
      // Client-side 6W subjects: stable within the widget and independent from a DS internal URI format.
      function subjectOf(item) { return 'dsbom://' + widget.id + '/' + objectId(item); }
      function fieldValue(item, field) {
        if (field === 'title') { return valueOf(item, ['title', 'Title']); }
        if (field === 'name') { return valueOf(item, ['name', 'Name']); }
        if (field === 'id') { return objectId(item); }
        if (field === 'type') { return valueOf(item, ['type', 'Type']); }
        if (field === 'state') { return valueOf(item, ['state', 'State']); }
        return '';
      }
      function iconUrl(item) {
        var names = ['iconUrl', 'iconURL', 'thumbnailUrl', 'thumbnailURL', 'imageUrl', 'imageURL', 'smallIcon', 'icon', 'thumbnail', 'image'];
        var value = valueOf(item, names) || valueOf(item && item.attributes, names);
        // Use only explicit safe image resources returned by the platform.
        return /^(https:\/\/|data:image\/)/i.test(value) ? value : '';
      }
      function fallbackTypeIcon(type) {
        var text = String(type || '').toLowerCase();
        if (text.indexOf('drawing') >= 0 || text.indexOf('dsdrw') >= 0) {
          return '<svg class="dsbom-type-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.5h8l3 3v10H2zM10 1.5v3h3M4 7h7M4 9.5h7M4 12h5" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }
        if (text.indexOf('document') >= 0 || text.indexOf('dscdoc') >= 0 || text.indexOf('file') >= 0) {
          return '<svg class="dsbom-type-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h6.5L13 5v9.5H3zM9.5 1.5V5H13M5 8h6M5 10.5h6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }
        if (text.indexOf('folder') >= 0 || text.indexOf('bookmark') >= 0) {
          return '<svg class="dsbom-type-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4h5l1.4 1.7h6.6v7.8H1.5z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/></svg>';
        }
        return '<svg class="dsbom-type-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l5 2.8v5.4L8 12.5 3 9.7V4.3zM3 4.3l5 2.8 5-2.8M8 7.1v5.4" fill="#c5dde7" stroke="currentColor" stroke-width="1.05" stroke-linejoin="round"/></svg>';
      }
      function typeIcon(item) {
        var url = iconUrl(item);
        var type = fieldValue(item, 'type') || 'Oggetto 3DEXPERIENCE';
        if (url) {
          return '<img class="dsbom-type-icon dsbom-api-type-icon" src="' + escapeHtml(url) + '" alt="" title="' + escapeHtml(type) + '">';
        }
        return '<span class="dsbom-fallback-type-icon" title="' + escapeHtml(type) + '">' + fallbackTypeIcon(type) + '</span>';
      }
      function itemIdentity(item, title) {
        return '<span class="dsbom-item-identity">' + typeIcon(item) + '<span class="dsbom-item-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</span></span>';
      }
      function stateClass(state) { return String(state || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
      function stateBadge(state) {
        var text = String(state || 'N/A');
        var labels = { IN_WORK: 'In corso', FROZEN: 'Congelato', RELEASED: 'Rilasciato', OBSOLETE: 'Obsoleto', PRIVATE: 'Privato' };
        return '<span class="dsbom-state dsbom-state-' + escapeHtml(stateClass(text)) + '">' + escapeHtml(labels[text] || text.replace(/_/g, ' ')) + '</span>';
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
          if (input.getAttribute('data-filter-bound') === 'true') { return; }
          input.setAttribute('data-filter-bound', 'true');
          input.addEventListener('input', function () {
            var target = input.getAttribute('data-kind') === 'results' ? resultFilters : bomFilters;
            target[input.getAttribute('data-field')] = input.value;
            if (input.getAttribute('data-kind') === 'results') { applyResultFilters(); } else { applyBomFilters(); }
          });
        });
      }

      function configureContexts(contexts) {
        var current = securityContext();
        var options = [];
        var i;
        availableContexts = contexts.filter(function (context, index, list) { return context && list.indexOf(context) === index; });
        if (availableContexts.indexOf(current) < 0) { availableContexts.unshift(current); }
        availableContexts.sort(function (a, b) { return a.localeCompare(b); });
        for (i = 0; i < availableContexts.length; i += 1) { options.push({ label: availableContexts[i], value: availableContexts[i] }); }
        widget.addPreference({ name: 'SecurityContext', type: 'list', label: 'Security context', defaultValue: current, options: options });
        widget.setValue('SecurityContext', current);
        updateContextSelector();
      }
      function namedValue(value) {
        if (typeof value === 'string') { return value; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { return ''; }
        return valueOf(value, ['name', 'title', 'label', 'value', 'id']);
      }
      function collectContexts(object, result) {
        var i, key, lower, role, organization, space, text;
        if (typeof object === 'string') {
          text = object.replace(/^ctx::/i, '').trim();
          if (!/[:/@]/.test(text) && text.split('.').length >= 3) { result.push(text); }
          return;
        }
        if (Array.isArray(object)) {
          for (i = 0; i < object.length; i += 1) { collectContexts(object[i], result); }
          return;
        }
        if (!object || typeof object !== 'object') { return; }
        ['securityContext', 'securitycontext', 'context', 'credential'].forEach(function (name) { if (object[name]) { collectContexts(object[name], result); } });
        role = namedValue(object.role || object.responsibility || object.securityRole);
        organization = namedValue(object.organization || object.company || object.enterprise);
        space = namedValue(object.collabspace || object.collabSpace || object.collaborativeSpace || object.space);
        if (role && organization && space) { result.push(role + '.' + organization + '.' + space); }
        Object.keys(object).forEach(function (name) {
          lower = name.toLowerCase();
          if (lower !== 'securitycontext' && lower !== 'context' && lower !== 'credential') { collectContexts(object[name], result); }
        });
      }
      function updateContextSelector() {
        var selector = el('.dsbom-context');
        var html = [];
        var current = securityContext();
        var i;
        if (!selector) { return; }
        for (i = 0; i < availableContexts.length; i += 1) {
          html.push('<option value="' + escapeHtml(availableContexts[i]) + '"' + (availableContexts[i] === current ? ' selected="selected"' : '') + '>' + escapeHtml(availableContexts[i]) + '</option>');
        }
        selector.innerHTML = html.join('');
        selector.disabled = !availableContexts.length;
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
          WAFData.authenticatedRequest(serviceUrl + '/resources/modeler/pno/person?current=true&select=collabspaces&select=credentials&select=roles&select=organizations&select=securitycontexts', {
            method: 'GET', type: 'json', timeout: 30000,
            onComplete: function (response) {
              var result = [];
              collectContexts(response, result);
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
        try {
          tagProxy.setSubjectsTags(subjectTags);
          tagProxy.activate();
          set6WStatus('6WTag attivo: ' + Object.keys(subjectTags).length + ' oggetti indicizzati.', false);
        } catch (error) {
          set6WStatus('6WTag non disponibile: ' + (error.message || String(error)), true);
        }
      }
      function initialize6WTagger() {
        try {
          tagProxy = TagNavigatorProxy.createProxy({
            widgetId: widget.id,
            filteringMode: TagNavigatorProxy.filteringMode && TagNavigatorProxy.filteringMode.WithFilteringServices ? TagNavigatorProxy.filteringMode.WithFilteringServices : 'WithFilteringServices'
          });
          tagProxy.addEvent('onFilterSubjectsChange', function (filter) {
            var subjects = Array.isArray(filter) ? filter : filter && filter.filteredSubjectList;
            var i;
            visibleTagSubjects = {};
            tagFilterActive = Array.isArray(subjects) && subjects.length > 0;
            if (tagFilterActive) {
              for (i = 0; i < subjects.length; i += 1) { visibleTagSubjects[subjects[i]] = true; }
            }
            renderResults();
            renderBom();
          });
          set6WStatus('6WTag pronto: esegui una ricerca per pubblicare i tag.', false);
        } catch (error) {
          tagProxy = null;
          set6WStatus('6WTag non inizializzato: ' + (error.message || String(error)), true);
        }
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
        var i, item;
        for (i = 0; i < objects.length; i += 1) {
          item = objects[i];
          html += '<tr class="dsbom-object' + (selectedObject && objectId(selectedObject) === objectId(item) ? ' ds-selected' : '') + '" data-index="' + i + '"><td>' + itemIdentity(item, fieldValue(item, 'title')) + '</td><td>' + escapeHtml(fieldValue(item, 'name')) + '</td><td>' + escapeHtml(fieldValue(item, 'id')) + '</td><td>' + escapeHtml(fieldValue(item, 'type')) + '</td><td>' + stateBadge(fieldValue(item, 'state')) + '</td></tr>';
        }
        html += '<tr class="dsbom-empty dsbom-empty-results" hidden="hidden"><td colspan="5">Nessun risultato corrisponde ai filtri.</td></tr>';
        el('.dsbom-results').innerHTML = html + '</tbody>';
        el('.dsbom-results').querySelectorAll('tr.dsbom-object').forEach(function (row) {
          row.addEventListener('click', function () {
            selectedObject = objects[Number(row.getAttribute('data-index'))];
            loadBom(selectedObject);
          });
        });
        bindColumnFilters();
        applyResultFilters();
      }
      function applyResultFilters() {
        var table = el('.dsbom-results');
        var rows, empty, shown = 0;
        if (!table) { return; }
        rows = table.querySelectorAll('tr.dsbom-object');
        rows.forEach(function (row) {
          var item = objects[Number(row.getAttribute('data-index'))];
          var visible = matchesFilters(item, resultFilters) && tagVisible(item);
          row.hidden = !visible;
          if (visible) { shown += 1; }
        });
        empty = table.querySelector('.dsbom-empty-results');
        if (empty) { empty.hidden = shown > 0; }
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
      function pathOf(entry) {
        var path = entry && (entry.Path || entry.path || entry.objectPath);
        if (!Array.isArray(path)) { return []; }
        return path.map(function (part) { return typeof part === 'object' ? objectId(part) : String(part); }).filter(Boolean);
      }
      function createBomTree(response, root) {
        var entries = members(response);
        var paths = [];
        var linked = {};
        var i, item, id, path, j;
        function ensureNode(nodeId, nodeItem) {
          if (!nodeId) { return null; }
          if (!bomNodes[nodeId]) { bomNodes[nodeId] = { item: nodeItem || { id: nodeId, title: nodeId, type: 'Object' }, id: nodeId, children: [] }; }
          if (nodeItem) { bomNodes[nodeId].item = nodeItem; }
          return bomNodes[nodeId];
        }
        function link(parentId, childId) {
          var key;
          if (!parentId || !childId || parentId === childId) { return; }
          key = parentId + '>' + childId;
          if (linked[key]) { return; }
          linked[key] = true;
          ensureNode(parentId).children.push(ensureNode(childId));
        }
        bomRoot = root;
        bomNodes = {};
        expandedNodes = {};
        ensureNode(objectId(root), root);
        for (i = 0; i < entries.length; i += 1) {
          path = pathOf(entries[i]);
          if (path.length) { paths.push(path); }
          item = entries[i];
          id = objectId(item);
          if (id) { ensureNode(id, item); }
        }
        for (i = 0; i < paths.length; i += 1) {
          path = paths[i];
          for (j = 0; j < path.length; j += 1) { ensureNode(path[j]); }
          for (j = 1; j < path.length; j += 1) { link(path[j - 1], path[j]); }
          if (path[0] !== objectId(root)) { link(objectId(root), path[0]); }
        }
        Object.keys(bomNodes).forEach(function (nodeId) {
          var hasParent = Object.keys(linked).some(function (key) { return key.slice(key.indexOf('>') + 1) === nodeId; });
          if (nodeId !== objectId(root) && !hasParent) { link(objectId(root), nodeId); }
          expandedNodes[nodeId] = true;
        });
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
        rows.push('<tr class="dsbom-tree-row" data-node-id="' + escapeHtml(node.id) + '"><td class="dsbom-tree-title" style="padding-left:' + (8 + depth * 18) + 'px">' + (hasChildren ? '<button class="dsbom-toggle" type="button" data-node-id="' + escapeHtml(node.id) + '" aria-label="Espandi o comprimi">' + (expanded ? '-' : '+') + '</button>' : '<span class="dsbom-leaf"></span>') + itemIdentity(node.item, fieldValue(node.item, 'title') || fieldValue(node.item, 'name')) + '</td><td>' + escapeHtml(fieldValue(node.item, 'name')) + '</td><td>' + escapeHtml(fieldValue(node.item, 'id')) + '</td><td>' + escapeHtml(fieldValue(node.item, 'type')) + '</td><td>' + stateBadge(fieldValue(node.item, 'state')) + '</td></tr>');
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
        rows.push('<tr class="dsbom-empty dsbom-empty-bom" hidden="hidden"><td colspan="5">Nessun nodo corrisponde ai filtri.</td></tr>');
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
        applyBomFilters();
      }
      function applyBomFilters() {
        var table = el('.dsbom-bom');
        var visibility = {};
        var shown = 0;
        function resolve(node, parentVisible) {
          var own = matchesFilters(node.item, bomFilters) && tagVisible(node.item);
          var childMatches = false;
          var expanded = expandedNodes[node.id] !== false;
          var i;
          for (i = 0; i < node.children.length; i += 1) { if (resolve(node.children[i], parentVisible && expanded)) { childMatches = true; } }
          visibility[node.id] = { matches: own || childMatches, visible: parentVisible && (own || childMatches) };
          return own || childMatches;
        }
        if (!table || !bomRoot || !bomNodes[objectId(bomRoot)]) { return; }
        resolve(bomNodes[objectId(bomRoot)], true);
        table.querySelectorAll('tr.dsbom-tree-row').forEach(function (row) {
          var state = visibility[row.getAttribute('data-node-id')];
          row.hidden = !state || !state.visible;
          if (state && state.visible) { shown += 1; }
        });
        table.querySelector('.dsbom-empty-bom').hidden = shown > 0;
      }
      function setup() {
        widget.body.innerHTML = '<main class="dsbom-root"><div class="dsbom-toolbar"><div class="dsbom-field"><label>Modeler</label><input class="dsbom-modeler" value="dseng" /></div><div class="dsbom-field"><label>Tipo tecnico</label><input class="dsbom-type" value="dseng:EngItem" /></div><div class="dsbom-field"><label>Mask (opzionale)</label><input class="dsbom-mask" value="dsmveng:EngItemMask.Common" /></div><div class="dsbom-field dsbom-context-field"><label>Security context</label><select class="dsbom-context" disabled="disabled"><option>Caricamento...</option></select></div><div class="dsbom-field"><label>Prefisso / ricerca</label><input class="dsbom-search" placeholder="es. DO- o SP-" /></div><button class="dsbom-button dsbom-search-button" type="button">Cerca</button></div><div class="dsbom-status">Pronto.</div><div class="dsbom-6w-status">6WTag in inizializzazione...</div><section class="dsbom-section"><h2 class="dsbom-section-title">Risultati</h2><div class="dsbom-table-wrap"><table class="dsbom-table dsbom-results"><tbody><tr><td class="dsbom-empty" colspan="5">Esegui una ricerca.</td></tr></tbody></table></div></section><section class="dsbom-section"><h2 class="dsbom-section-title">Distinta <select class="dsbom-depth" title="Profondita della distinta"><option value="1">Livello 1</option><option value="2">Livello 2</option><option value="-1">Tutti i livelli</option></select></h2><div class="dsbom-table-wrap dsbom-tree-wrap"><table class="dsbom-table dsbom-bom-table dsbom-bom"><tbody><tr><td class="dsbom-empty" colspan="5">Seleziona un risultato per caricare la distinta.</td></tr></tbody></table></div></section></main>';
        el('.dsbom-search-button').addEventListener('click', search);
        el('.dsbom-search').addEventListener('keydown', function (event) { if (event.key === 'Enter') { search(); } });
        el('.dsbom-depth').addEventListener('change', function () { if (selectedObject) { loadBom(selectedObject); } });
        el('.dsbom-context').addEventListener('change', function () {
          widget.setValue('SecurityContext', this.value);
          setStatus('Security context impostato: ' + this.value + '.', false);
        });
        initialize6WTagger();
        loadContexts();
      }
      widget.addEvent('onLoad', setup);
    });
  }
  start();
}());
