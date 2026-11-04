const { InstanceBase, InstanceStatus, runEntrypoint, combineRgb } = require('@companion-module/base');
const http = require('http');

class OnCueInstance extends InstanceBase {

  constructor(internal) {
    super(internal);
    this.state = { timer: {}, teleprompter: {}, player: {} };
    this.blinkState = false;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────
  async init(config) {
    this.config = config;
    this.updateStatus(InstanceStatus.Connecting, 'Connecting...');
    this.initActions();
    this.initFeedbacks();
    this.initVariables();
    this.startPolling();
  }

  async destroy() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.blinkInterval) clearInterval(this.blinkInterval);
  }

  async configUpdated(config) {
    this.config = config;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.blinkInterval) clearInterval(this.blinkInterval);
    this.startPolling();
  }

  getConfigFields() {
    return [
      {
        type: 'textinput',
        id: 'host',
        label: 'IP of the computer running OnCue',
        default: '127.0.0.1',
        width: 8,
        tooltip: 'Use 127.0.0.1 if Companion is running on the same PC as OnCue'
      },
      {
        type: 'number',
        id: 'port',
        label: 'Port',
        default: 9999,
        width: 4,
        min: 1,
        max: 65535
      }
    ];
  }

  // ─── HTTP helpers ────────────────────────────────────────────────────────
  async sendCommand(moduleKey, action, extra = {}) {
    return new Promise((resolve) => {
      const body = JSON.stringify({ module: moduleKey, action, ...extra });
      const options = {
        hostname: this.config.host || '127.0.0.1',
        port: this.config.port || 9999,
        path: '/api/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 2000
      };
      const req = http.request(options, () => resolve(true));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  }

  async fetchState() {
    return new Promise((resolve) => {
      const options = {
        hostname: this.config.host || '127.0.0.1',
        port: this.config.port || 9999,
        path: '/api/state',
        method: 'GET',
        timeout: 1500
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  // ─── Polling ─────────────────────────────────────────────────────────────
  startPolling() {
    // Blinks every 500ms — used by the "Time's Up" feedback
    this.blinkInterval = setInterval(() => {
      this.blinkState = !this.blinkState;
      if (this.state.timer && this.state.timer.isTimeUp) this.checkFeedbacks('timer_is_timeup');
    }, 500);

    this.pollInterval = setInterval(async () => {
      try {
        const state = await this.fetchState();
        if (state === null) {
          this.updateStatus(InstanceStatus.ConnectionFailure, 'OnCue not found');
          if (this.connected !== false) {
            this.connected = false;
            this.setVariableValues({ oncue_connection: 'disconnected' });
            this.checkFeedbacks('oncue_connected', 'oncue_disconnected', 'oncue_module_open');
          }
          return;
        }
        this.updateStatus(InstanceStatus.Ok);
        this.connected = true;
        this.state = state;
        this.updateVariables();
        this.checkFeedbacks();
      } catch (err) {
        this.log('error', 'Error in pollInterval: ' + (err.stack || err.message));
      }
    }, 250); // same refresh rate as OnCue itself — keeps the time variable aligned with the real display
  }

  // ─── Action helpers ──────────────────────────────────────────────────────
  onOffToggleOption() {
    return {
      type: 'dropdown', id: 'state', label: 'State', default: 'toggle',
      choices: [{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }, { id: 'toggle', label: 'Toggle' }]
    };
  }

  onOffToggleParams(state) {
    if (state === 'on') return { enabled: true };
    if (state === 'off') return { enabled: false };
    return {}; // no value = toggle
  }

  timerOptionAction(id, name, command) {
    return {
      [id]: {
        name,
        options: [this.onOffToggleOption()],
        callback: async (action) => { await this.sendCommand('timer', command, this.onOffToggleParams(action.options.state)); }
      }
    };
  }

  // ─── Actions ─────────────────────────────────────────────────────────────
  initActions() {
    this.setActionDefinitions({

      // ── Timer ──────────────────────────────────────────────────────────
      timer_start:  { name: 'Timer: Start', options: [], callback: async () => { await this.sendCommand('timer', 'start'); } },
      timer_pause:  { name: 'Timer: Pause', options: [], callback: async () => { await this.sendCommand('timer', 'pause'); } },
      timer_stop:   { name: 'Timer: Stop',  options: [], callback: async () => { await this.sendCommand('timer', 'stop'); } },
      timer_reset:  { name: 'Timer: Reset (returns to the configured time)', options: [], callback: async () => { await this.sendCommand('timer', 'reset'); } },

      timer_settime: {
        name: 'Timer: Set Time',
        options: [
          { type: 'number', id: 'hours',   label: 'Hours',   default: 0,  min: 0, max: 99 },
          { type: 'number', id: 'minutes', label: 'Minutes', default: 10, min: 0, max: 59 },
          { type: 'number', id: 'seconds', label: 'Seconds', default: 0,  min: 0, max: 59 }
        ],
        callback: async (action) => {
          await this.sendCommand('timer', 'settime', {
            hours: action.options.hours, minutes: action.options.minutes, seconds: action.options.seconds
          });
        }
      },

      timer_addtime: {
        name: 'Timer: Add Time',
        options: [{
          type: 'dropdown', id: 'seconds', label: 'Add', default: 60,
          choices: [
            { id: 10, label: '+10 seconds' }, { id: 30, label: '+30 seconds' },
            { id: 60, label: '+1 minute' }, { id: 120, label: '+2 minutes' },
            { id: 300, label: '+5 minutes' }, { id: 600, label: '+10 minutes' }
          ]
        }],
        callback: async (action) => { await this.sendCommand('timer', 'addtime', { seconds: action.options.seconds }); }
      },

      timer_subtracttime: {
        name: 'Timer: Subtract Time',
        options: [{
          type: 'dropdown', id: 'seconds', label: 'Subtract', default: 60,
          choices: [
            { id: 10, label: '-10 seconds' }, { id: 30, label: '-30 seconds' },
            { id: 60, label: '-1 minute' }, { id: 120, label: '-2 minutes' },
            { id: 300, label: '-5 minutes' }, { id: 600, label: '-10 minutes' }
          ]
        }],
        callback: async (action) => { await this.sendCommand('timer', 'subtracttime', { seconds: action.options.seconds }); }
      },

      timer_message: {
        name: 'Timer: Send Message to Display',
        options: [{ type: 'textinput', id: 'text', label: 'Message', default: '' }],
        callback: async (action) => { await this.sendCommand('timer', 'message', { text: action.options.text }); }
      },

      timer_clearmessage: { name: 'Timer: Clear Message', options: [], callback: async () => { await this.sendCommand('timer', 'clearmessage'); } },
      timer_setmode_countdown: { name: 'Timer: Countdown Mode', options: [], callback: async () => { await this.sendCommand('timer', 'setmode', { countdown: true }); } },
      timer_setmode_countup:   { name: 'Timer: Count-up Mode',  options: [], callback: async () => { await this.sendCommand('timer', 'setmode', { countdown: false }); } },

      timer_blink_on:     { name: 'Timer: Enable Blink on Expire',  options: [], callback: async () => { await this.sendCommand('timer', 'setblink', { enabled: true }); } },
      timer_blink_off:    { name: 'Timer: Disable Blink on Expire', options: [], callback: async () => { await this.sendCommand('timer', 'setblink', { enabled: false }); } },
      timer_blink_toggle: { name: 'Timer: Toggle Blink on Expire',  options: [], callback: async () => { await this.sendCommand('timer', 'setblink', {}); } },

      timer_allow_negative_on:     { name: 'Timer: Enable Negative Counting on Expire', options: [], callback: async () => { await this.sendCommand('timer', 'setallownegative', { enabled: true }); } },
      timer_allow_negative_off:    { name: 'Timer: Disable Negative Counting (stays at 00:00)', options: [], callback: async () => { await this.sendCommand('timer', 'setallownegative', { enabled: false }); } },
      timer_allow_negative_toggle: { name: 'Timer: Toggle Negative Counting on Expire', options: [], callback: async () => { await this.sendCommand('timer', 'setallownegative', {}); } },

      // Display options (OnCue 1.0.2+): on / off / toggle
      ...this.timerOptionAction('timer_show_clock', 'Timer: Show Clock on Display', 'setclock'),
      ...this.timerOptionAction('timer_top_layout', 'Timer: Timer at the Top (top bar layout)', 'settoplayout'),
      ...this.timerOptionAction('timer_show_labels', 'Timer: Show Labels (TIMER / CLOCK names)', 'setlabels'),
      ...this.timerOptionAction('timer_show_timeup_label', 'Timer: Show "TIME\'S UP!" Warning', 'settimeuplabel'),
      ...this.timerOptionAction('timer_message_blink', 'Timer: Blink Message', 'setmessageblink'),
      ...this.timerOptionAction('timer_video_background', 'Timer: Video Background (camera, capture card or NDI)', 'setvideo'),

      timer_set_message_size: {
        name: 'Timer: Set Message Size',
        options: [{ type: 'number', id: 'size', label: 'Size (%, 50-250; the text still shrinks to fit)', default: 100, min: 50, max: 250 }],
        callback: async (action) => { await this.sendCommand('timer', 'setmessagesize', { size: action.options.size }); }
      },
      timer_adjust_message_size: {
        name: 'Timer: Adjust Message Size (relative — for jog wheels/encoders)',
        options: [{ type: 'number', id: 'delta', label: 'Adjustment (%, use negative to decrease)', default: 10, min: -200, max: 200 }],
        callback: async (action) => { await this.sendCommand('timer', 'adjustmessagesize', { delta: action.options.delta }); }
      },
      timer_ndi_on: {
        name: 'Timer: Turn NDI Output On (turning it off is only done in OnCue)',
        options: [],
        callback: async () => { await this.sendCommand('timer', 'ndion'); }
      },

      timer_load_speaker: {
        name: 'Timer: Load Speaker by Number',
        options: [{ type: 'number', id: 'number', label: 'Speaker number (1 = first in the list)', default: 1, min: 1, max: 999 }],
        callback: async (action) => { await this.sendCommand('timer', 'loadspeaker', { index: action.options.number }); }
      },
      timer_load_speaker_by_name: {
        name: 'Timer: Load Speaker by Name',
        options: [{ type: 'textinput', id: 'name', label: 'Speaker name (or part of it)', default: '' }],
        callback: async (action) => { await this.sendCommand('timer', 'loadspeaker', { name: action.options.name }); }
      },
      timer_next_speaker: { name: 'Timer: Next Speaker', options: [], callback: async () => { await this.sendCommand('timer', 'nextspeaker'); } },
      timer_prev_speaker: { name: 'Timer: Previous Speaker', options: [], callback: async () => { await this.sendCommand('timer', 'prevspeaker'); } },

      // ── Teleprompter ───────────────────────────────────────────────────
      tp_play:  { name: 'Teleprompter: Play',  options: [], callback: async () => { await this.sendCommand('teleprompter', 'play'); } },
      tp_pause: { name: 'Teleprompter: Pause', options: [], callback: async () => { await this.sendCommand('teleprompter', 'pause'); } },
      tp_toggleplay: { name: 'Teleprompter: Play/Pause Toggle', options: [], callback: async () => { await this.sendCommand('teleprompter', 'toggleplay'); } },
      tp_reset: { name: 'Teleprompter: Return to Start', options: [], callback: async () => { await this.sendCommand('teleprompter', 'reset'); } },

      tp_setspeed: {
        name: 'Teleprompter: Set Speed',
        options: [{ type: 'number', id: 'speed', label: 'Speed (1-10)', default: 3, min: 1, max: 10 }],
        callback: async (action) => { await this.sendCommand('teleprompter', 'setspeed', { speed: action.options.speed }); }
      },

      tp_adjustspeed: {
        name: 'Teleprompter: Adjust Speed (relative — for jog wheels/encoders)',
        options: [{
          type: 'number', id: 'delta', label: 'Adjustment (use negative to decrease)',
          default: 0.5, min: -10, max: 10, step: 0.5
        }],
        callback: async (action) => { await this.sendCommand('teleprompter', 'adjustspeed', { delta: action.options.delta }); }
      },

      tp_togglemirror: { name: 'Teleprompter: Toggle Mirror', options: [], callback: async () => { await this.sendCommand('teleprompter', 'togglemirror'); } },

      tp_set_direction: {
        name: 'Teleprompter: Scroll Direction',
        options: [{
          type: 'dropdown', id: 'direction', label: 'Direction', default: 'toggle',
          choices: [{ id: 'up', label: 'Up (text moves up, normal)' }, { id: 'down', label: 'Down (text moves down, goes back)' }, { id: 'toggle', label: 'Toggle' }]
        }],
        callback: async (action) => {
          const d = action.options.direction;
          await this.sendCommand('teleprompter', 'setdirection', d === 'toggle' ? {} : { direction: d });
        }
      },
      tp_goto_marker: {
        name: 'Teleprompter: Go to Section Marker',
        options: [{ type: 'number', id: 'number', label: 'Marker number (1 = first ---)', default: 1, min: 1, max: 999 }],
        callback: async (action) => { await this.sendCommand('teleprompter', 'gotomarker', { index: action.options.number }); }
      },
      tp_next_marker: { name: 'Teleprompter: Next Section Marker', options: [], callback: async () => { await this.sendCommand('teleprompter', 'nextmarker'); } },
      tp_prev_marker: { name: 'Teleprompter: Previous Section Marker', options: [], callback: async () => { await this.sendCommand('teleprompter', 'prevmarker'); } },
      tp_set_font_size: {
        name: 'Teleprompter: Set Font Size',
        options: [{ type: 'number', id: 'size', label: 'Font size (20-120)', default: 52, min: 20, max: 120 }],
        callback: async (action) => { await this.sendCommand('teleprompter', 'setfontsize', { size: action.options.size }); }
      },
      tp_adjust_font_size: {
        name: 'Teleprompter: Adjust Font Size (relative — for jog wheels/encoders)',
        options: [{ type: 'number', id: 'delta', label: 'Adjustment (use negative to decrease)', default: 4, min: -100, max: 100 }],
        callback: async (action) => { await this.sendCommand('teleprompter', 'adjustfontsize', { delta: action.options.delta }); }
      },

      // ── Player ─────────────────────────────────────────────────────────
      player_play:  { name: 'Player: Play',  options: [], callback: async () => { await this.sendCommand('player', 'play'); } },
      player_pause: { name: 'Player: Pause', options: [], callback: async () => { await this.sendCommand('player', 'pause'); } },
      player_toggleplay: { name: 'Player: Play/Pause Toggle', options: [], callback: async () => { await this.sendCommand('player', 'toggleplay'); } },
      player_next:  { name: 'Player: Next Track', options: [], callback: async () => { await this.sendCommand('player', 'next'); } },
      player_prev:  { name: 'Player: Previous Track', options: [], callback: async () => { await this.sendCommand('player', 'prev'); } },

      player_setvolume: {
        name: 'Player: Set Volume',
        options: [{ type: 'number', id: 'volume', label: 'Volume (0-100)', default: 80, min: 0, max: 100 }],
        callback: async (action) => { await this.sendCommand('player', 'setvolume', { volume: action.options.volume }); }
      },

      player_adjustvolume: {
        name: 'Player: Adjust Volume (relative — for jog wheels/encoders)',
        options: [{
          type: 'number', id: 'delta', label: 'Adjustment (%, use negative to decrease)',
          default: 5, min: -100, max: 100
        }],
        callback: async (action) => { await this.sendCommand('player', 'adjustvolume', { delta: action.options.delta }); }
      },

      player_fadeout:       { name: 'Player: Fade Out', options: [], callback: async () => { await this.sendCommand('player', 'fadeout'); } },
      player_toggleshuffle: { name: 'Player: Toggle Shuffle', options: [], callback: async () => { await this.sendCommand('player', 'toggleshuffle'); } },
      player_cyclerepeat:   { name: 'Player: Cycle Repeat Mode', options: [], callback: async () => { await this.sendCommand('player', 'cyclerepeat'); } },

      player_stop_at_end: {
        name: 'Player: Stop at End of Track (don\'t go to the next one)',
        options: [this.onOffToggleOption()],
        callback: async (action) => { await this.sendCommand('player', 'setstopatend', this.onOffToggleParams(action.options.state)); }
      },
      player_play_number: {
        name: 'Player: Play Track by Number (playlist)',
        options: [{ type: 'number', id: 'number', label: 'Track number (1 = first in the playlist)', default: 1, min: 1, max: 9999 }],
        callback: async (action) => { await this.sendCommand('player', 'playindex', { index: action.options.number }); }
      },
      player_goto_cue: { name: 'Player: Go to Cue In', options: [], callback: async () => { await this.sendCommand('player', 'gotocue'); } },

      player_play_by_name: {
        name: 'Player: Play Track by Name',
        options: [{
          type: 'textinput', id: 'name', label: 'Track name (or part of it)', default: '',
          tooltip: 'Plays the first track whose name contains this text — doesn\'t need to be exact. Works well with tracks renamed in the Player.'
        }],
        callback: async (action) => { await this.sendCommand('player', 'playbyname', { name: action.options.name }); }
      },

      // ── Sound Effect Pads ─────────────────────────────────────────────
      player_play_pad: {
        name: 'Player: Play Pad',
        options: [{
          type: 'dropdown', id: 'pad', label: 'Pad', default: 1,
          choices: [1,2,3,4,5,6,7,8,9].map(n => ({ id: n, label: `Pad ${n}` }))
        }],
        callback: async (action) => { await this.sendCommand('player', 'playpad', { pad: action.options.pad }); }
      },

      player_set_pad_volume: {
        name: 'Player: Set Pad Volume',
        options: [
          { type: 'dropdown', id: 'pad', label: 'Pad', default: 1, choices: [1,2,3,4,5,6,7,8,9].map(n => ({ id: n, label: `Pad ${n}` })) },
          { type: 'number', id: 'volume', label: 'Volume (0-100)', default: 100, min: 0, max: 100 }
        ],
        callback: async (action) => { await this.sendCommand('player', 'setpadvolume', { pad: action.options.pad, volume: action.options.volume }); }
      },

      player_adjust_pad_volume: {
        name: 'Player: Adjust Pad Volume (relative — for jog wheels/encoders)',
        options: [
          { type: 'dropdown', id: 'pad', label: 'Pad', default: 1, choices: [1,2,3,4,5,6,7,8,9].map(n => ({ id: n, label: `Pad ${n}` })) },
          { type: 'number', id: 'delta', label: 'Adjustment (%, use negative to decrease)', default: 5, min: -100, max: 100 }
        ],
        callback: async (action) => { await this.sendCommand('player', 'adjustpadvolume', { pad: action.options.pad, delta: action.options.delta }); }
      }

    });
  }

  // ─── Feedbacks ───────────────────────────────────────────────────────────
  initFeedbacks() {
    this.setFeedbackDefinitions({

      // ── Timer ──────────────────────────────────────────────────────────
      timer_is_running: {
        name: 'Timer: Running',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 180, 0), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.timer.isRunning
      },
      timer_is_paused: {
        name: 'Timer: Paused',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(255, 165, 0), color: combineRgb(0, 0, 0) },
        options: [],
        callback: () => !this.state.timer.isRunning && this.getTimerSeconds() > 0 && !this.state.timer.isTimeUp
      },
      timer_is_stopped: {
        name: 'Timer: Stopped',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(80, 80, 80), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !this.state.timer.isRunning && !this.state.timer.isTimeUp
      },
      timer_is_timeup: {
        name: 'Timer: Time\'s Up (blinks red)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(220, 53, 69), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.timer.isTimeUp && this.blinkState
      },
      timer_is_alert1: {
        name: 'Timer: Alert 1 (yellow)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(255, 193, 7), color: combineRgb(0, 0, 0) },
        options: [],
        callback: () => {
          const s = this.state.timer;
          if (!s.isRunning || !s.isCountdown) return false;
          const secs = this.getTimerSeconds();
          return secs <= s.alertThreshold1 && secs > s.alertThreshold2;
        }
      },
      timer_is_alert2: {
        name: 'Timer: Alert 2 (red)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(220, 53, 69), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => {
          const s = this.state.timer;
          if (!s.isRunning || !s.isCountdown) return false;
          return this.getTimerSeconds() <= s.alertThreshold2;
        }
      },
      timer_blink_enabled: {
        name: 'Timer: Blink on Expire (enabled)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.timer.allowBlink
      },
      timer_allow_negative_enabled: {
        name: 'Timer: Negative Counting (enabled)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => this.state.timer.allowNegative !== false
      },
      timer_option_enabled: {
        name: 'Timer: Display Option (enabled)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [{
          type: 'dropdown', id: 'option', label: 'Option', default: 'showClock',
          choices: [
            { id: 'showClock', label: 'Show Clock' },
            { id: 'topLayout', label: 'Timer at the Top' },
            { id: 'showLabels', label: 'Show Labels' },
            { id: 'showTimeUpLabel', label: 'Show "TIME\'S UP!" Warning' },
            { id: 'allowMessageBlink', label: 'Blink Message' },
            { id: 'useVideoSource', label: 'Video Background' }
          ]
        }],
        callback: (feedback) => {
          const t = this.state.timer || {};
          const v = t[feedback.options.option];
          // Options that are on by default count as on when OnCue doesn't report them (older versions)
          if (v === undefined) return ['showClock', 'showLabels', 'showTimeUpLabel'].includes(feedback.options.option) && t.type !== undefined;
          return !!v;
        }
      },
      timer_message_on_screen: {
        name: 'Timer: Message on Screen',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!(this.state.timer && String(this.state.timer.message || '').trim())
      },
      timer_ndi_on: {
        name: 'Timer: NDI Output On',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 180, 0), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!(this.state.ndi && this.state.ndi.timer)
      },

      // ── Teleprompter ───────────────────────────────────────────────────
      tp_is_playing: {
        name: 'Teleprompter: Playing',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.teleprompter.isPlaying
      },
      tp_direction_down: {
        name: 'Teleprompter: Scrolling Down (going back)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(255, 165, 0), color: combineRgb(0, 0, 0) },
        options: [],
        callback: () => this.state.teleprompter.direction === -1
      },

      // ── Player ─────────────────────────────────────────────────────────
      player_is_playing: {
        name: 'Player: Playing',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(111, 66, 193), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.player.isPlaying
      },

      player_pad_is_playing: {
        name: 'Player: Pad Playing',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(111, 66, 193), color: combineRgb(255, 255, 255) },
        options: [{
          type: 'dropdown', id: 'pad', label: 'Pad', default: 1,
          choices: [1,2,3,4,5,6,7,8,9].map(n => ({ id: n, label: `Pad ${n}` }))
        }],
        callback: (feedback) => {
          const pads = this.state.player.pads;
          if (!pads) return false;
          const p = pads[feedback.options.pad - 1];
          return !!(p && p.isPlaying);
        }
      },
      player_stop_at_end_enabled: {
        name: 'Player: Stop at End of Track (enabled)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.player.stopAtEnd
      },

      // ── General ────────────────────────────────────────────────────────
      oncue_connected: {
        name: 'OnCue: Connected',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 180, 0), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.connected
      },
      oncue_disconnected: {
        name: 'OnCue: Not Connected',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(220, 53, 69), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !this.connected
      },
      oncue_module_open: {
        name: 'OnCue: Module Open',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [{
          type: 'dropdown', id: 'module', label: 'Module', default: 'timer',
          choices: [{ id: 'timer', label: 'Timer' }, { id: 'teleprompter', label: 'Teleprompter' }, { id: 'player', label: 'Player' }]
        }],
        callback: (feedback) => !!(this.connected && this.state.modules && this.state.modules[feedback.options.module])
      }

    });
  }

  // ─── Variables ───────────────────────────────────────────────────────────
  initVariables() {
    this.setVariableDefinitions([
      { variableId: 'timer_time',    name: 'Timer: current time (HH:MM:SS, or -MM:SS once expired)' },
      { variableId: 'timer_status',  name: 'Timer: status' },
      { variableId: 'timer_message', name: 'Timer: display message' },
      { variableId: 'timer_mode',    name: 'Timer: mode (countdown/countup)' },

      { variableId: 'tp_status', name: 'Teleprompter: status (playing/paused)' },
      { variableId: 'tp_speed',  name: 'Teleprompter: current speed' },

      { variableId: 'player_track',  name: 'Player: current track' },
      { variableId: 'player_status', name: 'Player: status (playing/paused)' },
      { variableId: 'player_volume', name: 'Player: volume (%)' },

      ...[1,2,3,4,5,6,7,8,9].map(n => ({ variableId: `player_pad_${n}_name`, name: `Player: Pad ${n} name` })),

      { variableId: 'timer_speaker',      name: 'Timer: current speaker' },
      { variableId: 'timer_next_speaker', name: 'Timer: next speaker in the list' },
      { variableId: 'timer_configured',   name: 'Timer: configured time (HH:MM:SS)' },
      { variableId: 'timer_progress',     name: 'Timer: elapsed (% of the configured time, countdown only)' },

      { variableId: 'tp_direction',      name: 'Teleprompter: scroll direction (up/down)' },
      { variableId: 'tp_section',        name: 'Teleprompter: current section (marker)' },
      { variableId: 'tp_section_number', name: 'Teleprompter: current section number' },
      { variableId: 'tp_font_size',      name: 'Teleprompter: font size' },

      { variableId: 'player_elapsed',    name: 'Player: elapsed time of the track (M:SS)' },
      { variableId: 'player_remaining',  name: 'Player: remaining time of the track (-M:SS, up to the Cue Out)' },
      { variableId: 'player_next_track', name: 'Player: next track' },

      { variableId: 'oncue_connection',  name: 'OnCue: connection (connected/disconnected)' },
      { variableId: 'timer_open',        name: 'OnCue: Timer open (yes/no)' },
      { variableId: 'tp_open',           name: 'OnCue: Teleprompter open (yes/no)' },
      { variableId: 'player_open',       name: 'OnCue: Player open (yes/no)' }
    ]);
  }

  static fmtHMS(total) {
    const s = Math.max(0, Math.floor(total || 0));
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  static fmtMS(total) {
    const s = Math.max(0, Math.floor(total || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Teleprompter position right now, with the same anchor math OnCue uses
  getTpY() {
    const tp = this.state.teleprompter || {};
    if (!Number.isFinite(tp.scrollY) || !Number.isFinite(tp.scrollTs)) return null;
    let y = tp.scrollY;
    if (tp.isPlaying) y += (tp.direction === -1 ? -1 : 1) * (tp.speed || 0) * 40 * (Date.now() - tp.scrollTs) / 1000;
    const max = Number.isFinite(tp.maxY) ? tp.maxY : Infinity;
    return Math.min(Math.max(0, y), max);
  }

  // Player track position right now (OnCue reports it every second while playing)
  getPlayerPosition() {
    const p = this.state.player || {};
    if (!Number.isFinite(p.position)) return null;
    let pos = p.position;
    if (p.isPlaying && Number.isFinite(p.positionTs)) pos += (Date.now() - p.positionTs) / 1000;
    const end = p.cueOut > 0 ? p.cueOut : p.duration;
    return { pos: end > 0 ? Math.min(pos, end) : pos, end: end || 0 };
  }

  // Computes the timer's current value using the same anchor-based logic
  // OnCue itself uses. Once the time expires, it keeps counting (into
  // negative) using the progressive-count anchor — including while paused,
  // in which case it stays at the accumulated value. Returns a NEGATIVE
  // number once expired (with negative counting enabled), to correctly
  // reflect the real state of the display.
  getTimerSeconds() {
    const s = this.state.timer;
    if (!s || s.totalSeconds === undefined) return 0;

    if (s.isTimeUp) {
      if (s.allowNegative === false) return 0; // stays at 00:00

      let elapsed = s.progressiveAnchorSeconds || 0;
      if (s.isProgressiveRunning && s.progressiveAnchorTimestamp) {
        elapsed += Math.floor((Date.now() - s.progressiveAnchorTimestamp) / 1000);
      }
      return -elapsed;
    }

    let seconds = s.totalSeconds || 0;
    if (s.isRunning && s.anchorTimestamp) {
      const elapsed = Math.floor((Date.now() - s.anchorTimestamp) / 1000);
      seconds = s.isCountdown ? Math.max(0, s.anchorSeconds - elapsed) : s.anchorSeconds + elapsed;
    }
    return seconds;
  }

  updateVariables() {
    const t = this.state.timer || {};
    const tp = this.state.teleprompter || {};
    const p = this.state.player || {};

    const seconds = this.getTimerSeconds();
    const isNegative = seconds < 0;
    const absSeconds = Math.abs(seconds);

    let timeStr;
    if (isNegative) {
      // Same convention as OnCue's own display in the expired state:
      // minutes:seconds only, no hours, with a leading minus sign.
      const mins = String(Math.floor(absSeconds / 60)).padStart(2, '0');
      const secs = String(absSeconds % 60).padStart(2, '0');
      timeStr = `-${mins}:${secs}`;
    } else {
      const hrs  = String(Math.floor(absSeconds / 3600)).padStart(2, '0');
      const mins = String(Math.floor((absSeconds % 3600) / 60)).padStart(2, '0');
      const secs = String(absSeconds % 60).padStart(2, '0');
      timeStr = `${hrs}:${mins}:${secs}`;
    }

    let timerStatus = 'stopped';
    if (t.isTimeUp) timerStatus = t.isProgressiveRunning === false ? 'timeup-paused' : 'timeup';
    else if (t.isRunning) timerStatus = 'running';
    else if ((t.totalSeconds || 0) > 0) timerStatus = 'paused';

    const padVars = {};
    const pads = p.pads || [];
    for (let i = 0; i < 9; i++) {
      padVars[`player_pad_${i + 1}_name`] = pads[i] ? pads[i].name : '';
    }

    // Timer: progress of the configured time (countdown only)
    let progress = '';
    if (t.isCountdown && t.configuredSeconds > 0) {
      progress = t.isTimeUp ? 100 : Math.round(Math.min(100, Math.max(0, (t.configuredSeconds - Math.max(0, seconds)) / t.configuredSeconds * 100)));
    }

    // Teleprompter: current section from the marker positions
    let section = '';
    let sectionNumber = '';
    const y = this.getTpY();
    if (y !== null && Array.isArray(tp.markers)) {
      tp.markers.forEach((m, i) => { if (m && m.y <= y + 2) { section = m.label; sectionNumber = i + 1; } });
    }

    const pp = this.getPlayerPosition();
    const modules = this.state.modules || {};
    const yesNo = (v) => (v ? 'yes' : 'no');

    this.setVariableValues({
      timer_speaker: t.speakerName || '',
      timer_next_speaker: t.nextSpeakerName || '',
      timer_configured: t.configuredSeconds !== undefined ? OnCueInstance.fmtHMS(t.configuredSeconds) : '',
      timer_progress: progress,
      tp_direction: tp.direction === -1 ? 'down' : (tp.direction === 1 ? 'up' : ''),
      tp_section: section,
      tp_section_number: sectionNumber,
      tp_font_size: tp.fontSize !== undefined ? tp.fontSize : '',
      player_elapsed: pp ? OnCueInstance.fmtMS(pp.pos) : '',
      player_remaining: pp && pp.end > 0 ? '-' + OnCueInstance.fmtMS(Math.ceil(pp.end - pp.pos)) : '',
      player_next_track: p.nextTrackName || '',
      oncue_connection: 'connected',
      timer_open: this.state.modules ? yesNo(modules.timer) : '',
      tp_open: this.state.modules ? yesNo(modules.teleprompter) : '',
      player_open: this.state.modules ? yesNo(modules.player) : '',

      timer_time: timeStr,
      timer_status: timerStatus,
      timer_message: t.message || '',
      timer_mode: t.isCountdown ? 'countdown' : 'countup',

      tp_status: tp.isPlaying ? 'playing' : 'paused',
      tp_speed: tp.speed !== undefined ? tp.speed : '',

      player_track: p.trackName || '',
      player_status: p.isPlaying ? 'playing' : 'paused',
      player_volume: p.volume !== undefined ? p.volume : '',

      ...padVars
    });
  }

}

runEntrypoint(OnCueInstance, []);
