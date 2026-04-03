(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────
  const DICT_URLS = {
    de: {
      aff: 'https://cdn.jsdelivr.net/npm/dictionary-de@3.0.0/index.aff',
      dic: 'https://cdn.jsdelivr.net/npm/dictionary-de@3.0.0/index.dic',
    },
    en: {
      aff: 'https://cdn.jsdelivr.net/npm/dictionary-en@4.0.0/index.aff',
      dic: 'https://cdn.jsdelivr.net/npm/dictionary-en@4.0.0/index.dic',
    },
  };

  const ONLINE_LOOKUP = {
    de: (word) =>
      `https://de.wiktionary.org/w/api.php?action=query&titles=${encodeURIComponent(word)}&format=json&origin=*`,
    en: (word) =>
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
  };

  const STORAGE_KEY = 'spellcheck_custom_dict';

  // Professional dictionaries to load at startup
  const PROFESSIONAL_DICTS = [
    'data/kfo-fachbegriffe.json',
  ];

  // ── State ──────────────────────────────────────────────────────────
  let currentLang = 'de';
  let typoInstance = null;
  let dictReady = false;
  let customDict = loadCustomDict();
  let professionalDict = {}; // { lang: Set of words }
  let activeTextarea = null;
  let debounceTimer = null;
  let currentMisspelledSpan = null;

  // ── DOM refs ───────────────────────────────────────────────────────
  const overlay = document.getElementById('overlay');
  const editor = document.getElementById('editor');
  const suggestions = document.getElementById('suggestions');
  const btnApply = document.getElementById('btn-apply');
  const btnCancel = document.getElementById('btn-cancel');
  const langSelect = document.getElementById('lang-select');
  const dictStatus = document.getElementById('dict-status');
  const dictCount = document.getElementById('dict-count');
  const overlayInfo = document.getElementById('overlay-info');
  const btnExport = document.getElementById('btn-export-dict');
  const btnClear = document.getElementById('btn-clear-dict');

  // ── Custom Dictionary (localStorage) ───────────────────────────────
  function loadCustomDict() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return typeof data === 'object' && data !== null ? data : {};
    } catch {
      return {};
    }
  }

  function saveCustomDict() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customDict));
    updateDictCount();
  }

  function addToCustomDict(word, lang) {
    if (!customDict[lang]) customDict[lang] = [];
    const lower = word.toLowerCase();
    if (!customDict[lang].includes(lower)) {
      customDict[lang].push(lower);
      saveCustomDict();
    }
  }

  function isInCustomDict(word, lang) {
    if (!customDict[lang]) return false;
    return customDict[lang].includes(word.toLowerCase());
  }

  function isInProfessionalDict(word, lang) {
    if (!professionalDict[lang]) return false;
    return professionalDict[lang].has(word) || professionalDict[lang].has(word.toLowerCase());
  }

  function updateDictCount() {
    const customCount = Object.values(customDict).reduce(
      (sum, arr) => sum + arr.length,
      0
    );
    const proCount = Object.values(professionalDict).reduce(
      (sum, set) => sum + set.size,
      0
    );
    dictCount.textContent = customCount;
    // Update professional dict info if element exists
    const proEl = document.getElementById('pro-dict-count');
    if (proEl) proEl.textContent = proCount;
  }

  // ── Professional Dictionaries ──────────────────────────────────────
  async function loadProfessionalDicts() {
    for (const url of PROFESSIONAL_DICTS) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        const lang = data.lang || 'de';
        if (!professionalDict[lang]) professionalDict[lang] = new Set();

        if (data.terms) {
          data.terms.forEach((t) => professionalDict[lang].add(t));
        }
        if (data.abbreviations) {
          data.abbreviations.forEach((a) => professionalDict[lang].add(a));
        }

        console.log(`Loaded professional dict "${data.name}": ${(data.terms?.length || 0) + (data.abbreviations?.length || 0)} terms`);
      } catch (err) {
        console.warn('Failed to load professional dict:', url, err);
      }
    }
    updateDictCount();
  }

  // ── Dictionary Loading ─────────────────────────────────────────────
  async function loadDictionary(lang) {
    dictReady = false;
    typoInstance = null;
    dictStatus.className = 'dict-status';
    dictStatus.textContent =
      lang === 'de'
        ? 'Wörterbuch wird geladen…'
        : 'Loading dictionary…';

    try {
      const urls = DICT_URLS[lang];
      const [affResp, dicResp] = await Promise.all([
        fetch(urls.aff),
        fetch(urls.dic),
      ]);

      if (!affResp.ok || !dicResp.ok) throw new Error('Download failed');

      const [affData, dicData] = await Promise.all([
        affResp.text(),
        dicResp.text(),
      ]);

      typoInstance = new Typo(lang, affData, dicData, { platform: 'any' });
      dictReady = true;
      dictStatus.className = 'dict-status ready';
      dictStatus.textContent =
        lang === 'de' ? 'Wörterbuch bereit' : 'Dictionary ready';
    } catch (err) {
      console.error('Dict load error:', err);
      dictStatus.className = 'dict-status error';
      dictStatus.textContent =
        lang === 'de'
          ? 'Fehler beim Laden'
          : 'Failed to load dictionary';
    }
  }

  // ── Spell Checking ─────────────────────────────────────────────────
  function checkWord(word) {
    if (!dictReady || !typoInstance) return true;
    const clean = word.replace(/[.,;:!?"""''()[\]{}<>…–—\-/\\]/g, '');
    if (!clean || clean.length < 2) return true;
    if (/^\d+$/.test(clean)) return true;
    if (isInCustomDict(clean, currentLang)) return true;
    if (isInProfessionalDict(clean, currentLang)) return true;
    return typoInstance.check(clean);
  }

  function getSuggestions(word) {
    if (!typoInstance) return [];
    const clean = word.replace(/[.,;:!?"""''()[\]{}<>…–—\-/\\]/g, '');
    return typoInstance.suggest(clean, 8);
  }

  // ── Editor Highlighting ────────────────────────────────────────────
  function highlightEditor() {
    if (!dictReady) return;

    const sel = window.getSelection();
    let caretOffset = getCaretOffset(editor);

    const text = editor.innerText || '';
    // Split into segments: words and non-words
    const segments = text.split(/(\s+)/);
    let html = '';

    for (const segment of segments) {
      if (/^\s+$/.test(segment)) {
        // Preserve whitespace (convert newlines to <br>)
        html += segment.replace(/\n/g, '<br>');
      } else if (segment.length > 0) {
        // It's a word (possibly with punctuation)
        const wordCore = segment.replace(
          /[.,;:!?"""''()[\]{}<>…–—\-/\\]/g,
          ''
        );
        if (wordCore.length >= 2 && !checkWord(segment)) {
          html += `<span class="misspelled" data-word="${escapeAttr(wordCore)}">${escapeHtml(segment)}</span>`;
        } else {
          html += escapeHtml(segment);
        }
      }
    }

    editor.innerHTML = html || '';
    setCaretOffset(editor, caretOffset);
    updateOverlayInfo();
  }

  function updateOverlayInfo() {
    const misspelled = editor.querySelectorAll('.misspelled');
    if (misspelled.length === 0) {
      overlayInfo.textContent =
        currentLang === 'de' ? 'Keine Fehler' : 'No errors';
    } else {
      overlayInfo.textContent =
        currentLang === 'de'
          ? `${misspelled.length} unbekannte(s) Wort/Wörter`
          : `${misspelled.length} unknown word(s)`;
    }
  }

  // ── Caret Helpers ──────────────────────────────────────────────────
  function getCaretOffset(element) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return 0;
    const range = sel.getRangeAt(0).cloneRange();
    range.selectNodeContents(element);
    range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
    return range.toString().length;
  }

  function setCaretOffset(element, offset) {
    const range = document.createRange();
    const sel = window.getSelection();
    let current = 0;
    let found = false;

    function walk(node) {
      if (found) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent.length;
        if (current + len >= offset) {
          range.setStart(node, offset - current);
          range.collapse(true);
          found = true;
          return;
        }
        current += len;
      } else {
        for (const child of node.childNodes) {
          walk(child);
          if (found) return;
        }
      }
    }

    walk(element);

    if (!found) {
      range.selectNodeContents(element);
      range.collapse(false);
    }

    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ── HTML Escape ────────────────────────────────────────────────────
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ── Online Lookup ──────────────────────────────────────────────────
  async function lookupOnline(word) {
    const url = ONLINE_LOOKUP[currentLang](word);

    try {
      const resp = await fetch(url);
      if (!resp.ok) return { found: false };

      const data = await resp.json();

      if (currentLang === 'de') {
        // Wiktionary: check if page exists (no "missing" key)
        const pages = data.query?.pages;
        if (!pages) return { found: false };
        const page = Object.values(pages)[0];
        return { found: !page.missing && page.pageid };
      } else {
        // Free Dictionary API returns array on success
        return { found: Array.isArray(data) && data.length > 0 };
      }
    } catch {
      return { found: false, error: true };
    }
  }

  // ── Suggestions Popup ──────────────────────────────────────────────
  function showSuggestions(span) {
    currentMisspelledSpan = span;
    const word = span.dataset.word;
    const rect = span.getBoundingClientRect();

    suggestions.innerHTML = '';
    suggestions.classList.remove('hidden');

    // Position
    suggestions.style.left = `${rect.left}px`;
    suggestions.style.top = `${rect.bottom + 4}px`;

    // Suggestions from typo.js
    const suggs = getSuggestions(word);
    if (suggs.length > 0) {
      suggs.forEach((s) => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.textContent = s;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          replaceMisspelled(span, s);
          hideSuggestions();
        });
        suggestions.appendChild(item);
      });
    } else {
      const none = document.createElement('div');
      none.className = 'suggestion-status';
      none.textContent =
        currentLang === 'de'
          ? 'Keine Vorschläge'
          : 'No suggestions';
      suggestions.appendChild(none);
    }

    // Divider
    const div1 = document.createElement('div');
    div1.className = 'suggestion-divider';
    suggestions.appendChild(div1);

    // Add to dictionary
    const addAction = document.createElement('div');
    addAction.className = 'suggestion-action';
    addAction.innerHTML = `<span class="icon">+</span> ${
      currentLang === 'de'
        ? 'Zum Wörterbuch hinzufügen'
        : 'Add to dictionary'
    }`;
    addAction.addEventListener('mousedown', (e) => {
      e.preventDefault();
      addToCustomDict(word, currentLang);
      hideSuggestions();
      highlightEditor();
    });
    suggestions.appendChild(addAction);

    // Online lookup
    const onlineAction = document.createElement('div');
    onlineAction.className = 'suggestion-action online';
    onlineAction.innerHTML = `<span class="icon">&#x1F50D;</span> ${
      currentLang === 'de'
        ? 'Online nachschlagen'
        : 'Look up online'
    }`;
    onlineAction.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      onlineAction.innerHTML = `<span class="spinner"></span> ${
        currentLang === 'de' ? 'Suche…' : 'Searching…'
      }`;

      const result = await lookupOnline(word);

      if (result.found) {
        addToCustomDict(word, currentLang);
        onlineAction.innerHTML = currentLang === 'de'
          ? '&#10003; Gefunden & hinzugefügt!'
          : '&#10003; Found & added!';
        onlineAction.style.color = '#16a34a';
        setTimeout(() => {
          hideSuggestions();
          highlightEditor();
        }, 800);
      } else if (result.error) {
        onlineAction.innerHTML = currentLang === 'de'
          ? '&#10007; Netzwerkfehler'
          : '&#10007; Network error';
        onlineAction.style.color = '#dc2626';
      } else {
        onlineAction.innerHTML = currentLang === 'de'
          ? '&#10007; Nicht gefunden'
          : '&#10007; Not found';
        onlineAction.style.color = '#dc2626';
      }
    });
    suggestions.appendChild(onlineAction);

    // Keep suggestions in viewport
    requestAnimationFrame(() => {
      const sRect = suggestions.getBoundingClientRect();
      if (sRect.right > window.innerWidth) {
        suggestions.style.left = `${window.innerWidth - sRect.width - 8}px`;
      }
      if (sRect.bottom > window.innerHeight) {
        suggestions.style.top = `${rect.top - sRect.height - 4}px`;
      }
    });
  }

  function hideSuggestions() {
    suggestions.classList.add('hidden');
    suggestions.innerHTML = '';
    currentMisspelledSpan = null;
  }

  function replaceMisspelled(span, replacement) {
    span.replaceWith(document.createTextNode(replacement));
    // Re-run highlighting after replacement
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(highlightEditor, 200);
  }

  // ── Overlay Control ────────────────────────────────────────────────
  function openOverlay(textarea) {
    activeTextarea = textarea;
    overlay.classList.remove('hidden');
    editor.innerHTML = '';
    editor.focus();
    updateOverlayInfo();
  }

  function closeOverlay() {
    overlay.classList.add('hidden');
    hideSuggestions();
    editor.innerHTML = '';
    activeTextarea = null;
  }

  function applyText() {
    if (!activeTextarea) return;
    const newText = editor.innerText || '';
    if (!newText.trim()) {
      closeOverlay();
      return;
    }

    const existing = activeTextarea.value;
    if (existing && !existing.endsWith('\n') && !existing.endsWith(' ')) {
      activeTextarea.value = existing + ' ' + newText;
    } else {
      activeTextarea.value = existing + newText;
    }

    // Trigger input event so any listeners on the textarea are notified
    activeTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    closeOverlay();
  }

  // ── Event Listeners ────────────────────────────────────────────────

  // Open overlay on textarea click
  document.querySelectorAll('.spell-target').forEach((textarea) => {
    textarea.addEventListener('focus', (e) => {
      e.target.blur();
      openOverlay(e.target);
    });
  });

  // Editor input → debounced highlighting
  editor.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(highlightEditor, 400);
  });

  // Click on misspelled word → show suggestions
  editor.addEventListener('click', (e) => {
    const span = e.target.closest('.misspelled');
    if (span) {
      e.stopPropagation();
      showSuggestions(span);
    } else {
      hideSuggestions();
    }
  });

  // Close suggestions on outside click
  document.addEventListener('mousedown', (e) => {
    if (
      !suggestions.contains(e.target) &&
      !e.target.closest('.misspelled')
    ) {
      hideSuggestions();
    }
  });

  // Buttons
  btnApply.addEventListener('click', applyText);
  btnCancel.addEventListener('click', closeOverlay);

  // Keyboard shortcuts in overlay
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!suggestions.classList.contains('hidden')) {
        hideSuggestions();
      } else {
        closeOverlay();
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      applyText();
    }
  });

  // Language switch
  langSelect.addEventListener('change', (e) => {
    currentLang = e.target.value;
    loadDictionary(currentLang);
  });

  // Export custom dictionary
  btnExport.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(customDict, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spellcheck-dictionary.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Clear custom dictionary
  btnClear.addEventListener('click', () => {
    const msg =
      currentLang === 'de'
        ? 'Eigenes Wörterbuch wirklich löschen?'
        : 'Really clear custom dictionary?';
    if (confirm(msg)) {
      customDict = {};
      saveCustomDict();
    }
  });

  // ── Init ───────────────────────────────────────────────────────────
  updateDictCount();
  loadProfessionalDicts().then(() => loadDictionary(currentLang));
})();
