(() => {
  const BRIDGE_PATH = "/__webstrapper/bridge";
  const RECONNECT_MS = 1000;

  const queuedEnvelopes = [];
  const workerSubscribers = new Map();
  const mainMessageHistory = [];
  const CONTEXT_MENU_ROOT_ID = "__codex-webstrap-context-menu-root";
  const CONTEXT_MENU_STYLE_ID = "__codex-webstrap-context-menu-style";
  const MOBILE_STYLE_ID = "__codex-webstrap-mobile-style";
  const buildInfo =
    window.__codexWebstrapBuildInfo && typeof window.__codexWebstrapBuildInfo === "object"
      ? window.__codexWebstrapBuildInfo
      : {};

  let ws = null;
  let connected = false;
  let reconnectTimer = null;
  let activeContextMenu = null;
  let lastContextMenuPoint = {
    x: Math.floor(window.innerWidth / 2),
    y: Math.floor(window.innerHeight / 2)
  };

  function isSentryIpcUrl(input) {
    if (typeof input === "string") {
      return input.startsWith("sentry-ipc://");
    }
    if (input && typeof input.url === "string") {
      return input.url.startsWith("sentry-ipc://");
    }
    return false;
  }

  function resolveUrlString(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input && typeof input.url === "string") {
      return input.url;
    }
    return "";
  }

  function isStatsigRegistryUrl(input) {
    const raw = resolveUrlString(input);
    if (!raw) {
      return false;
    }
    try {
      const parsed = new URL(raw, window.location.href);
      return parsed.hostname === "ab.chatgpt.com" && parsed.pathname.startsWith("/v1/rgstr");
    } catch {
      return false;
    }
  }

  function installBrowserCompatibilityShims() {
    if (typeof window.fetch === "function") {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (isSentryIpcUrl(input)) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (isStatsigRegistryUrl(input)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                has_updates: false,
                feature_gates: {},
                dynamic_configs: {},
                layer_configs: {},
                time: Date.now()
              }),
              {
                status: 200,
                headers: {
                  "content-type": "application/json"
                }
              }
            )
          );
        }
        return originalFetch(input, init);
      };
    }

    if (typeof navigator.sendBeacon === "function") {
      const originalSendBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => {
        if (typeof url === "string" && url.startsWith("sentry-ipc://")) {
          return true;
        }
        if (isStatsigRegistryUrl(url)) {
          return true;
        }
        return originalSendBeacon(url, data);
      };
    }

    const fallbackCopyText = (text) => {
      if (typeof document === "undefined" || !document.body) {
        return false;
      }
      const value = typeof text === "string" ? text : String(text ?? "");
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);

      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      textarea.remove();
      return copied;
    };

    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === "function") {
      const originalWriteText = clipboard.writeText.bind(clipboard);
      try {
        clipboard.writeText = async (text) => {
          try {
            return await originalWriteText(text);
          } catch (error) {
            if (fallbackCopyText(text)) {
              return;
            }
            throw error;
          }
        };
      } catch {
        // Ignore immutable clipboard implementations.
      }
    }

    if (clipboard && typeof clipboard.write === "function") {
      const originalWrite = clipboard.write.bind(clipboard);
      try {
        clipboard.write = async (items) => {
          try {
            return await originalWrite(items);
          } catch (error) {
            try {
              const firstItem = Array.isArray(items) ? items[0] : null;
              if (!firstItem || typeof firstItem.getType !== "function") {
                throw error;
              }
              const blob = await firstItem.getType("text/plain");
              const text = await blob.text();
              if (fallbackCopyText(text)) {
                return;
              }
            } catch {
              // Fall through to throw the original clipboard error.
            }
            throw error;
          }
        };
      } catch {
        // Ignore immutable clipboard implementations.
      }
    }

    if (typeof console.error === "function") {
      const originalConsoleError = console.error.bind(console);
      console.error = (...args) => {
        const text = args
          .map((arg) => {
            if (typeof arg === "string") {
              return arg;
            }
            if (arg && typeof arg.message === "string") {
              return arg.message;
            }
            return "";
          })
          .join(" ");

        if (text.includes("Sentry SDK failed to establish connection with the Electron main process")) {
          return;
        }
        if (text.includes("sentry-ipc://")) {
          return;
        }
        if (text.includes("ab.chatgpt.com/v1/rgstr")) {
          return;
        }
        if (text.includes("`DialogContent` requires a `DialogTitle`")) {
          return;
        }
        originalConsoleError(...args);
      };
    }

    if (typeof console.warn === "function") {
      const originalConsoleWarn = console.warn.bind(console);
      console.warn = (...args) => {
        const text = args
          .map((arg) => {
            if (typeof arg === "string") {
              return arg;
            }
            if (arg && typeof arg.message === "string") {
              return arg.message;
            }
            return "";
          })
          .join(" ");

        if (text.includes("Missing `Description` or `aria-describedby={undefined}` for {DialogContent}")) {
          return;
        }
        originalConsoleWarn(...args);
      };
    }
  }

  function rememberContextMenuPosition(event) {
    if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return;
    }
    lastContextMenuPoint = {
      x: event.clientX,
      y: event.clientY
    };
  }

  function ensureContextMenuStyles() {
    if (document.getElementById(CONTEXT_MENU_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = CONTEXT_MENU_STYLE_ID;
    style.textContent = `
      #${CONTEXT_MENU_ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-menu {
        position: fixed;
        min-width: 220px;
        max-width: 320px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 12px;
        background: rgba(26, 27, 31, 0.97);
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        color: #f4f4f5;
        font-size: 14px;
        line-height: 1.35;
        backdrop-filter: blur(16px);
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-item {
        position: relative;
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-item-btn {
        width: 100%;
        appearance: none;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        padding: 9px 10px;
        text-align: left;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        cursor: pointer;
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-item-btn:hover {
        background: rgba(255, 255, 255, 0.1);
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-item-btn:disabled {
        opacity: 0.45;
        cursor: default;
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-separator {
        height: 1px;
        margin: 5px 2px;
        background: rgba(255, 255, 255, 0.14);
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-item--submenu > .cw-menu {
        display: none;
        position: absolute;
        top: -6px;
        left: calc(100% + 4px);
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-item--submenu:hover > .cw-menu,
      #${CONTEXT_MENU_ROOT_ID} .cw-item--submenu:focus-within > .cw-menu {
        display: flex;
      }

      #${CONTEXT_MENU_ROOT_ID} .cw-submenu-arrow {
        opacity: 0.7;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Mobile-responsive CSS overrides
  // ---------------------------------------------------------------------------

  function ensureMobileStyles() {
    if (document.getElementById(MOBILE_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = MOBILE_STYLE_ID;
    style.textContent = `
      /* ==== Tablet & small screen fixes (max-width: 768px) ==== */
      @media (max-width: 768px) {

        /* Viewport stabilization — body must be overflow:hidden on BOTH axes
           so iOS doesn't treat it as a competing scroll target.
           Do NOT set overflow on <html> — that kills momentum scrolling. */
        body {
          overflow: hidden !important;
          -webkit-text-size-adjust: 100% !important;
        }

        /* Header — constrain to viewport */
        .h-toolbar {
          max-width: 100vw !important;
        }

        .h-toolbar button {
          flex-shrink: 1 !important;
          min-width: 0 !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
          white-space: nowrap !important;
        }

        /* Ensure thread/sidebar scroll containers work reliably on iOS.
           - overflow-x:hidden removes horizontal ambiguity so iOS always scrolls vertically
           - -webkit-overflow-scrolling:touch enables momentum/inertial scrolling
           - touch-action:pan-y tells the browser vertical swipes = scroll */
        .vertical-scroll-fade-mask-top,
        .vertical-scroll-fade-mask,
        [class*="overflow-y-auto"],
        [class*="overflow-auto"] {
          overflow-x: hidden !important;
          overflow-y: auto !important;
          -webkit-overflow-scrolling: touch !important;
          touch-action: pan-y !important;
        }

        /* Prevent iOS auto-zoom on focus (triggers when font-size < 16px) */
        input, textarea, select {
          font-size: 16px !important;
          max-width: 100% !important;
          box-sizing: border-box !important;
        }

        [contenteditable="true"] {
          max-width: 100% !important;
          box-sizing: border-box !important;
        }

        [contenteditable="true"]:focus {
          font-size: 16px !important;
          scroll-margin-bottom: 20px;
        }

        /* Terminal — constrain height */
        [class*="terminal"],
        [class*="Terminal"] {
          max-height: 40vh !important;
        }

        /* Dialogs/modals — fit screen */
        [role="dialog"] {
          max-width: calc(100vw - 16px) !important;
          max-height: calc(100dvh - 32px) !important;
          overflow-y: auto !important;
          margin: 8px !important;
        }

        /* Context menu — responsive sizing */
        #${CONTEXT_MENU_ROOT_ID} .cw-menu {
          min-width: min(220px, calc(100vw - 24px)) !important;
          max-width: calc(100vw - 24px) !important;
        }

        #${CONTEXT_MENU_ROOT_ID} .cw-item--submenu > .cw-menu {
          position: fixed !important;
          left: 12px !important;
          right: 12px !important;
          top: auto !important;
          width: auto !important;
        }

        /* Overflow prevention */
        pre, code {
          overflow-x: auto !important;
          max-width: 100% !important;
          word-break: break-word !important;
        }
      }

      /* ==== Phone layout (max-width: 600px) ==== */
      @media (max-width: 600px) {

        /* Safe area support for notched devices */
        body {
          padding-top: env(safe-area-inset-top) !important;
          padding-bottom: env(safe-area-inset-bottom) !important;
          padding-left: env(safe-area-inset-left) !important;
          padding-right: env(safe-area-inset-right) !important;
        }

        /* CRITICAL: Collapse sidebar token so main content gets full width.
           The Codex app uses --spacing-token-sidebar with a 240px clamp minimum
           which is far too wide on phones. Setting it to 0 makes the sidebar an
           overlay instead of pushing the main content off-screen. */
        :root {
          --spacing-token-sidebar: 0px !important;
        }

        /* Sidebar becomes full-screen overlay when open.
           When collapsed the app sets opacity-0 but the element still covers
           the screen (translate is 0 because we zeroed the token). We must
           disable pointer events so it doesn't block taps on main content. */
        .window-fx-sidebar-surface,
        .w-token-sidebar {
          width: 85vw !important;
          max-width: 320px !important;
          z-index: 50 !important;
          box-shadow: 4px 0 24px rgba(0, 0, 0, 0.5) !important;
          background-color: rgb(24, 24, 24) !important;
          pointer-events: none !important;
          transition: opacity 0.3s ease, pointer-events 0s linear 0.3s !important;
        }

        /* Re-enable pointer events only when sidebar is visible (open) */
        .window-fx-sidebar-surface.opacity-100,
        .w-token-sidebar.opacity-100 {
          pointer-events: auto !important;
          transition: opacity 0.3s ease, pointer-events 0s linear 0s !important;
        }

        /* Main content takes full width */
        .main-surface,
        .left-token-sidebar {
          left: 0 !important;
          width: 100vw !important;
        }

        /* Prevent header-left from consuming more than half the bar.
           The app sets an inline min-width via CSS vars that over-allocates
           space for the portal area — override it so buttons fit. */
        .app-header-left {
          width: auto !important;
          min-width: 0 !important;
          max-width: 50vw !important;
          flex-shrink: 0 !important;
          padding-left: 4px !important;
          padding-right: 0 !important;
          overflow: hidden !important;
        }

        /* Collapse the empty portal gap when sidebar is hidden */
        .app-header-left-portal {
          gap: 0 !important;
          padding-right: 2px !important;
        }

        /* Use stable viewport height */
        #root {
          height: calc(var(--cw-vh, 1vh) * 100) !important;
          height: 100dvh !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Viewport height stabilizer (mobile keyboard / chrome bar)
  // ---------------------------------------------------------------------------

  function installViewportStabilizer() {
    if (!window.visualViewport) {
      return;
    }

    const update = () => {
      document.documentElement.style.setProperty(
        "--cw-vh",
        window.visualViewport.height * 0.01 + "px"
      );
    };

    window.visualViewport.addEventListener("resize", update);
    update();
  }

  // ---------------------------------------------------------------------------
  // Auto-collapse sidebar on mobile first load
  // ---------------------------------------------------------------------------

  function autoCollapseSidebarOnMobile() {
    if (window.innerWidth > 600) {
      return;
    }

    // The React app restores sidebar state from storage after mount.
    // We poll briefly after DOM ready to catch the sidebar in its open state.
    function tryCollapse(attempts) {
      if (attempts <= 0) {
        return;
      }
      const btn = document.querySelector('button[aria-label="Hide sidebar"]');
      if (btn) {
        btn.click();
        return;
      }
      setTimeout(() => tryCollapse(attempts - 1), 200);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        // Give React time to mount and restore sidebar state
        setTimeout(() => tryCollapse(15), 500);
      });
    } else {
      setTimeout(() => tryCollapse(15), 500);
    }
  }

  function normalizeContextMenuItems(items) {
    if (!Array.isArray(items)) {
      return [];
    }
    return items.filter((item) => item && typeof item === "object");
  }

  function contextMenuAnchor() {
    const margin = 8;
    const x = Number.isFinite(lastContextMenuPoint.x) ? lastContextMenuPoint.x : window.innerWidth / 2;
    const y = Number.isFinite(lastContextMenuPoint.y) ? lastContextMenuPoint.y : window.innerHeight / 2;
    return {
      x: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - margin)),
      y: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - margin))
    };
  }

  function closeContextMenu(result) {
    if (!activeContextMenu) {
      return;
    }

    const current = activeContextMenu;
    activeContextMenu = null;

    window.removeEventListener("keydown", current.onKeyDown, true);
    window.removeEventListener("resize", current.onWindowChange, true);
    clearTimeout(current.resizeDebounce);

    current.root.remove();
    current.resolve(result ?? null);
  }

  function positionContextMenu(menu, anchor) {
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const left = Math.min(Math.max(margin, anchor.x), maxLeft);
    const top = Math.min(Math.max(margin, anchor.y), maxTop);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function buildContextMenu(items, onSelect, nested = false) {
    const menu = document.createElement("div");
    menu.className = "cw-menu";
    menu.setAttribute("role", "menu");
    if (!nested) {
      menu.tabIndex = -1;
    }

    items.forEach((item, index) => {
      if (item.type === "separator") {
        const separator = document.createElement("div");
        separator.className = "cw-separator";
        separator.setAttribute("role", "separator");
        separator.dataset.index = String(index);
        menu.appendChild(separator);
        return;
      }

      const container = document.createElement("div");
      container.className = "cw-item";
      container.dataset.itemId = String(item.id ?? "");

      const button = document.createElement("button");
      button.type = "button";
      button.className = "cw-item-btn";
      button.setAttribute("role", "menuitem");
      button.textContent = String(item.label ?? item.nativeLabel ?? item.id ?? "Menu item");

      const submenuItems = normalizeContextMenuItems(item.submenu);
      if (submenuItems.length > 0) {
        container.classList.add("cw-item--submenu");
        const arrow = document.createElement("span");
        arrow.className = "cw-submenu-arrow";
        arrow.textContent = ">";
        button.appendChild(arrow);
        container.appendChild(button);
        container.appendChild(buildContextMenu(submenuItems, onSelect, true));
      } else {
        const enabled = item.enabled !== false;
        if (!enabled) {
          button.disabled = true;
        } else if (item.id) {
          button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(String(item.id));
          });
        }
        container.appendChild(button);
      }

      menu.appendChild(container);
    });

    return menu;
  }

  function showBrowserContextMenu(items) {
    const normalizedItems = normalizeContextMenuItems(items);
    if (normalizedItems.length === 0) {
      return Promise.resolve(null);
    }

    ensureContextMenuStyles();
    closeContextMenu(null);

    return new Promise((resolve) => {
      const root = document.createElement("div");
      root.id = CONTEXT_MENU_ROOT_ID;

      const menu = buildContextMenu(normalizedItems, (id) => {
        closeContextMenu({ id });
      });
      root.appendChild(menu);

      const onRootMouseDown = (event) => {
        if (event.target === root && event.button === 0) {
          event.preventDefault();
          closeContextMenu(null);
        }
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeContextMenu(null);
        }
      };

      let resizeDebounce = null;
      const onWindowChange = () => {
        clearTimeout(resizeDebounce);
        resizeDebounce = setTimeout(() => closeContextMenu(null), 300);
      };

      root.addEventListener("mousedown", onRootMouseDown);
      root.addEventListener("contextmenu", (event) => {
        event.preventDefault();
      });

      activeContextMenu = {
        root,
        resolve,
        onKeyDown,
        onWindowChange,
        get resizeDebounce() { return resizeDebounce; }
      };

      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("resize", onWindowChange, true);

      document.body.appendChild(root);
      const anchor = contextMenuAnchor();
      positionContextMenu(menu, anchor);
      menu.focus();
    });
  }

  function bridgeUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${BRIDGE_PATH}`;
  }

  function scheduleReconnect() {
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_MS);
  }

  function sendEnvelope(envelope) {
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope));
      return;
    }
    queuedEnvelopes.push(envelope);
  }

  function flushQueue() {
    while (queuedEnvelopes.length > 0 && connected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(queuedEnvelopes.shift()));
    }
  }

  function handleMainMessage(payload) {
    const record = {
      ts: Date.now(),
      type: payload?.type || null,
      payload
    };
    mainMessageHistory.push(record);
    if (mainMessageHistory.length > 200) {
      mainMessageHistory.shift();
    }
    window.__codexWebstrapMainMessages = mainMessageHistory;

    try {
      window.dispatchEvent(new MessageEvent("message", { data: payload }));
    } catch (error) {
      console.error("codex-webstrap main-message dispatch failed", {
        type: payload?.type || null,
        error: String(error)
      });
      throw error;
    }
  }

  function handleWorkerEvent(workerId, payload) {
    const subscribers = workerSubscribers.get(workerId);
    if (!subscribers) {
      return;
    }
    subscribers.forEach((callback) => {
      try {
        callback(payload);
      } catch (error) {
        console.warn("worker subscriber callback failed", error);
      }
    });
  }

  function handleBridgeError(message) {
    window.__codexWebstrapLastBridgeError = message;
    const printable = {
      code: message?.code || null,
      message: message?.message || null
    };
    console.warn("codex-webstrap bridge error", printable);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    ws = new WebSocket(bridgeUrl());

    ws.addEventListener("open", () => {
      connected = true;
      flushQueue();
    });

    ws.addEventListener("close", () => {
      connected = false;
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      connected = false;
      scheduleReconnect();
    });

    ws.addEventListener("message", (event) => {
      let envelope;
      try {
        envelope = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (envelope?.type) {
        case "bridge-ready":
          return;
        case "main-message":
          handleMainMessage(envelope.payload);
          return;
        case "worker-event":
          handleWorkerEvent(envelope.workerId, envelope.payload);
          return;
        case "bridge-error":
          handleBridgeError(envelope);
          return;
        default:
          return;
      }
    });
  }

  function sendMessageFromView(payload) {
    if (payload?.type === "open-in-browser") {
      const target = payload?.url || payload?.href || null;
      if (target) {
        const opened = window.open(target, "_blank", "noopener,noreferrer");
        if (!opened) {
          // Fallback when popup is blocked.
          window.location.href = target;
        }
      }
      return Promise.resolve();
    }

    sendEnvelope({
      type: "view-message",
      payload
    });
    return Promise.resolve();
  }

  function sendWorkerMessageFromView(workerId, payload) {
    sendEnvelope({
      type: "worker-message",
      workerId,
      payload
    });
    return Promise.resolve();
  }

  function subscribeToWorkerMessages(workerId, callback) {
    let subscribers = workerSubscribers.get(workerId);
    if (!subscribers) {
      subscribers = new Set();
      workerSubscribers.set(workerId, subscribers);
    }
    subscribers.add(callback);

    return () => {
      const existing = workerSubscribers.get(workerId);
      if (!existing) {
        return;
      }
      existing.delete(callback);
      if (existing.size === 0) {
        workerSubscribers.delete(workerId);
      }
    };
  }

  const electronBridge = {
    windowType: "electron",
    sendMessageFromView,
    sendWorkerMessageFromView,
    subscribeToWorkerMessages,
    showContextMenu: async (payload) => {
      return showBrowserContextMenu(payload);
    },
    triggerSentryTestError: async () => {
      await sendMessageFromView({ type: "trigger-sentry-test" });
    },
    getPathForFile: (file) => {
      if (file && typeof file.path === "string") {
        return file.path;
      }
      return null;
    },
    getSentryInitOptions: () => ({
      dsn: null,
      codexAppSessionId: null,
      appVersion:
        typeof buildInfo.appVersion === "string" && buildInfo.appVersion.length > 0
          ? buildInfo.appVersion
          : "0.0.0",
      buildNumber:
        typeof buildInfo.buildNumber === "string" && buildInfo.buildNumber.length > 0
          ? buildInfo.buildNumber
          : undefined,
      buildFlavor:
        typeof buildInfo.buildFlavor === "string" && buildInfo.buildFlavor.length > 0
          ? buildInfo.buildFlavor
          : "prod"
    }),
    getAppSessionId: () => null,
    getBuildFlavor: () =>
      typeof buildInfo.buildFlavor === "string" && buildInfo.buildFlavor.length > 0
        ? buildInfo.buildFlavor
        : "prod"
  };

  window.codexWindowType = "electron";
  window.electronBridge = electronBridge;
  installBrowserCompatibilityShims();
  ensureMobileStyles();
  installViewportStabilizer();
  autoCollapseSidebarOnMobile();
  window.addEventListener("contextmenu", rememberContextMenuPosition, true);

  connect();
})();
