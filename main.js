const { InstanceBase, InstanceStatus, runEntrypoint, combineRgb } = require('@companion-module/base');
const http = require('http');

class OnCueInstance extends InstanceBase {

  constructor(internal) {
    super(internal);
    this.state = { timer: {}, teleprompter: {}, player: {} };
    this.blinkState = false;
  }

  // ─── Ciclo de vida ───────────────────────────────────────────────────────
  async init(config) {
    this.config = config;
    this.updateStatus(InstanceStatus.Connecting, 'Conectando...');
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
        label: 'IP do computador rodando o OnCue',
        default: '127.0.0.1',
        width: 8,
        tooltip: 'Use 127.0.0.1 se o Companion estiver no mesmo PC que o OnCue'
      },
      {
        type: 'number',
        id: 'port',
        label: 'Porta',
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
    // Pisca a cada 500ms — usado pelo feedback de "Tempo Esgotado"
    this.blinkInterval = setInterval(() => {
      this.blinkState = !this.blinkState;
      if (this.state.timer && this.state.timer.isTimeUp) this.checkFeedbacks('timer_is_timeup');
    }, 500);

    this.pollInterval = setInterval(async () => {
      try {
        const state = await this.fetchState();
        if (state === null) {
          this.updateStatus(InstanceStatus.ConnectionFailure, 'OnCue não encontrado');
          return;
        }
        this.updateStatus(InstanceStatus.Ok);
        this.state = state;
        this.updateVariables();
        this.checkFeedbacks();
      } catch (err) {
        this.log('error', 'Erro no pollInterval: ' + (err.stack || err.message));
      }
    }, 250); // igual à taxa de atualização do próprio OnCue — mantém a variável de tempo alinhada com a tela real
  }

