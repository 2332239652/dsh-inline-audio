/* global window, document, Node, MutationObserver, HTMLImageElement */
// dsh-inline-audio browser half — hand-written CJS factory bundle for the
// dsh web ModuleLoader (protocol aligned with dsh-chat-import / dsh-genui):
//   window.__ModuleLoader__.load({ id: "dsh-inline-audio", factory: (require) => {...} })
// The factory returns { name, inject, apply }.
// Function: watch the DOM and swap the host-side <img src="/plugins/
// dsh-inline-audio/audio?..."> placeholder for a real <audio controls> player.
(function () {
  'use strict';

  var ROUTE_MARK = '/plugins/dsh-inline-audio/audio';
  var REPLACED_ATTR = 'data-dsh-inline-audio-replaced';

  function audioFor(img) {
    var audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = img.src;
    audio.style.maxWidth = '100%';
    audio.style.width = '100%';
    var alt = img.getAttribute('alt') || '';
    if (alt && alt !== 'audio') audio.title = alt;
    return audio;
  }

  function tryReplace(img) {
    try {
      if (img.hasAttribute(REPLACED_ATTR)) return true;
      var src = img.getAttribute('src') || '';
      if (src.indexOf(ROUTE_MARK) === -1) return false;
      var audio = audioFor(img);
      img.setAttribute(REPLACED_ATTR, '1');
      img.replaceWith(audio);
      return true;
    } catch (e) {
      return false;
    }
  }

  function scan(root) {
    if (root && typeof root.querySelectorAll === 'function') {
      var imgs = Array.prototype.slice.call(root.querySelectorAll('img'));
      for (var i = 0; i < imgs.length; i++) {
        if (imgs[i] instanceof HTMLImageElement) tryReplace(imgs[i]);
      }
    }
    if (root instanceof HTMLImageElement) tryReplace(root);
  }

  function apply() {
    if (typeof document === 'undefined') return undefined;
    var styleTag = document.createElement('style');
    styleTag.textContent = [
      'img[src*="' + ROUTE_MARK + '"]{border:1px dashed rgba(128,128,128,.45);border-radius:6px;padding:8px;}',
      'audio{max-width:100%;}'
    ].join('\n');
    document.head.appendChild(styleTag);

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var node = m.addedNodes[j];
            if (node instanceof HTMLImageElement) {
              tryReplace(node);
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              scan(node);
            }
          }
        } else if (m.type === 'attributes' && m.target instanceof HTMLImageElement) {
          tryReplace(m.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });

    scan(document.body);

    return function () {
      try { observer.disconnect(); } catch (e) { /* ignore */ }
      if (styleTag.parentNode) styleTag.parentNode.removeChild(styleTag);
    };
  }

  window.__ModuleLoader__.load({
    id: 'dsh-inline-audio',
    factory: function (require) {
      return { name: 'dsh-inline-audio', inject: [], apply: apply };
    }
  });
})();