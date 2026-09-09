// ==UserScript==
// @name         TM Core
// @namespace    tm-core
// @version      1.0.0
// @description  Shared UI, layout and slot system for multiple Tampermonkey scripts.
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // TM CORE
    // ============================================================
    //
    // Public API:
    //
    //   TM.registerButton({
    //       id: 'download',
    //       slot: 'R1',
    //       text: 'DL',
    //       title: 'Download',
    //       onClick: download
    //   });
    //
    //   TM.removeButton('download');
    //   TM.setLayout({ top: 20, bottom: 20 });
    //   TM.setConfig({ ... });
    //   TM.getSlotInfo();
    //   TM.getConfig();
    //
    // Script responsibilities:
    //   - business logic
    //   - button definition
    //   - slot selection
    //
    // TM Core responsibilities:
    //   - screen zones
    //   - slot positions
    //   - button style
    //   - duplicate-slot protection
    //   - shared toolbar containers
    //
    // ============================================================

    const VERSION = '1.0.0';

    // ------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------

    const DEFAULT_CONFIG = {
        layout: {
            top: 20,
            bottom: 20,
            // middle is calculated automatically:
            // middle = 100 - top - bottom
        },

        slots: {
            left: 7,
            right: 7
        },

        toolbar: {
            leftOffset: 12,
            rightOffset: 12,

            // Slot content is vertically centered inside its slot.
            // Set to true to center the entire occupied slot area.
            centerButtons: true
        },

        button: {
            height: '40px',
            minWidth: '40px',
            maxWidth: 'none',

            paddingX: '10px',

            radius: '8px',
            borderWidth: '0px',

            background: '#222222',
            color: '#ffffff',

            hoverBackground: '#3a3a3a',
            activeBackground: '#111111',

            borderColor: 'transparent',

            fontFamily: 'inherit',
            fontSize: '14px',
            fontWeight: '500',

            shadow: '0 2px 8px rgba(0, 0, 0, 0.18)',

            opacity: '1',

            disabledOpacity: '0.45'
        },

        zIndex: 2147483000,

        // Prefix everything created by TM Core to minimize
        // collision with website CSS.
        prefix: 'tm-core'
    };

    const state = {
        config: clone(DEFAULT_CONFIG),

        initialized: false,

        root: null,
        styleElement: null,

        leftZone: null,
        rightZone: null,

        leftSlots: new Map(),
        rightSlots: new Map(),

        buttons: new Map()
    };

    // ------------------------------------------------------------
    // Utilities
    // ------------------------------------------------------------

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function isPlainObject(value) {
        return (
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value)
        );
    }

    function mergeDeep(target, source) {
        if (!isPlainObject(source)) {
            return target;
        }

        for (const [key, value] of Object.entries(source)) {
            if (isPlainObject(value)) {
                if (!isPlainObject(target[key])) {
                    target[key] = {};
                }
                mergeDeep(target[key], value);
            } else {
                target[key] = value;
            }
        }

        return target;
    }

    function clampNumber(value, min, max, fallback) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(max, Math.max(min, number));
    }

    function normalizeConfig(input) {
        const config = clone(DEFAULT_CONFIG);

        mergeDeep(config, input || {});

        config.layout.top = clampNumber(
            config.layout.top,
            0,
            100,
            DEFAULT_CONFIG.layout.top
        );

        config.layout.bottom = clampNumber(
            config.layout.bottom,
            0,
            100,
            DEFAULT_CONFIG.layout.bottom
        );

        if (config.layout.top + config.layout.bottom >= 100) {
            throw new Error(
                '[TM Core] Invalid layout: top + bottom must be less than 100%.'
            );
        }

        config.slots.left = Math.max(
            0,
            Math.floor(Number(config.slots.left) || 0)
        );

        config.slots.right = Math.max(
            0,
            Math.floor(Number(config.slots.right) || 0)
        );

        return config;
    }

    function getMiddlePercent() {
        return (
            100 -
            state.config.layout.top -
            state.config.layout.bottom
        );
    }

    function normalizeSlot(slot) {
        if (typeof slot !== 'string') {
            throw new TypeError('[TM Core] slot must be a string.');
        }

        const normalized = slot.trim().toUpperCase();

        if (!/^[LR]\d+$/.test(normalized)) {
            throw new Error(
                `[TM Core] Invalid slot "${slot}". Expected L1, L2... or R1, R2...`
            );
        }

        return normalized;
    }

    function getSlotSide(slot) {
        return slot.charAt(0);
    }

    function getSlotNumber(slot) {
        return Number(slot.slice(1));
    }

    function getSlotMap(slot) {
        return getSlotSide(slot) === 'L'
            ? state.leftSlots
            : state.rightSlots;
    }

    function getSlotCount(side) {
        return side === 'L'
            ? state.config.slots.left
            : state.config.slots.right;
    }

    function assertSlotExists(slot) {
        const side = getSlotSide(slot);
        const number = getSlotNumber(slot);
        const count = getSlotCount(side);

        if (number < 1 || number > count) {
            throw new Error(
                `[TM Core] Slot ${slot} does not exist. ` +
                `Available range: ${side}1-${side}${count}.`
            );
        }
    }

    function safeCall(callback, ...args) {
        if (typeof callback !== 'function') {
            return;
        }

        try {
            callback(...args);
        } catch (error) {
            console.error('[TM Core] Button callback error:', error);
        }
    }

    // ------------------------------------------------------------
    // CSS
    // ------------------------------------------------------------

    function buildCss() {
        const c = state.config;
        const p = c.prefix;

        const middleTop = `${c.layout.top}vh`;
        const middleHeight = `${getMiddlePercent()}vh`;

        return `
            #${p}-root {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                z-index: ${c.zIndex} !important;
                pointer-events: none !important;
                margin: 0 !important;
                padding: 0 !important;
                border: 0 !important;
                background: transparent !important;
                font-family: ${c.button.fontFamily} !important;
                box-sizing: border-box !important;
            }

            #${p}-middle {
                position: absolute !important;
                top: ${middleTop} !important;
                left: 0 !important;
                width: 100% !important;
                height: ${middleHeight} !important;
                pointer-events: none !important;
                margin: 0 !important;
                padding: 0 !important;
                box-sizing: border-box !important;
            }

            #${p}-left,
            #${p}-right {
                position: absolute !important;
                top: 0 !important;
                bottom: 0 !important;
                width: auto !important;
                min-width: 0 !important;
                pointer-events: none !important;
                margin: 0 !important;
                padding: 0 !important;
                box-sizing: border-box !important;

                ${c.toolbar.centerButtons
                    ? 'display: flex !important; flex-direction: column !important; justify-content: center !important;'
                    : 'display: block !important;'}
            }

            #${p}-left {
                left: ${c.toolbar.leftOffset}px !important;
            }

            #${p}-right {
                right: ${c.toolbar.rightOffset}px !important;
            }

            .${p}-slot {
                position: relative !important;
                flex: 0 0 auto !important;
                width: auto !important;
                min-width: 0 !important;
                height: auto !important;
                pointer-events: none !important;
                display: flex !important;
                align-items: center !important;
                justify-content: flex-start !important;
                box-sizing: border-box !important;
            }

            #${p}-right .${p}-slot {
                justify-content: flex-end !important;
            }

            .${p}-button {
                appearance: none !important;
                -webkit-appearance: none !important;

                box-sizing: border-box !important;

                height: ${c.button.height} !important;
                min-width: ${c.button.minWidth} !important;
                ${c.button.maxWidth !== 'none'
                    ? `max-width: ${c.button.maxWidth} !important;`
                    : ''}

                padding: 0 ${c.button.paddingX} !important;

                border-width: ${c.button.borderWidth} !important;
                border-style: solid !important;
                border-color: ${c.button.borderColor} !important;
                border-radius: ${c.button.radius} !important;

                background: ${c.button.background} !important;
                color: ${c.button.color} !important;

                font-family: ${c.button.fontFamily} !important;
                font-size: ${c.button.fontSize} !important;
                font-weight: ${c.button.fontWeight} !important;

                box-shadow: ${c.button.shadow} !important;
                opacity: ${c.button.opacity} !important;

                cursor: pointer !important;

                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;

                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;

                margin: 0 !important;

                outline: none !important;

                pointer-events: auto !important;

                transition:
                    background-color 120ms ease,
                    opacity 120ms ease,
                    transform 80ms ease !important;
            }

            .${p}-button:hover {
                background: ${c.button.hoverBackground} !important;
            }

            .${p}-button:active {
                background: ${c.button.activeBackground} !important;
                transform: translateY(1px) !important;
            }

            .${p}-button:disabled {
                cursor: default !important;
                opacity: ${c.button.disabledOpacity} !important;
                transform: none !important;
            }

            .${p}-button:focus-visible {
                outline: 2px solid currentColor !important;
                outline-offset: 2px !important;
            }

            @media (max-width: 600px) {
                #${p}-left {
                    left: 6px !important;
                }

                #${p}-right {
                    right: 6px !important;
                }
            }
        `;
    }

    function injectStyle() {
        if (!document.head) {
            return;
        }

        if (!state.styleElement) {
            state.styleElement = document.createElement('style');
            state.styleElement.id = `${state.config.prefix}-style`;
            state.styleElement.type = 'text/css';
            document.head.appendChild(state.styleElement);
        }

        state.styleElement.textContent = buildCss();
    }

    // ------------------------------------------------------------
    // DOM / Zones / Slots
    // ------------------------------------------------------------

    function createRoot() {
        const p = state.config.prefix;

        const root = document.createElement('div');
        root.id = `${p}-root`;

        const middle = document.createElement('div');
        middle.id = `${p}-middle`;

        const left = document.createElement('div');
        left.id = `${p}-left`;

        const right = document.createElement('div');
        right.id = `${p}-right`;

        middle.appendChild(left);
        middle.appendChild(right);
        root.appendChild(middle);

        document.body.appendChild(root);

        state.root = root;
        state.leftZone = left;
        state.rightZone = right;
    }

    function createSlotElement(side, number) {
        const slot = `${side}${number}`;

        const element = document.createElement('div');
        element.className = `${state.config.prefix}-slot`;
        element.dataset.slot = slot;

        return element;
    }

    function buildSlots() {
        state.leftSlots.clear();
        state.rightSlots.clear();

        for (let i = 1; i <= state.config.slots.left; i += 1) {
            const element = createSlotElement('L', i);
            state.leftZone.appendChild(element);
            state.leftSlots.set(`L${i}`, {
                id: `L${i}`,
                side: 'L',
                number: i,
                element,
                buttonId: null
            });
        }

        for (let i = 1; i <= state.config.slots.right; i += 1) {
            const element = createSlotElement('R', i);
            state.rightZone.appendChild(element);
            state.rightSlots.set(`R${i}`, {
                id: `R${i}`,
                side: 'R',
                number: i,
                element,
                buttonId: null
            });
        }
    }

    function rebuildSlotLayout() {
        if (!state.leftZone || !state.rightZone) {
            return;
        }

        const leftCount = state.leftSlots.size;
        const rightCount = state.rightSlots.size;

        for (const slot of state.leftSlots.values()) {
            slot.element.style.height =
                leftCount > 0
                    ? `${100 / leftCount}%`
                    : '0%';
        }

        for (const slot of state.rightSlots.values()) {
            slot.element.style.height =
                rightCount > 0
                    ? `${100 / rightCount}%`
                    : '0%';
        }
    }

    function rebuildZones() {
        if (!state.root) {
            createRoot();
        }

        state.leftZone.replaceChildren();
        state.rightZone.replaceChildren();

        buildSlots();
        rebuildSlotLayout();

        // Reattach buttons that are still valid.
        const existingButtons = Array.from(state.buttons.values());

        state.buttons.clear();

        for (const record of existingButtons) {
            try {
                registerButton(record.options);
            } catch (error) {
                console.error(
                    `[TM Core] Could not restore button "${record.id}":`,
                    error
                );
            }
        }
    }

    // ------------------------------------------------------------
    // Buttons
    // ------------------------------------------------------------

    function normalizeButtonOptions(options) {
        if (!isPlainObject(options)) {
            throw new TypeError(
                '[TM Core] registerButton() expects an object.'
            );
        }

        if (!options.id) {
            throw new Error(
                '[TM Core] Button requires an id.'
            );
        }

        const id = String(options.id).trim();

        if (!id) {
            throw new Error(
                '[TM Core] Button id cannot be empty.'
            );
        }

        const slot = normalizeSlot(options.slot);

        assertSlotExists(slot);

        const normalized = {
            id,
            slot,

            text:
                options.text === undefined
                    ? ''
                    : String(options.text),

            title:
                options.title === undefined
                    ? ''
                    : String(options.title),

            html:
                options.html === undefined
                    ? null
                    : String(options.html),

            ariaLabel:
                options.ariaLabel === undefined
                    ? ''
                    : String(options.ariaLabel),

            type:
                options.type || 'button',

            onClick: options.onClick,

            disabled:
                Boolean(options.disabled),

            className:
                options.className
                    ? String(options.className)
                    : '',

            dataset:
                isPlainObject(options.dataset)
                    ? clone(options.dataset)
                    : {},

            // Optional per-button styling. This is intentionally
            // limited so global defaults remain centralized.
            style: isPlainObject(options.style)
                ? clone(options.style)
                : {}
        };

        return normalized;
    }

    function applyButtonOptionalStyle(button, style) {
        // Global style always wins through !important unless a
        // caller explicitly uses CSS variables or separate properties.
        // Only a small, deliberate set is accepted here.
        const allowed = [
            'width',
            'minWidth',
            'maxWidth',
            'height',
            'background',
            'color',
            'fontSize',
            'fontWeight',
            'borderRadius'
        ];

        for (const property of allowed) {
            if (style[property] !== undefined) {
                const cssProperty =
                    property === 'minWidth'
                        ? 'min-width'
                        : property === 'maxWidth'
                            ? 'max-width'
                            : property.replace(
                                /[A-Z]/g,
                                match => `-${match.toLowerCase()}`
                            );

                button.style.setProperty(
                    cssProperty,
                    String(style[property]),
                    'important'
                );
            }
        }
    }

    function createButtonElement(options) {
        const button = document.createElement('button');

        button.type = options.type;
        button.className = `${state.config.prefix}-button`;

        if (options.className) {
            button.classList.add(...options.className.split(/\\s+/).filter(Boolean));
        }

        if (options.html !== null) {
            button.innerHTML = options.html;
        } else {
            button.textContent = options.text;
        }

        if (options.title) {
            button.title = options.title;
        }

        if (options.ariaLabel) {
            button.setAttribute('aria-label', options.ariaLabel);
        } else if (options.title) {
            button.setAttribute('aria-label', options.title);
        }

        for (const [key, value] of Object.entries(options.dataset)) {
            button.dataset[key] = String(value);
        }

        button.disabled = options.disabled;

        applyButtonOptionalStyle(button, options.style);

        button.addEventListener('click', event => {
            if (button.disabled) {
                return;
            }

            safeCall(options.onClick, event, {
                id: options.id,
                slot: options.slot,
                button
            });
        });

        return button;
    }

    function removeButton(buttonId) {
        const id = String(buttonId).trim();
        const record = state.buttons.get(id);

        if (!record) {
            return false;
        }

        const slot = getSlotMap(record.slot).get(record.slot);

        if (slot) {
            slot.buttonId = null;
            slot.element.replaceChildren();
        }

        state.buttons.delete(id);

        return true;
    }

    function registerButton(rawOptions) {
        if (!state.initialized) {
            init();
        }

        const options = normalizeButtonOptions(rawOptions);

        const existingById = state.buttons.get(options.id);

        if (existingById) {
            removeButton(options.id);
        }

        const slotMap = getSlotMap(options.slot);
        const slot = slotMap.get(options.slot);

        if (!slot) {
            throw new Error(
                `[TM Core] Slot ${options.slot} is not available.`
            );
        }

        if (slot.buttonId && slot.buttonId !== options.id) {
            throw new Error(
                `[TM Core] Slot ${options.slot} is already occupied by button "${slot.buttonId}".`
            );
        }

        const button = createButtonElement(options);

        slot.element.replaceChildren(button);
        slot.buttonId = options.id;

        const record = {
            id: options.id,
            slot: options.slot,
            button,
            options
        };

        state.buttons.set(options.id, record);

        return button;
    }

    function setButtonDisabled(buttonId, disabled) {
        const record = state.buttons.get(String(buttonId).trim());

        if (!record) {
            return false;
        }

        record.button.disabled = Boolean(disabled);
        record.options.disabled = Boolean(disabled);

        return true;
    }

    function setButtonText(buttonId, text) {
        const record = state.buttons.get(String(buttonId).trim());

        if (!record) {
            return false;
        }

        record.button.textContent = String(text);
        record.options.text = String(text);

        return true;
    }

    function getButton(buttonId) {
        const record = state.buttons.get(String(buttonId).trim());

        return record ? record.button : null;
    }

    // ------------------------------------------------------------
    // Layout / Configuration
    // ------------------------------------------------------------

    function setLayout(layout) {
        if (!isPlainObject(layout)) {
            throw new TypeError(
                '[TM Core] setLayout() expects an object.'
            );
        }

        const nextConfig = clone(state.config);

        if (layout.top !== undefined) {
            nextConfig.layout.top = layout.top;
        }

        if (layout.bottom !== undefined) {
            nextConfig.layout.bottom = layout.bottom;
        }

        const normalized = normalizeConfig(nextConfig);

        state.config = normalized;

        injectStyle();
        rebuildSlotLayout();

        return getLayout();
    }

    function setConfig(partialConfig) {
        const normalized = normalizeConfig(
            mergeDeep(clone(state.config), partialConfig || {})
        );

        const slotCountChanged =
            normalized.slots.left !== state.config.slots.left ||
            normalized.slots.right !== state.config.slots.right;

        state.config = normalized;

        injectStyle();

        if (slotCountChanged) {
            rebuildZones();
        } else {
            rebuildSlotLayout();
        }

        return getConfig();
    }

    function getLayout() {
        return {
            top: state.config.layout.top,
            middle: getMiddlePercent(),
            bottom: state.config.layout.bottom
        };
    }

    function getConfig() {
        const config = clone(state.config);
        config.layout.middle = getMiddlePercent();
        return config;
    }

    // ------------------------------------------------------------
    // Slot information
    // ------------------------------------------------------------

    function getSlotInfo() {
        const result = {
            left: [],
            right: []
        };

        for (const slot of state.leftSlots.values()) {
            result.left.push({
                slot: slot.id,
                occupied: Boolean(slot.buttonId),
                buttonId: slot.buttonId
            });
        }

        for (const slot of state.rightSlots.values()) {
            result.right.push({
                slot: slot.id,
                occupied: Boolean(slot.buttonId),
                buttonId: slot.buttonId
            });
        }

        return result;
    }

    function getAvailableSlots(side) {
        const normalizedSide = String(side || '').trim().toUpperCase();

        if (!['L', 'R'].includes(normalizedSide)) {
            throw new Error(
                '[TM Core] getAvailableSlots() expects L or R.'
            );
        }

        const map =
            normalizedSide === 'L'
                ? state.leftSlots
                : state.rightSlots;

        return Array.from(map.values())
            .filter(slot => !slot.buttonId)
            .map(slot => slot.id);
    }

    // ------------------------------------------------------------
    // Initialization
    // ------------------------------------------------------------

    function init(customConfig = {}) {
        if (state.initialized) {
            if (Object.keys(customConfig).length > 0) {
                setConfig(customConfig);
            }
            return TM;
        }

        state.config = normalizeConfig(customConfig);

        const start = () => {
            if (state.initialized) {
                return;
            }

            injectStyle();
            createRoot();
            buildSlots();
            rebuildSlotLayout();

            state.initialized = true;

            console.info(
                `[TM Core] Initialized v${VERSION}.`,
                getLayout()
            );
        };

        if (!document.body) {
            window.addEventListener(
                'DOMContentLoaded',
                start,
                { once: true }
            );
        } else {
            start();
        }

        return TM;
    }

    // ------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------

    const TM = {
        version: VERSION,

        init,

        registerButton,
        removeButton,

        getButton,
        setButtonDisabled,
        setButtonText,

        setLayout,
        setConfig,

        getLayout,
        getConfig,

        getSlotInfo,
        getAvailableSlots
    };

    // ------------------------------------------------------------
    // Export
    // ------------------------------------------------------------

    if (window.TM && window.TM !== TM) {
        console.warn(
            '[TM Core] window.TM already exists. It will be replaced.'
        );
    }

    window.TM = TM;

    // Auto initialize with defaults.
    init();
})();