  // ─── Ações ───────────────────────────────────────────────────────────────
  initActions() {
    this.setActionDefinitions({

      // ── Timer ──────────────────────────────────────────────────────────
      timer_start:  { name: 'Timer: Iniciar', options: [], callback: async () => { await this.sendCommand('timer', 'start'); } },
      timer_pause:  { name: 'Timer: Pausar',  options: [], callback: async () => { await this.sendCommand('timer', 'pause'); } },
      timer_stop:   { name: 'Timer: Parar',   options: [], callback: async () => { await this.sendCommand('timer', 'stop'); } },
      timer_reset:  { name: 'Timer: Resetar (volta ao tempo configurado)', options: [], callback: async () => { await this.sendCommand('timer', 'reset'); } },

      timer_settime: {
        name: 'Timer: Definir Tempo',
        options: [
          { type: 'number', id: 'hours',   label: 'Horas',    default: 0,  min: 0, max: 99 },
          { type: 'number', id: 'minutes', label: 'Minutos',  default: 10, min: 0, max: 59 },
          { type: 'number', id: 'seconds', label: 'Segundos', default: 0,  min: 0, max: 59 }
        ],
        callback: async (action) => {
          await this.sendCommand('timer', 'settime', {
            hours: action.options.hours, minutes: action.options.minutes, seconds: action.options.seconds
          });
        }
      },

      timer_addtime: {
        name: 'Timer: Adicionar Tempo',
        options: [{
          type: 'dropdown', id: 'seconds', label: 'Adicionar', default: 60,
          choices: [
            { id: 10, label: '+10 segundos' }, { id: 30, label: '+30 segundos' },
            { id: 60, label: '+1 minuto' }, { id: 120, label: '+2 minutos' },
            { id: 300, label: '+5 minutos' }, { id: 600, label: '+10 minutos' }
          ]
        }],
        callback: async (action) => { await this.sendCommand('timer', 'addtime', { seconds: action.options.seconds }); }
      },

      timer_subtracttime: {
        name: 'Timer: Subtrair Tempo',
        options: [{
          type: 'dropdown', id: 'seconds', label: 'Subtrair', default: 60,
          choices: [
            { id: 10, label: '-10 segundos' }, { id: 30, label: '-30 segundos' },
            { id: 60, label: '-1 minuto' }, { id: 120, label: '-2 minutos' },
            { id: 300, label: '-5 minutos' }, { id: 600, label: '-10 minutos' }
          ]
        }],
        callback: async (action) => { await this.sendCommand('timer', 'subtracttime', { seconds: action.options.seconds }); }
      },

      timer_message: {
        name: 'Timer: Enviar Mensagem para o Telão',
        options: [{ type: 'textinput', id: 'text', label: 'Mensagem', default: '' }],
        callback: async (action) => { await this.sendCommand('timer', 'message', { text: action.options.text }); }
      },

      timer_clearmessage: { name: 'Timer: Limpar Mensagem', options: [], callback: async () => { await this.sendCommand('timer', 'clearmessage'); } },
      timer_setmode_countdown: { name: 'Timer: Modo Regressivo', options: [], callback: async () => { await this.sendCommand('timer', 'setmode', { countdown: true }); } },
      timer_setmode_countup:   { name: 'Timer: Modo Progressivo', options: [], callback: async () => { await this.sendCommand('timer', 'setmode', { countdown: false }); } },

      timer_blink_on:     { name: 'Timer: Ativar Piscar ao Esgotar',    options: [], callback: async () => { await this.sendCommand('timer', 'setblink', { enabled: true }); } },
      timer_blink_off:    { name: 'Timer: Desativar Piscar ao Esgotar', options: [], callback: async () => { await this.sendCommand('timer', 'setblink', { enabled: false }); } },
      timer_blink_toggle: { name: 'Timer: Alternar Piscar ao Esgotar',  options: [], callback: async () => { await this.sendCommand('timer', 'setblink', {}); } },

      timer_allow_negative_on:     { name: 'Timer: Ativar Contagem Negativa ao Esgotar',   options: [], callback: async () => { await this.sendCommand('timer', 'setallownegative', { enabled: true }); } },
      timer_allow_negative_off:    { name: 'Timer: Desativar Contagem Negativa (fica em 00:00)', options: [], callback: async () => { await this.sendCommand('timer', 'setallownegative', { enabled: false }); } },
      timer_allow_negative_toggle: { name: 'Timer: Alternar Contagem Negativa ao Esgotar', options: [], callback: async () => { await this.sendCommand('timer', 'setallownegative', {}); } },

      // ── Teleprompter ───────────────────────────────────────────────────
      tp_play:  { name: 'Teleprompter: Play',  options: [], callback: async () => { await this.sendCommand('teleprompter', 'play'); } },
      tp_pause: { name: 'Teleprompter: Pausar', options: [], callback: async () => { await this.sendCommand('teleprompter', 'pause'); } },
      tp_toggleplay: { name: 'Teleprompter: Play/Pausar (alterna)', options: [], callback: async () => { await this.sendCommand('teleprompter', 'toggleplay'); } },
      tp_reset: { name: 'Teleprompter: Voltar ao Início', options: [], callback: async () => { await this.sendCommand('teleprompter', 'reset'); } },

      tp_setspeed: {
        name: 'Teleprompter: Definir Velocidade',
        options: [{ type: 'number', id: 'speed', label: 'Velocidade (1-10)', default: 3, min: 1, max: 10 }],
        callback: async (action) => { await this.sendCommand('teleprompter', 'setspeed', { speed: action.options.speed }); }
      },

      tp_adjustspeed: {
        name: 'Teleprompter: Ajustar Velocidade (relativo — use no knob/encoder)',
        options: [{
          type: 'number', id: 'delta', label: 'Ajuste (use negativo para diminuir)',
          default: 0.5, min: -10, max: 10, step: 0.5
        }],
        callback: async (action) => { await this.sendCommand('teleprompter', 'adjustspeed', { delta: action.options.delta }); }
      },

      tp_togglemirror: { name: 'Teleprompter: Alternar Espelho', options: [], callback: async () => { await this.sendCommand('teleprompter', 'togglemirror'); } },

      // ── Player ─────────────────────────────────────────────────────────
      player_play:  { name: 'Player: Play',  options: [], callback: async () => { await this.sendCommand('player', 'play'); } },
      player_pause: { name: 'Player: Pausar', options: [], callback: async () => { await this.sendCommand('player', 'pause'); } },
      player_toggleplay: { name: 'Player: Play/Pausar (alterna)', options: [], callback: async () => { await this.sendCommand('player', 'toggleplay'); } },
      player_next:  { name: 'Player: Próxima Faixa', options: [], callback: async () => { await this.sendCommand('player', 'next'); } },
      player_prev:  { name: 'Player: Faixa Anterior', options: [], callback: async () => { await this.sendCommand('player', 'prev'); } },

      player_setvolume: {
        name: 'Player: Definir Volume',
        options: [{ type: 'number', id: 'volume', label: 'Volume (0-100)', default: 80, min: 0, max: 100 }],
        callback: async (action) => { await this.sendCommand('player', 'setvolume', { volume: action.options.volume }); }
      },

      player_adjustvolume: {
        name: 'Player: Ajustar Volume (relativo — use no knob/encoder)',
        options: [{
          type: 'number', id: 'delta', label: 'Ajuste (%, use negativo para diminuir)',
          default: 5, min: -100, max: 100
        }],
        callback: async (action) => { await this.sendCommand('player', 'adjustvolume', { delta: action.options.delta }); }
      },

      player_fadeout:       { name: 'Player: Fade Out', options: [], callback: async () => { await this.sendCommand('player', 'fadeout'); } },
      player_toggleshuffle: { name: 'Player: Alternar Aleatório', options: [], callback: async () => { await this.sendCommand('player', 'toggleshuffle'); } },
      player_cyclerepeat:   { name: 'Player: Alternar Modo de Repetição', options: [], callback: async () => { await this.sendCommand('player', 'cyclerepeat'); } },

      player_play_by_name: {
        name: 'Player: Tocar Faixa pelo Nome',
        options: [{
          type: 'textinput', id: 'name', label: 'Nome da faixa (ou parte dele)', default: '',
          tooltip: 'Toca a primeira faixa cujo nome contenha esse texto — não precisa ser exato. Funciona bem com faixas renomeadas no Player.'
        }],
        callback: async (action) => { await this.sendCommand('player', 'playbyname', { name: action.options.name }); }
      },

      // ── Pads de Efeitos Sonoros ──────────────────────────────────────────
      player_play_pad: {
        name: 'Player: Tocar Pad',
        options: [{
          type: 'dropdown', id: 'pad', label: 'Pad', default: 1,
          choices: [1,2,3,4,5,6,7,8,9].map(n => ({ id: n, label: `Pad ${n}` }))
        }],
        callback: async (action) => { await this.sendCommand('player', 'playpad', { pad: action.options.pad }); }
      },

      player_set_pad_volume: {
        name: 'Player: Definir Volume do Pad',
        options: [
          { type: 'dropdown', id: 'pad', label: 'Pad', default: 1, choices: [1,2,3,4,5,6,7,8,9].map(n => ({ id: n, label: `Pad ${n}` })) },
          { type: 'number', id: 'volume', label: 'Volume (0-100)', default: 100, min: 0, max: 100 }
        ],
        callback: async (action) => { await this.sendCommand('player', 'setpadvolume', { pad: action.options.pad, volume: action.options.volume }); }
      },

      player_adjust_pad_volume: {
        name: 'Player: Ajustar Volume do Pad (relativo — use no knob/encoder)',
        options: [
          { type: 'dropdown', id: 'pad', label: 'Pad', default: 1, choices: [1,2,3,4,5,6,7,8,9].map(n => ({ id: n, label: `Pad ${n}` })) },
          { type: 'number', id: 'delta', label: 'Ajuste (%, use negativo para diminuir)', default: 5, min: -100, max: 100 }
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
        name: 'Timer: Rodando',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 180, 0), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.timer.isRunning
      },
      timer_is_paused: {
        name: 'Timer: Pausado',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(255, 165, 0), color: combineRgb(0, 0, 0) },
        options: [],
        callback: () => !this.state.timer.isRunning && this.getTimerSeconds() > 0 && !this.state.timer.isTimeUp
      },
      timer_is_stopped: {
        name: 'Timer: Parado',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(80, 80, 80), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !this.state.timer.isRunning && !this.state.timer.isTimeUp
      },
      timer_is_timeup: {
        name: 'Timer: Tempo Esgotado (pisca vermelho)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(220, 53, 69), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.timer.isTimeUp && this.blinkState
      },
      timer_is_alert1: {
        name: 'Timer: Alerta 1 (amarelo)',
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
        name: 'Timer: Alerta 2 (vermelho)',
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
        name: 'Timer: Piscar ao Esgotar (ativado)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.timer.allowBlink
      },
      timer_allow_negative_enabled: {
        name: 'Timer: Contagem Negativa (ativada)',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => this.state.timer.allowNegative !== false
      },

      // ── Teleprompter ───────────────────────────────────────────────────
      tp_is_playing: {
        name: 'Teleprompter: Rolando',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(0, 123, 255), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.teleprompter.isPlaying
      },

      // ── Player ─────────────────────────────────────────────────────────
      player_is_playing: {
        name: 'Player: Tocando',
        type: 'boolean',
        defaultStyle: { bgcolor: combineRgb(111, 66, 193), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => !!this.state.player.isPlaying
      },

      player_pad_is_playing: {
        name: 'Player: Pad Tocando',
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
      }

    });
  }

  // ─── Variáveis ───────────────────────────────────────────────────────────
  initVariables() {
    this.setVariableDefinitions([
      { variableId: 'timer_time',    name: 'Timer: tempo atual (HH:MM:SS, ou -MM:SS se esgotado)' },
      { variableId: 'timer_status',  name: 'Timer: status' },
      { variableId: 'timer_message', name: 'Timer: mensagem do telão' },
      { variableId: 'timer_mode',    name: 'Timer: modo (countdown/countup)' },

      { variableId: 'tp_status', name: 'Teleprompter: status (playing/paused)' },
      { variableId: 'tp_speed',  name: 'Teleprompter: velocidade atual' },

      { variableId: 'player_track',  name: 'Player: faixa atual' },
      { variableId: 'player_status', name: 'Player: status (playing/paused)' },
      { variableId: 'player_volume', name: 'Player: volume (%)' },

      ...[1,2,3,4,5,6,7,8,9].map(n => ({ variableId: `player_pad_${n}_name`, name: `Player: nome do Pad ${n}` }))
    ]);
  }

  // Calcula o tempo atual do timer usando a mesma lógica de âncora usada no
  // próprio OnCue. Quando o tempo esgota, continua contando (para o
  // negativo) usando a âncora da contagem progressiva — inclusive quando
  // ela está pausada, nesse caso fica parado no valor acumulado. Retorna
  // um número NEGATIVO quando está no tempo esgotado (e "permitir negativo"
  // está ativado), para refletir corretamente o estado real da tela.
  getTimerSeconds() {
    const s = this.state.timer;
    if (!s || s.totalSeconds === undefined) return 0;

    if (s.isTimeUp) {
      if (s.allowNegative === false) return 0; // fica parado em 00:00

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
      // Mesma convenção da própria tela do OnCue no modo esgotado: só
      // minutos:segundos, sem horas, com o sinal de negativo na frente.
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

    this.setVariableValues({
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
